# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## プロジェクト概要

天底極致スコアリングBot の週次レポート・OHLCV管理を担う Google Apps Script (GAS) プロジェクト。

TradingView からのアラート Webhook を受信し、JPX銘柄の中期パフォーマンス（5/10/20/40営業日後）を `alerts_raw` で追跡する。OHLCVは Yahoo Finance 1h 足から前場AM/後場PMの4時間足相当へ集約し、Discordへ週次レポートを送信する。

主な役割は以下。

- TradingView Webhook 受信
- `alerts_raw` へのアラート記録
- `ohlcv_4h` への前場AM/後場PM OHLCV保存
- 5/10/20/40営業日後の評価更新
- Discord週次レポート送信
- 完了済みシグナルの `signals_archive` 退避
- 古いOHLCV/アーカイブの削除
- GAP修復、空timestamp/不正timestamp整理
- プレミアム通知worker用の読み取り元提供

## 最重要ルール

- 既存GAS本体の安定稼働を最優先する。
- `doPost`、`alerts_raw` スキーマ、既存トリガー、既存スクリプトプロパティ名を不用意に変更しない。
- `alerts_raw` はヘッダー4行目、データ5行目。
- `ohlcv_4h` はヘッダー1行目、データ2行目。
- `ohlcv_4h` の timestamp は原則 `09:00 JST` または `13:00 JST` のみ。
- `ohlcv_4h` は A列 timestamp 昇順が前提。
- OHLCV行の重複判定は `timestamp + symbol`。
- 空timestampや `09:00` / `13:00` 以外のtimestampを既存行から推定補正しない。
- 修復時は、不正行を削除し、対象銘柄を `OHLCV_REPAIR_SYMBOLS` に積んで正規取得で補填する。
- GAP修復・監査・削除系で `ohlcv_4h` 全行読み込みを増やさない。
- 時間主導トリガーでは `SpreadsheetApp.getActiveSpreadsheet()` に依存しない。必ず `SPREADSHEET_ID` から `SpreadsheetApp.openById()` する。
- 長時間処理は、再開トリガーとスクリプトプロパティで再開可能にする。
- デバッグログは原則 `console.log`。`debug_webhook` シートへ新規書き込みしない。
- 投資助言・売買推奨・目標株価・スコア化に見える文言を追加しない。

## OHLCV取得の重要ルール

通常のOHLCV取得窓は `buildOhlcvRequestPairForEndMillis_()` で決定する。

基準値。

```javascript
OHLCV_DEFAULT_LOOKBACK_DAYS = 120
RECENT_RANGE_DAYS = 7
OVERLAP_DAYS = 3
```
## プレミアム通知 worker

`premium_worker/` は既存GAS本体から独立した Codex automation 用の読み取り専用worker。

### 変更禁止・保護方針

- プレミアム通知対応では、既存機能保護を最優先する。
- `gas.txt` / `doPost` / 既存トリガー / `alerts_raw` スキーマを変更しない。
- workerは Google Sheets API で `alerts_raw` を読むだけにする。
- 投稿済み状態は `premium_worker/state/` に保存する。
- 生成中ファイルは `premium_worker/out/` に保存する。
- `premium_worker/state/` と `premium_worker/out/` は git 管理しない。

### プレミアム投稿ログ

- プレミアム投稿ログをスプレッドシートへ残す場合は、`PREMIUM_LOG_SPREADSHEET_ID` を使う。
- `PREMIUM_LOG_SPREADSHEET_ID` は既存GAS対象とは別スプレッドシートにする。
- 古いログはworker側で自動削除する。
- Discord投稿ごとにSheets APIへ個別書き込みしない。
- 1回のworker実行分をまとめて追記する。
- Sheets 429/5xx はバックオフして再試行する。
- ログ記録は補助経路なので、ログ用Sheetsの429でDiscord投稿を二重化・中断しない。

### 起動時間・claimルール

- Codex automation は JST `13:00-13:10` と `15:30-15:40` の許可窓で起動する。
- worker側の時間ゲート既定値:
  - `PREMIUM_ALLOWED_JST_HOURS=13,15`
  - `PREMIUM_ALLOWED_JST_MINUTES=13:00-13:10,15:30-15:40`
