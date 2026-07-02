# Codex Automation Prompt

Run the premium alert worker for the weekly_report_gas repository.

1. Run `node premium_worker/worker.mjs collect`.
   If the automation prompt says the current startup is a delayed start for the
   intended 13:05 or 15:36 run window and `collect` is skipped only by the
   minute gate, immediately rerun `node premium_worker/worker.mjs collect --force`.
   Do not stop solely because the local clock has moved outside the worker's
   strict minute window.
   If a local command such as `collect`, `post`, or `fail` is rejected by a
   read-only sandbox or execution-policy error before Node starts, do not record
   the workflow as skipped or complete. Restore/request writable local execution
   for this automation run and retry the same command, using `collect --force`
   when the intended window has already passed.
2. If the command reports `skipped` for a real business-day/time gate reason
   after the delayed-window rule above has been handled, or if it reports
   `claimedCount: 0`, stop without posting.
3. Read `premium_worker/out/latest_claim.json`.
   The worker is configured to claim every unsent `BOTTOM` alert ID, ordered by
   newest `received_at` first. Do not limit processing to only the latest
   `received_at` group. Posted or manually locked alert IDs must not be claimed
   again; do not dedupe by symbol because different alert IDs for the same
   symbol are separate alerts.
4. For each claimed alert, use web search to verify a concise fundamental snapshot.
   Prioritize official company IR, TDnet/JPX disclosure pages or PDFs, EDINET,
   and reputable financial news. Do not limit the scan to earnings releases:
   also look for guidance revisions, buybacks, dividends, capital policy,
   medium-term plans, M&A, business alliances, major contracts, regulatory
   actions, governance events, and other timely disclosures.
   Before writing `開示リンク未確認` or saying there are no timely materials,
   open and scan the company's official IR/news disclosure list and an
   IRBANK/TDnet-style disclosure list for the symbol. Check at least the 45
   days before `receivedAt` and any newer disclosures visible at run time.
   If the IR library has a newer quarterly result, monthly data, guidance
   revision, asset-sale/special-gain notice, shareholder-return policy update,
   or other current disclosure, prioritize that newer item over an older annual
   earnings presentation. If a company genuinely has very few disclosures, an
   older official disclosure may be used only after explicitly stating that the
   official IR and IRBANK checks found no newer individual/timely disclosure in
   the required window. Do not use proxy materials such as company research
   reports, new-listing reports, interview articles, or media clippings as
   `開示リンク`; those are background sources at most.
   Do not conclude from only "no earnings release" or "no guidance revision";
   non-earnings disclosures such as warrant exercise/transfer, M&A progress,
   headquarters relocation, capital allocation, or business progress can be the
   main material.
4-A. For each claimed alert, before writing the report, build a `disclosure_candidates` list.

You MUST open and scan at least:
- the company's official IR/news disclosure list
- IRBANK disclosure list for the symbol
- TDnet/JPX-style disclosure list or equivalent

Do not rely only on Google/Bing search result snippets.
Search snippets may be stale. Always open the disclosure list page itself.

For each candidate disclosure, record internally:
- disclosure date
- disclosure time if visible
- title
- direct PDF/detail URL
- source page used to discover it

Sort `disclosure_candidates` by disclosure datetime descending.

If any fundamentally material disclosure exists within 45 days before `receivedAt` or newer than `receivedAt` but visible at runtime, the report MUST prioritize the newest fundamentally material disclosure(s).

Do not force routine administrative disclosures into the report merely because they are newest.
Routine personnel changes, ordinary officer personnel notices, organization changes, shareholders meeting notices, corporate governance reports, and similar administrative notices may be ignored unless they directly affect governance risk, management control, capital policy, earnings, shareholder returns, financing, M&A, business operations, or listing status.
Still open and scan those latest routine-looking disclosures before deciding.
If the content is routine and not fundamental, do not use it as the lead
`材料インパクト` or first `足元材料` sentence. Instead, lead with the newest
fundamentally material disclosure and leave the routine disclosure out of
`開示リンク` unless the narrative explicitly discusses it. Do not write filler
such as "最新開示は管理・体制面が中心" or "体制更新は管理面への影響が中心" just
to satisfy the stale-disclosure validator.

