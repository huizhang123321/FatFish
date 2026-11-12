import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { EMOJI_GROUPS, STICKERS, stickerToken, stickerUrl } from "../lib/stickers";
import type { CustomSticker } from "../lib/types";

interface EmojiPickerProps {
  /** Insert plain text (an emoji) at the caret. */
  onEmoji: (emoji: string) => void;
  /** Insert a sticker token at the caret. */
  onSticker: (token: string) => void;
  onClose: () => void;
  /** Surface a problem the user needs to see. */
  onError?: (message: string) => void;
}

/**
 * The composer's emoji / sticker panel.
 *
 * Two tabs because the two things behave differently: an emoji is a character and
 * ends up inline in the sentence, while a sticker is a picture sent as a token the
 * renderer turns into an image. Mixing them into one grid would make it unclear
 * which one you are about to insert.
 *
 * The sticker tab also carries the shared imported library, with an import button:
 * the server stores those images so everyone in the conversation sees the same
 * sticker, rather than it living in one person's browser.
 */
export function EmojiPicker({ onEmoji, onSticker, onClose, onError }: EmojiPickerProps) {
  const [tab, setTab] = useState<"emoji" | "sticker">("emoji");
  const [group, setGroup] = useState(EMOJI_GROUPS[0].name);

  const [custom, setCustom] = useState<CustomSticker[]>([]);
  const [limit, setLimit] = useState<{ max: number; maxBytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const active = EMOJI_GROUPS.find((item) => item.name === group) ?? EMOJI_GROUPS[0];

  const load = useCallback(async () => {
    try {
      const data = await api.listCustomStickers();
      setCustom(data.items);
      setLimit({ max: data.max, maxBytes: data.max_bytes });
      setLoadError("");
    } catch (err) {
      // An older server without the sticker routes answers 404/302; saying so is
      // better than an empty grid that looks like a bug.
      setLoadError(err instanceof Error ? err.message : "读取贴纸失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const importSticker = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await api.importCustomSticker(file, file.name.replace(/\.[^.]+$/, ""));
      await load();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "导入失败");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeSticker = async (sticker: CustomSticker) => {
    if (!window.confirm(`删除贴纸「${sticker.name || sticker.id}」？已发出去的消息会显示成文字。`)) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteCustomSticker(sticker.id);
      await load();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="emoji-panel" role="dialog" aria-label="表情与贴纸">
      <header className="emoji-tabs">
        <button
          type="button"
          className={tab === "emoji" ? "active" : ""}
          onClick={() => setTab("emoji")}
        >
          表情
        </button>
        <button
          type="button"
          className={tab === "sticker" ? "active" : ""}
          onClick={() => setTab("sticker")}
        >
          贴纸
        </button>
        <button type="button" className="emoji-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </header>

      {tab === "emoji" ? (
        <>
          <div className="emoji-groups">
            {EMOJI_GROUPS.map((item) => (
              <button
                key={item.name}
                type="button"
                className={item.name === group ? "active" : ""}
                onClick={() => setGroup(item.name)}
              >
                {item.name}
              </button>
            ))}
          </div>
          <div className="emoji-grid">
            {active.emoji.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="emoji-cell"
                title={emoji}
                onClick={() => onEmoji(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="sticker-panel">
          <div className="sticker-section-head">
            <span>内置</span>
          </div>
          <div className="sticker-grid">
            {STICKERS.map((sticker) => (
              <button
                key={sticker.id}
                type="button"
                className="sticker-cell"
                title={sticker.label}
                onClick={() => onSticker(stickerToken(sticker.id))}
              >
                <img src={stickerUrl(sticker.id)} alt={sticker.label} loading="lazy" />
              </button>
            ))}
          </div>

          <div className="sticker-section-head">
            <span>
              自定义{limit ? `（${custom.length}/${limit.max}）` : ""}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(event) => void importSticker(event.target.files?.[0])}
            />
            <button
              type="button"
              className="mini-btn"
              disabled={busy || (limit !== null && custom.length >= limit.max)}
              onClick={() => fileRef.current?.click()}
              title="导入图片作为贴纸（PNG / JPEG / GIF / WebP，1 MB 以内）"
            >
              ＋ 导入
            </button>
          </div>

          {loadError ? (
            <p className="section-empty">
              自定义贴纸不可用：{loadError}
              <br />
              服务端可能是旧版本，需要先更新程序。
            </p>
          ) : custom.length === 0 ? (
            <p className="section-empty">
              还没有自定义贴纸。点「导入」选一张图片，它会存到服务端，所有人都能用。
            </p>
          ) : (
            <div className="sticker-grid">
              {custom.map((sticker) => (
                <div className="sticker-cell custom" key={sticker.id}>
                  <button
                    type="button"
                    className="sticker-pick"
                    title={sticker.name || `贴纸 ${sticker.id}`}
                    onClick={() => onSticker(sticker.token)}
                  >
                    <img src={sticker.url} alt={sticker.name || "贴纸"} loading="lazy" />
                  </button>
                  {sticker.mine && (
                    <button
                      type="button"
                      className="sticker-del"
                      title="删除这个贴纸"
                      disabled={busy}
                      onClick={() => void removeSticker(sticker)}
                    >
                      ×
                    </button>
                  )}
                  {!sticker.mine && (
                    <span className="sticker-owner" title={`由 ${sticker.uploader} 导入`}>
                      {sticker.uploader.slice(0, 2)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <p className="sticker-note">
            贴纸存在服务端，所有人都能看到；只有导入者能删除。上限{" "}
            {limit ? Math.round(limit.maxBytes / 1024) : 1024} KB。
          </p>
        </div>
      )}
    </div>
  );
}
