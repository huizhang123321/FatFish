import { useCallback, useEffect, useRef } from "react";
import { fileUrl } from "../lib/api";
import {
  fileExtension,
  fileGlyph,
  formatClock,
  formatDay,
  isAudioName,
  isImageName,
  originalFileName,
  parseMentions,
  parseReactions,
  sameDay,
} from "../lib/format";
import { hasSticker, parseStickerText, stickerUrl } from "../lib/stickers";
import type { MessageRow } from "../lib/types";
import { Avatar } from "./Avatar";

interface MessageListProps {
  messages: MessageRow[];
  me: string;
  /** Everyone who has a custom avatar, so images are only requested when real. */
  avatarUsers: Set<string>;
  loading: boolean;
  /** Conversation id. Entering a new one always lands on the newest message. */
  channelId?: string;
  /** Bumped by the pane when the user sends, to reveal what was just sent. */
  stickSignal?: number;
}

/** Consecutive messages from one sender inside this window are grouped. */
const GROUP_WINDOW_SECONDS = 5 * 60;

/**
 * The scrolling transcript.
 *
 * Keeps the newest message in view unless the user has scrolled up to read
 * history, in which case new arrivals must not yank the viewport away.
 *
 * "Which conversation am I in" is part of that state, not outside it: the
 * scroll position of the previous channel must not decide where a newly-opened
 * one starts. Entering a chat always lands on the last message.
 */
export function MessageList({
  messages,
  me,
  avatarUsers,
  loading,
  channelId = "",
  stickSignal = 0,
}: MessageListProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const visible = messages.filter((row) => !row.deleted);

  /**
   * Pin the viewport to the newest message.
   *
   * Repeated after a frame and again after a moment because images, stickers and
   * voice players only acquire their height after layout — a single pass leaves
   * the view a few hundred pixels short of the bottom, which reads as "it opened
   * near the bottom but not at it".
   */
  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    window.requestAnimationFrame(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    window.setTimeout(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    }, 150);
  }, []);

  // Entering a conversation discards the previous one's scroll state. Without
  // this, having scrolled up in channel A meant channel B opened at its top.
  useEffect(() => {
    stickToBottom.current = true;
    scrollToBottom();
  }, [channelId, scrollToBottom]);

  // Follow new messages, but only while the reader is already at the bottom.
  useEffect(() => {
    if (!stickToBottom.current) return;
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Sending always reveals what was just sent, even if the reader had scrolled up.
  useEffect(() => {
    if (!stickSignal) return;
    stickToBottom.current = true;
    scrollToBottom();
  }, [stickSignal, scrollToBottom]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < 80;
  };

  if (loading) {
    return (
      <div className="message-scroll" ref={scrollerRef}>
        <p className="placeholder">正在载入消息…</p>
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className="message-scroll" ref={scrollerRef}>
        <p className="placeholder">这里还没有消息，说点什么吧。</p>
      </div>
    );
  }

  return (
    <div className="message-scroll" ref={scrollerRef} onScroll={onScroll}>
      {visible.map((row, index) => {
        const previous = visible[index - 1];
        const showDay = !previous || !sameDay(previous.ts, row.ts);
        const grouped =
          !!previous &&
          !showDay &&
          previous.sender === row.sender &&
          row.content_type !== "system" &&
          previous.content_type !== "system" &&
          row.ts - previous.ts < GROUP_WINDOW_SECONDS;

        return (
          <div key={row.id}>
            {showDay && <div className="day-separator">{formatDay(row.ts)}</div>}
            {row.content_type === "system" ? (
              <p className="system-message">{row.content}</p>
            ) : (
              <MessageRowView
                row={row}
                me={me}
                grouped={grouped}
                hasAvatar={avatarUsers.has(row.sender)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface RowProps {
  row: MessageRow;
  me: string;
  grouped: boolean;
  hasAvatar: boolean;
}

function MessageRowView({ row, me, grouped, hasAvatar }: RowProps) {
  const mine = row.sender === me;
  const reactions = parseReactions(row.reactions);
  const mentions = parseMentions(row.mentions);
  const mentionsMe = mentions.includes("everyone") || mentions.includes(me);

  return (
    <article
      className={`message${grouped ? " grouped" : ""}${mine ? " mine" : ""}${
        mentionsMe ? " mentions-me" : ""
      }`}
    >
      <div className="message-gutter">
        {grouped ? (
          <time className="message-time-inline">{formatClock(row.ts)}</time>
        ) : (
          <Avatar username={row.sender} hasAvatar={hasAvatar} size={34} />
        )}
      </div>

      <div className="message-body">
        {!grouped && (
          <header className="message-head">
            <span className="message-sender">{row.sender}</span>
            <time>{formatClock(row.ts)}</time>
            {row.edited ? <span className="edited-tag">已编辑</span> : null}
          </header>
        )}

        {row.content && <MessageContent text={row.content} />}

        {row.filename && <Attachment filename={row.filename} />}

        {Object.keys(reactions).length > 0 && (
          <div className="reaction-row">
            {Object.entries(reactions).map(([emoji, users]) => (
              <span key={emoji} className="reaction" title={users.join("、")}>
                {emoji} {users.length}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * Message body text, with stickers rendered as pictures.
 *
 * A sticker travels as the plain-text token ``[sticker:id]`` (see lib/stickers),
 * so this is where it becomes an image. Plain runs stay in the paragraph, and a
 * message that is *only* a sticker renders no empty paragraph.
 */
function MessageContent({ text }: { text: string }) {
  if (!hasSticker(text)) {
    return <p className="message-text">{text}</p>;
  }

  const parts = parseStickerText(text);
  const onlyStickers = parts.every((part) => part.kind === "sticker");

  return (
    <div className={`message-text message-text-rich${onlyStickers ? " stickers-only" : ""}`}>
      {parts.map((part, index) =>
        part.kind === "sticker" ? (
          <img
            key={`${part.id}-${index}`}
            className="message-sticker"
            src={stickerUrl(part.id)}
            alt={`贴纸 ${part.id}`}
            loading="lazy"
          />
        ) : (
          <span key={`t-${index}`}>{part.text}</span>
        ),
      )}
    </div>
  );
}

/** An image shown inline, a voice note played in place, or a download link. */
function Attachment({ filename }: { filename: string }) {
  if (isImageName(filename)) {
    return (
      <a className="attachment-image" href={fileUrl(filename)} target="_blank" rel="noreferrer">
        <img src={fileUrl(filename)} alt={filename} loading="lazy" />
      </a>
    );
  }
  if (isAudioName(filename)) {
    // A voice note: playable here, and still downloadable because the server sends
    // non-image uploads with a download disposition.
    return (
      <div className="attachment-audio">
        <audio controls preload="metadata" src={fileUrl(filename)}>
          你的浏览器不支持音频播放。
        </audio>
        <a className="attachment-audio-dl" href={fileUrl(filename)} download title="下载语音">
          ⭳
        </a>
      </div>
    );
  }
  // The stored name is a UUID plus the sender's name (see
  // ``chat._encode_upload_name``); recover that name so the card is readable.
  const name = originalFileName(filename);
  const ext = fileExtension(name);
  return (
    <a className="attachment-file" href={fileUrl(filename)} download={name}>
      <span className="attachment-file-glyph" aria-hidden="true">
        {fileGlyph(name)}
      </span>
      <span className="attachment-file-body">
        <span className="attachment-file-name" title={name}>
          {name}
        </span>
        <span className="attachment-file-meta">{ext} 文件</span>
      </span>
      <span className="attachment-file-dl" aria-hidden="true">
        ⭳
      </span>
    </a>
  );
}
