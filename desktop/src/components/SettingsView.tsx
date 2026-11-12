import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { formatDay } from "../lib/format";
import type { Theme } from "../lib/theme";
import type { ApiToken, DesktopConnection, MyProfile } from "../lib/types";
import { Avatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";

interface SettingsViewProps {
  me: string;
  profile: MyProfile | null;
  hasAvatar: boolean;
  desktop: DesktopConnection | null;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onReloadProfile: () => void;
  onLogout: () => void;
  notify: (message: string, kind?: "error" | "info") => void;
}

/** Profile and desktop preferences. */
export function SettingsView({
  me,
  profile,
  hasAvatar,
  desktop,
  theme,
  onThemeChange,
  onReloadProfile,
  onLogout,
  notify,
}: SettingsViewProps) {
  const [displayName, setDisplayName] = useState("");
  const [color, setColor] = useState("#63d2ff");
  const [serverInput, setServerInput] = useState(desktop?.serverUrl ?? "");
  const [busy, setBusy] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Seed the form from the loaded profile once it arrives.
  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.display_name ?? "");
    setColor(profile.name_color ?? "#63d2ff");
  }, [profile]);

  useEffect(() => {
    setServerInput(desktop?.serverUrl ?? "");
  }, [desktop?.serverUrl]);

  const saveDisplayName = async () => {
    setBusy("name");
    try {
      await api.setDisplayName(displayName.trim());
      onReloadProfile();
      notify("显示名已保存", "info");
    } catch (err) {
      notify(err instanceof Error ? err.message : "保存失败", "error");
    } finally {
      setBusy("");
    }
  };

  const saveColor = async () => {
    setBusy("color");
    try {
      // The server validates the #rrggbb shape and treats null as "reset".
      await api.saveSettings({ name_color: color });
      onReloadProfile();
      notify("名字颜色已保存", "info");
    } catch (err) {
      notify(err instanceof Error ? err.message : "保存失败", "error");
    } finally {
      setBusy("");
    }
  };

  const resetColor = async () => {
    setBusy("color");
    try {
      await api.saveSettings({ name_color: null });
      onReloadProfile();
      notify("已恢复默认颜色", "info");
    } catch (err) {
      notify(err instanceof Error ? err.message : "操作失败", "error");
    } finally {
      setBusy("");
    }
  };

  const onPickAvatar = async (file: File | undefined) => {
    if (!file) return;
    setBusy("avatar");
    try {
      const blob = await api.prepareAvatar(file);
      await api.uploadAvatar(blob);
      onReloadProfile();
      notify("头像已更新", "info");
    } catch (err) {
      notify(err instanceof Error ? err.message : "头像上传失败", "error");
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeAvatar = async () => {
    setBusy("avatar");
    try {
      await api.deleteAvatar();
      onReloadProfile();
      notify("头像已删除", "info");
    } catch (err) {
      notify(err instanceof Error ? err.message : "操作失败", "error");
    } finally {
      setBusy("");
    }
  };

  const applyServer = async () => {
    if (!window.fatfish) return;
    setBusy("server");
    try {
      const result = await window.fatfish.setServer(serverInput.trim());
      if (!result.ok) {
        notify(result.error ?? "地址无效", "error");
        return;
      }
      notify("已保存，正在重启…", "info");
      await window.fatfish.relaunch();
    } catch (err) {
      notify(err instanceof Error ? err.message : "保存失败", "error");
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>设置</h2>
        <span className="panel-hint">@{me}</span>
      </header>

      <div className="panel-body">
        <section className="panel-block">
          <h3>外观</h3>
          <p className="settings-note">
            夜间模式是深色底浅色字，长时间看更省眼；日间模式是白底黑字，强光下更清楚。
            选择会记住，下次打开直接生效。
          </p>
          <div className="theme-toggle">
            <button
              type="button"
              className={theme === "dark" ? "active" : ""}
              aria-pressed={theme === "dark"}
              onClick={() => onThemeChange("dark")}
            >
              <span className="theme-swatch dark" aria-hidden="true" />
              夜间模式
            </button>
            <button
              type="button"
              className={theme === "light" ? "active" : ""}
              aria-pressed={theme === "light"}
              onClick={() => onThemeChange("light")}
            >
              <span className="theme-swatch light" aria-hidden="true" />
              日间模式
            </button>
          </div>
        </section>

        <section className="panel-block">
          <h3>头像</h3>
          <div className="settings-row">
            <Avatar username={me} hasAvatar={hasAvatar} size={64} />
            <div className="settings-row-actions">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(event) => void onPickAvatar(event.target.files?.[0])}
              />
              <button
                type="button"
                className="ghost-btn"
                disabled={busy === "avatar"}
                onClick={() => fileRef.current?.click()}
              >
                上传新头像
              </button>
              <button
                type="button"
                className="ghost-btn danger"
                disabled={busy === "avatar" || !hasAvatar}
                onClick={() => void removeAvatar()}
              >
                删除头像
              </button>
              <p className="settings-note">会自动裁成正方形并压缩为 128×128 JPEG。</p>
            </div>
          </div>
        </section>

        <section className="panel-block">
          <h3>显示名</h3>
          <p className="settings-note">
            别人看到的名字。留空则显示用户名 <code>@{me}</code>。
          </p>
          <div className="settings-inline">
            <input
              value={displayName}
              maxLength={32}
              placeholder="最多 32 个字符"
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <button
              type="button"
              className="primary-btn"
              disabled={busy === "name"}
              onClick={() => void saveDisplayName()}
            >
              保存
            </button>
          </div>
        </section>

        <section className="panel-block">
          <h3>名字颜色</h3>
          <div className="settings-inline">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#63d2ff"}
              onChange={(event) => setColor(event.target.value)}
            />
            <button
              type="button"
              className="primary-btn"
              disabled={busy === "color"}
              onClick={() => void saveColor()}
            >
              保存
            </button>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy === "color"}
              onClick={() => void resetColor()}
            >
              恢复默认
            </button>
          </div>
        </section>

        {desktop ? (
          <section className="panel-block">
            <h3>服务端地址</h3>
            <p className="settings-note">
              默认使用本机自带的服务端。要在局域网里连另一台机器，填那台机器的地址，
              例如 <code>https://192.168.1.20:5000</code>；留空表示回到本机模式。
            </p>
            <div className="settings-inline">
              <input
                value={serverInput}
                placeholder={
                  desktop.mode === "local" ? "本机模式" : desktop.serverUrl
                }
                onChange={(event) => setServerInput(event.target.value)}
              />
              <button
                type="button"
                className="primary-btn"
                disabled={busy === "server"}
                onClick={() => void applyServer()}
              >
                保存并重启
              </button>
            </div>
            <p className="settings-note">
              当前模式：{desktop.mode === "remote" ? `远程 ${desktop.serverUrl}` : "本机"}
              ；数据目录 <code>{desktop.dataDir}</code>
            </p>
            <div className="settings-inline">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => void window.fatfish?.openDataDir()}
              >
                打开数据目录
              </button>
            </div>
          </section>
        ) : (
          <section className="panel-block">
            <h3>运行模式</h3>
            <p className="settings-note">
              当前是浏览器访问模式；服务端地址由浏览器地址栏决定。
            </p>
          </section>
        )}

        <ApiAccessSection notify={notify} />

        <section className="panel-block">
          <h3>关于</h3>
          <p className="settings-note">
            FatFish · 桌面版
            {desktop ? ` ${desktop.appVersion} · Electron ${desktop.electron}` : ""}
            ；消息、图片与账号全部保存在本机 SQLite 与本地目录中，不上传任何云端。
          </p>
          <div className="settings-inline">
            <button type="button" className="ghost-btn danger" onClick={onLogout}>
              退出登录
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}

