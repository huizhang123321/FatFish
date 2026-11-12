import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPane } from "./components/ChatPane";
import { FriendsView } from "./components/FriendsView";
import { GroupPanel } from "./components/GroupPanel";
import { CreateGroupDialog } from "./components/Modal";
import { JoinGroupDialog } from "./components/JoinGroupDialog";
import { LoginScreen } from "./components/LoginScreen";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import * as api from "./lib/api";
import {
  clearCredentials,
  isAutoLoginSuppressed,
  loadCredentials,
  setAutoLoginSuppressed,
} from "./lib/credentials";
import { dmChannelFor, dmTitle } from "./lib/format";
import { applyTheme, loadTheme, saveTheme, type Theme } from "./lib/theme";
import type {
  ChannelRef,
  DesktopConnection,
  DmSummary,
  Friend,
  FriendRequestRow,
  HealthResponse,
  MessageRow,
  MyProfile,
  PrivateChannel,
} from "./lib/types";
import { useEventStream } from "./lib/useEvents";

/** Backend constants the interface mirrors (see ``minimost/chat.py``). */
const MAX_MESSAGE_CHARS = 10000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type Phase = "boot" | "login" | "ready";
type View = "chat" | "friends" | "settings";

interface Toast {
  message: string;
  kind: "info" | "error";
}

/**
 * Merge freshly delivered rows into the transcript.
 *
 * Keyed by message id so an edit or a deletion tombstone replaces the row in
 * place instead of being appended, and re-sorted by timestamp because an edited
 * old message arrives after a newer one.
 */
function mergeMessages(previous: MessageRow[], incoming: MessageRow[]): MessageRow[] {
  const byId = new Map<number, MessageRow>();
  for (const row of previous) byId.set(row.id, row);
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => a.ts - b.ts || a.id - b.id);
}