Examples:
- If the newest disclosure is an ordinary personnel change and the latest fundamentally material disclosure is an older earnings release, using the older earnings release is acceptable.
- If a newer earnings release exists, do not use an older earnings release as the main material.
- If a financial result and a capital-cost / stock-price-conscious management policy update are released at the same time, include both.
- If the disclosure is a representative director change, accounting auditor change, improper accounting investigation, lawsuit, regulatory action, or listing-maintenance issue, treat it as fundamentally material.

Fundamentally material disclosures include, but are not limited to:
- earnings releases / quarterly or full-year financial results
- guidance revisions
- dividends / buybacks / shareholder returns
- capital cost / stock-price-conscious management policy
- medium-term plans
- M&A / alliances / asset sales / special gains or losses
- governance or regulatory events

If the selected disclosure is older than the newest fundamentally material disclosure candidate, the report is invalid. Regenerate it before writing `premium_reports.json`.

When multiple important disclosures are released at the same time, such as a financial result and a capital policy update, include all of them in `足元材料` and `開示リンク`.
4-B. Determine `材料インパクト` by reading the disclosure content, not by title alone.

The worker's title-based disclosure classification is only a pre-check to decide
which disclosures must be considered. It is NOT enough to classify the final
material impact from the title.

For every fundamentally material disclosure selected for the report, open the
direct PDF/detail page and read the actual content before deciding
`材料インパクト`.

When deciding `材料インパクト`, evaluate the substance of the disclosure:

- actual earnings figures vs prior year
- company guidance vs prior guidance / market context
- upward or downward revision
- dividend increase / decrease / new shareholder return policy
- buyback scale and timing
- capital allocation plan
- PBR / ROE / capital cost response credibility
- dilution risk from warrants, CBs, public offering, or third-party allotment
- special gains / losses and whether they are one-time
- M&A price, strategic fit, funding burden, and integration risk
- monthly sales / order / utilization trend
- governance or regulatory risk
- whether the disclosure changes the company's medium-term fundamentals

Do not classify as positive or negative merely because the title contains words
such as:
- dividend
- buyback
- capital cost
- earnings
- M&A
- financing
- personnel change

Read the numbers, conditions, timing, and business context.

Use one of the following labels:

- `ポジティブ材料`
- `ネガティブ材料`
- `様子見`
- `混在/要確認`

The `材料インパクト` field must not be only the label. Write it as
`ラベル：根拠要約`, using a full-width colon and one concise source-grounded
sentence. The summary should mention the disclosure substance, figures, timing,
or business effect that justifies the label.
Do not build this summary by truncating or joining disclosure titles. Awkward
phrases such as `開示は...を含み`, `...に関するを含み`, `...ならびを含み`,
or title fragments ending in `に関する` / `について` are invalid; rewrite the
business effect in natural Japanese.

The summary must read like the previous good reports: `material/event + business
effect or risk`. Do not end with vague conclusions such as `...が支えです`,
`...が焦点です`, or `...が重いです`; state what changed for sales, margin,
dilution, cash flow, orders, utilization, returns, or another company-specific
driver.

Keep the summary short: aim for 45-80 Japanese characters after the label, and
never exceed 90 characters. Do not put procedural research wording here, such as
`PDF本文でも確認`, `主要損益項目を確認`, broad checklist phrases, or
`次回開示で確認する局面`. Put document titles, multiple figures, and detailed
confirmation points in `足元材料` / `ファンダ要点` / `開示リンク` instead.
Do not include `YYYY-MM-DD` calendar dates in `材料インパクト`; the date belongs in
`足元材料` and `開示リンク`. Start the summary from the material/event and business
effect, such as `中計見直しで回復目標は示された一方...`.

