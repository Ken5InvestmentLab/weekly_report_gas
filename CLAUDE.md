# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

天底極致スコアリングBot の週次レポート・OHLCV管理を担う Google Apps Script (GAS) プロジェクト。TradingView からのアラート Webhook を受信し、JPX 銘柄の中期パフォーマンス（5/10/20/40営業日後）を追跡してDiscordに週次レポートを送信する。

## デプロイ・実行方法

- GAS プロジェクトは Google Apps Script エディタ上で管理（ファイルは `.gs` 拡張子）
- ローカルに clasp を使う場合: `clasp push` でデプロイ、`clasp pull` で取得
- トリガーの再設定: `setupAllTriggers()` を手動実行（既存トリガーを全削除して固定トリガーのみ再登録する。動的再開トリガー実行中に実行しない）
- 旧スキーマ移行: `migrateCurrentSchemaToMidtermTracking_()` を手動実行

## 定期トリガー一覧

`setupAllTriggers()` で登録される**固定トリガー**（削除してはいけない）：

| 関数 | スケジュール | 役割 |
|------|-------------|------|
| `buildAndSendWeeklyReport` | 土曜 9:05 JST | 週次レポート送信 |
| `fetchOHLCVForNewAlertsMidday` | 毎日 13:30 JST | AM分OHLCV先行取得。後続チェーンなし |
| `fetchOHLCVForNewAlerts` | 毎日 16:00 JST | OHLCV本番取得 → 日次メンテ → GAP修復チェーン |
| `syncMarketHolidays` | 毎月1日 3:10 JST | 祝日カレンダー同期 |
| `purgeOldOhlcvDataDaily` | 毎日 2:00 JST | 365日超の古い OHLCV 削除 |
| `purgeOldSignalArchiveRowsDaily` | 毎日 2:10 JST | `signals_archive` の保持期限超過データ削除 |

**動的に生成・削除されるワンショットトリガー**（`setupAllTriggers()` には含めない）：

| ハンドラー関数 | 生成元 | 役割 |
|---|---|---|
| `sendDeferredDiscordPayload` | Discord 429 レート制限時 | 延期した Discord ペイロードを再送 |
| `runDailyMaintenanceTrigger` | OHLCV PHASE4完了後 | `runDailyMaintenance` を起動 |
| `quickRepairTrigger` | `runDailyMaintenance` 完了後 / cleanup完了後 | `quickRepairRecentGaps` を起動 |
| `resumeOHLCVFetchMidday` | 13:30先行OHLCV取得の再開時 | `fetchOHLCVForNewAlertsMidday` を再起動 |
| `resumeOHLCVFetch` | OHLCV フェーズ再開時 | `fetchOHLCVForNewAlerts` を再起動 |
| `resumeDailyMaintenance` | `runDailyMaintenance` 再開時 | `runDailyMaintenanceInternal_` を再起動 |
| `resumeQuickRepair` | `quickRepairRecentGaps` 再開時 | ギャップ修復を再起動 |
| `resumeOhlcvPostRepairCleanup` | GAP修復完了後 | timestamp正規化・AM保護マーキング・重複整理・最終ソートを再開 |
| `purgeOldOhlcvResumeTrigger` | `purgeOldOhlcvDataDaily` 未完了時 | OHLCV削除を再起動 |
| `resumeCleanupLegacyGapFailedAndEmptyTimestamps` | 旧OHLCV残骸整理未完了時 | 空timestamp・非09:00/13:00・長期GAP_FAILED整理を再開 |
| `resumeEvaluationOhlcvCoverageRepair` | 評価対象銘柄OHLCV補填未完了時 | 120日OHLCV補填を再開 |
| `resumeHistoricalOhlcvVolumeRepair` | 過去OHLCV出来高補正未完了時 | 出来高補正を再開 |

**重要**: ワンショットトリガーは各ハンドラー関数の冒頭で `deleteTriggersByHandler_("自分の関数名")` を呼び、自分自身を削除してから処理を実行する。

## スプレッドシート構造

