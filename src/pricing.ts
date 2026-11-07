// Pricing (docs/spec/modules/pricing.md): Estimate from the body, the price tree and the price
// rules; Cost guard.
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
  // On-Page results and references: "will not be charged" or "charged only for posting a task"
  // (their docs pages; the price tree prices them at 0).
  ...[
    'force_stop',
    'summary/{id}',
    'pages',
    'pages_by_resource',
    'resources',
    'duplicate_tags',
    'duplicate_content',
    'links',
    'redirect_chains',
    'non_indexable',
    'waterfall',
    'keyword_density',
    'microdata',
    'uncrawlable_resources',
    'raw_html',
    'content_parsing',
    'lighthouse/audits',
    'lighthouse/versions',
  ].map((api) => `/v3/on_page/${api}`),
  // llm_responses/models: "Your account will not be charged for using this API".
  ...['chat_gpt', 'claude', 'gemini', 'perplexity'].map(
    (model) => `/v3/ai_optimization/${model}/llm_responses/models`,
  ),
]);
export const isFree = (specPath: string): boolean =>
  FREE.has(specPath) || specPath.split('/').some((w) => FREE.has(w));

// Billing unit: results per SERP; each SERP after the first costs `next` of the first.
type Pages = { field: string; size: number; next: number };
// A paid body field. `when` tests String(value), default: set and not false. A number value
// counts n units. `times` multiplies the task price, `add` adds n × the base price, `usd` n × usd.
// `unless`: skipped when that field is set (a flag whose price another flag already includes).
type Extra = {
  field: string;
  when?: RegExp;
  times?: number;
  add?: number;
  usd?: number;
  unless?: string;
};
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

// --- on_page. https://dataforseo.com/pricing/on-page/onpage-api: "Per crawled page", and
// "the max_crawl_pages field is effectively the spending cap". help-center/
// cost-of-onpage-api-parameters: each flag adds coefficient × base per page; browser rendering
// (33) "includes load_resources + enable_javascript".
const BROWSER = 'enable_browser_rendering';
const ONPAGE: Extra[] = [
  { field: 'load_resources', add: 2, unless: BROWSER },
  { field: 'enable_javascript', add: 9, unless: BROWSER },
  { field: BROWSER, add: 33 },
  { field: 'enable_content_parsing', add: 1 },
  { field: 'calculate_keyword_density', add: 1 },
];
const ON_PAGE_RULES: Rule[] = [
  // max_crawl_pages: required, no documented maximum; absent → the API refuses the task.
  {
    path: '/v3/on_page/task_post',
    node: ['on_page', 'task_post'],
    results: { field: 'max_crawl_pages', max: Number.POSITIVE_INFINITY, default: 1 },
    extras: ONPAGE,
  },
  // Live, one page per task: "Instant Pages and Content Parsing Live cost $0.00015 per page".
  // shortcut: content_parsing/live takes the crawl coefficients (no source of its own); fix if a
  // real cost differs.
  { path: '/v3/on_page/instant_pages', node: ['on_page', 'instant_pages'], extras: ONPAGE },
  {
    path: '/v3/on_page/content_parsing/live',
    node: ['on_page', 'content_parsing_live'],
    extras: ONPAGE,
  },
  { path: '/v3/on_page/page_screenshot', node: ['on_page', 'page_screenshot'] },
  // https://dataforseo.com/pricing/on-page/lighthouse-api: per task, categories and audits free.
  { path: '/v3/on_page/lighthouse/task_post', node: ['on_page', 'lighthouse', 'task_post'] },
  { path: '/v3/on_page/lighthouse/live/json', node: ['on_page', 'lighthouse', 'live'] },
];

// --- content_analysis. https://dataforseo.com/pricing/content-analysis-api/content-analysis:
// "billed for setting a task and for each row in the response"; search: one row per citation.
const content = (api: string, results: Results): Rule => ({
  path: `/v3/content_analysis/${api}/live`,
  node: ['content_analysis', api, 'live'],
  results,
});
// Trends: one row per date_group bucket (default month); category_trends date_from ≥ 2022-10-31.
const TRENDS: Results = { span: { from: '2022-10-31', unit: 'month', by: 'date_group' } };
const CONTENT_RULES: Rule[] = [
  content('search', LIMIT),
  content('summary', { max: 1 }),
  content('sentiment_analysis', { max: 1 }),
  // shortcut: the account tree bills it per request only, though the pricing page says per row
  // (10 rating rows, +$0.00036); add a row price if the real-cost warning fires.
  {
    path: '/v3/content_analysis/rating_distribution/live',
    node: ['content_analysis', 'rating_distribution', 'live'],
  },
  content('phrase_trends', TRENDS),
  content('category_trends', TRENDS),
];

