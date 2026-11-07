// Transport: one HTTP exchange with basic auth, retries and pace (docs/spec/modules/transport.md).
import { setTimeout as wait } from 'node:timers/promises';
import { DfsError, messageOf } from './errors.ts';
import { isRecord } from './json.ts';

const VARS = ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'] as const;

// Read per request from the env; never logged, never stored.
export function authHeader(env: NodeJS.ProcessEnv): string {
  for (const name of VARS) {
    if (!env[name]) {
      throw new DfsError(2, `${name} is not set — export DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD`);
    }
  }
  const pair = `${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

export type Exchange = { status: number; text: string };
type Sleep = (ms: number) => Promise<unknown>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const RETRIES = 4;
const TRANSIENT = new Set([40202, 40209, 50000, 50301, 50303]);
const PAID_TRANSIENT = new Set([...TRANSIENT, 50401]);
// 1, 2, 4, 8 s plus 0–1 s jitter.
const backoff = (attempt: number) => 1000 * 2 ** attempt + Math.random() * 1000;

// The codes a retry looks at: the envelope's, or every task's under a 20000 envelope.
function retryable(status: number, text: string, free: boolean): boolean {
  if (free && status === 500) return true;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(body)) return false;
  // A paid call retries only when the response proves it cost nothing.
  if (!free && body.cost !== 0) return false;
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  const codes =
    body.status_code === 20000
      ? tasks.map((t) => (isRecord(t) ? t.status_code : undefined))
      : [body.status_code];
  const set = free ? TRANSIENT : PAID_TRANSIENT;
  return codes.length > 0 && codes.every((c) => typeof c === 'number' && set.has(c));
}

const MINUTE = 60_000;
const IN_FLIGHT = 10;
const LIVE_TIMEOUT = 130_000;
type Pace = { until: number; open: number; queue: (() => void)[] };
// One pace per fetch: a process has one; each test fake gets its own.
const paces = new WeakMap<Fetch, Pace>();

async function slot(pace: Pace): Promise<() => void> {
  while (pace.open >= IN_FLIGHT) await new Promise<void>((r) => pace.queue.push(r));
  pace.open++;
  return () => {
    pace.open--;
    pace.queue.shift()?.();
  };
}

export async function send(
  { fetch, sleep = wait, now = Date.now }: { fetch: Fetch; sleep?: Sleep; now?: () => number },
  req: { method: string; url: string; body?: string; auth: string; free: boolean; live: boolean },
): Promise<Exchange> {
  const headers: Record<string, string> = { authorization: req.auth };
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  const pace = paces.get(fetch) ?? { until: 0, open: 0, queue: [] };
  paces.set(fetch, pace);
  for (let attempt = 0; ; attempt++) {
    const last = attempt === RETRIES;
    let res: Exchange | undefined;
    let lost: unknown;
    const release = await slot(pace);
    // After the slot: a response that came in while this request was queued may set `until`.
    const pause = pace.until - now();
    if (pause > 0) await sleep(pause);
    const abort = req.live ? new AbortController() : undefined;
    const timer =
      abort && setTimeout(() => abort.abort(new Error('no answer in 130 s')), LIVE_TIMEOUT);
    try {
      const init = { method: req.method, headers, body: req.body, signal: abort?.signal };
      const r = await fetch(req.url, init);
      if (r.headers.get('x-ratelimit-remaining') === '0') {
        pace.until = (Math.floor(now() / MINUTE) + 1) * MINUTE;
      }
      res = { status: r.status, text: await r.text() };
    } catch (e) {
      lost = e;
    } finally {
      clearTimeout(timer);
      release();
    }
    if (res === undefined) {
      // A paid request may have reached the API and been charged: never send it twice.
      // shortcut: a refused or unresolved connection (nothing sent) also reads as lost; split by
      // `cause.code` if agents hit it often.
      if (!req.free) {
        throw new DfsError(
          1,
          `connection lost after send: ${messageOf(lost)} — money may be spent; dfs +collect recovers it`,
        );
      }
      if (last) {
        throw new DfsError(
          1,
          `network error: ${messageOf(lost)} — check the network; see: dfs store list`,
        );
      }
    } else if (last || !retryable(res.status, res.text, req.free)) {
      return res;
    }
    await sleep(backoff(attempt));
  }
}