Do not default to `混在/要確認`. Use it only when positive and negative or
uncertain elements truly coexist. Do not force label diversity either: if every
report in a batch is genuinely supported by the same label, that is acceptable.

Examples:

- `ポジティブ材料：2026年3月期は売上高9,835百万円、経常利益458百万円、当期純利益441百万円と増収増益で、繰延税金資産計上も最終利益を押し上げている。`
- `ネガティブ材料：2026年9月期中間期は小幅増収でも営業損失が続き、MSワラント行使による希薄化も残っている。`

Guidance:

- Use `ポジティブ材料` when the disclosure clearly improves fundamentals,
  shareholder returns, capital efficiency, earnings visibility, balance sheet
  quality, or business growth prospects.
- Use `ネガティブ材料` when the disclosure clearly worsens earnings, guidance,
  dilution risk, financial risk, governance risk, or business outlook.
- Use `混在/要確認` when positive and negative elements coexist, such as
  shareholder returns but weak earnings, M&A growth but funding risk, or capital
  policy improvement but weak execution visibility.
- Use `様子見` when the disclosure is relevant but the financial impact,
  timing, amount, or sustainability is not yet clear.

The first sentence of `足元材料` should mention the disclosure content that
supports the impact label, not just the disclosure title.
When writing calendar dates in `足元材料`, use `M月D日` style such as `5月8日`,
not `YYYY-MM-DD`. Fiscal periods such as `2026年3月期` and `開示リンク` labels using
`YYYY-MM-DD 開示タイトル(hh:mm)` remain acceptable.

Examples:

- A dividend-related disclosure is not automatically positive. If the company
  increases dividends despite falling profits or weak cash flow, classify as
  `混在/要確認` unless the payout is clearly sustainable.
- A buyback is not automatically positive. If the scale is very small or the
  company has weak balance sheet conditions, classify as `様子見` or
  `混在/要確認`.
- A capital-cost / stock-price-conscious management disclosure is not
  automatically positive. If it only repeats generic policy with no concrete
  capital allocation, ROE/PBR target, shareholder return change, or execution
  plan, classify as `様子見`.
- An earnings release is not automatically positive or negative. Compare sales,
  operating profit, ordinary profit, net profit, margins, guidance, and company
  assumptions.
- A financing disclosure is not automatically negative. Evaluate dilution,
  use of proceeds, funding necessity, exercise conditions, and expected business
  return.
- An M&A disclosure is not automatically positive. Evaluate acquisition price,
  earnings contribution, strategic fit, goodwill/integration risk, and funding
  burden.

