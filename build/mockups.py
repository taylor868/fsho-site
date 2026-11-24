"""Seller-personalization MOCKUPS (preview only, never production).

build_mockups() writes /mockups/ (index) and /mockups/seller/ (one page that demos all 7 ideas).
gen.py calls it only when deploy_context() is not 'production', so these pages can never ship
on fsho.co even if this file reaches main. Every page is noindex, loads no GTM / GA4 / WhatConverts /
Meta / OpenAI / ClickCease, and the form is a stub that sends nothing.

Content rules: no invented reviews, closings, stats, names or credentials. Anything that needs a
real fact is a visible [PLACEHOLDER: ...] for Andrew or Taylor to fill.
"""
import html, json, os

# Idea 1: intent buckets. Order matters: first match wins. 'generic' is the safe default.
BUCKETS = [
    {"id": "foreclosure", "label": "Behind on payments / foreclosure",
     "match": r"foreclos|behind on|missed (?:mortgage )?payment|late (?:mortgage )?payment|auction|sheriff|lender|notice of default|can.?t pay (?:my|the) mortgage",
     "h1": "Behind on payments? See your options while there is still time.",
     "sub": "Ask for a no-obligation cash offer, or just a straight answer about where you stand. No repairs, no commissions, no pressure. We are not your lender, and we are not attorneys."},
    {"id": "probate", "label": "Probate / inherited house",
     "match": r"probate|inherit|estate|executor|executrix|administrator|deceased|passed away|death in the family|heir",
     "h1": "Selling a house from an estate? We work around the court's timeline.",
     "sub": "Executors and heirs can ask for an as-is offer without clearing out the house first. We do not push a signature before the right person can sign."},
    {"id": "divorce", "label": "Divorce / separation",
     "match": r"divorc|separat|splitting up|ex.?(?:wife|husband|spouse)",
     "h1": "Selling the house in a divorce? One clear offer you can both look at.",
     "sub": "A private, as-is sale with no string of showings. We do not take sides, and we are not attorneys."},
    {"id": "landlord", "label": "Tired landlord / tenants",
     "match": r"landlord|tenant|rental|renter|evict|section 8|duplex|triplex|fourplex|multi.?family",
     "h1": "Done being a landlord? Ask about selling the rental as it is.",
     "sub": "You can ask while tenants still live there. We do not evict anyone or promise tenants will leave, and you do not have to fix the place first."},
    {"id": "repairs", "label": "Needs repairs / as-is",
     "match": r"repair|as.?is|fixer|damage|condition|ugly|mold|roof|foundation|fire|water damage|hoard|cleanout|clean out|outdated",
     "h1": "House needs work? Sell it as-is. No repairs, no cleaning.",
     "sub": "Leave the leak, the old kitchen and the boxes. Ask for a no-obligation offer on the house exactly as it sits today."},
    {"id": "relocation", "label": "Relocation / need to move",
     "match": r"relocat|moving|job transfer|transferr|military|pcs orders|out of state|downsiz|new job",
     "h1": "Moving soon? Sell on your timeline, not the market's.",
     "sub": "No showings to schedule around your packing. Ask for a no-obligation cash offer and pick a closing date that fits your move."},
    {"id": "generic", "label": "Default (no match)", "match": "",
     "h1": "Sell your house fast, for a fair cash offer, on your timeline.",
     "sub": "Get a no-obligation cash offer, or let us show you how to net more with a market sale. No repairs, no cleaning, no commissions. You choose."},
]

