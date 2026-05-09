# weekly_report_gas

天底極致スコアリングBot の週次レポート・OHLCV管理を行う Google Apps Script プロジェクトです。

TradingView のアラートを Webhook で受信し、JPX銘柄の中期パフォーマンスを 5/10/20/40営業日後で追跡します。OHLCVは Yahoo Finance の1時間足を前場AM・後場PMの4時間足相当に集約し、評価結果をDiscordへ週次レポートとして送信します。

## 主な機能

- TradingView Webhook 受信
- HMAC-SHA256 署名検証
- `alerts_raw` へのアラート記録
- `ohlcv_4h` へのAM/PM OHLCV保存
- 13:30のAM先行OHLCV取得
- 16:00の本番OHLCV取得
- 株式分割検出・価格調整
- 5/10/20/40営業日後の評価更新
- Discord週次レポート送信
- 完了済みシグナルの `signals_archive` 退避
- 古いOHLCV/アーカイブの削除
- GAP修復
- 空timestamp・不正timestamp整理
- 評価対象銘柄の120日OHLCV補填
- プレミアム通知worker用の `alerts_raw` 読み取り元提供

## 全体フロー

```text
TradingView Alert
  → doPost
    → alerts_raw に記録

13:30
  → fetchOHLCVForNewAlertsMidday
    → AM分までOHLCV先行取得
    → 日次メンテ/GitHub Actions/GAP修復には進まない

16:00
  → fetchOHLCVForNewAlerts
    → PHASE1: OHLCV取得
    → PHASE2: 株式分割検出・価格調整
    → PHASE3: 分割調整キュー適用
    → PHASE4: 重複排除・ソート・完了通知
      → runDailyMaintenance
        → quickRepairRecentGaps

土曜 9:05
  → buildAndSendWeeklyReport
    → Discord週次レポート送信
    → alerts_report に保存
    → 完了済みraw行を signals_archive へ退避
```

## スプレッドシート構成

| シート名 | 用途 |
|---|---|
| `alerts_raw` | 受信アラートと評価結果 |
| `ohlcv_4h` | AM/PMの4時間足相当OHLCV |
| `alerts_report` | 週次レポート保存 |
| `market_holidays` | 日本市場の休場日 |
| `signals_archive` | 完了済みシグナルの退避先 |
| `debug_webhook` | 旧デバッグシート。現在は未使用 |

## `alerts_raw`

ヘッダー行は4行目、データ開始行は5行目です。

ヘッダーは以下。

```text
alert_id, received_at, signal_date, signal_week_start, signal_type,
timeframe, symbol_code, symbol_name, entry_price, volume, tv_symbol,
eval_date_5bd, eval_close_5bd, perf_5bd, win_flag_5bd, reported_5bd,
eval_date_10bd, eval_close_10bd, perf_10bd, win_flag_10bd, reported_10bd,
eval_date_20bd, eval_close_20bd, perf_20bd, win_flag_20bd, reported_20bd,
eval_date_40bd, eval_close_40bd, perf_40bd, win_flag_40bd, reported_40bd,
status, note, logged_at
```

## `ohlcv_4h`

ヘッダー行は1行目、データ開始行は2行目です。

基本列は以下。

```text
timestamp, alert_id, symbol, open, high, low, close, volume
```

重要ルール。

- timestamp は `09:00 JST` または `13:00 JST` のみ。
- `09:00 JST` はAM代表行。
- `13:00 JST` はPM代表行。
- Yahoo Finance の生1時間足timestampをそのまま保存しない。
- `timestamp + symbol` で重複排除する。
- A列 timestamp 昇順で保存する。
- 空timestamp行や `09:00` / `13:00` 以外の行は原則削除し、正規取得で補填する。

## 初期設定

### 1. スクリプトプロパティを設定

GASの「プロジェクトの設定」→「スクリプト プロパティ」に以下を設定します。

| キー | 必須 | 内容 |
|---|---:|---|
| `SPREADSHEET_ID` | ✅ | 対象スプレッドシートID |
| `GAS_SHARED_SECRET` | ✅ | Webhook署名検証用の共有シークレット |
| `DISCORD_STATS_WEBHOOK_URL` | ✅ | 週次レポート送信先Discord Webhook |
| `DISCORD_WEBHOOK` | ✅ | OHLCV完了通知先Discord Webhook |
| `GITHUB_PAT` | 任意 | GitHub Actions `optimize.yml` 起動用 |
| `OHLCV_VERBOSE_FETCH_LOGS` | 任意 | `true` でOHLCV取得詳細ログを有効化 |

### 2. 祝日シートを同期

初回は手動で実行します。

```javascript
syncMarketHolidays()
```

`market_holidays` に、内閣府祝日CSVとJPX年末年始休場日が登録されます。

### 3. トリガーを登録

```javascript
setupAllTriggers()
```

この関数は既存トリガーを全削除し、固定トリガーだけ再登録します。

## 固定トリガー

