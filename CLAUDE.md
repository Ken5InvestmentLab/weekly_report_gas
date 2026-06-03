# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

天底極致スコアリングBot の週次レポート・OHLCV管理を担う Google Apps Script (GAS) プロジェクト。TradingView からのアラート Webhook を受信し、JPX 銘柄の中期パフォーマンス（5/10/20/40営業日後）を追跡してDiscordに週次レポートを送信する。

## コードベース構造

GAS 本体のコードはすべて **`gas.txt`** 一ファイルに集約されている（リポジトリ内で編集する場合はこのファイルを対象にする）。`premium_worker/worker.mjs` は独立した Node.js worker。

## デプロイ・実行方法

- GAS プロジェクトは Google Apps Script エディタ上で管理（ファイルは `.gs` 拡張子）
- ローカルに clasp を使う場合: `clasp push` でデプロイ、`clasp pull` で取得
- トリガーの再設定: `setupAllTriggers()` を手動実行（既存トリガーを全削除して固定トリガーのみ再登録する。動的再開トリガー実行中に実行しない）
- OHLCV固定トリガーだけを再設定する場合は `resetOhlcvFetchTriggersOnly()` を手動実行（`fetchOHLCVForNewAlertsMidday` / `fetchOHLCVForNewAlerts` だけを削除・再登録する）
- 旧スキーマ移行: `migrateCurrentSchemaToMidtermTracking_()` を手動実行

## 定期トリガー一覧

`setupAllTriggers()` で登録される**固定トリガー**（削除してはいけない）：

| 関数 | スケジュール | 役割 |
|------|-------------|------|
| `buildAndSendWeeklyReport` | 土曜 9:05 JST | 週次レポート送信 |
| `fetchOHLCVForNewAlertsMidday` | 毎日 13:21 JST | AM分OHLCV先行取得。後続チェーンなし |
| `fetchOHLCVForNewAlerts` | 毎日 15:51 JST | OHLCV本番取得 → 日次メンテ → GAP修復チェーン |
| `syncMarketHolidays` | 毎月1日 3:10 JST | 祝日カレンダー同期 |
| `purgeOldOhlcvDataDaily` | 毎日 2:00 JST | 365日超の古い OHLCV 削除 |
| `purgeOldSignalArchiveRowsDaily` | 毎日 2:10 JST | `signals_archive` の保持期限超過データ削除 |

**動的に生成・削除されるワンショットトリガー**（`setupAllTriggers()` には含めない）：

