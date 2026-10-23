import type { JobEvent } from '../job/events';
import type { JobState } from '../job/state';

/**
 * What goes over the wire. Only durable events carry a `seq`, because that is
 * the number a reconnecting client sends back as `Last-Event-ID` and it has to
 * mean a row in `job_events`. Progress ticks are lossy by design.
 */
export interface EventEnvelope {
  readonly seq: number | null;
  readonly event: JobEvent;
  readonly state: JobState;
}

/**
 * JSON payloads never contain a raw newline, so in practice this emits one
 * line. It stays because a `data` value with an embedded newline would
 * otherwise end the frame early and silently truncate the message.
 */
export const encodeDataLines = (value: string): string =>
  value
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join('\n');

/**
 * A frame ends with a blank line; a `data` value containing newlines has to be
 * split across several `data:` lines or the parser stops early.
 */
export const encodeFrame = (envelope: EventEnvelope): string => {
  const lines: string[] = [];
  if (envelope.seq !== null) lines.push(`id: ${envelope.seq}`);
  lines.push(`event: ${envelope.event.type}`);
  lines.push(
    encodeDataLines(JSON.stringify({ event: envelope.event, state: envelope.state, seq: envelope.seq })),
  );
  return `${lines.join('\n')}\n\n`;
};

/**
 * The opening frame. It is deliberately not a `JobEvent`: a client that feeds
 * incoming frames through the reducer must be able to tell "here is the
 * current state" apart from "here is something that happened", or it will try
 * to apply a transition that never occurred.
 */
export const encodeSnapshot = (state: JobState, seq: number | null): string =>
  ['event: snapshot', encodeDataLines(JSON.stringify({ state, seq })), ''].join('\n') + '\n';

/** Comments keep proxies from closing an idle stream, and are ignored by clients. */
export const encodeComment = (text: string): string => `: ${text}\n\n`;

/** Tells the browser how long to wait before reconnecting after a drop. */
export const encodeRetry = (milliseconds: number): string => `retry: ${milliseconds}\n\n`;

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  // `no-transform` matters: a compressing proxy will happily buffer the stream.
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

export const HEARTBEAT_INTERVAL_MS = 15_000;

/** `Last-Event-ID` arrives as a header on reconnect and as a query param otherwise. */
export const parseLastEventId = (raw: string | null): number => {
  if (raw === null) return 0;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
};