| 関数 | スケジュール | 内容 |
|---|---:|---|
| `buildAndSendWeeklyReport` | 土曜 9:05 JST | 週次レポート送信 |
| `syncMarketHolidays` | 毎月1日 3:10 JST | 祝日同期 |
| `fetchOHLCVForNewAlertsMidday` | 毎日 13:30 JST | AM分OHLCV先行取得 |
| `fetchOHLCVForNewAlerts` | 毎日 16:00 JST | OHLCV本番取得 |
| `purgeOldOhlcvDataDaily` | 毎日 2:00 JST | 365日超のOHLCV削除 |
| `purgeOldSignalArchiveRowsDaily` | 毎日 2:10 JST | 古い `signals_archive` 削除 |

## 動的トリガー

処理中に必要に応じて作成されるワンショットトリガーです。

| 関数 | 内容 |
|---|---|
| `sendDeferredDiscordPayload` | Discordレート制限時の再送 |
| `runDailyMaintenanceTrigger` | OHLCV完了後の日次メンテ起動 |
| `quickRepairTrigger` | GAP修復起動 |
| `resumeOHLCVFetchMidday` | 13:30 OHLCV先行取得の再開 |
| `resumeOHLCVFetch` | 16:00 OHLCV本番取得の再開 |
| `resumeDailyMaintenance` | 日次メンテナンスの再開 |
| `resumeQuickRepair` | GAP修復の再開 |
| `purgeOldOhlcvResumeTrigger` | OHLCV削除の再開 |
| `resumeCleanupLegacyGapFailedAndEmptyTimestamps` | 旧OHLCV残骸整理の再開 |
| `resumeEvaluationOhlcvCoverageRepair` | 評価対象OHLCV補填の再開 |
| `resumeHistoricalOhlcvVolumeRepair` | 過去OHLCV出来高補正の再開 |

## Webhook仕様

`doPost(e)` は以下の envelope を受け取ります。

```json
{
  "v": "v1",
  "ts": 1710000000000,
  "payloadJson": "{\"alerts\":[...]}",
  "sig": "hmac-sha256-hex"
}
```

署名対象文字列。

```text
v1.{ts}.{payloadJson}
```

`GAS_SHARED_SECRET` を使って HMAC-SHA256 のhex署名を検証します。

クロックスキューは ±4.5分以内です。

`payloadJson` の中身は、`alert` 単体または `alerts` 配列に対応します。

## OHLCV取得

### 13:30先行取得

関数。

```javascript
fetchOHLCVForNewAlertsMidday()
```

役割。

- AM分までのOHLCVを先行取得する。
- 対象は `alerts_raw` に登場する全銘柄。
- OHLCV未取得銘柄だけ120日分取得する。
- 既存OHLCVがある銘柄は `lastTs` 以降だけ取得する。
- 今日シグナルが出た銘柄数はメタ情報として保持する。
- 16:00本番チェーンには進まない。
- 日次メンテナンス、GitHub Actions、GAP修復は起動しない。
- 16:00本番が近い場合は再開せず終了する。

### 16:00本番取得

関数。

```javascript
fetchOHLCVForNewAlerts()
```

役割。

- `alerts_raw` に登場する全銘柄を対象にする。
- `OHLCV_REPAIR_SYMBOLS` の銘柄も対象に含める。
- OHLCV未取得銘柄は120日分取得する。
- 修復対象銘柄は120日分強制再取得する。
- 既存銘柄は `lastTs` 以降だけ取得する。
- PHASE1〜PHASE4を進める。
- 完了後に日次メンテナンスを起動する。

### PHASE

| フェーズ | 内容 |
|---|---|
| `PHASE1` | Yahoo Finance 1h足からOHLCV取得 |
| `PHASE2` | 株式分割検出・価格調整 |
| `PHASE3` | 分割調整キュー適用 |
| `PHASE4` | 重複排除・timestamp昇順ソート・完了通知 |

## 評価ロジック

`CHECKPOINTS` は以下の4地点です。

| 営業日 | ラベル |
|---:|---|
| 5 | 5営業日後 |
| 10 | 10営業日後 |
| 20 | 20営業日後 |
| 40 | 40営業日後 |

各チェックポイントで以下を更新します。

- `eval_date_Xbd`
- `eval_close_Xbd`
- `perf_Xbd`
- `win_flag_Xbd`
- `reported_Xbd`

全チェックポイントが埋まると `status=COMPLETE` になります。

## 週次レポート

通常実行。

```javascript
buildAndSendWeeklyReport()
```

手動送信。

```javascript
buildAndSendWeeklyReportManual()
```

今週分プレビュー。

```javascript
previewWeeklyReportThisWeek()
```

仕様。

- BOTTOMシグナルのみ集計。
- 評価日がレポート対象週に入る銘柄を集計。
- 通常実行では `reported_Xbd=true` の行を除外。
- 通常実行後は `reported_Xbd` を true にする。
- DiscordへEmbed送信。
- `alerts_report` に保存。
- 完了済み行は `signals_archive` へ退避する。

## アーカイブと保持期間

