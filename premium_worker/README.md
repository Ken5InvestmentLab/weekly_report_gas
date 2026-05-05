# Premium Alert Worker

This worker is intentionally separate from the existing GAS project.
It does not edit `gas.txt`, does not call GAS functions, and does not write to
the existing spreadsheet. It reads `alerts_raw`, lets Codex research a short
fundamental snapshot, then posts a Discord Embed to the premium channel.

## Required setup

1. Create a Google Cloud service account with Google Sheets API enabled.
2. Share the target spreadsheet with the service account email as **Viewer**.
3. Copy `.env.example` to `premium_worker/.env` and set:
   - `PREMIUM_SPREADSHEET_ID`
   - `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_SERVICE_ACCOUNT_JSON`
   - `DISCORD_PREMIUM_WEBHOOK_URL`
4. Keep `premium_worker/.env`, credentials, `premium_worker/state/`, and
   `premium_worker/out/` untracked.

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

## Optional spreadsheet log

By default, this worker records posted/failed alerts only in
`premium_worker/state/`. If you want a spreadsheet log, set
`PREMIUM_LOG_SPREADSHEET_ID` to a separate spreadsheet ID and share that log
spreadsheet with the service account as **Editor**.

The worker will create/update `premium_alert_log`. Rows older than
`PREMIUM_LOG_RETENTION_DAYS` are deleted automatically before new log rows are
appended.

For safety, `PREMIUM_LOG_SPREADSHEET_ID` must be different from
`PREMIUM_SPREADSHEET_ID`.

## Commands

```powershell
node premium_worker/worker.mjs collect
node premium_worker/worker.mjs post --input premium_worker/out/premium_reports.json
node premium_worker/worker.mjs fail --alert-id ALERT_ID --reason "insufficient sources"
node premium_worker/worker.mjs lock-before --date 2026-04-30
node premium_worker/worker.mjs status
node premium_worker/worker.mjs self-test
```

`collect` runs only at the allowed JST slots by default. Use `--force` for a
manual test. The default slots are `13:05` and `15:36` JST on weekdays. The
default signal filter is `BOTTOM`, and already-posted alert IDs are never
selected again. The same symbol may be selected again when TradingView creates
a different alert ID.

By default, `PREMIUM_MAX_ALERTS_PER_RUN=0` and `PREMIUM_SCAN_MAX_ROWS=0`, so
the worker scans all rows and claims every unsent matching alert ID. Set
positive values only when intentionally capping a manual run.

`lock-before` is a local state maintenance command. It reads `alerts_raw` with
Sheets read-only access and marks every alert ID with `received_at` on or before
the given JST date as locked in `premium_worker/state/`, without writing to the
spreadsheet.

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
        { "name": "材料インパクト", "value": "ポジティブ材料: 会社開示で確認できる増益要因。" },
        { "name": "事業概要", "value": "..." },
        { "name": "足元材料", "value": "..." },
        { "name": "ファンダ要点", "value": "..." },
        { "name": "注意点", "value": "..." },
        { "name": "開示リンク", "value": "[決算短信](https://...)" },
        { "name": "Sources", "value": "[会社IR](https://...)\n[TDnet](https://...)" }
      ]
    }
  ]
}
```

The worker normalizes TradingView embed titles to
`銘柄名 (証券コード) | TradingView チャート` when `symbolName` and
`symbolCode` are present. Write the narrative report body in Japanese; `post`
rejects reports whose `事業概要`, `足元材料`, `ファンダ要点`, or `注意点`
fields are not Japanese text or are too terse to be useful as analysis. Keep
each narrative field to roughly two short sentences, adding source-grounded
figures, dates, business drivers, or confirmation points where available while
staying concise enough for Discord embeds.
Use direct disclosure file URLs only in `開示リンク` (PDF URLs or TDnet
`td_download.cgi` file URLs). Use reference page URLs only in `Sources`:
company IR pages, disclosure-list pages, news pages, profile pages, or other
grounding webpages. Do not put direct PDF or other direct file URLs in
`Sources`; if no direct disclosure file is verified, use `開示リンク未確認`.
Markdown link labels should use the actual page or document title as closely as possible, such as
`2026年３月期 第３四半期決算短信〔日本基準〕（連結）` or
`配当予想の修正（増配・特別配当）に関するお知らせ`. Generic labels like
`開示1`, `出典1`, `会社IR`, `Source1`, or `PDF1` are rejected because readers
cannot tell what they are opening.

Do not include buy/sell recommendations, target prices, or any additional
score. If no disclosure link can be verified, set `開示リンク` to
`開示リンク未確認`.

`材料インパクト` is optional. Use it only as a source-grounded material impact
label such as `ポジティブ材料`, `ネガティブ材料`, `様子見`, or `混在/要確認`.
The worker uses it to sort embeds and choose the embed color, but it must not
be phrased as a buy/sell recommendation.
