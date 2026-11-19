import { useEffect, useRef, useState } from "react";
import { formatBytes, isAudioName } from "../lib/format";
import { EmojiPicker } from "./EmojiPicker";
import { VoiceRecorder } from "./VoiceRecorder";

interface ComposerProps {
  /** Called with the trimmed text and any attached files. */
  onSend: (text: string, files: File[]) => Promise<void>;
  /** Called when the user starts typing, for the "is typing" indicator. */
  onTyping?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Maximum characters the backend accepts. */
  maxLength: number;
  /** Maximum total upload size in bytes (backend setting, 25 MB by default). */
  maxUploadBytes: number;
}

/**
 * The message input: text, attached images or voice notes, emoji and stickers.
 *
 * Attachments are held client-side until the send succeeds, then cleared, so a
 * failed send does not silently drop them. A voice note is just a file here -- see
 * VoiceRecorder for why that is the whole story.
 */
export function Composer({
  onSend,
  onTyping,
  disabled,
  placeholder,
  maxLength,
  maxUploadBytes,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"emoji" | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Grow the textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  /**
   * Insert text at the caret rather than at the end.
   *
   * With the panel open the textarea loses focus, so ``selectionStart`` is read
   * from the element and the caret is put back afterwards -- otherwise every emoji
   * would land at the end of a sentence the user is editing in the middle.
   */
  const insertAtCaret = (snippet: string) => {
    const el = textareaRef.current;
    if (!el) {
      setText((current) => (current + snippet).slice(0, maxLength));
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = (el.value.slice(0, start) + snippet + el.value.slice(end)).slice(0, maxLength);
    setText(next);
    window.requestAnimationFrame(() => {
      el.focus();
      const caret = Math.min(start + snippet.length, next.length);
      el.setSelectionRange(caret, caret);
    });
  };

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    const next = [...files, ...Array.from(incoming)];
    const nextBytes = next.reduce((sum, file) => sum + file.size, 0);
    if (nextBytes > maxUploadBytes) {
      setError(`附件总大小不能超过 ${formatBytes(maxUploadBytes)}`);
      return;
    }
    setError("");
    setFiles(next);
  };

  const submit = async () => {
    const trimmed = text.trim();
    if ((!trimmed && files.length === 0) || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSend(trimmed, files);
      setText("");
      setFiles([]);
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`composer${disabled ? " is-disabled" : ""}`}>
      {files.length > 0 && (
        <div className="composer-attachments">
          {files.map((file, index) => (
            <span className="attachment-chip" key={`${file.name}-${index}`}>
              <span className="chip-name">{file.name}</span>
              <span className="chip-size">{formatBytes(file.size)}</span>
              <button
                type="button"
                aria-label={`移除 ${file.name}`}
                onClick={() => setFiles(files.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="form-error composer-error">{error}</p>}

      {panel === "emoji" && (
        <EmojiPicker
          onEmoji={(emoji) => insertAtCaret(emoji)}
          onSticker={(token) => insertAtCaret(token)}
          onClose={() => setPanel(null)}
        />
      )}

      <div className="composer-row">
        <button
          type="button"
          className="icon-btn"
          title="表情与贴纸"
          aria-label="表情与贴纸"
          disabled={disabled || busy}
          onClick={() => setPanel(panel === "emoji" ? null : "emoji")}
        >
          <SmileIcon />
        </button>

        <VoiceRecorder
          disabled={disabled || busy}
          onError={(message) => setError(message)}
          onRecorded={(file) => {
            const nextBytes = [...files, file].reduce((sum, item) => sum + item.size, 0);
            if (nextBytes > maxUploadBytes) {
              setError(`附件总大小不能超过 ${formatBytes(maxUploadBytes)}`);
              return;
            }
            setError("");
            setFiles((current) => [...current, file]);
          }}
        />

        <button
          type="button"
          className="icon-btn"
          title="添加附件（图片、文档、压缩包……任意文件）"
          aria-label="添加附件"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          ＋
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />

        <textarea
          ref={textareaRef}
          value={text}
          disabled={disabled || busy}
          placeholder={placeholder ?? "输入消息，Enter 发送，Shift+Enter 换行"}
          maxLength={maxLength}
          rows={1}
          onChange={(event) => {
            setText(event.target.value);
            onTyping?.();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />

        <button
          type="button"
          className="primary-btn send-btn"
          disabled={disabled || busy || (!text.trim() && files.length === 0)}
          onClick={() => void submit()}
        >
          {busy ? "…" : "发送"}
        </button>
      </div>

      <div className="composer-meta">
        <span>
          {text.length}/{maxLength}
        </span>
        {totalBytes > 0 && <span>附件 {formatBytes(totalBytes)}</span>}
        {files.some((file) => isAudioName(file.name)) && <span className="voice-hint">含语音</span>}
      </div>
    </div>
  );
}

/** Smile glyph for the emoji/sticker button. */
function SmileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="9" cy="10" r="1.4" fill="currentColor" />
      <circle cx="15" cy="10" r="1.4" fill="currentColor" />
      <path
        d="M8.5 14.5a4 4 0 0 0 7 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