- 対象時間以外は即終了する。
- 抽出対象は既定で `signal_type=BOTTOM`。
- `received_at` 新しい順で処理する。
- ロック粒度はシンボルではなく `alert_id` 単位。
- 同一シンボルでも別 `alert_id` は別アラートとして扱う。
- 一度投稿または手動ロックした `alert_id` は再選択しない。
- 既定では `PREMIUM_MAX_ALERTS_PER_RUN=0` / `PREMIUM_SCAN_MAX_ROWS=0` とし、全行を読み込んで未送信対象をすべてclaimする。
- 正の値は手動テストなど、意図的に件数制限したい場合だけ使う。
- `collect` が `claimedCount: 0` の場合は何も投稿しない。
- `post` はアクティブなclaimが残っている `alert_id` だけをDiscord投稿対象にする。
- 古い `premium_reports.json` や投稿済み `alert_id` はskipして再投稿しない。

### プレミアムEmbed・分析ルール

- TradingViewリンクはJPX銘柄でも `TSE:{code}` を使う。`TYO:` は開けない銘柄がある。
- タイトルはチャートリンクだと分かる文言にする。
- プレミアム分析は決算だけに限定しない。
- 対象材料:
  - 業績修正
  - 自社株買い
  - 配当/資本政策
  - 中計
  - M&A
  - 業務提携
  - 大型契約
  - 新株予約権の行使/譲渡
  - 資金使途
  - 本店移転
  - 規制/ガバナンス
  - その他、検証できる適時材料
- `開示リンク未確認` や材料なし判断の前に、公式IR/ニュース一覧と IRBANK/TDnet系一覧を少なくとも `received_at` 前45日分確認する。
- 実行時に見える新しい開示も確認対象に含める。
- 公式IRライブラリに新しい四半期決算、月次、業績予想修正、固定資産譲渡/特別利益、株主還元方針などがある場合は、古い年度決算説明資料だけで足元材料を作らない。
- `材料インパクト` は根拠付きの以下いずれかに留める。
  - `ポジティブ材料`
  - `ネガティブ材料`
  - `様子見`
  - `混在/要確認`
- 売買推奨・目標株価・スコア化はしない。

### 開示リンクルール

- プレミアムEmbedの `開示リンク` は、資料または開示への直リンクだけにする。
- 許可する例:
  - PDF直リンク
  - TDnet `td_download.cgi`
  - IRBANK個別開示ページ
  - 会社/PRの個別開示詳細ページ
- IR一覧・会社概要・ニュース一覧などの参照ページは `Sources` に分ける。
- `開示リンク` は1件に制限しない。
- `足元材料` / `ファンダ要点` / `注意点` の分析に使った直近重要開示は、検証できた分を漏れなく載せる。
- リンクラベルは `開示1` / `出典1` / `会社IR` のような汎用名にしない。
- 実際の資料タイトルまたはページタイトルにする。
- IRBANK個別開示ページ内に `f.irbank.net/pdf/...pdf` または `f.irbank.net/pr/...pdf` が確認できる場合はPDF直リンクを優先する。
- `https://irbank.net/{code}/{documentId}` より、確認できるなら `https://f.irbank.net/pdf/{yyyymmdd}/{documentId}.pdf` 形式を優先する。
- 本文は日本語で、各分析欄に日付・数値・事業ドライバー・確認点を含める。
- 1行メモのような薄い要約にしない。
- `足元材料` は調査ログや開示タイトルの羅列ではなく、最新重要開示の日付・材料・数値・確認点を短い時系列で書く。
- `足元材料` と `ファンダ要点` で同じ文を繰り返さない。
- プレミアム分析文は銘柄名だけ差し替えられる汎用テンプレにしない。
- `事業概要` は実際の事業・主力サービス・顧客層を書く。
- 「開示資料で確認できる主要サービス・製品を中心に事業を展開する上場企業」「売上成長、利益率、資本政策、事業提携のどれに効くか」のような実体説明を避けた文は禁止。
- `足元材料` は、その開示が当該銘柄のどのKPIやリスクに効くかを書く。
- `ファンダ要点` は銘柄実態に合う指標を書く。
  - ARR
  - 解約率
  - ARPU
  - 既存店売上
  - 粗利率
  - 受注残
  - 稼働率
  - 新株予約権の行使ペース/希薄化
  - 施設稼働率
  - 借入条件
  - その他、銘柄固有の重要KPI
- `注意点` は開示固有の未確認点を書く。
  - 希薄化
  - 契約金額
  - 稼働率
  - 受注残
  - 統合費用
  - ガバナンス
  - その他、開示に応じた確認点