| ハンドラー関数 | 生成元 | 役割 |
|---|---|---|
| `sendDeferredDiscordPayload` | Discord 429 レート制限時 | 延期した Discord ペイロードを再送 |
| `resumeBuildAndSendWeeklyReport` | `buildAndSendWeeklyReport` 実行開始時 | 週次レポートがタイムアウトで強制終了した場合に自動リトライ（10分後発火、最大3回） |
| `runDailyMaintenanceTrigger` | OHLCV PHASE4完了後 | `runDailyMaintenance` を起動 |
| `quickRepairTrigger` | `runDailyMaintenance` 完了後 / post-maintenancecleanup完了後 | `quickRepairRecentGaps` を起動 |
| `resumeOHLCVFetchMidday` | 13:21先行OHLCV取得の再開時 | `fetchOHLCVForNewAlertsMidday` を再起動 |
| `resumeOHLCVFetch` | OHLCV フェーズ再開時 | `fetchOHLCVForNewAlerts` を再起動 |
| `resumeDailyMaintenance` | `runDailyMaintenance` 再開時 | `runDailyMaintenanceInternal_` を再起動 |
| `resumeQuickRepair` | `quickRepairRecentGaps` 再開時 | ギャップ修復を再起動 |
| `resumeOhlcvPostRepairCleanup` | GAP修復完了後 | timestamp正規化・AM保護マーキング・重複整理・最終ソートを再開 |
| `postprocessMiddayOhlcv` | 旧13:21後処理状態が残る場合 | 追記後のtimestamp正規化・不正timestamp削除を小分けで再開 |
| `resumeMiddayOhlcvRollback` | 13:21先行OHLCV戻し処理の再開時 | 触った銘柄の120日OHLCV削除を再開 |
| `purgeOldOhlcvResumeTrigger` | `purgeOldOhlcvDataDaily` 未完了時 | OHLCV削除を再起動 |
| `resumeCleanupLegacyGapFailedAndEmptyTimestamps` | 旧OHLCV残骸整理未完了時 | 空timestamp・非09:00/13:00・長期GAP_FAILED整理を再開 |
| `resumeEvaluationOhlcvCoverageRepair` | 評価対象銘柄OHLCV補填未完了時 | 120日OHLCV補填を再開 |
| `resumeHistoricalOhlcvVolumeRepair` | 過去OHLCV出来高補正未完了時 | 出来高補正を再開 |
| `resumeRepairHistoricalPmVolumeFromAlertsRaw` | `repairHistoricalPmVolumeFromAlertsRaw()` 未完了時 | alerts_raw由来PM出来高反映の再開 |
| `resumeRepairHistoricalAmVolumeFromAlertsRaw` | `repairHistoricalAmVolumeFromAlertsRaw()` 未完了時 | alerts_raw由来AM出来高反映の再開 |
| `runOhlcvPostMaintenanceCleanupTrigger` | `startOhlcvPostMaintenanceCleanupNow()` 手動実行時 | 日次メンテ後OHLCV掃除チェーン（timestamp正規化・superseded midday削除・重複整理）を再開 |
| `resumeOhlcvRecoveryTimestampNormalization` | `startOhlcvRecovery20260513()` 等の日付別OHLCV回復処理の再開時 | timestamp正規化の再開 |
| `resumeCleanupOhlcvDuplicates` | `cleanupOhlcvDuplicatesNow()` がタイムアウト/ロック競合/エラーで未完了の場合 | シート全体の重複削除を `cursor`（`OHLCV_FULL_DEDUP_STATE_V1`）から再開（30秒〜2分後に発火、完走するまで自動継続。止めるには `resetCleanupOhlcvDuplicatesState()`） |

**重要**: ワンショットトリガーは各ハンドラー関数の冒頭で `deleteTriggersByHandler_("自分の関数名")` を呼び、自分自身を削除してから処理を実行する。

## スプレッドシート構造

### `alerts_raw` 列定義

`RAW_HEADERS` の順序：

