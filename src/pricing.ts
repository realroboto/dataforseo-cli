// Pricing (docs/spec/modules/pricing.md): Estimate from the body, the price tree and the price
// rules; Cost guard. shortcut: rules for serp and keywords_data only; tickets 06–07 add the rest.
import { isRecord } from './json.ts';

export const FREE = new Set([
  'task_get',
  'tasks_ready',
  'tasks_fixed',
  'id_list',
  'errors',
  'user_data',
  'locations',
  'languages',
  'webhook_resend',
  // Reference lists: "Your account will not be charged for using this API" (their docs pages).
  'locations_and_languages',
  'categories',
  'status',
  'industries',
  'job_functions',
]);
export const isFree = (specPath: string): boolean => specPath.split('/').some((w) => FREE.has(w));

// Billing unit: results per SERP; each SERP after the first costs `next` of the first.
type Pages = { field: string; size: number; next: number };
// A paid body field. `when` tests String(value), default: set and not false. A number value
// counts n units. `times` multiplies the task price, `add` adds n × the base price, `usd` n × usd.
type Extra = { field: string; when?: RegExp; times?: number; add?: number; usd?: number };
export type Rule = {
  path: string;
  node: string[];
  factor?: number; // list price / node price
  pages?: Pages;
  results?: { field: string; max: number }; // count of a per_result leaf; else 1
  extras?: Extra[];
  unbounded?: true;
};

