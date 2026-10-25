import { isTerminal } from '@/core/job/selectors';
import {
  encodeComment,
  encodeFrame,
  encodeRetry,
  encodeSnapshot,
  HEARTBEAT_INTERVAL_MS,
  parseLastEventId,
  SSE_HEADERS,
} from '@/core/orchestrator/sse';
import { getJobService } from '../../../_lib/service';
import { errorResponse, jobIdFrom, type RouteContext } from '../../../_lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const jobId = await jobIdFrom(context);
  if (!jobId.ok) return errorResponse(jobId.error);

  const service = getJobService();

  // The browser resends `Last-Event-ID` automatically after a dropped
  // connection; the query parameter is for clients opening the stream by hand.
  const url = new URL(request.url);
  const fromSeq = parseLastEventId(
    request.headers.get('last-event-id') ?? url.searchParams.get('lastEventId'),
  );

  const subscribed = service.subscribe(jobId.value, fromSeq);
  if (!subscribed.ok) return errorResponse(subscribed.error);

  const { backlog, live } = subscribed.value;
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The client vanished between the check and the enqueue.
          closed = true;
        }
      };

      send(encodeRetry(3_000));

      const job = service.getJob(jobId.value);
      if (job.ok) {
        // A late subscriber renders immediately rather than waiting for
        // whatever event happens to fire next.
        send(encodeSnapshot(job.value.state, fromSeq === 0 ? null : fromSeq));
      }

      for (const envelope of backlog) send(encodeFrame(envelope));

      heartbeat = setInterval(() => send(encodeComment('ping')), HEARTBEAT_INTERVAL_MS);

      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        live.close();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      request.signal.addEventListener('abort', finish, { once: true });

      try {
        for await (const envelope of live.stream) {
          if (closed) break;
          send(encodeFrame(envelope));
          // A terminal state is the end of the story; holding the socket open
          // afterwards just leaks a connection per finished job.
          if (isTerminal(envelope.state)) break;
        }
      } finally {
        finish();
      }
    },

    cancel() {
      closed = true;
      clearInterval(heartbeat);
      live.close();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
