// Guards for parsed JSON: narrow `unknown` with `isRecord` + `typeof`, never a cast.

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
