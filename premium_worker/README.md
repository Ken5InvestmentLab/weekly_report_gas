# Premium Alert Worker

This worker is intentionally separate from the existing GAS project.

It does not edit `gas.txt`, does not call GAS functions, and does not write to
the existing spreadsheet. It reads `alerts_raw`, lets Codex research a short
fundamental snapshot, then posts a Discord Embed to the premium channel.

The worker is designed to prevent stale or weak fundamental reports from being
posted. Before the real Discord post, use `--dry-run` to validate the report JSON,
disclosure links, source links, Japanese narrative fields, generic wording, and
whether a newer fundamentally material disclosure was missed.

---

## Required setup

1. Create a Google Cloud service account with Google Sheets API enabled.
2. Share the target spreadsheet with the service account email as **Viewer**.
3. Copy `.env.example` to `premium_worker/.env` and set:
   - `PREMIUM_SPREADSHEET_ID`
   - `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_SERVICE_ACCOUNT_JSON`
   - `DISCORD_PREMIUM_WEBHOOK_URL`
4. Keep the following untracked:
   - `premium_worker/.env`
   - credentials
   - `premium_worker/state/`
   - `premium_worker/out/`

---

## Base64 credential option

`GOOGLE_SERVICE_ACCOUNT_JSON_B64` is the full service-account JSON encoded as
Base64. It is useful when the automation environment can store environment
variables more easily than local files.

PowerShell:

```powershell
$jsonPath = "C:\Users\ken5\.secrets\premium-alert-reader.json"
$json = Get-Content -Raw -Path $jsonPath
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)) | Set-Clipboard
```

Then paste the clipboard value into:

```env
GOOGLE_SERVICE_ACCOUNT_JSON_B64=PASTE_BASE64_VALUE_HERE
```

Quick decode check:

```powershell
$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:GOOGLE_SERVICE_ACCOUNT_JSON_B64))
($decoded | ConvertFrom-Json).client_email
```

---

## Optional spreadsheet log

By default, this worker records posted/failed alerts only in
`premium_worker/state/`.

If you want a spreadsheet log, set `PREMIUM_LOG_SPREADSHEET_ID` to a separate
spreadsheet ID and share that log spreadsheet with the service account as
**Editor**.

The worker will create/update `premium_alert_log`. Rows older than
`PREMIUM_LOG_RETENTION_DAYS` are deleted automatically before new log rows are
appended.

For safety, `PREMIUM_LOG_SPREADSHEET_ID` must be different from
`PREMIUM_SPREADSHEET_ID`.

---

## Commands

### From repository root

Run these commands when your current directory is:

```text
weekly_report_gas>
```

```powershell
node --check premium_worker/worker.mjs
node premium_worker/worker.mjs self-test
node premium_worker/worker.mjs collect
node premium_worker/worker.mjs post --input premium_worker/out/premium_reports.json --dry-run
node premium_worker/worker.mjs post --input premium_worker/out/premium_reports.json
node premium_worker/worker.mjs fail --alert-id ALERT_ID --reason "insufficient verified sources"
node premium_worker/worker.mjs lock-before --date 2026-04-30
node premium_worker/worker.mjs status
```

### From inside `premium_worker/`

Run these commands when your current directory is:

```text
weekly_report_gas\premium_worker>
```

```powershell
node --check worker.mjs
node worker.mjs self-test
node worker.mjs collect
node worker.mjs post --input out/premium_reports.json --dry-run
node worker.mjs post --input out/premium_reports.json
node worker.mjs fail --alert-id ALERT_ID --reason "insufficient verified sources"
node worker.mjs lock-before --date 2026-04-30
node worker.mjs status
```

Always run `--dry-run` before the real Discord post.

---

## Normal posting flow

Use this flow for normal operation:

```text
collect
↓
Codex creates premium_worker/out/premium_reports.json
↓
post --dry-run
↓
If dry-run succeeds, run the real post
↓
If dry-run fails, regenerate only the failed report and dry-run again
```

Example from repository root:

```powershell
node premium_worker/worker.mjs collect
node premium_worker/worker.mjs post --input premium_worker/out/premium_reports.json --dry-run
node premium_worker/worker.mjs post --input premium_worker/out/premium_reports.json
```

Example from inside `premium_worker/`:

```powershell
node worker.mjs collect
node worker.mjs post --input out/premium_reports.json --dry-run
node worker.mjs post --input out/premium_reports.json
```

---

## Collect behavior

`collect` runs only inside the allowed JST windows by default.

Default windows:

```text
13:00-13:10 JST
15:30-15:40 JST
Weekdays only
```

Use `--force` for a manual test or for an automation run that started late but
is still intended to cover the 13:05 or 15:36 run window.

```powershell
node premium_worker/worker.mjs collect --force
```

or, from inside `premium_worker/`:

```powershell
node worker.mjs collect --force
```

The default signal filter is `BOTTOM`, and already-posted alert IDs are never
selected again.

The same symbol may be selected again when TradingView creates a different
alert ID.

If `collect`, `post`, or `fail` is rejected before Node starts because the
Codex session is read-only, do not treat that as a normal skip. The workflow
needs writable local execution because it must update `premium_worker/state/`
and `premium_worker/out/`; rerun with writable execution and use
`collect --force` if the intended window has already passed.

By default:

```env
PREMIUM_MAX_ALERTS_PER_RUN=0
PREMIUM_SCAN_MAX_ROWS=0
```

This means the worker scans all rows and claims every unsent matching alert ID.
Set positive values only when intentionally capping a manual run.

---

## Dry-run behavior

`post --dry-run` validates the report without sending anything to Discord.

The dry-run checks:

- report JSON shape
- required fields
- Japanese narrative fields
- generic or boilerplate wording
- prohibited investment-advice wording
- direct disclosure URL rules
- source URL rules
- descriptive Markdown link labels
- stale or weak disclosure usage
- whether a newer fundamentally material IRBANK disclosure was missed

If every report is valid, dry-run returns a payload preview and does not post.

If a report fails validation, fix only the failed report in
`premium_worker/out/premium_reports.json`, then run dry-run again.

---

## Fail-stub behavior

Use `fail --alert-id <id> --reason "insufficient verified sources"` only after
checking that specific alert against company IR/news pages, IRBANK, and a
TDnet/JPX-equivalent disclosure source. Do not use `fail --input` to mark a
whole batch as `insufficient verified sources`.

The worker rejects batch insufficient-source stubs by default. A mass fail
requires an explicit manual override with `--allow-mass-fail` or
`PREMIUM_ALLOW_MASS_FAIL_STUBS=true`, and should be treated as an exceptional
operator action, not normal automation behavior.

---

## Fundamentally material disclosure policy

The report does **not** need to include the absolute newest disclosure if that
newest disclosure is routine or administrative.

The report must include the newest **fundamentally material** disclosure when one
exists within the required disclosure window.

Fundamentally material disclosures include, but are not limited to:

- earnings releases / quarterly or full-year financial results
- guidance revisions
- dividends / buybacks / shareholder returns
- capital cost / stock-price-conscious management policy
- medium-term plans
- M&A / alliances / asset sales / special gains or losses
- monthly data / order data / sales data / utilization data
- warrant exercise / transfers / financing / dilution-related disclosures
- governance or regulatory events that can affect fundamentals

Routine administrative disclosures may be ignored merely because they are newer.

Routine disclosures include, but are not limited to:

- ordinary personnel changes
- ordinary officer personnel notices
- organization changes
- shareholders meeting notices
- corporate governance reports
- independent officer filings
- routine articles-of-incorporation changes

However, governance-related disclosures must be treated as fundamentally material
when they directly affect governance risk, management control, capital policy,
earnings, shareholder returns, financing, M&A, business operations, or listing
status.

Examples:

- If the newest disclosure is an ordinary personnel change and the latest
  fundamentally material disclosure is an older earnings release, using the older
  earnings release is acceptable.
- If a newer earnings release exists, do not use an older earnings release as
  the main material.
- If a financial result and a capital-cost / stock-price-conscious management
  policy update are released at the same time, include both.