// --- serp. One node covers every engine and type: serp.task_post, serp.live.<kind> (help-center/
// serp-api-cost-explained: "Base price | $ 0.002 | $ 0.0006 | $ 0.0012").
const serp = (type: string, kinds: string[], bill: Omit<Rule, 'path' | 'node'> = {}): Rule[] => [
  { path: `/v3/serp/${type}/task_post`, node: ['serp', 'task_post'], ...bill },
  ...kinds.map((kind) => ({
    path: `/v3/serp/${type}/live/${kind}`,
    node: ['serp', 'live', kind],
    ...bill,
  })),
];
// Organic se_type: "the price per subsequent pages ... is 25% lower" (help-center/
// above-100-results-with-serp-api). Other types: "+1 base price per each additional" page.
const organic = (size: number): Pages => ({ field: 'depth', size, next: 0.75 });
const full = (size: number, field = 'depth'): Pages => ({ field, size, next: 1 });
// help-center/serp-api-cost-explained: "If you apply one of the operators listed above, the base
// price per task will be multiplied by 5" (Google Organic, Maps, News, Images).
const OPERATORS: Extra = {
  field: 'keyword',
  when: /(^|[\s"'(-])(allinanchor|allintext|allintitle|allinurl|define|filetype|id|inanchor|info|intext|intitle|inurl|link|site):/,
  times: 5,
};
// Pricing pages: "+1 base price" (Organic, News, Bing); task_post docs say a flat $0.0006: take the higher.
const RECT_ADD: Extra = { field: 'calculate_rectangles', add: 1 };
const RECT_DOUBLE: Extra = { field: 'calculate_rectangles', times: 2 }; // "×2 the total price"
const SERP_RULES: Rule[] = [
  // https://dataforseo.com/pricing/google-serp/google-organic-serp-api
  ...serp('google/organic', ['advanced', 'regular', 'html'], {
    pages: organic(10),
    extras: [
      OPERATORS,
      RECT_ADD,
      { field: 'load_async_ai_overview', add: 1 }, // pricing page: "+1 base price"
      // docs: "billed $0.00015 extra for each click regardless of task priority"
      { field: 'people_also_ask_click_depth', usd: 0.00015 },
    ],
  }),
  // https://dataforseo.com/pricing/serp/bing-organic-serp-api; Live depth 100 = $0.0155 (help-center/
  // using-the-stop_crawl_on_match-parameter-in-serp-api) confirms the 25% next-page discount
  ...serp('bing/organic', ['advanced', 'regular', 'html'], {
    pages: organic(10),
    extras: [RECT_ADD],
  }),
  // https://dataforseo.com/pricing/serp/yahoo-serp-api
  // Yahoo: "billed per each SERP", default depth 6 (live html: 10).
  ...serp('yahoo/organic', ['advanced', 'regular'], { pages: organic(6) }),
  { path: '/v3/serp/yahoo/organic/live/html', node: ['serp', 'live', 'html'], pages: organic(10) },
  // https://dataforseo.com/pricing/serp/baidu-organic-serp-api
  // Baidu get_website_url: "the charge per task will be multiplied by 10" (spec field docs).
  ...serp('baidu/organic', [], {
    pages: organic(10),
    extras: [{ field: 'get_website_url', times: 10 }],
  }),
  // https://dataforseo.com/pricing/serp/naver-organic-serp-api
  ...serp('naver/organic', [], { pages: organic(15) }),
  // https://dataforseo.com/pricing/serp/seznam-organic-serp-api
  // Seznam: "pixel rankings double the total".
  ...serp('seznam/organic', [], { pages: organic(10), extras: [RECT_DOUBLE] }),
  // https://dataforseo.com/pricing/google-serp/google-ai-mode-serp-api
  // AI Mode: $0.0012 / $0.0024 / $0.004; calculate_rectangles: "multiplied by 2".
  ...serp('google/ai_mode', ['advanced', 'html'], { factor: 2, extras: [RECT_DOUBLE] }),
  // https://dataforseo.com/pricing/google-serp/google-autocomplete-serp-api
  ...serp('google/autocomplete', ['advanced']),
  // https://dataforseo.com/pricing/google-serp/google-dataset-info-serp-api
  ...serp('google/dataset_info', ['advanced']),
  // https://dataforseo.com/pricing/google-serp/google-dataset-search-serp-api
  ...serp('google/dataset_search', ['advanced'], { pages: full(20) }),
  // https://dataforseo.com/pricing/google-serp/google-finance-serp-api (all four finance types)
  // Finance: news_type local/world markets and a window other than 1D: "multiplied by 2".
  ...serp('google/finance_explore', ['advanced', 'html'], {
    extras: [{ field: 'news_type', when: /^(local_market|world_markets)$/, times: 2 }],
  }),
  ...serp('google/finance_markets', ['advanced', 'html']),
  ...serp('google/finance_quote', ['advanced', 'html'], {
    extras: [{ field: 'window', when: /^(?!1D$)/, times: 2 }],
  }),
  ...serp('google/finance_ticker_search', ['advanced']),
  // https://dataforseo.com/pricing/google-serp/google-images-serp-api
  ...serp('google/images', ['advanced', 'html'], { pages: full(100), extras: [OPERATORS] }),
  // https://dataforseo.com/pricing/google-serp/google-local-finder-serp-api
  ...serp('google/local_finder', ['advanced', 'html'], { pages: full(10) }),
  // https://dataforseo.com/pricing/google-serp/google-maps-serp-api
  ...serp('google/maps', ['advanced'], { pages: full(100), extras: [OPERATORS] }),
  // https://dataforseo.com/pricing/google-serp/google-news-serp-api
  ...serp('google/news', ['advanced', 'html'], { pages: full(10), extras: [OPERATORS, RECT_ADD] }),
  // https://dataforseo.com/pricing/google-serp/google-search-by-image-serp-api
  ...serp('google/search_by_image', [], { extras: [RECT_DOUBLE] }),
  // https://dataforseo.com/pricing/google-serp/google-ads-advertisers-serp-api
  ...serp('google/ads_advertisers', []),
  // https://dataforseo.com/pricing/google-serp/google-ads-search-serp-api
  ...serp('google/ads_search', [], { pages: full(40) }),
  // https://dataforseo.com/pricing/google-serp/google-jobs-serp-api
  // Jobs has a node of its own; no Live mode.
  { path: '/v3/serp/google/jobs/task_post', node: ['serp', 'jobs', 'task_post'], pages: full(10) },
  // https://dataforseo.com/pricing/serp/youtube-serp-api: "Video Info and Subtitles cost three
  // times as much"; no next-page discount stated.
  ...serp('youtube/organic', ['advanced'], { pages: full(20, 'block_depth') }),
  ...serp('youtube/video_comments', ['advanced'], { pages: full(20) }),
  ...serp('youtube/video_info', ['advanced'], { factor: 3 }),
  ...serp('youtube/video_subtitles', ['advanced'], { factor: 3 }),
  // docs.dataforseo.com/v3/serp/ai_summary, /serp/screenshot: "charged ... for each request".
  { path: '/v3/serp/ai_summary', node: ['serp', 'ai_summary'] },
  { path: '/v3/serp/screenshot', node: ['serp', 'screenshot'] },
];

// --- keywords_data. Per task: "Your account
// is billed only for setting a task, no matter how many keywords you receive in response."
// task_post nodes carry no engine word; live nodes do.
const keywords = (engine: string, api: string, post = api): Rule[] => [
  {
    path: `/v3/keywords_data/${engine}/${api}/task_post`,
    node: ['keywords_data', post, 'task_post'],
  },
  {
    path: `/v3/keywords_data/${engine}/${api}/live`,
    node: ['keywords_data', engine, post, 'live'],
  },
];
const live = (api: string): Rule => ({
  path: `/v3/keywords_data/${api}/live`,
  node: ['keywords_data', ...api.split('/'), 'live'],
});
const KEYWORDS_RULES: Rule[] = [
  // https://dataforseo.com/pricing/keywords-data/google-ads
  ...[
    'search_volume',
    'keywords_for_site',
    'keywords_for_keywords',
    'ad_traffic_by_keywords',
  ].flatMap((api) => keywords('google_ads', api)),
  // https://dataforseo.com/pricing/keywords-data/bing-ads (also audience_estimation)
  ...['search_volume', 'keywords_for_site', 'keywords_for_keywords', 'keyword_performance'].flatMap(
    (api) => keywords('bing', api),
  ),
  ...keywords('bing', 'audience_estimation'),
  // No node of its own; bing-ads pricing lists it at the search_volume price ($0.06 / $0.09).
  ...keywords('bing', 'search_volume_history', 'search_volume'),
  // https://dataforseo.com/pricing/keywords-data/google-trends
  // Google Trends nodes carry no engine word at all.
  {
    path: '/v3/keywords_data/google_trends/explore/task_post',
    node: ['keywords_data', 'explore', 'task_post'],
  },
  {
    path: '/v3/keywords_data/google_trends/explore/live',
    node: ['keywords_data', 'explore', 'live'],
  },
  // https://dataforseo.com/pricing/keywords-data/dataforseo-trends-api-pricing
  ...['explore', 'subregion_interests', 'demography', 'merged_data'].map((a) =>
    live(`dataforseo_trends/${a}`),
  ),
  // https://dataforseo.com/pricing/keywords-data/clickstream-api-pricing
  live('clickstream_data/dataforseo_search_volume'),
  live('clickstream_data/global_search_volume'),
  // "billed for setting a task and for each item in the response";
  // one item per keyword, at most 1,000.
  { ...live('clickstream_data/bulk_search_volume'), results: { field: 'keywords', max: 1000 } },
];

export const RULES: Rule[] = [...SERP_RULES, ...KEYWORDS_RULES];
const BY_PATH = new Map(RULES.map((r) => [r.path, r]));
export const ruleFor = (specPath: string): Rule | undefined => BY_PATH.get(specPath);

export type Estimate = {
  usd: number | null;
  basis: 'rule' | 'unknown' | 'unbounded';
  warning?: string; // a rule names a node the price tree lacks
};

const pageFactor = (pages: Pages | undefined, task: Record<string, unknown>): number => {
  if (!pages) return 1;
  const want = Number(task[pages.field] ?? pages.size);
  const n = Math.max(1, Math.ceil((Number.isFinite(want) ? want : pages.size) / pages.size));
  return 1 + (n - 1) * pages.next;
};

// Node price of one task: the sum of its leaves; undefined for an absent or unknown leaf.
function leafPrice(rule: Rule, leaves: unknown, task: Record<string, unknown>): number | undefined {
  if (!Array.isArray(leaves) || leaves.length === 0) return undefined;
  let usd = 0;
  for (const l of leaves) {
    if (!isRecord(l) || typeof l.cost !== 'number') return undefined;
    if (l.cost_type === 'per_request') usd += l.cost;
    else if (l.cost_type !== 'per_result') return undefined;
    else if (!rule.results) usd += l.cost;
    else {
      const v = task[rule.results.field];
      usd += l.cost * (Array.isArray(v) ? Math.min(v.length, rule.results.max) : rule.results.max);
    }
  }
  return usd;
}

// Worst case of one call: the sum over its tasks (a GET is one request). `tree` is the stored
// `price` node, undefined when dfs has none.
export function estimate(rule: Rule | undefined, tasks: unknown[], tree: unknown): Estimate {
  if (rule?.unbounded) return { usd: null, basis: 'unbounded' };
  if (!rule || tree === undefined) return { usd: null, basis: 'unknown' };
  const node = rule.node.reduce<unknown>((n, k) => (isRecord(n) ? n[k] : undefined), tree);
  let usd = 0;
  for (const t of tasks.length > 0 ? tasks : [{}]) {
    const task = isRecord(t) ? t : {};
    const key = task.priority === 2 ? 'priority_high' : 'priority_normal';
    const leaves = isRecord(node) ? node[key] : undefined;
    const price = leafPrice(rule, leaves, task);
    if (price === undefined) {
      const name = [...rule.node, key].join('.');
      return {
        usd: null,
        basis: 'unknown',
        warning: `price rule ${rule.path}: no price at ${name} in the price tree`,
      };
    }
    const base = price * (rule.factor ?? 1);
    let times = 1;
    let add = 0;
    for (const x of rule.extras ?? []) {
      const v = task[x.field];
      if (v === undefined || v === null || v === false || (x.when && !x.when.test(String(v)))) {
        continue;
      }
      const n = typeof v === 'number' ? Math.max(0, v) : 1;
      times *= x.times ?? 1;
      add += n * ((x.add ?? 0) * base + (x.usd ?? 0));
    }
    usd += base * pageFactor(rule.pages, task) * times + add;
  }
  return { usd: Math.round(usd * 1e9) / 1e9, basis: 'rule' }; // drop float noise
}

// Cost guard: the refusal (exit 4) or undefined to send. Unknown and unbounded prices send only
// with an explicit --max-cost.
export function guard(
  specPath: string,
  est: Estimate,
  ceiling: number,
  explicit: boolean,
): string | undefined {
  if (est.usd !== null) {
    return est.usd > ceiling
      ? `estimate $${est.usd} above ceiling $${ceiling} for ${specPath} — raise --max-cost <usd> or DFS_MAX_COST, or --sandbox`
      : undefined;
  }
  if (explicit) return undefined;
  const why = est.basis === 'unbounded' ? 'has no upper bound' : 'unknown';
  return `price of ${specPath} ${why} — pass --max-cost <usd> to send, or --sandbox`;
}
