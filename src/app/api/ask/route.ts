import { runAsk, type RunEvent } from '@/lib/pipeline';
import { askRequestSchema, firstIssue } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serverless functions are killed at their timeout, so the run has to fit inside
 * one. 60s is the ceiling on Vercel's Hobby plan; the scheduler's token gate is
 * what keeps a 100-claim run inside it rather than parked waiting on a window.
 */
export const maxDuration = 60;

/**
 * Run a question set and stream progress as newline-delimited JSON.
 *
 * Streaming is not decoration here. A run with a per-minute token ceiling
 * genuinely spends time waiting at the budget gate, and a progress bar that
 * cannot show *why* it is waiting is indistinguishable from a hang. Each line is
 * one `RunEvent`, so the client can render per-claim state as it changes.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'That request body was not valid JSON. If you uploaded a large file, it may have exceeded the size limit.' },
      { status: 400 },
    );
  }

  const parsed = askRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const controller = new AbortController();

  // If the browser navigates away, stop paying for model calls nobody will read.
  request.signal.addEventListener('abort', () => controller.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (event: RunEvent): void => {
        try {
          streamController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The client hung up mid-run; the abort above stops the work.
        }
      };

      try {
        await runAsk(parsed.data, send, { signal: controller.signal });
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
      } finally {
        try {
          streamController.close();
        } catch {
          // Already closed by a client disconnect.
        }
      }
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
