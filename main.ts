// github-core-clone-01 entry: a GitHub-compatible git forge in a single Node process.
//
// Lifecycle (the harness contract, settled by the kit's wire.ts):
//   1. Bind an ephemeral port (listen(0)); never bind 8080, the suite owns it.
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register; the suite then dials that port.
//   3. Poll GET $MAKEFUN_ENV_URL/done until {"done": true}, then exit 0.
// Without MAKEFUN_ENV_URL there is nothing to register with, so exit 1 at once.
// With MAKEFUN_SHOP_TOKEN unset the forge answers 401 to every protected route,
// so the trial cannot pass — but the process still runs and answers /healthz.
//
// The forge itself lives in app.ts (createApp); this file only runs the lifecycle
// and owns the process's exit code.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: no suite to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Back-off between attempts: 250ms, 500ms, 1s, then 2s forever. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the suite accepts it (200, or 409 when a first register won). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      // Anything else is a transient failure (suite not up yet): retry.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The suite is not answering yet, or the poll timed out: not done, poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const app = createApp();
  // If the harness stops the entry with a signal, close the server and exit 0
  // instead of dying mid-request: the trial is over by then, and a clean exit
  // keeps the run's teardown unambiguous.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void app.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, () => resolve());
  });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[forge] registered; waiting for the suite to say done\n');

  await waitForDone();
  await app.close();
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