Do not write `材料インパクト` until the selected disclosure content has been read.
If the disclosure file cannot be opened or the content cannot be verified, use
`混在/要確認` or `様子見`, and explain the uncertainty in `注意点`.
5. Create `premium_worker/out/premium_reports.json` with one report per alert.
   Each report must include fields named exactly:
   `材料インパクト`, `事業概要`, `足元材料`, `ファンダ要点`, `注意点`, `開示リンク`, `Sources`.
   Write the report body in Japanese. The narrative fields `事業概要`,
   `足元材料`, `ファンダ要点`, and `注意点` must not be written in English.
   Keep each narrative field analytical rather than memo-like: usually 2 short
   sentences, with source-grounded figures, dates, business drivers, or
   confirmation points where available. Avoid one-line generic summaries, but
   stay concise enough for Discord embeds.
   Do not reuse the same `足元材料`, `ファンダ要点`, or `注意点` text across
   multiple reports in a batch. Generic bucket summaries such as `決算・還元・提携
   などが収益性、資本効率、事業進捗へ与える実質影響が焦点`, `株主還元や
   資本効率方針はROE`, or broad M&A/monthly/disclosure templates are invalid;
   write the actual KPI and risk for that company.
   Before writing reports, skim `premium_worker/FUNDAMENTAL_EXAMPLES.md`.
   Treat those examples as quality calibration, not a rigid template: follow
   their specificity around actual business, event dates, figures, KPIs, and
   unresolved risks, but adapt structure and emphasis to the company and
   disclosure.
   This automation is normally run with GPT-5.5 reasoning set to high. Use that
   reasoning budget to preserve per-symbol quality, not to compress the work.
   When the claim has many alerts, split the work into small chunks, such as
   5-8 symbols at a time, and keep an internal audit table for every symbol:
   `alertId`, `symbolCode`, selected material disclosure(s), direct
   `開示リンク` count, `Sources` count, company-specific KPI, unresolved risk,
   and final `材料インパクト` label. Do not write the whole batch from titles,
   snippets, or a shared prose pattern in one pass.
   Large-batch fatigue is not an acceptable reason for thinner analysis. If the
   batch is too large to finish at the same quality level, keep iterating in
   chunks and run dry-run repairs; do not post partially grounded reports or
   convert grounded-but-unpolished alerts into `fail` stubs.
   Write the analytical conclusion, not the research procedure. Do not use
   generic placeholder phrases such as `確認対象です`, `確認する局面です`,
   `確認したい局面です`, or `次回進捗待ちです` as the main
   content of `材料インパクト`, `足元材料`, `ファンダ要点`, or `注意点`.
   Also do not use research-plan wording such as `今回の開示では...具体的に追います`,
   `どこに効くか`, `見る必要があります`, `見ます`, `確認していきます`,
   `確認したい`, `確認する局面`, `見たい`, `見極めたい`, `見極めが必要`,
   or filler lead-ins such as
   `読み取れる結果は`. The field name already tells
   the reader this is analysis; write the conclusion directly.
   Instead, state what the disclosure means now: positive/negative/mixed
   effect, which KPI or risk moved, and what unresolved item remains.
   You may use `確認軸` only when it is attached to concrete company-specific
   KPIs, such as store sales, order backlog, utilization, ARR, churn, funding
   terms, or dilution/exercise pace.
   Do not use boilerplate that could be copied across symbols. `事業概要`
   must only name the actual business, core product/service, operating format,
   or customer segment for that company. Do not include revenue drivers, KPIs,
   monthly sales, visitor count, unit price, margins, utilization, order backlog,
   funding, shareholder returns, or phrases such as `収益を左右します` /
   `業績を左右します` here; put those in `ファンダ要点`.
   Never write a company overview like
   "開示資料で確認できる主要サービス・製品を中心に事業を展開する上場企業"
   or "直近の材料は、売上成長、利益率、資本政策、事業提携のどれに効くか".
   Also never write a company overview like `直近開示で示された事業領域を軸に`
   or `開示タイトルからは...材料になります`; that is not a business
   description. Name only the actual operation, product, service, and customer.
   `足元材料` must explain why the selected
   disclosure matters for that specific company, such as SaaS ARR, store
   profitability, financing dilution, facility utilization, order backlog,
   acquisition integration, or governance risk. `ファンダ要点` must choose the
   relevant KPI/accounting line rather than list generic categories.
   `ファンダ要点` must not start from boilerplate such as "ファンダ面では、
   この開示が..." or "後続として、次回決算で...". Write the company-specific
   mechanism instead: for example ARR/churn/ARPU for SaaS, same-store sales and
   gross margin for retail, order backlog and utilization for manufacturers,
   dilution and exercise pace for warrants, or occupancy and funding terms for
   facility operators.
   `注意点` must name the company-specific uncertainty; do not rely on generic
   caveats such as "開示単体では金額、契約期間、希薄化、一過性の区別が十分に
   読み切れない" unless the sentence immediately explains which of those
   issues applies and why.
   Do not start `注意点` with the stock code, such as `1234では...`; the embed
   title already identifies the symbol. Start directly with the risk, KPI, or
   unresolved disclosure item.
   `足元材料` should read like a concise event timeline, not a research log:
   lead with the newest fundamentally material disclosure date, material event, and figures
   where available, then add one sentence connecting it to the business
   confirmation point. Do not start with boilerplate such as "official IR/IRBANK
   was checked for 45 days" when a usable disclosure link exists; mention sparse
   disclosure checks in `注意点` only when needed. Avoid repeating the same
   sentence in `足元材料` and `ファンダ要点`, and avoid dumping multiple disclosure
   titles without explaining their impact.
   Do not prepend disclosure-title inventory sentences such as
   `2026-05-07に「決算短信...」、「決算説明資料...」も確認。`.
   When several same-date disclosures matter, summarize the substance in one
   analytical sentence instead, such as earnings progress plus dividend policy
   or M&A completion plus product launch relevance. Keep the exact document
   titles in `開示リンク`, not at the start of `足元材料`.
   Every report MUST include a `材料インパクト` field starting with exactly one of:
