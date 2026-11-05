#!/usr/bin/env python3
"""FSHO static site generator. Reads content/, writes dist/.
Usage: python build/gen.py            build into dist/
       python build/gen.py --check    validate content only (non-zero exit on errors; WARN lines do not fail)
       python build/gen.py --live     build without preview guards (noindex/banner/form lock) -- cutover only

Drafts: a page or market with `draft: true` is built in preview builds and skipped in
live/prod builds. Preview builds are a normal gen.py run while site.json preview is true,
plus Netlify deploy-preview, branch-deploy, and netlify dev (CONTEXT). Live/prod builds are
`gen.py --live`, Netlify production (CONTEXT=production), and any run with preview false
(except those Netlify preview contexts, which still include drafts). Omit `draft` when
published. Never write `draft: false`. The home page (empty slug) cannot be draft.
"""
import os, re, sys, json, glob, shutil, html

def _scalar(v):
    v = v.strip()
    if v in ('true', 'false'): return v == 'true'
    if v in ('', '~', 'null'): return None if v else ''
    if v == '[]': return []
    if len(v) >= 2 and v[0] == v[-1] == '"': return json.loads(v)
    if len(v) >= 2 and v[0] == v[-1] == "'": return v[1:-1].replace("''", "'")
    if re.fullmatch(r'-?\d+', v): return int(v)
    return v

def parse_frontmatter(text):
    """Dependency-free parser for the YAML subset used in content/pages:
    `key: scalar` lines and a list of flat mappings (`faq:` then `  - q: ..` / `    a: ..`)."""
    out, key, item = {}, None, None
    for n, line in enumerate(text.split('\n'), 1):
        if not line.strip() or line.lstrip().startswith('#'): continue
        m = re.match(r'^([A-Za-z_][\w-]*):(?:\s+(.*))?$', line)
        if m and not line[0].isspace():
            val = (m.group(2) or '').split(' #')[0] if not (m.group(2) or '').lstrip().startswith(('"', "'")) else m.group(2)
            key = m.group(1)
            out[key] = [] if val.strip() == '' else _scalar(val); item = None; continue
        m = re.match(r'^\s+-\s+([A-Za-z_]\w*):\s*(.*)$', line)
        if m and key and isinstance(out.get(key), list):
            item = {m.group(1): _scalar(m.group(2))}; out[key].append(item); continue
        m = re.match(r'^\s+([A-Za-z_]\w*):\s*(.*)$', line)
        if m and item is not None:
            item[m.group(1)] = _scalar(m.group(2)); continue
        raise ValueError(f'frontmatter line {n} not understood: {line.strip()[:60]}')
    return out

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
C = os.path.join(ROOT, 'content'); OUT = os.path.join(ROOT, 'dist'); B = os.path.join(ROOT, 'build')
TEMPLATES = {'home', 'market', 'situation', 'basic'}
MAX_IMG = 200 * 1024
PREVIEW_CTX = {'deploy-preview', 'branch-deploy', 'dev'}  # Netlify CONTEXT values that are draft deploys
IMG_SRC = re.compile(r'<img\b[^>]*?\bsrc\s*=\s*(["\'])([^"\']+)\1', re.I)
FORM1_NAMES = {'address': 1, 'first': 2, 'phone': 2, 'email': 2}  # names the hero form and step-2 handoff require

def esc(s):
    return str(s).replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;').replace('>', '&gt;')

def pos_int(v):
    return type(v) is int and v > 0

def show_drafts(site, live):
    """True when this build should include draft:true pages and markets."""
    if live:
        return False
    ctx = os.environ.get('CONTEXT', '')
    if ctx == 'production':
        return False
    if ctx in PREVIEW_CTX:
        return True
    return bool(site.get('preview', True))

def local_image_name(url, domain):
    if not isinstance(url, str): return None
    u = url.strip()
    if not u: return None
    if domain and u.startswith(domain): u = u[len(domain):]
    if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*://', u) or u.startswith('//'): return None
    u = u.split('#', 1)[0].split('?', 1)[0]
    name = os.path.basename(u)
    if not name or '.' not in name: return None
    if not name.lower().endswith(('.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.avif')): return None
    return name

def walk_text(obj, out):
    if isinstance(obj, str): out.append(obj)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(k, str) and k.startswith('_'): continue
            walk_text(v, out)
    elif isinstance(obj, list):
        for v in obj: walk_text(v, out)

def faq_ld_items(body, own, site_faq):
    """FAQ items this page actually exposes: its own faq, or the site faq when it renders {{faq}}."""
    own = [f for f in (own or []) if isinstance(f, dict) and f.get('q') and f.get('a')]
    renders = re.findall(r'\{\{faq(?::(\d+))?\}\}', body or '')
    if own: items = own
    elif renders: items = [f for f in (site_faq or []) if isinstance(f, dict) and f.get('q') and f.get('a')]
    else: return []
    if renders and all(n for n in renders):
        items = items[:max(int(n) for n in renders)]
    return items

def ld_script(obj):
    raw = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    return '<script type="application/ld+json">' + raw + '</script>'

def decorate_imgs(html_text, idx):
    """Add width/height (and alt, when the tag has none) for images listed in media.json."""
    def repl(m):
        tag = m.group(0)
        sm = IMG_SRC.search(tag)
        if not sm or not idx: return tag
        info = idx.get(os.path.basename(sm.group(2).split('?', 1)[0].split('#', 1)[0]))
        if not info: return tag
        extra = ''
        if not re.search(r'\bwidth\s*=', tag) and pos_int(info.get('width')): extra += f' width="{info["width"]}"'
        if not re.search(r'\bheight\s*=', tag) and pos_int(info.get('height')): extra += f' height="{info["height"]}"'
        if not re.search(r'\balt\s*=', tag) and isinstance(info.get('alt'), str) and info['alt'].strip():
            extra += f' alt="{esc(info["alt"])}"'
        return tag[:-1] + extra + '>' if extra else tag
    return re.sub(r'<img\b[^>]*>', repl, html_text, flags=re.I)

