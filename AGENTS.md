# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## プロジェクト概要

天底極致スコアリングBot の週次レポート・OHLCV管理を担う Google Apps Script (GAS) プロジェクト。TradingView からのアラート Webhook を受信し、JPX 銘柄の中期パフォーマンス（5/10/20/40営業日後）を追跡してDiscordに週次レポートを送信する。

## プレミアム通知 worker

- `premium_worker/` は既存GAS本体から独立したCodex automation用の読み取り専用worker。プレミアム通知対応では、既存機能保護を最優先し、`gas.txt` / `doPost` / 既存トリガー / `alerts_raw` スキーマを変更しない
- workerはGoogle Sheets APIで `alerts_raw` を読むだけにし、投稿済み状態は `premium_worker/state/`、生成中ファイルは `premium_worker/out/` に置く（どちらもgit管理しない）
- Codex automationは毎時起動してよいが、worker側のJST時間ゲート（既定 `PREMIUM_ALLOWED_JST_HOURS=14,16`）で対象時間以外は即終了する

## デプロイ・実行方法

- GAS プロジェクトは Google Apps Script エディタ上で管理（ファイルは `.gs` 拡張子）
- ローカルに clasp を使う場合: `clasp push` でデプロイ、`clasp pull` で取得
- トリガーの再設定: `setupAllTriggers()` を手動実行
- スキーマ移行が必要な場合: `migrateCurrentSchemaToMidtermTracking_()` を手動実行

## 定期トリガー一覧

`setupAllTriggers()` で登録される**固定トリガー**（削除してはいけない）：

| 関数 | スケジュール | 役割 |
|------|-------------|------|
| `buildAndSendWeeklyReport` | 土曜 9:05 | 週次レポート送信 |
| `fetchOHLCVForNewAlertsMidday` | 毎日 13:30 | 当日AM分までのOHLCV先行取得（後続チェーンなし） |
| `fetchOHLCVForNewAlerts` | 毎日 16:00 | 全銘柄の OHLCV データ取得→日次メンテ→GAP修復 |
| `syncMarketHolidays` | 毎月1日 3:10 | 祝日カレンダー同期 |
| `purgeOldOhlcvDataDaily` | 毎日 2:00 | 古い OHLCV データ削除 |

**動的に生成・削除されるワンショットトリガー**（`setupAllTriggers()` には含まれない）：

| ハンドラー関数 | 生成元 | 役割 |
|---|---|---|
| `runDailyMaintenanceTrigger` | OHLCV PHASE4完了後 | `runDailyMaintenance` を起動 |
| `quickRepairTrigger` | `runDailyMaintenance` 完了後 | `quickRepairRecentGaps` を起動 |
| `resumeOHLCVFetchMidday` | 13:30先行OHLCV取得の再開時 | `fetchOHLCVForNewAlertsMidday` を再起動 |
| `resumeOHLCVFetch` | OHLCV フェーズ再開時 | `fetchOHLCVForNewAlerts` を再起動 |
| `resumeDailyMaintenance` | `runDailyMaintenance` 再開時 | `runDailyMaintenanceInternal_` を再起動 |
| `resumeQuickRepair` | `quickRepairRecentGaps` 再開時 | ギャップ修復を再起動 |
| `resumeCleanupLegacyGapFailedAndEmptyTimestamps` | `cleanupLegacyGapFailedAndEmptyTimestamps(false)` 未完了時 | 旧OHLCV残骸整理（空timestamp・非09:00/13:00・長期GAP_FAILED）を再開 |
| `purgeOldOhlcvResumeTrigger` | `purgeOldOhlcvDataDaily` 未完了時 | OHLCV削除を再起動 |
| `resumeEvaluationOhlcvCoverageRepair` | `repairEvaluationOhlcvCoverage120` 未完了時 | 評価対象銘柄の120日OHLCV補填を再開 |

