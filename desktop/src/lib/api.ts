/**
 * Backend client.
 *
 * Two things about this API are unusual and drive the whole module:
 *
 * 1. Authentication is a **form POST that redirects**, not a JSON endpoint.
 *    ``fetch`` follows the redirect, so success and failure are distinguished by
 *    where the request ended up (``/`` versus ``/login``) rather than by a
 *    status code. ``redirect: "manual"`` is not usable here: the browser turns
 *    that into an opaque response whose status cannot be read.
 *
 * 2. An expired session makes a protected endpoint **302 to ``/login``**, which
 *    ``fetch`` also follows. So every response is checked for "did I land on the
 *    login page?" and funnelled into :class:`Unauthorized`.
 */

import type {
  ApiTokenCreated,
  ApiTokenList,
  CsrfResponse,
  CustomSticker,
  CustomStickerList,
  DmSummary,
  Friend,
  FriendRequestRow,
  GroupLookup,
  GroupRoster,
  GroupSearchPage,
  GroupSettings,
  GroupRole,
  HealthResponse,
  JoinRequests,
  MessageRow,
  MyProfile,
  PrivateChannel,
  SearchResponse,
  UserSettings,
} from "./types";

/** Thrown when the backend answered with an error status. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Thrown when the session is missing or has expired. */
export class Unauthorized extends Error {
  constructor(message = "登录状态已失效") {
    super(message);
    this.name = "Unauthorized";
  }
}

let onUnauthorized: (() => void) | null = null;

/** Register the callback invoked when a request discovers the session is gone. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

let csrfToken = "";

/** Path of the login page, used to recognise a redirect-to-login. */
const LOGIN_PATH = "/login";

/**
 * Did this response end up on the login page?
 *
 * ``response.url`` is the final URL after redirects. A protected endpoint that
 * lost its session redirects to ``/login``, so landing there means "not
 * authenticated" whatever the status code says.
 */
function endedOnLoginPage(res: Response): boolean {
  try {
    return new URL(res.url).pathname === LOGIN_PATH;
  } catch {
    return false;
  }
}

/** Pipe an authenticated request through the redirect check. */
async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
  });
  if (endedOnLoginPage(res)) {
    onUnauthorized?.();
    throw new Unauthorized();
  }
  return res;
}

/** Request JSON and throw :class:`ApiError` on a non-2xx answer. */
async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init);
  if (!res.ok) {
    throw new ApiError(res.status, await describe(res));
  }
  return (await res.json()) as T;
}

/** POST/PUT a JSON body. */
function jsonBody(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Flatten a Flask error body into something worth showing a person. */
async function describe(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return `请求失败（HTTP ${res.status}）`;
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    if (parsed && typeof parsed.error === "string") return parsed.error;
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON */
  }
  // Flask's plain-text returns ("forbidden", "ok", ...) are shown as-is, but a
  // whole HTML page is not, so cap what reaches the UI.
  return text.length > 200 ? `请求失败（HTTP ${res.status}）` : text;
}

/** Pull the visible error text out of a rendered login/signup page. */
function errorFromHtml(html: string): string {
  const match = /class="auth-(?:error|notice)"[^>]*>([\s\S]*?)<\//i.exec(html);
  if (!match) return "";
  return match[1].replace(/<[^>]+>/g, "").trim();
}

/** Percent-encode one URL path segment, keeping channel punctuation readable. */
function seg(value: string): string {
  return encodeURIComponent(value);
}

// ── Session ────────────────────────────────────────────────────────────────

/** Read the session's CSRF token and whether it already holds a login. */
export async function fetchCsrf(): Promise<CsrfResponse> {
  const data = await json<CsrfResponse>("/csrf-token");
  csrfToken = data.csrf_token;
  return data;
}

/** Log in with the backend's HTML form protocol. */
export async function login(username: string, password: string): Promise<void> {
  if (!csrfToken) await fetchCsrf();
  const body = new URLSearchParams({
    csrf_token: csrfToken,
    username,
    password,
  });
  const res = await fetch(LOGIN_PATH, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
  });
  const landed = new URL(res.url).pathname;
  if (landed === LOGIN_PATH) {
    const html = await res.text();
    throw new ApiError(401, errorFromHtml(html) || "用户名或密码不正确");
  }
}