```text
alert_id, received_at, signal_date, signal_week_start, signal_type,
timeframe, symbol_code, symbol_name, entry_price, volume, tv_symbol,
eval_date_5bd, eval_close_5bd, perf_5bd, win_flag_5bd, reported_5bd,
eval_date_10bd, eval_close_10bd, perf_10bd, win_flag_10bd, reported_10bd,
eval_date_20bd, eval_close_20bd, perf_20bd, win_flag_20bd, reported_20bd,
eval_date_40bd, eval_close_40bd, perf_40bd, win_flag_40bd, reported_40bd,
status, note, logged_at
```

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
- A列 timestamp は Date オブジェクトとして書き込み、セル書式 `"yyyy/mm/dd hh:mm"` を設定する（テキスト形式 `"@"` は使わない）
- B列 `alert_id` に入るマーカー：通常取得は空文字/refresh ID、`MIDDAY_yyyy-mm-dd`（13:21先行取得）、`MIDDAY_LOCKED_yyyy-mm-dd`（AM保護行）、`PM_LOCKED_yyyy-mm-dd`（PM保護行）、`GAP_REPAIR`（ギャップ修復）、`GAP_FAILED`（取得失敗マーカー）
- `MIDDAY_LOCKED_yyyy-mm-dd` は13:21で `alerts_raw` の出来高を転記したAM保護行。15:51本番・GAP修復・重複整理でも削除・上書き禁止
- `PM_LOCKED_yyyy-mm-dd` は15:51本番で当日PMにBOTTOMシグナルが点灯した銘柄のPM行に付くマーカー。PM出来高=`alerts_raw` PM出来高で上書きされ、削除・上書き禁止
- 重複排除は `timestamp + symbol`（timestampは09:00/13:00バケット）で行い、同一キーは1行だけ残す（残す優先度は `compareOhlcvDuplicatePriority_`）
- PHASE4では重い重複削除を行わず、取得フローを完了して日次メンテナンスへ進める。通常の重複整理はGAP修復後cleanup、過去分の一括掃除は `cleanupOhlcvDuplicatesNow()`（シート全体を前方カーソルで走査、resume対応）を使う
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
| `OHLCV_PROGRESS_INDEX` / `OHLCV_SYMBOL_LIST` | 15:51 本番取得の再開カーソルと対象銘柄 |
| `OHLCV_NEW_ALERT_COUNT` | 15:51 本番取得時の当日シグナル銘柄数 |
| `CURRENT_REFRESH_ID` | 現在のOHLCV取得ID |
| `LAST_TS_MAP` | 銘柄別最終timestamp |
| `OHLCV_MIDDAY_PROGRESS_INDEX` / `OHLCV_MIDDAY_SYMBOL_LIST` | 13:21 先行取得の再開カーソルと対象銘柄 |
| `OHLCV_MIDDAY_NEW_ALERT_COUNT` | 13:21 先行取得時の当日シグナル銘柄数 |
| `OHLCV_MIDDAY_LAST_TS_MAP` | 13:21 先行取得用の銘柄別最終timestamp |
| `OHLCV_MIDDAY_REFRESH_ID` | 13:21 先行取得ID |
| `OHLCV_MIDDAY_FULL_BACKFILL_SYMBOLS` | 13:21 で120日取得する真の新規銘柄 |
| `OHLCV_MIDDAY_POSTPROCESS_PENDING` | 旧13:21 後処理トリガーが残っているかの印 |
| `OHLCV_MIDDAY_POSTPROCESS_STATE_V1` | 旧13:21 後処理（不正timestamp掃除）の再開状態 |
| `OHLCV_MIDDAY_ROLLBACK_STATE_V1` | 13:21 戻し処理の再開状態 |
| `OHLCV_MIDDAY_ROLLBACK_SYMBOLS_V1` | 13:21 戻し処理で120日削除する銘柄 |
| `DAILY_MAINT_CURSOR` | `runDailyMaintenance` の再開カーソル |
| `DAILY_MAINT_NEW_COUNT` | 日次メンテナンス用の新規件数メタ |
| `DAILY_MAINT_REFRESH_ID` | 日次メンテナンス用の取得IDメタ |
| `OHLCV_COMPLETION_NOTICE_PENDING_V1` | `runDailyMaintenance` 完了後に保存する Discord 完了通知ペイロード。`resumeOhlcvPostRepairCleanup` 完了後に送信される |
| `QUICK_REPAIR_STATE` | `quickRepairRecentGaps` の再開状態（v7） |
| `QUICK_REPAIR_TAIL_CLEANUP_STATE` | GAP修復入口の末尾不正timestamp掃除状態 |
| `OHLCV_POST_REPAIR_CLEANUP_STATE_V1` | GAP修復後 cleanup の再開状態 |
| `OHLCV_INTRADAY_STALE_SYMBOLS_V1` | Yahoo 1h が古い/null の銘柄の一時保留リスト |
| `CLEANUP_LEGACY_STATE_V1` | 旧OHLCV残骸整理の再開状態 |
| `CLEANUP_LEGACY_AUTO_QUICK_REPAIR_V1` | cleanup完了後に `quickRepairTrigger` を予約するためのフラグ |
| `SPLIT_QUEUE` / `SPLIT_INDEX` | 株式分割調整キューの進捗 |
| `OHLCV_SPLIT_CACHE` | 株式分割情報キャッシュ |
| `VARIANT_HISTORY_V1` | 週次レポート文言の重複防止履歴（JSON） |
| `OHLCV_REPAIR_SYMBOLS` | 次回OHLCV取得で120日再取得する修復対象銘柄 |
| `OHLCV_MANUAL_BUSINESS_DATE` / `OHLCV_MANUAL_BUSINESS_EXPIRES_AT` | 手動基準日と期限 |
| `QUICK_REPAIR_FAIL_COUNTS_V1` | quickRepair で 0 行返却が続く銘柄+日付の失敗回数。1h と 1d の両方が空の場合は即時 `GAP_FAILED`、0 行返却が3回連続の場合も `GAP_FAILED` を書き込みループを断つ |
| `OHLCV_FULL_DEDUP_STATE_V1` | `cleanupOhlcvDuplicatesNow()`（全行重複削除）の再開カーソル。完走で削除、`resetCleanupOhlcvDuplicatesState()` でリセット |
| `EVAL_OHLCV_COVERAGE_REPAIR_STATE_V1` | 評価対象銘柄120日OHLCV補填の再開状態 |
| `HISTORICAL_VOLUME_REPAIR_STATE_V1` | 過去OHLCV出来高補正の再開状態 |
| `HIST_ALERT_VOL_REPAIR_PM_V1` | 過去PM出来高をalerts_rawから反映するリペアの再開状態 |
| `HIST_ALERT_VOL_REPAIR_AM_V1` | 過去AM出来高をalerts_rawから反映するリペアの再開状態 |
| `HIST_ALERT_VOL_REPAIR_CHAIN_PM_TO_AM` | PM完了後にAMを自動起動するチェーンフラグ（payload: `{dryRun: bool}`） |
| `WEEKLY_REPORT_RETRY_COUNT_V1` | 週次レポート自動リトライ回数（成功時に削除、上限3回到達で停止） |