- 開示が本当に少ない銘柄では、公式IR/IRBANKを確認したうえで新しい個別開示がないことを本文に明記すれば、古い公式開示を補助的に `開示リンク` へ置いてよい。
- 調査/フォローアップ/新規上場レポート、社長名鑑、媒体記事などの代理資料を足元材料の代替として `開示リンク` に置かない。
- POSTEDログの `Reason` は空欄にしない。
- `Reason` には `材料インパクト` とファンダ要点から一文総評を残す。
- Discord投稿URLが取得できた場合、プレミアムログの `Reason` は一文総評をMarkdownリンク化して記録する。

## デプロイ・実行方法

- GASプロジェクトは Google Apps Script エディタ上で管理する。
- ローカルに clasp を使う場合:
  - `clasp push` でデプロイ
  - `clasp pull` で取得
- トリガー再設定:
  - `setupAllTriggers()` を手動実行
- 旧スキーマ移行:
  - `migrateCurrentSchemaToMidtermTracking_()` を手動実行
- `setupAllTriggers()` は既存プロジェクトトリガーを全削除して固定トリガーだけ再登録する。動的な再開トリガー実行中に不用意に実行しない。

## 固定トリガー一覧

`setupAllTriggers()` で登録される固定トリガー。

| 関数 | スケジュール | 役割 |
|---|---:|---|
| `buildAndSendWeeklyReport` | 土曜 9:05 JST | 週次レポート送信 |
| `syncMarketHolidays` | 毎月1日 3:10 JST | 内閣府祝日CSV + JPX年末年始休場日を同期 |
| `fetchOHLCVForNewAlertsMidday` | 毎日 13:30 JST | 当日AM分までのOHLCV先行取得。後続チェーンなし |
| `fetchOHLCVForNewAlerts` | 毎日 16:00 JST | OHLCV本番取得 → 日次メンテ → GAP修復チェーン |
| `purgeOldOhlcvDataDaily` | 毎日 2:00 JST | 365日超の古いOHLCV削除 |
| `purgeOldSignalArchiveRowsDaily` | 毎日 2:10 JST | `signals_archive` の保持期限超過データ削除 |

## 動的ワンショットトリガー

`setupAllTriggers()` には含めない。各処理が必要に応じて作成・削除する。

| ハンドラー関数 | 生成元 | 役割 |
|---|---|---|
| `sendDeferredDiscordPayload` | Discord 429 レート制限時 | 延期したDiscordペイロードを再送 |
| `runDailyMaintenanceTrigger` | OHLCV PHASE4完了後 | `runDailyMaintenance` を起動 |
| `quickRepairTrigger` | `runDailyMaintenance` 完了後 / cleanup完了後 | `quickRepairRecentGaps` を起動 |
| `resumeOHLCVFetchMidday` | 13:30先行OHLCV取得の再開時 | `fetchOHLCVForNewAlertsMidday` を再起動 |
| `resumeOHLCVFetch` | 16:00 OHLCV本番取得の再開時 | `fetchOHLCVForNewAlerts` を再起動 |
| `resumeDailyMaintenance` | 日次メンテナンス再開時 | `runDailyMaintenanceInternal_` を再開 |
| `resumeQuickRepair` | GAP修復再開時 | `quickRepairRecentGaps` を再開 |
| `purgeOldOhlcvResumeTrigger` | OHLCV削除未完了時 | `purgeOldOhlcvDataDaily` を再開 |
| `resumeCleanupLegacyGapFailedAndEmptyTimestamps` | 旧OHLCV残骸整理未完了時 | 空timestamp・非09:00/13:00・長期GAP_FAILED整理を再開 |
| `resumeEvaluationOhlcvCoverageRepair` | 評価対象銘柄の120日OHLCV補填未完了時 | `repairEvaluationOhlcvCoverage120` を再開 |
| `resumeHistoricalOhlcvVolumeRepair` | 過去OHLCV出来高補正未完了時 | `repairHistoricalOhlcvVolumes` を再開 |

重要: ワンショットトリガーのラッパー関数は、冒頭で `deleteTriggersByHandler_("自分の関数名")` を呼び、自分自身のトリガーを削除してから本体処理を呼ぶ。

## スプレッドシート構造

| シート名 | 役割 |
|---|---|
| `alerts_raw` | Webhookで受信したアラートと評価結果。ヘッダー4行目、データ5行目 |
| `ohlcv_4h` | 前場AM/後場PMの4時間足相当OHLCV。ヘッダー1行目、データ2行目 |
| `alerts_report` | 週次レポートのアーカイブ |
| `market_holidays` | 日本市場の休場日。内閣府祝日CSV + JPX年末年始休場日 |
| `signals_archive` | 完了済みシグナルの退避先。`RAW_HEADERS + archived_at` |
| `debug_webhook` | 旧デバッグログシート。現在は未使用。GASから書き込まない |

