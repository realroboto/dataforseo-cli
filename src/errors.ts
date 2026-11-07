// Exit codes (docs/spec/exit-codes-flags.md): 1 API or network, 2 account, 3 invalid input
// (nothing sent), 4 cost guard, 5 dfs bug, 6 incomplete.
export type ExitCode = 1 | 2 | 3 | 4 | 5 | 6;

export class DfsError extends Error {
  readonly exit: ExitCode;
  constructor(exit: ExitCode, message: string) {
    super(message);
    this.name = 'DfsError';
    this.exit = exit;
  }
}

// A caught value's message: an Error's own text (no `Error: ` prefix), anything else as a string.
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
