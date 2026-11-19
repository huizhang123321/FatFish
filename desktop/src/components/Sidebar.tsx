import type { Theme } from "../lib/theme";
import type { ChannelRef } from "../lib/types";
import { Avatar } from "./Avatar";
import { FishMark } from "./LoginScreen";

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
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  /** True on phones: the sidebar is the whole screen, not a column. */
  mobile?: boolean;
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
  theme,
  onThemeChange,
  mobile = false,
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
    <nav className={`sidebar${mobile ? " is-mobile" : ""}`}>
      {mobile ? (
        <header className="mobile-appbar">
          <FishMark size={28} />
          <div className="mobile-appbar-text">
            <strong>FatFish</strong>
            <span>
              @{me} · {online.has(me) ? "在线" : "离线"}
            </span>
          </div>
          <button
            type="button"
            className="mobile-theme-btn"
            onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
            aria-label={theme === "dark" ? "切换到日间模式" : "切换到夜间模式"}
            title={theme === "dark" ? "日间模式" : "夜间模式"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <Avatar username={me} hasAvatar={meAvatar} size={34} />
        </header>
      ) : (
        <header className="sidebar-me">
          <Avatar username={me} hasAvatar={meAvatar} size={36} />
          <div className="sidebar-me-text">
            <strong>{me}</strong>
            <span>{online.has(me) ? "在线" : "离线"}</span>
          </div>
        </header>
      )}

      {!mobile && (
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
      )}

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

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
      <circle cx="12" cy="12" r="3.7" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
      <path
        d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.2 8.2 0 1 0 20 14.2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
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