## アーキテクチャ上の重要事項

### 日次処理の実行チェーン

```
13:21  fetchOHLCVForNewAlertsMidday → AM先行取得のみ（後続チェーンなし）
         未取得銘柄は120日分、既存銘柄は当日AM分だけ取得。
         重複整理・GAP修復・広範囲timestamp掃除は15:51本番側へ委譲。

15:51  fetchOHLCVForNewAlerts → (PHASE1→2→3→4)
         PHASE1は未取得銘柄120日分、既存銘柄は当日PM分だけ取得。
         → PHASE4完了: runDailyMaintenanceTrigger（10秒後）
           → runDailyMaintenance: 評価日到達銘柄の価格更新
             → 完了後: Discord完了通知をOHLCV_COMPLETION_NOTICE_PENDING_V1に保存
               + quickRepairTrigger（10秒後）
               → quickRepairRecentGaps: セッション欠落修復
                 → 完了後: resumeOhlcvPostRepairCleanup
                   → timestamp正規化・AM保護・重複整理・ソート
                     → 完了後: OHLCV完了Discord通知 + GitHub Actions
```

**重要**: Discord完了通知は `runDailyMaintenance` 完了直後には送らない。`OHLCV_COMPLETION_NOTICE_PENDING_V1` に保存し、`resumeOhlcvPostRepairCleanup` の最終ステップで送信する。

### CacheService に保存される一時データ

| キャッシュキー | 用途 | TTL | 無効化条件 |
|---|---|---|---|
| `OHLCV_EDT_META` / `OHLCV_EDT_<n>` | `resumeOhlcvPostRepairCleanup` の EARLY_DEDUP 用 tail key set（40k 行 × 3 列を毎回再構築すると 200s+ 消費しタイムアウトループに陥るため、resume 間で再利用する） | 1800s | `lastRow` / `readFromRow` がキャッシュ時と異なる場合は自動的に無効化される。Phase 2 完走 / `completeOhlcvPostRepairCleanup_` / `resetOhlcvPostRepairCleanupNow()` で破棄 |
| `RAW_ALERT_VOLUME_MAP_V1` | `buildRawAlertVolumeMapForBusinessDate_` の結果。13:21 と 15:51 で同じ営業日のマップを 2 回計算する無駄を避ける。payload は `{ businessDate, volumeMap, stats, builtAt }` の JSON | 21600s (6h) | payload 内の `businessDate` がリクエストと不一致なら自動ミス。`expectedKeys` 付き呼び出しはキャッシュをスキップ（フィルタ済み部分集合のため）。payload > 90KB ならキャッシュしない |

**ループ安全性**: キャッシュのクリアは「完了系（Phase 2 完走・cleanup チェーン完了・手動 reset・tail size 0）」と「cache miss 時の構築直前（古い不整合チャンクの掃除）」に限定。Phase 1 / Phase 2 のタイムアウト経路では一切クリアしない。Phase 1 が途中で中断した場合は save が呼ばれずキャッシュ空 → 次回 resume も Phase 1 を最初からやり直すが、これは旧実装と同じ振る舞いであり修正で悪化はしない。1 回 Phase 1 が完走すれば以降の resume は Phase 1 をスキップして Phase 2 のみ実行できる。

### タイムアウト対策パターン（2種類）

