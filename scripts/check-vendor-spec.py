"""Check every claim docs/spec/SPEC.md makes about the vendor OpenAPI spec.

Usage: python3 -I check.py <openapi_specification.yaml> [overlay.yaml]
Read-only. Prints one block per claim class; docs/spec/SPEC.md cites the block name.
"""
import collections, datetime, re, sys
import yaml

class Loader(yaml.SafeLoader):
    """No timestamp tag: YAML 1.2 core schema, like the npm `yaml` package dfs uses."""
Loader.yaml_implicit_resolvers = {k: [r for r in v if r[0].rsplit(':', 1)[1] not in ('timestamp', 'value', 'bool')]
                                  for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()}
Loader.add_implicit_resolver('tag:yaml.org,2002:bool', re.compile(r'^(?:true|True|TRUE|false|False|FALSE)$'), list('tTfF'))
d = yaml.load(open(sys.argv[1], encoding='utf-8'), Loader=Loader)

def apply_overlay(doc, path):
    """OpenAPI Overlay 1.0 subset: RFC 9535 normalized-path targets, update and remove (docs/spec/SPEC.md Vendor overlay)."""
    ov = yaml.load(open(path, encoding='utf-8'), Loader=Loader)
    misses = []
    for act in ov['actions']:
        keys = re.findall(r"\['([^']*)'\]", act['target'])
        assert act['target'] == '$' + ''.join(f"['{k}']" for k in keys), f"not a normalized path: {act['target']}"
        node = doc
        for k in keys[:-1]: node = node.get(k) if isinstance(node, dict) else None
        if not isinstance(node, dict) or keys[-1] not in node: misses.append(act['target']); continue
        assert isinstance(node[keys[-1]], (dict, list)), f"Overlay 1.0 target must be an object or array: {act['target']}"
        if act.get('remove'): del node[keys[-1]]
        else:
            new = {k: v for k, v in act['update'].items() if node[keys[-1]].get(k) != v}
            if not new: misses.append(act['target']); continue
            node[keys[-1]].update(new)
    return len(ov['actions']), misses

if len(sys.argv) > 2:
    n, misses = apply_overlay(d, sys.argv[2])
    print(f'overlay.actions: {n}'); print(f'overlay.no_effect: {misses}')
S = d['components']['schemas']
P = d['paths']
out = lambda k, v: print(f'{k}: {v}')

def deref(n):
    while isinstance(n, dict) and '$ref' in n:
        n = S[n['$ref'].split('/')[-1]]
    return n

def fields(n, seen=None):
    """Union of property schemas over properties/$ref/allOf/oneOf/anyOf/discriminator (spec Planner)."""
    seen = set() if seen is None else seen
    acc = {}
    if not isinstance(n, dict): return acc
    if '$ref' in n:
        name = n['$ref'].split('/')[-1]
        if name in seen: return acc
        seen.add(name); return fields(S[name], seen)
    acc.update(n.get('properties') or {})
    for k in ('allOf', 'oneOf', 'anyOf'):
        for s in n.get(k) or []: acc.update(fields(s, seen))
    for ref in ((n.get('discriminator') or {}).get('mapping') or {}).values():
        acc.update(fields({'$ref': ref}, seen))
    return acc

def free_form(n):
    return isinstance(n, dict) and n.get('type') == 'object' and not any(
        k in n for k in ('properties', '$ref', 'allOf', 'oneOf', 'anyOf', 'additionalProperties', 'discriminator'))

def jtype(v):
    if v is None: return 'null'
    if isinstance(v, bool): return 'boolean'
    if isinstance(v, int): return 'integer'
    if isinstance(v, float): return 'number'
    if isinstance(v, (str, datetime.date)): return 'string'
    return 'array' if isinstance(v, list) else 'object'

def check(v, n, path, faults):
    n = deref(n)
    if not isinstance(n, dict): return
    t = n.get('type')
    if v is None:
        if str(n.get('nullable')).lower() != 'true' and t: faults.append(('null', path))
        return
    if t and not (t == jtype(v) or (t == 'number' and jtype(v) == 'integer')):
        faults.append(('type', f'{path} want {t} got {jtype(v)}')); return
    if isinstance(v, list):
        for i in v: check(i, n.get('items') or {}, path + '[]', faults)
    elif isinstance(v, dict):
        f = fields(n)
        if not f and t == 'object': return
        for k, x in v.items():
            if k not in f: faults.append(('name', f'{path}.{k}'))
            else: check(x, f[k], f'{path}.{k}', faults)

# 1. Inventory
methods = collections.Counter(len([m for m in v if m in ('get', 'post', 'put', 'delete', 'patch')]) for v in P.values())
mods = sorted({p.split('/')[2] for p in P})
out('inventory.paths', len(P)); out('inventory.modules', f'{len(mods)} {mods}')
out('inventory.methods_per_path', dict(methods))
non_path = [p for p, v in P.items() for m, op in v.items() if isinstance(op, dict)
            for prm in op.get('parameters') or [] if deref(prm).get('in') != 'path']
out('inventory.non_path_params', len(non_path))
post_nonarray = [p for p, v in P.items() if 'post' in v and
                 ((v['post'].get('requestBody') or {}).get('content', {}).get('application/json', {}).get('schema') or {}).get('type') != 'array']
