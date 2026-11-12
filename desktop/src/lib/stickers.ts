/**
 * Stickers and emoji.
 *
 * Two different things, deliberately kept apart:
 *
 * * **Emoji** are Unicode characters. They are inserted into the message text and
 *   rendered by the system font, so they need no assets, work in every client and
 *   survive copy/paste.
 * * **Stickers** are images. They are original artwork drawn for this project
 *   (no third-party sticker sets, and specifically nothing from any commercial
 *   chat product), served from ``/static/stickers/<id>.svg`` by the same Flask app.
 *   A message carries a token ``[sticker:<id>]`` and the renderer turns the known
 *   tokens into images.
 *
 * A token is plain text on the wire, so an old client shows ``[sticker:happy]``
 * rather than a broken image, and history stays searchable.
 */

/** Directory the sticker images are served from. */
const STICKER_BASE = "/static/stickers";

/** One sticker, as drawn in `minimost/static/stickers/`. */
export interface Sticker {
  id: string;
  label: string;
}

/** Every sticker shipped with the app. Keep in sync with the static directory. */
export const STICKERS: Sticker[] = [
  { id: "happy", label: "开心" },
  { id: "laugh", label: "大笑" },
  { id: "love", label: "喜欢" },
  { id: "sad", label: "难过" },
  { id: "angry", label: "生气" },
  { id: "sleepy", label: "困了" },
  { id: "cool", label: "酷" },
  { id: "nice", label: "赞" },
];

const STICKER_IDS = new Set(STICKERS.map((sticker) => sticker.id));

/**
 * Imported stickers ("表情包") get ids like ``custom-12``.
 *
 * The prefix is the whole protocol between the server and the renderer: it means a
 * message can be rendered anywhere without first fetching the sticker library, and
 * a built-in id can never collide with an imported one.
 */
const CUSTOM_RE = /^custom-(\d+)$/;

/** True when this id can be rendered (built-in or imported). */
export function isKnownSticker(id: string): boolean {
  return STICKER_IDS.has(id) || CUSTOM_RE.test(id);
}

/**
 * URL of a sticker image.
 *
 * Built-ins are files in the package (``/static/stickers``); imported ones are
 * served from the data directory by the sticker blueprint, so they survive a
 * reinstall.
 */
export function stickerUrl(id: string): string {
  const custom = CUSTOM_RE.exec(id);
  if (custom) return `/stickers/${custom[1]}/image`;
  return `${STICKER_BASE}/${id}.svg`;
}

/** Message text that represents a sticker. */
export function stickerToken(id: string): string {
  return `[sticker:${id}]`;
}

/**
 * Matches a sticker token.
 *
 * Only ids we actually ship are matched, so text that happens to look like a token
 * (someone pasting an API example, say) is left alone instead of turning into a
 * broken image.
 */
const TOKEN_RE = /\[sticker:([a-z0-9_-]+)\]/g;

/** True when the string contains at least one sticker token we can render. */
export function hasSticker(text: string): boolean {
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    if (isKnownSticker(match[1])) return true;
  }
  return false;
}

/**
 * Split message text into plain runs and sticker ids, ready to render.
 *
 * Unknown token ids stay in the plain text (they may be a typo the author wants to
 * see, not a silent nothing).
 */
export type TextPart = { kind: "text"; text: string } | { kind: "sticker"; id: string };

export function parseStickerText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(text)) !== null) {
    const [token, id] = match;
    if (!isKnownSticker(id)) continue;

    const before = text.slice(lastIndex, match.index);
    if (before) parts.push({ kind: "text", text: before });
    parts.push({ kind: "sticker", id });
    lastIndex = match.index + token.length;
  }

  const rest = text.slice(lastIndex);
  if (rest) parts.push({ kind: "text", text: rest });
  return parts;
}

/** An emoji group shown as one tab in the picker. */
export interface EmojiGroup {
  name: string;
  emoji: string[];
}

/**
 * A small, opinionated set.
 *
 * Not an exhaustive Unicode browser: a chat composer needs the handful people
 * actually reach for, and a four-thousand-entry picker is worse than a short one.
 */
export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    name: "常用",
    emoji: ["😀", "😄", "😁", "😂", "🤣", "😊", "😍", "😘", "😎", "🤔", "😅", "😇"],
  },
  {
    name: "情绪",
    emoji: ["😢", "😭", "😡", "😤", "🥺", "😴", "🤯", "😱", "😬", "🙃", "😐", "🤗"],
  },
  {
    name: "手势",
    emoji: ["👍", "👎", "👏", "🙏", "🤝", "✌️", "👌", "🤙", "💪", "👀", "🙌", "🫡"],
  },
  {
    name: "物件",
    emoji: ["🔥", "✨", "🎉", "🎂", "☕", "🍜", "🐟", "🌙", "⭐", "💡", "📌", "✅"],
  },
];