**重要**: ワンショットトリガーは各ハンドラー関数の冒頭で `deleteTriggersByHandler_("自分の関数名")` を呼び、自分自身を削除してから処理を実行する。これをしないとトリガー一覧に残留する。

## スプレッドシート構造

| シート名 | 役割 |
|----------|------|
| `alerts_raw` | Webhook で受信したアラートと評価結果（ヘッダー行=4行目、データ開始=5行目） |
| `ohlcv_4h` | 4時間足相当（前場AM・後場PM）の OHLCV データ（ヘッダー行=1行目、データ開始=2行目） |
| `alerts_report` | 週次レポートのアーカイブ |
| `market_holidays` | 日本市場の休場日 |
| `debug_webhook` | 旧デバッグログシート（現在未使用。GASから書き込まない） |

**注意**: `alerts_raw` は `CONFIG.HEADER_ROW=4` / `CONFIG.DATA_START_ROW=5`。`ohlcv_4h` はヘッダー行=1 / データ=2行目（`CONFIG` の値と異なる）。

## スクリプトプロパティ

| キー | 必須 | 用途 |
|------|------|------|
| `SPREADSHEET_ID` | ✅ | 対象スプレッドシートの ID |
| `GAS_SHARED_SECRET` | ✅ | Webhook 署名検証用の共有シークレット |
| `DISCORD_STATS_WEBHOOK_URL` | ✅ | 週次レポート送信先 |
| `DISCORD_WEBHOOK` | ✅ | OHLCV 完了通知送信先 |
| `GITHUB_PAT` | 任意 | GitHub Actions (`optimize.yml`) トリガー用 PAT |
| `OHLCV_CURRENT_PHASE` | 内部 | OHLCV 取得フェーズ管理（1〜4） |
| `OHLCV_MIDDAY_PROGRESS_INDEX` | 内部 | 13:30 OHLCV先行取得の再開カーソル |
| `OHLCV_MIDDAY_SYMBOL_LIST` | 内部 | 13:30 OHLCV先行取得の対象銘柄リスト |
| `OHLCV_MIDDAY_NEW_ALERT_COUNT` | 内部 | 13:30 OHLCV先行取得で行が取れた銘柄数 |
| `OHLCV_MIDDAY_LAST_TS_MAP` | 内部 | 13:30 OHLCV先行取得用の銘柄別最終timestamp |
| `OHLCV_MIDDAY_REFRESH_ID` | 内部 | 13:30 OHLCV先行取得の実行ID（`MIDDAY_yyyy-mm-dd`） |
| `DAILY_MAINT_CURSOR` | 内部 | `runDailyMaintenance` の再開カーソル |
| `QUICK_REPAIR_STATE` | 内部 | `quickRepairRecentGaps` の再開カーソル（v6: `nextIndex` / `processedGroups` / `totalRows` など） |
| `QUICK_REPAIR_TAIL_CLEANUP_STATE` | 内部 | GAP修復入口での末尾不正timestamp掃除の実行済み状態。営業日だけでなく `lastRow` 増加時は再チェックする |
| `CLEANUP_LEGACY_STATE_V1` | 内部 | `cleanupLegacyGapFailedAndEmptyTimestamps` の再開カーソル・集計状態 |
| `CLEANUP_LEGACY_AUTO_QUICK_REPAIR_V1` | 内部 | `emergencyStopQuickRepairAndCleanOhlcv` 後にcleanup完了時だけ `quickRepairTrigger` を予約するためのフラグ |
| `EVAL_OHLCV_COVERAGE_REPAIR_STATE_V1` | 内部 | `repairEvaluationOhlcvCoverage120` の再開・集計状態 |
| `OHLCV_REPAIR_SYMBOLS` | 内部 | 空timestamp/非09:00・13:00削除後など、次回OHLCV取得で120日再取得する銘柄リスト |
| `SPLIT_QUEUE` / `SPLIT_INDEX` | 内部 | 株式分割調整キューの進捗 |
| `VARIANT_HISTORY_V1` | 内部 | 週次レポート文言の重複防止履歴（JSON） |