# Idea 2: situation stories. Tone matches the live situation pages: plain words, no legal advice, no promises.
STORIES = {
    "probate": {"title": "Handling a house in probate", "link": ["/selling-a-house-in-probate/", "Read the full probate page"],
        "lead": "You may be the executor, an heir, or the family member who ended up with the keys. The house may still be full. Nobody has to have every answer before calling.",
        "cards": [["We wait for the right signer", "If the court has not given someone authority yet, we can still talk about the house. We do not push anyone to sign early."],
                  ["Leave the belongings", "You can ask for an as-is offer without clearing out a lifetime of things first."],
                  ["The court can set the pace", "We do not promise a closing date when a court timeline is involved. You pick a date that works once you can."]],
        "faq": [["Can we talk before probate is finished?", "Yes. You can ask about the house and the options. Who can sign, and when, is a legal question for the estate's attorney or the court. We are not attorneys."],
                ["Do the heirs all need to agree?", "We need the person or people with authority to sell. We do not decide that, and we do not take sides between family members."],
                ["What if the house needs work or is still full?", "Tell us. You can ask for an offer on the house as it sits, belongings and all. There is no cost to ask and no obligation to accept."]]},
    "divorce": {"title": "Selling a house in a divorce", "link": ["/selling-a-house-in-divorce/", "Read the full divorce page"],
        "lead": "The house is often stuck in the middle. One person may still live there, repairs may have stopped, and nobody wants strangers walking through.",
        "cards": [["One number for both of you", "A single written offer you can both look at, with your own lawyers if you have them."],
                  ["Fewer people in the house", "A cash offer does not need a string of showings or open houses."],
                  ["We stay out of the split", "The title company handles closing. We do not decide who gets what."]],
        "faq": [["Do both of us have to agree?", "If more than one person has to sign, we need the people who can decide. That question belongs with your lawyers or the court."],
                ["Will a sale decide how the money is split?", "No. We do not split proceeds or predict what a court will order. We are not attorneys."],
                ["Can we sell as-is so neither of us manages repairs?", "Yes. You can ask for an offer on the house as it sits. No repairs and no cleaning are required to ask."]]},
    "foreclosure": {"title": "Behind on payments", "link": ["/stop-foreclosure/", "Read the foreclosure options page"],
        "lead": "Letters from the lender, calls you are avoiding, a date that feels like it is getting closer. It is more common than it feels, and there is no shame in it.",
        "cards": [["Call your lender too", "Ask about a repayment plan, forbearance or a loan modification. A sale is one option, not the only one."],
                  ["Free help exists", "HUD-approved housing counselors give free guidance and are not trying to buy your house: hud.gov/counseling."],
                  ["A straight answer on timing", "If a sale could help, we will tell you plainly whether there is enough time. Selling does not guarantee a foreclosure stops."]],
        "faq": [["Can selling stop the foreclosure?", "Often, if there is enough time and the numbers work. It is not a guarantee, and it does not promise anything about your credit. We are not attorneys."],
                ["Is it too late if I already have a sale date?", "Call or text us now so we can look at the dates together. For legal questions, talk with a foreclosure attorney."],
                ["Do I have to fix anything first?", "No. You can ask for an offer on the house as it is today."]]},
    "landlord": {"title": "Selling a rental, tenants and all", "link": ["/selling-a-house-with-tenants/", "Read the full tenants page"],
        "lead": "Late rent, a lease with months left, repairs you are tired of funding. You can want out of being a landlord without wanting a fight.",
        "cards": [["No need to empty it first", "You can ask about an occupied rental. Tell us who lives there and what you know about the lease."],
                  ["As-is includes the work", "Repairs you do not want to manage can stay as they are while you ask."],
                  ["What we buy", "Single-family houses and multi-family properties with 2 to 4 units, in the states on our service areas page."]],
        "faq": [["Will you evict the tenants?", "No. We do not evict tenants for you, and we do not promise they will move out. A sale does not, by itself, end a lease."],
                ["What if rent is behind?", "Tell us. We will not guess a rent number, and we will say if we are not the right fit."],
                ["Can I sell while the lease is still running?", "You can ask. For legal questions about the lease, talk with a lawyer. We are not attorneys or a property manager."]]},
    "repairs": {"title": "Selling a house that needs work", "link": ["/sell-your-house-as-is/", "Read the full as-is page"],
        "lead": "A bad roof, an old furnace, a room full of boxes. None of that has to become your project before you call.",
        "cards": [["No repair list", "You do not need a contractor or a punch list to start. Describe the condition in plain words."],
                  ["No cleaning day", "You do not have to empty the house or make it show-ready."],
                  ["Honest about price", "A cash offer is typically below full retail, because repairs, costs and risk move to us. We can also show you a market-sale path that may net more."]],
        "faq": [["Do I have to repair or clean before you look?", "No. You can ask for an offer with the house as it sits."],
                ["What if the house is in really rough shape?", "Tell us. The offer is about the house as it is. We will say plainly if it is not a fit."],
                ["Does as-is mean the price matches a fixed-up house?", "No. As-is offers are typically below full retail. You can compare it with your other choices before deciding."]]},
}
CHIPS = [("probate", "Inherited / probate"), ("divorce", "Divorce"), ("foreclosure", "Behind on payments"),
         ("landlord", "Tired landlord"), ("repairs", "Needs repairs")]

