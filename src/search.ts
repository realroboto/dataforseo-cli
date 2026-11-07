// Search: endpoints by path words, module tag and description, in an in-memory SQLite FTS5
// index built per call (docs/spec/modules/catalog.md, Search); path words weigh most.
// shortcut: DatabaseSync is a documentation-only deprecated alias of Database since Node v26.11.0
// (DEP0210); switch when @types/node types Database.
import { DatabaseSync } from 'node:sqlite';
import type { Endpoint } from './catalog.ts';
import { DfsError } from './errors.ts';
import { plainLines, SEARCH_USAGE } from './render.ts';

// Case and diacritics folded on both sides: `Migração` → `migracao`.
const fold = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2') // `BusinessData` → `Business Data`
    .replace(/_/g, ' ')
    .toLowerCase();

// Tokens hold only letters and digits, so no FTS5 syntax reaches the match expression.
export function matchQuery(query: string): string {
  const tokens = fold(query).match(/[\p{L}\p{N}]+/gu);
  if (!tokens) throw new DfsError(3, `usage: ${SEARCH_USAGE}`);
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export function search(endpoints: Endpoint[], query: string): Endpoint[] {
  const match = matchQuery(query);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "create virtual table e using fts5(i unindexed, words, tag, descr, tokenize = 'porter unicode61 remove_diacritics 2')",
    );
    const insert = db.prepare('insert into e values (?, ?, ?, ?)');
    db.exec('begin');
    endpoints.forEach((ep, i) => {
      const words = ep.words.filter((w) => !w.startsWith('<')).join(' ');
      insert.run(
        i,
        fold(words),
        fold((ep.op.tags ?? []).join(' ')),
        fold(plainLines(ep.op.description).join(' ')),
      );
    });
    db.exec('commit');
    return db
      .prepare('select i from e where e match ? order by bm25(e, 0, 6, 2, 1) limit 20')
      .all(match)
      .map(({ i }) => endpoints[Number(i)]);
  } finally {
    db.close();
  }
}