## アーキテクチャ上の重要事項

### タイムアウト対策パターン（2種類）

GAS の実行上限は **6分**。長時間処理はどちらかのパターンで実装する：

**パターンA — 先行トリガー方式（`quickRepairRecentGaps`）**
1. 処理開始時に `resumeXxx` トリガー（10分後）を先にセット
2. 処理が正常完了したらトリガーを削除
3. GAS に強制終了されても自動再開される
4. `quickRepairRecentGaps` は Cloud Logs に `console.log("[quickRepair] ...")` で開始・対象銘柄数・バッチ進捗を必ず出す。ログが一切出ずタイムアウトする状態は異常。

**パターンB — 内部タイムリミット方式（`fetchOHLCVForNewAlerts`, `runDailyMaintenance`）**
1. 処理開始時に `setupResumeTrigger_(handlerName)` で1分後トリガーをセット
2. 3.5〜4分経過で自発的に中断、スクリプトプロパティに進捗保存
3. 正常完了時はトリガーを削除

### 日次処理の実行チェーン

`fetchOHLCVForNewAlertsMidday`（13:30 直接トリガー）は、当日AM分までのOHLCV先行取得だけを行う。完了時はDiscordのOHLCV完了通知だけを送り、`runDailyMaintenanceTrigger` / GitHub Actions / `quickRepairTrigger` には進まない。当日分はAM行（シートtimestamp `09:00 JST`）だけ保存し、当日PM行（`13:00 JST`）や14:00以降のYahoo足、15:30終値スナップショットは保存しない。途中中断・完了時は `dedupeAndSortOhlcv_()` で `ohlcv_4h` をtimestamp昇順へ戻す。

`fetchOHLCVForNewAlerts`（16:00 直接トリガー）が本番チェーンの起点：

```
fetchOHLCVForNewAlerts → (PHASE1→2→3→4)
  → PHASE4完了: runDailyMaintenanceTrigger（1分後）
    → runDailyMaintenance: 評価日到達銘柄の価格更新
      → 完了後: quickRepairTrigger（1分後）
        → quickRepairRecentGaps: セッション欠落修復
```

各ワンショットトリガーのハンドラーはラッパー関数（例: `runDailyMaintenanceTrigger`）であり、起動直後に自分自身を `deleteTriggersByHandler_` で削除してから本体を呼ぶ。
16:00本番チェーン開始時は、残っている `resumeOHLCVFetchMidday` と13:30専用プロパティをクリアしてから通常PHASEを開始する。13:30で既に書き込まれたOHLCV行はシート上の成果として引き継ぎ、16:00側が通常どおり再取得・重複排除する。

### OHLCV 取得フロー（4フェーズ）

```
PHASE1: 全銘柄の OHLCV を Yahoo Finance 1h足で取得
PHASE2: 株式分割検出・価格調整
PHASE3: 分割調整キューを OHLCV シートに適用
PHASE4: 重複排除・ソート・完了通知 → runDailyMaintenanceTrigger をチェーン
```

各フェーズはスクリプトプロパティ `OHLCV_CURRENT_PHASE` で管理。
通常の未指定取得窓は `OHLCV_DEFAULT_LOOKBACK_DAYS = 120` 日。`lastTs` がない銘柄や `OHLCV_REPAIR_SYMBOLS` に入った強制再取得銘柄も120日を標準とする。120日より古い補填は通常処理に混ぜず、`refetchSymbolGap(symbol, startDate, endDate)` などで銘柄・期間を明示して実行する。

祝日などに前営業日扱いで `fetchOHLCVForNewAlerts` 起点のチェーンを手動実行する場合は、日付別の公開ラッパーから `runFetchOHLCVForNewAlertsAsDate_("yyyy-mm-dd")` を呼ぶ。手動基準日は日次メンテナンス・GAP修復にも引き継がれ、GAP修復完了時または `clearManualOhlcvBusinessDate()` で解除する。
手動基準日の公開ラッパーは、開始時に既存のOHLCVフェーズ進捗・保存済み銘柄リスト・再開トリガーをリセットしてから基準日を設定し、古い途中状態を引き継がないようにする。