SCENARIOS = [
    # (slug, title, description, query)
    ("idea1-foreclosure", "Idea 1: search-matched headline (behind on payments)", "Keyword 'behind on payments' picks the foreclosure headline.", "?ideas=1&kw=behind+on+payments"),
    ("idea1-probate", "Idea 1: search-matched headline (inherited house)", "utm_term 'sell inherited house fast' picks the probate headline.", "?ideas=1&utm_term=sell+inherited+house+fast"),
    ("idea1-default", "Idea 1: safe default", "No keyword, so the current homepage headline shows.", "?ideas=1"),
    ("idea2-divorce", "Idea 2: situation story (divorce)", "Reassurance cards and FAQ for divorce. Chips switch situations.", "?ideas=1,2&sit=divorce"),
    ("idea3-local", "Idea 3: local feel (Columbus)", "City from the URL in the copy, plus a local-proof placeholder.", "?ideas=1,3&city=Columbus"),
    ("idea4-compare", "Idea 4: agent vs cash comparison", "Hedged industry ranges side by side with the FSHO path.", "?ideas=4#compare"),
    ("idea5-afterhours", "Idea 5: mobile bar + after-hours (forced)", "Sticky Call / Get Offer bar and the after-hours note. View on a phone width.", "?ideas=5&ah=1"),
    ("idea6-resume", "Idea 6: pick up where you left off", "Seeds a sample unfinished address in this browser only.", "?ideas=6&resume=demo"),
    ("idea7-faces", "Idea 7: faces + promise", "Photo placeholders and the no-call-center promise.", "?ideas=7#people"),
    ("combo-probate-harrisburg-afterhours", "Combined: probate executor in Harrisburg, after hours", "All 7 ideas. Try it at phone width.", "?kw=inherited+house+probate&city=Harrisburg&ah=1"),
    ("combo-foreclosure-york-returning", "Combined: behind on payments in York, returning visitor", "All 7 ideas, plus a saved address from an earlier visit.", "?utm_term=behind+on+mortgage+payments&utm_campaign=Hot+Markets&city=York&resume=demo&ah=0"),
    ("combo-landlord-grandrapids", "Combined: tired landlord in Grand Rapids, daytime", "All 7 ideas, daytime (after-hours note off).", "?kw=sell+rental+property+with+tenants&city=Grand+Rapids&ah=0"),
    ("combo-repairs-louisville", "Combined: house needs repairs in Louisville", "All 7 ideas.", "?kw=sell+house+needs+repairs&city=Louisville&ah=0"),
    ("combo-relocation", "Combined: relocating, no city", "Relocation headline, situation chips, no local copy.", "?kw=relocating+for+job+sell+house&ah=0"),
    ("baseline", "Baseline: all ideas off", "Close to today's page, for comparison.", "?ideas=none"),
]