interface ApiAccessSectionProps {
  notify: (message: string, kind?: "error" | "info") => void;
}

/**
 * "API 接入服务": issue bearers for other programs to push messages in.
 *
 * The token is shown exactly once, in a highlighted box the user is told to copy
 * now, because the server keeps only a digest and genuinely cannot show it again.
 * Everything else on this screen is bookkeeping: which tokens exist, when each was
 * last used, and revoking one.
 */
function ApiAccessSection({ notify }: ApiAccessSectionProps) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [endpoint, setEndpoint] = useState("");
  const [limit, setLimit] = useState(20);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  // Revoking used window.confirm; the desktop shell is Electron, where a native
  // modal looks out of place, so it is an in-app dialog now.
  const [pendingRevoke, setPendingRevoke] = useState<ApiToken | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.listApiTokens();
      setTokens(data.items);
      setEndpoint(data.endpoint);
      setLimit(data.max_tokens);
    } catch (err) {
      notify(err instanceof Error ? err.message : "读取 API 令牌失败", "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy("create");
    try {
      const created = await api.createApiToken(label.trim() || "未命名令牌");
      setFresh(created.token);
      setLabel("");
      await load();
      notify("令牌已生成，请立即复制", "info");
    } catch (err) {
      notify(err instanceof Error ? err.message : "生成失败", "error");
    } finally {
      setBusy("");
    }
  };

  const revoke = async (token: ApiToken) => {
    setBusy(`revoke:${token.id}`);
    try {
      await api.revokeApiToken(token.id);
      await load();
      notify("令牌已撤销", "info");
    } catch (err) {
      notify(err instanceof Error ? err.message : "撤销失败", "error");
    } finally {
      setBusy("");
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${what}已复制`, "info");
    } catch {
      notify("复制失败，请手动选中", "error");
    }
  };

  return (
    <section className="panel-block">
      <h3>API 接入服务</h3>
      <p className="settings-note">
        生成令牌后，其它程序或脚本就能把消息推送进这里——消息会像本人发送的一样出现在
        频道里，实时推送、@提及、已读全部照常生效。令牌只显示一次，服务端只存摘要。
      </p>

      <div className="settings-inline">
        <code className="api-endpoint">{endpoint || "…"}</code>
        <button
          type="button"
          className="ghost-btn"
          disabled={!endpoint}
          onClick={() => void copy(endpoint, "推送地址")}
        >
          复制地址
        </button>
      </div>

      <div className="settings-inline" style={{ marginTop: 10 }}>
        <input
          value={label}
          maxLength={40}
          placeholder="令牌备注，例如：监控告警机器人"
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
        />
        <button
          type="button"
          className="primary-btn"
          disabled={busy === "create" || tokens.length >= limit}
          onClick={() => void create()}
        >
          生成新令牌
        </button>
      </div>
      <p className="settings-note">
        已用 {tokens.length}/{limit}。每个令牌都属于当前账号，只能发到该账号有权访问的频道。
      </p>

      {fresh && (
        <div className="api-secret">
          <p>
            这是令牌原文，<strong>关闭或刷新后无法再次查看</strong>：
          </p>
          <code>{fresh}</code>
          <div className="settings-inline">
            <button type="button" className="primary-btn" onClick={() => void copy(fresh, "令牌")}>
              复制令牌
            </button>
            <button type="button" className="ghost-btn" onClick={() => setFresh(null)}>
              我已保存，隐藏
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="section-empty">正在读取令牌…</p>
      ) : tokens.length === 0 ? (
        <p className="section-empty">还没有令牌。</p>
      ) : (
        <ul className="person-list">
          {tokens.map((token) => (
            <li key={token.id}>
              <div className="person-text">
                <strong>{token.label}</strong>
                <span>
                  <code>{token.hint}…</code> · 创建于 {formatDay(token.created_ts)} ·{" "}
                  {token.last_used_ts
                    ? `最后使用 ${formatDay(token.last_used_ts)}`
                    : "从未使用"}
                </span>
              </div>
              <button
                type="button"
                className="ghost-btn danger"
                disabled={busy === `revoke:${token.id}`}
                onClick={() => setPendingRevoke(token)}
              >
                撤销
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="settings-inline" style={{ marginTop: 10 }}>
        <button type="button" className="ghost-btn" onClick={() => setShowHelp((v) => !v)}>
          {showHelp ? "收起用法" : "查看调用示例"}
        </button>
      </div>

      {showHelp && (
        <pre className="api-help">{`curl -X POST "${endpoint || "http://127.0.0.1:5000/api/v1/messages"}" \\
  -H "Authorization: Bearer <你的令牌>" \\
  -H "Content-Type: application/json" \\
  -d "{\\"channel\\": \\"general\\", \\"text\\": \\"构建完成\\"}"`}</pre>
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title="撤销令牌"
          message={`撤销令牌「${pendingRevoke.label}」？使用它的程序会立即失效，无法恢复。`}
          confirmLabel="撤销"
          danger
          busy={busy === `revoke:${pendingRevoke.id}`}
          onCancel={() => setPendingRevoke(null)}
          onConfirm={() => {
            const token = pendingRevoke;
            setPendingRevoke(null);
            void revoke(token);
          }}
        />
      )}
    </section>
  );
}
