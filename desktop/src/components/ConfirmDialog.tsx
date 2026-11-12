import { useState } from "react";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
  title: string;
  /** What is about to happen, in plain words. */
  message: string;
  confirmLabel?: string;
  /** True for anything that cannot be undone. */
  danger?: boolean;
  /**
   * When set, the user has to type this exact text before the action is enabled.
   *
   * Used for disbanding a group: the cost of a stray click is the whole group, so
   * the confirmation is deliberate rather than a single button press.
   */
  requireText?: string;
  /** Label above the text field, e.g. 「群名」. */
  inputLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * An in-app replacement for ``window.confirm`` / ``window.prompt``.
 *
 * The desktop shell is Electron, which does not implement ``window.prompt`` at
 * all -- it returns ``undefined`` and logs a warning. Code that relied on it
 * silently did nothing, which is exactly how "clicking 解散群组 does nothing"
 * happened: the prompt never appeared, so the typed name was ``undefined``, the
 * name check failed, and the only feedback was a toast that was easy to miss.
 *
 * ``window.confirm`` does work in Electron, but it is a native modal that blocks
 * the renderer and looks nothing like the rest of the app, so the same component
 * covers both.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "确定",
  danger = false,
  requireText,
  inputLabel = "请输入",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");

  const needsText = typeof requireText === "string" && requireText.length > 0;
  const textOk = !needsText || typed === requireText;
  const canConfirm = textOk && !busy;

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="ghost-btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className={danger ? "primary-btn danger" : "primary-btn"}
            disabled={!canConfirm}
            onClick={onConfirm}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </>
      }
    >
      <p className="confirm-message">{message}</p>

      {needsText && (
        <label className="field">
          <span>{inputLabel}</span>
          <input
            value={typed}
            autoFocus
            placeholder={requireText}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canConfirm) onConfirm();
            }}
          />
        </label>
      )}

      {needsText && typed.length > 0 && !textOk && (
        <p className="settings-note">输入的内容和上面不一致，无法继续。</p>
      )}
    </Modal>
  );
}
