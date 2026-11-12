import type { ChannelRef } from "../lib/types";
import { Avatar } from "./Avatar";

interface SidebarProps {
  me: string;
  meAvatar: boolean;
  publicChannels: ChannelRef[];
  groups: ChannelRef[];
  privateChannels: ChannelRef[];
  dms: ChannelRef[];
  activeId: string | null;
  unread: Record<string, number>;
  online: Set<string>;
  friendRequestCount: number;
  onSelect: (channel: ChannelRef) => void;
  onCreateGroup: () => void;
  /** Open the "join a group with its number" dialog. */
  onJoinGroup: () => void;
  onOpenFriends: () => void;
  onOpenSettings: () => void;
  view: "chat" | "friends" | "settings";
}

/**
 * The left column: identity, then the three channel lists.
 *
 * Groups and legacy private channels are listed separately because they have
 * different management affordances, even though both render the same in the
 * transcript above.
 */
export function Sidebar({
  me,
  meAvatar,
  publicChannels,
  groups,
  privateChannels,
  dms,
  activeId,
  unread,
  online,
  friendRequestCount,
  onSelect,
  onCreateGroup,
  onJoinGroup,
  onOpenFriends,
  onOpenSettings,
  view,
}: SidebarProps) {
  const renderItem = (channel: ChannelRef) => {
    const count = channel.unread || unread[channel.id] || 0;
    const isOnline =
      channel.kind === "dm"
        ? (channel.dmUsers ?? []).some((user) => online.has(user))
        : false;
    return (
      <li key={channel.id}>
        <button
          type="button"
          className={`channel-item${channel.id === activeId ? " active" : ""}`}
          onClick={() => onSelect(channel)}
          title={channel.title}
        >
          <span className={`channel-glyph glyph-${channel.kind}`} aria-hidden="true">
            {channel.kind === "public" ? "#" : channel.kind === "dm" ? "@" : "◍"}
          </span>
          <span className="channel-name">
            {channel.title}
            {channel.kind === "group" && channel.role === "owner" && (
              <span className="role-chip owner">群主</span>
            )}
            {channel.kind === "group" && channel.role === "admin" && (
              <span className="role-chip admin">管理</span>
            )}
          </span>
          {isOnline && <span className="online-dot" title="在线" />}
          {count > 0 && <span className="unread-badge">{count > 99 ? "99+" : count}</span>}
        </button>
      </li>
    );
  };

  return (
    <nav className="sidebar">
      <header className="sidebar-me">
        <Avatar username={me} hasAvatar={meAvatar} size={36} />
        <div className="sidebar-me-text">
          <strong>{me}</strong>
          <span>{online.has(me) ? "在线" : "离线"}</span>
        </div>
      </header>

      <div className="sidebar-actions">
        <button
          type="button"
          className={`ghost-btn${view === "friends" ? " active" : ""}`}
          onClick={onOpenFriends}
        >
          好友
          {friendRequestCount > 0 && <span className="unread-badge">{friendRequestCount}</span>}
        </button>
        <button
          type="button"
          className={`ghost-btn${view === "settings" ? " active" : ""}`}
          onClick={onOpenSettings}
        >
          设置
        </button>
      </div>

      <div className="channel-sections">
        <Section title="公共频道" items={publicChannels} render={renderItem} />
        <Section
          title="群组"
          items={groups}
          render={renderItem}
          actions={[
            { label: "新建群组", onClick: onCreateGroup, glyph: "＋" },
            { label: "用群号加入", onClick: onJoinGroup, glyph: "⌕" },
          ]}
        />
        {privateChannels.length > 0 && (
          <Section title="私有频道" items={privateChannels} render={renderItem} />
        )}
        <Section title="私聊" items={dms} render={renderItem} />
      </div>
    </nav>
  );
}

interface SectionProps {
  title: string;
  items: ChannelRef[];
  render: (channel: ChannelRef) => React.ReactNode;
  actions?: { label: string; onClick: () => void; glyph: string }[];
}

function Section({ title, items, render, actions }: SectionProps) {
  return (
    <section className="channel-section">
      <h3>
        <span>{title}</span>
        {actions?.map((action) => (
          <button
            key={action.label}
            type="button"
            className="mini-btn"
            onClick={action.onClick}
            title={action.label}
            aria-label={action.label}
          >
            {action.glyph}
          </button>
        ))}
      </h3>
      {items.length === 0 ? (
        <p className="section-empty">暂无</p>
      ) : (
        <ul>{items.map(render)}</ul>
      )}
    </section>
  );
}