def load_media(errs):
    fp = os.path.join(C, 'media', 'media.json')
    if not os.path.exists(fp):
        errs.append('content/media/media.json: missing'); return None
    try: data = json.load(open(fp, encoding='utf-8'))
    except Exception as e:
        errs.append(f'content/media/media.json: {e}'); return None
    if not isinstance(data, list):
        errs.append('content/media/media.json: must be an array of {file, alt, width, height}'); return None
    return data

def load_page(fp):
    raw = open(fp, encoding='utf-8').read()
    m = re.match(r'^---\n(.*?)\n---\n?(.*)$', raw, re.S)
    if not m: raise ValueError('missing YAML frontmatter')
    fm = parse_frontmatter(m.group(1))
    fm.setdefault('slug', os.path.splitext(os.path.basename(fp))[0])
    if isinstance(fm.get('slug'), int): fm['slug'] = str(fm['slug'])
    if fm['slug'] == 'home': fm['slug'] = ''
    fm['body'] = m.group(2)
    return fm

def load_all():
    site = json.load(open(os.path.join(C, 'site.json'), encoding='utf-8'))
    pages, errs = [], []
    for fp in sorted(glob.glob(os.path.join(C, 'pages', '*.md'))):
        try: p = load_page(fp); p['_src'] = os.path.relpath(fp, ROOT); pages.append(p)
        except Exception as e: errs.append(f'{os.path.relpath(fp, ROOT)}: {e}')
    markets = []
    for fp in sorted(glob.glob(os.path.join(C, 'markets', '*.json'))):
        try: m = json.load(open(fp, encoding='utf-8')); m['_src'] = os.path.relpath(fp, ROOT); markets.append(m)
        except Exception as e: errs.append(f'{os.path.relpath(fp, ROOT)}: {e}')
    redirects = json.load(open(os.path.join(C, 'redirects.json'), encoding='utf-8'))
    site['_qualifier'] = load_qualifier(errs)
    site['_media'] = load_media(errs)
    return site, pages, markets, redirects, errs

QF = os.path.join(C, 'forms', 'qualifier.json')
MAX_QJS = 3584  # bytes: qualifier.js budget (about 3 KB)
PROTECTED = r'\b(race|racial|color|religio\w*|church|national origin|nationality|ethnic\w*|immigra\w*|citizen\w*|sex|gender|pregnan\w*|disab\w*|handicap\w*|wheelchair|familial|children|kids|married|marital|age|elderly|senior)\b'

def load_qualifier(errs):
    if not os.path.exists(QF): return None
    try: return json.load(open(QF, encoding='utf-8'))
    except Exception as e: errs.append(f'content/forms/qualifier.json: {e}'); return None

