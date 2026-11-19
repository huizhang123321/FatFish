import { useCallback, useEffect, useRef, useState } from "react";
import type { TsnetStatus } from "../lib/types";

interface RemoteAccessSectionProps {
  notify: (message: string, kind?: "error" | "info") => void;
}

/**
 * "远程访问（Tailscale）": publish this FatFish on a tailnet, through the embedded
 * tsnet node.
 *
 * The shell owns the node process; this component only reads its status and asks
 * it to start or stop. That is why the whole section disappears in a browser tab:
 * there is no shell to host the node, and a "start" button that cannot work is
 * worse than no section at all.
 *
 * The auth key field is optional on purpose. With a key the node comes up
 * unattended; without one Tailscale prints a login URL that the user opens in a
 * browser, which is the normal flow for a personal machine.
 */
export function RemoteAccessSection({ notify }: RemoteAccessSectionProps) {
  const bridge = typeof window !== "undefined" ? window.fatfish?.tsnet : undefined;
  const [status, setStatus] = useState<TsnetStatus | null>(null);
  const [hostname, setHostname] = useState("fatfish");
  const [port, setPort] = useState(80);
  const [authKey, setAuthKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setStatus(await bridge.status());
    } catch {
      // A status read failing means the shell is going away; leave the last view.
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    void refresh();
    pollRef.current = window.setInterval(() => void refresh(), 2500);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [bridge, refresh]);

  if (!bridge) {
    return (
      <section className="panel-block">
        <h3>远程访问（Tailscale）</h3>
        <p className="settings-note">
          只能在桌面应用里使用。浏览器模式没有外壳进程，无法启动内嵌的 Tailscale 节点。
        </p>
      </section>
    );
  }

  const start = async () => {
    setBusy(true);
    try {
      const result = await bridge.start({ hostname, port, authKey });
      if (!result.ok) {
        notify(result.error || "启动失败", "error");
      } else {
        notify("已开始连接 Tailscale", "info");
        setAuthKey("");
      }
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "启动失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await bridge.stop();
      await refresh();
      notify("已停止 Tailscale 节点", "info");
    } finally {
      setBusy(false);
    }
  };

  const state = status?.state ?? "off";
  const running = Boolean(status?.running);
  const label =
    state === "running"
      ? "已连接"
      : state === "login_required"
        ? "等待登录"
        : state === "starting"
          ? "正在启动"
          : state === "error"
            ? "出错"
            : state === "stopped"
              ? "已停止"
              : "未启用";

  return (
    <section className="panel-block">
      <h3>远程访问（Tailscale）</h3>
      <p className="settings-note">
        用官方 <code>tsnet</code> 把本机嵌入你的 tailnet，从手机或其他设备访问这个聊天服务。
        服务本身仍然只监听 <code>127.0.0.1</code>，局域网和公网都连不上——只有 tailnet 内的设备能访问，
        并且受 tailnet 的 ACL 控制。
      </p>

      {!status?.available && (
        <p className="settings-note danger-text">
          找不到 <code>tsnet-sidecar.exe</code>：这个安装包里没有该组件，请使用 1.4.0 或更新的安装包。
        </p>
      )}

      <div className="tsnet-status">
        <span className={`tsnet-dot tsnet-${state}`} />
        <strong>{label}</strong>
        {status?.url ? (
          <code className="tsnet-url">{status.url}</code>
        ) : status?.addresses?.length ? (
          <code className="tsnet-url">{status.addresses.join(", ")}</code>
        ) : null}
        {running && <span className="tsnet-conns">{status?.connections ?? 0} 个连接</span>}
      </div>

      {state === "login_required" && status?.login_url && (
        <div className="tsnet-login">
          <p className="settings-note">
            这个节点还没有被授权。打开下面的链接，用 Tailscale 账号登录并批准它：
          </p>
          <button
            type="button"
            className="primary-btn"
            onClick={() => void window.fatfish?.openExternal(status.login_url)}
          >
            打开登录页面
          </button>
          <code className="tsnet-url">{status.login_url}</code>
        </div>
      )}

      {status?.error && <p className="settings-note danger-text">{status.error}</p>}

      <div className="tsnet-form">
        <label className="field">
          <span>节点名称</span>
          <input
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder="fatfish"
            disabled={running || busy}
          />
        </label>
        <label className="field">
          <span>tailnet 端口</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(event) => setPort(Number(event.target.value) || 80)}
            disabled={running || busy}
          />
        </label>
        <label className="field field-wide">
          <span>授权密钥（可选）</span>
          <input
            type="password"
            value={authKey}
            onChange={(event) => setAuthKey(event.target.value)}
            placeholder="tskey-...，留空则用浏览器登录"
            disabled={running || busy}
          />
        </label>
      </div>

      <div className="settings-inline">
        {running ? (
          <button type="button" className="ghost-btn danger" disabled={busy} onClick={() => void stop()}>
            停止节点
          </button>
        ) : (
          <button
            type="button"
            className="primary-btn"
            disabled={busy || !status?.available}
            onClick={() => void start()}
          >
            {busy ? "启动中…" : "启动节点"}
          </button>
        )}
        <button type="button" className="ghost-btn" onClick={() => void refresh()}>
          刷新状态
        </button>
        {status?.log_tail?.length ? (
          <button type="button" className="ghost-btn" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "收起日志" : "查看日志"}
          </button>
        ) : null}
      </div>

      {showLog && status?.log_tail?.length ? (
        <pre className="tsnet-log">{status.log_tail.join("\n")}</pre>
      ) : null}
    </section>
  );
}