/** Register an account; the backend logs the new user in on success. */
export async function signup(
  username: string,
  password: string,
  confirmPassword: string,
): Promise<void> {
  if (!csrfToken) await fetchCsrf();
  const body = new URLSearchParams({
    csrf_token: csrfToken,
    username,
    password,
    confirm_password: confirmPassword,
  });
  const res = await fetch("/signup", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
  });
  const landed = new URL(res.url).pathname;
  if (landed === "/signup" || landed === LOGIN_PATH) {
    const html = await res.text();
    throw new ApiError(400, errorFromHtml(html) || "注册失败，请检查填写内容");
  }
}

/** End the session. The backend answers with a redirect, so status is ignored. */
export async function logout(): Promise<void> {
  await fetch("/logout", { credentials: "same-origin", redirect: "follow" });
  csrfToken = "";
}

/** Read the running server's health record. */
export async function health(): Promise<HealthResponse> {
  return json<HealthResponse>("/app/health");
}

// ── Channels and messages ──────────────────────────────────────────────────

/** Public channel names, straight from ``settings.json``. */
export async function publicChannels(): Promise<string[]> {
  return json<string[]>("/channels");
}

/** Private channels and groups the user belongs to. */
export async function privateChannels(): Promise<PrivateChannel[]> {
  return json<PrivateChannel[]>("/private_channels");
}

/** DM conversations, most recent activity first. */
export async function dms(): Promise<DmSummary[]> {
  return json<DmSummary[]>("/dms");
}

/** Messages in a channel newer than *after* (0 returns the whole transcript). */
export async function messages(channel: string, after = 0): Promise<MessageRow[]> {
  return json<MessageRow[]>(`/messages/${seg(channel)}?after=${after}`);
}

