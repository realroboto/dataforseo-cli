// Vendor overlay: an OpenAPI Overlay 1.0 subset (docs/spec/modules/catalog.md). Targets are
// RFC 9535 normalized paths only, so no JSONPath dependency; actions `update` and `remove`.
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from './json.ts';

// One normalized-path segment: a name in single quotes (only `\'` and `\\` escaped) or an index.
const SEGMENT = /\['((?:[^'\\]|\\['\\])*)'\]|\[(0|[1-9]\d*)\]/y;

export function parseTarget(target: string): (string | number)[] {
  const keys: (string | number)[] = [];
  SEGMENT.lastIndex = 1;
  while (target.startsWith('$') && SEGMENT.lastIndex < target.length) {
    const m = SEGMENT.exec(target);
    if (!m) break;
    keys.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : Number(m[2]));
  }
  if (!target.startsWith('$') || keys.length === 0 || SEGMENT.lastIndex !== target.length) {
    throw new Error(`overlay target is not a normalized path: ${target}`);
  }
  return keys;
}

const child = (n: unknown, k: string | number): unknown =>
  Array.isArray(n) && typeof k === 'number'
    ? n[k]
    : isRecord(n) && typeof k === 'string' && Object.hasOwn(n, k)
      ? n[k]
      : undefined;

// Overlay 1.0 update: objects merge recursively, an array target gets the value appended.
function merge(target: object, update: unknown): boolean {
  if (Array.isArray(target)) {
    target.push(update);
    return true;
  }
  if (!isRecord(target) || !isRecord(update)) throw new Error('overlay update must be an object');
  let changed = false;
  for (const [k, v] of Object.entries(update)) {
    const old = Object.hasOwn(target, k) ? target[k] : undefined;
    if (isRecord(old) && isRecord(v)) changed = merge(old, v) || changed;
    else if (!isDeepStrictEqual(old, v)) {
      target[k] = v;
      changed = true;
    }
  }
  return changed;
}

// Applies the overlay to `doc` in place. Returns the targets of actions that changed nothing
// (target absent, or update already present); `spec:check` fails on them, a run does not.
export function applyOverlay(doc: unknown, overlay: unknown): string[] {
  if (
    !isRecord(overlay) ||
    typeof overlay.overlay !== 'string' ||
    !/^1\.0\.\d+$/.test(overlay.overlay) ||
    !Array.isArray(overlay.actions)
  ) {
    throw new Error('overlay is not an Overlay 1.0 document');
  }
  const noEffect: string[] = [];
  for (const action of overlay.actions) {
    if (!isRecord(action) || typeof action.target !== 'string') {
      throw new Error('overlay action has no target');
    }
    const keys = parseTarget(action.target);
    const last = keys[keys.length - 1];
    const parent = keys.slice(0, -1).reduce(child, doc);
    const node = child(parent, last);
    if (node === undefined) {
      noEffect.push(action.target);
      continue;
    }
    if (typeof node !== 'object' || node === null) {
      throw new Error(`overlay target selects no object or array: ${action.target}`);
    }
    if (action.remove === true) {
      if (Array.isArray(parent)) parent.splice(Number(last), 1);
      else if (isRecord(parent)) delete parent[last];
    } else if (action.update === undefined) {
      throw new Error(`overlay action has neither update nor remove: ${action.target}`);
    } else if (!merge(node, action.update)) {
      noEffect.push(action.target);
    }
  }
  return noEffect;
}
