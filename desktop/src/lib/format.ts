/** Small presentation helpers shared by the chat components. */

/** Format an epoch-seconds timestamp as a local wall-clock time. */
export function formatClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format a day separator label: 今天 / 昨天 / 2026年11月12日. */
export function formatDay(ts: number): string {
  const date = new Date(ts * 1000);
  const today = new Date();
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((midnight(today) - midnight(date)) / 86400000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** True when two timestamps fall on the same calendar day. */
export function sameDay(a: number, b: number): boolean {
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/**
 * A stable colour derived from a username.
 *
 * Used when the user has not picked one, so names are still visually distinct
 * without a server round trip.
 */
export function colorFor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) {
    hash = (hash * 31 + username.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% 68%)`;
}

/** Initial shown in the avatar placeholder. */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // CJK names read better as the first glyph; latin names as the first letter.
  return trimmed[0].toUpperCase();
}

/** Parse the ``reactions`` JSON string into ``{emoji: [usernames]}``. */
export function parseReactions(raw: string | null): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Parse the ``mentions`` JSON array string. */
export function parseMentions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Human-readable byte size for the attachment hint. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A DM channel title from its participants. */
export function dmTitle(users: string[]): string {
  return users.join("、") || "私聊";
}

/**
 * Build the canonical DM channel id for a pair of users.
 *
 * The backend's ``normalize_dm`` sorts participants with Python's ``sorted()``,
 * which orders by code unit; JavaScript's default ``sort()`` does the same. Using
 * a locale-aware comparison here (``localeCompare``) would produce a channel name
 * the server cannot resolve for mixed-case pairs -- e.g. "Zoe" sorts before
 * "alice" by code unit but after it in a dictionary.
 */
export function dmChannelFor(me: string, other: string): string {
  return `dm:${[me, other].sort().join(":")}`;
}

/** True when the string looks like an image filename we can render inline. */
export function isImageName(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(filename);
}

/**
 * True when the filename looks like a voice note or other audio attachment.
 *
 * ``webm`` is first because that is what ``MediaRecorder`` produces in Chromium
 * for ``audio/webm``; the rest are here because a user can also drag an existing
 * recording in from disk.
 */
export function isAudioName(filename: string): boolean {
  return /\.(webm|ogg|oga|m4a|mp3|wav|opus|aac)$/i.test(filename);
}

/**
 * Pick a MediaRecorder MIME type the browser actually supports.
 *
 * Chromium always has Opus-in-WebM; Safari would need mp4. Returning the first
 * supported candidate, and ``""`` when none is (letting MediaRecorder choose its
 * default), keeps this working across all three shells without branching.
 */
export function pickAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/** File extension implied by a recorder MIME type. */
export function audioExtensionFor(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

/** ``0:07`` style duration for a voice note. */
export function formatClipLength(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Recover the name a sender used for an uploaded file.
 *
 * The server stores non-image uploads as ``<32 hex>_<percent-encoded name>`` (see
 * ``chat._encode_upload_name``), because ``secure_filename`` would flatten a
 * Chinese name to nothing and drop its extension. Images carry no name at all, so
 * their stored uuid is all there is.
 *
 * Uploads made before the encoding change hold a plain ASCII name, for which the
 * percent-decoding is a no-op; a malformed sequence falls back to the raw suffix
 * rather than throwing and blanking the row.
 */
export function originalFileName(stored: string): string {
  if (stored.length > 33 && stored[32] === "_") {
    const tail = stored.slice(33);
    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  }
  return stored;
}

/** Extension shown as a badge, upper-cased, or ``文件`` when there is none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "文件";
  return name.slice(dot + 1).toUpperCase().slice(0, 6);
}

/**
 * A glyph for the file card, chosen by extension.
 *
 * A handful of categories rather than one icon per type: the point is to make a
 * list of attachments scannable, and a dozen distinct symbols do that better than
 * forty near-identical ones.
 */
export function fileGlyph(name: string): string {
  const ext = fileExtension(name).toLowerCase();
  if (["pdf"].includes(ext)) return "📕";
  if (["doc", "docx", "rtf", "odt"].includes(ext)) return "📘";
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return "📗";
  if (["ppt", "pptx", "odp"].includes(ext)) return "📙";
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(ext)) return "🗜";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(ext)) return "🖼";
  if (["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"].includes(ext)) return "🎵";
  if (["mp4", "mkv", "mov", "avi", "webm", "wmv"].includes(ext)) return "🎬";
  if (["txt", "md", "log"].includes(ext)) return "📄";
  if (["py", "js", "ts", "tsx", "jsx", "json", "html", "css", "java", "c", "cpp", "go", "rs", "sh", "bat", "ps1"].includes(ext)) return "🧾";
  if (["exe", "msi", "apk", "dmg", "deb"].includes(ext)) return "⚙";
  return "📎";
}