`ポジティブ材料`, `ネガティブ材料`, `様子見`, or `混在/要確認`.

`材料インパクト` must be based on the content of the selected disclosure(s),
not on the title alone. Read the actual PDF/detail page, compare the numbers,
conditions, and business context, then choose the label.

`材料インパクト` MUST use `ラベル：根拠要約` format. Bare labels such as
`ネガティブ材料` or `様子見` are invalid because 13:05 and 15:36 Discord posts
must use the same summarized format.

The `根拠要約` part must be one short sentence, no more than 90 Japanese
characters after the label. It should state the substance behind the label, not
the investigation process. A batch must not be rejected just because many
reports share the same label; reject only unsupported or template-like labels.

Keep this as a source-grounded material impact label, not a trading action.
6. Use the TradingView URL from the claim as the Embed URL. JPX symbols must use
   the TradingView `TSE:` prefix, not `TYO:`, and chart URLs must use
   `https://jp.tradingview.com/chart/` rather than `https://www.tradingview.com/chart/`.
   The worker normalizes TradingView embed titles to
   `銘柄名 (証券コード) | TradingView チャート`.
7. Put only direct disclosure file/detail URLs in `開示リンク` when verified:
   - direct PDF URLs such as `https://f.irbank.net/pdf/YYYYMMDD/<document_id>.pdf`
   - direct IRBANK PR PDFs such as `https://f.irbank.net/pr/...pdf`
   - TDnet `td_download.cgi` file URLs
   - individual company/PR disclosure detail pages only when no direct PDF file exists

   Do not impose a one-link limit. Include every recent fundamentally material disclosure
   used to write `足元材料`, `ファンダ要点`, or `注意点`, such as a quarterly
   result plus a guidance revision, buyback update, dividend/capital-policy
   notice, M&A/alliance disclosure, asset-sale/special-gain notice, monthly
   data, or governance/regulatory release. Keep weak background pages out of
   `開示リンク`, but do not omit a verified direct disclosure merely because one
   stronger disclosure is already linked.

   If `足元材料`, `ファンダ要点`, or `注意点` mentions an IR/disclosure title,
   event, or official press release, the corresponding disclosure must also
   appear in `開示リンク`. This includes secondary but explicitly discussed
   items such as industry-award press releases, governance notices, shareholder
   meeting notices, dividend notices, or social-media/account launch notices.
   If there is no direct PDF but an official company/PR detail page exists, put
   that detail page in `開示リンク` with the same timestamped label.

   Every `開示リンク` label MUST be formatted as:

   `YYYY-MM-DD 開示タイトル(hh:mm)`

   Example:

   `[2026-05-14 剰余金の配当に関するお知らせ(15:30)](https://f.irbank.net/pdf/20260514/140120260514534210.pdf)`

   If two URLs point to the same disclosure content, include only one line even
   when the URLs differ. Treat matching TDnet/IRBANK document IDs, matching PDF
   files, or exactly matching disclosure titles at the same date/time as the same
   content. Prefer direct `f.irbank.net` PDF/PR URLs over IRBANK HTML pages or
   secondary mirrored URLs.

   Discord embed fields are capped at 1024 characters; if `開示リンク` exceeds
   that limit Discord truncates the field mid-URL and the trailing `](url)` is
   lost, leaving a broken link such as `...storage-yahoo.jp/disclosure/20260508/20…`.
   To prevent this, do NOT use long Yahoo edge-storage URLs such as
   `https://finance-frontend-pc-dist.*.storage-yahoo.jp/disclosure/...` in
   `開示リンク`; substitute the equivalent short `f.irbank.net/pdf/...` or TDnet
   `td_download.cgi` URL for the same document. Keep the assembled `開示リンク`
   field (all link lines combined, including labels and newlines) under 1000
   characters as a safety margin. If links would still exceed that, drop the
   weakest disclosure rather than letting Discord cut a URL.

   Do NOT put IRBANK HTML disclosure pages such as
   `https://irbank.net/<code>/<document_id>` in `開示リンク`.
   IRBANK HTML pages are allowed only as an input page to discover the real PDF URL.

   When an IRBANK HTML page exposes or corresponds to an `f.irbank.net/pdf/...pdf`
   or `f.irbank.net/pr/...pdf` file, the outgoing `開示リンク` MUST use that direct
   `f.irbank.net` file URL, not the `irbank.net` HTML page.

   Example:
   Wrong:
   `https://irbank.net/3910/140120260204547074#google_vignette`

   Correct:
   `https://f.irbank.net/pdf/20260204/140120260204547074.pdf`

   Before writing `premium_worker/out/premium_reports.json`, validate every
   `開示リンク`. If any URL matches `https://irbank.net/<code>/<document_id>` or
   contains `#google_vignette`, replace it with the corresponding direct
   `https://f.irbank.net/pdf/YYYYMMDD/<document_id>.pdf` when the document date
   can be inferred from the document ID or verified from the page. If the direct
   file cannot be verified, write `開示リンク未確認` instead of using the IRBANK HTML page.

   Link labels must use the actual document or disclosure title as closely as possible,
   with the required date/time prefix/suffix, such as
   `2026-05-14 2026年３月期 第３四半期決算短信〔日本基準〕（連結）(15:30)` or
   `2026-05-14 配当予想の修正（増配・特別配当）に関するお知らせ(15:30)`;
   do not use generic labels like `開示1`.
