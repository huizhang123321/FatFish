/**
 * Server-render smoke test for the interface components.
 *
 * Chromium cannot start in every build environment (it needs mojo named pipes,
 * which locked-down shells deny), so the bundle cannot always be exercised in a
 * real browser. This test covers the next best thing: it renders every screen
 * through `react-dom/server` with realistic props and asserts the markup that
 * makes the screen usable is actually produced.
 *
 * What it catches, without a browser:
 *   * a component that throws while rendering (bad prop access, undefined
 *     destructuring, a missing import),
 *   * a screen that renders empty or loses its key affordances,
 *   * a coding error in the pure formatting helpers used while rendering.
 *
 * What it cannot catch (covered by scripts/ui-smoke.js when Chromium can run):
 * effects, event handlers, layout/CSS and anything network-dependent.
 *
 * Run:
 *   cd desktop
 *   npx tsc scripts/render-smoke.tsx --outDir .render-smoke --module commonjs \
 *       --target es2022 --jsx react-jsx --esModuleInterop --skipLibCheck \
 *       --moduleResolution node
 *   node .render-smoke/render-smoke.js
 */

import { renderToStaticMarkup } from "react-dom/server";

import { ChatPane } from "../src/components/ChatPane";
import { FriendsView } from "../src/components/FriendsView";
import { GroupPanel } from "../src/components/GroupPanel";
import { LoginScreen } from "../src/components/LoginScreen";
import { MessageList } from "../src/components/MessageList";
import { CreateGroupDialog } from "../src/components/Modal";
import { JoinGroupDialog } from "../src/components/JoinGroupDialog";
import { SettingsView } from "../src/components/SettingsView";
import { Sidebar } from "../src/components/Sidebar";
import type { ChannelRef, MessageRow } from "../src/lib/types";
import { dmChannelFor, dmTitle, formatClock, formatDay } from "../src/lib/format";