GAS の実行上限は **6分**。長時間処理はどちらかのパターンで実装する：

**パターンA — 先行トリガー方式（`quickRepairRecentGaps`, `runOhlcvPostRepairCleanup_`）**
1. 処理開始直後に `resumeXxx` safety トリガーを先にセット。OHLCV 13:21/15:51取得では6.5分後（390秒）に固定
2. 処理が正常完了したらトリガーを削除
3. GAS の 360 秒強制終了対策。バッファ 60 秒は `.after()` のスケジュール遅延吸収用
4. ロック取得前後・対象件数・バッチ進捗を `console.log` に必ず出す
5. OHLCV 13:21/15:51取得では、バッチ追記直後に再開カーソルと補助状態を保存し、safety retry は保存済み位置から引き継ぐ
6. `.after(10 * 1000)` は10秒ぴったりの起動保証ではなく最小待機時間。実起動はGAS側の時間主導トリガーキューで遅れることがある

**パターンB — 内部タイムリミット方式（`fetchOHLCVForNewAlerts`, `runDailyMaintenance`）**
1. 処理開始時に `setupResumeTrigger_(handlerName)` で 10 秒後の継続トリガーをセット
2. 3.5〜4分経過で自発的に中断、スクリプトプロパティに進捗保存
3. 正常完了時はトリガーを削除

### OHLCV 取得フロー（4フェーズ）

```
PHASE1: OHLCV未取得銘柄は120日分、既存銘柄は当日AM/PM分を Yahoo Finance 1h足で取得
PHASE2: 株式分割検出・価格調整
PHASE3: 分割調整キューを OHLCV シートに適用
PHASE4: 重い重複削除を行わず取得フロー完了 → runDailyMaintenanceTrigger をチェーン
```

フェーズはスクリプトプロパティ `OHLCV_CURRENT_PHASE` で管理。15:51本体では `range=5d` を使わず必ず `period1/period2` を使う。13:21先行取得の既存銘柄は当日08:00〜13:00:59 JSTの当日AM分だけ、15:51本体の既存銘柄は当日13:00:00 JST以降の当日PM分だけを取得する。

### OHLCV 取得窓の決定ロジック

`buildOhlcvRequestPairForEndMillis_()` で決定する。基準値: `OHLCV_DEFAULT_LOOKBACK_DAYS=120`、`RECENT_RANGE_DAYS=5`、`OVERLAP_DAYS=3`。

| 状態 | 取得方法 |
|---|---|
| OHLCV未取得銘柄 | 直近120日分 |
| `OHLCV_REPAIR_SYMBOLS` 対象 | OHLCV未取得や手動全量修復では直近120日分。15:51本体の既存銘柄は当日PM分のみ |
| `lastTs` が直近5日以内 | `lastTs - 3日` から取得終了時刻まで `period1/period2` |
| `lastTs` が6日〜120日以内 | `lastTs - 3日` から現在まで `period1/period2` |
| `lastTs` が120日より古い | 直近120日分 |
| `lastTs` が取得終了時刻以上 | 異常値対策として直近範囲を `period1/period2` |

13:21先行取得では、OHLCV未取得銘柄だけ120日分を取得し、既存OHLCV銘柄は当日AM未取得の場合だけ当日AM分を取得する。既存キー探索や重複ガードは行わず、重複やGAPは15:51本番、GAP修復、post-repair cleanupへ委譲する。

15:51本体では、OHLCV未取得銘柄だけ120日分を取得し、既存OHLCV銘柄は当日PM未取得の場合だけ当日PM分を取得する。既存銘柄の過去GAPは15:51 PHASE1の重ね取りで埋めず、後段のGAP修復と post-repair cleanup へ委譲する。GAS再試行や120日新規取得に備え、通常のappend guardと直近重複整理は保険として残す。

### Yahoo Finance 1h足の集約ルール

