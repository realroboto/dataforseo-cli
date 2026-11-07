// OpenAPI 3.0 Schema Objects as the Planner reads them (docs/spec/modules/planner.md).
// Pattern: scripts/check-vendor-spec.py `fields()` and `check()`.
import { isRecord } from './json.ts';

export type Schema = {
  type?: string;
  nullable?: unknown;
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  $ref?: string;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  discriminator?: { mapping?: Record<string, string> };
  example?: unknown;
};
export type Schemas = Record<string, Schema>;

export type Fault = { kind: 'name' | 'type' | 'null'; path: string; detail?: string };

const refName = (ref: string): string => ref.slice(ref.lastIndexOf('/') + 1);
const named = (schemas: Schemas, name: string): Schema | undefined =>
  Object.hasOwn(schemas, name) ? schemas[name] : undefined;

// Follows `$ref` to a schema with content; a dangling or cyclic `$ref` gives undefined.
export function deref(n: Schema | undefined, schemas: Schemas): Schema | undefined {
  const seen = new Set<string>();
  while (n?.$ref !== undefined) {
    const name = refName(n.$ref);
    if (seen.has(name)) return undefined;
    seen.add(name);
    n = named(schemas, name);
  }
  return n;
}

// Fields of an object: the union over properties, $ref, allOf, oneOf, anyOf and
// discriminator.mapping targets, with a visited set against cycles.
export function fields(
  n: Schema | undefined,
  schemas: Schemas,
  seen = new Set<string>(),
): Map<string, Schema> {
  const acc = new Map<string, Schema>();
  if (!isRecord(n)) return acc;
  if (n.$ref !== undefined) {
    const name = refName(n.$ref);
    if (seen.has(name)) return acc;
    seen.add(name);
    return fields(named(schemas, name), schemas, seen);
  }
  for (const [k, v] of Object.entries(n.properties ?? {})) acc.set(k, v);
  for (const s of [...(n.allOf ?? []), ...(n.oneOf ?? []), ...(n.anyOf ?? [])]) {
    for (const [k, v] of fields(s, schemas, seen)) acc.set(k, v);
  }
  for (const ref of Object.values(n.discriminator?.mapping ?? {})) {
    for (const [k, v] of fields({ $ref: ref }, schemas, seen)) acc.set(k, v);
  }
  return acc;
}

// OpenAPI 3.0 `nullable`; the vendor spec may write it as a string.
export const isNullable = (s: Schema | undefined): boolean =>
  String(s?.nullable).toLowerCase() === 'true';

export function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

// Name and type faults of a value against a schema. `null` is valid only where
// `nullable: true`; no `type` accepts any value; an object with no fields accepts any keys.
export function faults(v: unknown, n: Schema | undefined, schemas: Schemas, path = ''): Fault[] {
  const out: Fault[] = [];
  const s = deref(n, schemas);
  if (!isRecord(s)) return out;
  const want = s.type;
  if (v === null) {
    if (want && !isNullable(s)) out.push({ kind: 'null', path });
    return out;
  }
  const got = jsonType(v);
  if (want && want !== got && !(want === 'number' && got === 'integer')) {
    out.push({ kind: 'type', path, detail: `want ${want} got ${got}` });
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) out.push(...faults(x, s.items ?? {}, schemas, `${path}[]`));
  } else if (isRecord(v)) {
    const f = fields(s, schemas);
    if (f.size === 0) return out;
    for (const [k, x] of Object.entries(v)) {
      const fs = f.get(k);
      if (fs === undefined) out.push({ kind: 'name', path: `${path}.${k}` });
      else out.push(...faults(x, fs, schemas, `${path}.${k}`));
    }
  }
  return out;
}