- If the disclosure is a representative director change, accounting auditor
  change, improper accounting investigation, lawsuit, regulatory action, or
  listing-maintenance issue, treat it as fundamentally material.

---

## Material impact judgment policy

The title-based disclosure classification is only a pre-check to decide which
disclosures must be considered.

`材料インパクト` must be decided by reading the actual disclosure content, not by
the title alone.

Do not classify a disclosure as positive or negative merely because the title
contains words such as dividend, buyback, capital cost, earnings, M&A, financing,
or personnel change.

Evaluate:

- actual earnings figures
- guidance changes
- margin trend
- shareholder return amount and sustainability
- buyback scale
- dilution risk
- capital allocation credibility
- PBR / ROE / capital cost response
- special gains or losses
- M&A price, funding burden, and integration risk
- monthly sales / orders / utilization trend
- governance or regulatory impact

Use:

- `ポジティブ材料` when the content clearly improves fundamentals, shareholder
  returns, capital efficiency, earnings visibility, or business growth prospects.
- `ネガティブ材料` when the content clearly worsens earnings, guidance, dilution
  risk, financial risk, governance risk, or business outlook.
- `混在/要確認` when positive and negative elements coexist.
- `様子見` when the disclosure is relevant but the financial impact, timing,
  amount, or sustainability is not yet clear.

## Report JSON shape

Codex should create `premium_worker/out/premium_reports.json` like this:

```json
{
  "reports": [
    {
      "alertId": "example-alert-id",
      "title": "銘柄名 (1234) | TradingView チャート",
      "url": "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
      "symbolCode": "1234",
      "symbolName": "銘柄名",
      "fields": [
        {
          "name": "材料インパクト",
          "value": "ポジティブ材料: 会社開示で確認できる増益要因。"
        },
        {
          "name": "事業概要",
          "value": "ステンレス管や加工品を製造販売するメーカーで、建設・設備向け需要、材料市況、工場稼働率が収益を左右する。販売数量と材料スプレッドの変化が粗利率に反映されやすい。"
        },
        {
          "name": "足元材料",
          "value": "2026年5月8日に2026年3月期決算短信と、資本コストや株価を意識した経営の実現に向けた対応を同時開示。決算数値と資本効率改善方針を合わせて確認する局面。"
        },
        {
          "name": "ファンダ要点",
          "value": "販売数量、材料価格、在庫評価、固定費吸収が利益率の確認点になる。資本政策ではROE、PBR、配当方針、株主還元姿勢が中期的な評価材料になる。"
        },
        {
          "name": "注意点",
          "value": "需要回復が遅れる場合は稼働率低下と固定費負担が続く可能性がある。資本コスト対応は方針だけでなく、利益成長や還元実行が伴うかを継続確認したい。"
        },
        {
          "name": "開示リンク",
          "value": "[2026-05-08 2026年３月期 決算短信〔日本基準〕（連結）(15:30)](https://f.irbank.net/pdf/20260508/xxxxxxxxxxxx.pdf)\n[2026-05-08 資本コストや株価を意識した経営の実現に向けた対応について(15:30)](https://f.irbank.net/pdf/20260508/yyyyyyyyyyyy.pdf)"
        },
        {
          "name": "Sources",
          "value": "[銘柄名 IRニュース](https://www.example.co.jp/ir/news/)\n[銘柄名（1234）のIR情報・決算資料 | IRBANK](https://irbank.net/1234/ir)"
        }
      ]
    }
  ]
}
```

---

## Required report fields

Each report must include these fields:

```text
材料インパクト
事業概要
足元材料
ファンダ要点
注意点
開示リンク
Sources
```

`材料インパクト` must start with one of:

```text
ポジティブ材料
ネガティブ材料
様子見
混在/要確認
```

The worker uses `材料インパクト` to sort embeds and choose the embed color. It is
mandatory and must not be phrased as a buy/sell recommendation.

It must use this format:

```text
ラベル：根拠要約
```

The field must not be just `ポジティブ材料`, `ネガティブ材料`, `様子見`, or
`混在/要確認`. Add one concise source-grounded sentence after the full-width
colon, for example:

```text
ポジティブ材料：2026年3月期は売上高9,835百万円、経常利益458百万円、当期純利益441百万円と増収増益で、繰延税金資産計上も最終利益を押し上げている。
```

---

## Narrative writing rules

Write the narrative report body in Japanese.

The following fields must be Japanese text and must not be too terse:

```text
事業概要
足元材料
ファンダ要点
注意点
```

Keep each narrative field to roughly two short sentences, adding
source-grounded figures, dates, business drivers, or confirmation points where
available while staying concise enough for Discord embeds.

Do not use boilerplate that could be copied across symbols.

`事業概要` must name the actual business model, core product/service, customer
segment, or revenue driver for that company.

Do not write generic company overviews such as:

```text
開示資料で確認できる主要サービス・製品を中心に事業を展開する上場企業
直近の材料は、売上成長、利益率、資本政策、事業提携のどれに効くか
```

`足元材料` should read like a compact event timeline:

```text
newest fundamentally material disclosure date
↓
material event
↓
key figure where available
↓
why it matters for that company
```

Do not lead with:

```text
official IR/IRBANK was checked for 45 days
```

when a usable disclosure exists.

Put sparse-disclosure caveats in `注意点` only when needed.

Avoid repeating the same sentence in `足元材料` and `ファンダ要点`.

`ファンダ要点` must choose the relevant KPI/accounting line rather than list
generic categories.

Examples:

- ARR / churn / ARPU for SaaS
- same-store sales and gross margin for retail
- order backlog and utilization for manufacturers
- dilution and exercise pace for warrants
- occupancy and funding terms for facility operators
- sales volume, material spread, inventory valuation, and plant utilization for manufacturers

`注意点` must name the company-specific uncertainty.

Do not rely on generic caveats such as:

```text
開示単体では金額、契約期間、希薄化、一過性の区別が十分に読み切れない
```

unless the sentence immediately explains which issue applies and why.

---

## Disclosure search rules

Before deciding that timely disclosures are unconfirmed, scan both:

- the company's official IR/news disclosure list
- an IRBANK/TDnet-style disclosure list

Check at least:

```text
45 days before the alert receivedAt
plus any newer items visible during the run
```

Do not treat the following as enough:

```text
no earnings release
no guidance revision
```

Non-earnings disclosures can be the main material when they are fundamentally
important.

Examples:

- warrant exercise / transfer
- M&A progress
- headquarters relocation
- capital allocation
- shareholder-return policy update
- business progress disclosure
- monthly sales data
- asset-sale or special-gain notice
- governance or regulatory disclosure

If a newer quarterly result, monthly data, guidance revision, asset-sale or
special-gain notice, shareholder-return policy update, or other current IR
library item exists, use that newer fundamentally material disclosure before
relying on an older annual earnings presentation.

If a company genuinely has very few disclosures, an older official disclosure
may be used only after the report explicitly states that official IR and IRBANK
checks found no newer individual/timely fundamentally material disclosure in the
required window.

Do not use proxy materials as `開示リンク`.

Proxy materials include:

- company research reports
- new-listing reports
- interview articles
- media clippings
- sponsored research reports

Treat them as background sources only.

---

## 開示リンク rules

Use direct disclosure URLs only in `開示リンク`.

Allowed examples:

```text
direct PDF URLs
TDnet td_download.cgi file URLs
direct IRBANK f.irbank.net/pdf/...pdf URLs
direct IRBANK f.irbank.net/pr/...pdf URLs
individual company/PR disclosure detail pages when no direct PDF exists
```

Do not impose a one-link limit.

Include every recent important disclosure used to write:

```text
足元材料
ファンダ要点
注意点
```

For example, include all of these when they are used:

- quarterly result
- guidance revision
- buyback update
- dividend / capital-policy notice
- M&A / alliance disclosure
- asset-sale / special-gain notice
- monthly data
- governance / regulatory release

Keep weak background pages out of `開示リンク`.

Every `開示リンク` label must be formatted as:

```text
YYYY-MM-DD 開示タイトル(hh:mm)
```

Example:

```text
[2026-05-14 剰余金の配当に関するお知らせ(15:30)](https://f.irbank.net/pdf/20260514/140120260514534210.pdf)
```

If two URLs point to the same disclosure content, keep only one line even when
the URLs are different. Treat matching TDnet/IRBANK document IDs, matching PDF
files, or exactly matching disclosure titles at the same date/time as the same
content. Prefer direct `f.irbank.net` PDF/PR URLs over IRBANK HTML pages or
secondary mirrored URLs.

If no direct disclosure URL is verified, use:

```text
開示リンク未確認
```

IRBANK HTML pages such as:

```text
https://irbank.net/<code>/<document_id>
```

are accepted only as an input fallback.

When the IRBANK HTML page exposes or corresponds to:

```text
https://f.irbank.net/pdf/...pdf
https://f.irbank.net/pr/...pdf
```

the outgoing embed should use the direct `f.irbank.net` file URL, not the
IRBANK HTML page.

Wrong:

```text
https://irbank.net/3910/140120260204547074#google_vignette
```

Correct:

```text
https://f.irbank.net/pdf/20260204/140120260204547074.pdf
```

---

## Sources rules

Use reference page URLs only in `Sources`.

Allowed examples:

- company IR pages
- company disclosure-list pages
- IRBANK disclosure-list pages
- news pages
- business/profile pages
- other reputable grounding webpages

Do not put the following in `Sources`:

- direct PDFs
- TDnet file URLs
- IRBANK individual disclosure pages
- individual PR/disclosure detail pages

Those direct disclosure links belong only in `開示リンク`.

---

## Markdown link label rules

Markdown link labels should use the actual page or document title as closely as
possible.

Good examples:

```text
[2026-05-14 2026年３月期 第３四半期決算短信〔日本基準〕（連結）(15:30)](https://f.irbank.net/pdf/...)
[2026-05-14 配当予想の修正（増配・特別配当）に関するお知らせ(15:30)](https://f.irbank.net/pdf/...)
[銘柄名（1234）のIR情報・決算資料 | IRBANK](https://irbank.net/1234/ir)
[銘柄名 IRニュース](https://www.example.co.jp/ir/news/)
```

Bad examples:

```text
[開示1](https://...)
[出典1](https://...)
[会社IR](https://...)
[Source1](https://...)
[PDF1](https://...)
```

Generic labels are rejected because readers cannot tell what they are opening.

---

## Prohibited wording

Do not include buy/sell recommendations, target prices, or any additional score.

Avoid wording such as:

```text
買い推奨
売り推奨
買うべき
売るべき
目標株価
利確
損切り
追加採点
スコア: 5
5点満点
```

The report is a premium fundamental snapshot, not investment advice.

---

## Lock-before command

`lock-before` is a local state maintenance command.

It reads `alerts_raw` with Sheets read-only access and marks every alert ID with
`received_at` on or before the given JST date as locked in
`premium_worker/state/`.

It does not write to the spreadsheet.

Example:

```powershell
node premium_worker/worker.mjs lock-before --date 2026-04-30
```

or, from inside `premium_worker/`:

```powershell
node worker.mjs lock-before --date 2026-04-30
```

---

## Premium log behavior

When `PREMIUM_LOG_SPREADSHEET_ID` is set, `post` writes premium log rows to that
separate spreadsheet in one batch per run and retries transient Google Sheets
429/5xx responses.

Discord posting is still treated as the primary delivery path.

Log write failures are reported as warnings so a rate-limit on the log
spreadsheet does not duplicate or block alert posts.

Posted rows write the `材料インパクト` value to the one-line `reason` summary.
Because `材料インパクト` must already be `ラベル：根拠要約`, the log reason does not
append `ファンダ要点`.

When Discord returns a message URL, that summary is stored as a Markdown link to
the posted analysis.

---

## Safety notes

This worker must stay separate from the existing GAS project.

Do not edit:

```text
gas.txt
```

Do not modify GAS triggers.

Do not write to the existing spreadsheet.

Do not use `PREMIUM_LOG_SPREADSHEET_ID` with the same spreadsheet ID as
`PREMIUM_SPREADSHEET_ID`.