- AMバケット: `09:00` / `10:00` / `11:00` / `12:00` 足をマージ → シートは `09:00 JST`
- PMバケット: `13:00` / `14:00` / `15:00` 足 + `15:30` 終値スナップショット → シートは `13:00 JST`
- `15:30` の `volume=0 / O=H=L=C` バーは終値スナップショット。PMの `close` のみ更新し、`open/high/low/volume` には混ぜない
- 15:51本番の当日PMのみ `PM出来高 = 日足出来高 - AM出来高` で補正可。他の処理では日足出来高をAM/PM片側に寄せない
- 15:51本番で当日PMにBOTTOMシグナルがある銘柄は、`PM出来高 = alerts_raw PM出来高`（`PM_LOCKED` マーカー付与）。同時にAM行（MIDDAY_LOCKED でない場合のみ）は `AM = max(0, fetched_AM + fetched_PM - alerts_raw PM)` に補正し AM+PM トータルを fetched 合計に維持する

### 一時的サーバーエラーのリトライ

`withRetry_(fn, maxRetries, baseDelayMs)` で指数バックオフリトライ（デフォルト最大3回、2s→4s→8s）。`isTransientError_(e)` が "server error" / "we're sorry" / "quota" / "timeout" / "502" / "503" を一時エラーと判定する。`quickRepairRecentGaps` の外側 `catch` では一時エラーを `throw` せず、トリガーによる自動再開に委ねる。

### チェックポイント評価ロジック

`CHECKPOINTS` 配列（5/10/20/40営業日）に基づき `alerts_raw` の各行を更新する。`reported_Xbd` フラグが `true` になった行は週次レポート対象から除外される。全チェックポイント埋まると `status = "COMPLETE"` → 一定期間後に `signals_archive` へ退避し `alerts_raw` から削除。

### Webhook 署名検証

`v1.{timestamp}.{payloadJson}` を HMAC-SHA256 で署名し、クロックスキュー ±4.5分以内のみ受理。

### GAP 修復の仕組み

`quickRepairRecentGaps` は `ohlcv_4h` 全行スキャンを避け、直近 `daysBack` 日分を銘柄バッチ単位で Yahoo Finance から再取得する。取得は `UrlFetchApp.fetchAll`、進捗は `QUICK_REPAIR_STATE` v7 で再開。修復行は B列に `GAP_REPAIR` を入れて追記。完了後は `dedupeAndSortOhlcv_()` を直接呼ばず `resumeOhlcvPostRepairCleanup` に委譲する。

**GAP_FAILED 生成条件**: 1h と 1d の両方が空（デュアルミス）の場合は即座に `GAP_FAILED` 行を書く。それ以外の 0 行返却が `QUICK_REPAIR_FAIL_THRESHOLD=3` 回連続した場合も `GAP_FAILED` を書いてループを断つ。

`quickScanMissingSessions` と `auditGapRepairCoverage` は A列 timestamp 昇順を前提に末尾から直近日数分だけ読む。全行読み込みに戻すと行数が多い環境でタイムアウトするため禁止。

### シート読み書きのベストプラクティス

- **禁止**: `getRange(row,col).getValue()` の大量ループ。データ本体は `getValues()` で一括取得
- **禁止**: 時間主導トリガーで `SpreadsheetApp.getActiveSpreadsheet()` を使う。必ず `SpreadsheetApp.openById(SPREADSHEET_ID)` を使う
- **禁止**: GAP修復・監査で `getRange(2, 1, lastRow - 1, ...)` の全行読みを追加する
- `ohlcv_4h` 先頭からの連続削除は `sheet.deleteRows(firstDataRow, N)` で高速に行う
- 通常追記は `appendRowsToSheet_` を通す。13:21軽量MIDDAY追記だけは `appendMiddayOhlcvRowsWithoutGuard_()` を使い、既存キー探索・重複ガード・readback削除を15:51側へ委譲する
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
clearManualOhlcvBusinessDate()        // 手動基準日解除

// OHLCV取得
fetchOHLCVForNewAlertsMidday()        // 13:21先行取得を手動実行
fetchOHLCVForNewAlerts()              // 15:51本番OHLCVチェーンを手動実行
resetAllOhlcvProperties()             // OHLCV関連進捗プロパティをリセット
previewRollbackMiddayOhlcv20260511()  // 13:30取得戻し対象をDryRun確認
rollbackMiddayOhlcv20260511()         // 13:30取得で触った銘柄の120日OHLCVを削除して修復キューへ積む
resumeMiddayOhlcvRollback()           // 13:21取得戻し処理の再開
resetMiddayOhlcvRollbackState()       // 13:21取得戻し処理の状態リセット