def check_qualifier(q):
    E, src = [], 'content/forms/qualifier.json'
    if q is None: return E
    L = list('EMOTA')
    Q = {x.get('id'): x for x in q.get('questions', [])}
    if len(Q) != len(q.get('questions', [])): E.append(f'{src}: duplicate or missing question id')
    ends, cats, res = q.get('endings', {}), q.get('categories', {}), q.get('result', {})
    if q.get('start') not in Q: E.append(f'{src}: start "{q.get("start")}" is not a question')
    for l in L:
        if l not in cats: E.append(f'{src}: categories is missing EMOTA letter {l}')
        if not any(x.get('category') == l for x in Q.values()): E.append(f'{src}: no question asks about {l} ({cats.get(l, "?")}). All 5 EMOTA categories need one')
    if 'tiers' in q: E.append(f'{src}: "tiers" is a v1 key and is no longer used. Use result.all_pass / result.any_fail')
    for l in list(cats):
        n = sum(1 for x in Q.values() if x.get('category') == l)
        if n > 1: E.append(f'{src}: {n} questions in category {l}. Keep it to one tap per step: merge them into one question')
    ap, af = res.get('all_pass', {}), res.get('any_fail', {})
    for k, r in (('all_pass', ap), ('any_fail', af)):
        if r.get('ending') not in ends: E.append(f'{src}: result.{k} ending "{r.get("ending")}" does not exist')
        if not r.get('tier') or not r.get('cadence'): E.append(f'{src}: result.{k} needs tier and cadence')
    if not af.get('fail_tag'): E.append(f'{src}: result.any_fail needs fail_tag (e.g. "emota-fail-")')
    for k, e in ends.items():
        if not e.get('headline'): E.append(f'{src}: ending {k} needs a headline')
        if k != ap.get('ending') and e.get('conversion', 'none') != 'none':
            E.append(f'{src}: ending "{k}" has conversion "{e.get("conversion")}". Only the all-pass ending may fire an Ads conversion')
        if k not in (ap.get('ending'), af.get('ending')) and (not e.get('tier') or not e.get('cadence')): E.append(f'{src}: ending {k} needs its own tier and cadence')
    def targets(x):
        if not x.get('options'): E.append(f'{src}: question {x.get("id")} has no options'); return []
        return [(o.get('next'), o) for o in x['options']]
    for x in Q.values():
        c = x.get('category')
        if not x.get('label'): E.append(f'{src}: question {x.get("id")} needs a label')
        if c not in cats: E.append(f'{src}: question {x.get("id")} needs a category ({", ".join(cats) or "E/M/O/T/A"})')
        for k in ('points', 'force_tier'):
            if k in x: E.append(f'{src}: question {x.get("id")}: "{k}" is a v1 key and is no longer used. Use pass on its answers')
        for nx, o in targets(x):
            if not o.get('label') or not o.get('value'): E.append(f'{src}: {x["id"]}: every option needs label and value')
            p = o.get('pass')
            if c in L and p is None and not (isinstance(nx, str) and nx.startswith('@')) and nx in Q and Q[nx].get('category') == c: pass
            elif c in L and p is None: E.append(f'{src}: {x["id"]}/{o.get("value")}: EMOTA answers need pass: true/false')
            if c not in L and p is not None: E.append(f'{src}: {x["id"]}: {c} questions are gates, not scored. Remove pass')
            if isinstance(p, dict) and not p: E.append(f'{src}: {x["id"]}/{o.get("value")}: pass {{}} is empty')
            elif isinstance(p, dict) and c in L and c not in p: E.append(f'{src}: {x["id"]}/{o.get("value")}: pass must include its own letter {c}')
            for k in ('points', 'force_tier'):
                if k in o: E.append(f'{src}: {x["id"]}/{o.get("value")}: "{k}" is a v1 key and is no longer used. Use pass')
            if isinstance(p, dict) and any(k not in L or not isinstance(v, bool) for k, v in p.items()): E.append(f'{src}: {x["id"]}/{o.get("value")}: pass must be true/false or {{"E": true, ...}}')
            elif p is not None and not isinstance(p, (bool, dict)): E.append(f'{src}: {x["id"]}/{o.get("value")}: pass must be true/false')
            if nx == '@score': continue
            if isinstance(nx, str) and nx.startswith('@end:'):
                if nx[5:] not in ends: E.append(f'{src}: {x["id"]}: ending "{nx[5:]}" does not exist (dead end)')
                elif nx[5:] != 'not_fit': E.append(f'{src}: {x["id"]}: next "{nx}" is not allowed. Only @end:not_fit can stop the form; every other result must come from @score')
                continue
            if nx not in Q: E.append(f'{src}: {x["id"]}: next "{nx}" goes nowhere (dead end)')
    # walk every path: no loops, and every path that is graded must have answered all 5 letters
    bad = set()
    def walk(qid, seen, got, depth=0):
        if qid in seen: E.append(f'{src}: loop: ' + ' -> '.join(seen + [qid])); return
        if qid not in Q or depth > 60: return
        g = got | ({Q[qid].get('category')} & set(L))
        for nx, o in targets(Q[qid]):
            if nx == '@score':
                miss = [l for l in L if l not in g]
                if miss: bad.add(f'{src}: a path reaches @score via {qid} without asking {"".join(miss)}')
            elif isinstance(nx, str) and nx.startswith('@end:'): pass
            else: walk(nx, seen + [qid], g, depth + 1)
    if q.get('start') in Q: walk(q['start'], [], set())
    E += sorted(bad)
    seen_ids = set()
    def reach(qid):
        if qid in seen_ids or qid not in Q: return
        seen_ids.add(qid); [reach(nx) for nx, _ in targets(Q[qid])]
    reach(q.get('start'))
    for k in Q:
        if k not in seen_ids: E.append(f'{src}: question {k} can never be reached')
    words = ' '.join([x.get('label', '') for x in Q.values()] + [o.get('label', '') for x in Q.values() for o in x.get('options', [])] + [e.get('headline', '') + ' ' + e.get('body', '') for e in ends.values()])
    for w in sorted(set(m.group(0).lower() for m in re.finditer(PROTECTED, words, re.I))):
        E.append(f'{src}: Fair Housing: wording mentions "{w}". Ask about the property and situation, never protected classes')
    c = q.get('consent', {})
    if not isinstance(c.get('enabled'), bool) or not c.get('field'): E.append(f'{src}: consent needs enabled (true/false) and field')
    if c.get('enabled') and (not c.get('text') or 'PLACEHOLDER' in c.get('text', '')): E.append(f'{src}: consent is on but the wording is still a placeholder')
    if os.path.getsize(QF) > 20000: E.append(f'{src}: over the 20 KB size limit')
    qjs = os.path.join(B, 'qualifier.js')
    if os.path.getsize(qjs) > MAX_QJS: E.append(f'build/qualifier.js: {os.path.getsize(qjs)} bytes is over the {MAX_QJS} byte budget')
    return E

def check_draft(src, obj, E):
    if 'draft' not in obj: return
    if obj.get('draft') is not True:
        E.append(f'{src}: draft must be true; omit the key when the page is published (never write draft: false)')

def check_seo(src, obj, titles, W):
    title, desc = obj.get('title'), obj.get('meta_description')
    if isinstance(title, str) and title:
        if len(title) > 60: W.append(f'{src}: title is {len(title)} characters (keep it to 60)')
        titles.setdefault(title, []).append(src)
    if isinstance(desc, str) and len(desc) > 155: W.append(f'{src}: meta_description is {len(desc)} characters (keep it to 155)')
    if obj.get('og_title') is not None and (not isinstance(obj.get('og_title'), str) or not obj.get('og_title').strip()):
        W.append(f'{src}: og_title is set but empty')
    can = obj.get('canonical')
    if can is not None and (not isinstance(can, str) or not can.startswith('https://')):
        return f'{src}: canonical must be an absolute https URL'
    return None

def check_form1(site, E):
    src = 'content/site.json'
    fields = site.get('form1_fields')
    if not isinstance(fields, list) or not fields:
        E.append(f'{src}: form1_fields must be a non-empty list'); return
    names = []
    for i, x in enumerate(fields):
        if not isinstance(x, dict):
            E.append(f'{src}: form1_fields[{i}] must be an object'); continue
        name = x.get('name')
        if not isinstance(name, str) or not re.fullmatch(r'[a-z][a-z0-9_]*', name):
            E.append(f'{src}: form1_fields[{i}] name must be a lowercase identifier')
        elif name in names:
            E.append(f'{src}: form1_fields duplicate name "{name}"')
        else:
            names.append(name)
        if not x.get('label'): E.append(f'{src}: form1_fields {name or i} needs a label')
        if x.get('type') not in ('text', 'tel', 'email'): E.append(f'{src}: form1_fields {name or i} type must be text, tel, or email')
        if type(x.get('required')) is not bool: E.append(f'{src}: form1_fields {name or i} required must be true or false')
        if type(x.get('step')) is not int or x.get('step') not in (1, 2): E.append(f'{src}: form1_fields {name or i} step must be 1 or 2')
        if 'pair' in x and (not isinstance(x.get('pair'), str) or not x.get('pair').strip()):
            E.append(f'{src}: form1_fields {name or i} pair must be a non-empty string')
    for name, step in FORM1_NAMES.items():
        hit = next((x for x in fields if isinstance(x, dict) and x.get('name') == name), None)
        if not hit: E.append(f'{src}: form1_fields is missing "{name}" (the hero form hands it to step 2)')
        elif hit.get('step') != step: E.append(f'{src}: form1_fields {name} must be step {step}')
    i = 0
    seen_pairs = set()
    while i < len(fields):
        x = fields[i] if isinstance(fields[i], dict) else {}
        pair = x.get('pair')
        if not pair:
            i += 1; continue
        nxt = fields[i + 1] if i + 1 < len(fields) and isinstance(fields[i + 1], dict) else {}
        if nxt.get('pair') != pair or (i + 2 < len(fields) and isinstance(fields[i + 2], dict) and fields[i + 2].get('pair') == pair):
            E.append(f'{src}: form1_fields pair "{pair}" must be exactly two consecutive fields'); break
        if pair in seen_pairs: E.append(f'{src}: form1_fields pair "{pair}" is used twice')
        seen_pairs.add(pair)
        if x.get('step') != nxt.get('step'): E.append(f'{src}: form1_fields pair "{pair}" must share a step')
        i += 2