空/無効 timestamp 行は日付推定で修正しない。`repairEmptyTimestampRows(false)` / `cleanupLegacyGapFailedAndEmptyTimestamps(false)` は対象行を削除し、対象銘柄を `OHLCV_REPAIR_SYMBOLS` に記録して正規取得で補填する。空timestampや非09:00/13:00 timestampを既存行から推定して書き換えない。

Yahoo Finance 1h足は JPX の時間足を区間末尾側の時刻で返すため、`13:00 JST` 足は前場（9:00〜13:00）バケットに含める。`15:30 JST` の `volume=0` かつ `O=H=L=C` バーは後場の終値スナップショットとして扱う。`parseIntraResponse_` では PM バケットの `close` だけを更新し、`open/high/low/volume` には混ぜない。OHLCV は生価格保存のため、通常取得・GAP修復・過去出来高補正では Yahoo Finance の `1h` だけを取得し、`1d` はデバッグや分割情報確認など必要な場合に限る。`ohlcv_4h` に保存する timestamp はセッション代表時刻の `09:00 JST` / `13:00 JST` の2種類だけにする。Yahooの生1h足時刻（10:00/11:00/12:00/14:00/15:00/15:30など）や `GAP_FAILED` の `00:00` マーカーは保存しない。

### 一時的サーバーエラーのリトライ

`withRetry_(fn, maxRetries, baseDelayMs)` で指数バックオフリトライ（デフォルト最大3回、2s→4s→8s）。`isTransientError_(e)` が "server error" / "we're sorry" / "service unavailable" / "quota" / "timeout" / "502" / "503" を一時エラーと判定する。`quickRepairRecentGaps` の外側 `catch` では一時エラーを `throw` せず、トリガーによる自動再開に委ねる（GASに「失敗」と記録させない）。

### チェックポイント評価ロジック

`CHECKPOINTS` 配列（5/10/20/40営業日）に基づき `alerts_raw` の各行を更新する。`reported_Xbd` フラグが `true` になった行は週次レポート対象から除外される。全チェックポイント埋まると `status = "COMPLETE"` になり、一定期間後に `purgeArchivedRawRows_` で削除される。

### Webhook 署名検証

`v1.{timestamp}.{payloadJson}` を HMAC-SHA256 で署名し、クロックスキュー ±4.5分以内のみ受理。

### GAP 修復の仕組み

`quickRepairRecentGaps` は巨大な `ohlcv_4h` 全行スキャンと全銘柄再取得を避けるため、まず `quickScanMissingSessions(daysBack, minSessions)` で未処理のセッション不足だけを抽出し、対象銘柄・日付グループだけを Yahoo Finance から再取得する。取得は `UrlFetchApp.fetchAll` を使い、進捗集計は `QUICK_REPAIR_STATE` v6 に保存する。再開時は直近スキャンをやり直し、既に埋まったグループや `GAP_FAILED` / `GAP_REPAIR` マーカー付きの未充足日は再取得対象から外す。

修復行は B列に `GAP_REPAIR` を入れて追記し、`GAP_FAILED` は不足しているAM/PMセッションに対して `makeGapFailedRows_` で `09:00 JST` / `13:00 JST` の実timestampを持つマーカー行として作る。空timestamp、`00:00`、Yahoo生1h足時刻をマーカーとして保存しない。追記した実行では、正常完了時だけでなく時間切れで再開に回す直前にも `dedupeAndSortOhlcv_()` と `SpreadsheetApp.flush()` を実行し、必ず `timestamp + symbol` 重複排除・A列 timestamp 昇順ソート済みの状態に戻してから `QUICK_REPAIR_STATE` を保存する。`refetchSymbolGap(symbol, startDate, endDate)` は手動用の単一補填関数で、前後3日マージンで取得しても、成功判定は対象日付範囲内の行だけに限定する（対象日以外が取れただけで成功扱いしない）。

