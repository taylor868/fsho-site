#!/usr/bin/env python3
"""FSHO static site generator. Reads content/, writes dist/.
Usage: python build/gen.py            build into dist/
       python build/gen.py --check    validate content only (non-zero exit on errors; WARN lines do not fail)
       python build/gen.py --live     force a build without preview guards when site.json preview is still true

Preview guards (noindex, the PREVIEW banner, robots.txt Disallow: /, and X-Robots-Tag)
follow content/site.json "preview". Netlify production runs `python3 build/gen.py` with
no --live flag, so a public build requires "preview": false in that file.

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
# Stay out of sitemap.xml even if noindex or sitemap frontmatter changes.
# Absolute URLs use site.json "domain" (the canonical origin). Never a deploy or preview hostname.
SITEMAP_SKIP = {'test-intake', 'step-2', 'thank-you'}

def esc(s):
    return str(s).replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;').replace('>', '&gt;')

def link_preview(s):
    """Unfurl tags use the word and, so a pasted link never shows the characters &amp;."""
    return re.sub(r'\s{2,}', ' ', re.sub(r'\s*&\s*', ' and ', str(s or ''))).strip()

def pos_int(v):
    return type(v) is int and v > 0

def deploy_context(live):
    """Baked into the test page. Production cannot be overridden by a query string."""
    if live or os.environ.get('CONTEXT') == 'production':
        return 'production'
    ctx = os.environ.get('CONTEXT', '')
    if ctx in ('deploy-preview', 'branch-deploy', 'dev'):
        return ctx
    if not ctx:
        return 'local'
    return 'denied'

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

# Dashed [F]/[C] notes and blank strings are not answers. A question that has nothing else is left off /faq/.
_PLACEHOLDER_ANSWER = re.compile(r'placeholder,\s*waiting|\[(?:F/C|F|C)\]|not confirmed:', re.I)

def is_placeholder_answer(text):
    raw = html.unescape(re.sub(r'<[^>]+>', ' ', text or ''))
    raw = re.sub(r'\s+', ' ', raw).strip()
    if not raw:
        return True
    return bool(_PLACEHOLDER_ANSWER.search(raw))

def answer_markup(text):
    text = (text or '').strip()
    if not text:
        return ''
    if text.startswith('<'):
        return text
    return '<p>' + html.escape(text, quote=False) + '</p>'

def faq_item_html(item, answers):
    """Confirmed copy, plus one faq_answers string when that string is a real answer."""
    parts = []
    base = item.get('a') or ''
    if not is_placeholder_answer(base):
        parts.append(answer_markup(base))
    aid = item.get('answer_id') or ''
    extra = answers.get(aid, '') if aid else ''
    if isinstance(extra, str) and not is_placeholder_answer(extra):
        parts.append(answer_markup(extra))
    return ''.join(parts)

def render_faq_page(site):
    """Grouped /faq/ body. Unanswered slots in faq_answers are omitted, not rendered as notes."""
    page = site.get('faq_page') or {}
    answers = site.get('faq_answers') or {}
    visible = []
    for group in page.get('groups') or []:
        items = []
        for item in group.get('items') or []:
            body = faq_item_html(item, answers)
            if item.get('q') and body:
                items.append((item['q'], body))
        if items:
            visible.append((group, items))
    blocks = []
    if page.get('reviewed'):
        blocks.append(f'<p class="fine reviewed">{page["reviewed"]}</p>')
    blocks.append('<nav class="faq-toc" aria-label="FAQ sections">' + ''.join(
        f'<a href="#{g["id"]}">{g["title"]}</a>' for g, _items in visible) + '</nav>')
    for group, items in visible:
        details = ''.join(f'<details><summary>{q}</summary>{a}</details>' for q, a in items)
        blocks.append(f'<h2 id="{group["id"]}">{group["title"]}</h2><div class="faq">{details}</div>')
    return ''.join(blocks)

def faq_details(body):
    items = []
    for q, inner in re.findall(r'<details><summary>(.*?)</summary>(.*?)</details>', body or '', re.S):
        qtext = html.unescape(re.sub(r'<[^>]+>', '', q)).strip()
        atext = html.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', inner)))
        atext = re.sub(r'\s+([.,;:])', r'\1', atext).strip()
        if qtext and atext and not is_placeholder_answer(atext):
            items.append({'q': qtext, 'a': atext})
    return items

def faq_ld_items(rendered, own, source_body, slug):
    """FAQPage JSON-LD for /faq/ from the details that shipped, and for a page with its own faq.
    The shared FAQ is not repeated on the homepage, how-it-works, stop-foreclosure, or state pages.
    Ad landing pages keep the faq in their frontmatter, so they still get the schema."""
    if slug == 'faq':
        return faq_details(rendered)
    items = [f for f in (own or []) if isinstance(f, dict) and f.get('q') and f.get('a') and not is_placeholder_answer(f.get('a'))]
    if not items:
        return []
    renders = re.findall(r'\{\{faq(?::(\d+))?\}\}', source_body or '')
    if renders and all(n for n in renders):
        items = items[:max(int(n) for n in renders)]
    return items

def check_faq_content(site, E):
    answers = site.get('faq_answers')
    page = site.get('faq_page')
    if not isinstance(answers, dict):
        E.append('content/site.json: faq_answers must be an object of answer strings')
        answers = {}
    else:
        for key, val in answers.items():
            if not re.fullmatch(r'faq_[a-z0-9_]+', str(key)) or not isinstance(val, str):
                E.append(f'content/site.json: faq_answers.{key} must be a faq_* string')
    if not isinstance(page, dict) or not isinstance(page.get('groups'), list) or not page.get('groups'):
        E.append('content/site.json: faq_page.groups must be a non-empty list')
        return
    seen = set()
    for group in page['groups']:
        gid = group.get('id') if isinstance(group, dict) else ''
        if not isinstance(group, dict) or not gid or not group.get('title') or not isinstance(group.get('items'), list):
            E.append('content/site.json: each faq_page group needs id, title, and items')
            continue
        for item in group['items']:
            if not isinstance(item, dict) or not item.get('q'):
                E.append(f'content/site.json: faq_page {gid} item needs q')
                continue
            aid = item.get('answer_id') or ''
            if aid:
                if aid in seen:
                    E.append(f'content/site.json: duplicate faq answer id {aid}')
                seen.add(aid)
                if aid not in answers:
                    E.append(f'content/site.json: {aid} is missing from faq_answers')
            elif is_placeholder_answer(item.get('a') or ''):
                E.append(f'content/site.json: faq question has no publishable answer and no answer_id ({item.get("q")})')
    for key in answers:
        if key not in seen:
            E.append(f'content/site.json: faq_answers.{key} is not used by a question')

def ld_script(obj):
    raw = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    return '<script type="application/ld+json">' + raw + '</script>'

# Official WhatConverts standard snippet (Tracking > Tracking Code), profile 176490.
# The inline script is copied as WhatConverts ships it so the landing URL and referrer
# are snapshotted while the HTML parses. defer on the profile file keeps 176490.js off
# the first-paint path; it still runs after that snapshot.
WC_PROFILE = '176490'
WC_HOST = '//s.ksrndkehqnwntyxlhgto.com'
WC_INIT_JS = (
    'var $wc_load=function(a){return JSON.parse(JSON.stringify(a))},'
    '$wc_leads=$wc_leads||{doc:{url:$wc_load(document.URL),ref:$wc_load(document.referrer),'
    'search:$wc_load(location.search),hash:$wc_load(location.hash)}};'
)

def check_whatconverts(site, E):
    wc = site.get('whatconverts')
    src = 'content/site.json'
    if not isinstance(wc, dict):
        E.append(f'{src}: missing "whatconverts" object')
        return
    if not isinstance(wc.get('enabled'), bool):
        E.append(f'{src}: whatconverts.enabled must be true or false')
    if wc.get('profile_id') != WC_PROFILE:
        E.append(f'{src}: whatconverts.profile_id must be {WC_PROFILE}')
    if wc.get('script_host') != WC_HOST:
        E.append(f'{src}: whatconverts.script_host must be {WC_HOST}')

def whatconverts_snippet(site):
    """Empty unless the official profile is explicitly enabled. Never emits another host or id."""
    wc = site.get('whatconverts')
    if not isinstance(wc, dict) or wc.get('enabled') is not True:
        return ''
    if wc.get('profile_id') != WC_PROFILE or wc.get('script_host') != WC_HOST:
        return ''
    return '<script>' + WC_INIT_JS + '</script><script src="' + WC_HOST + '/' + WC_PROFILE + '.js" defer></script>'

# Approved pixels. IDs are locked. tracking stays false so the footer demo does not
# load a second gtm.js or stat.js. cccontrack.js is not in the head: it records a
# conversion when it loads. pixels.js injects it after a reserved public completion.
GTM_ID = 'GTM-WWPBQGDZ'
ADS_CALL_SEND_TO = 'AW-16781895992/YrLzCKa9g4sdELjSncI-'
META_PIXEL_ID = '959620977142967'
OPENAI_PIXEL_ID = 'AMsRexCaeaxScDiV9SGJcP'
OPENAI_SRC = 'https://bzrcdn.openai.com/sdk/oaiq.min.js'
CC_PRECONNECT = 'https://www.clickcease.com'
CC_DNS = '//www.clickcease.com'
CC_MONITOR = 'https://www.clickcease.com/monitor/stat.js'
CC_CONVERSION = 'https://www.clickcease.com/monitor/cccontrack.js'
CC_STATS_IMG = 'https://monitor.clickcease.com/stats/stats.aspx'

def check_pixels(site, E):
    src = 'content/site.json'
    px = site.get('pixels')
    if not isinstance(px, dict):
        E.append(f'{src}: missing "pixels" object')
        return
    if not isinstance(px.get('enabled'), bool):
        E.append(f'{src}: pixels.enabled must be true or false')
    if site.get('gtm_id') != GTM_ID:
        E.append(f'{src}: gtm_id must be {GTM_ID}')
    if px.get('gtm_id') != GTM_ID:
        E.append(f'{src}: pixels.gtm_id must be {GTM_ID}')
    if px.get('ads_call_send_to') != ADS_CALL_SEND_TO:
        E.append(f'{src}: pixels.ads_call_send_to must be {ADS_CALL_SEND_TO}')
    if px.get('meta_pixel_id') != META_PIXEL_ID:
        E.append(f'{src}: pixels.meta_pixel_id must be {META_PIXEL_ID}')
    if px.get('openai_pixel_id') != OPENAI_PIXEL_ID:
        E.append(f'{src}: pixels.openai_pixel_id must be {OPENAI_PIXEL_ID}')

def pixels_on(site):
    px = site.get('pixels')
    if not isinstance(px, dict) or px.get('enabled') is not True:
        return False
    if site.get('gtm_id') != GTM_ID or px.get('gtm_id') != GTM_ID:
        return False
    if px.get('ads_call_send_to') != ADS_CALL_SEND_TO:
        return False
    if px.get('meta_pixel_id') != META_PIXEL_ID or px.get('openai_pixel_id') != OPENAI_PIXEL_ID:
        return False
    return True

def clickcease_visitor():
    return (
        '<script>var script=document.createElement("script");'
        'script.async=true;script.type="text/javascript";'
        'var target="' + CC_MONITOR + '";'
        'script.src=target;var elem=document.head;elem.appendChild(script);'
        '</script>'
        '<noscript><a href="https://www.clickcease.com" rel="nofollow">'
        '<img src="' + CC_STATS_IMG + '" alt="ClickCease"></a></noscript>'
    )

def meta_pixel(pid):
    return (
        "<script>!function(f,b,e,v,n,t,s)"
        "{if(f.fbq)return;n=f.fbq=function(){n.callMethod?"
        "n.callMethod.apply(n,arguments):n.queue.push(arguments)};"
        "if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';"
        "n.queue=[];t=b.createElement(e);t.async=!0;"
        "t.src=v;s=b.getElementsByTagName(e)[0];"
        "s.parentNode.insertBefore(t,s)}(window,document,'script',"
        "'https://connect.facebook.net/en_US/fbevents.js');"
        "fbq('init', '" + pid + "');"
        "fbq('track', 'PageView');"
        "</script>"
        '<noscript><img height="1" width="1" style="display:none" alt="" '
        'src="https://www.facebook.com/tr?id=' + pid + '&amp;ev=PageView&amp;noscript=1"></noscript>'
    )

def openai_pixel(pid):
    return (
        '<script>(function(w,d,s,u){'
        'if(w.oaiq)return;'
        'var q=function(){q.q.push(arguments)};'
        'q.q=[];w.oaiq=q;'
        'var js=d.createElement(s);js.async=true;js.src=u;'
        'var f=d.getElementsByTagName(s)[0];'
        'f.parentNode.insertBefore(js,f);'
        '})(window,document,"script","' + OPENAI_SRC + '");'
        'oaiq("init", { pixelId: "' + pid + '" });'
        '</script>'
    )

def approved_head(site):
    """ClickCease visitor, Meta PageView, and OpenAI init. No conversion on parse."""
    if not pixels_on(site):
        return ''
    px = site['pixels']
    return (
        '<link rel="preconnect" href="' + CC_PRECONNECT + '">'
        '<link rel="dns-prefetch" href="' + CC_DNS + '">'
        + clickcease_visitor()
        + meta_pixel(px['meta_pixel_id'])
        + openai_pixel(px['openai_pixel_id'])
    )

def gtm_noscript(site):
    if not pixels_on(site):
        return ''
    return (
        '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id='
        + site['gtm_id']
        + '" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>'
    )

def pixels_script(site):
    if not pixels_on(site):
        return ''
    px = site['pixels']
    cfg = json.dumps({
        'adsCallSendTo': px['ads_call_send_to'],
        'clickceaseConversion': CC_CONVERSION,
    }, separators=(',', ':'), ensure_ascii=True)
    src = open(os.path.join(B, 'pixels.js'), encoding='utf-8').read().strip().replace('</', '<\\/')
    return '<script>window.FSHO_PIXELS=' + cfg + ';\n' + src + '</script>'

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

def load_test_form_guard():
    fp = os.path.join(B, 'test_form_guard.json')
    data = json.load(open(fp, encoding='utf-8'))
    if not isinstance(data.get('patterns'), list) or not data['patterns']:
        raise ValueError('build/test_form_guard.json: patterns must be a non-empty list')
    return data['patterns']

def banned_test_form_hits(text):
    hits = []
    for item in load_test_form_guard():
        if re.search(item['re'], text or '', re.I):
            hits.append(item['id'])
    return hits

def test_form_sources():
    items = [('build/two-stage.js', open(os.path.join(B, 'two-stage.js'), encoding='utf-8').read())]
    page = os.path.join(C, 'pages', 'test-intake.md')
    if os.path.isfile(page):
        items.append((os.path.relpath(page, ROOT), open(page, encoding='utf-8').read()))
    src = open(os.path.join(B, 'gen.py'), encoding='utf-8').read()
    found = re.search(r'\n    def test_intake\(\):\n.*?\n    def qualifier_form\(\):', src, re.S)
    if not found:
        items.append(('build/gen.py test_intake()', ''))
    else:
        items.append(('build/gen.py test_intake()', found.group(0)))
    return items

def check_test_form(E):
    for label, text in test_form_sources():
        if label == 'build/gen.py test_intake()' and not text:
            E.append('build/gen.py: test_intake() source was not found for the copy check')
            continue
        for hit in banned_test_form_hits(text):
            E.append(f'{label}: banned test-form phrase ({hit})')

def guard_test_page():
    """Test intake only: transferred bytes and subresource count. Does not change other pages."""
    page_path = os.path.join(OUT, 'test-intake', 'index.html')
    if not os.path.isfile(page_path):
        return
    raw = open(page_path, encoding='utf-8').read()
    urls = set()
    for m in re.finditer(r'<(script|img|iframe|link)\b([^>]*)>', raw, re.I):
        tag, attrs = m.group(1).lower(), m.group(2)
        if tag == 'link':
            rel = re.search(r'\brel\s*=\s*"([^"]*)"', attrs, re.I)
            relv = (rel.group(1).lower() if rel else '').split()
            if 'icon' not in relv and 'stylesheet' not in relv:
                continue
        src = re.search(r'\b(?:src|href)\s*=\s*"([^"]+)"', attrs, re.I)
        if not src:
            continue
        url = src.group(1).strip()
        if not url or url.startswith(('#', 'data:', 'mailto:', 'tel:')):
            continue
        urls.add(url.split('#', 1)[0])
    total = os.path.getsize(page_path)
    for url in urls:
        if re.match(r'(?:https?:)?//', url):
            continue
        fp = os.path.join(OUT, url.lstrip('/'))
        if os.path.isfile(fp):
            total += os.path.getsize(fp)
    requests = 1 + len(urls)
    if total > 100 * 1024 or requests >= 10:
        raise SystemExit(f'test-intake budget: {total} bytes, {requests} requests (limit 100KB and under 10 requests)')

def check(site, pages, markets, redirects, errs):
    E = list(errs) + check_qualifier(site.get('_qualifier'))
    W = []
    for k in ['company', 'phone', 'tel', 'domain', 'brand', 'nav', 'footer', 'trust_badges', 'faq', 'situations', 'steps', 'comparison', 'testimonials', 'cta']:
        if k not in site: E.append(f'content/site.json: missing "{k}"')
    check_whatconverts(site, E)
    check_pixels(site, E)
    for c in ('orange', 'navy'):
        if not re.fullmatch(r'#[0-9A-Fa-f]{6}', str(site.get('brand', {}).get(c, ''))): E.append(f'content/site.json: brand.{c} must be #RRGGBB')
    if not re.fullmatch(r'\+1\d{10}', str(site.get('tel', ''))): E.append('content/site.json: tel must be +1XXXXXXXXXX')
    consent = site.get('consent')
    if not isinstance(consent, str) or 'Consent isn\u2019t required to buy or sell' not in consent or 'msg &amp; data rates' not in consent:
        E.append('content/site.json: consent must keep the approved communication disclosure')
    for f in site.get('faq', []):
        if not isinstance(f, dict) or not f.get('q') or not f.get('a'): E.append('content/site.json: faq item needs q and a')
    check_faq_content(site, E)
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
    check_test_form(E)
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
        JS = 'document.addEventListener("submit",function(e){var t=e.target;if(!t||t.id==="ts-form")return;e.preventDefault();e.stopImmediatePropagation();alert("Preview only, forms are off. Nothing was sent.")},true);' + JS
    navl = ''.join(f'<a href="{n["href"]}">{n["label"]}</a>' for n in S['nav'])
    def trust_list(items):
        # Official logo links share one centered row. Each text chip is its own
        # centered row, so a wide hero column cannot sit a chip beside the logos.
        parts, logos = [], []
        def flush():
            if logos:
                parts.append('<li class="trust-logos">' + ''.join(logos) + '</li>')
                logos.clear()
        for t in items:
            if 'class="badge"' in t:
                logos.append(t)
            else:
                flush()
                parts.append(f'<li>{t}</li>')
        flush()
        return '<ul class="trust">' + ''.join(parts) + '</ul>'
    trust = trust_list(S['trust_badges'])
    QC = S.get('_qualifier') or {}
    def consent_box():
        c = QC.get('consent', {})
        if not c.get('enabled'): return ''
        return f'<label class="chk"><input type="checkbox" name="consent"{" required" if c.get("required") else ""}> <small>{c["text"]} <a href="/text-messaging-terms/">Text Terms</a> · <a href="/privacy/">Privacy</a></small></label>'
    def stage_boot(ctx, real_flag, src):
        return f'<script>window.FSHO_DEPLOY_CONTEXT="{ctx}";window.FSHO_USE_REAL_ADAPTER="{real_flag}";</script><script>{src}</script>'
    def consent_label():
        return (f'<label class="consent" data-consent-size="8"><input type="checkbox" name="consent">'
                f'<small>{S.get("consent") or ""} <a href="/text-messaging-terms/">Text Terms</a> · <a href="/privacy/">Privacy</a></small></label>')
    def two_stage_assets():
        ctx = deploy_context(live)
        real_flag = '1' if os.environ.get('FSHO_USE_REAL_ADAPTER') == '1' else ''
        src = re.sub(r'\n\s*\n', '\n', open(os.path.join(B, 'two-stage.js'), encoding='utf-8').read().strip()).replace('</', '<\\/')
        return ctx, real_flag, src
    def test_intake():
        ctx, real_flag, src = two_stage_assets()
        if ctx == 'production':
            return (
                '<section class="wrap pad" id="two-stage"><h1>This page isn\'t in use.</h1>'
                '<p>This page isn\'t used anymore. Call or text '
                f'<a href="tel:{TEL}">{PH}</a>, or <a href="/#offer">start the form on the homepage</a>.</p>'
                '<p class="fine">If you want an offer, use the homepage form or call us.</p></section>'
            )
        return (
            '<section class="wrap pad" id="two-stage"><h1>This page isn\'t in use.</h1>'
            '<p class="fine">Test mode only. Needs ?test=1. This page stays noindex.</p>'
            '<p id="ts-off" hidden>Test mode is off. Production builds cannot enable it, and other builds need ?test=1.</p>'
            '<div id="ts-app" hidden><form id="ts-form" action="#" method="post">'
            '<div class="lead-h"><strong>Stage 1</strong><span>Name, property, phone, and email. This only saves the info.</span></div>'
            '<label>Name<input name="name" autocomplete="name" required></label>'
            '<label>Property address<input name="address" autocomplete="street-address" required></label>'
            '<label>Phone<input name="phone" type="tel" autocomplete="tel" required></label>'
            '<label>Email<input name="email" type="email" autocomplete="email" required></label>'
            + consent_label() +
            '<button class="btn btn-o" type="submit">Save this info</button></form>'
            '<div id="ts-sorry"></div><div id="ts-followup"></div><div id="ts-thanks"></div><div id="ts-ask"></div>'
            '<h2 id="ts-trace-title">Step trace</h2><p id="ts-summary" data-google="not-loaded" data-downstream="" data-priority=""></p>'
            '<p id="ts-error" hidden role="alert"></p><p id="ts-events"></p><ol id="ts-trace"></ol></div>'
            '<style>'
            '#ts-app{max-width:32rem}'
            '#ts-form label{display:block;font-weight:700;font-size:14px;margin:14px 0 0;color:var(--n)}'
            '#ts-form input{display:block;width:100%;margin-top:6px;padding:14px 16px;border:1.5px solid #c8d1da;border-radius:12px;font-size:16px;background:#fff}'
            '#ts-form input:focus{outline:2px solid var(--o);border-color:var(--o)}'
            '#ts-form .btn{width:100%;margin-top:16px;min-height:48px}'
            '#ts-app h2{font-size:1.35rem;margin:18px 0 10px}'
            '#ts-app .qo{display:block;width:100%;text-align:left;margin:0 0 10px;min-height:48px;padding:14px 16px;border-radius:12px}'
            '#ts-abandon{display:block;width:100%;margin-top:4px;min-height:44px;font-weight:700}'
            '#ts-sorry:empty,#ts-followup:empty,#ts-thanks:empty{display:none}'
            '#ts-sorry,#ts-followup,#ts-thanks{border-radius:14px;padding:18px 16px;margin:8px 0 18px}'
            '#ts-sorry{background:#fff7f2;border-left:5px solid var(--o)}'
            '#ts-followup,#ts-thanks{background:#f4f8f4;border-left:5px solid var(--n)}'
            '#ts-sorry h2,#ts-followup h2,#ts-thanks h2{margin:0 0 8px}'
            '#ts-sorry p,#ts-followup p,#ts-thanks p{margin:0;font-size:17px;line-height:1.45}'
            '#ts-kicker{margin:8px 0 0;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#667}'
            '#ts-skip{display:block;width:100%;margin-top:4px;min-height:48px;border-radius:12px;border:1.5px solid #c8d1da;background:#fff;font-weight:800;font-size:16px;color:var(--n)}'
            '#ts-error{background:#fff1f0;border-radius:12px;padding:12px 14px;margin:8px 0;font-weight:700}'
            '#ts-app button:disabled,#ts-app input:disabled{opacity:.55}'
            '#ts-summary{font-size:15px;line-height:1.4}'
            '#ts-trace{margin:8px 0 0;padding-left:1.2em}'
            '#ts-trace li{margin:8px 0}'
            '#ts-form label.consent{display:flex;align-items:flex-start;gap:6px;margin:8px 0 0;padding:0;font-weight:400;font-size:8px;line-height:1.3;color:#667}'
            '#ts-form label.consent input{display:inline-block;width:12px;height:12px;min-height:0;margin:0;padding:0;border:0;border-radius:2px;flex:0 0 auto}'
            '#ts-form label.consent small{font-size:1em;line-height:1.3;font-weight:400;color:inherit}'
            '#ts-form label.consent a{color:#3d5166;font-weight:600;text-decoration:underline;text-underline-offset:1px}'
            '@media(max-width:860px){#two-stage{padding-bottom:104px}}'
            '</style>'
            f'{stage_boot(ctx, real_flag, src)}</section>'
        )
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
<input type="hidden" name="gclid"><input type="hidden" name="utm_campaign"><input type="hidden" name="utm_term"><input type="hidden" name="utm_source"><input type="hidden" name="utm_medium"><input type="hidden" name="form_id" value="1"><fieldset class="s1">{s1}
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
        return ('<form class="lead step2" action="/thank-you/" method="post" novalidate><input type="hidden" name="form_id" value="6"><input type="hidden" name="address"><input type="hidden" name="phone"><input type="hidden" name="email">\n'
                '<div class="lead-h"><strong>Almost done: tell us about the house</strong><span>Optional details help us make a more accurate offer faster.</span></div>\n'
                + f + f'<button class="btn btn-o">Submit Details</button><p class="fine">Prefer to talk? Call/text <a href="tel:{TEL}">{PH}</a></p></form>')
    def testis(lst):
        bits = []
        for t in lst:
            quote = t['quote']
            url = t.get('source_url') or ''
            if url:
                quote = f'<a href="{esc(url)}" target="_blank" rel="noopener noreferrer">{quote}</a>'
            bits.append(f'<blockquote class="testi">“{quote}”<cite>{t["name"]}</cite></blockquote>')
        return ''.join(bits)
    def reviewsh(lst):
        bits = []
        for t in lst:
            cite = t['name']
            extra = ' · '.join(x for x in (t.get('source'), t.get('date')) if x)
            if extra: cite += ' · ' + extra
            bits.append(f'<blockquote class="testi">“{t["quote"]}”<cite>{cite}</cite></blockquote>')
        return ''.join(bits)
    def faqh(items, n=99): return '<div class="faq">' + ''.join(f'<details><summary>{f["q"]}</summary><p>{f["a"]}</p></details>' for f in items[:n]) + '</div>'
    def cta(h=None, href='#offer'):
        # href is #offer on pages that render the hero form, and /#offer everywhere else.
        c = S['cta']; return f'<section class="band"><div class="wrap"><h2>{h or c["heading"]}</h2><p>{c["text"]}</p><a class="btn btn-o" href="{href}">{c["button"]}</a> <a class="btn btn-w" href="tel:{TEL}">Call {PH}</a></div></section>'
    def public_intake():
        ctx, real_flag, src = two_stage_assets()
        return (
            '<div class="lead" id="two-stage"><div id="ts-app" data-public="1"><form id="ts-form" action="#" method="post">'
            '<div class="lead-h"><strong>Get your fair cash offer</strong><span>Takes about 60 seconds. No obligation.</span></div>'
            '<label>Name<input name="name" autocomplete="name" required></label>'
            '<label>Property address<input name="address" autocomplete="street-address" required></label>'
            '<label>Phone<input name="phone" type="tel" autocomplete="tel" required></label>'
            '<label>Email<input name="email" type="email" autocomplete="email" required></label>'
            + consent_label() +
            '<button class="btn btn-o" type="submit">Get My Offer</button>'
            f'<p class="fine">Your info stays private. Or call/text <a href="tel:{TEL}">{PH}</a></p></form>'
            '<div id="ts-sorry"></div><div id="ts-followup"></div><div id="ts-thanks"></div><div id="ts-ask"></div>'
            '<p id="ts-error" hidden role="alert"></p>'
            '<h2 id="ts-trace-title" hidden>Step trace</h2>'
            '<p id="ts-summary" hidden data-google="not-loaded" data-downstream="" data-priority=""></p>'
            '<p id="ts-events" hidden></p><ol id="ts-trace" hidden></ol></div>'
            + stage_boot(ctx, real_flag, src) + '</div>'
        )
    def hero(h, sub, intake=False):
        panel = public_intake() if intake else form()
        return f'<section class="hero" id="offer"><div class="wrap hg"><div><p class="eyebrow">{S["hero_eyebrow"]}</p><h1>{h}</h1><p class="lede">{sub}</p>{trust}</div>{panel}</div></section>'
    sits = '<div class="grid3">' + ''.join(f'<div class="card"><div class="ic">{x["icon"]}</div><h3>{x["title"]}</h3><p>{x["text"]}</p></div>' for x in S['situations']) + '</div>'
    steps = '<div class="grid3 steps">' + ''.join(f'<div class="card"><b>{x["n"]}</b><h3>{x["title"]}</h3><p>{x["text"]}</p></div>' for x in S['steps']) + '</div>'
    cp = S['comparison']
    comp = ('<div class="tbl"><table><thead><tr><th></th>' + ''.join(f'<th{" class=\"us\"" if i == 0 else ""}>{h}</th>' for i, h in enumerate(cp['headers'])) + '</tr></thead><tbody>\n'
            + ''.join(f'<tr><td>{r[0]}</td><td class="us">{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td></tr>\n' for r in cp['rows']) + f'</tbody></table><p class="fine">{cp["note"]}</p></div>')
    vids = '<div class="grid3">' + ''.join(f'<button class="vid" data-yt="{v}" aria-label="Play seller video testimonial"><img loading="lazy" decoding="async" src="https://i.ytimg.com/vi_webp/{v}/hqdefault.webp" alt="" width="480" height="360"><span>▶</span></button>' for v in S['video_ids']) + '</div>'
    shown_markets = [m for m in markets if include_drafts or not m.get('draft')]
    states = '<div class="states">' + ''.join(f'<a href="/{m["slug"]}/">{m["state"]}</a>' for m in shown_markets) + '</div>'

    def shortcodes(body, faq_items, cta_label=None, offer_href='#offer'):
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
            if k == 'faq_page': return render_faq_page(S)
            if k == 'cta': return cta(arg or cta_label or None, offer_href)
            if k == 'states': return states
            if k == 'step2_form': return step2()
            if k == 'qualifier_form': return qualifier_form()
            if k == 'test_intake': return test_intake()
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
        title, desc, ot = link_preview(title), link_preview(desc), link_preview(og_title or title)
        site_name = link_preview(S['company'])
        og = [f'<meta property="og:title" content="{esc(ot)}">', f'<meta property="og:description" content="{esc(desc)}">',
              f'<meta property="og:url" content="{esc(canon)}">', '<meta property="og:type" content="website">',
              f'<meta property="og:site_name" content="{esc(site_name)}">']
        card = 'summary'
        if og_image:
            img = abs_url(og_image)
            og += [f'<meta property="og:image" content="{esc(img)}">', f'<meta name="twitter:image" content="{esc(img)}">']
            card = 'summary_large_image'
        og += [f'<meta name="twitter:card" content="{card}">', f'<meta name="twitter:title" content="{esc(ot)}">', f'<meta name="twitter:description" content="{esc(desc)}">']
        scripts = ld_script({"@context": "https://schema.org", "@type": "RealEstateAgent", "name": site_name, "legalName": S["legal_name"], "telephone": TEL, "url": S["domain"] + "/", "logo": S["domain"] + S["logo"]})
        if faq_ld:
            scripts += ld_script({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
                {"@type": "Question", "name": html.unescape(f["q"]), "acceptedAnswer": {"@type": "Answer", "text": html.unescape(f["a"])}} for f in faq_ld]})
        # /test-intake/ is the noindex harness, not a public page. Redirect stubs are written later and stay excluded.
        public = path.rstrip('/') != '/test-intake'
        wc = whatconverts_snippet(S) if public else ''
        extra = approved_head(S) if public else ''
        gtm_ns = gtm_noscript(S) if public else ''
        px = pixels_script(S) if public else ''
        doc = f'''<!doctype html><html lang="en"><head>{robots}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{wc}{extra}<title>{esc(title)}</title><meta name="description" content="{esc(desc)}"><link rel="icon" href="/favicon.png"><link rel="canonical" href="{esc(canon)}">{''.join(og)}<style>{CSS}</style>
{scripts}</head><body>{gtm_ns}{px}{banner}
<header class="top"><div class="wrap hd"><a href="/" class="logo"><img src="{S["logo"]}" alt="{logo_alt}" fetchpriority="high"></a><nav>{navl}</nav><a class="btn btn-call" href="tel:{TEL}">📞 {PH}</a></div><nav class="mnav" aria-label="Sections"><a href="/how-it-works/">How It Works</a><a href="/reviews/">Reviews</a><a href="/faq/">FAQ</a></nav></header>
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
        # Home and situation templates render the hero form (id="offer"). Basic pages do not,
        # so the cash-offer button and the sticky Get Offer control go to the homepage form.
        file_rel = None
        offer = '#offer' if p['template'] in ('home', 'situation') else '/#offer'
        if p['slug'] == '404':
            path, file_rel = '/404.html', '404.html'
        faq_items = p.get('faq') or S['faq']
        body = md(shortcodes(p['body'], faq_items, p.get('cta_label'), offer))
        if p['template'] in ('home', 'situation'):
            body = hero(p['hero_headline'], p['hero_sub'], intake=True) + body
        page(path, p['title'], p.get('meta_description') or '', body, bool(p.get('noindex', False) or p.get('draft')),
             canonical=p.get('canonical') or None, og_title=p.get('og_title') or None, og_image=p.get('og_image') or None,
             faq_ld=faq_ld_items(body, p.get('faq'), p.get('body'), p['slug']), file_rel=file_rel, offer_href=offer)
        built += 1
        if p.get('sitemap', True) and not p.get('noindex') and not p.get('draft') and p['slug'] not in SITEMAP_SKIP and p['slug'] != '404': urls.append('/' if not p['slug'] else f'/{p["slug"]}/')
    for m in markets:
        if m.get('draft') and not include_drafts:
            skipped += 1; continue
        if m.get('draft'): drafts_in += 1
        s = m['state']; path = f'/{m["slug"]}/'
        cities = ('<p class="c">Cities we buy in: ' + ', '.join(m['cities']) + '</p>') if m.get('cities') else ''
        note = (m.get('local_note') or '').strip()
        if note.startswith('[PLACEHOLDER'): note = ''
        local_html = f'<div class="ph">{note}</div>' if note else ''
        body = (hero(m['headline'], m['hero_sub'], intake=True) + f'<section class="wrap pad"><div class="qual">{S["qualifier"]}</div><h2 class="c">Common reasons {s} homeowners call us</h2>{sits}{cities}</section>'
                + f'<section class="alt"><div class="wrap pad"><h2 class="c">How it works in {s}</h2>{steps}<p class="c"><a href="/faq/">Questions about selling? Read the FAQ.</a></p></div></section>'
                + f'<section class="wrap pad">{testis(m.get("testimonials") or S["testimonials"])}{local_html}</section>' + cta(m.get('cta_label'), '#offer'))
        page(path, m['title'], m['meta_description'], body, bool(m.get('noindex', False) or m.get('draft')),
             canonical=m.get('canonical') or None, og_title=m.get('og_title') or None, og_image=m.get('og_image') or None,
             offer_href='#offer')
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
    guard_test_page()
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