### `alerts_raw`

ヘッダーは `RAW_HEADERS`。

```text
alert_id, received_at, signal_date, signal_week_start, signal_type,
timeframe, symbol_code, symbol_name, entry_price, volume, tv_symbol,
eval_date_5bd, eval_close_5bd, perf_5bd, win_flag_5bd, reported_5bd,
eval_date_10bd, eval_close_10bd, perf_10bd, win_flag_10bd, reported_10bd,
eval_date_20bd, eval_close_20bd, perf_20bd, win_flag_20bd, reported_20bd,
eval_date_40bd, eval_close_40bd, perf_40bd, win_flag_40bd, reported_40bd,
status, note, logged_at
```

### `ohlcv_4h`

基本列。

```text
timestamp, alert_id, symbol, open, high, low, close, volume
```

重要な保存ルール。

- timestamp は `09:00 JST` または `13:00 JST`。
- `09:00 JST` はAM代表行。
- `13:00 JST` はPM代表行。
- B列 `alert_id` には通常取得、`MIDDAY_yyyy-mm-dd`、`GAP_REPAIR` などのマーカーが入る。
- 重複排除は `timestamp + symbol`。
- 最終状態は必ず timestamp 昇順へ戻す。

## スクリプトプロパティ

### 必須・外部連携

| キー | 必須 | 用途 |
|---|---:|---|
| `SPREADSHEET_ID` | ✅ | 対象スプレッドシートID |
| `GAS_SHARED_SECRET` | ✅ | Webhook署名検証用の共有シークレット |
| `DISCORD_STATS_WEBHOOK_URL` | ✅ | 週次レポート送信先Discord Webhook |
| `DISCORD_WEBHOOK` | ✅ | OHLCV完了通知先Discord Webhook |
| `GITHUB_PAT` | 任意 | `Ken5InvestmentLab/screening-bot` の `optimize.yml` dispatch 用 |
| `OHLCV_VERBOSE_FETCH_LOGS` | 任意 | `true` のとき銘柄別OHLCV取得ログを詳細出力 |

### 内部状態

| キー | 用途 |
|---|---|
| `LAST_WEEKLY_REPORT_WEEK` | 週次レポート重複送信防止 |
| `VARIANT_HISTORY_V1` | 週次レポート文言の直近履歴 |
| `DEFERRED_DISCORD_PAYLOAD` | Discord 429時の延期ペイロード |
| `OHLCV_CURRENT_PHASE` | 16:00 OHLCV本番取得フェーズ |
| `OHLCV_PROGRESS_INDEX` | 16:00 OHLCV本番取得の再開カーソル |
| `OHLCV_SYMBOL_LIST` | 16:00 OHLCV本番取得対象銘柄 |
| `OHLCV_NEW_ALERT_COUNT` | 16:00 OHLCV本番取得時の当日シグナル銘柄数 |
| `CURRENT_REFRESH_ID` | 現在のOHLCV取得ID |
| `LAST_TS_MAP` | 銘柄別最終timestamp |
| `SYNC_ENTRY_PRICE_INDEX` | entry_price 同期処理用カーソル |
| `SPLIT_QUEUE` / `SPLIT_INDEX` | 株式分割調整キュー |
| `OHLCV_SPLIT_CACHE` | 株式分割情報キャッシュ |
| `OHLCV_TRACE_LAST` | OHLCVトレース用 |
| `OHLCV_REPAIR_SYMBOLS` | 次回120日再取得する修復対象銘柄 |
| `OHLCV_MANUAL_BUSINESS_DATE` | 手動基準日 |
| `OHLCV_MANUAL_BUSINESS_EXPIRES_AT` | 手動基準日の期限 |
| `OHLCV_MIDDAY_PROGRESS_INDEX` | 13:30先行取得の再開カーソル |
| `OHLCV_MIDDAY_SYMBOL_LIST` | 13:30先行取得対象銘柄 |
| `OHLCV_MIDDAY_NEW_ALERT_COUNT` | 13:30先行取得時の当日シグナル銘柄数 |
| `OHLCV_MIDDAY_LAST_TS_MAP` | 13:30先行取得用の銘柄別最終timestamp |
| `OHLCV_MIDDAY_REFRESH_ID` | 13:30先行取得ID |
| `OHLCV_MIDDAY_FULL_BACKFILL_SYMBOLS` | 13:30で120日取得する真の新規銘柄 |
| `DAILY_MAINT_CURSOR` | 日次メンテナンス再開カーソル |
| `DAILY_MAINT_NEW_COUNT` | 日次メンテナンス用の新規件数メタ |
| `DAILY_MAINT_REFRESH_ID` | 日次メンテナンス用の取得IDメタ |
| `QUICK_REPAIR_STATE` | GAP修復の再開状態。v6 |
| `QUICK_REPAIR_TAIL_CLEANUP_STATE` | GAP修復入口の末尾不正timestamp掃除状態 |
| `CLEANUP_LEGACY_STATE_V1` | 旧OHLCV残骸整理の再開状態 |
| `CLEANUP_LEGACY_AUTO_QUICK_REPAIR_V1` | cleanup完了後に `quickRepairTrigger` を予約するためのフラグ |
| `EVAL_OHLCV_COVERAGE_REPAIR_STATE_V1` | 評価対象銘柄120日OHLCV補填の再開状態 |
| `HISTORICAL_VOLUME_REPAIR_STATE_V1` | 過去OHLCV出来高補正の再開状態 |