`quickScanMissingSessions` と `auditGapRepairCoverage` は `ohlcv_4h` のA列 timestamp 昇順を前提に、timestamp列で直近範囲の開始位置を絞ってから読む。全行読み込みに戻すと、行数が大きい環境でログを出す前に6分タイムアウトするので禁止。`quickRepairRecentGaps` のバッチ処理では、初回スキャンで返る `sessionInfo` を使い回し、バッチごとに同じ直近範囲を再スキャンしない。途中中断で追記行を末尾に未ソートのまま残すと、次回の直近範囲探索が壊れてタイムアウトループ化するため禁止。

補填後の確認は `auditGapRepairCoverage(daysBack, minSessions)` を使う。`untreatedShort` が実際の未処理不足、`attemptedButShort` は `GAP_FAILED` / `GAP_REPAIR` などのマーカーがあるが2セッション未満のもの。

### OHLCV 不正timestamp・GAP修復タイムアウトの復旧手順

`resumeQuickRepair` / `quickRepairTrigger` がタイムアウトループになった場合、または `ohlcv_4h` に空timestamp・09:00/13:00以外のtimestampが混入した場合は、先に `emergencyStopQuickRepairAndCleanOhlcv()` を実行する。これは既存の `resumeQuickRepair` / `quickRepairTrigger` を削除し、`QUICK_REPAIR_STATE` と `QUICK_REPAIR_TAIL_CLEANUP_STATE` を消したうえで、`cleanupLegacyGapFailedAndEmptyTimestamps(false)` を本番実行する。cleanupが複数回に分かれる場合は `resumeCleanupLegacyGapFailedAndEmptyTimestamps` で再開し、完了後にだけ `CLEANUP_LEGACY_AUTO_QUICK_REPAIR_V1` を見て `quickRepairTrigger` を1分後に予約する。cleanup中に `quickRepairRecentGaps()` を直接起動しない。

`cleanupLegacyGapFailedAndEmptyTimestamps(true)` はDryRun、`false` は本番削除。対象は空timestamp、09:00/13:00以外のtimestamp、長期滞留した `GAP_FAILED`。削除した銘柄は `OHLCV_REPAIR_SYMBOLS` に積み、通常OHLCV取得の120日再取得で補填する。

### シート読み書きのベストプラクティス

- 時間主導トリガーから呼ばれる処理では `SpreadsheetApp.getActiveSpreadsheet()` に依存せず、`SPREADSHEET_ID` から `SpreadsheetApp.openById()` で対象ブックを開く。重い初期化より前に `console.log` / `Logger.log` で入口ログを出し、再開可能な長時間処理は入口直後に保険の再開トリガーを先行予約してから `LockService` で二重起動を避ける
- `ohlcv_4h` は A列（timestamp）昇順ソート前提。先頭から連続削除する処理は `sheet.deleteRows(firstDataRow, N)` で高速に行える
- `ohlcv_4h` に新規行を追記する場合は `appendRowsToSheet_` を通し、A列 timestamp を `Date` に正規化してから書く。補填・手動修復でも空 timestamp や 09:00/13:00 以外の時刻のまま直接 `setValues` しない。GAP修復のように内部でまとめて追記する場合も、追記前に各行のtimestampを検証し、追記後は中断前を含めて `dedupeAndSortOhlcv_()` で昇順 invariant を復元する
- GAP修復・監査は A列 timestamp 昇順を前提に末尾から直近分だけを読む。GAP系処理で `getRange(2, 1, lastRow - 1, ...)` の全行読みを追加しない。入口の不正timestamp掃除は営業日単位だけでスキップせず、前回チェック後に `lastRow` が増えていたら再チェックする
- デバッグ・進捗ログは `debug_webhook` に書き込まず、原則 `console.log` のみに統一する。`console.log` と `Logger.log` に同じ内容を二重出力しない。`debugLogToSheet_` は互換用の名前だが、実装はコンソール出力のみとする
- OHLCV取得の正常系ログは銘柄ごとに出さず、バッチ/チャンク単位に集約する。銘柄別のYahoo Finance取得期間・結果ログが必要な場合だけ、スクリプトプロパティ `OHLCV_VERBOSE_FETCH_LOGS=true` で詳細ログを有効化する
- 株式分割調整で `ohlcv_4h` を更新する場合は全行走査を避け、C列 `symbol` を `TextFinder` などで絞って対象銘柄の行だけ処理する
- **バルク読み込み**: `getRange(row,col).getValue()` の大量ループは高コスト。A列 timestamp の境界探索のような少数プローブに留め、データ本体は必要範囲を一括 `getValues()` で読む
- **書き戻し**: 全行一括書き戻しは避け、変更した行のみ個別に `setValues` する
- 過去OHLCV全履歴補正のような大規模修復でも、実行冒頭に `ohlcv_4h` 全行を読んで対象マップを作らない。行チャンク単位で読み、チャンク内の銘柄を小分け fetch して、進捗をスクリプトプロパティに保存する