| シート名 | 役割 |
|----------|------|
| `alerts_raw` | Webhook で受信したアラートと評価結果（ヘッダー行=4行目、データ開始=5行目） |
| `ohlcv_4h` | 前場AM・後場PMの OHLCV データ（ヘッダー行=1行目、データ開始=2行目） |
| `alerts_report` | 週次レポートのアーカイブ |
| `market_holidays` | 日本市場の休場日 |
| `signals_archive` | 完了済みシグナルの退避先（`RAW_HEADERS + archived_at`） |
| `debug_webhook` | 旧デバッグシート。現在は未使用。GASから書き込まない |

**注意**: `alerts_raw` は `CONFIG.HEADER_ROW=4` / `CONFIG.DATA_START_ROW=5`。`ohlcv_4h` はヘッダー行=1 / データ=2行目（`CONFIG` の値と異なる）。

### `ohlcv_4h` の列構造と保存ルール

列: `timestamp, alert_id, symbol, open, high, low, close, volume`

- timestamp は `09:00 JST`（AM代表）または `13:00 JST`（PM代表）のみ。`09:00` のゼロ埋め必須（`9:00` は不正）
- A列 timestamp は文字列 `yyyy/MM/dd HH:mm` 形式でテキストセル（`setNumberFormat("@")`）として保存する。シリアル値で保存しない
- B列 `alert_id` に入るマーカー：通常取得は空文字/refresh ID、`MIDDAY_yyyy-mm-dd`（13:30先行取得）、`MIDDAY_LOCKED_yyyy-mm-dd`（保護行）、`GAP_REPAIR`（ギャップ修復）
- `MIDDAY_LOCKED_yyyy-mm-dd` は13:30で `alerts_raw` の出来高を転記したAM保護行。16:00本番・GAP修復・重複整理でも削除・上書き禁止
- 重複排除は `timestamp + symbol` で行う
- 最終状態は必ず A列 timestamp 昇順

## スクリプトプロパティ

### 必須・外部連携

| キー | 必須 | 用途 |
|------|------|------|
| `SPREADSHEET_ID` | ✅ | 対象スプレッドシートの ID |
| `GAS_SHARED_SECRET` | ✅ | Webhook 署名検証用の共有シークレット |
| `DISCORD_STATS_WEBHOOK_URL` | ✅ | 週次レポート送信先 |
| `DISCORD_WEBHOOK` | ✅ | OHLCV 完了通知送信先 |
| `GITHUB_PAT` | 任意 | `Ken5InvestmentLab/screening-bot` の `optimize.yml` dispatch 用 |
| `OHLCV_VERBOSE_FETCH_LOGS` | 任意 | `true` で銘柄別 OHLCV 取得詳細ログを有効化 |

### 内部状態（主なもの）

| キー | 用途 |
|------|------|
| `OHLCV_CURRENT_PHASE` | OHLCV 取得フェーズ管理（1〜4） |
| `DAILY_MAINT_CURSOR` | `runDailyMaintenance` の再開カーソル |
| `QUICK_REPAIR_STATE` | `quickRepairRecentGaps` の再開状態（v7） |
| `OHLCV_POST_REPAIR_CLEANUP_STATE_V1` | GAP修復後 cleanup の再開状態 |
| `SPLIT_QUEUE` / `SPLIT_INDEX` | 株式分割調整キューの進捗 |
| `VARIANT_HISTORY_V1` | 週次レポート文言の重複防止履歴（JSON） |
| `OHLCV_REPAIR_SYMBOLS` | 次回OHLCV取得で120日再取得する修復対象銘柄 |

## アーキテクチャ上の重要事項

### 日次処理の実行チェーン

```
13:30  fetchOHLCVForNewAlertsMidday → AM先行取得のみ（後続チェーンなし）

16:00  fetchOHLCVForNewAlerts → (PHASE1→2→3→4)
         → PHASE4完了: runDailyMaintenanceTrigger（1分後）
           → runDailyMaintenance: 評価日到達銘柄の価格更新
             → 完了後: quickRepairTrigger（1分後）
               → quickRepairRecentGaps: セッション欠落修復
                 → 完了後: resumeOhlcvPostRepairCleanup
                   → timestamp正規化・AM保護・重複整理・ソート
                     → 完了後: OHLCV完了Discord通知 + GitHub Actions
```

### タイムアウト対策パターン（2種類）

GAS の実行上限は **6分**。長時間処理はどちらかのパターンで実装する：