def check_reviews(site, E):
    rows = site.get('reviews', [])
    if rows is None: return
    if not isinstance(rows, list):
        E.append('content/site.json: reviews must be a list'); return
    for i, t in enumerate(rows):
        if not isinstance(t, dict) or not t.get('quote') or not t.get('name') or not t.get('source') or not t.get('date'):
            E.append(f'content/site.json: reviews[{i}] needs quote, name, source, and date')

def check_media(site, pages, markets, E, W):
    media = site.get('_media')
    if media is None: return
    by_file, src = {}, 'content/media/media.json'
    for i, item in enumerate(media):
        if not isinstance(item, dict):
            E.append(f'{src}: item {i} must be an object'); continue
        name = item.get('file')
        if not isinstance(name, str) or '/' in name or '\\' in name or not name.lower().endswith('.webp'):
            E.append(f'{src}: item {i} file must be a .webp basename (no folders)'); name = None
        elif name in by_file:
            E.append(f'{src}: duplicate file "{name}"')
        else:
            path = os.path.join(C, 'media', name)
            if not os.path.isfile(path): E.append(f'{src}: {name} is not in content/media/')
            by_file[name] = item
        label = name or f'item {i}'
        if not pos_int(item.get('width')): E.append(f'{src}: {label} needs a positive integer width')
        if not pos_int(item.get('height')): E.append(f'{src}: {label} needs a positive integer height')
        alt = item.get('alt')
        if not isinstance(alt, str) or not alt.strip(): W.append(f'{src}: {label} is missing alt')
    domain = str(site.get('domain') or '')
    refs = {}  # basename -> [labels]
    def add(label, url):
        name = local_image_name(url, domain)
        if not name or name == 'favicon.png': return
        refs.setdefault(name, []).append(label)
    add('content/site.json logo', site.get('logo'))
    blobs = []
    walk_text({k: v for k, v in site.items() if not str(k).startswith('_')}, blobs)
    for m in markets: walk_text(m, blobs)
    for p in pages: walk_text(p.get('body') or '', blobs)
    for text in blobs:
        for m in IMG_SRC.finditer(text):
            add('content image', m.group(2))
    for p in pages:
        if p.get('og_image'): add(p['_src'] + ' og_image', p['og_image'])
    for mkt in markets:
        if mkt.get('og_image'): add(mkt['_src'] + ' og_image', mkt['og_image'])
    if site.get('og_image'): add('content/site.json og_image', site.get('og_image'))
    missing = set()
    for name, labels in refs.items():
        if name not in by_file:
            missing.add(name)
            where = ', '.join(labels[:4])
            E.append(f'{src}: missing entry for referenced image "{name}" ({where})')
    for fp in glob.glob(os.path.join(C, 'media', '*.webp')):
        n = os.path.basename(fp)
        if n not in by_file and n not in missing:
            W.append(f'content/media/{n}: not listed in media.json')

