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

## Commands

```powershell
node premium_worker/worker.mjs collect
node premium_worker/worker.mjs post --input premium_worker/out/premium_reports.json
node premium_worker/worker.mjs fail --alert-id ALERT_ID --reason "insufficient sources"
node premium_worker/worker.mjs status
node premium_worker/worker.mjs self-test
```

`collect` runs only at the allowed JST hours by default. Use `--force` for a
manual test. The default allowed hours are `14,16`, so an hourly Codex
automation can wake up every hour and exit immediately outside those hours.

## Report JSON shape

Codex should create `premium_worker/out/premium_reports.json` like this:

```json
{
  "reports": [
    {
      "alertId": "example-alert-id",
      "title": "銘柄名（1234）｜Premium Snapshot",
      "url": "https://www.tradingview.com/chart/?symbol=TYO%3A1234",
      "fields": [
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

Do not include buy/sell recommendations, target prices, or any additional
score. If no disclosure link can be verified, set `開示リンク` to
`開示リンク未確認`.