## アーキテクチャ

### Webhook受信

`doPost(e)` が入口。

- `Content-Type: application/json` のみ受理。
- envelope形式を受け取る。
- `v1.{timestamp}.{payloadJson}` を HMAC-SHA256 で署名検証する。
- クロックスキューは ±4.5分以内。
- `alert` 単体または `alerts` 配列を受け取る。
- JPXらしいコードだけを対象にする。
- `alert_id` で重複排除する。
- `alerts_raw` に安全追記する。

### 週次レポート

主な関数。

- `buildAndSendWeeklyReport()`
- `buildAndSendWeeklyReportManual()`
- `previewWeeklyReportThisWeek()`

仕様。

- BOTTOMシグナルのみ集計対象。
- 評価地点は `CHECKPOINTS` の 5/10/20/40営業日。
- `reported_Xbd=true` は通常レポート対象から除外。
- 手動送信では `ignoreReported=true` / `markReported=false`。
- DiscordにはEmbedで送信。
- Discord 429時は `sendDeferredDiscordPayload` へ延期可能。
- `alerts_report` にレポート内容を保存。
- 完了済みraw行は `signals_archive` へ退避後、rawから削除する。

### 日次処理チェーン

13:30 と 16:00 は役割が異なる。

#### 13:30: `fetchOHLCVForNewAlertsMidday`

13:30はAM先行取得だけを行う。

- 当日が休場日の場合はスキップ。
- 16:00本番処理が近い場合は再開せず終了。
- 対象銘柄は `alerts_raw` に登場する全銘柄。
- 今日シグナルが出た銘柄数はメタ情報として `OHLCV_MIDDAY_NEW_ALERT_COUNT` に保持。
- OHLCV未取得銘柄だけ120日分取得。
- 既存OHLCVがある銘柄は `lastTs` 以降だけ差分取得。
- fetch終端は当日AM分まで。
- 当日PM行や14:00以降のYahoo足、15:30終値スナップショットは保存しない。
- 完了時は `dedupeAndSortOhlcv_()` で `ohlcv_4h` を timestamp 昇順へ戻す。
- 日次メンテナンス、GitHub Actions、GAP修復には進まない。
- 完了通知のみ送る。

#### 16:00: `fetchOHLCVForNewAlerts`

16:00が本番チェーンの起点。

```text
fetchOHLCVForNewAlerts
  → PHASE1: OHLCV取得
  → PHASE2: 株式分割検出・価格調整
  → PHASE3: 分割調整キュー適用
  → PHASE4: 重複排除・ソート・完了通知
    → runDailyMaintenanceTrigger
      → runDailyMaintenance
        → quickRepairTrigger
          → quickRepairRecentGaps
```

16:00開始時のルール。

- 残っている `resumeOHLCVFetchMidday` を削除。
- 13:30専用プロパティをクリア。
- 13:30で書き込まれたOHLCV行はシート上の成果として引き継ぐ。
- 16:00側で通常どおり再取得・重複排除する。
- 当日が休場日の場合はスキップ。
- 対象銘柄は `alerts_raw` に登場する全銘柄 + `OHLCV_REPAIR_SYMBOLS`。
- OHLCV未取得銘柄は120日分取得。
- `OHLCV_REPAIR_SYMBOLS` の銘柄は120日分強制再取得。
- 既存銘柄は `lastTs` 以降だけ差分取得。