/** Merges a DM with the current user into one addressable channel reference. */
function dmRefFor(me: string, other: string): ChannelRef {
  return {
    id: dmChannelFor(me, other),
    kind: "dm",
    title: other,
    subtitle: "私聊",
    unread: 0,
    dmUsers: [other],
  };
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [me, setMe] = useState("");
  const [view, setView] = useState<View>("chat");
  const [toast, setToast] = useState<Toast | null>(null);

  const [publicList, setPublicList] = useState<string[]>([]);
  const [privates, setPrivates] = useState<PrivateChannel[]>([]);
  const [dmList, setDmList] = useState<DmSummary[]>([]);
  const [friendList, setFriendList] = useState<Friend[]>([]);
  const [requestsIn, setRequestsIn] = useState<FriendRequestRow[]>([]);
  const [requestsOut, setRequestsOut] = useState<FriendRequestRow[]>([]);
  const [avatarUsers, setAvatarUsers] = useState<Set<string>>(new Set());
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [unreads, setUnreads] = useState<Record<string, number>>({});

  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingDms, setPendingDms] = useState<ChannelRef[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [connected, setConnected] = useState(false);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [managing, setManaging] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showJoinGroup, setShowJoinGroup] = useState(false);

  const [desktop, setDesktop] = useState<DesktopConnection | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  // Read once from storage; index.html already applied it before the first paint,
  // so this only keeps the attribute in sync when the user switches.
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  /** Explains an unrequested login screen (e.g. the saved password stopped working). */
  const [loginNotice, setLoginNotice] = useState("");

  const cursorRef = useRef(0);
  const typingSentRef = useRef(0);

  const notify = useCallback((message: string, kind: "info" | "error" = "info") => {
    setToast({ message, kind });
  }, []);

  // Auto-dismiss the toast so it never covers the composer indefinitely.
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Keep <html data-theme> and the saved choice in step with the selection.
  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  /**
   * Change the theme and remember it on the account.
   *
   * The account copy is what actually survives a restart: `localStorage` is keyed
   * by origin, and the desktop shell picks a free port when 5000 is taken, so the
   * next launch can be a different origin with nothing saved. A failure here is
   * not worth blocking the switch over, but the user is told the choice may not
   * outlive the session.
   */
  const changeTheme = useCallback(
    (next: Theme) => {
      setTheme(next);
      void api.saveTheme(next).catch(() => {
        notify("主题已切换，但没能保存到账号，下次启动可能恢复默认", "error");
      });
    },
    [notify],
  );

  /**
   * Adopt the theme saved on the account, once per session.
   *
   * Runs after the profile arrives, i.e. only when signed in, and only when the
   * server actually has a choice stored -- an older server returns null and the
   * local value stays.
   */
  const themeSyncedRef = useRef(false);
  useEffect(() => {
    if (themeSyncedRef.current || !profile) return;
    themeSyncedRef.current = true;
    void api
      .getSettings()
      .then((saved) => {
        if (saved.theme === "light" || saved.theme === "dark") setTheme(saved.theme);
      })
      .catch(() => {
        /* server without the theme column: keep whatever is stored locally */
      });
  }, [profile]);

  /** Re-read every list the sidebar and the friends view render. */
  const reloadLists = useCallback(async () => {
    const [channels, privateChannels, conversations, friends, incoming, outgoing, avatars, meProfile] =
      await Promise.all([
        api.publicChannels(),
        api.privateChannels(),
        api.dms(),
        api.friends(),
        api.friendRequests("in"),
        api.friendRequests("out"),
        api.usersWithAvatars(),
        api.myProfile(),
      ]);
    setPublicList(channels);
    setPrivates(privateChannels);
    setDmList(conversations);
    setFriendList(friends);
    setRequestsIn(incoming);
    setRequestsOut(outgoing);
    setAvatarUsers(new Set(avatars));
    setProfile(meProfile);
  }, []);

  // ── Boot: work out whether a session already exists ──────────────────────
  useEffect(() => {
    let cancelled = false;

    // Read before silentLogin can clear it: it is what lets the login screen say
    // "the saved password no longer works" instead of silently appearing.
    const hadSavedAtBoot = loadCredentials() !== null;

    /**
     * Re-authenticate with the saved password, replacing a login screen the user
     * did not ask for.
     *
     * The server drops a session after 15 minutes of inactivity, so without this
     * a normal afternoon of chatting means retyping a 15-character password
     * repeatedly. A reload is used on success rather than patching state in
     * place: every list, the transcript and the SSE cursor are then rebuilt
     * exactly as on a fresh start, with no chance of stale data surviving the
     * gap.
     */
    const silentLogin = async (): Promise<boolean> => {
      if (isAutoLoginSuppressed()) return false;
      const saved = loadCredentials();
      if (!saved) return false;
      try {
        await api.login(saved.username, saved.password);
        return true;
      } catch {
        // The password changed, or the account is locked. Keeping it would just
        // fail again on every request, so drop it and let the user type.
        clearCredentials();
        return false;
      }
    };

    api.setUnauthorizedHandler(() => {
      // The session expired mid-use. Try the saved password once and reload into
      // a working session; if that fails, fall back to the login screen with a
      // note explaining why.
      void (async () => {
        if (await silentLogin()) {
          window.location.reload();
          return;
        }
        setPhase("login");
        setMe("");
      })();
    });

    void (async () => {
      try {
        const csrf = await api.fetchCsrf();
        if (cancelled) return;
        if (csrf.user) {
          setMe(csrf.user);
          setPhase("ready");
        } else if (await silentLogin()) {
          if (cancelled) return;
          const again = await api.fetchCsrf();
          if (cancelled) return;
          if (again.user) {
            setMe(again.user);
            setPhase("ready");
          } else {
            setPhase("login");
          }
        } else {
          if (cancelled) return;
          const stored = loadCredentials();
          setLoginNotice(
            stored === null && hadSavedAtBoot
              ? "已保存的密码无法使用，请重新输入。"
              : "",
          );
          setPhase("login");
        }
        const [healthInfo, connection] = await Promise.all([
          api.health().catch(() => null),
          window.fatfish?.getConnection().catch(() => null) ?? Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (healthInfo) setHealth(healthInfo);
        if (connection) setDesktop(connection);
      } catch {
        if (!cancelled) setPhase("login");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Load the lists once authenticated ────────────────────────────────────
  useEffect(() => {
    if (phase !== "ready" || !me) return;
    void reloadLists().catch((err: unknown) => {
      notify(err instanceof Error ? err.message : "读取数据失败", "error");
    });
  }, [phase, me, reloadLists, notify]);

  // ── Normalise the three channel lists into one addressable collection ────
  const publicRefs = useMemo<ChannelRef[]>(
    () =>
      publicList.map((name) => ({
        id: name,
        kind: "public",
        title: name,
        subtitle: "公共频道",
        unread: unreads[name] ?? 0,
      })),
    [publicList, unreads],
  );

  const groupRefs = useMemo<ChannelRef[]>(
    () =>
      privates
        .filter((entry) => entry.kind === "group")
        .map((entry) => ({
          id: entry.channel,
          kind: "group",
          title: entry.name,
          subtitle: `${entry.members.length} 人 · 群组`,
          unread: entry.unread,
          privateId: entry.id,
          role: entry.role,
        })),
    [privates],
  );

  const privateRefs = useMemo<ChannelRef[]>(
    () =>
      privates
        .filter((entry) => entry.kind !== "group")
        .map((entry) => ({
          id: entry.channel,
          kind: "channel",
          title: entry.name,
          subtitle: `${entry.members.length} 人 · 私有频道`,
          unread: entry.unread,
          privateId: entry.id,
          role: entry.role,
        })),
    [privates],
  );

  const dmRefs = useMemo<ChannelRef[]>(
    () =>
      dmList.map((entry) => ({
        id: entry.channel,
        kind: "dm",
        title: dmTitle(entry.users),
        subtitle:
          entry.users.length > 1
            ? `群聊 · ${entry.users.length + 1} 人`
            : online.has(entry.users[0]) || false
              ? "在线"
              : "私聊",
        unread: entry.unread,
        dmUsers: entry.users,
      })),
    [dmList, online],
  );

  const allRefs = useMemo(() => {
    const known = new Set(dmRefs.map((ref) => ref.id));
    const extra = pendingDms.filter((ref) => !known.has(ref.id));
    return [...publicRefs, ...groupRefs, ...privateRefs, ...dmRefs, ...extra];
  }, [publicRefs, groupRefs, privateRefs, dmRefs, pendingDms]);

  const activeChannel = useMemo(
    () => allRefs.find((ref) => ref.id === activeId) ?? null,
    [allRefs, activeId],
  );

  // The transcript effect keys off this *string*, not the ChannelRef object.
  // The ref objects are rebuilt whenever any list payload changes (a DM
  // arrives, a group is renamed, unread counts settle), and re-running the load
  // on those would wipe the transcript and re-mark the channel read every time —
  // which itself bumps the change counter and can cascade.
  const activeChannelId = activeChannel?.id ?? null;

  // Pick something to open once the lists are known.
  useEffect(() => {
    if (phase !== "ready" || allRefs.length === 0) return;
    if (activeId && allRefs.some((ref) => ref.id === activeId)) return;
    setActiveId(allRefs[0].id);
  }, [phase, allRefs, activeId]);

  // ── Load the transcript whenever the open channel changes ───────────────
  useEffect(() => {
    if (phase !== "ready" || !activeChannelId) return;
    const channelId = activeChannelId;
    let cancelled = false;

    setMessages([]);
    setTypingUsers([]);
    setLoadingMessages(true);
    setManaging(false);
    cursorRef.current = 0;

    void (async () => {
      try {
        const rows = await api.messages(channelId, 0);
        if (cancelled) return;
        setMessages(rows);
        cursorRef.current = rows.length > 0 ? rows[rows.length - 1].ts : 0;
        setUnreads((prev) => ({ ...prev, [channelId]: 0 }));
        await api.markRead(channelId).catch(() => undefined);
      } catch (err) {
        if (!cancelled) {
          // A 404 means the conversation is gone: the group was disbanded, or this
          // account was removed from it. Showing an empty pane would read as "the
          // app stopped responding", so say what happened and drop the selection.
          if (err instanceof api.ApiError && err.status === 404) {
            notify("这个群已经被解散，或者你已不在其中", "error");
            setActiveId(null);
            void reloadLists();
          } else {
            notify(err instanceof Error ? err.message : "读取消息失败", "error");
          }
        }
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, activeChannelId, notify, reloadLists]);

  // ── Live updates ────────────────────────────────────────────────────────
  const handlers = useMemo(
    () => ({
      messages: (payload: unknown) => {
        setMessages((prev) => mergeMessages(prev, payload as MessageRow[]));
      },
      friends: (payload: unknown) => setFriendList(payload as Friend[]),
      friend_requests: (payload: unknown) =>
        setRequestsIn((payload as { items: FriendRequestRow[] }).items ?? []),
      private_channels: (payload: unknown) => setPrivates(payload as PrivateChannel[]),
      dms: (payload: unknown) => setDmList(payload as DmSummary[]),
      online_users: (payload: unknown) => setOnline(new Set(payload as string[])),
      channel_unreads: (payload: unknown) => setUnreads(payload as Record<string, number>),
      typing: (payload: unknown) => setTypingUsers(payload as string[]),
    }),
    [],
  );

  // Only stream while the chat pane is actually the thing on screen: the
  // server scopes channel events to one channel per connection, and the cursor
  // must be the one from the freshly loaded transcript.
  const streamChannel =
    phase === "ready" && view === "chat" && !loadingMessages ? (activeChannel?.id ?? null) : null;

  useEventStream(streamChannel, cursorRef.current, handlers, setConnected);

  // ── Actions ─────────────────────────────────────────────────────────────

  const openChannel = useCallback((ref: ChannelRef) => {
    setActiveId(ref.id);
    setView("chat");
  }, []);

  const startDm = useCallback(
    (username: string) => {
      if (!me) return;
      const ref = dmRefFor(me, username);
      setPendingDms((prev) => [...prev.filter((item) => item.id !== ref.id), ref]);
      openChannel(ref);
    },
    [me, openChannel],
  );

  const sendMessage = useCallback(
    async (text: string, files: File[]) => {
      if (!activeChannel) return;
      const channelId = activeChannel.id;
      await api.sendMessage(channelId, text, files);
      // The SSE stream normally delivers this within ~100 ms; re-reading is the
      // fallback for a stream that is reconnecting, so a sent message is never
      // invisible.
      try {
        const rows = await api.messages(channelId, cursorRef.current);
        setMessages((prev) => mergeMessages(prev, rows));
        const newest = rows.length > 0 ? rows[rows.length - 1].ts : 0;
        cursorRef.current = Math.max(cursorRef.current, newest);
      } catch {
        /* the stream will catch up */
      }
      if (channelId.startsWith("dm:")) {
        void reloadLists().catch(() => undefined);
      }
    },
    [activeChannel, reloadLists],
  );

  const onTyping = useCallback(() => {
    if (!activeChannel) return;
    const now = Date.now();
    if (now - typingSentRef.current < 2500) return;
    typingSentRef.current = now;
    void api.startTyping(activeChannel.id);
  }, [activeChannel]);

  const createGroup = useCallback(
    async (
      name: string,
      members: string[],
      kind: "group" | "channel",
      inviteAdminOnly: boolean,
    ) => {
      const created = await api.createPrivateChannel(name, members, kind, inviteAdminOnly);
      await reloadLists();
      setActiveId(created.channel);
      setView("chat");
      // Say the group number out loud: it is the one piece of information the
      // creator needs to keep, and it is not visible until the panel is opened.
      if (kind === "group" && created.group_no) {
        notify(`群组已创建，群号 ${created.group_no}`, "info");
      } else {
        notify(kind === "group" ? "群组已创建" : "私有频道已创建", "info");
      }
    },
    [reloadLists, notify],
  );

  const leaveChannel = useCallback(() => {
    setManaging(false);
    setActiveId(null);
    void reloadLists();
  }, [reloadLists]);

  const doLogout = useCallback(async () => {
    // An explicit logout must stay logged out: without this the saved password
    // would sign the user straight back in on the next request.
    setAutoLoginSuppressed(true);
    await api.logout().catch(() => undefined);
    setPhase("login");
    setLoginNotice("已退出登录。");
    setMe("");
    setMessages([]);
    setActiveId(null);
    setPublicList([]);
    setPrivates([]);
    setDmList([]);
    setFriendList([]);
    setRequestsIn([]);
    setRequestsOut([]);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────

  if (phase === "boot") {
    return (
      <div className="boot-screen">
        <p>正在连接本地服务…</p>
      </div>
    );
  }

  if (phase === "login") {
    return (
      <LoginScreen
        notice={loginNotice}
        onAuthenticated={async () => {
          const csrf = await api.fetchCsrf();
          setMe(csrf.user ?? "");
          setLoginNotice("");
          setAutoLoginSuppressed(false);
          setPhase("ready");
        }}
      />
    );
  }

  const meHasAvatar = avatarUsers.has(me);

  return (
    <div className="app-shell">
      <Sidebar
        me={me}
        meAvatar={meHasAvatar}
        publicChannels={publicRefs}
        groups={groupRefs}
        privateChannels={privateRefs}
        dms={dmRefs}
        activeId={activeId}
        unread={unreads}
        online={online}
        friendRequestCount={requestsIn.length}
        onSelect={openChannel}
        onCreateGroup={() => setShowCreateGroup(true)}
        onJoinGroup={() => setShowJoinGroup(true)}
        onOpenFriends={() => setView("friends")}
        onOpenSettings={() => setView("settings")}
        view={view}
      />

      <main className="workspace">
        {view === "chat" &&
          (activeChannel ? (
            <ChatPane
              channel={activeChannel}
              me={me}
              messages={messages}
              avatarUsers={avatarUsers}
              loading={loadingMessages}
              connected={connected}
              typingUsers={typingUsers}
              maxMessageChars={MAX_MESSAGE_CHARS}
              maxUploadBytes={MAX_UPLOAD_BYTES}
              managing={managing}
              onToggleManage={() => setManaging((value) => !value)}
              onSend={sendMessage}
              onTyping={onTyping}
            />
          ) : (
            <div className="empty-state">
              <h2>还没有可用的频道</h2>
              <p>先新建一个群组，或者到「好友」里加人开始私聊。</p>
            </div>
          ))}

        {view === "friends" && (
          <FriendsView
            me={me}
            friends={friendList}
            requestsIn={requestsIn}
            requestsOut={requestsOut}
            online={online}
            onStartDm={startDm}
            onRefresh={() => void reloadLists()}
            notify={notify}
          />
        )}

        {view === "settings" && (
          <SettingsView
            me={me}
            profile={profile}
            hasAvatar={meHasAvatar}
            desktop={desktop}
            theme={theme}
            onThemeChange={changeTheme}
            onReloadProfile={() => void reloadLists()}
            onLogout={() => void doLogout()}
            notify={notify}
          />
        )}

        {view === "chat" && managing && activeChannel?.privateId !== undefined && (
          <GroupPanel
            privateId={activeChannel.privateId}
            title={activeChannel.title}
            isGroup={activeChannel.kind === "group"}
            me={me}
            myRole={activeChannel.role}
            friends={friendList}
            onClose={() => setManaging(false)}
            onChanged={() => void reloadLists()}
            onLeft={leaveChannel}
            notify={notify}
          />
        )}
      </main>

      {showCreateGroup && (
        <CreateGroupDialog
          friends={friendList}
          onClose={() => setShowCreateGroup(false)}
          onCreate={createGroup}
        />
      )}

      {showJoinGroup && (
        <JoinGroupDialog
          onClose={() => setShowJoinGroup(false)}
          onRequested={() => void reloadLists()}
          notify={notify}
        />
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.message}
        </div>
      )}

      {health?.desktop_mode && <span className="build-tag">桌面版 {health.version}</span>}
    </div>
  );
}
