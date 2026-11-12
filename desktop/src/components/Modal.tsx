import { useState } from "react";
import type { Friend } from "../lib/types";
import { Avatar } from "./Avatar";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/** A centred dialog with a backdrop that closes on click. */
export function Modal({ title, onClose, children, footer }: ModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

interface CreateGroupDialogProps {
  friends: Friend[];
  onClose: () => void;
  onCreate: (
    name: string,
    members: string[],
    kind: "group" | "channel",
    inviteAdminOnly: boolean,
  ) => Promise<void>;
}

/**
 * Create a group (or a legacy private channel).
 *
 * The distinction matters: groups get owner/admin/member roles and the
 * management matrix, while a legacy channel stays role-free and behaves exactly
 * like the upstream feature.
 *
 * Group settings that shape the group from the first minute -- currently the
 * invite policy -- are chosen here rather than being fixed afterwards, because
 * "who may invite" is the kind of rule a group wants set before people arrive.
 */
export function CreateGroupDialog({ friends, onClose, onCreate }: CreateGroupDialogProps) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"group" | "channel">("group");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [inviteAdminOnly, setInviteAdminOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = (username: string) => {
    const next = new Set(selected);
    if (next.has(username)) next.delete(username);
    else next.add(username);
    setSelected(next);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("请填写名称");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onCreate(trimmed, [...selected], kind, inviteAdminOnly);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={kind === "group" ? "新建群组" : "新建私有频道"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="primary-btn" onClick={() => void submit()} disabled={busy}>
            {busy ? "创建中…" : "创建"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>名称</span>
        <input
          value={name}
          maxLength={40}
          autoFocus
          placeholder="例如：周末联机"
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <div className="field">
        <span>类型</span>
        <div className="kind-toggle">
          <button
            type="button"
            className={kind === "group" ? "active" : ""}
            onClick={() => setKind("group")}
          >
            群组（owner / admin / member 三级权限）
          </button>
          <button
            type="button"
            className={kind === "channel" ? "active" : ""}
            onClick={() => setKind("channel")}
          >
            私有频道（无角色，成员权限相同）
          </button>
        </div>
      </div>

      <div className="field">
        <span>初始成员（可选）</span>
        {friends.length === 0 ? (
          <p className="section-empty">还没有好友，可以先创建再邀请。</p>
        ) : (
          <ul className="pick-list">
            {friends.map((friend) => (
              <li key={friend.username}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(friend.username)}
                    onChange={() => toggle(friend.username)}
                  />
                  <Avatar
                    username={friend.username}
                    label={friend.display_name}
                    hasAvatar={friend.avatar}
                    size={26}
                  />
                  <span>{friend.display_name || friend.username}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {kind === "group" && (
        <div className="field">
          <span>群设置</span>
          <label className="policy-row">
            <input
              type="checkbox"
              checked={inviteAdminOnly}
              onChange={(event) => setInviteAdminOnly(event.target.checked)}
            />
            <span>仅群主和管理员可以邀请新成员</span>
          </label>
          <p className="settings-note">
            关闭时任何成员都能邀请。创建后群主可以在「群聊设置」里随时修改。
          </p>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
      <p className="settings-note">
        你会成为创建者；群组中创建者即群主，并会自动获得一个可分享的群号。
      </p>
    </Modal>
  );
}
