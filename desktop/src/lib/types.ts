/**
 * Wire types.
 *
 * These mirror the JSON the Flask backend actually returns; field names are kept
 * exactly as the server spells them so a payload can be stored without
 * translation.  Optional fields are the ones a particular endpoint omits rather
 * than nulls it.
 */

/** A row from ``GET /messages/<channel>`` or the ``messages`` SSE event. */
export interface MessageRow {
  id: number;
  channel: string;
  sender: string;
  content: string;
  /** ``"system"`` marks a notice (rename, join, welcome) instead of a person. */
  content_type: string | null;
  filename: string | null;
  ts: number;
  edited: number | null;
  edited_ts: number | null;
  deleted: number;
  deleted_ts: number | null;
  reply_to_id: number | null;
  /** JSON string of ``{emoji: [usernames]}``, or null. */
  reactions: string | null;
  reactions_ts?: number;
  /** JSON array string of mentioned usernames, or null. */
  mentions?: string | null;
}

/** One entry of ``GET /private_channels``. */
export interface PrivateChannel {
  id: number;
  channel: string;
  name: string;
  unread: number;
  members: string[];
  kind: "channel" | "group";
  role: GroupRole;
}

/** One entry of ``GET /dms``. */
export interface DmSummary {
  channel: string;
  users: string[];
  unread: number;
}

/** One entry of ``GET /users/search``. */
export interface SearchItem {
  username: string;
  display_name: string | null;
  avatar: boolean;
  name_color: string | null;
  relation: "friend" | "pending_out" | "pending_in" | "none";
  request_id: number | null;
}

/** One entry of ``GET /friends``. */
export interface Friend {
  username: string;
  display_name: string | null;
  avatar: boolean;
  name_color: string | null;
  since_ts: number;
}

/** One entry of ``GET /friends/requests``. */
export interface FriendRequestRow {
  id: number;
  from_user: string;
  to_user: string;
  from_display_name: string | null;
  to_display_name: string | null;
  status: "pending" | "accepted" | "rejected";
  created_ts: number;
  resolved_ts: number | null;
}

export type GroupRole = "owner" | "admin" | "member";

/** One entry of ``GET /groups/<id>/members``. */
export interface GroupMember {
  username: string;
  display_name: string | null;
  avatar: boolean;
  role: GroupRole;
  joined_ts: number;
}

/** ``GET /groups/<id>/members``. */
export interface GroupRoster {
  id: number;
  channel: string;
  name: string;
  kind: string;
  members: GroupMember[];
}

/** ``GET /profile`` (social blueprint). */
export interface MyProfile {
  username: string;
  display_name: string | null;
  bio: string | null;
  name_color: string | null;
}

/** ``GET /users/search`` envelope. */
export interface SearchResponse {
  items: SearchItem[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

/** ``GET /csrf-token``. */
export interface CsrfResponse {
  csrf_token: string;
  user: string | null;
}

/** ``GET /settings`` (chat blueprint). */
export interface UserSettings {
  name_color: string | null;
  bio: string | null;
  /** ``"light"`` / ``"dark"``, or null when the user has never chosen. */
  theme: "light" | "dark" | null;
}

/** ``GET /app/health``. */
export interface HealthResponse {
  status: string;
  version: string;
  ui_bundled: boolean;
  desktop_mode: boolean;
}

/** A channel the user can open, normalised from the three list endpoints. */
export interface ChannelRef {
  id: string;
  kind: "public" | "group" | "channel" | "dm";
  title: string;
  subtitle: string;
  unread: number;
  /** Present for private channels and groups. */
  privateId?: number;
  /** Present for DMs: the other participants. */
  dmUsers?: string[];
  role?: GroupRole;
  /** 8-digit number a group can be shared by; absent for channels and DMs. */
  groupNo?: string;
  /** True when this group restricts inviting to owner/admin. */
  inviteAdminOnly?: boolean;
}

/** ``GET /groups/<id>/settings``. */
export interface GroupSettings {  id: number;
  name: string;
  kind: "channel" | "group";
  /** 8-digit shareable number, empty for legacy private channels. */
  group_no: string;
  /** This group's own invite policy. */
  invite_admin_only: boolean;
  /** Whether the group may be found by searching its name. */
  discoverable: boolean;
  /** An operator tightened every group in settings.json. */
  invite_gated_globally: boolean;
  member_count: number;
  owner: string;
  my_role: GroupRole;
  /** May rename (admin or owner). */
  can_manage: boolean;
  /** May change the invite policy (owner only). */
  can_change_policy: boolean;
}

/** ``GET /groups/lookup?group_no=…`` -- deliberately minimal. */
export interface GroupLookup {
  id: number;
  name: string;
  member_count: number;
  already_member: boolean;
  pending: boolean;
}

/** ``GET /groups/search?q=…`` -- one page of discoverable groups. */
export interface GroupSearchPage {
  items: GroupLookup[];
  next_offset: number | null;
  query: string;
}

/** One unread request in a manager's queue. */
export interface JoinRequestIncoming {
  id: number;
  channel_id: number;
  group_name: string;
  username: string;
  note: string;
  created_ts: number;
}

/** One of the caller's own requests, with its outcome. */
export interface JoinRequestOutgoing {
  id: number;
  channel_id: number;
  group_name: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  created_ts: number;
  decided_ts: number | null;
}

/** ``GET /groups/join_requests``. */
export interface JoinRequests {
  incoming: JoinRequestIncoming[];
  outgoing: JoinRequestOutgoing[];
}

/** What the Electron shell reports about this instance. */
export interface DesktopConnection {
  mode: "local" | "remote";
  serverUrl: string;
  baseUrl: string;
  dataDir: string;
  appVersion: string;
  electron: string;
}

/** One issued API token. The secret itself is never part of this shape. */
export interface ApiToken {
  id: number;
  label: string;
  /** First few characters, for telling two tokens apart. */
  hint: string;
  created_ts: number;
  last_used_ts: number | null;
  revoked: boolean;
}

/** ``GET /api/tokens``. */
export interface ApiTokenList {
  items: ApiToken[];
  /** Push URL other programs should POST to. */
  endpoint: string;
  max_tokens: number;
}

/** ``POST /api/tokens`` -- the only response that ever carries the secret. */
export interface ApiTokenCreated {
  token: string;
  item: ApiToken;
}

/** One imported sticker ("表情包"). */
export interface CustomSticker {
  id: number;
  /** Message token that renders this sticker, e.g. ``[sticker:custom-12]``. */
  token: string;
  name: string;
  url: string;
  uploader: string;
  created_ts: number;
  /** True when the signed-in user imported it (only then may they delete it). */
  mine: boolean;
}

/** ``GET /stickers``. */
export interface CustomStickerList {
  items: CustomSticker[];
  max: number;
  max_bytes: number;
}