def check(site, pages, markets, redirects, errs):
    E = list(errs) + check_qualifier(site.get('_qualifier'))
    W = []
    for k in ['company', 'phone', 'tel', 'domain', 'brand', 'nav', 'footer', 'trust_badges', 'faq', 'situations', 'steps', 'comparison', 'testimonials', 'cta']:
        if k not in site: E.append(f'content/site.json: missing "{k}"')
    for c in ('orange', 'navy'):
        if not re.fullmatch(r'#[0-9A-Fa-f]{6}', str(site.get('brand', {}).get(c, ''))): E.append(f'content/site.json: brand.{c} must be #RRGGBB')
    if not re.fullmatch(r'\+1\d{10}', str(site.get('tel', ''))): E.append('content/site.json: tel must be +1XXXXXXXXXX')
    lf = site.get('lead_form') or {}
    if isinstance(lf, dict):
        for label in ('endpoint', 'endpoint_planned'):
            val = str(lf.get(label) or '')
            if not val: continue
            if not (val.startswith('/.netlify/functions/') or val.startswith('https://')):
                E.append(f'content/site.json: lead_form.{label} must be a /.netlify/functions/ path or https URL')
            if re.search(r'token|secret|key=', val, re.I) or '@' in val:
                E.append(f'content/site.json: lead_form.{label} must not include credentials')
    for f in site.get('faq', []):
        if not f.get('q') or not f.get('a'): E.append('content/site.json: faq item needs q and a')
    check_form1(site, E)
    check_reviews(site, E)
    slugs, titles = {}, {}
    for p in pages:
        for k in ('title', 'template'):
            if not p.get(k): E.append(f'{p["_src"]}: missing "{k}"')
        if 'meta_description' not in p: E.append(f'{p["_src"]}: missing "meta_description"')
        if p.get('template') not in TEMPLATES - {'market'}: E.append(f'{p["_src"]}: template must be home|situation|basic (markets live in content/markets/)')
        if p.get('template') in ('home', 'situation'):
            for k in ('hero_headline', 'hero_sub'):
                if not p.get(k): E.append(f'{p["_src"]}: template {p["template"]} needs "{k}"')
        if not isinstance(p.get('noindex', False), bool): E.append(f'{p["_src"]}: noindex must be true/false')
        check_draft(p['_src'], p, E)
        if p.get('draft') is True and p['slug'] == '':
            E.append(f'{p["_src"]}: home page cannot be draft; the site would have no index')
        bad_can = check_seo(p['_src'], p, titles, W)
        if bad_can: E.append(bad_can)
        for f in p.get('faq') or []:
            if not isinstance(f, dict) or not f.get('q') or not f.get('a'): E.append(f'{p["_src"]}: faq items need q and a')
        if not re.fullmatch(r'[a-z0-9-]*', p['slug']): E.append(f'{p["_src"]}: bad slug "{p["slug"]}"')
        slugs.setdefault(p['slug'], []).append(p['_src'])
    for m in markets:
        for k in ('state', 'slug', 'title', 'meta_description', 'headline', 'hero_sub'):
            if not m.get(k): E.append(f'{m["_src"]}: missing "{k}"')
        if not isinstance(m.get('cities', []), list): E.append(f'{m["_src"]}: cities must be a list')
        for t in m.get('testimonials', []):
            if not t.get('quote') or not t.get('name'): E.append(f'{m["_src"]}: testimonials need quote and name')
        check_draft(m['_src'], m, E)
        bad_can = check_seo(m['_src'], m, titles, W)
        if bad_can: E.append(bad_can)
        slugs.setdefault(m.get('slug', ''), []).append(m['_src'])
    for s, srcs in slugs.items():
        if len(srcs) > 1: E.append(f'duplicate slug "/{s}/": ' + ', '.join(srcs))
    for r in redirects:
        if not str(r.get('from', '')).startswith('/') or not str(r.get('to', '')).startswith('/'): E.append(f'content/redirects.json: bad entry {r}')
        if r.get('code') not in (301, 302): E.append(f'content/redirects.json: code must be 301 or 302: {r}')
        if r.get('from', '').strip('/') in slugs: E.append(f'content/redirects.json: {r["from"]} redirects away from a live page')
    for fp in glob.glob(os.path.join(C, 'media', '*')):
        if not os.path.isfile(fp): continue
        n = os.path.basename(fp)
        if n == 'media.json': continue
        sz = os.path.getsize(fp)
        if sz > MAX_IMG: E.append(f'content/media/{n}: {sz//1024} KB is over the 200 KB limit')
        if not n.lower().endswith('.webp') and n != 'favicon.png': E.append(f'content/media/{n}: images must be .webp (favicon.png is the only exception)')
    check_media(site, pages, markets, E, W)
    for title, srcs in titles.items():
        if len(srcs) > 1: W.append('duplicate title "%s": %s' % (title, ', '.join(srcs)))
    return E, W