8. Put 2-4 reference page URLs in `Sources`: company IR pages, disclosure-list
   pages, news pages, business/profile pages, or reputable financial-news pages
   used for grounding. Do not put direct PDFs, TDnet files, IRBANK individual
   disclosure pages, or individual PR/disclosure detail pages in `Sources`;
   those direct disclosure links belong only in `開示リンク`. Source link labels
   must be page titles as closely as possible; do not use `出典1`, `Source1`,
   `会社IR`, or similarly opaque labels.
9. Do not write buy/sell recommendations, target prices, or any additional score.
   Avoid wording such as `買い推奨`, `売り推奨`, `買うべき`, `売るべき`,
   `目標株価`, `利確`, or `損切り`.
9-A. Before the real Discord post, run a worker validation dry-run.

Run:

`node premium_worker/worker.mjs post --input premium_worker/out/premium_reports.json --dry-run`

This dry-run is mandatory. Do not run the real post until the dry-run succeeds.

If the dry-run fails, read the JSON error message carefully.

If the error says any of the following:
- `may be stale`
- `uses an older disclosure while newer IRBANK fundamentally material disclosure exists`
- `newer IRBANK fundamentally material disclosure exists`
- `disclosure link must be a direct disclosure URL`
- `source link must be a reference/listing page URL`
- `Sources must include at least 2 reference/listing URLs`
- `Sources duplicates the same reference URL`
- `large premium batch has too many reports without direct 開示リンク`
- `large premium batch has too many sparse-disclosure fallback reports`
- `large premium batch field ... average length is too terse`
- `field 足元材料`
- `field ファンダ要点`
- `too generic`
- `too narrowly scoped`
- `must include at least one URL in Sources`

