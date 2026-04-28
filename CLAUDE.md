# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

天底極致スコアリングBot の週次レポート・OHLCV管理を担う Google Apps Script (GAS) プロジェクト。TradingView からのアラート Webhook を受信し、JPX 銘柄の中期パフォーマンス（5/10/20/40営業日後）を追跡してDiscordに週次レポートを送信する。

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
| `fetchOHLCVForNewAlerts` | 毎日 16:10 | 全銘柄の OHLCV データ取得 |
| `syncMarketHolidays` | 毎月1日 3:10 | 祝日カレンダー同期 |
| `purgeOldOhlcvDataDaily` | 毎日 2:00 | 古い OHLCV データ削除 |

**動的に生成・削除されるワンショットトリガー**（`setupAllTriggers()` には含まれない）：

| ハンドラー関数 | 生成元 | 役割 |
|---|---|---|
| `runDailyMaintenanceTrigger` | OHLCV PHASE4完了後 | `runDailyMaintenance` を起動 |
| `quickRepairTrigger` | `runDailyMaintenance` 完了後 | `quickRepairRecentGaps` を起動 |
| `resumeOHLCVFetch` | OHLCV フェーズ再開時 | `fetchOHLCVForNewAlerts` を再起動 |
| `resumeDailyMaintenance` | `runDailyMaintenance` 再開時 | `runDailyMaintenanceInternal_` を再起動 |
| `resumeQuickRepair` | `quickRepairRecentGaps` 再開時 | ギャップ修復を再起動 |
| `purgeOldOhlcvResumeTrigger` | `purgeOldOhlcvDataDaily` 未完了時 | OHLCV削除を再起動 |

**重要**: ワンショットトリガーは各ハンドラー関数の冒頭で `deleteTriggersByHandler_("自分の関数名")` を呼び、自分自身を削除してから処理を実行する。これをしないとトリガー一覧に残留する。

## スプレッドシート構造

| シート名 | 役割 |
|----------|------|
| `alerts_raw` | Webhook で受信したアラートと評価結果（ヘッダー行=4行目、データ開始=5行目） |
| `ohlcv_4h` | 4時間足相当（前場AM・後場PM）の OHLCV データ（ヘッダー行=1行目、データ開始=2行目） |
| `alerts_report` | 週次レポートのアーカイブ |
| `market_holidays` | 日本市場の休場日 |
| `debug_webhook` | Webhook デバッグログ（7日保持） |

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
| `DAILY_MAINT_CURSOR` | 内部 | `runDailyMaintenance` の再開カーソル |
| `QUICK_REPAIR_STATE` | 内部 | `quickRepairRecentGaps` の再開カーソル（v3: `nextIndex` / `totalSymbols` / `totalRows` など） |
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

`fetchOHLCVForNewAlerts`（16:10 直接トリガー）が起点：

```
fetchOHLCVForNewAlerts → (PHASE1→2→3→4)
  → PHASE4完了: runDailyMaintenanceTrigger（1分後）
    → runDailyMaintenance: 評価日到達銘柄の価格更新
      → 完了後: quickRepairTrigger（1分後）
        → quickRepairRecentGaps: セッション欠落修復
```

各ワンショットトリガーのハンドラーはラッパー関数（例: `runDailyMaintenanceTrigger`）であり、起動直後に自分自身を `deleteTriggersByHandler_` で削除してから本体を呼ぶ。

### OHLCV 取得フロー（4フェーズ）

```
PHASE1: 全銘柄の OHLCV を Yahoo Finance 1h足で取得
PHASE2: 株式分割検出・価格調整
PHASE3: 分割調整キューを OHLCV シートに適用
PHASE4: 重複排除・ソート・完了通知 → runDailyMaintenanceTrigger をチェーン
```

各フェーズはスクリプトプロパティ `OHLCV_CURRENT_PHASE` で管理。

### 一時的サーバーエラーのリトライ

`withRetry_(fn, maxRetries, baseDelayMs)` で指数バックオフリトライ（デフォルト最大3回、2s→4s→8s）。`isTransientError_(e)` が "server error" / "we're sorry" / "service unavailable" / "quota" / "timeout" / "502" / "503" を一時エラーと判定する。`quickRepairRecentGaps` の外側 `catch` では一時エラーを `throw` せず、トリガーによる自動再開に委ねる（GASに「失敗」と記録させない）。

