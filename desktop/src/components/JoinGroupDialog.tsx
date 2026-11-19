import { useState } from "react";
import * as api from "../lib/api";
import type { GroupLookup } from "../lib/types";
import { Modal } from "./Modal";

interface JoinGroupDialogProps {
  onClose: () => void;
  /** Called after a request is sent, so the shell can refresh its request list. */
  onRequested: () => void;
  notify: (message: string, kind?: "error" | "info") => void;
}

const isGroupNumber = (value: string): boolean => /^\d{8}$/.test(value);

/**
 * Find a group by number or by name, then ask to join it.
 *
 * One box for both, because the difference only matters to the server: eight
 * digits is a number, anything else is a name. The result is always *shown*
 * before a request can be sent -- typing a wrong digit and firing a request at a
 * stranger's group is exactly what the preview prevents.
 *
 * Name results only include groups whose owner opted into being discoverable,
 * so an empty result means "nothing published under that name", not "no such
 * group": the number route still works for a group you were told about privately.
 */
export function JoinGroupDialog({ onClose, onRequested, notify }: JoinGroupDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GroupLookup[]>([]);
  const [selected, setSelected] = useState<GroupLookup | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [searched, setSearched] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setResults([]);
    setSelected(null);
    setNextOffset(null);
    setSearched(false);
    setError("");
  };

  const run = async (more = false) => {
    const value = query.trim();
    if (!value) {
      setError("请输入群号或群名");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (isGroupNumber(value)) {
        const found = await api.lookupGroup(value);
        setResults([found]);
        setSelected(found);
        setNextOffset(null);
      } else {
        if (value.length < 2) {
          setError("搜索群名至少输入 2 个字");
          return;
        }
        const page = await api.searchGroups(value, more ? (nextOffset ?? 0) : 0);
        setResults((current) => (more ? [...current, ...page.items] : page.items));
        setNextOffset(page.next_offset);
        // A single hit needs no picking; pre-select it.
        setSelected(!more && page.items.length === 1 ? page.items[0] : null);
      }
      setSearched(true);
    } catch (err) {
      reset();
      setError(err instanceof Error ? err.message : "查询失败");
    } finally {
      setBusy(false);
    }
  };

  const request = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await api.requestJoinGroup(selected.id, note.trim());
      onRequested();
      notify("已发送入群申请，等待群主或管理员审批", "info");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "申请失败");
    } finally {
      setBusy(false);
    }
  };

  const blocked = !selected || selected.already_member || selected.pending;

  return (
    <Modal
      title="加入群组"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost-btn" onClick={onClose} disabled={busy}>
            关闭
          </button>
          <button
            type="button"
            className="primary-btn"
            disabled={blocked || busy}
            onClick={() => void request()}
          >
            {busy ? "处理中…" : "发送申请"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>群号或群名</span>
        <div className="dock-inline">
          <input
            value={query}
            maxLength={40}
            autoFocus
            placeholder="8 位群号，或群名里的几个字"
            onChange={(event) => {
              setQuery(event.target.value);
              reset();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void run();
            }}
          />
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => void run()}>
            {busy ? "…" : "查询"}
          </button>
        </div>
      </label>

      {results.length > 0 && (
        <ul className="group-result-list">
          {results.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`group-result${selected?.id === item.id ? " active" : ""}`}
                onClick={() => setSelected(item)}
              >
                <span className="group-result-name">{item.name}</span>
                <span className="group-result-meta">
                  {item.member_count} 人
                  {item.already_member ? " · 已在群" : item.pending ? " · 待审批" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {nextOffset !== null && (
        <button
          type="button"
          className="ghost-btn"
          disabled={busy}
          onClick={() => void run(true)}
        >
          加载更多
        </button>
      )}

      {searched && results.length === 0 && !error && (
        <p className="section-empty">
          没有找到公开的群。如果对方给过你群号，直接输入 8 位群号即可；只有群主开启了「允许通过群名搜索」，群名才能被搜到。
        </p>
      )}

      {selected && (
        <div className="join-result">
          <div className="join-result-head">
            <strong>{selected.name}</strong>
            <span className="join-result-meta">{selected.member_count} 人</span>
          </div>
          {selected.already_member ? (
            <p className="settings-note">你已经在这个群里了。</p>
          ) : selected.pending ? (
            <p className="settings-note">申请已发送，等待审批。</p>
          ) : (
            <>
              <label className="field">
                <span>备注（可选）</span>
                <input
                  value={note}
                  maxLength={120}
                  placeholder="例如：我是小林，一起联机的"
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              <p className="settings-note">
                群主或管理员审批通过后你才会进群；进群后看不到加入之前的消息。
              </p>
            </>
          )}
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}
