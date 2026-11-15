import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { formatBytes } from "../lib/format";
import type { StorageConversation, StorageReport } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";

interface StorageSectionProps {
  notify: (message: string, kind?: "error" | "info") => void;
  /** Called after something was deleted so the shell can refresh the sidebar. */
  onChanged?: () => void;
}

/** The four things that grow, plus "other", in the order they matter. */
const CATEGORIES: { key: keyof StorageReport["parts"]; label: string; color: string }[] = [
  { key: "databases", label: "数据库", color: "var(--accent)" },
  { key: "uploads", label: "附件", color: "var(--warn)" },
  { key: "avatars", label: "头像", color: "var(--ok, #45d483)" },
  { key: "stickers", label: "贴纸", color: "#b18cff" },
  { key: "other", label: "其他", color: "var(--line)" },
];

/**
 * "存储空间": where the disk went, and how to get some of it back.
 *
 * Two deliberate choices:
 *
 * * The bar and the table answer different questions. The bar says "what is
 *   eating the disk" (attachments usually), the table says "which conversation
 *   is the culprit", which is the only actionable level -- deleting half of all
 *   history is not a choice anyone wants to make.
 * * Deleting history asks first, and the dialog spells out that attachments go
 *   with it. The conversation, its members and its roles stay, so this is not
 *   disguised as "delete the group".
 */
export function StorageSection({ notify, onChanged }: StorageSectionProps) {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [pendingPurge, setPendingPurge] = useState<StorageConversation | null>(null);
  const [confirmOrphans, setConfirmOrphans] = useState(false);

  const load = useCallback(async () => {
    try {
      setReport(await api.storage());
    } catch (err) {
      notify(err instanceof Error ? err.message : "读取存储信息失败", "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const purge = async (conversation: StorageConversation) => {
    setBusy(`purge:${conversation.channel}`);
    try {
      const freed = await api.purgeConversation(conversation.channel);
      notify(
        `已清除「${conversation.name}」的聊天记录，释放 ${formatBytes(freed.freed_bytes)}`,
        "info",
      );
      await load();
      onChanged?.();
    } catch (err) {
      notify(err instanceof Error ? err.message : "清除失败", "error");
    } finally {
      setBusy("");
    }
  };

  const cleanOrphans = async () => {
    setBusy("orphans");
    try {
      const freed = await api.cleanupOrphans();
      notify(`已清理 ${freed.files} 个无引用附件，释放 ${formatBytes(freed.freed_bytes)}`, "info");
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : "清理失败", "error");
    } finally {
      setBusy("");
    }
  };

  if (loading) {
    return (
      <section className="panel-block">
        <h3>存储空间</h3>
        <p className="section-empty">正在统计…</p>
      </section>
    );
  }

  if (!report) {
    return (
      <section className="panel-block">
        <h3>存储空间</h3>
        <p className="section-empty">读取失败，稍后重试。</p>
      </section>
    );
  }

  const total = Math.max(1, report.total_bytes);

  return (
    <section className="panel-block">
      <h3>存储空间</h3>

      <div className="storage-total">
        <strong>{formatBytes(report.total_bytes)}</strong>
        <span className="storage-path" title={report.data_dir}>
          {report.data_dir}
        </span>
      </div>

      {/* One bar, proportional segments: the quickest read of "what is big". */}
      <div className="storage-bar" role="img" aria-label="存储占用构成">
        {CATEGORIES.map((category) => {
          const bytes = report.parts[category.key];
          if (bytes <= 0) return null;
          return (
            <span
              key={category.key}
              className="storage-bar-part"
              style={{ width: `${(bytes / total) * 100}%`, background: category.color }}
              title={`${category.label} ${formatBytes(bytes)}`}
            />
          );
        })}
      </div>

      <ul className="storage-legend">
        {CATEGORIES.map((category) => {
          const bytes = report.parts[category.key];
          const percent = (bytes / total) * 100;
          return (
            <li key={category.key}>
              <span className="storage-dot" style={{ background: category.color }} />
              <span className="storage-legend-label">{category.label}</span>
              <span className="storage-legend-value">{formatBytes(bytes)}</span>
              <span className="storage-legend-pct">{percent < 1 && bytes > 0 ? "<1" : Math.round(percent)}%</span>
            </li>
          );
        })}
      </ul>

      <h4 className="storage-subhead">按会话</h4>
      {report.conversations.length === 0 ? (
        <p className="section-empty">还没有群组或私有频道。</p>
      ) : (
        <ul className="storage-list">
          {report.conversations.map((conversation) => (
            <li key={conversation.channel}>
              <div className="storage-row-text">
                <strong>{conversation.name}</strong>
                <span className="storage-row-meta">
                  {conversation.kind === "group" ? "群组" : "私有频道"} ·{" "}
                  {conversation.messages} 条消息
                  {conversation.attachments > 0
                    ? ` · ${conversation.attachments} 个附件 ${formatBytes(conversation.attachment_bytes)}`
                    : ""}
                </span>
              </div>
              {conversation.can_purge ? (
                <button
                  type="button"
                  className="mini-btn danger"
                  disabled={busy !== ""}
                  onClick={() => setPendingPurge(conversation)}
                  title="只删除聊天记录，群组和成员保留"
                >
                  清除记录
                </button>
              ) : (
                <span className="storage-row-note">仅群主/管理员可清除</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="storage-actions">
        <button
          type="button"
          className="ghost-btn"
          disabled={busy !== "" || report.orphans.files === 0}
          onClick={() => setConfirmOrphans(true)}
          title="删除没有任何消息引用的附件文件"
        >
          清理无引用附件
          {report.orphans.files > 0 ? `（${report.orphans.files} 个 · ${formatBytes(report.orphans.bytes)}）` : ""}
        </button>
        <button type="button" className="ghost-btn" disabled={busy !== ""} onClick={() => void load()}>
          刷新
        </button>
      </div>

      <p className="settings-note">
        清除记录只删这个会话的消息与它的附件；群组和成员保留，可以照常继续聊天。
        数据库、头像与贴纸不会被删除。
      </p>

      {pendingPurge && (
        <ConfirmDialog
          title="清除聊天记录"
          message={`清除「${pendingPurge.name}」的全部聊天记录？${pendingPurge.attachments > 0 ? `其中 ${pendingPurge.attachments} 个附件（${formatBytes(pendingPurge.attachment_bytes)}）也会被删除。` : ""}群组、成员和频道设置都会保留，但记录无法恢复。`}
          confirmLabel="清除"
          danger
          busy={busy === `purge:${pendingPurge.channel}`}
          onCancel={() => setPendingPurge(null)}
          onConfirm={() => {
            const conversation = pendingPurge;
            setPendingPurge(null);
            void purge(conversation);
          }}
        />
      )}

      {confirmOrphans && (
        <ConfirmDialog
          title="清理无引用附件"
          message={`删除 ${report.orphans.files} 个已经没有任何消息引用的附件文件（${formatBytes(report.orphans.bytes)}）？正在被消息使用的附件不受影响。`}
          confirmLabel="清理"
          danger
          busy={busy === "orphans"}
          onCancel={() => setConfirmOrphans(false)}
          onConfirm={() => {
            setConfirmOrphans(false);
            void cleanOrphans();
          }}
        />
      )}
    </section>
  );
}
