import { useState } from "react";
import type { ChannelRef, MessageRow } from "../lib/types";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

interface ChatPaneProps {
  channel: ChannelRef;
  me: string;
  messages: MessageRow[];
  avatarUsers: Set<string>;
  loading: boolean;
  connected: boolean;
  typingUsers: string[];
  maxMessageChars: number;
  maxUploadBytes: number;
  managing: boolean;
  onToggleManage: () => void;
  onSend: (text: string, files: File[]) => Promise<void>;
  onTyping: () => void;
}

/**
 * The transcript pane for one channel.
 *
 * The header carries the channel's identity and the management entry point;
 * groups get a members/management dock, DMs and public channels do not.
 */
export function ChatPane({
  channel,
  me,
  messages,
  avatarUsers,
  loading,
  connected,
  typingUsers,
  maxMessageChars,
  maxUploadBytes,
  managing,
  onToggleManage,
  onSend,
  onTyping,
}: ChatPaneProps) {
  const canManage = channel.privateId !== undefined;

  // Counts sends so the transcript can reveal the message just posted, even when
  // the reader had scrolled up into history.
  const [sends, setSends] = useState(0);

  const sendAndReveal = async (text: string, files: File[]) => {
    await onSend(text, files);
    setSends((count) => count + 1);
  };

  return (
    <section className="chat-pane">
      <header className="chat-header">
        <div className="chat-title">
          <h2>
            <span className={`channel-glyph glyph-${channel.kind}`} aria-hidden="true">
              {channel.kind === "public" ? "#" : channel.kind === "dm" ? "@" : "◍"}
            </span>
            {channel.title}
          </h2>
          <span className="chat-subtitle">{channel.subtitle}</span>
        </div>

        <div className="chat-header-actions">
          <span
            className={`stream-badge${connected ? " on" : " off"}`}
            title={connected ? "实时连接正常" : "正在重新连接…"}
          >
            {connected ? "实时" : "重连中"}
          </span>
          {canManage && (
            <button
              type="button"
              className={`ghost-btn${managing ? " active" : ""}`}
              onClick={onToggleManage}
            >
              成员 / 管理
            </button>
          )}
        </div>
      </header>

      <MessageList
        messages={messages}
        me={me}
        avatarUsers={avatarUsers}
        loading={loading}
        channelId={channel.id}
        stickSignal={sends}
      />

      <div className="typing-line" aria-live="polite">
        {typingUsers.length > 0 && `${typingUsers.join("、")} 正在输入…`}
      </div>

      <Composer
        onSend={sendAndReveal}
        onTyping={onTyping}
        maxLength={maxMessageChars}
        maxUploadBytes={maxUploadBytes}
        placeholder={
          channel.kind === "dm"
            ? `发消息给 ${channel.title}…`
            : `在 ${channel.title} 里说点什么…`
        }
      />
    </section>
  );
}