/** Send text and/or image attachments. */
export async function sendMessage(
  channel: string,
  text: string,
  files: File[] = [],
  replyToId?: number | null,
): Promise<void> {
  const form = new FormData();
  if (text.trim()) form.set("text", text);
  if (replyToId) form.set("reply_to_id", String(replyToId));
  for (const file of files) form.append("files", file);
  const res = await send(`/send/${seg(channel)}`, { method: "POST", body: form });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Advance the read watermark for a channel. */
export async function markRead(channel: string): Promise<void> {
  const res = await send(`/mark_read/${seg(channel)}`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Hide a DM from the sidebar until it sees new activity. */
export async function closeDm(channel: string): Promise<void> {
  await json("/dms/close", jsonBody("POST", { channel }));
}

/** Who is currently online (server-side presence). */
export async function onlineUsers(): Promise<string[]> {
  return json<string[]>("/online_users");
}

/** Tell the server this user is still present. */
export async function reportPresence(
  state: "active" | "idle" | "hidden" | "offline",
): Promise<void> {
  await fetch("/presence", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
}

/**
 * Announce that this user is typing in *channel*.
 *
 * Fire-and-forget: a dropped keystroke indicator is not worth surfacing an
 * error for, and the server expires the row after five seconds anyway.
 */
export async function startTyping(channel: string): Promise<void> {
  try {
    await fetch(`/typing/${seg(channel)}`, {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    /* the indicator is best-effort */
  }
}

// ── Profiles, avatars, settings ────────────────────────────────────────────

/** The signed-in user's own profile fields. */
export async function myProfile(): Promise<MyProfile> {
  return json<MyProfile>("/profile");
}

/** Set (or clear) the display name shown instead of the username. */
export async function setDisplayName(displayName: string): Promise<void> {
  await json("/profile", jsonBody("POST", { display_name: displayName }));
}

/** Another user's public profile fields. */
export async function userProfile(username: string): Promise<{
  username: string;
  name_color: string | null;
  bio: string | null;
}> {
  return json(`/profile/${seg(username)}`);
}

/** Usernames that have uploaded a custom avatar. */
export async function usersWithAvatars(): Promise<string[]> {
  return json<string[]>("/user_avatars");
}

/** URL for a user's avatar image (the endpoint 404s when there is none). */
export function avatarUrl(username: string): string {
  return `/avatar/${seg(username)}`;
}

/**
 * Downscale an image to a square JPEG in the browser.
 *
 * Avatars are stored as 128x128 JPEGs (the server caps uploads at 5 MB), so
 * resizing here keeps the payload tiny and avoids shipping a full camera photo
 * over the loopback socket.
 */
export async function prepareAvatar(file: File, size = 128): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持图片处理");
  // Centre-crop to a square before scaling so faces are not squashed.
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.9),
  );
  if (!blob) throw new Error("图片处理失败");
  return blob;
}

/** Upload a prepared avatar blob. */
export async function uploadAvatar(blob: Blob): Promise<void> {
  const form = new FormData();
  form.set("avatar", blob, "avatar.jpg");
  const res = await send("/avatar", { method: "POST", body: form });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Remove the custom avatar. */
export async function deleteAvatar(): Promise<void> {
  const res = await send("/avatar", { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Current user's colour/bio settings. */
export async function getSettings(): Promise<UserSettings> {
  return json<UserSettings>("/settings");
}

/** Save colour (``null`` resets to the hash-derived default) and bio. */
export async function saveSettings(patch: {
  name_color?: string | null;
  bio?: string | null;
}): Promise<void> {
  const res = await send("/settings", jsonBody("POST", patch));
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/**
 * Remember the colour theme on the account.
 *
 * Separate from [saveSettings]: that route writes the colour and bio too, so
 * sending only a theme through it would blank them.
 */
export async function saveTheme(theme: "light" | "dark"): Promise<void> {
  const res = await send("/theme", jsonBody("POST", { theme }));
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

// ── Social: search, friends ────────────────────────────────────────────────

/** Search users by username or display name. */
export async function searchUsers(
  query: string,
  page = 1,
  pageSize = 20,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    page_size: String(pageSize),
  });
  return json<SearchResponse>(`/users/search?${params.toString()}`);
}

/** The friend list. */
export async function friends(): Promise<Friend[]> {
  return json<Friend[]>("/friends");
}

/** Friend requests, defaulting to the inbox of pending requests. */
export async function friendRequests(
  direction: "in" | "out" | "all" = "in",
  status: "pending" | "accepted" | "rejected" | "all" = "pending",
): Promise<FriendRequestRow[]> {
  const params = new URLSearchParams({ direction, status });
  const data = await json<{ items: FriendRequestRow[] }>(
    `/friends/requests?${params.toString()}`,
  );
  return data.items;
}

/** Ask another user to be friends. */
export async function sendFriendRequest(username: string): Promise<void> {
  const res = await send(
    "/friends/requests",
    jsonBody("POST", { username }),
  );
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Accept an incoming request. */
export async function acceptFriendRequest(id: number): Promise<void> {
  const res = await send(`/friends/requests/${id}/accept`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Reject an incoming request. */
export async function rejectFriendRequest(id: number): Promise<void> {
  const res = await send(`/friends/requests/${id}/reject`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Withdraw a request this user sent. */
export async function withdrawFriendRequest(id: number): Promise<void> {
  const res = await send(`/friends/requests/${id}`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Remove a friend (the chat history is kept). */
export async function removeFriend(username: string): Promise<void> {
  const res = await send(`/friends/${seg(username)}`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

// ── Groups ─────────────────────────────────────────────────────────────────

/** Create a legacy private channel (``kind: "channel"``) or a group. */
export async function createPrivateChannel(
  name: string,
  members: string[],
  kind: "channel" | "group" = "channel",
  inviteAdminOnly = false,
): Promise<{
  id: number;
  channel: string;
  name: string;
  kind: string;
  group_no: string | null;
  invite_admin_only: boolean;
}> {
  return json(
    "/private_channels/create",
    jsonBody("POST", {
      name,
      members,
      kind,
      invite_admin_only: inviteAdminOnly,
    }),
  );
}

/** Settings of one group: the number, the policy and what the caller may do. */
export async function groupSettings(id: number): Promise<GroupSettings> {
  return json<GroupSettings>(`/groups/${id}/settings`);
}

/**
 * Update a group's name and/or invite policy.
 *
 * Renaming needs admin, changing the policy needs the owner -- the server
 * enforces both, so `can_manage` / `can_change_policy` from [groupSettings] decide
 * what the UI offers.
 */
export async function saveGroupSettings(
  id: number,
  patch: { name?: string; invite_admin_only?: boolean; discoverable?: boolean },
): Promise<void> {
  const res = await send(`/groups/${id}/settings`, jsonBody("POST", patch));
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Search discoverable groups by name. */
export async function searchGroups(q: string, offset = 0): Promise<GroupSearchPage> {
  return json<GroupSearchPage>(
    `/groups/search?q=${encodeURIComponent(q)}&offset=${offset}`,
  );
}

/**
 * Find a group by its number.
 *
 * Returns the name and member count only -- the number is a handle people share,
 * not a key to the group.
 */
export async function lookupGroup(groupNo: string): Promise<GroupLookup> {
  return json<GroupLookup>(`/groups/lookup?group_no=${encodeURIComponent(groupNo)}`);
}

/** Ask to join a group found by number. */
export async function requestJoinGroup(id: number, note = ""): Promise<void> {
  const res = await send(`/groups/${id}/join_request`, jsonBody("POST", { note }));
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Pending requests to decide, plus the caller's own recent requests. */
export async function joinRequests(): Promise<JoinRequests> {
  return json<JoinRequests>("/groups/join_requests");
}

/** Approve or reject someone's request to join a group you manage. */
export async function decideJoinRequest(
  groupId: number,
  requestId: number,
  action: "approve" | "reject",
): Promise<void> {
  const res = await send(
    `/groups/${groupId}/join_requests/${requestId}`,
    jsonBody("POST", { action }),
  );
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Withdraw your own pending request. */
export async function cancelJoinRequest(groupId: number, requestId: number): Promise<void> {
  const res = await send(`/groups/${groupId}/join_requests/${requestId}`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

/** Group roster with roles. */
export async function groupRoster(id: number): Promise<GroupRoster> {
  return json<GroupRoster>(`/groups/${id}/members`);
}

/** Invite a user to a private channel or group. */
export async function addMember(id: number, username: string): Promise<void> {
  await json(`/private_channels/${id}/add_member`, jsonBody("POST", { username }));
}

/** Remove a member from a group (owner/admin only). */
export async function removeMember(id: number, username: string): Promise<void> {
  await json(`/groups/${id}/remove_member`, jsonBody("POST", { username }));
}

/** Promote to admin or demote to member (owner only). */
export async function setRole(
  id: number,
  username: string,
  role: Exclude<GroupRole, "owner">,
): Promise<void> {
  await json(`/groups/${id}/role`, jsonBody("POST", { username, role }));
}

/** Transfer ownership (owner only). */
export async function transferOwnership(id: number, username: string): Promise<void> {
  await json(`/groups/${id}/transfer`, jsonBody("POST", { username }));
}

/** Disband a group; *confirm* must equal its name exactly. */
export async function disbandGroup(id: number, confirm: string): Promise<void> {
  await json(`/groups/${id}`, jsonBody("DELETE", { confirm }));
}

/** Rename a private channel or group. */
export async function renameChannel(id: number, name: string): Promise<void> {
  await json(`/private_channels/${id}/rename`, jsonBody("POST", { name }));
}

/** Leave a private channel or group. */
export async function leaveChannel(id: number): Promise<void> {
  await json(`/private_channels/${id}/leave`, { method: "POST" });
}

/** URL of an uploaded attachment. */
export function fileUrl(filename: string): string {
  return `/files/${encodeURIComponent(filename)}`;
}

// ── Machine access ("API 接入服务") ────────────────────────────────────────

/** List the signed-in user's API tokens (never the secrets). */
export async function listApiTokens(): Promise<ApiTokenList> {
  return json<ApiTokenList>("/api/tokens");
}

/**
 * Mint a token.
 *
 * The plaintext is in this response and nowhere else -- the server keeps only a
 * digest -- so the caller must show it to the user immediately and say so.
 */
export async function createApiToken(label: string): Promise<ApiTokenCreated> {
  return json<ApiTokenCreated>("/api/tokens", jsonBody("POST", { label }));
}

/** Revoke a token. It stops working immediately; the row is kept for auditing. */
export async function revokeApiToken(id: number): Promise<void> {
  const res = await send(`/api/tokens/${id}`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}

// ── Imported stickers ("表情包") ───────────────────────────────────────────

/** List the shared sticker library. */
export async function listCustomStickers(): Promise<CustomStickerList> {
  return json<CustomStickerList>("/stickers");
}

/**
 * Import an image into the shared sticker library.
 *
 * The server validates the image by its signature, so a renamed file is rejected
 * there — a clear error is better than a sticker that never renders.
 */
export async function importCustomSticker(
  file: File,
  name: string,
): Promise<CustomSticker> {
  const form = new FormData();
  form.set("file", file, file.name);
  if (name.trim()) form.set("name", name.trim());
  const res = await send("/stickers", { method: "POST", body: form });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
  const body = (await res.json()) as { item: CustomSticker };
  return body.item;
}

/** Remove a sticker you imported. */
export async function deleteCustomSticker(id: number): Promise<void> {
  const res = await send(`/stickers/${id}`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await describe(res));
}
