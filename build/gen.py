#!/usr/bin/env python3
"""FSHO static site generator. Reads content/, writes dist/.
Usage: python build/gen.py            build into dist/
       python build/gen.py --check    validate content only (non-zero exit on errors)
       python build/gen.py --live     build without preview guards (noindex/banner/form lock) -- cutover only
"""
import os, re, sys, json, glob, shutil

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

def load_page(fp):
    raw = open(fp, encoding='utf-8').read()
    m = re.match(r'^---\n(.*?)\n---\n?(.*)$', raw, re.S)
    if not m: raise ValueError('missing YAML frontmatter')
    fm = parse_frontmatter(m.group(1))
    fm.setdefault('slug', os.path.splitext(os.path.basename(fp))[0])
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

def check(site, pages, markets, redirects, errs):
    E = list(errs) + check_qualifier(site.get('_qualifier'))
    for k in ['company', 'phone', 'tel', 'domain', 'brand', 'nav', 'footer', 'trust_badges', 'faq', 'situations', 'steps', 'comparison', 'testimonials', 'cta']:
        if k not in site: E.append(f'content/site.json: missing "{k}"')
    for c in ('orange', 'navy'):
        if not re.fullmatch(r'#[0-9A-Fa-f]{6}', str(site.get('brand', {}).get(c, ''))): E.append(f'content/site.json: brand.{c} must be #RRGGBB')
    if not re.fullmatch(r'\+1\d{10}', str(site.get('tel', ''))): E.append('content/site.json: tel must be +1XXXXXXXXXX')
    for f in site.get('faq', []):
        if not f.get('q') or not f.get('a'): E.append('content/site.json: faq item needs q and a')
    slugs = {}
    for p in pages:
        for k in ('title', 'template'):
            if not p.get(k): E.append(f'{p["_src"]}: missing "{k}"')
        if 'meta_description' not in p: E.append(f'{p["_src"]}: missing "meta_description"')
        if p.get('template') not in TEMPLATES - {'market'}: E.append(f'{p["_src"]}: template must be home|situation|basic (markets live in content/markets/)')
        if p.get('template') in ('home', 'situation'):
            for k in ('hero_headline', 'hero_sub'):
                if not p.get(k): E.append(f'{p["_src"]}: template {p["template"]} needs "{k}"')
        if not isinstance(p.get('noindex', False), bool): E.append(f'{p["_src"]}: noindex must be true/false')
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
        slugs.setdefault(m.get('slug', ''), []).append(m['_src'])
    for s, srcs in slugs.items():
        if len(srcs) > 1: E.append(f'duplicate slug "/{s}/": ' + ', '.join(srcs))
    for r in redirects:
        if not str(r.get('from', '')).startswith('/') or not str(r.get('to', '')).startswith('/'): E.append(f'content/redirects.json: bad entry {r}')
        if r.get('code') not in (301, 302): E.append(f'content/redirects.json: code must be 301 or 302: {r}')
        if r.get('from', '').strip('/') in slugs: E.append(f'content/redirects.json: {r["from"]} redirects away from a live page')
    for fp in glob.glob(os.path.join(C, 'media', '*')):
        n = os.path.basename(fp); sz = os.path.getsize(fp)
        if sz > MAX_IMG: E.append(f'content/media/{n}: {sz//1024} KB is over the 200 KB limit')
        if not n.lower().endswith('.webp') and n != 'favicon.png': E.append(f'content/media/{n}: images must be .webp')
    return E