// 週次レポート
buildAndSendWeeklyReportManual()      // 週次レポートの手動送信
previewWeeklyReportThisWeek()         // 今週分レポートのプレビュー
debugWeekly5bdCandidates()            // 5営業日チェックポイント候補を確認

// GAP修復・監査
quickScanMissingSessions()            // セッション欠落の診断（書き込みなし）
quickRepairRecentGaps()               // GAP修復
resetQuickRepairState()               // ギャップ修復の進捗リセット
auditGapRepairCoverage(14, 2)         // GAP修復が埋まっているか監査
previewOhlcvPostRepairCleanup()       // GAP修復後cleanupのDryRun確認
startOhlcvPostRepairCleanupNow()      // GAP修復後cleanupを手動開始
resumeOhlcvPostRepairCleanup()        // GAP修復後cleanup再開
resetOhlcvPostRepairCleanupNow()      // GAP修復後cleanup状態リセット

// timestamp診断・修復
diagOhlcvTimestamps()                 // 無効タイムスタンプ行の診断
diagOneSessionDays()                  // 1セッションしかない日を診断
repairEmptyTimestampRows(true)        // DryRun でタイムスタンプ修復を確認
repairEmptyTimestampRows(false)       // 空/無効timestamp削除 本番
repairBlankTimestampOhlcvRowsNow()    // 空timestampを即時修復（緊急用）
cleanupLegacyGapFailedAndEmptyTimestamps(true)   // 旧OHLCV残骸整理 DryRun
cleanupLegacyGapFailedAndEmptyTimestamps(false)  // 旧OHLCV残骸整理 本番
emergencyStopQuickRepairAndCleanOhlcv()          // GAP修復停止→OHLCV整理→quickRepairTrigger予約
purgeBogusGapRepairRows()             // 不正な GAP_REPAIR 行を削除
cleanupOhlcvDuplicatesNow()           // シート全体の同一timestamp+symbol重複を一括削除（resume対応・完走まで自動継続）
resetCleanupOhlcvDuplicatesState()    // 全行重複削除の進捗・自動リトライトリガーをリセット

// 日次メンテ後OHLCV掃除チェーン（手動起動パス）
startOhlcvPostMaintenanceCleanupNow() // OHLCV掃除チェーンを手動開始（timestamp正規化→superseded midday削除→重複整理→quickRepairTrigger予約）
resetOhlcvPostMaintenanceCleanupNow() // OHLCV掃除チェーンの状態とトリガーをリセット

// 緊急停止・強制終了
stopOhlcvResumeLoopNow()              // resumeOHLCVFetch/resumeOHLCVFetchMidday を削除して再開ループ停止
forceFinishOhlcvPhase4LightNow()      // PHASE4 軽量版で強制完了、日次メンテナンスをチェーン
forceFinishOhlcvPhase4UltraLightNow() // PHASE4 超軽量版で強制完了
emergencyStopOhlcvTimeoutLoop()       // OHLCV本番取得のタイムアウトループ停止・進捗プロパティ全クリア

// 日付別OHLCV回復（one-shot補修）
previewOhlcvRecovery20260513()        // 2026-05-13 OHLCV回復のDryRun確認
startOhlcvRecovery20260513()          // 2026-05-13 のtimestamp正規化→cleanup→GAP修復スケジュール
previewRepairOhlcvAm20260511Only()    // 2026-05-11 AM行修復のDryRun確認
repairOhlcvAm20260511Only()           // 2026-05-11 AM行修復 本番

// 単発補填
refetchTodayOhlcv()                          // 当日OHLCV再取得
refetchSymbolGap(symbol, startDate, endDate) // 単一銘柄・期間のGAP補填
refetchSymbolRange(symbols, startDate, endDate) // 複数銘柄・期間の補填

// 評価対象OHLCV補填
auditEvaluationOhlcvCoverage120()    // 評価対象銘柄の120日OHLCV監査
repairEvaluationOhlcvCoverage120()   // 評価対象銘柄の120日OHLCV補填
resetEvaluationOhlcvCoverageRepairState()  // 補填状態リセット

