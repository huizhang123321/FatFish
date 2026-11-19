/**
 * Server-Sent Events subscription.
 *
 * The backend pushes every piece of live state through one long-lived
 * ``GET /events`` connection, so this hook is the only thing in the interface
 * that gets data without asking for it.
 *
 * Two details matter:
 *
 * * The ``after`` cursor is read once when the stream opens. Putting it in the
 *   dependency list would tear the connection down on every delivered message
 *   and rebuild it, which both loses the stream's ``Last-Event-ID`` resume
 *   behaviour and floods the server with reconnects. The server advances its own
 *   cursor as it emits.
 * * Every named event carries JSON, so one listener per event name is enough;
 *   ``EventSource`` reconnects on its own if the server recycles the stream
 *   (which it does roughly every five minutes).
 */

import { useEffect, useRef } from "react";

/** Map of event name to payload handler. */
export type EventHandlers = Record<string, (payload: unknown) => void>;

/**
 * Subscribe to the backend's event stream for *channel*.
 *
 * @param channel Channel to scope channel-specific events to (messages, typing).
 * @param after Cursor captured when the connection opens.
 * @param handlers Named SSE event handlers; read through a ref so changing them
 *   never reconnects the stream.
 * @param onStatus Called with the connection state so the UI can show a badge.
 */
export function useEventStream(
  channel: string | null,
  after: number,
  handlers: EventHandlers,
  onStatus?: (connected: boolean) => void,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const afterRef = useRef(after);
  afterRef.current = after;

  useEffect(() => {
    if (!channel) return;

    const url = `/events?channel=${encodeURIComponent(channel)}&after=${afterRef.current}`;
    const source = new EventSource(url);

    source.onopen = () => statusRef.current?.(true);
    source.onerror = () => statusRef.current?.(false);

    const names = Object.keys(handlersRef.current);
    const bound: Array<[string, (event: MessageEvent) => void]> = [];

    for (const name of names) {
      const listener = (event: MessageEvent) => {
        let payload: unknown;
        try {
          payload = JSON.parse(event.data as string);
        } catch {
          return;
        }
        const handler = handlersRef.current[name];
        if (handler) handler(payload);
      };
      source.addEventListener(name, listener as EventListener);
      bound.push([name, listener]);
    }

    return () => {
      for (const [name, listener] of bound) {
        source.removeEventListener(name, listener as EventListener);
      }
      source.close();
      statusRef.current?.(false);
    };
  }, [channel]);
}
