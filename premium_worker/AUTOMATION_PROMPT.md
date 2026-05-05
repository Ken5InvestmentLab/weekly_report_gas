# Codex Automation Prompt

Run the premium alert worker for the weekly_report_gas repository.

1. Run `node premium_worker/worker.mjs collect`.
2. If the command reports `skipped` or `claimedCount: 0`, stop without posting.
3. Read `premium_worker/out/latest_claim.json`.
4. For each claimed alert, use web search to verify a concise fundamental snapshot.
   Prioritize official company IR, TDnet/JPX disclosure pages or PDFs, EDINET,
   and reputable financial news.
5. Create `premium_worker/out/premium_reports.json` with one report per alert.
   Each report must include fields named exactly:
   `事業概要`, `足元材料`, `ファンダ要点`, `注意点`, `開示リンク`, `Sources`.
6. Use the TradingView URL from the claim as the Embed URL.
7. Put direct disclosure URLs in `開示リンク` when verified. If no disclosure link
   can be verified, write `開示リンク未確認`.
8. Put 2-4 source URLs in `Sources`. Do not invent URLs or cite unverified pages.
9. Do not write buy/sell recommendations, target prices, or any additional score.
10. Run `node premium_worker/worker.mjs post --input premium_worker/out/premium_reports.json`.
11. If a report cannot be grounded with at least one source URL, run
    `node premium_worker/worker.mjs fail --alert-id <alertId> --reason "insufficient verified sources"`
    for that alert instead of posting it.

If `PREMIUM_LOG_SPREADSHEET_ID` is configured, the worker records post/fail
events in that separate spreadsheet and automatically deletes old active log
rows. Do not use the existing GAS spreadsheet as the premium log spreadsheet.

Do not edit `gas.txt`, do not modify GAS triggers, and do not write to the
existing spreadsheet.