then do NOT stop.

Instead:
1. Identify the failed `alertId` and symbol from the error.
2. Re-open `premium_worker/out/latest_claim.json`.
3. Re-open the current `premium_worker/out/premium_reports.json`.
4. Regenerate only the failed report.
5. Keep all other valid reports unchanged.
6. For the failed symbol, open and scan:
   - the company's official IR/news disclosure list
   - IRBANK disclosure list for the symbol
   - TDnet/JPX-style disclosure list or equivalent
7. Build a fresh `disclosure_candidates` list.
8. Prioritize the newest fundamentally material disclosure(s), including same-date same-time disclosures.
9. Rewrite `premium_worker/out/premium_reports.json`.
10. Run the dry-run again.

Repeat this dry-run → fix → dry-run loop for the failed alert. A batch-level
retry count is not evidence that the symbol lacks disclosures.

If the dry-run still fails after repeated report repair:
- keep the failed alert isolated from the next real post batch
- read whether the validator is asking for a newer disclosure, a title/date
  match, a direct disclosure URL, or a report-field rewrite
- keep repairing the grounded report when verified disclosure material exists

Do NOT post a 様子見 stub merely because validation retries were exhausted.
`fail` is for alert-specific source insufficiency after the source checks below,
not for a report that still needs validation repair.

Do not use `fail --input` to convert a whole batch into insufficient-source
stubs. `insufficient verified sources` is an alert-by-alert conclusion after
checking that symbol's company IR/news pages, IRBANK, and a TDnet/JPX-equivalent
disclosure source. Do not loop `fail --alert-id` across many alerts as a
workaround for the batch guard; the worker rejects repeated insufficient-source
stubs in a rolling time window unless an explicit manual mass-fail override is
set. If several alerts look weak, keep regenerating or isolating the grounded
reports and fail only the truly source-insufficient alert.

10. Only after the dry-run succeeds, run the real post:

`node premium_worker/worker.mjs post --input premium_worker/out/premium_reports.json`

The real post must preserve the worker-generated button components when
Discord bot posting is configured. Each premium alert should show an enabled
scan button with `custom_id` `premium_scan:<symbolCode>` and label
`🔍 <symbolCode> をスキャンする`, plus a neighboring link button labeled
`📊 チャートを見る` whose URL matches the embed title's TradingView URL. The
13:05 and 15:36 automations use the same worker, so this button behavior applies
to both posting windows. If the local environment lacks the bot token/channel
settings, the worker will warn and fall back to webhook posting without
components; fix the local configuration instead of treating the buttonless post
as the intended premium format.
11. If a report cannot be grounded with at least one source URL, run the `fail`
    command to post a 様子見 stub:

    `node premium_worker/worker.mjs fail --alert-id <alertId> --reason "insufficient verified sources"`

    The worker posts a 様子見 Discord embed and records the alert as POSTED.
    Do NOT skip the alert or leave it unposted.
    Batch insufficient-source fail input is rejected by default and requires
    an explicit manual override; repeated per-alert insufficient-source stubs
    are also rejected by default. Normal automation must not use that override.

If `PREMIUM_LOG_SPREADSHEET_ID` is configured, the worker records all post
events (including 様子見 stubs) in that separate spreadsheet. If the spreadsheet
write fails, the events are persisted to `state.pendingLogEvents` and replayed
automatically on the next run. The process exits with code 2 on write failure —
check the exit code in automation scripts. Do not use the existing GAS
spreadsheet as the premium log spreadsheet.

Do not edit `gas.txt`, do not modify GAS triggers, and do not write to the
existing GAS spreadsheet (alerts_raw).
