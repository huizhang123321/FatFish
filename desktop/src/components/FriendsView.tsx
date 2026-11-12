import { useState } from "react";
import * as api from "../lib/api";
import type { Friend, FriendRequestRow, SearchItem } from "../lib/types";
import { Avatar } from "./Avatar";

interface FriendsViewProps {
  me: string;
  friends: Friend[];
  requestsIn: FriendRequestRow[];
  requestsOut: FriendRequestRow[];
  online: Set<string>;
  onStartDm: (username: string) => void;
  onRefresh: () => void;
  notify: (message: string, kind?: "error" | "info") => void;
}

/**
 * People: search, incoming/outgoing requests, and the friend list.
 *
 * Every action calls the backend and then asks the shell to re-read the two
 * lists, so the view never drifts from what the server believes.
 */
export function FriendsView({
  me,
  friends,
  requestsIn,
  requestsOut,
  online,
  onStartDm,
  onRefresh,
  notify,
}: FriendsViewProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const runSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    const term = query.trim();
    if (!term) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const response = await api.searchUsers(term);
      setResults(response.items);
      if (response.items.length === 0) notify("没有找到匹配的用户", "info");
    } catch (err) {
      notify(err instanceof Error ? err.message : "搜索失败", "error");
    } finally {
      setSearching(false);
    }
  };

  const act = async (key: string, run: () => Promise<void>, done: string) => {
    setBusy(key);
    try {
      await run();
      notify(done, "info");
      onRefresh();
      if (results.length > 0) {
        const response = await api.searchUsers(query.trim());
        setResults(response.items);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : "操作失败", "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>好友</h2>
        <span className="panel-hint">{friends.length} 位好友</span>
      </header>

      <div className="panel-body">
        <section className="panel-block">
          <h3>添加好友</h3>
          <form className="search-form" onSubmit={runSearch}>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入用户名或显示名搜索"
              maxLength={32}
            />
            <button type="submit" className="primary-btn" disabled={searching}>
              {searching ? "搜索中…" : "搜索"}
            </button>
          </form>

          {results.length > 0 && (
            <ul className="person-list">
              {results.map((item) => (
                <li key={item.username}>
                  <Avatar
                    username={item.username}
                    label={item.display_name}
                    hasAvatar={item.avatar}
                    size={32}
                  />
                  <div className="person-text">
                    <strong style={item.name_color ? { color: item.name_color } : undefined}>
                      {item.display_name || item.username}
                    </strong>
                    <span>@{item.username}</span>
                  </div>
                  <RelationAction
                    item={item}
                    busy={busy === `search:${item.username}`}
                    onSend={() =>
                      act(
                        `search:${item.username}`,
                        () => api.sendFriendRequest(item.username),
                        `已向 ${item.username} 发送好友申请`,
                      )
                    }
                    onAccept={() => {
                      if (!item.request_id) return;
                      void act(
                        `search:${item.username}`,
                        () => api.acceptFriendRequest(item.request_id as number),
                        `已添加 ${item.username} 为好友`,
                      );
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel-block">
          <h3>
            收到的好友申请
            {requestsIn.length > 0 && <span className="count-pill">{requestsIn.length}</span>}
          </h3>
          {requestsIn.length === 0 ? (
            <p className="section-empty">没有待处理的申请</p>
          ) : (
            <ul className="person-list">
              {requestsIn.map((request) => (
                <li key={request.id}>
                  <Avatar
                    username={request.from_user}
                    label={request.from_display_name}
                    hasAvatar={false}
                    size={32}
                  />
                  <div className="person-text">
                    <strong>{request.from_display_name || request.from_user}</strong>
                    <span>@{request.from_user}</span>
                  </div>
                  <div className="person-actions">
                    <button
                      type="button"
                      className="primary-btn"
                      disabled={busy === `in:${request.id}`}
                      onClick={() =>
                        act(
                          `in:${request.id}`,
                          () => api.acceptFriendRequest(request.id),
                          `已添加 ${request.from_user} 为好友`,
                        )
                      }
                    >
                      接受
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={busy === `in:${request.id}`}
                      onClick={() =>
                        act(
                          `in:${request.id}`,
                          () => api.rejectFriendRequest(request.id),
                          "已拒绝该申请",
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
        </section>

        {requestsOut.length > 0 && (
          <section className="panel-block">
            <h3>已发出的申请</h3>
            <ul className="person-list">
              {requestsOut.map((request) => (
                <li key={request.id}>
                  <Avatar username={request.to_user} label={request.to_display_name} hasAvatar={false} size={32} />
                  <div className="person-text">
                    <strong>{request.to_display_name || request.to_user}</strong>
                    <span>等待对方确认</span>
                  </div>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={busy === `out:${request.id}`}
                    onClick={() =>
                      act(
                        `out:${request.id}`,
                        () => api.withdrawFriendRequest(request.id),
                        "已撤回申请",
                      )
                    }
                  >
                    撤回
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="panel-block">
          <h3>我的好友</h3>
          {friends.length === 0 ? (
            <p className="section-empty">还没有好友，先搜索添加一个吧。</p>
          ) : (
            <ul className="person-list">
              {friends.map((friend) => (
                <li key={friend.username}>
                  <Avatar
                    username={friend.username}
                    label={friend.display_name}
                    hasAvatar={friend.avatar}
                    size={32}
                  />
                  <div className="person-text">
                    <strong
                      style={friend.name_color ? { color: friend.name_color } : undefined}
                    >
                      {friend.display_name || friend.username}
                    </strong>
                    <span>
                      @{friend.username}
                      {online.has(friend.username) ? " · 在线" : ""}
                    </span>
                  </div>
                  <div className="person-actions">
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => onStartDm(friend.username)}
                    >
                      发私聊
                    </button>
                    <button
                      type="button"
                      className="ghost-btn danger"
                      disabled={busy === `rm:${friend.username}`}
                      onClick={() => {
                        if (!window.confirm(`确定删除好友 ${friend.username}？聊天记录会保留。`)) {
                          return;
                        }
                        void act(
                          `rm:${friend.username}`,
                          () => api.removeFriend(friend.username),
                          `已删除好友 ${friend.username}`,
                        );
                      }}
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <footer className="panel-footer">当前登录：@{me}</footer>
    </section>
  );
}

interface RelationActionProps {
  item: SearchItem;
  busy: boolean;
  onSend: () => void;
  onAccept: () => void;
}

/** The single action button that matches the viewer's relation to a user. */
function RelationAction({ item, busy, onSend, onAccept }: RelationActionProps) {
  if (item.relation === "friend") {
    return <span className="relation-tag">已是好友</span>;
  }
  if (item.relation === "pending_out") {
    return <span className="relation-tag">已申请</span>;
  }
  if (item.relation === "pending_in") {
    return (
      <button type="button" className="primary-btn" disabled={busy} onClick={onAccept}>
        接受申请
      </button>
    );
  }
  return (
    <button type="button" className="ghost-btn" disabled={busy} onClick={onSend}>
      加好友
    </button>
  );
}