def build_mockups(out, ctx):
    S, PH, TEL = ctx['S'], ctx['PH'], ctx['TEL']
    here = os.path.dirname(os.path.abspath(__file__))
    mcss = open(os.path.join(here, 'mockups.css'), encoding='utf-8').read()
    mjs = open(os.path.join(here, 'mockups.js'), encoding='utf-8').read().replace('</', '<\\/')
    e = html.escape
    banner = ('<div class="mk-banner" role="note"><strong>MOCKUP</strong>, not the live site. '
              'The form is turned off and nothing is sent. <a href="/mockups/">All mockups</a></div>')

    def doc(title, body, extra_head=''):
        return (f'<!doctype html><html lang="en"><head><meta name="robots" content="noindex,nofollow">'
                f'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                f'<title>{e(title)}</title><link rel="icon" href="/favicon.png"><style>{ctx["CSS"]}{mcss}</style>{extra_head}</head>'
                f'<body class="mk">{banner}{ctx["header"]}<main>{body}</main>{ctx["footer"]}</body></html>')

    def write(rel, text):
        dest = os.path.join(out, rel); os.makedirs(os.path.dirname(dest), exist_ok=True)
        open(dest, 'w', encoding='utf-8').write(text)

    # ---------- /mockups/seller/ ----------
    data = {"buckets": BUCKETS, "stories": STORIES, "eyebrow": S['hero_eyebrow'],
            "hours": {"open": 8, "close": 20, "tz": "America/New_York"}, "phone": PH, "tel": TEL}
    chips = ''.join(f'<button type="button" class="mk-chip" data-sit="{k}" aria-pressed="false">{e(v)}</button>' for k, v in CHIPS)
    form = ('<div class="lead" id="mk-lead">'
            '<div class="mk-resume" id="mk-resume" data-idea="6" hidden><p class="mk-resume-h">Welcome back. Pick up where you left off?</p>'
            '<p class="mk-resume-a"><span>Property</span><b id="mk-resume-addr"></b></p>'
            '<div class="mk-resume-b"><button type="button" class="btn btn-o" id="mk-resume-go">Continue &rarr;</button>'
            '<button type="button" class="ts-back" id="mk-resume-clear">Start over</button></div></div>'
            '<form id="ts-form" class="mk-form" action="#" method="post" novalidate data-mockup="1">'
            '<div class="lead-h"><strong>Get your fair cash offer</strong><span>Takes about 60 seconds. No obligation.</span></div>'
            '<p class="mk-ah mk-ah-form" hidden>&#127769; <span class="mk-ah-t"></span></p>'
            + ctx['ts_steps']('Get My Offer &rarr;', 'Continue &rarr;') +
            f'<p class="fine">Your info stays private. Or call/text <a href="tel:{TEL}">{PH}</a></p></form>'
            '<div class="mk-done" id="mk-done" role="status" hidden><h2>Mockup only: nothing was sent.</h2>'
            '<p>On the live site this is where the qualifying questions start. No lead was created, and no tracking fired.</p>'
            '<button type="button" class="btn btn-o" id="mk-again">Try again</button></div></div>')
    hero = (f'<section class="hero" id="offer"><div class="wrap hg"><div><p class="eyebrow" id="mk-eyebrow">{S["hero_eyebrow"]}</p>'
            f'<h1 id="mk-h1">{BUCKETS[-1]["h1"]}</h1><p class="lede" id="mk-sub">{BUCKETS[-1]["sub"]}</p>'
            f'<p class="mk-local-line" id="mk-local-line" data-idea="3" hidden></p>{ctx["trust"]}</div>{form}</div></section>')
    info = ('<details class="mk-info wrap"><summary>What this mockup is showing</summary><dl id="mk-info"></dl>'
            '<p class="fine">Change the URL to try others, e.g. <code>?kw=behind+on+payments&amp;city=Harrisburg&amp;ah=1</code>. '
            '<code>ideas=1,3,5</code> picks ideas, <code>ideas=none</code> turns all off. '
            '<code>sit=</code> probate, divorce, foreclosure, landlord, repairs, relocation. '
            '<code>ah=1</code> / <code>ah=0</code> forces after-hours. <code>resume=demo</code> / <code>resume=clear</code>.</p></details>')
    story = ('<section class="alt" id="story" data-idea="2" hidden><div class="wrap pad">'
             '<p class="mk-tag">Idea 2 &middot; situation story</p>'
             f'<h2 class="c">What is going on with the house?</h2><div class="mk-chips" role="group" aria-label="Pick your situation">{chips}</div>'
             '<div id="mk-story" aria-live="polite"></div></div></section>')
    local = ('<section class="wrap pad" id="local" data-idea="3" hidden><p class="mk-tag">Idea 3 &middot; local feel</p>'
             '<h2 class="c" id="mk-local-h">Selling a house in your area?</h2>'
             '<p class="c mk-narrow" id="mk-local-p">Tell us the address and we will look at the house as it is. '
             'We only buy in the states listed on our <a href="/service-areas/">service areas</a> page.</p>'
             '<div class="mk-ph" id="mk-local-ph">[PLACEHOLDER: real local proof from Andrew, for example homes bought nearby, a closing photo, or a local review. Leave the block out if there is none.]</div></section>')
    compare = ('<section class="alt" id="compare" data-idea="4" hidden><div class="wrap pad"><p class="mk-tag">Idea 4 &middot; side by side</p>'
               '<h2 class="c">Listing with an agent vs. a cash sale to us</h2>'
               '<p class="c mk-narrow">For a lot of sellers in a hard spot, knowing it will close matters as much as the price. Here is the honest trade-off.</p>'
               '<div class="mk-cmp" role="table" aria-label="Listing with an agent compared with a cash sale">'
               '<div class="mk-cmp-r mk-cmp-hd" role="row"><span role="columnheader"></span><span role="columnheader">Listing with an agent</span><span role="columnheader" class="us">Cash sale to Fair &amp; Simple</span></div>'
               + ''.join(f'<div class="mk-cmp-r" role="row"><span role="rowheader">{a}</span><span role="cell" data-h="Listing with an agent">{b}</span><span role="cell" class="us" data-h="Cash sale to Fair &amp; Simple">{c}</span></div>' for a, b, c in [
                   ("Agent commission", "Often around 5&ndash;6% of the sale price in total. Negotiable, and it varies.", "None"),
                   ("Seller closing costs", "Often about 1&ndash;3% (title, transfer taxes and fees vary by state).", "We cover them"),
                   ("Repairs and prep", "Usually expected: repairs, cleaning, staging, plus fixes the buyer asks for after inspection.", "None. Sell as-is."),
                   ("Showings", "Usually many, on the buyer's schedule.", "None"),
                   ("Time to close", "Commonly a few months: time on market, then often 30&ndash;45 days with a financed buyer.", "You pick the date. <span class=\"mk-ph-i\">[PLACEHOLDER: Andrew's typical days to close, if he wants a number]</span>"),
                   ("Certainty", "A buyer's loan, appraisal or inspection can delay or cancel the deal.", "The price stays the same once we are under contract, unless an inspection finds problems that were not disclosed."),
                   ("Price", "Usually the highest price, before costs.", "Typically below full retail, because repairs, costs and risk move to us."),
               ]) +
               '</div><p class="fine c">Agent-side figures are typical industry ranges, not quotes. Your costs may differ. FSHO-side wording is from the current site.</p></div></section>')
    steps = f'<section class="wrap pad"><h2 class="c">How it works: 3 simple steps</h2>{ctx["steps"]}</section>'
    people = ('<section class="alt" id="people" data-idea="7" hidden><div class="wrap pad"><p class="mk-tag">Idea 7 &middot; faces + promise</p>'
              '<h2 class="c">You\'ll talk to us, not a call center.</h2>'
              '<div class="mk-people">'
              '<figure class="mk-face"><div class="mk-photo" role="img" aria-label="Photo placeholder">[PLACEHOLDER: Andrew photo]</div>'
              '<figcaption><b>Andrew Collier</b><span>Founder &middot; [PLACEHOLDER: one line from Andrew in his own words]</span></figcaption></figure>'
              '<figure class="mk-face"><div class="mk-photo" role="img" aria-label="Photo placeholder">[PLACEHOLDER: Taylor photo]</div>'
              '<figcaption><b>[PLACEHOLDER: Taylor, name as it should appear]</b><span>[PLACEHOLDER: Taylor\'s role or title]</span></figcaption></figure></div>'
              f'<p class="c mk-narrow">When you call or text <a href="tel:{TEL}">{PH}</a>, <span class="mk-ph-i">[PLACEHOLDER: who answers, and when, confirmed by Andrew]</span>.</p>'
              f'<p class="c"><a class="btn btn-call" href="tel:{TEL}">&#128222; Call or text {PH}</a></p></div></section>')
    band = (f'<section class="band"><div class="wrap"><h2>{S["cta"]["heading"]}</h2><p>{S["cta"]["text"]}</p>'
            f'<a class="btn btn-w" href="#offer">{S["cta"]["button"]}</a></div></section>')
    bar = (f'<div class="mk-bar" id="mk-bar" data-idea="5" hidden><p class="mk-ah mk-ah-bar" hidden>&#127769; <span class="mk-ah-t"></span></p>'
           f'<div class="mk-bar-b"><a class="mk-bar-call" href="tel:{TEL}">&#128222; Call or text</a><a class="mk-bar-go" href="#offer">Get Offer</a></div></div>'
           f'<div id="mk-oldbar"><a class="sticky" href="tel:{TEL}">&#128222; Call Now</a><a class="sticky s2b" href="#offer">Get Offer</a></div>')
    body = info + hero + story + local + compare + steps + people + band + bar
    blob = json.dumps(data, ensure_ascii=False).replace('</', '<\\/')
    body += f'<script type="application/json" id="mk-data">{blob}</script><script>{mjs}</script>'
    write('mockups/seller/index.html', doc('MOCKUP: personalized seller page | Fair & Simple Home Offer', body))

    # ---------- /mockups/ index ----------
    ideas = [
        ("1", "Search-matched headline", "The H1 and subhead follow the search term or campaign (7 buckets, safe default)."),
        ("2", "Situation stories", "Reassurance cards and FAQ for probate, divorce, foreclosure, landlord and repairs."),
        ("3", "Local feel", "City from the URL or the typed address shows in the copy, with a local-proof slot."),
        ("4", "Agent vs cash comparison", "Fees, repairs, time to close and certainty, with hedged ranges."),
        ("5", "Mobile bar + after hours", "Sticky Call / Get Offer bar, tap-to-call, after-hours note by ET time."),
        ("6", "Pick up where you left off", "A returning visitor who typed an address sees it again (this browser only)."),
        ("7", "Faces + promise", "Photo slots for Andrew and Taylor and 'You'll talk to us, not a call center'."),
    ]
    cards = ''.join(f'<li class="card"><a href="/mockups/seller/{q}"><b>{e(t)}</b></a><p>{e(d)}</p><code>{e(q)}</code></li>' for _, t, d, q in SCENARIOS)
    idl = ''.join(f'<li><b>{n}. {e(t)}</b> {e(d)}</li>' for n, t, d in ideas)
    idx = (f'<section class="wrap pad"><h1>Seller personalization mockups</h1>'
           '<p class="mk-narrow">Preview only. Nothing here is on fsho.co, the form sends nothing, and no tracking loads. '
           'Every demo is the same page, <a href="/mockups/seller/">/mockups/seller/</a>, changed by its URL.</p>'
           f'<h2>The 7 ideas</h2><ol class="mk-ideas">{idl}</ol><h2>Demo links</h2><ul class="mk-scn">{cards}</ul>'
           '<p class="fine">Anything marked [PLACEHOLDER] needs a real fact from Andrew or Taylor before it could ship.</p></section>')
    write('mockups/index.html', doc('MOCKUPS: seller personalization | Fair & Simple Home Offer', idx))

    # Belt and braces: header-level noindex for the folder on preview hosts.
    hp = os.path.join(out, '_headers')
    prev = open(hp, encoding='utf-8').read() if os.path.isfile(hp) else ''
    open(hp, 'w', encoding='utf-8').write(prev + ('\n' if prev and not prev.endswith('\n') else '') + '/mockups/*\n  X-Robots-Tag: noindex, nofollow\n')
    return 2