### 週次レポート文言バリエーション

`buildWeeklySummaryText_` はDiscord投稿文を生成する。`VARIANT_HISTORY_V1` プロパティで過去3回分の文言パターンを記録し、直近と同じ表現を避けるロジックがある（`pushUniqueVariant_`）。

## よく使うデバッグ・手動操作関数

一時デバッグ・one-shot補修関数は原則として恒久化しない。復旧・監査用として残す手動関数は、この一覧か関連セクションに用途を明記する。

```javascript
setupAllTriggers()                    // トリガー全リセット（固定トリガーのみ再登録）
resetQuickRepairState()               // ギャップ修復の進捗リセット
resetAllOhlcvProperties()             // OHLCV フェーズ状態リセット
clearManualOhlcvBusinessDate()        // 手動基準日の指定を解除（通常はGAP修復完了時に自動解除）
diagOhlcvTimestamps()                 // 無効タイムスタンプ行の診断
quickScanMissingSessions()            // セッション欠落の診断（書き込みなし）
auditGapRepairCoverage(14, 2)         // GAP修復が本当に埋まっているか監査（マーカー付き未充足も表示）
auditEvaluationOhlcvCoverage120()     // 評価対象銘柄の120日OHLCVセッション充足を監査
repairEvaluationOhlcvCoverage120()    // 評価対象銘柄の120日OHLCV欠落だけを補填（再開可能）
resetEvaluationOhlcvCoverageRepairState() // 120日OHLCV補填の再開状態をリセット
buildAndSendWeeklyReportManual()      // 週次レポートの手動送信
previewWeeklyReportThisWeek()         // 今週分レポートのプレビュー
repairEmptyTimestampRows(true)        // DryRun で空/無効timestamp削除対象を確認
cleanupLegacyGapFailedAndEmptyTimestamps(true)  // DryRun で空timestamp・非09:00/13:00・長期GAP_FAILED削除対象を確認
cleanupLegacyGapFailedAndEmptyTimestamps(false) // 本番削除。未完了時は resumeCleanupLegacyGapFailedAndEmptyTimestamps で再開
emergencyStopQuickRepairAndCleanOhlcv() // GAP修復タイムアウトループ停止→OHLCV整理→完了後quickRepairTrigger自動予約
purgeBogusGapRepairRows()             // 不正な GAP_REPAIR 行を削除
repairHistoricalOhlcvVolumes()        // 旧セッション境界で保存済みの過去OHLCVを全履歴補正（再開可能）
previewHistoricalOhlcvVolumeRepair()  // 過去OHLCV補正のDryRun
debugWeekly5bdCandidates()            // 5営業日チェックポイント候補を確認
diagOneSessionDays()                  // 1セッションしかない日を診断
```