// task_post, live/advanced, live/html: a path tail and its node tail.
const QUEUE_AND_LIVE = [['task_post'], ['live', 'advanced'], ['live', 'html']];

// --- merchant. https://dataforseo.com/pricing/merchant/google-shopping-api and
// .../merchant/amazon-api: per SERP block of `depth`, each block full price.
const MERCHANT_RULES: Rule[] = [
  // Google products: "per page of 40 results"; sellers: 10 sellers, get_shops_on_google ×2.
  {
    path: '/v3/merchant/google/products/task_post',
    node: ['merchant', 'google', 'products', 'task_post'],
    pages: full(40),
  },
  {
    path: '/v3/merchant/google/sellers/task_post',
    node: ['merchant', 'google', 'sellers', 'task_post'],
    pages: full(10),
    extras: [{ field: 'get_shops_on_google', times: 2 }],
  },
  {
    path: '/v3/merchant/google/product_info/task_post',
    node: ['merchant', 'google', 'product_info', 'task_post'],
  },
  {
    path: '/v3/merchant/google/sellers/ad_url/{shop_ad_aclk}',
    node: ['merchant', 'google', 'sellers', 'ad_url'],
  },
  // Amazon products: 100 results per block; ASIN and sellers per task (no depth).
  ...['products', 'asin', 'sellers'].flatMap((api) =>
    QUEUE_AND_LIVE.map((mode) => ({
      path: `/v3/merchant/amazon/${api}/${mode.join('/')}`,
      node: ['merchant', 'amazon', api, ...mode],
      ...(api === 'products' ? { pages: full(100) } : {}),
    })),
  ),
];

// --- app_data. https://dataforseo.com/pricing/app-data/google-play and .../app-data/app-store:
// same prices, shared nodes without an engine word; block sizes differ per engine.
const app = (engine: string, api: string, pages?: Pages): Rule => ({
  path: `/v3/app_data/${engine}/${api}/task_post`,
  node: ['app_data', api, 'task_post'],
  pages,
});
const APP_RULES: Rule[] = [
  app('google', 'app_searches', full(30)),
  app('apple', 'app_searches', full(100)),
  app('google', 'app_list', full(100)),
  app('apple', 'app_list', full(100)),
  app('google', 'app_info'),
  app('apple', 'app_info'),
  app('google', 'app_reviews', full(150)),
  app('apple', 'app_reviews', full(25)),
  // "$0.1 per request plus $0.001 per returned app".
  ...['google', 'apple'].map((engine) => ({
    path: `/v3/app_data/${engine}/app_listings/search/live`,
    node: ['app_data', 'app_listings', 'search', 'live'],
    results: LIMIT,
  })),
];

// --- business_data. Per block of `depth` results, each block full price, unless noted.
const business = (api: string, modes: string[][], bill: Omit<Rule, 'path' | 'node'> = {}) =>
  modes.map((mode) => ({
    path: `/v3/business_data/${api}/${mode.join('/')}`,
    node: ['business_data', ...api.split('/'), ...mode],
    ...bill,
  }));
const POST = [['task_post']];
const LIVE = [['live']];
const BOTH = [...POST, ...LIVE];
const BUSINESS_RULES: Rule[] = [
  // https://dataforseo.com/pricing/business-data/business-listings-api: "$0.012, plus $0.00036
  // for each returned item", at most 1,000.
  ...business('business_listings/search', LIVE, { results: LIMIT }),
  ...business('business_listings/categories_aggregation', LIVE, { results: LIMIT }),
  // https://dataforseo.com/pricing/business-data/business-data-api (also my_business_updates)
  ...business('google/my_business_info', BOTH),
  // Task fee $0.0015 + $0.00075 per 10 updates; the leaf ($0.00225) holds the first block.
  ...business('google/my_business_updates', POST, {
    pages: { field: 'depth', size: 10, next: 1 / 3 },
  }),
  // https://dataforseo.com/pricing/business-data/google-reviews-api (also extended_reviews)
  // "Per block of 10 returned reviews"; a search operator in keyword: "multiplied by 5".
  ...business('google/reviews', POST, { pages: full(10), extras: [OPERATORS] }),
  // Per 20 reviews. Docs: keyword ×3, cid or place_id ×2. The pricing page's fixed surcharge
  // (+$0.0015 keyword, +$0.00075 cid/place_id) equals it at depth 20, is lower above: take docs.
  ...business('google/extended_reviews', POST, {
    pages: full(20),
    extras: [
      OPERATORS,
      { field: 'keyword', times: 3 },
      { field: 'cid', times: 2, unless: 'keyword' },
      { field: 'place_id', times: 2, unless: 'keyword' },
    ],
  }),
  // https://dataforseo.com/pricing/business-data/google-questions-and-answers-api-pricing
  ...business('google/questions_and_answers', BOTH, { pages: full(20) }),
  // https://dataforseo.com/pricing/business-data/google-hotels-api (also hotel_info):
  // "billed per SERP containing up to 18 organic hotel entities".
  ...business('google/hotel_searches', BOTH, { pages: full(18) }),
  // One hotel per task; load_prices_by_dates: "multiplied by two".
  ...business('google/hotel_info', QUEUE_AND_LIVE, {
    extras: [{ field: 'load_prices_by_dates', times: 2 }],
  }),
  // https://dataforseo.com/pricing/business-data/business-data-api-trustpilot-search-pricing
  ...business('trustpilot/search', POST, { pages: full(10) }),
  // https://dataforseo.com/pricing/business-data/business-data-api-trustpilot-reviews-pricing
  ...business('trustpilot/reviews', POST, { pages: full(20) }),
  // https://dataforseo.com/pricing/business-data/business-data-api-tripadvisor-search-pricing
  ...business('tripadvisor/search', POST, { pages: full(30) }),
  // https://dataforseo.com/pricing/business-data/business-data-api-tripadvisor-pricing
  // A language field: "one extra request"; "(2 × $0.00075) + $0.00075 = $0.00225" at depth 20.
  ...business('tripadvisor/reviews', POST, {
    pages: full(10),
    extras: [
      { field: 'language_code', add: 1 },
      { field: 'language_name', add: 1, unless: 'language_code' },
    ],
  }),
];

