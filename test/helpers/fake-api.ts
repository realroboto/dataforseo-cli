// Preload for bin tests (seam 2): `node --import <this> bin/dfs.ts …` answers DataForSEO calls
// with an empty 20000 envelope, so the bin runs with no network.
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      status_code: 20000,
      cost: 0,
      tasks_count: 1,
      tasks: [{ id: 't', status_code: 20000, cost: 0, result: [{ items: [{ title: 'x' }] }] }],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
