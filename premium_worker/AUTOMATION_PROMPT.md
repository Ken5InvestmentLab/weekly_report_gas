# Codex Automation Prompt

Run the premium alert worker for the weekly_report_gas repository.

1. Run `node premium_worker/worker.mjs collect`.
2. If the command reports `skipped` or `claimedCount: 0`, stop without posting.
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
5. Create `premium_worker/out/premium_reports.json` with one report per alert.
   Each report must include fields named exactly:
   `事業概要`, `足元材料`, `ファンダ要点`, `注意点`, `開示リンク`, `Sources`.
   Write the report body in Japanese. The narrative fields `事業概要`,
   `足元材料`, `ファンダ要点`, and `注意点` must not be written in English.
   Keep each narrative field analytical rather than memo-like: usually 2 short
   sentences, with source-grounded figures, dates, business drivers, or
   confirmation points where available. Avoid one-line generic summaries, but
   stay concise enough for Discord embeds.
   Do not use boilerplate that could be copied across symbols. `事業概要`
   must name the actual business model, core product/service, customer segment,
   or revenue driver for that company. `足元材料` must explain why the selected
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
   `足元材料` should read like a concise event timeline, not a research log:
   lead with the newest important disclosure date, material event, and figures
   where available, then add one sentence connecting it to the business
   confirmation point. Do not start with boilerplate such as "official IR/IRBANK
   was checked for 45 days" when a usable disclosure link exists; mention sparse
   disclosure checks in `注意点` only when needed. Avoid repeating the same
   sentence in `足元材料` and `ファンダ要点`, and avoid dumping multiple disclosure
   titles without explaining their impact.
   You may add an optional `材料インパクト` field with one of:
   `ポジティブ材料`, `ネガティブ材料`, `様子見`, or `混在/要確認`.
   Keep this as a source-grounded material impact label, not a trading action.
6. Use the TradingView URL from the claim as the Embed URL. JPX symbols must use
   the TradingView `TSE:` prefix, not `TYO:`. The worker normalizes TradingView
   embed titles to `銘柄名 (証券コード) | TradingView チャート`.
7. Put only direct disclosure file/detail URLs in `開示リンク` when verified:
   - direct PDF URLs such as `https://f.irbank.net/pdf/YYYYMMDD/<document_id>.pdf`
   - direct IRBANK PR PDFs such as `https://f.irbank.net/pr/...pdf`
   - TDnet `td_download.cgi` file URLs
   - individual company/PR disclosure detail pages only when no direct PDF file exists

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
   such as `2026年３月期 第３四半期決算短信〔日本基準〕（連結）` or
   `配当予想の修正（増配・特別配当）に関するお知らせ`; do not use generic labels like `開示1`.
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
10. Run `node premium_worker/worker.mjs post --input premium_worker/out/premium_reports.json`.
11. If a report cannot be grounded with at least one source URL, run
    `node premium_worker/worker.mjs fail --alert-id <alertId> --reason "insufficient verified sources"`
    for that alert instead of posting it.

If `PREMIUM_LOG_SPREADSHEET_ID` is configured, the worker records post/fail
events in that separate spreadsheet, batches post log rows once per run, retries
transient Sheets 429/5xx responses, and automatically deletes old active log
rows. For posted reports, the `reason` column is a concise one-line summary
generated from `材料インパクト` and the report's fundamental point; when Discord
returns a message URL, that summary is stored as a Markdown link to the posted
fundamental analysis. Do not use the existing GAS spreadsheet as the premium log
spreadsheet.

Do not edit `gas.txt`, do not modify GAS triggers, and do not write to the
existing spreadsheet.
