# Test mode

The public form stays off (`preview` true, `lead_form.enabled` false, empty endpoint). This page is a separate click-through at `/test-intake/?test=1`.

Test mode is on only when the build context is `local`, `dev`, `deploy-preview`, or `branch-deploy`, and the URL has `?test=1`. A production build (`CONTEXT=production` or `gen.py --live`) bakes `production`, and `?test=1` does not turn it on.

Stage 1 parks name, address, phone, and email through the mock adapter. That records a staged-table insert and does not create a CRM lead or load a Google tag. Leaving after that stays parked.

Q1 condo, mobile, land, or other stays parked for a `pg_cron` self-serve sweep. No tag.

Q1 single-family or multi-family waits for Q2. The tag is still not loaded. Any owner answer (only owner, all owners agree, heir/executor/POA) is the form fill: the dry-run records the tag and the conversion, then the expected path is the Zap Hot path (WhatConverts, CRM, Slack). Q3–Q6 only add enrichment lines.

Q2 non-owner is logged as CRM follow-up with no conversion and no tag.

The default adapter makes no network calls. The tag marker is a JSON script tag, not a request to Google. Nothing here calls Supabase, intake-reserve, Zapier, WhatConverts, CRM, or Slack.