### OHLCV取得フェーズ

| フェーズ | 内容 |
|---|---|
| `PHASE1` | Yahoo Finance 1h足からOHLCV取得 |
| `PHASE2` | 株式分割検出・価格調整 |
| `PHASE3` | 分割調整キューを `ohlcv_4h` に適用 |
| `PHASE4` | 重複排除・timestamp昇順ソート・完了通知・日次メンテ予約 |

通常の未指定取得窓は `OHLCV_DEFAULT_LOOKBACK_DAYS = 120` 日。

120日より古い補填は通常処理に混ぜず、以下のような手動補填関数で銘柄・期間を明示して実行する。

```javascript
refetchSymbolGap(symbol, startDate, endDate)
refetchSymbolRange(symbols, startDate, endDate)
```

### Yahoo Finance 1h足の集約ルール

- Yahoo Finance 1h足のtimestampは区間開始時刻として扱う。
- AMバケット:
  - 生1h足の `09:00` / `10:00` / `11:00` / `12:00` をマージ
  - シートtimestampは `09:00 JST`
- PMバケット:
  - 生1h足の `13:00` / `14:00` / `15:00` と `15:30` 終値スナップショットを使う
  - シートtimestampは `13:00 JST`
- Yahoo生1hの `13:00` 足はPM開始側であり、AMへ混ぜない。
- `15:30 JST` の `volume=0` かつ `O=H=L=C` バーは後場の終値スナップショットとして扱う。
- 終値スナップショットはPMバケットの `close` だけを更新し、`open/high/low/volume` には混ぜない。
- 通常取得・GAP修復・過去出来高補正では Yahoo Finance の `1h` を主に使う。
- `1d` はデバッグや分割情報確認など必要な場合に限る。

### 日次メンテナンス

主な関数。

- `runDailyMaintenance()`
- `resumeDailyMaintenance()`
- `runDailyMaintenanceTrigger()`

役割。

- 評価日を迎えた `alerts_raw` 行を更新。
- 5/10/20/40営業日後の評価価格、騰落率、勝敗を埋める。
- 全チェックポイントが埋まると `status=COMPLETE`。
- 完了後にDiscord通知。
- `GITHUB_PAT` があれば `Ken5InvestmentLab/screening-bot` の `optimize.yml` を起動。
- 完了後に `quickRepairTrigger` を1分後に予約。

### アーカイブ・削除

- BOTTOMの `COMPLETE` 行は `BOTTOM_COMPLETED_RETENTION_DAYS = 7` 日後に `signals_archive` へ退避し、`alerts_raw` から削除する。
- TOPの `COMPLETE` 行は `TOP_COMPLETED_RETENTION_DAYS = 30` 日後に退避する。
- `signals_archive` は `SIGNAL_ARCHIVE_RETENTION_DAYS = 365` 日保持。
- `ohlcv_4h` は365日超の古い行を `purgeOldOhlcvDataDaily()` で削除する。
- OHLCVは `alert_id` 単位で消さず、OHLCV側の365日保持に任せる。

### GAP修復

主な関数。

- `quickRepairRecentGaps()`
- `resumeQuickRepair()`
- `quickRepairTrigger()`
- `quickScanMissingSessions(daysBack, minSessions)`
- `auditGapRepairCoverage(daysBack, minSessions)`

仕様。

- `ohlcv_4h` 全行スキャンを避ける。
- A列 timestamp 昇順を前提に、直近範囲だけ読む。
- `quickScanMissingSessions()` で未処理のセッション不足だけを抽出する。
- 対象銘柄・対象日付グループだけ Yahoo Finance から再取得する。
- 取得は `UrlFetchApp.fetchAll` を使う。
- 進捗は `QUICK_REPAIR_STATE` v6 に保存する。
- 再開時は直近スキャンをやり直し、既に埋まったグループやマーカー付き未充足日は再取得対象から外す。
- 修復行はB列に `GAP_REPAIR` を入れる。
- `GAP_FAILED` は不足しているAM/PMセッションに対して `09:00 JST` / `13:00 JST` の実timestampを持つマーカー行として作る。
- 空timestamp、`00:00`、Yahoo生1h足時刻をマーカーとして保存しない。
- 時間切れで再開に回す直前にも `dedupeAndSortOhlcv_()` と `SpreadsheetApp.flush()` を実行する。

### 不正timestamp・GAP修復タイムアウト復旧