const passed: string[] = [];
const failed: Array<[string, string]> = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    passed.push(name);
    console.log(`  PASS ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    failed.push([name, detail]);
    console.log(`  FAIL ${name}: ${detail}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertContains(haystack: string, needle: string, label: string) {
  assert(
    haystack.includes(needle),
    `${label}: expected to contain ${JSON.stringify(needle)}, got ${JSON.stringify(haystack.slice(0, 240))}`,
  );
}

const noop = () => undefined;
const asyncNoop = async () => undefined;

const publicChannel: ChannelRef = {
  id: "general",
  kind: "public",
  title: "general",
  subtitle: "公共频道",
  unread: 0,
};

const groupChannel: ChannelRef = {
  id: "private:7",
  kind: "group",
  title: "周末联机",
  subtitle: "3 人 · 群组",
  unread: 2,
  privateId: 7,
  role: "owner",
};

const dmChannel: ChannelRef = {
  id: "dm:alice:bob",
  kind: "dm",
  title: "bob",
  subtitle: "在线",
  unread: 1,
  dmUsers: ["bob"],
};

const messages: MessageRow[] = [
  {
    id: 1,
    channel: "general",
    sender: "alice",
    content: "第一条消息",
    content_type: null,
    filename: null,
    ts: 1700000000,
    edited: null,
    edited_ts: null,
    deleted: 0,
    deleted_ts: null,
    reply_to_id: null,
    reactions: JSON.stringify({ "👍": ["bob"] }),
  },
  {
    id: 2,
    channel: "general",
    sender: "bob",
    content: "",
    content_type: null,
    filename: "abc123.png",
    ts: 1700000060,
    edited: null,
    edited_ts: null,
    deleted: 0,
    deleted_ts: null,
    reply_to_id: null,
    reactions: null,
  },
  {
    id: 3,
    channel: "general",
    sender: "minimost",
    content: "alice 加入了频道",
    content_type: "system",
    filename: null,
    ts: 1700000120,
    edited: null,
    edited_ts: null,
    deleted: 0,
    deleted_ts: null,
    reply_to_id: null,
    reactions: null,
  },
];

console.log("\n=== login screen ===");
check("renders the login form", () => {
  const html = renderToStaticMarkup(<LoginScreen onAuthenticated={asyncNoop} />);
  assertContains(html, "登录", "login");
  assertContains(html, "注册", "login");
  assertContains(html, "用户名", "login");
  assertContains(html, 'type="password"', "login");
  assertContains(html, "请输入密码", "login");
  // Remembering the password is what stops the 15-minute idle timeout from
  // making people retype a 15-character password several times an hour.
  assertContains(html, "记住密码", "login");
  assertContains(html, 'type="checkbox"', "login");
  // The password rules and the confirm field are signup-only; in login mode the
  // form is just the two fields. See the signup branch in components/LoginScreen.tsx.
  assert(!html.includes("确认密码"), "signup-only confirm field must not render in login mode");
  assert(!html.includes("至少 15 个字符"), "signup-only rules must not render in login mode");
});

console.log("\n=== sidebar ===");
check("renders the three channel sections", () => {
  const html = renderToStaticMarkup(
    <Sidebar
      me="alice"
      meAvatar={false}
      publicChannels={[publicChannel]}
      groups={[groupChannel]}
      privateChannels={[]}
      dms={[dmChannel]}
      activeId="general"
      unread={{}}
      online={new Set(["bob"])}
      friendRequestCount={2}
      onSelect={noop}
      onCreateGroup={noop}
      onJoinGroup={noop}
      onOpenFriends={noop}
      onOpenSettings={noop}
      view="chat"
    />,
  );
  assertContains(html, "公共频道", "sidebar");
  assertContains(html, "群组", "sidebar");
  assertContains(html, "私聊", "sidebar");
  assertContains(html, "general", "sidebar");
  assertContains(html, "周末联机", "sidebar");
  assertContains(html, "群主", "sidebar marks the owner role");
  assertContains(html, "unread-badge", "sidebar shows unread counts");
  assertContains(html, "online-dot", "sidebar marks online DM partners");
});

console.log("\n=== transcript ===");
check("renders messages, grouping and attachments", () => {
  const html = renderToStaticMarkup(
    <MessageList
      messages={messages}
      me="alice"
      avatarUsers={new Set(["bob"])}
      loading={false}
    />,
  );
  assertContains(html, "第一条消息", "messages");
  assertContains(html, "day-separator", "messages");
  assertContains(html, "alice", "messages");
  assertContains(html, "system-message", "system notices get their own styling");
  assertContains(html, "attachment-image", "image attachments render inline");
  assertContains(html, "/files/abc123.png", "attachment URL");
  assertContains(html, "reaction", "reactions render");
});

check("marks my own messages so they can sit on the right", () => {
  const html = renderToStaticMarkup(
    <MessageList
      messages={[
        {
          id: 20,
          channel: "general",
          sender: "alice",
          content: "我自己发的",
          content_type: null,
          filename: null,
          ts: 1700000500,
          edited: null,
          edited_ts: null,
          deleted: 0,
          deleted_ts: null,
          reply_to_id: null,
          reactions: null,
        },
        {
          id: 21,
          channel: "general",
          sender: "bob",
          content: "别人发的",
          content_type: null,
          filename: null,
          ts: 1700000600,
          edited: null,
          edited_ts: null,
          deleted: 0,
          deleted_ts: null,
          reply_to_id: null,
          reactions: null,
        },
      ]}
      me="alice"
      avatarUsers={new Set()}
      loading={false}
    />,
  );
  // `mine` is what the stylesheet keys the right-hand layout off.
  assertContains(html, 'class="message mine"', "own message is marked mine");
  assert(!/class="message[^"]*mine[^"]*"[^>]*>\s*<div class="message-gutter">\s*<img[^>]*alt="bob"/.test(html),
    "the other person's message is not marked mine");
});

check("renders an imported sticker from its id", () => {  const html = renderToStaticMarkup(
    <MessageList
      messages={[
        {
          id: 30,
          channel: "general",
          sender: "bob",
          content: "[sticker:custom-7]",
          content_type: null,
          filename: null,
          ts: 1700000700,
          edited: null,
          edited_ts: null,
          deleted: 0,
          deleted_ts: null,
          reply_to_id: null,
          reactions: null,
        },
      ]}
      me="alice"
      avatarUsers={new Set()}
      loading={false}
    />,
  );
  assertContains(html, "/stickers/7/image", "imported sticker URL is built from the id");
  assertContains(html, "message-sticker", "imported sticker renders as an image");
});

check("shows the sender's filename for a shared file", () => {
  // What the server stores for an upload called "季度总结 2026.docx".
  const stored =
    "f005ae5d95614b439a4d544915d313f5_" +
    "%E5%AD%A3%E5%BA%A6%E6%80%BB%E7%BB%93%202026.docx";
  const html = renderToStaticMarkup(
    <MessageList
      messages={[
        {
          id: 40,
          channel: "general",
          sender: "bob",
          content: "",
          content_type: null,
          filename: stored,
          ts: 1700000800,
          edited: null,
          edited_ts: null,
          deleted: 0,
          deleted_ts: null,
          reply_to_id: null,
          reactions: null,
        },
      ]}
      me="alice"
      avatarUsers={new Set()}
      loading={false}
    />,
  );
  assertContains(html, "季度总结 2026.docx", "the original filename is shown, not the uuid");
  assertContains(html, "DOCX", "the extension is shown as a badge");
  assertContains(html, "/files/f005ae5d95614b439a4d544915d313f5_", "link still points at the stored name");
  // The stored name belongs in the href, not in the text the reader sees.
  assert(!html.includes(">f005ae5d95614b439a4d544915d313f5_"), "the raw stored name is not displayed");
});

check("renders the empty state", () => {
  const html = renderToStaticMarkup(
    <MessageList messages={[]} me="alice" avatarUsers={new Set()} loading={false} />,
  );
  assertContains(html, "还没有消息", "empty transcript");
});

check("renders a voice note as a player", () => {
  const html = renderToStaticMarkup(
    <MessageList
      messages={[
        {
          id: 10,
          channel: "general",
          sender: "bob",
          content: "",
          content_type: null,
          filename: "f005ae5d95614b439a4d544915d313f5_voice-20260101.webm",
          ts: 1700000200,
          edited: null,
          edited_ts: null,
          deleted: 0,
          deleted_ts: null,
          reply_to_id: null,
          reactions: null,
        },
      ]}
      me="alice"
      avatarUsers={new Set()}
      loading={false}
    />,
  );
  assertContains(html, "<audio", "voice notes play in place");
  assertContains(html, "attachment-audio", "voice note styling");
  assertContains(html, ".webm", "voice note URL");
});

check("renders sticker tokens as images", () => {
  const html = renderToStaticMarkup(
    <MessageList
      messages={[
        {
          id: 11,
          channel: "general",
          sender: "bob",
          content: "看这个 [sticker:happy] 和 [sticker:nice]",
          content_type: null,
          filename: null,
          ts: 1700000300,
          edited: null,
          edited_ts: null,
          deleted: 0,
          deleted_ts: null,
          reply_to_id: null,
          reactions: null,
        },
      ]}
      me="alice"
      avatarUsers={new Set()}
      loading={false}
    />,
  );
  assertContains(html, 'class="message-sticker"', "sticker rendered as an image");
  assertContains(html, "/static/stickers/happy.svg", "first sticker URL");
  assertContains(html, "/static/stickers/nice.svg", "second sticker URL");
  assertContains(html, "看这个", "surrounding text is kept");
  // The token itself must not leak into the visible text.
  assert(!html.includes("[sticker:happy]"), "sticker token is not shown as text");
});

check("leaves an unknown sticker token as text", () => {
  const html = renderToStaticMarkup(
    <MessageList
      messages={[
        {
          id: 12,
          channel: "general",
          sender: "bob",
          content: "[sticker:not-a-real-one]",
          content_type: null,
          filename: null,
          ts: 1700000400,
          edited: null,
          edited_ts: null,
          deleted: 0,
          deleted_ts: null,
          reply_to_id: null,
          reactions: null,
        },
      ]}
      me="alice"
      avatarUsers={new Set()}
      loading={false}
    />,
  );
  assertContains(html, "[sticker:not-a-real-one]", "unknown ids stay readable");
  assert(!html.includes("message-sticker"), "no broken image for an unknown id");
});

check("renders the loading state", () => {
  const html = renderToStaticMarkup(
    <MessageList messages={[]} me="alice" avatarUsers={new Set()} loading />,
  );
  assertContains(html, "正在载入", "loading transcript");
});

console.log("\n=== chat pane ===");
check("renders header, transcript and composer", () => {
  const html = renderToStaticMarkup(
    <ChatPane
      channel={groupChannel}
      me="alice"
      messages={messages}
      avatarUsers={new Set()}
      loading={false}
      connected
      typingUsers={["bob"]}
      maxMessageChars={10000}
      maxUploadBytes={25 * 1024 * 1024}
      managing={false}
      onToggleManage={noop}
      onSend={asyncNoop}
      onTyping={noop}
    />,
  );
  assertContains(html, "周末联机", "chat header");
  assertContains(html, "实时", "stream badge");
  assertContains(html, "成员 / 管理", "management entry point for a group");
  assertContains(html, "正在输入", "typing indicator");
  assertContains(html, "发送", "composer send button");
  assertContains(html, "textarea", "composer input");
  assertContains(html, "0/10000", "character counter");
});

console.log("\n=== friends ===");
check("renders search, requests and the friend list", () => {
  const html = renderToStaticMarkup(
    <FriendsView
      me="alice"
      friends={[
        { username: "bob", display_name: "鲍勃", avatar: false, name_color: null, since_ts: 1 },
      ]}
      requestsIn={[
        {
          id: 5,
          from_user: "carol",
          to_user: "alice",
          from_display_name: null,
          to_display_name: null,
          status: "pending",
          created_ts: 1,
          resolved_ts: null,
        },
      ]}
      requestsOut={[]}
      online={new Set(["bob"])}
      onStartDm={noop}
      onRefresh={noop}
      notify={noop}
    />,
  );
  assertContains(html, "添加好友", "friends search");
  assertContains(html, "输入用户名或显示名搜索", "friends search placeholder");
  assertContains(html, "收到的好友申请", "incoming requests");
  assertContains(html, "接受", "accept button");
  assertContains(html, "我的好友", "friend list");
  assertContains(html, "鲍勃", "display name is preferred over the username");
  assertContains(html, "发私聊", "start-DM action");
});

console.log("\n=== settings ===");
check("renders profile and desktop sections", () => {
  const html = renderToStaticMarkup(
    <SettingsView
      me="alice"
      profile={{ username: "alice", display_name: "Alice", bio: null, name_color: "#63d2ff" }}
      hasAvatar={false}
      desktop={{
        mode: "local",
        serverUrl: "",
        baseUrl: "http://127.0.0.1:5000",
        dataDir: "C:/Users/alice/AppData/Roaming/FatFish/data",
        appVersion: "1.0.0",
        electron: "45.3.1",
      }}
      theme="dark"
      onThemeChange={noop}
      onReloadProfile={noop}
      onLogout={noop}
      notify={noop}
    />,
  );
  assertContains(html, "显示名", "settings");
  assertContains(html, "名字颜色", "settings");
  assertContains(html, "服务端地址", "desktop-only section");
  assertContains(html, "保存并重启", "server switch");
  assertContains(html, "打开数据目录", "data directory shortcut");
  assertContains(html, "退出登录", "logout");
});

check("renders both theme choices and marks the active one", () => {
  const dark = renderToStaticMarkup(
    <SettingsView
      me="alice"
      profile={null}
      hasAvatar={false}
      desktop={null}
      theme="dark"
      onThemeChange={noop}
      onReloadProfile={noop}
      onLogout={noop}
      notify={noop}
    />,
  );
  assertContains(dark, "夜间模式", "theme picker");
  assertContains(dark, "日间模式", "theme picker");
  // The selected button is the one carrying `active` and aria-pressed="true".
  const darkActive = /class="active"[^>]*aria-pressed="true"/.test(dark);
  assert(darkActive, "dark mode should be marked active when theme=dark");

  const light = renderToStaticMarkup(
    <SettingsView
      me="alice"
      profile={null}
      hasAvatar={false}
      desktop={null}
      theme="light"
      onThemeChange={noop}
      onReloadProfile={noop}
      onLogout={noop}
      notify={noop}
    />,
  );
  const lightButton = light.slice(light.indexOf("日间模式"));
  assert(
    lightButton.length > 0 && lightButton.includes('aria-pressed="true"'),
    "light mode should be marked active when theme=light",
  );
});

check("renders without the desktop bridge (browser mode)", () => {
  const html = renderToStaticMarkup(
    <SettingsView
      me="alice"
      profile={null}
      hasAvatar={false}
      desktop={null}
      theme="dark"
      onThemeChange={noop}
      onReloadProfile={noop}
      onLogout={noop}
      notify={noop}
    />,
  );
  assertContains(html, "浏览器访问模式", "browser-mode note");
});

console.log("\n=== group management ===");
check("renders the member dock", () => {
  const html = renderToStaticMarkup(
    <GroupPanel
      privateId={7}
      title="周末联机"
      isGroup
      me="alice"
      myRole="owner"
      friends={[
        { username: "carol", display_name: null, avatar: false, name_color: null, since_ts: 1 },
      ]}
      onClose={noop}
      onChanged={noop}
      onLeft={noop}
      notify={noop}
    />,
  );
  assertContains(html, "群聊设置", "dock header");
  assertContains(html, "成员", "member count block");
  // The owner cannot simply leave: the dock must say so instead of offering it.
  assertContains(html, "群主不能直接退出", "owner cannot leave without transferring");
  assertContains(html, "解散群组", "owner can disband");
});

check("renders the create-group dialog", () => {
  const html = renderToStaticMarkup(
    <CreateGroupDialog
      friends={[
        { username: "bob", display_name: "鲍勃", avatar: false, name_color: null, since_ts: 1 },
      ]}
      onClose={noop}
      onCreate={asyncNoop}
    />,
  );
  assertContains(html, "新建群组", "dialog title");
  assertContains(html, "群组（owner / admin / member 三级权限）", "kind selector");
  assertContains(html, "私有频道（无角色，成员权限相同）", "legacy kind selector");
  assertContains(html, "鲍勃", "friend picker");
  assertContains(html, "仅群主和管理员可以邀请新成员", "invite policy can be chosen at creation");
});

check("renders the join dialog with one box for number or name", () => {
  const html = renderToStaticMarkup(
    <JoinGroupDialog onClose={noop} onRequested={noop} notify={noop} />,
  );
  assertContains(html, "加入群组", "dialog title");
  assertContains(html, "群号或群名", "one field covers both");
  assertContains(html, "查询", "lookup button");
  // Nothing is requested until a group has been looked up and shown.
  assertContains(html, 'disabled=""', "send button starts disabled");
});

console.log("\n=== formatting helpers ===");
check("DM titles join participants", () => {
  assert(dmTitle(["bob", "carol"]) === "bob、carol", `got ${dmTitle(["bob", "carol"])}`);
  assert(dmTitle([]) === "私聊", "empty DM title falls back");
  assert(dmChannelFor("alice", "bob") === "dm:alice:bob", dmChannelFor("alice", "bob"));
  // Python's sorted() is code-unit order: an uppercase name sorts before lowercase.
  assert(
    dmChannelFor("alice", "Zoe") === "dm:Zoe:alice",
    `code-unit ordering required by the backend, got ${dmChannelFor("alice", "Zoe")}`,
  );
});

check("clock and day labels", () => {
  assert(/^\d{2}:\d{2}$/.test(formatClock(1700000000)), `got ${formatClock(1700000000)}`);
  assert(formatDay(Date.now() / 1000) === "今天", "today");
  assert(formatDay(Date.now() / 1000 - 86400) === "昨天", "yesterday");
  assert(formatDay(1700000000).length > 4, "older days get a date");
});

console.log("\n" + "=".repeat(60));
console.log(`PASSED ${passed.length}   FAILED ${failed.length}`);
for (const [name, detail] of failed) console.log(`  ${name}: ${detail}`);
process.exit(failed.length === 0 ? 0 : 1);