// --- ai_optimization. https://dataforseo.com/pricing/ai-optimization/llm-responses: "$0.0006 +
// price charged by LLM", "the amount charged by the LLM is not known in advance": unbounded.
const llm = (model: string, mode: string): Rule => ({
  path: `/v3/ai_optimization/${model}/llm_responses/${mode}`,
  node: ['ai_optimization', 'llm_responses', mode],
  unbounded: true,
});
// https://dataforseo.com/pricing/ai-optimization/llm-mentions: $0.1 per task + $0.001 per row;
// rows from 2025-08-01, the earliest date_from.
// shortcut: docs examples bill $0.101 for 2–12 rows (maybe one row per task); the estimate counts
// every row, a worst case; lower it if real costs confirm.
const mentions = (api: string, results: Results): Rule => ({
  path: `/v3/ai_optimization/llm_mentions/${api}/live`,
  node: ['ai_optimization', 'llm_mentions', api, 'live'],
  results,
});
const AI_RULES: Rule[] = [
  ...['chat_gpt', 'claude', 'gemini'].flatMap((m) => [llm(m, 'live'), llm(m, 'task_post')]),
  llm('perplexity', 'live'),
  // https://dataforseo.com/pricing/ai-optimization/llm-scraper: "billed for each results page".
  ...['chat_gpt', 'gemini'].flatMap((model) =>
    QUEUE_AND_LIVE.map((mode) => ({
      path: `/v3/ai_optimization/${model}/llm_scraper/${mode.join('/')}`,
      node: ['ai_optimization', 'llm_scraper', ...mode],
    })),
  ),
  ...[
    'search_mentions',
    'target_metrics_lite',
    'top_mentioned_domains',
    'top_mentioned_pages',
    'top_mentioned_brands',
    'top_mentioned_brand_categories',
    'top_mentioned_domains_lite',
    'top_mentioned_pages_lite',
    'top_mentioned_brands_lite',
    'top_mentioned_brand_categories_lite',
  ].map((api) => mentions(api, LIMIT)),
  mentions('target_metrics', { max: 1 }), // one aggregate object, items null
  mentions('multi_target_metrics', each('targets', 10)), // one item per target set
  mentions('historical', { span: { from: '2025-08-01', unit: 'month' } }),
  ...['timeseries_delta', 'timeseries_new_lost'].map((api) =>
    mentions(api, { span: { from: '2025-08-01', unit: 'month', by: 'group_range' } }),
  ),
  // https://dataforseo.com/pricing/ai-optimization/ai-keyword-search-volume: one row per keyword, ≤ 1,000.
  {
    path: '/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live',
    node: ['ai_optimization', 'ai_keyword_data', 'keywords_search_volume', 'live'],
    results: each('keywords'),
  },
];

export const RULES: Rule[] = [
  ...SERP_RULES,
  ...KEYWORDS_RULES,
  ...LABS_RULES,
  ...BACKLINKS_RULES,
  ...DOMAIN_RULES,
  ...ON_PAGE_RULES,
  ...CONTENT_RULES,
  ...MERCHANT_RULES,
  ...APP_RULES,
  ...BUSINESS_RULES,
  ...AI_RULES,
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

// A body field in use: set and not false.
const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== false;

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
      if (!isSet(v) || (x.when && !x.when.test(String(v))) || (x.unless && isSet(task[x.unless]))) {
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