`resumeQuickRepair` / `quickRepairTrigger` がタイムアウトループになった場合、または `ohlcv_4h` に空timestamp・09:00/13:00以外のtimestampが混入した場合は、先に以下を実行する。

```javascript
emergencyStopQuickRepairAndCleanOhlcv()
```

この関数の役割。

- `resumeQuickRepair` / `quickRepairTrigger` を削除。
- `QUICK_REPAIR_STATE` を削除。
- `QUICK_REPAIR_TAIL_CLEANUP_STATE` を削除。
- `cleanupLegacyGapFailedAndEmptyTimestamps(false)` を本番実行。
- cleanupが複数回に分かれる場合は `resumeCleanupLegacyGapFailedAndEmptyTimestamps` で再開。
- cleanup完了後にだけ `CLEANUP_LEGACY_AUTO_QUICK_REPAIR_V1` を見て `quickRepairTrigger` を1分後に予約。

cleanup中に `quickRepairRecentGaps()` を直接起動しない。

### 空timestamp・不正timestamp整理

主な関数。

```javascript
repairEmptyTimestampRows(true)
repairEmptyTimestampRows(false)
cleanupLegacyGapFailedAndEmptyTimestamps(true)
cleanupLegacyGapFailedAndEmptyTimestamps(false)
```

ルール。

- `true` はDryRun。
- `false` は本番削除。
- 対象は空timestamp、09:00/13:00以外のtimestamp、長期滞留した `GAP_FAILED`。
- 削除した銘柄は `OHLCV_REPAIR_SYMBOLS` に積む。
- 次回OHLCV取得で120日分を再取得して補填する。
- 既存行のtimestampを推定で書き換えない。
- 例外として、`alert_id` が `MIDDAY_YYYY-MM-DD` に完全一致する行だけは、`YYYY-MM-DD 09:00 JST` を正しいtimestampとして自動補正してよい。

### 評価対象銘柄の120日OHLCV補填

主な関数。

```javascript
auditEvaluationOhlcvCoverage120()
repairEvaluationOhlcvCoverage120()
resumeEvaluationOhlcvCoverageRepair()
resetEvaluationOhlcvCoverageRepairState()
```

用途。

- 評価対象銘柄について、120日分のOHLCVセッション充足を監査・補填する。
- 通常OHLCV取得とは分けて再開可能にする。
- 進捗は `EVAL_OHLCV_COVERAGE_REPAIR_STATE_V1` に保存する。

### 過去OHLCV出来高補正

主な関数。

```javascript
previewHistoricalOhlcvVolumeRepair()
repairHistoricalOhlcvVolumes()
resumeHistoricalOhlcvVolumeRepair()
resetHistoricalOhlcvVolumeRepairState()
```

用途。

- 旧セッション境界で保存済みの過去OHLCV出来高を補正する。
- 再開可能バッチとして実行する。
- 進捗は `HISTORICAL_VOLUME_REPAIR_STATE_V1` に保存する。

## タイムアウト対策パターン

GASの実行上限は約6分。長時間処理は必ず再開可能にする。

### パターンA: 先行保険トリガー方式

例: `quickRepairRecentGaps`

1. 処理開始時に `resumeXxx` トリガーを先にセット。
2. 処理が正常完了したらトリガーを削除。
3. GASに強制終了されても自動再開される。
4. ロック取得前後、対象件数、バッチ進捗を `console.log` に出す。

### パターンB: 内部タイムリミット方式

例: `fetchOHLCVForNewAlerts`, `runDailyMaintenance`

1. 処理開始時に再開トリガーをセット。
2. 3.5〜4分経過で自発的に中断。
3. スクリプトプロパティに進捗保存。
4. 正常完了時は再開トリガーを削除。

## シート読み書きのベストプラクティス

- `getRange(row,col).getValue()` の大量ループは禁止。
- A列 timestamp の境界探索のような少数プローブに留める。
- データ本体は必要範囲を一括 `getValues()` で読む。
- 全行一括書き戻しは避ける。
- 変更した行のみ個別または小バッチで `setValues()` する。
- `ohlcv_4h` の先頭から連続削除する処理は `sheet.deleteRows(firstDataRow, N)` で行う。
- `ohlcv_4h` に追記する場合は `appendRowsToSheet_` を通す。
- 追記前にtimestampを `Date` に正規化する。
- 追記後は必要に応じて `dedupeAndSortOhlcv_()` で昇順 invariant を復元する。
- GAP修復・監査はA列 timestamp 昇順を前提に末尾から直近分だけを読む。
- `getRange(2, 1, lastRow - 1, ...)` の全行読みをGAP系に追加しない。
- 株式分割調整で `ohlcv_4h` を更新する場合は、C列 `symbol` を `TextFinder` などで絞って対象銘柄の行だけ処理する。
- 過去OHLCV全履歴補正のような大規模修復でも、実行冒頭に `ohlcv_4h` 全行を読んで対象マップを作らない。行チャンク単位で読み、チャンク内の銘柄を小分けfetchし、進捗をスクリプトプロパティに保存する。