### チェックポイント評価ロジック

`CHECKPOINTS` 配列（5/10/20/40営業日）に基づき `alerts_raw` の各行を更新する。`reported_Xbd` フラグが `true` になった行は週次レポート対象から除外される。全チェックポイント埋まると `status = "COMPLETE"` になり、一定期間後に `purgeArchivedRawRows_` で削除される。

### Webhook 署名検証

`v1.{timestamp}.{payloadJson}` を HMAC-SHA256 で署名し、クロックスキュー ±4.5分以内のみ受理。

### GAP 修復の仕組み

`quickRepairRecentGaps` は巨大な `ohlcv_4h` 全行スキャンを避けるため、`alerts_raw` の対象銘柄を取得し、直近 `daysBack` 日分を銘柄バッチ単位で Yahoo Finance から再取得する。取得は `UrlFetchApp.fetchAll` を使い、進捗は `QUICK_REPAIR_STATE` v3 の `nextIndex` で再開する。

修復行は B列に `GAP_REPAIR` を入れて追記し、最後に `timestamp + symbol` で重複排除・A列 timestamp 昇順ソートする。`refetchSymbolGap(symbol, startDate, endDate)` は手動用の単一補填関数で、前後3日マージンで取得しても、成功判定は対象日付範囲内の行だけに限定する（対象日以外が取れただけで成功扱いしない）。

`quickScanMissingSessions` と `auditGapRepairCoverage` は `ohlcv_4h` のA列 timestamp 昇順を前提に、末尾から直近日数ぶんだけ読む。全行読み込みに戻すと、行数が大きい環境でログを出す前に6分タイムアウトするので禁止。

補填後の確認は `auditGapRepairCoverage(daysBack, minSessions)` を使う。`untreatedShort` が実際の未処理不足、`attemptedButShort` は `GAP_FAILED` / `GAP_REPAIR` などのマーカーがあるが2セッション未満のもの。

### シート読み書きのベストプラクティス

- `ohlcv_4h` は A列（timestamp）昇順ソート前提。先頭から連続削除する処理は `sheet.deleteRows(firstDataRow, N)` で高速に行える
- GAP修復・監査は A列 timestamp 昇順を前提に末尾から直近分だけを読む。GAP系処理で `getRange(2, 1, lastRow - 1, ...)` の全行読みを追加しない
- **バルク読み込み**: `getRange(row,col).getValue()` の繰り返しは高コスト。末尾から `(daysBack + 7) * 1000` 行を一括読み込みする
- **書き戻し**: 全行一括書き戻しは避け、変更した行のみ個別に `setValues` する

### 週次レポート文言バリエーション

`buildWeeklySummaryText_` はDiscord投稿文を生成する。`VARIANT_HISTORY_V1` プロパティで過去3回分の文言パターンを記録し、直近と同じ表現を避けるロジックがある（`pushUniqueVariant_`）。

## よく使うデバッグ・手動操作関数

```javascript
setupAllTriggers()                    // トリガー全リセット（固定トリガーのみ再登録）
resetQuickRepairState()               // ギャップ修復の進捗リセット
resetAllOhlcvProperties()             // OHLCV フェーズ状態リセット
diagOhlcvTimestamps()                 // 無効タイムスタンプ行の診断
quickScanMissingSessions()            // セッション欠落の診断（書き込みなし）
auditGapRepairCoverage(14, 2)         // GAP修復が本当に埋まっているか監査（マーカー付き未充足も表示）
buildAndSendWeeklyReportManual()      // 週次レポートの手動送信
previewWeeklyReportThisWeek()         // 今週分レポートのプレビュー
repairEmptyTimestampRows(true)        // DryRun でタイムスタンプ修復を確認
purgeBogusGapRepairRows()             // 不正な GAP_REPAIR 行を削除
debugWeekly5bdCandidates()            // 5営業日チェックポイント候補を確認
diagOneSessionDays()                  // 1セッションしかない日を診断
```
