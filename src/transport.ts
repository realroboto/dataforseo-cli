// Transport: one HTTP exchange with basic auth (docs/spec/modules/transport.md).
// shortcut: no retries, pace or Live timeout yet; ticket 09 adds them.
import { DfsError, messageOf } from './errors.ts';

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

export async function send(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  { method, url, body, auth }: { method: string; url: string; body?: string; auth: string },
): Promise<Exchange> {
  const headers: Record<string, string> = { authorization: auth };
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(url, { method, headers, body });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    throw new DfsError(
      1,
      `network error: ${messageOf(e)} — check the network; see: dfs store list`,
    );
  }
}