## ログ方針

- `writeProcessLog_()` は `console.log` へ出す。
- `debugLogToSheet_()` は互換名だが、実装はコンソール出力のみ。
- `debug_webhook` シートへ書き込まない。
- 正常系ログは銘柄ごとに出さず、バッチ/チャンク単位に集約する。
- 銘柄別のYahoo Finance取得期間・結果ログが必要な場合だけ、`OHLCV_VERBOSE_FETCH_LOGS=true` を使う。
- `console.log` と `Logger.log` に同じ内容を二重出力しない。

## よく使う手動関数

```javascript
setupAllTriggers()                         // 固定トリガーだけ再登録
migrateCurrentSchemaToMidtermTracking_()   // 旧alerts_rawスキーマを現行へ移行

buildAndSendWeeklyReportManual()           // 週次レポート手動送信
previewWeeklyReportThisWeek()              // 今週分レポートのプレビュー

syncMarketHolidays()                       // 祝日同期
clearManualOhlcvBusinessDate()             // 手動基準日解除

fetchOHLCVForNewAlertsMidday()             // 13:30先行取得を手動実行
fetchOHLCVForNewAlerts()                   // 16:00本番OHLCVチェーンを手動実行
resetAllOhlcvProperties()                  // OHLCV関連進捗プロパティをリセット

purgeOldOhlcvDataDaily()                   // 365日超のOHLCV削除
purgeOldSignalArchiveRowsDaily()           // signals_archive保持期限超過データ削除

quickScanMissingSessions()                 // セッション欠落診断
quickRepairRecentGaps()                    // GAP修復
resumeQuickRepair()                        // GAP修復再開
resetQuickRepairState()                    // GAP修復状態リセット
auditGapRepairCoverage(14, 2)              // GAP修復結果監査

diagOhlcvTimestamps()                      // 無効timestamp診断
diagOneSessionDays()                       // 1セッション日診断
repairEmptyTimestampRows(true)             // 空/無効timestamp削除対象 DryRun
repairEmptyTimestampRows(false)            // 空/無効timestamp削除 本番
cleanupLegacyGapFailedAndEmptyTimestamps(true)   // 旧OHLCV残骸整理 DryRun
cleanupLegacyGapFailedAndEmptyTimestamps(false)  // 旧OHLCV残骸整理 本番
emergencyStopQuickRepairAndCleanOhlcv()    // GAP修復停止→OHLCV整理→完了後quickRepairTrigger予約
purgeBogusGapRepairRows()                  // 不正GAP_REPAIR行削除

auditEvaluationOhlcvCoverage120()          // 評価対象銘柄の120日OHLCV監査
repairEvaluationOhlcvCoverage120()         // 評価対象銘柄の120日OHLCV補填
resetEvaluationOhlcvCoverageRepairState()  // 評価対象OHLCV補填状態リセット

previewHistoricalOhlcvVolumeRepair()       // 過去出来高補正 DryRun
repairHistoricalOhlcvVolumes()             // 過去出来高補正 本番
resetHistoricalOhlcvVolumeRepairState()    // 過去出来高補正状態リセット

debugWeekly5bdCandidates()                 // 5営業日チェックポイント候補確認
refetchTodayOhlcv()                        // 当日OHLCV再取得
refetchSymbolGap(symbol, startDate, endDate)   // 単一銘柄・期間のGAP補填
refetchSymbolRange(symbols, startDate, endDate) // 複数銘柄・期間の補填
```

## 実装時の注意

- 一時デバッグ・one-shot補修関数は原則として恒久化しない。
- 復旧・監査用として残す手動関数は、このAGENTSまたはREADMEに用途を書く。
- スクリプトプロパティ名を変更する場合は、既存状態との移行・リセット手順も同時に書く。
- トリガー名を変更する場合は、残留旧トリガー削除手順も書く。
- `setupAllTriggers()` に動的ワンショットトリガーを入れない。
- 既存の `alerts_raw` / `ohlcv_4h` レイアウトに列追加する場合は、移行関数とREADME更新を同時に行う。
