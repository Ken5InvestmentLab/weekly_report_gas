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
   earnings presentation.
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
   You may add an optional `材料インパクト` field with one of:
   `ポジティブ材料`, `ネガティブ材料`, `様子見`, or `混在/要確認`.
   Keep this as a source-grounded material impact label, not a trading action.
6. Use the TradingView URL from the claim as the Embed URL. JPX symbols must use
   the TradingView `TSE:` prefix, not `TYO:`. The worker normalizes TradingView
   embed titles to `銘柄名 (証券コード) | TradingView チャート`.
7. Put only direct disclosure URLs in `開示リンク` when verified: PDF URLs,
   TDnet `td_download.cgi` file URLs, IRBANK individual disclosure pages, or
   individual company/PR disclosure detail pages. Do not put IR pages,
   disclosure-list pages, company-profile pages, or news-list pages in
   `開示リンク`; put those in `Sources` instead. If no direct disclosure URL can
   be verified, write `開示リンク未確認`. Link labels must use the actual
   document or disclosure title as closely as possible, such as
   `2026年３月期 第３四半期決算短信〔日本基準〕（連結）` or
   `配当予想の修正（増配・特別配当）に関するお知らせ`; do not use generic
   labels like `開示1`.
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
rows. Do not use the existing GAS spreadsheet as the premium log spreadsheet.

Do not edit `gas.txt`, do not modify GAS triggers, and do not write to the
existing spreadsheet.
