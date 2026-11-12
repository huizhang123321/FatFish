import { useEffect, useRef, useState } from "react";
import { audioExtensionFor, formatClipLength, pickAudioMimeType } from "../lib/format";

interface VoiceRecorderProps {
  /** Receives the finished recording as a File, ready to attach to a message. */
  onRecorded: (file: File) => void;
  /** Reports a problem the user needs to see. */
  onError: (message: string) => void;
  disabled?: boolean;
}

type Phase = "idle" | "recording";

/** Give up automatically rather than filling the disk with one long note. */
const MAX_SECONDS = 120;

/**
 * Voice notes: press to record, press again to stop.
 *
 * The browser does the encoding (``MediaRecorder``) and the result is handed back
 * as a normal ``File``, so a voice note is just an attachment: it goes through the
 * existing upload route, the existing size limit and the existing permission
 * checks, and it survives in history like any other file. Nothing about messages
 * had to change to support it.
 *
 * Microphone access needs a secure context. ``http://127.0.0.1`` counts as one, so
 * this works in both the desktop window and the browser-mode UI without a
 * certificate warning.
 */
export function VoiceRecorder({ onRecorded, onError, disabled }: VoiceRecorderProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  /** Stop the microphone promptly: leaving it live is both rude and a privacy bug. */
  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => () => releaseStream(), []);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      onError("这个浏览器不支持录音");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      onError("这个浏览器不支持录音");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = pickAudioMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || "audio/webm";
        releaseStream();
        setPhase("idle");
        setSeconds(0);

        if (cancelledRef.current) {
          chunksRef.current = [];
          return;
        }
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (blob.size === 0) {
          onError("没有录到声音");
          return;
        }
        const extension = audioExtensionFor(type);
        const stamp = new Date()
          .toISOString()
          .replace(/[-:T.]/g, "")
          .slice(0, 14);
        onRecorded(new File([blob], `voice-${stamp}.${extension}`, { type }));
      };

      recorder.start();
      setPhase("recording");
      setSeconds(0);

      const startedAt = Date.now();
      timerRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000;
        setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS) stop(false);
      }, 200);
    } catch (err) {
      releaseStream();
      setPhase("idle");
      const name = err instanceof Error ? err.name : "";
      if (name === "NotAllowedError") {
        onError("麦克风权限被拒绝，请在浏览器/系统设置里允许");
      } else if (name === "NotFoundError") {
        onError("没有找到麦克风");
      } else {
        onError(err instanceof Error ? err.message : "无法开始录音");
      }
    }
  };

  const stop = (cancel: boolean) => {
    cancelledRef.current = cancel;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      releaseStream();
      setPhase("idle");
      setSeconds(0);
    }
  };

  if (phase === "recording") {
    return (
      <div className="voice-recording" role="status">
        <span className="voice-dot" aria-hidden="true" />
        <span className="voice-timer">{formatClipLength(seconds)}</span>
        <button type="button" className="ghost-btn" onClick={() => stop(true)}>
          取消
        </button>
        <button type="button" className="primary-btn" onClick={() => stop(false)}>
          停止
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="icon-btn"
      title="录制语音"
      aria-label="录制语音"
      disabled={disabled}
      onClick={() => void start()}
    >
      <MicIcon />
    </button>
  );
}

/** A microphone glyph, drawn inline so no icon font or asset is needed. */
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M6 11a6 6 0 0 0 12 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M12 17v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