**パターンA — 先行トリガー方式（`quickRepairRecentGaps`, `runOhlcvPostRepairCleanup_`）**
1. 処理開始直後に `resumeXxx` トリガー（10分後）を先にセット
2. 処理が正常完了したらトリガーを削除
3. GAS に強制終了されても自動再開される
4. ロック取得前後・対象件数・バッチ進捗を `console.log` に必ず出す

**パターンB — 内部タイムリミット方式（`fetchOHLCVForNewAlerts`, `runDailyMaintenance`）**
1. 処理開始時に `setupResumeTrigger_(handlerName)` で1分後トリガーをセット
2. 3.5〜4分経過で自発的に中断、スクリプトプロパティに進捗保存
3. 正常完了時はトリガーを削除

### OHLCV 取得フロー（4フェーズ）

```
PHASE1: 全銘柄の OHLCV を Yahoo Finance 1h足で取得
PHASE2: 株式分割検出・価格調整
PHASE3: 分割調整キューを OHLCV シートに適用
PHASE4: 重複排除・ソート・完了通知 → runDailyMaintenanceTrigger をチェーン
```

フェーズはスクリプトプロパティ `OHLCV_CURRENT_PHASE` で管理。13:30/16:00本体では `range=5d` を使わず必ず `period1/period2` を使う。

### Yahoo Finance 1h足の集約ルール

- AMバケット: `09:00` / `10:00` / `11:00` / `12:00` 足をマージ → シートは `09:00 JST`
- PMバケット: `13:00` / `14:00` / `15:00` 足 + `15:30` 終値スナップショット → シートは `13:00 JST`
- `15:30` の `volume=0 / O=H=L=C` バーは終値スナップショット。PMの `close` のみ更新し、`open/high/low/volume` には混ぜない
- 16:00本番の当日PMのみ `PM出来高 = 日足出来高 - AM出来高` で補正可。他の処理では日足出来高をAM/PM片側に寄せない

### 一時的サーバーエラーのリトライ

`withRetry_(fn, maxRetries, baseDelayMs)` で指数バックオフリトライ（デフォルト最大3回、2s→4s→8s）。`isTransientError_(e)` が "server error" / "we're sorry" / "quota" / "timeout" / "502" / "503" を一時エラーと判定する。`quickRepairRecentGaps` の外側 `catch` では一時エラーを `throw` せず、トリガーによる自動再開に委ねる。

### チェックポイント評価ロジック

`CHECKPOINTS` 配列（5/10/20/40営業日）に基づき `alerts_raw` の各行を更新する。`reported_Xbd` フラグが `true` になった行は週次レポート対象から除外される。全チェックポイント埋まると `status = "COMPLETE"` → 一定期間後に `signals_archive` へ退避し `alerts_raw` から削除。

### Webhook 署名検証

`v1.{timestamp}.{payloadJson}` を HMAC-SHA256 で署名し、クロックスキュー ±4.5分以内のみ受理。

### GAP 修復の仕組み

`quickRepairRecentGaps` は `ohlcv_4h` 全行スキャンを避け、直近 `daysBack` 日分を銘柄バッチ単位で Yahoo Finance から再取得する。取得は `UrlFetchApp.fetchAll`、進捗は `QUICK_REPAIR_STATE` v7 で再開。修復行は B列に `GAP_REPAIR` を入れて追記。完了後は `dedupeAndSortOhlcv_()` を直接呼ばず `resumeOhlcvPostRepairCleanup` に委譲する。

`quickScanMissingSessions` と `auditGapRepairCoverage` は A列 timestamp 昇順を前提に末尾から直近日数分だけ読む。全行読み込みに戻すと行数が多い環境でタイムアウトするため禁止。

### シート読み書きのベストプラクティス

- **禁止**: `getRange(row,col).getValue()` の大量ループ。データ本体は `getValues()` で一括取得
- **禁止**: 時間主導トリガーで `SpreadsheetApp.getActiveSpreadsheet()` を使う。必ず `SpreadsheetApp.openById(SPREADSHEET_ID)` を使う
- **禁止**: GAP修復・監査で `getRange(2, 1, lastRow - 1, ...)` の全行読みを追加する
- `ohlcv_4h` 先頭からの連続削除は `sheet.deleteRows(firstDataRow, N)` で高速に行う
- 追記は `appendRowsToSheet_` を通す。追記後はA列を読み返して空・不正・09:00/13:00以外の行を即削除する
- 全行一括書き戻しは避け、変更した行のみ個別または小バッチで `setValues()` する

