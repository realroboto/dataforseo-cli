// Pricing (docs/spec/modules/pricing.md). shortcut: only the free list by path word, every other
// price unknown, so a paid call needs an explicit --max-cost; ticket 04 adds price rules.
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

// Estimate in USD: 0 for a free path or the sandbox, undefined when unknown.
export const estimate = (specPath: string, sandbox: boolean): number | undefined =>
  sandbox || specPath.split('/').some((w) => FREE.has(w)) ? 0 : undefined;

// Cost guard: an unknown price sends only with an explicit --max-cost (the sandbox estimates 0).
// shortcut: no estimate is above 0 yet, so no ceiling check; ticket 04 adds it with price rules.
export const guard = (est: number | undefined, ceiling: number | undefined): 'send' | 'refuse' =>
  est === undefined && ceiling === undefined ? 'refuse' : 'send';