out('inventory.post_body_not_array', post_nonarray)
out('inventory.servers', [s['url'] for s in d.get('servers', [])])
out('inventory.ai_suffix_paths', [p for p in P if p.endswith('.ai')])
out('inventory.no_description', [p for p, v in P.items() if not any((op or {}).get('description') for op in v.values() if isinstance(op, dict))])

# 2. Examples through a names+types Planner
tot = 0; per = collections.defaultdict(list)
for p, v in P.items():
    if 'post' not in v: continue
    sch = v['post']['requestBody']['content']['application/json']['schema']
    ex = sch.get('example')
    if ex is None: continue
    tot += 1
    for i, task in enumerate(ex if isinstance(ex, list) else [ex]):
        f = []; check(task, sch['items'], '', f)
        for kind, where in f: per[kind].append(f'{p} {where}')
out('examples.total', tot)
for kind in ('name', 'type', 'null'):
    out(f'examples.{kind}_faults', f'{len(per[kind])} ' + '; '.join(per[kind][:12]))

# 3. Free-form slots and deprecated fields in request schemas
ff = collections.Counter(); dep = 0
def walk(n, key):
    global dep
    if isinstance(n, dict):
        if free_form(n): ff[key] += 1
        if str(n.get('deprecated')).lower() == 'true': dep += 1
        for k, x in n.items(): walk(x, k if k not in ('items',) else key + '[]')
    elif isinstance(n, list):
        for x in n: walk(x, key)
for name, s in S.items():
    if name.endswith('RequestInfo'): walk(s, name)
out('request.free_form_slots', f'{sum(ff.values())} {dict(collections.Counter(k.split(".")[-1] for k in ff.elements()))}')
out('request.deprecated_fields', dep)
fk = collections.Counter(k for name, s in S.items() if name.endswith('RequestInfo') for k in fields(s) if 'filters' in k)
out('request.filter_field_names', dict(fk))

# 4. Task lifecycle per task_post level
levels = sorted(p[:-len('/task_post')] for p in P if p.endswith('/task_post'))
shape = collections.Counter(); detail = {}
for lv in levels:
    gets = sorted(p[len(lv) + 1:] for p in P if p.startswith(lv + '/task_get'))
    variants = sorted({g.split('/')[1] for g in gets if g.count('/') >= 2})
    bare = any(g == 'task_get/{id}' for g in gets)
    key = 'none' if not gets else ('advanced/regular' if {'advanced', 'regular'} & set(variants) else
                                   ('bare' if bare and not variants else f'other {variants}{" +bare" if bare else ""}'))
    shape[key] += 1; detail[lv] = key
    rd = lv
    while rd and rd + '/tasks_ready' not in P: rd = rd.rsplit('/', 1)[0]
    if not rd: detail[lv] += ' NO tasks_ready'
out('lifecycle.task_post_levels', len(levels)); out('lifecycle.collect_shapes', dict(shape))
out('lifecycle.not_advanced_regular', {k: v for k, v in detail.items() if not v.startswith('advanced')})
out('lifecycle.no_tasks_ready', [k for k, v in detail.items() if 'NO tasks_ready' in v])

# 5. id_list and user_data
idl = sorted(p for p in P if p.endswith('/id_list'))
out('id_list.paths', f'{len(idl)} {[p.split("/")[2] for p in idl]}')
task_mods = sorted({lv.split('/')[2] for lv in levels})
out('id_list.task_modules_without', [m for m in task_mods if f'/v3/{m}/id_list' not in P])
r = fields(S.get('IdListResultInfo') or next(S[k] for k in S if 'IdList' in k and k.endswith('ResultInfo')))
out('id_list.result_fields', sorted(r))
out('user_data.result_fields', sorted(fields(S['AppendixUserDataResultInfo'])))

# 6. POST classification for limits
cls = collections.Counter(); other = []
for p, v in P.items():
    if 'post' not in v: continue
    w = p.split('/')[2:]
    if p.endswith('/task_post'): cls['task_post'] += 1
    elif 'live' in w: cls['live word'] += 1
    else: cls['other'] += 1; other.append('/'.join(w))
out('post.classes', dict(cls)); out('post.other', other)

# 7. Command tree: nodes that are both endpoint and level; clashes with hand commands
words = {tuple(p.split('/')[2:]) for p in P}
both = sorted('/'.join(w) for w in words if any(o[:len(w)] == w and len(o) > len(w) for o in words))
out('tree.endpoint_and_level', both)
hand = {'schema', 'search', 'store', '+run', '+collect'}
out('tree.hand_word_clash', sorted('/'.join(w) for w in words if hand & set(w)))
pp = collections.Counter(seg for p in P for seg in re.findall(r'\{(\w+)\}', p))
out('tree.path_params', dict(pp))

# 8. Fields the Estimate and paging read
want = ('priority', 'depth', 'limit', 'max_crawl_pages', 'offset', 'offset_token', 'search_after_token', 'tag')
cnt = collections.Counter(k for name, s in S.items() if name.endswith('RequestInfo') for k in fields(s) if k in want)
out('request.estimate_paging_fields', dict(cnt))
