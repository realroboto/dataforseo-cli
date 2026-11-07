// A fake fetch that records every call and answers with real Response objects.
export function fakeFetch(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetch, calls };
}