# ---------- rendering ----------
def build(site, pages, markets, redirects, live):
    S = site; PH, TEL = S['phone'], S['tel']; preview = S.get('preview', True) and not live
    include_drafts = show_drafts(S, live)
    media_idx = {it['file']: it for it in (S.get('_media') or []) if isinstance(it, dict) and it.get('file')}
    logo_info = media_idx.get(os.path.basename(str(S.get('logo') or '')))
    logo_alt = esc(logo_info['alt']) if logo_info and isinstance(logo_info.get('alt'), str) and logo_info['alt'].strip() else S['company_html']
    lead_on = S.get('lead_form', {}).get('enabled', False)
    CSS = open(os.path.join(B, 'style.css'), encoding='utf-8').read().replace('{{orange}}', S['brand']['orange']).replace('{{navy}}', S['brand']['navy'])
    JS = open(os.path.join(B, 'app.js'), encoding='utf-8').read().strip()
    JS = re.sub(r'var FSHO=\{endpoint:"[^"]*"', 'var FSHO={endpoint:"%s"' % (S['lead_form'].get('endpoint', '') if lead_on else ''), JS)
    JS = re.sub(r'tracking:(true|false)', 'tracking:' + ('true' if S.get('tracking') else 'false'), JS)
    JS = re.sub(r'gtm:"[^"]*",clickcease:""', 'gtm:"%s",clickcease:"%s"' % (S.get('gtm_id', ''), S.get('clickcease_id', '')), JS)
    if not lead_on and not preview:
        JS = 'document.addEventListener("submit",function(e){e.preventDefault();e.stopImmediatePropagation();alert("Preview only, forms are off. Nothing was sent.")},true);' + JS
    navl = ''.join(f'<a href="{n["href"]}">{n["label"]}</a>' for n in S['nav'])
    trust = '<ul class="trust">' + ''.join(f'<li>{t}</li>' for t in S['trust_badges']) + '</ul>'
    QC = S.get('_qualifier') or {}
    def consent_box():
        c = QC.get('consent', {})
        if not c.get('enabled'): return ''
        return f'<label class="chk"><input type="checkbox" name="consent"{" required" if c.get("required") else ""}> <small>{c["text"]} <a href="/text-messaging-terms/">Text Terms</a> · <a href="/privacy/">Privacy</a></small></label>'
    def qualifier_form():
        cfg = {k: QC[k] for k in ('id', 'version', 'start', 'result', 'endings') if k in QC}
        cfg['questions'] = [{k: v for k, v in x.items() if not k.startswith('_')} for x in QC['questions']]
        cfg['consent'] = {k: QC['consent'][k] for k in ('enabled', 'field', 'text')}
        qjs = open(os.path.join(B, 'qualifier.js'), encoding='utf-8').read().strip()
        data = json.dumps(cfg, separators=(',', ':'), ensure_ascii=False).replace('</', '<\\/')
        return (f'<div class="lead qf" id="qf">{honeypot()}<div class="qbar" role="progressbar" aria-label="Progress"><i></i></div><div class="qbox" aria-live="polite">'
                f'<noscript><p>Please call or text <a href="tel:{TEL}">{PH}</a> and we\'ll finish this together.</p></noscript></div>'
                f'<p class="fine">Prefer to talk? Call/text <a href="tel:{TEL}">{PH}</a></p></div>'
                f'<script type="application/json" id="qcfg">{data}</script><script>{qjs}</script>')
    def honeypot():
        return '<div class="hp" aria-hidden="true"><label>Company website<input name="company_website" tabindex="-1" autocomplete="off"></label></div>'
    def field_html(x):
        attrs = [f'name="{x["name"]}"', f'type="{x["type"]}"']
        if x.get('autocomplete'): attrs.append(f'autocomplete="{esc(x["autocomplete"])}"')
        if x.get('placeholder'): attrs.append(f'placeholder="{esc(x["placeholder"])}"')
        if x.get('required'): attrs.append('required')
        return f'<label>{x["label"]}<input {" ".join(attrs)}></label>'
    def fields_html(xs):
        out, i = [], 0
        while i < len(xs):
            pair = xs[i].get('pair')
            if pair and i + 1 < len(xs) and xs[i + 1].get('pair') == pair:
                out.append('<div class="row">' + field_html(xs[i]) + field_html(xs[i + 1]) + '</div>'); i += 2
            else:
                out.append(field_html(xs[i])); i += 1
        return ''.join(out)
    def form():
        fields = S.get('form1_fields') or []
        s1 = fields_html([x for x in fields if x.get('step') == 1])
        s2 = fields_html([x for x in fields if x.get('step') == 2])
        return f'''<form class="lead" id="f" action="/step-2/" method="post" novalidate>
<div class="lead-h"><strong>Get your fair cash offer</strong><span>Takes about 60 seconds. No obligation.</span></div>
<ol class="steps-ind"><li class="on">1. Property</li><li>2. Contact</li></ol>
<input type="hidden" name="gclid"><input type="hidden" name="utm_campaign"><input type="hidden" name="utm_term"><input type="hidden" name="utm_source"><input type="hidden" name="utm_medium"><input type="hidden" name="form_id" value="1">{honeypot()}<fieldset class="s1">{s1}
<button type="button" class="btn btn-o nx">Get My Offer &rarr;</button></fieldset>
<fieldset class="s2" hidden>{s2}
{consent_box()}
<button class="btn btn-o">Send Me My Offer</button><button type="button" class="bk">&larr; Back</button></fieldset>
<p class="fine">🔒 Your info stays private. Or call/text <a href="tel:{TEL}">{PH}</a></p></form>'''
    def step2():
        f = ''
        for x in S['step2_fields']:
            if x['type'] == 'select': f += f'<label>{x["label"]}<select name="{x["name"]}"><option value="">Choose…</option>' + ''.join(f'<option>{o}</option>' for o in x['options']) + '</select></label>\n'
            else: f += f'<label>{x["label"]}<textarea name="{x["name"]}" rows="3"></textarea></label>\n'
        return ('<form class="lead step2" action="/thank-you/" method="post" novalidate><input type="hidden" name="form_id" value="6"><input type="hidden" name="address"><input type="hidden" name="phone"><input type="hidden" name="email">' + honeypot() + '\n'
                '<div class="lead-h"><strong>Almost done: tell us about the house</strong><span>Optional details help us make a more accurate offer faster.</span></div>\n'
                + f + f'<button class="btn btn-o">Submit Details</button><p class="fine">Prefer to talk? Call/text <a href="tel:{TEL}">{PH}</a></p></form>')
    def testis(lst): return ''.join(f'<blockquote class="testi">“{t["quote"]}”<cite>{t["name"]}</cite></blockquote>' for t in lst)
    def reviewsh(lst):
        bits = []
        for t in lst:
            cite = t['name']
            extra = ' · '.join(x for x in (t.get('source'), t.get('date')) if x)
            if extra: cite += ' · ' + extra
            bits.append(f'<blockquote class="testi">“{t["quote"]}”<cite>{cite}</cite></blockquote>')
        return ''.join(bits)
    def faqh(items, n=99): return '<div class="faq">' + ''.join(f'<details><summary>{f["q"]}</summary><p>{f["a"]}</p></details>' for f in items[:n]) + '</div>'
    def cta(h=None):
        c = S['cta']; return f'<section class="band"><div class="wrap"><h2>{h or c["heading"]}</h2><p>{c["text"]}</p><a class="btn btn-o" href="#offer">{c["button"]}</a> <a class="btn btn-w" href="tel:{TEL}">Call {PH}</a></div></section>'
    def hero(h, sub): return f'<section class="hero" id="offer"><div class="wrap hg"><div><p class="eyebrow">{S["hero_eyebrow"]}</p><h1>{h}</h1><p class="lede">{sub}</p>{trust}</div>{form()}</div></section>'
    sits = '<div class="grid3">' + ''.join(f'<div class="card"><div class="ic">{x["icon"]}</div><h3>{x["title"]}</h3><p>{x["text"]}</p></div>' for x in S['situations']) + '</div>'
    steps = '<div class="grid3 steps">' + ''.join(f'<div class="card"><b>{x["n"]}</b><h3>{x["title"]}</h3><p>{x["text"]}</p></div>' for x in S['steps']) + '</div>'
    cp = S['comparison']
    comp = ('<div class="tbl"><table><thead><tr><th></th>' + ''.join(f'<th{" class=\"us\"" if i == 0 else ""}>{h}</th>' for i, h in enumerate(cp['headers'])) + '</tr></thead><tbody>\n'
            + ''.join(f'<tr><td>{r[0]}</td><td class="us">{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td></tr>\n' for r in cp['rows']) + f'</tbody></table><p class="fine">{cp["note"]}</p></div>')
    vids = '<div class="grid3">' + ''.join(f'<button class="vid" data-yt="{v}" aria-label="Play seller video testimonial"><img loading="lazy" decoding="async" src="https://i.ytimg.com/vi_webp/{v}/hqdefault.webp" alt="" width="480" height="360"><span>▶</span></button>' for v in S['video_ids']) + '</div>'
    shown_markets = [m for m in markets if include_drafts or not m.get('draft')]
    states = '<div class="states">' + ''.join(f'<a href="/{m["slug"]}/">{m["state"]}</a>' for m in shown_markets) + '</div>'

    def shortcodes(body, faq_items, cta_label=None):
        def rep(m):
            k, _, arg = m.group(1).partition(':')
            if k == 'qualifier': return f'<div class="qual">{S["qualifier"]}</div>'
            if k == 'situations': return sits
            if k == 'steps': return steps
            if k == 'comparison': return comp
            if k == 'videos': return vids
            if k == 'testimonials': return testis(S['testimonials'])
            if k == 'reviews': return reviewsh(S.get('reviews') or [])
            if k == 'trust': return trust
            if k == 'faq': return faqh(faq_items, int(arg) if arg else 99)
            if k == 'cta': return cta(arg or cta_label or None)
            if k == 'states': return states
            if k == 'step2_form': return step2()
            if k == 'qualifier_form': return qualifier_form()
            if k == 'phone': return PH
            raise ValueError(f'unknown shortcode {{{{{k}}}}}')
        return re.sub(r'\{\{([a-z0-9_]+(?::[^}]*)?)\}\}', rep, body)

    def md(body):
        out = []
        for blk in re.split(r'\n\s*\n', body.strip()):
            b = blk.strip()
            if not b: continue
            if b.startswith('<') or b.startswith('{{'): out.append(b); continue
            if b.startswith('#'):
                lvl = len(b) - len(b.lstrip('#')); out.append(f'<h{lvl}>{inline(b[lvl:].strip())}</h{lvl}>'); continue
            lines = b.split('\n')
            if all(l.lstrip().startswith(('- ', '* ')) for l in lines):
                out.append('<ul class="ck">' + ''.join(f'<li>{inline(l.lstrip()[2:])}</li>' for l in lines) + '</ul>'); continue
            out.append(f'<p>{inline(" ".join(lines))}</p>')
        return ''.join(out)
    def inline(t):
        t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
        t = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', t)
        return t

    if os.path.isdir(OUT): shutil.rmtree(OUT)
    os.makedirs(OUT)
    def abs_url(src):
        if not src: return ''
        if src.startswith('http://') or src.startswith('https://'): return src
        if not src.startswith('/'): src = '/' + src
        return S['domain'] + src
    def page(path, title, desc, body, noindex, canonical=None, og_title=None, og_image=None, faq_ld=None, file_rel=None, offer_href='#offer'):
        canon = canonical or (S['domain'] + path)
        robots = '<meta name="robots" content="noindex,nofollow">' if (preview or noindex) else ''
        banner = '<div style="background:#c00;color:#fff;text-align:center;font:700 13px system-ui;padding:4px">PREVIEW: not the live site. Form data is only logged, never sent.</div>' if preview else ''
        ot = og_title or title
        og = [f'<meta property="og:title" content="{esc(ot)}">', f'<meta property="og:description" content="{esc(desc)}">',
              f'<meta property="og:url" content="{esc(canon)}">', '<meta property="og:type" content="website">',
              f'<meta property="og:site_name" content="{esc(S["company"])}">']
        card = 'summary'
        if og_image:
            img = abs_url(og_image)
            og += [f'<meta property="og:image" content="{esc(img)}">', f'<meta name="twitter:image" content="{esc(img)}">']
            card = 'summary_large_image'
        og += [f'<meta name="twitter:card" content="{card}">', f'<meta name="twitter:title" content="{esc(ot)}">', f'<meta name="twitter:description" content="{esc(desc)}">']
        scripts = ld_script({"@context": "https://schema.org", "@type": "RealEstateAgent", "name": S["company"], "legalName": S["legal_name"], "telephone": TEL, "url": S["domain"] + "/", "logo": S["domain"] + S["logo"]})
        if faq_ld:
            scripts += ld_script({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
                {"@type": "Question", "name": html.unescape(f["q"]), "acceptedAnswer": {"@type": "Answer", "text": html.unescape(f["a"])}} for f in faq_ld]})
        doc = f'''<!doctype html><html lang="en"><head>{robots}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(title)}</title><meta name="description" content="{esc(desc)}"><link rel="icon" href="/favicon.png"><link rel="canonical" href="{esc(canon)}">{''.join(og)}<style>{CSS}</style>
{scripts}</head><body>{banner}
<header class="top"><div class="wrap hd"><a href="/" class="logo"><img src="{S["logo"]}" alt="{logo_alt}" fetchpriority="high"></a><nav>{navl}</nav><a class="btn btn-call" href="tel:{TEL}">📞 {PH}</a></div></header>
<main>{body}</main>
<footer class="ft"><div class="wrap fg"><div><img src="{S["logo"]}" alt="" class="inv" loading="lazy"><p>{S["footer"]["about"]}</p><p><a href="tel:{TEL}">{PH}</a> · call or text</p></div>
<div><strong>Company</strong>{navl}{''.join(f'<a href="{n["href"]}">{n["label"]}</a>' for n in S["footer"]["company_extra"])}</div>
<div><strong>Legal</strong>{''.join(f'<a href="{n["href"]}">{n["label"]}</a>' for n in S["footer"]["legal"])}</div></div><p class="wrap copy">{S["footer"]["copyright"]}</p></footer>
<a class="sticky" href="tel:{TEL}">📞 Call Now</a><a class="sticky s2b" href="{offer_href}">Get Offer</a>
<script>{JS}</script></body></html>'''
        rel = file_rel or ('index.html' if path == '/' else path.strip('/') + '/index.html')
        dest = os.path.join(OUT, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        open(dest, 'w', encoding='utf-8').write(decorate_imgs(doc, media_idx))

    urls, built, skipped, drafts_in = [], 0, 0, 0
    for p in pages:
        if p.get('draft') and not include_drafts:
            skipped += 1; continue
        if p.get('draft'): drafts_in += 1
        path = f'/{p["slug"]}/' if p['slug'] else '/'
        file_rel, offer = None, '#offer'
        if p['slug'] == '404':
            path, file_rel, offer = '/404.html', '404.html', '/#offer'
        faq_items = p.get('faq') or S['faq']
        body = md(shortcodes(p['body'], faq_items, p.get('cta_label')))
        if p['template'] in ('home', 'situation'): body = hero(p['hero_headline'], p['hero_sub']) + body
        page(path, p['title'], p.get('meta_description') or '', body, bool(p.get('noindex', False) or p.get('draft')),
             canonical=p.get('canonical') or None, og_title=p.get('og_title') or None, og_image=p.get('og_image') or None,
             faq_ld=faq_ld_items(p.get('body'), p.get('faq'), S.get('faq')), file_rel=file_rel, offer_href=offer)
        built += 1
        if p.get('sitemap', True) and not p.get('noindex') and not p.get('draft') and p['slug'] != '404': urls.append('/' if not p['slug'] else f'/{p["slug"]}/')
    for m in markets:
        if m.get('draft') and not include_drafts:
            skipped += 1; continue
        if m.get('draft'): drafts_in += 1
        s = m['state']; path = f'/{m["slug"]}/'
        cities = ('<p class="c">Cities we buy in: ' + ', '.join(m['cities']) + '</p>') if m.get('cities') else ''
        local = m.get('local_note') or f'[PLACEHOLDER: add a real {s} deal / local market note, if one exists.]'
        body = (hero(m['headline'], m['hero_sub']) + f'<section class="wrap pad"><div class="qual">{S["qualifier"]}</div><h2 class="c">Common reasons {s} homeowners call us</h2>{sits}{cities}</section>'
                + f'<section class="alt"><div class="wrap pad"><h2 class="c">How it works in {s}</h2>{steps}</div></section>'
                + f'<section class="wrap pad">{testis(m.get("testimonials") or S["testimonials"])}<div class="ph">{local}</div></section>' + cta(m.get('cta_label')))
        page(path, m['title'], m['meta_description'], body, bool(m.get('noindex', False) or m.get('draft')),
             canonical=m.get('canonical') or None, og_title=m.get('og_title') or None, og_image=m.get('og_image') or None)
        built += 1
        if not m.get('noindex') and not m.get('draft'): urls.append(path)

    # redirects: Netlify _redirects + Apache/nginx copies + meta-refresh stubs
    R = [(r['from'], r['to'], r.get('code', 301)) for r in redirects]
    not_found = '/* /404.html 404\n' if os.path.isfile(os.path.join(OUT, '404.html')) else ''
    open(os.path.join(OUT, '_redirects'), 'w').write('# Netlify / Cloudflare Pages: permanent 301s\n' + ''.join(f'{a} {b} {c}!\n{a.rstrip("/")} {b} {c}!\n' for a, b, c in R) + ('# Unknown paths\n' + not_found if not_found else ''))
    open(os.path.join(OUT, '.htaccess'), 'w').write('# Apache\n' + ''.join(f'Redirect {c} {a} {b}\n' for a, b, c in R) + ('ErrorDocument 404 /404.html\n' if not_found else ''))
    open(os.path.join(OUT, 'redirects.conf'), 'w').write('# nginx (include in server block)\n' + ''.join(f'location = {a} {{ return {c} {b}; }}\n' for a, b, c in R) + ('error_page 404 /404.html;\n' if not_found else ''))
    for a, b, c in R:
        d = OUT + a; os.makedirs(d, exist_ok=True)
        open(d + 'index.html', 'w').write(f'<!doctype html><meta charset=utf-8><title>Moved</title><meta name=robots content=noindex><link rel=canonical href="{b}"><meta http-equiv=refresh content="0;url={b}"><a href="{b}">Moved here</a>')
    order = ['/', '/how-it-works/', '/our-company/', '/reviews/', '/faq/', '/contact-us/', '/stop-foreclosure/', '/service-areas/', '/privacy/', '/terms-conditions/', '/text-messaging-terms/']
    urls = sorted(urls, key=lambda u: (order.index(u) if u in order else len(order)))
    open(os.path.join(OUT, 'sitemap.xml'), 'w').write('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + ''.join(f'<url><loc>{S["domain"]}{u}</loc></url>' for u in urls) + '</urlset>')
    if preview:
        open(os.path.join(OUT, 'robots.txt'), 'w').write('User-agent: *\nDisallow: /\n')
        open(os.path.join(OUT, '_headers'), 'w').write('/*\n  X-Robots-Tag: noindex, nofollow\n')
    else:
        open(os.path.join(OUT, 'robots.txt'), 'w').write(f'User-agent: *\nDisallow: /step-2/\nDisallow: /thank-you/\nSitemap: {S["domain"]}/sitemap.xml\n')
    for fp in glob.glob(os.path.join(C, 'media', '*')):
        if os.path.basename(fp) == 'media.json': continue
        shutil.copy(fp, OUT)
    return built, skipped, drafts_in

if __name__ == '__main__':
    site, pages, markets, redirects, errs = load_all()
    E, W = check(site, pages, markets, redirects, errs)
    if W: print('\n'.join('WARN ' + w for w in W))
    if E:
        print('\n'.join('ERROR ' + e for e in E)); sys.exit(1)
    if '--check' in sys.argv:
        print(f'OK: {len(pages)} pages, {len(markets)} markets, {len(redirects)} redirects'); sys.exit(0)
    n, skipped, drafts_in = build(site, pages, markets, redirects, '--live' in sys.argv)
    note = '' if '--live' in sys.argv or not site.get('preview', True) else ' (PREVIEW: noindex, banner on)'
    if skipped: note += f' (skipped {skipped} drafts)'
    elif drafts_in: note += f' ({drafts_in} drafts included)'
    print(f'built {n} pages + {len(redirects)} redirects into dist/' + note)