// 過去出来高補正
previewHistoricalOhlcvVolumeRepair() // 過去出来高補正 DryRun
repairHistoricalOhlcvVolumes()       // 過去出来高補正 本番
resetHistoricalOhlcvVolumeRepairState()   // 過去出来高補正状態リセット

// alerts_raw 由来の過去出来高反映（一時リペア）
previewRepairHistoricalPmVolumeFromAlertsRaw() // 過去PM出来高をalerts_raw値で反映 DryRun（PM_LOCKED付与＋AM補正）
repairHistoricalPmVolumeFromAlertsRaw()        // 過去PM出来高をalerts_raw値で反映 本番
resumeRepairHistoricalPmVolumeFromAlertsRaw()  // 同上 resume（自動でも10秒後に発火）
resetRepairHistoricalPmVolumeState()           // PM版の状態リセット
previewRepairHistoricalAmVolumeFromAlertsRaw() // 過去AM出来高をalerts_raw値で反映 DryRun（MIDDAY_LOCKED付与）
repairHistoricalAmVolumeFromAlertsRaw()        // 過去AM出来高をalerts_raw値で反映 本番
resumeRepairHistoricalAmVolumeFromAlertsRaw()  // 同上 resume
resetRepairHistoricalAmVolumeState()           // AM版の状態リセット
chainAmRepairAfterPmCompletes()                // PM完了後にAMを自動起動するチェーンを有効化（PM実行中・実行前どちらでも可、本番モード）
chainAmRepairAfterPmCompletes({dryRun:true})   // 同上、DryRunモードで AM をチェーン
cancelChainAmRepairAfterPmCompletes()          // チェーン解除

// 削除
purgeOldOhlcvDataDaily()             // 365日超のOHLCV削除
purgeOldSignalArchiveRowsDaily()     // signals_archive保持期限超過データ削除
```

## 実装時の注意

- 一時デバッグ・one-shot補修関数は原則として恒久化しない。復旧・監査用として残す手動関数は CLAUDE.md / README.md / AGENTS.md に用途を書く。
- スクリプトプロパティ名を変更する場合は、既存状態との移行・リセット手順も同時に書く。
- トリガー名を変更する場合は、残留旧トリガー削除手順も書く。
- `setupAllTriggers()` に動的ワンショットトリガーを入れない。
- `alerts_raw` / `ohlcv_4h` レイアウトに列追加する場合は、移行関数とドキュメント更新を同時に行う。
- `doPost`、`alerts_raw` スキーマ、既存トリガー、既存スクリプトプロパティ名を不用意に変更しない。
- 投資助言・売買推奨・目標株価・スコア化に見える文言をDiscord投稿へ追加しない。

## premium_worker との関係

`premium_worker/` は GAS 本体とは独立した読み取り専用 worker。`alerts_raw` を Google Sheets API で読むだけで、`doPost`・既存トリガー・`alerts_raw` スキーマは変更しない。投稿済み状態は worker 側で管理し、既存スプレッドシートにプレミアム投稿ログを混ぜない。

プレミアム投稿ログをスプレッドシートへ残す場合は `PREMIUM_LOG_SPREADSHEET_ID` を使い、既存GAS対象とは別スプレッドシートにする。`premium_worker/state/` と `premium_worker/out/` は git 管理しない。

### BOTTOM 全件 POSTED 必須

**BOTTOMシグナルは全件 Discord に投稿しなければならない。FAILEDで終わるパスは存在しない。**

- ファンダ材料が十分な場合: `post` コマンドで通常投稿
- 材料が不十分・ソース未確認の場合: `fail` コマンドで **様子見スタブ**を投稿（`材料インパクト: 様子見`）
- バリデーション失敗でも: `fail` コマンドで様子見スタブを投稿

`fail` コマンドは内部で Discord embed を送信し `state.posted[alertId]` に記録する。`event_type=FAILED` のログ行は今後生成されない。

### スプシ書き込み失敗時の自動リカバリ

`writePremiumLogEventsSafe` がスプシ書き込みに失敗した場合:
- `state.pendingLogEvents` に events を永続化
- `process.exitCode = 2` をセット（自動化スクリプト側で異常検知可能）
- 次回 `collect` / `post` 起動時に自動 replay

環境変数 `PREMIUM_LOG_FORCE_FAIL=1` でスプシ書き込み失敗をテスト可能。