### アーカイブ保持期間

| 対象 | 保持期間 |
|---|---|
| BOTTOMの `COMPLETE` 行 | 完了後7日で `signals_archive` へ退避 |
| TOPの `COMPLETE` 行 | 完了後30日で `signals_archive` へ退避 |
| `signals_archive` | 365日 |
| `ohlcv_4h` | 365日 |

### ログ方針

- `writeProcessLog_()` と `debugLogToSheet_()` はともに `console.log` へ出力（`debug_webhook` シートへ書き込まない）
- 正常系ログは銘柄ごとでなくバッチ/チャンク単位に集約する
- `console.log` と `Logger.log` に同じ内容を二重出力しない

## よく使うデバッグ・手動操作関数

```javascript
// トリガー・初期設定
setupAllTriggers()                    // 固定トリガーのみ再登録
syncMarketHolidays()                  // 祝日同期

// OHLCV取得
fetchOHLCVForNewAlertsMidday()        // 13:30先行取得を手動実行
fetchOHLCVForNewAlerts()              // 16:00本番OHLCVチェーンを手動実行
resetAllOhlcvProperties()             // OHLCV関連進捗プロパティをリセット

// 週次レポート
buildAndSendWeeklyReportManual()      // 週次レポートの手動送信
previewWeeklyReportThisWeek()         // 今週分レポートのプレビュー
debugWeekly5bdCandidates()            // 5営業日チェックポイント候補を確認

// GAP修復・監査
quickScanMissingSessions()            // セッション欠落の診断（書き込みなし）
quickRepairRecentGaps()               // GAP修復
resetQuickRepairState()               // ギャップ修復の進捗リセット
auditGapRepairCoverage(14, 2)         // GAP修復が埋まっているか監査
startOhlcvPostRepairCleanupNow()      // GAP修復後cleanupを手動開始
resetOhlcvPostRepairCleanupNow()      // GAP修復後cleanup状態リセット

// timestamp診断・修復
diagOhlcvTimestamps()                 // 無効タイムスタンプ行の診断
diagOneSessionDays()                  // 1セッションしかない日を診断
repairEmptyTimestampRows(true)        // DryRun でタイムスタンプ修復を確認
repairEmptyTimestampRows(false)       // 空/無効timestamp削除 本番
cleanupLegacyGapFailedAndEmptyTimestamps(true)   // 旧OHLCV残骸整理 DryRun
cleanupLegacyGapFailedAndEmptyTimestamps(false)  // 旧OHLCV残骸整理 本番
emergencyStopQuickRepairAndCleanOhlcv()          // GAP修復停止→OHLCV整理→quickRepairTrigger予約
purgeBogusGapRepairRows()             // 不正な GAP_REPAIR 行を削除

// 単発補填
refetchTodayOhlcv()                          // 当日OHLCV再取得
refetchSymbolGap(symbol, startDate, endDate) // 単一銘柄・期間のGAP補填
refetchSymbolRange(symbols, startDate, endDate) // 複数銘柄・期間の補填

// 評価対象OHLCV補填
auditEvaluationOhlcvCoverage120()    // 評価対象銘柄の120日OHLCV監査
repairEvaluationOhlcvCoverage120()   // 評価対象銘柄の120日OHLCV補填
resetEvaluationOhlcvCoverageRepairState()  // 補填状態リセット

// 削除
purgeOldOhlcvDataDaily()             // 365日超のOHLCV削除
purgeOldSignalArchiveRowsDaily()     // signals_archive保持期限超過データ削除
```

## premium_worker との関係

`premium_worker/` は GAS 本体とは独立した読み取り専用 worker。`alerts_raw` を Google Sheets API で読むだけで、`doPost`・既存トリガー・`alerts_raw` スキーマは変更しない。投稿済み状態は worker 側で管理し、既存スプレッドシートにプレミアム投稿ログを混ぜない。
