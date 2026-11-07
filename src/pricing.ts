// Pricing (docs/spec/modules/pricing.md): Estimate from the body, the price tree and the price
// rules; Cost guard. shortcut: rules for serp, keywords_data, dataforseo_labs, backlinks and
// domain_analytics only; ticket 07 adds the rest.
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
  'available_filters', // backlinks/overview: "We do not charge any fees for using data filtering"
  'available_history',
  'index', // backlinks/index
  // A whole path: other technologies paths are paid.
  '/v3/domain_analytics/technologies/technologies',
]);
export const isFree = (specPath: string): boolean =>
  FREE.has(specPath) || specPath.split('/').some((w) => FREE.has(w));

// Billing unit: results per SERP; each SERP after the first costs `next` of the first.
type Pages = { field: string; size: number; next: number };
// A paid body field. `when` tests String(value), default: set and not false. A number value
// counts n units. `times` multiplies the task price, `add` adds n × the base price, `usd` n × usd.
type Extra = { field: string; when?: RegExp; times?: number; add?: number; usd?: number };
// Count of a per_result leaf: an array length or a number in `field`, at most `max`; absent →
// `default`, else `max`. A `span` counts the `unit` periods (or the period in body field `by`)
// from date_from (absent: `from`, the earliest date) to date_to (absent: today). No results → 1.
type Unit = 'day' | 'week' | 'month' | 'year';
type Span = { from: string; unit: Unit; by?: string };
type Results = { field?: string; max?: number; default?: number; span?: Span };
export type Rule = {
  path: string;
  node: string[];
  factor?: number; // list price / node price
  pages?: Pages;
  results?: Results;
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

// --- dataforseo_labs. https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api (also
// -amazon-api): "Per task + per item"; nodes carry no engine word. Items: "limited to 1000".
// Docs: include_clickstream_data "you will be charged double the price for the request".
const CLICKSTREAM: Extra = { field: 'include_clickstream_data', times: 2 };
const LIMIT: Results = { field: 'limit', max: 1000, default: 100 };
const labs = (engine: string, api: string, results: Results, node = api): Rule => ({
  path: `/v3/dataforseo_labs/${engine}/${api}/live`,
  node: ['dataforseo_labs', node, 'live'],
  results,
  extras: [CLICKSTREAM],
});
const each = (field: string, max = 1000): Results => ({ field, max });
// Google Play and App Store rules: https://dataforseo.com/pricing/dataforseo-labs/
// dataforseo-labs-google-play-api and dataforseo-labs-app-store-api, same "$0.012 + $0.00012".
const LABS_RULES: Rule[] = [
  ...[
    'keywords_for_site',
    'related_keywords',
    'keyword_suggestions',
    'categories_for_domain',
    'keywords_for_categories',
    'ranked_keywords',
    'serp_competitors',
    'competitors_domain',
    'domain_intersection',
    'subdomains',
    'relevant_pages',
    'domain_rank_overview',
    'page_intersection',
    'keywords_for_app',
    'app_competitors',
    'app_intersection',
  ].map((api) => labs('google', api, LIMIT)),
  labs('google', 'keyword_ideas', { ...LIMIT, default: 700 }),
  labs('google', 'top_searches', { ...LIMIT, default: 1000 }),
  // One item per input; keyword_overview and historical_*: "you will not be charged for the
  // keywords omitted in the results", at most 700 keywords.
  ...['bulk_keyword_difficulty', 'search_intent', 'categories_for_keywords'].map((api) =>
    labs('google', api, each('keywords')),
  ),
  labs('google', 'keyword_overview', each('keywords', 700)),
  labs('google', 'historical_keyword_data', each('keywords', 700)),
  // No node of its own; not a pricing-page exception, so the general rate of historical_keyword_data.
  labs('google', 'historical_search_volume', each('keywords', 700), 'historical_keyword_data'),
  labs('google', 'bulk_traffic_estimation', each('targets')),
  labs('google', 'bulk_app_metrics', each('app_ids')),
  labs('apple', 'bulk_app_metrics', each('app_ids')),
  ...['keywords_for_app', 'app_competitors', 'app_intersection'].map((api) =>
    labs('apple', api, LIMIT),
  ),
  // Exceptions ($0.12 + $0.0012): "billed for setting a task and data for each domain".
  labs('google', 'historical_bulk_traffic_estimation', each('targets')),
  labs('google', 'domain_metrics_by_categories', LIMIT),
  // "each item representing a month's worth of data"; date_from at least 2020-10-01.
  // shortcut: absent date_from counts from 2020-10 (API default: 6 months); add a default span if
  // the over-estimate refuses real calls.
  labs('google', 'historical_rank_overview', { span: { from: '2020-10-01', unit: 'month' } }),
  // "Per SERP", one monthly snapshot each, at most 365 days back: 13 months at most.
  labs('google', 'historical_serps', { max: 13 }),
  // https://dataforseo.com/pricing/dataforseo-labs/dataforseo-amazon-api
  labs('amazon', 'bulk_search_volume', each('keywords')),
  labs('amazon', 'product_rank_overview', each('asins')),
  ...[
    'related_keywords',
    'ranked_keywords',
    'product_competitors',
    'product_keyword_intersections',
  ].map((api) => labs('amazon', api, LIMIT)),
];

// --- backlinks. https://dataforseo.com/pricing/backlinks/backlinks: "billed for setting a task and
// for each row in the response"; bulk endpoints "accept up to 1000 targets".
const backlinks = (api: string, results: Results): Rule => ({
  path: `/v3/backlinks/${api}/live`,
  node: ['backlinks', api, 'live'],
  results,
});
const BACKLINKS_RULES: Rule[] = [
  backlinks('summary', { max: 1 }),
  ...[
    'backlinks',
    'anchors',
    'domain_pages',
    'domain_pages_summary',
    'referring_domains',
    'referring_networks',
    'competitors',
    'domain_intersection',
    'page_intersection',
  ].map((api) => backlinks(api, LIMIT)),
  ...[
    'bulk_ranks',
    'bulk_backlinks',
    'bulk_spam_score',
    'bulk_referring_domains',
    'bulk_new_lost_backlinks',
    'bulk_new_lost_referring_domains',
    'bulk_pages_summary',
  ].map((api) => backlinks(api, each('targets'))),
  // One row per month; date_from at least 2019-01-01, the default.
  backlinks('history', { span: { from: '2019-01-01', unit: 'month' } }),
  // One row per group_range period (default month); date_from at least 2019-01-30.
  ...['timeseries_summary', 'timeseries_new_lost_summary'].map((api) =>
    backlinks(api, { span: { from: '2019-01-30', unit: 'month', by: 'group_range' } }),
  ),
];

// --- domain_analytics. https://dataforseo.com/pricing/domain-analytics-api/domain-technologies-api:
// "$0.012 per task plus $0.0012 for each returned item"; domain_technologies "flat $0.012 per task".
const technologies = (api: string, results?: Results): Rule => ({
  path: `/v3/domain_analytics/technologies/${api}/live`,
  node: ['domain_analytics', 'technologies', api, 'live'],
  results,
});
const BIG_LIMIT: Results = { ...LIMIT, max: 10000 };
const DOMAIN_RULES: Rule[] = [
  technologies('domain_technologies'),
  technologies('aggregation_technologies', BIG_LIMIT),
  technologies('domains_by_technology', BIG_LIMIT),
  technologies('domains_by_html_terms', BIG_LIMIT),
  technologies('technologies_summary', { max: 1 }), // one result object, no items array
  // One item per date from 2022-10-31. shortcut: the period is not documented, so per day (worst
  // case); switch to month if a real cost shows monthly items.
  technologies('technology_stats', { span: { from: '2022-10-31', unit: 'day' } }),
  // https://dataforseo.com/pricing/domain-analytics-api/domain-analytics-whois-api: "$0.12, plus
  // $0.0012 for each returned domain. ... 100 domains by default ... 1,000 domains per task".
  {
    path: '/v3/domain_analytics/whois/overview/live',
    node: ['domain_analytics', 'whois', 'overview', 'live'],
    results: LIMIT,
  },
];

export const RULES: Rule[] = [
  ...SERP_RULES,
  ...KEYWORDS_RULES,
  ...LABS_RULES,
  ...BACKLINKS_RULES,
  ...DOMAIN_RULES,
];
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

const DAY_MS = 86_400_000;
// Periods from date_from to date_to, both ends counted; an unreadable date takes the default.
function periods(span: Span, task: Record<string, unknown>, now: number): number {
  const date = (v: unknown, or: number) => {
    const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
    return new Date(Number.isNaN(t) ? or : t);
  };
  const a = date(task.date_from, Date.parse(span.from));
  const b = date(task.date_to, now);
  const by = span.by && task[span.by];
  const unit = typeof by === 'string' ? by : span.unit;
  const days = Math.floor((b.getTime() - a.getTime()) / DAY_MS);
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  const n =
    unit === 'day'
      ? days + 1
      : unit === 'week'
        ? Math.ceil((days + 1) / 7) + 1 // a partial week at each end
        : unit === 'year'
          ? b.getUTCFullYear() - a.getUTCFullYear() + 1
          : months + 1;
  return Math.max(1, n);
}

function count(r: Results | undefined, task: Record<string, unknown>, now: number): number {
  if (!r) return 1;
  if (r.span) return periods(r.span, task, now);
  const max = r.max ?? 1;
  const v = r.field === undefined ? undefined : task[r.field];
  if (Array.isArray(v)) return Math.min(v.length, max);
  if (typeof v === 'number' && Number.isFinite(v)) return Math.min(Math.max(0, v), max);
  return r.default ?? max;
}

// Node price of one task: the sum of its leaves; undefined for an absent or unknown leaf.
function leafPrice(
  rule: Rule,
  leaves: unknown,
  task: Record<string, unknown>,
  now: number,
): number | undefined {
  if (!Array.isArray(leaves) || leaves.length === 0) return undefined;
  let usd = 0;
  for (const l of leaves) {
    if (!isRecord(l) || typeof l.cost !== 'number') return undefined;
    if (l.cost_type === 'per_request') usd += l.cost;
    else if (l.cost_type !== 'per_result') return undefined;
    else usd += l.cost * count(rule.results, task, now);
  }
  return usd;
}

// Worst case of one call: the sum over its tasks (a GET is one request). `tree` is the stored
// `price` node, undefined when dfs has none. `now` ends a date span with no date_to.
export function estimate(
  rule: Rule | undefined,
  tasks: unknown[],
  tree: unknown,
  now: number,
): Estimate {
  if (rule?.unbounded) return { usd: null, basis: 'unbounded' };
  if (!rule || tree === undefined) return { usd: null, basis: 'unknown' };
  const node = rule.node.reduce<unknown>((n, k) => (isRecord(n) ? n[k] : undefined), tree);
  let usd = 0;
  for (const t of tasks.length > 0 ? tasks : [{}]) {
    const task = isRecord(t) ? t : {};
    const key = task.priority === 2 ? 'priority_high' : 'priority_normal';
    const leaves = isRecord(node) ? node[key] : undefined;
    const price = leafPrice(rule, leaves, task, now);
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
