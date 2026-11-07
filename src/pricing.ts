// Pricing (docs/spec/modules/pricing.md): Estimate from the body, the price tree and the price
// rules; Cost guard. shortcut: rules for serp/google/organic only; tickets 05–07 add the rest.
import { isRecord } from './json.ts';

const FREE = new Set([
  'task_get',
  'tasks_ready',
  'tasks_fixed',
  'id_list',
  'errors',
  'user_data',
  'locations',
  'languages',
  'webhook_resend',
]);
export const isFree = (specPath: string): boolean => specPath.split('/').some((w) => FREE.has(w));

// Billing unit: results per SERP; each SERP after the first costs `next` of the node price.
type Pages = { field: string; size: number; next: number };
export type Rule = { path: string; node: string[]; pages?: Pages; unbounded?: true };

// Google organic: billed per SERP of 10 results, default depth 10; each next SERP 25% lower
// (help-center/above-100-results-with-serp-api: `depth` 15 bills two SERPs).
const SERP_PAGES: Pages = { field: 'depth', size: 10, next: 0.75 };
export const RULES: Rule[] = [
  { path: '/v3/serp/google/organic/task_post', node: ['serp', 'task_post'], pages: SERP_PAGES },
  ...['advanced', 'regular', 'html'].map((kind) => ({
    path: `/v3/serp/google/organic/live/${kind}`,
    node: ['serp', 'live', kind],
    pages: SERP_PAGES,
  })),
];
export const ruleFor = (specPath: string): Rule | undefined =>
  RULES.find((r) => r.path === specPath);

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
    const [price] = isRecord(node) && Array.isArray(node[key]) ? node[key] : [];
    if (!isRecord(price) || price.cost_type !== 'per_request' || typeof price.cost !== 'number') {
      const name = [...rule.node, key].join('.');
      return {
        usd: null,
        basis: 'unknown',
        warning: `price rule ${rule.path}: no per_request price at ${name} in the price tree`,
      };
    }
    usd += price.cost * pageFactor(rule.pages, task);
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