# ---------- rendering ----------
def build(site, pages, markets, redirects, live):
    S = site; PH, TEL = S['phone'], S['tel']; preview = S.get('preview', True) and not live
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
        return (f'<div class="lead qf" id="qf"><div class="qbar" role="progressbar" aria-label="Progress"><i></i></div><div class="qbox" aria-live="polite">'
                f'<noscript><p>Please call or text <a href="tel:{TEL}">{PH}</a> and we\'ll finish this together.</p></noscript></div>'
                f'<p class="fine">Prefer to talk? Call/text <a href="tel:{TEL}">{PH}</a></p></div>'
                f'<script type="application/json" id="qcfg">{data}</script><script>{qjs}</script>')
    def form():
        return f'''<form class="lead" id="f" action="/step-2/" method="post" novalidate>
<div class="lead-h"><strong>Get your fair cash offer</strong><span>Takes about 60 seconds. No obligation.</span></div>
<ol class="steps-ind"><li class="on">1. Property</li><li>2. Contact</li></ol>
<input type="hidden" name="gclid"><input type="hidden" name="utm_campaign"><input type="hidden" name="utm_term"><input type="hidden" name="utm_source"><input type="hidden" name="utm_medium"><input type="hidden" name="form_id" value="1"><fieldset class="s1"><label>Property address<input name="address" autocomplete="street-address" placeholder="123 Main St, City, State" required></label>
<button type="button" class="btn btn-o nx">Get My Offer &rarr;</button></fieldset>
<fieldset class="s2" hidden><div class="row"><label>First name<input name="first" autocomplete="given-name" required></label><label>Last name<input name="last" autocomplete="family-name"></label></div>
<label>Phone<input name="phone" type="tel" autocomplete="tel" required></label><label>Email<input name="email" type="email" autocomplete="email" required></label>
{consent_box()}
<button class="btn btn-o">Send Me My Offer</button><button type="button" class="bk">&larr; Back</button></fieldset>
<p class="fine">🔒 Your info stays private. Or call/text <a href="tel:{TEL}">{PH}</a></p></form>'''
    def step2():
        f = ''
        for x in S['step2_fields']:
            if x['type'] == 'select': f += f'<label>{x["label"]}<select name="{x["name"]}"><option value="">Choose…</option>' + ''.join(f'<option>{o}</option>' for o in x['options']) + '</select></label>\n'
            else: f += f'<label>{x["label"]}<textarea name="{x["name"]}" rows="3"></textarea></label>\n'
        return ('<form class="lead step2" action="/thank-you/" method="post" novalidate><input type="hidden" name="form_id" value="6"><input type="hidden" name="address"><input type="hidden" name="phone"><input type="hidden" name="email">\n'
                '<div class="lead-h"><strong>Almost done: tell us about the house</strong><span>Optional details help us make a more accurate offer faster.</span></div>\n'
                + f + f'<button class="btn btn-o">Submit Details</button><p class="fine">Prefer to talk? Call/text <a href="tel:{TEL}">{PH}</a></p></form>')
    def testis(lst): return ''.join(f'<blockquote class="testi">“{t["quote"]}”<cite>{t["name"]}</cite></blockquote>' for t in lst)
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
    states = '<div class="states">' + ''.join(f'<a href="/{m["slug"]}/">{m["state"]}</a>' for m in markets) + '</div>'

    def shortcodes(body, faq_items):
        def rep(m):
            k, _, arg = m.group(1).partition(':')
            if k == 'qualifier': return f'<div class="qual">{S["qualifier"]}</div>'
            if k == 'situations': return sits
            if k == 'steps': return steps
            if k == 'comparison': return comp
            if k == 'videos': return vids
            if k == 'testimonials': return testis(S['testimonials'])
            if k == 'trust': return trust
            if k == 'faq': return faqh(faq_items, int(arg) if arg else 99)
            if k == 'cta': return cta(arg or None)
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
    def page(path, title, desc, body, noindex):
        robots = '<meta name="robots" content="noindex,nofollow">' if (preview or noindex) else ''
        banner = '<div style="background:#c00;color:#fff;text-align:center;font:700 13px system-ui;padding:4px">PREVIEW: not the live site. Form data is only logged, never sent.</div>' if preview else ''
        doc = f'''<!doctype html><html lang="en"><head>{robots}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><meta name="description" content="{desc}"><link rel="icon" href="/favicon.png"><link rel="canonical" href="{S["domain"]}{path}"><style>{CSS}</style>

<script type="application/ld+json">{{"@context":"https://schema.org","@type":"RealEstateAgent","name":"{S["company"]}","legalName":"{S["legal_name"]}","telephone":"{TEL}","url":"{S["domain"]}/","logo":"{S["domain"]}{S["logo"]}"}}</script></head><body>{banner}
<header class="top"><div class="wrap hd"><a href="/" class="logo"><img src="{S["logo"]}" alt="{S["company_html"]}" width="160" height="61" fetchpriority="high"></a><nav>{navl}</nav><a class="btn btn-call" href="tel:{TEL}">📞 {PH}</a></div></header>
<main>{body}</main>
<footer class="ft"><div class="wrap fg"><div><img src="{S["logo"]}" alt="" width="150" height="57" class="inv" loading="lazy"><p>{S["footer"]["about"]}</p><p><a href="tel:{TEL}">{PH}</a> · call or text</p></div>
<div><strong>Company</strong>{navl}{''.join(f'<a href="{n["href"]}">{n["label"]}</a>' for n in S["footer"]["company_extra"])}</div>
<div><strong>Legal</strong>{''.join(f'<a href="{n["href"]}">{n["label"]}</a>' for n in S["footer"]["legal"])}</div></div><p class="wrap copy">{S["footer"]["copyright"]}</p></footer>
<a class="sticky" href="tel:{TEL}">📞 Call Now</a><a class="sticky s2b" href="#offer">Get Offer</a>
<script>{JS}</script></body></html>'''
        d = os.path.join(OUT, path.strip('/')); os.makedirs(d, exist_ok=True)
        open(os.path.join(d, 'index.html'), 'w', encoding='utf-8').write(doc)

    urls = []
    for p in pages:
        path = f'/{p["slug"]}/' if p['slug'] else '/'
        faq_items = p.get('faq') or S['faq']
        body = md(shortcodes(p['body'], faq_items))
        if p['template'] in ('home', 'situation'): body = hero(p['hero_headline'], p['hero_sub']) + body
        page(path, p['title'], p.get('meta_description') or '', body, p.get('noindex', False))
        if p.get('sitemap', True) and not p.get('noindex'): urls.append(path)
    for m in markets:
        s = m['state']; path = f'/{m["slug"]}/'
        cities = ('<p class="c">Cities we buy in: ' + ', '.join(m['cities']) + '</p>') if m.get('cities') else ''
        local = m.get('local_note') or f'[PLACEHOLDER: add a real {s} deal / local market note, if one exists.]'
        body = (hero(m['headline'], m['hero_sub']) + f'<section class="wrap pad"><div class="qual">{S["qualifier"]}</div><h2 class="c">Common reasons {s} homeowners call us</h2>{sits}{cities}</section>'
                + f'<section class="alt"><div class="wrap pad"><h2 class="c">How it works in {s}</h2>{steps}</div></section>'
                + f'<section class="wrap pad">{testis(m.get("testimonials") or S["testimonials"])}<div class="ph">{local}</div></section>' + cta(m.get('cta_label')))
        page(path, m['title'], m['meta_description'], body, m.get('noindex', False))
        if not m.get('noindex'): urls.append(path)

    # redirects: Netlify _redirects + Apache/nginx copies + meta-refresh stubs
    R = [(r['from'], r['to'], r.get('code', 301)) for r in redirects]
    open(os.path.join(OUT, '_redirects'), 'w').write('# Netlify / Cloudflare Pages: permanent 301s\n' + ''.join(f'{a} {b} {c}!\n{a.rstrip("/")} {b} {c}!\n' for a, b, c in R))
    open(os.path.join(OUT, '.htaccess'), 'w').write('# Apache\n' + ''.join(f'Redirect {c} {a} {b}\n' for a, b, c in R))
    open(os.path.join(OUT, 'redirects.conf'), 'w').write('# nginx (include in server block)\n' + ''.join(f'location = {a} {{ return {c} {b}; }}\n' for a, b, c in R))
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
        shutil.copy(fp, OUT)
    return len(pages) + len(markets)

if __name__ == '__main__':
    site, pages, markets, redirects, errs = load_all()
    E = check(site, pages, markets, redirects, errs)
    if E:
        print('\n'.join('ERROR ' + e for e in E)); sys.exit(1)
    if '--check' in sys.argv:
        print(f'OK: {len(pages)} pages, {len(markets)} markets, {len(redirects)} redirects'); sys.exit(0)
    n = build(site, pages, markets, redirects, '--live' in sys.argv)
    print(f'built {n} pages + {len(redirects)} redirects into dist/' + ('' if '--live' in sys.argv or not site.get('preview', True) else ' (PREVIEW: noindex, banner on)'))
