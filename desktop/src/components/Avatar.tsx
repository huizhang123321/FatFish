import { useEffect, useState } from "react";
import { avatarUrl } from "../lib/api";
import { colorFor, initialOf } from "../lib/format";

interface AvatarProps {
  username: string;
  label?: string | null;
  /** Known avatar state; the image is only requested when this is true. */
  hasAvatar: boolean;
  size?: number;
  title?: string;
}

/**
 * A user avatar: the uploaded image when there is one, otherwise a coloured
 * initial. Falls back to the initial if the image fails to load (a user who
 * deleted their avatar between renders).
 */
export function Avatar({ username, label, hasAvatar, size = 32, title }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [username, hasAvatar]);

  const name = label || username;
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };

  if (hasAvatar && !broken) {
    return (
      <img
        className="avatar"
        style={style}
        src={avatarUrl(username)}
        alt={name}
        title={title ?? name}
        onError={() => setBroken(true)}
      />
    );
  }

  return (
    <span
      className="avatar avatar-initial"
      style={{ ...style, background: colorFor(username) }}
      title={title ?? name}
      aria-hidden="true"
    >
      {initialOf(name)}
    </span>
  );
}