| 対象 | 保持期間 |
|---|---:|
| BOTTOMのCOMPLETE行 | 完了後7日で `signals_archive` へ退避 |
| TOPのCOMPLETE行 | 完了後30日で `signals_archive` へ退避 |
| `signals_archive` | 365日 |
| `ohlcv_4h` | 365日 |

古いOHLCV削除。

```javascript
purgeOldOhlcvDataDaily()
```

古いアーカイブ削除。

```javascript
purgeOldSignalArchiveRowsDaily()
```

## GAP修復

診断。

```javascript
quickScanMissingSessions()
```

修復。

```javascript
quickRepairRecentGaps()
```

監査。

```javascript
auditGapRepairCoverage(14, 2)
```

仕様。

- 直近範囲だけを読む。
- 全行読み込みは避ける。
- 不足しているAM/PMセッションだけ補填する。
- 補填行は `GAP_REPAIR`。
- 取得失敗マーカーは `GAP_FAILED`。
- マーカーも `09:00 JST` / `13:00 JST` の実timestampを持つ。
- 空timestampや `00:00` マーカーは作らない。
- 中断前にも重複排除・timestamp昇順ソートを行う。

## 復旧手順

### GAP修復がタイムアウトループする場合

まず以下を実行します。

```javascript
emergencyStopQuickRepairAndCleanOhlcv()
```

この関数は以下を行います。

- `resumeQuickRepair` / `quickRepairTrigger` を削除
- `QUICK_REPAIR_STATE` を削除
- `QUICK_REPAIR_TAIL_CLEANUP_STATE` を削除
- `cleanupLegacyGapFailedAndEmptyTimestamps(false)` を実行
- cleanup完了後に `quickRepairTrigger` を1分後に予約

### 空timestamp・不正timestampを確認する場合

```javascript
diagOhlcvTimestamps()
```

### 空timestamp・不正timestampをDryRunする場合

```javascript
repairEmptyTimestampRows(true)
cleanupLegacyGapFailedAndEmptyTimestamps(true)
```

### 本番削除する場合

```javascript
repairEmptyTimestampRows(false)
cleanupLegacyGapFailedAndEmptyTimestamps(false)
```

削除された銘柄は `OHLCV_REPAIR_SYMBOLS` に入り、次回OHLCV取得で120日分再取得されます。

## 手動でよく使う関数

```javascript
setupAllTriggers()
syncMarketHolidays()

fetchOHLCVForNewAlertsMidday()
fetchOHLCVForNewAlerts()
resetAllOhlcvProperties()

buildAndSendWeeklyReportManual()
previewWeeklyReportThisWeek()

quickScanMissingSessions()
quickRepairRecentGaps()
resetQuickRepairState()
auditGapRepairCoverage(14, 2)

diagOhlcvTimestamps()
diagOneSessionDays()
repairEmptyTimestampRows(true)
repairEmptyTimestampRows(false)

cleanupLegacyGapFailedAndEmptyTimestamps(true)
cleanupLegacyGapFailedAndEmptyTimestamps(false)
emergencyStopQuickRepairAndCleanOhlcv()

auditEvaluationOhlcvCoverage120()
repairEvaluationOhlcvCoverage120()
resetEvaluationOhlcvCoverageRepairState()

previewHistoricalOhlcvVolumeRepair()
repairHistoricalOhlcvVolumes()
resetHistoricalOhlcvVolumeRepairState()

purgeOldOhlcvDataDaily()
purgeOldSignalArchiveRowsDaily()

clearManualOhlcvBusinessDate()
debugWeekly5bdCandidates()
```

## プレミアム通知workerとの関係

`premium_worker/` はGAS本体とは独立した読み取り専用workerです。

- GAS本体の `doPost` やトリガーは変更しない。
- `alerts_raw` を Google Sheets API で読む。
- 投稿済み状態はworker側で管理する。
- 既存GAS対象スプレッドシートにプレミアム投稿ログを混ぜない。
- プレミアム投稿ログを残す場合は `PREMIUM_LOG_SPREADSHEET_ID` で別スプレッドシートを使う。

## ログ確認

ログは主に Cloud Logs / 実行ログで確認します。

- `writeProcessLog_()` は `console.log` へ出力。
- `debugLogToSheet_()` は互換名ですが、実装はコンソール出力のみ。
- `debug_webhook` シートには新規書き込みしません。
- OHLCV取得の銘柄別詳細ログが必要な場合は、スクリプトプロパティに以下を設定します。

```text
OHLCV_VERBOSE_FETCH_LOGS=true
```

## 注意事項

- `setupAllTriggers()` は既存トリガーを全削除します。
- 動的な再開トリガー実行中に不用意に `setupAllTriggers()` を実行しないでください。
- `ohlcv_4h` のA列timestamp昇順を壊すと、GAP修復や削除処理が遅くなったりタイムアウトする可能性があります。
- 追記・補填後は必要に応じて `dedupeAndSortOhlcv_()` で並べ替えてください。
- 空timestampや非09:00/13:00 timestampを既存行から推定補正しないでください。
- 投資助言・売買推奨・目標株価に見える文言をDiscord投稿へ追加しないでください。
