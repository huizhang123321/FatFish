import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import type {
  Friend,
  GroupRoster,
  GroupRole,
  GroupSettings,
  JoinRequestIncoming,
} from "../lib/types";
import { Avatar } from "./Avatar";

interface GroupPanelProps {
  privateId: number;
  title: string;
  isGroup: boolean;
  me: string;
  myRole: GroupRole | undefined;
  friends: Friend[];
  onClose: () => void;
  /** Ask the shell to re-read the channel lists after a membership change. */
  onChanged: () => void;
  /** The user is no longer in this channel; navigate away from it. */
  onLeft: () => void;
  notify: (message: string, kind?: "error" | "info") => void;
}

/**
 * The group settings and member management dock.
 *
 * Two halves that answer two different questions. **群聊设置** is about the group
 * itself: its number, its name, and who is allowed to invite. The member list
 * below it is about people: promote, hand over ownership, remove.
 *
 * Legacy private channels (``kind: "channel"``) have no roles and no number, so
 * the dock degrades to a plain member list plus invite/leave, matching the
 * backend's "no role enforcement on old channels" behaviour.
 */
export function GroupPanel({
  privateId,
  title,
  isGroup,
  me,
  myRole,
  friends,
  onClose,
  onChanged,
  onLeft,
  notify,
}: GroupPanelProps) {
  const [roster, setRoster] = useState<GroupRoster | null>(null);
  const [settings, setSettings] = useState<GroupSettings | null>(null);
  const [incoming, setIncoming] = useState<JoinRequestIncoming[]>([]);
  const [invite, setInvite] = useState("");
  const [rename, setRename] = useState(title);
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [members, group, requests] = await Promise.all([
        api.groupRoster(privateId),
        // A legacy channel has no settings endpoint content worth showing; the
        // request still succeeds, so this keeps one code path.
        api.groupSettings(privateId).catch(() => null),
        // The queue is global (every group this user manages); the panel filters
        // to the group on screen.
        api.joinRequests().catch(() => ({ incoming: [], outgoing: [] })),
      ]);
      setRoster(members);
      setSettings(group);
      setIncoming(requests.incoming);
      if (group) setRename(group.name);
    } catch (err) {
      notify(err instanceof Error ? err.message : "读取成员失败", "error");
    }
  }, [privateId, notify]);

  useEffect(() => {
    setRename(title);
    setCopied(false);
    void load();
  }, [privateId, title, load]);

  const isOwner = myRole === "owner";
  const canRename = settings ? settings.can_manage : !isGroup || isOwner || myRole === "admin";
  const canChangePolicy = settings ? settings.can_change_policy : isOwner;

  const members = roster?.members ?? [];
  const memberNames = new Set(members.map((member) => member.username));
  const invitable = friends.filter((friend) => !memberNames.has(friend.username));
  const groupNo = settings?.group_no || "";

  const run = async (
    key: string,
    action: () => Promise<void>,
    done: string,
  ): Promise<boolean> => {
    setBusy(key);
    try {
      await action();
      notify(done, "info");
      await load();
      onChanged();
      return true;
    } catch (err) {
      notify(err instanceof Error ? err.message : "操作失败", "error");
      return false;
    } finally {
      setBusy("");
    }
  };

  const copyGroupNo = async () => {
    if (!groupNo) return;
    try {
      await navigator.clipboard.writeText(groupNo);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard needs a secure context and permission; fall back to selecting.
      window.prompt("复制群号（Ctrl+C）：", groupNo);
    }
  };

  return (
    <aside className="dock">
      <header className="dock-header">
        <h3>{isGroup ? "群聊设置" : "频道成员"}</h3>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="收起">
          ×
        </button>
      </header>

      <div className="dock-body">
        {isGroup && (
          <section className="dock-block">
            <h4>群号</h4>
            {settings === null ? (
              // Settings could not be read (old server, transient failure): say
              // nothing rather than claiming the group has no number.
              <p className="section-empty">群号读取中…</p>
            ) : groupNo ? (
              <div className="group-no-row">
                <code className="group-no">{groupNo}</code>
                <button type="button" className="mini-btn" onClick={() => void copyGroupNo()}>
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
            ) : (
              <p className="section-empty">这个群还没有群号。</p>
            )}
            <p className="settings-note">
              群号固定不变，可发给朋友作为这个群的标识；它不用于搜索加入，加入仍需群内成员邀请。
            </p>
          </section>
        )}

        {isGroup && (
          <section className="dock-block">
            <h4>管理设定</h4>
            <label className="policy-row">
              <input
                type="checkbox"
                checked={settings?.invite_admin_only ?? false}
                disabled={!canChangePolicy || busy !== "" || !!settings?.invite_gated_globally}
                onChange={(event) => {
                  const next = event.target.checked;
                  void run(
                    "policy",
                    () => api.saveGroupSettings(privateId, { invite_admin_only: next }),
                    next ? "已改为仅群主/管理员可邀请" : "已允许所有成员邀请",
                  );
                }}
              />
              <span>
                仅群主和管理员可以邀请新成员
                {settings?.invite_gated_globally ? "（已被服务端全局强制开启）" : ""}
              </span>
            </label>
            <p className="settings-note">
              {canChangePolicy
                ? "关闭时，任何成员都可以邀请自己的好友入群。"
                : "只有群主可以修改这项设定。"}
            </p>

            <label className="policy-row discoverable-row">
              <input
                type="checkbox"
                checked={settings?.discoverable ?? false}
                disabled={!canChangePolicy || busy !== ""}
                onChange={(event) => {
                  const next = event.target.checked;
                  void run(
                    "discoverable",
                    () => api.saveGroupSettings(privateId, { discoverable: next }),
                    next ? "已允许通过群名搜索到本群" : "已停止通过群名被发现",
                  );
                }}
              />
              <span>允许别人通过群名搜索到本群</span>
            </label>
            <p className="settings-note">
              默认关闭。开启后，陌生人能按群名搜到这个群并申请加入（仍需审批）；
              关闭时只有拿到群号的人才能申请。
            </p>
          </section>
        )}

        {canRename && (
          <section className="dock-block">
            <h4>群名称</h4>
            <div className="dock-inline">
              <input
                value={rename}
                maxLength={40}
                onChange={(event) => setRename(event.target.value)}
              />
              <button
                type="button"
                className="ghost-btn"
                disabled={!rename.trim() || rename === title || busy !== ""}
                onClick={() =>
                  void run(
                    "rename",
                    () => api.saveGroupSettings(privateId, { name: rename.trim() }),
                    "已改名",
                  )
                }
              >
                保存
              </button>
            </div>
          </section>
        )}

        {isGroup && (settings?.can_manage ?? false) && (
          <section className="dock-block">
            <h4>
              入群申请{incoming.length > 0 ? ` · ${incoming.length}` : ""}
            </h4>
            {incoming.length === 0 ? (
              <p className="section-empty">还没有人申请加入。</p>
            ) : (
              <ul className="join-request-list">
                {incoming
                  .filter((request) => request.channel_id === privateId)
                  .map((request) => (
                    <li key={request.id}>
                      <div className="join-request-text">
                        <strong>{request.username}</strong>
                        {request.note && <span className="join-request-note">{request.note}</span>}
                      </div>
                      <div className="member-actions">
                        <button
                          type="button"
                          className="mini-btn"
                          disabled={busy !== ""}
                          onClick={() =>
                            void run(
                              `approve:${request.id}`,
                              () => api.decideJoinRequest(privateId, request.id, "approve"),
                              "已同意入群",
                            )
                          }
                        >
                          同意
                        </button>
                        <button
                          type="button"
                          className="mini-btn danger"
                          disabled={busy !== ""}
                          onClick={() =>
                            void run(
                              `reject:${request.id}`,
                              () => api.decideJoinRequest(privateId, request.id, "reject"),
                              "已拒绝",
                            )
                          }
                        >
                          拒绝
                        </button>
                      </div>
                    </li>
                  ))}
              </ul>
            )}
            <p className="settings-note">
              别人用群号申请加入后出现在这里；同意后他成为普通成员，看不到申请之前的消息。
            </p>
          </section>
        )}

        <section className="dock-block">
          <h4>成员 · {members.length}</h4>
          <ul className="member-list">
            {members.map((member) => {
              const self = member.username === me;
              const memberRole = member.role;
              const canRemove =
                isGroup &&
                !self &&
                (isOwner || (myRole === "admin" && memberRole === "member"));
              const canSetRole =
                isGroup && isOwner && !self && memberRole !== "owner";
              return (
                <li key={member.username}>
                  <Avatar
                    username={member.username}
                    label={member.display_name}
                    hasAvatar={member.avatar}
                    size={28}
                  />
                  <div className="member-text">
                    <strong>{member.display_name || member.username}</strong>
                    {self && <span className="self-tag">你</span>}
                    {memberRole !== "member" && (
                      <span className={`role-chip ${memberRole}`}>
                        {memberRole === "owner" ? "群主" : "管理员"}
                      </span>
                    )}
                  </div>
                  {isGroup && (
                    <div className="member-actions">
                      {canSetRole && (
                        <button
                          type="button"
                          className="mini-btn"
                          disabled={busy !== ""}
                          title={memberRole === "admin" ? "取消管理员" : "设为管理员"}
                          onClick={() =>
                            void run(
                              `role:${member.username}`,
                              () =>
                                api.setRole(
                                  privateId,
                                  member.username,
                                  memberRole === "admin" ? "member" : "admin",
                                ),
                              memberRole === "admin" ? "已取消管理员" : "已设为管理员",
                            )
                          }
                        >
                          {memberRole === "admin" ? "取消管理" : "设为管理"}
                        </button>
                      )}
                      {canSetRole && (
                        <button
                          type="button"
                          className="mini-btn"
                          disabled={busy !== ""}
                          title="转让群主"
                          onClick={() => {
                            if (
                              !window.confirm(
                                `确定把群主转让给 ${member.username}？转让后你会变成管理员。`,
                              )
                            ) {
                              return;
                            }
                            void run(
                              `transfer:${member.username}`,
                              () => api.transferOwnership(privateId, member.username),
                              "群主已转让",
                            );
                          }}
                        >
                          转让群主
                        </button>
                      )}
                      {canRemove && (
                        <button
                          type="button"
                          className="mini-btn danger"
                          disabled={busy !== ""}
                          title="移出群组"
                          onClick={() => {
                            if (!window.confirm(`确定把 ${member.username} 移出群组？`)) return;
                            void run(
                              `rm:${member.username}`,
                              () => api.removeMember(privateId, member.username),
                              "已移出群组",
                            );
                          }}
                        >
                          移出
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {invitable.length > 0 ? (
          <section className="dock-block">
            <h4>邀请成员</h4>
            <div className="dock-inline">
              <select value={invite} onChange={(event) => setInvite(event.target.value)}>
                <option value="">选择好友…</option>
                {invitable.map((friend) => (
                  <option key={friend.username} value={friend.username}>
                    {friend.display_name || friend.username}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="primary-btn"
                disabled={!invite || busy !== ""}
                onClick={() =>
                  void run("invite", () => api.addMember(privateId, invite), "已邀请").then(() =>
                    setInvite(""),
                  )
                }
              >
                邀请
              </button>
            </div>
            <p className="settings-note">
              新成员看不到加入之前的消息；若设定为「仅群主和管理员可邀请」，普通成员的邀请会被服务端拒绝。
            </p>
          </section>
        ) : null}

        <section className="dock-block">
          <h4>离开</h4>
          {isGroup && isOwner ? (
            <p className="settings-note">
              群主不能直接退出：请先把群主转让给其他成员，或直接解散群组。
            </p>
          ) : (
            <button
              type="button"
              className="ghost-btn danger"
              disabled={busy !== ""}
              onClick={() => {
                if (!window.confirm(`确定离开「${title}」？`)) return;
                // Only navigate away once the server confirms: a refused leave
                // (e.g. an owner who has not transferred yet) must keep the
                // channel open so the reason in the toast still makes sense.
                void run("leave", () => api.leaveChannel(privateId), "已离开").then((ok) => {
                  if (ok) onLeft();
                });
              }}
            >
              离开
            </button>
          )}

          {isGroup && isOwner && (
            <button
              type="button"
              className="ghost-btn danger"
              disabled={busy !== ""}
              onClick={() => {
                const typed = window.prompt(
                  `解散后无法恢复。请输入群名「${title}」以确认：`,
                  "",
                );
                if (typed === null) return;
                if (typed !== title) {
                  notify("群名不一致，未执行解散", "error");
                  return;
                }
                void run("disband", () => api.disbandGroup(privateId, title), "群组已解散").then(
                  (ok) => {
                    if (ok) onLeft();
                  },
                );
              }}
            >
              解散群组
            </button>
          )}
        </section>
      </div>
    </aside>
  );
}
