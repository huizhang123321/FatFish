import { useState } from "react";
import * as api from "../lib/api";
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
} from "../lib/credentials";

interface LoginScreenProps {
  /** Called once the backend holds a session for the new user. */
  onAuthenticated: () => void;
  /** Why the user is looking at this screen, when it is not their own doing. */
  notice?: string;
}

/** The password rules the backend enforces, shown up front on the signup tab. */
const PASSWORD_RULES = [
  "至少 15 个字符",
  "包含大写字母和小写字母",
  "包含数字",
  "包含特殊字符（如 !@#$%^&*）",
];

type Mode = "login" | "signup";

/**
 * Login and registration.
 *
 * The backend authenticates through its HTML form routes, so this screen posts
 * the same fields a browser would (including the CSRF token it fetches first)
 * and reports whatever the rendered page says when the attempt fails.
 */
export function LoginScreen({ onAuthenticated, notice }: LoginScreenProps) {
  const [mode, setMode] = useState<Mode>("login");
  const [saved] = useState(() => loadCredentials());
  const [username, setUsername] = useState(saved?.username ?? "");
  const [password, setPassword] = useState(saved?.password ?? "");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hadSaved, setHadSaved] = useState(saved !== null);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    setPassword("");
    setConfirm("");
  };

  const forget = () => {
    clearCredentials();
    setHadSaved(false);
    setRemember(false);
    setPassword("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    if (mode === "signup" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") {
        await api.login(username.trim(), password);
        // Only ever store credentials the server just accepted.
        if (remember) {
          saveCredentials({ username: username.trim(), password });
          setHadSaved(true);
        } else {
          clearCredentials();
          setHadSaved(false);
        }
      } else {
        await api.signup(username.trim(), password, confirm);
      }
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-art" aria-hidden="true">
        <FishMark />
        <h1>FatFish</h1>
        <p>全部数据留在你自己的电脑上，不联网、不上云。</p>
      </div>

      <div className="login-card">
        <div className="login-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={mode === "login" ? "active" : ""}
            onClick={() => switchMode("login")}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signup"}
            className={mode === "signup" ? "active" : ""}
            onClick={() => switchMode("signup")}
          >
            注册
          </button>
        </div>

        <form onSubmit={submit} className="login-form" autoComplete="on">
          <label>
            <span>用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="1–32 位字母、数字、下划线或短横线"
              autoComplete="username"
              maxLength={32}
              required
              autoFocus
            />
          </label>

          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={mode === "signup" ? "至少 15 位，含大小写、数字和符号" : "请输入密码"}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              maxLength={1024}
              required
            />
          </label>

          {mode === "signup" && (
            <>
              <label>
                <span>确认密码</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  placeholder="再输入一次密码"
                  autoComplete="new-password"
                  maxLength={1024}
                  required
                />
              </label>
              <ul className="password-rules">
                {PASSWORD_RULES.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          {notice && !error && <p className="form-notice">{notice}</p>}

          {mode === "login" && (
            <label className="remember-row">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span>
                记住密码，下次自动登录
                <em>
                  密码以明文保存在本机浏览器存储里，任何能用这台电脑的人都能读到；
                  公用机器请勿勾选。
                </em>
              </span>
            </label>
          )}

          {mode === "login" && hadSaved && (
            <button type="button" className="link-btn" onClick={forget}>
              清除已保存的密码
            </button>
          )}

          <button type="submit" className="primary-btn" disabled={busy}>
            {busy ? "请稍候…" : mode === "login" ? "登录" : "创建账号"}
          </button>
        </form>

        <p className="login-footnote">
          账号仅保存在本机数据库，忘记密码请在服务端机器上运行
          <code>minimost reset-password</code>。
        </p>
      </div>
    </div>
  );
}

/** The application mark: an original fish, drawn inline so it scales cleanly. */
export function FishMark({ size = 72 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="fish-mark">
      <defs>
        <linearGradient id="fishgrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#63d2ff" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <path
        d="M5 32c9.5-12.5 22-18 33.5-18 6.3 0 11.6 2.1 15.7 5.3L62 12l-1.2 10 1.2 10-7.8-7.3C50.1 27.9 44.8 30 38.5 30 27 30 14.5 24.5 5 32z"
        fill="url(#fishgrad)"
      />
      <circle cx="45" cy="27.4" r="2.9" fill="#0b0e14" />
      <path d="M20 40c4 3.5 9 5.5 14 5.5" stroke="rgba(11,14,20,.35)" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  );
}
