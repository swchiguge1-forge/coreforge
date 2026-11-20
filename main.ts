// main.ts — CoreForge entrypoint.
//
// The harness that grades this forge does not talk to a fixed port. It
// starts this file, and my only jobs are:
//   1. bring the forge up on whatever port the kernel hands me,
//   2. tell the environment where I landed (POST /register),
//   3. sit quietly until the environment says the trial is over
//      (GET /done), then shut down cleanly.
// Everything else — git smart HTTP, the REST API, GraphQL, MCP — lives
// behind createApp() in app.ts and is none of this file's business.

import { createApp } from './app.ts';

const TAG = '[coreforge-main]';
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;

function note(message: string): void {
  console.log(`${TAG} ${message}`);
}

function warn(message: string): void {
  console.error(`${TAG} ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff as a tiny stateful helper: each call hands back
// the delay to wait before the next attempt and doubles the following
// one, never growing past the cap. Registration and done-polling each
// keep their own instance so one loop's retries cannot inflate the
// other's delays.
function backoff(): () => number {
  let upcoming = FIRST_RETRY_MS;
  return () => {
    const delay = upcoming;
    upcoming = Math.min(upcoming * 2, MAX_RETRY_MS);
    return delay;
  };
}

// Where the environment lives. A trailing slash would turn
// `${env}/register` into a double-slashed path, so strip any.
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  return raw.replace(/\/+$/, '');
}

// Bind the server to port 0 and report the port the kernel picked.
// A listen failure (or a server that somehow has no address) rejects,
// and run() turns that into a fatal exit.
function bind(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address !== null && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('server is listening but reports no address'));
      }
    });
  });
}

// POST our port to the environment until it acknowledges us:
//   200 — registered, carry on.
//   409 — a sibling process registered first; that still means the
//         environment knows where a forge is, so carry on.
//   400 / 405 — the environment rejects the shape of the request
//         itself; retrying the same bytes is pointless, so abort.
//   anything else, or no answer at all — the environment may still be
//         coming up; wait and try again, forever if need be.
async function announce(origin: string, port: number): Promise<void> {
  const wait = backoff();
  for (;;) {
    let status: number | null = null;
    try {
      const reply = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = reply.status;
      // Drain the body so the connection can close cleanly.
      await reply.text().catch(() => undefined);
    } catch {
      status = null; // unreachable, reset, or timed out — all retryable
    }

    if (status === 200) {
      note(`registered with the environment (port ${port})`);
      return;
    }
    if (status === 409) {
      note('environment already had a registration; carrying on');
      return;
    }
    if (status === 400 || status === 405) {
      throw new Error(`register refused with HTTP ${status}; the request contract is wrong, not retrying`);
    }

    const delay = wait();
    note(`register attempt unanswered (status: ${status ?? 'network error'}); retrying in ${delay} ms`);
    await sleep(delay);
  }
}

// Poll /done until the environment flips it to true. A failed request,
// a non-OK status, or a body that does not literally say done: true
// all mean the same thing — not finished yet — so the loop simply
// keeps its backoff rhythm and asks again. It never gives up: leaving
// early would abandon a trial that is still running.
async function awaitFinish(origin: string): Promise<void> {
  const wait = backoff();
  let checks = 0;
  for (;;) {
    let finished = false;
    try {
      const reply = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        finished = body.done === true;
      } else {
        await reply.text().catch(() => undefined);
      }
    } catch {
      finished = false;
    }
    if (finished) {
      note(`done signal received after ${checks + 1} check(s)`);
      return;
    }
    checks += 1;
    const delay = wait();
    if (checks === 1 || checks % 20 === 0) {
      note(`trial still running (check ${checks}); next check in ${delay} ms`);
    }
    await sleep(delay);
  }
}

async function run(): Promise<void> {
  const origin = envOrigin();
  if (origin === '') {
    warn('MAKEFUN_ENV_URL is not set; there is no environment to register with, exiting');
    process.exit(1);
  }

  const server = createApp();
  const port = await bind(server);
  note(`forge listening on ephemeral port ${port}`);

  await announce(origin, port);
  await awaitFinish(origin);

  note('closing the server');
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  note('shutdown complete');
  process.exit(0);
}

run().catch((error: unknown) => {
  warn(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
