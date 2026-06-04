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
RECENT_RANGE_DAYS = 5
OVERLAP_DAYS = 3
```

取得窓の考え方。

| 状態 | 取得方法 |
|---|---|
| `lastTs` なし | 直近120日分を `period1/period2` で取得 |
| `OHLCV_REPAIR_SYMBOLS` 対象 | OHLCV未取得や手動全量修復では直近120日分。15:51本体の既存銘柄は当日PM分のみ |
| `lastTs` が取得終了時刻以上 | 異常値対策として直近範囲を `period1/period2` で取得 |
| `lastTs` が直近5日以内 | 通常差分取得では `period1/period2` を強制し、`lastTs - 3日` から取得終了時刻まで取得 |
| `lastTs` が6日〜120日以内 | `lastTs` の3日前から現在まで `period1/period2` で取得 |
| `lastTs` が120日より古い | 直近120日分を `period1/period2` で取得 |

重要。

- 13:21先行取得の既存OHLCV銘柄は例外的に当日AMだけを取得する。OHLCV未取得銘柄は直近120日分、既存OHLCV銘柄は当日08:00〜13:00:59 JSTを `period1/period2` で取得し、重複整理・GAP修復・広範囲timestamp掃除は15:51本番側へ委譲する。
- 15:51本体の既存OHLCV銘柄も例外的に当日PMだけを取得する。既存OHLCV銘柄は当日13:00:00 JSTから取得終了時刻までを `period1/period2` で取得し、`lastTs >= 当日13:00 JST` の銘柄は取得対象から外す。
- 15:51本体では `range=5d` を使わない。`range=5d` は取得終了時刻を明示できず、当日足のキャッシュ差異でAM/PM集約が壊れるため、当日AM/PMだけの取得でも `period1/period2` を使う。
- 既存銘柄の過去GAPは15:51 PHASE1の重ね取りで埋めず、日次メンテ後の `quickRepairRecentGaps` と post-repair cleanup で補填・整理する。
- 15:51本体や後段cleanupでは、GAS再試行や120日新規取得に備えて `timestamp + symbol` の軽量重複ガード・重複整理を保険として残す。
- 120日より古い範囲の補填は通常取得に混ぜず、必要に応じて手動補填関数で明示期間を指定する。

## プレミアム通知 worker

`premium_worker/` は既存GAS本体から独立した Codex automation 用の読み取り専用worker。

### 変更禁止・保護方針

- プレミアム通知対応では、既存機能保護を最優先する。
- `gas.txt` / `doPost` / 既存トリガー / `alerts_raw` スキーマを変更しない。
- workerは Google Sheets API で `alerts_raw` を読むだけにする。
- 投稿済み状態は `premium_worker/state/` に保存する。
- 生成中ファイルは `premium_worker/out/` に保存する。
- `premium_worker/state/` と `premium_worker/out/` は git 管理しない。
- 日本語を含む `premium_worker/out/premium_reports.json` は PowerShell here-string 等で作成しない。文字化けで `?` 化することがあるため、UTF-8安全な Node 書き込みや `apply_patch` で作成・修正する。

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
- Automation起動が遅れても意図された13:05/15:36の実行枠なら、時間ゲートskipで止めず `collect --force` で回収を続ける。
- `collect` / `post` / `fail` が read-only sandbox や実行ポリシーでNode起動前に拒否された場合は、通常skip扱いにしない。書き込み可能なローカル実行環境に戻して同じコマンドを再実行し、意図枠を過ぎていれば `collect --force` を使う。
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
- `材料インパクト` はプレミアムEmbedの必須項目とし、根拠付きで以下いずれかから始める。
  - `ポジティブ材料`
  - `ネガティブ材料`
  - `様子見`
  - `混在/要確認`
- `材料インパクト` はラベル単独にしない。必ず `ラベル：根拠要約` 形式で、開示内容・数値・時期・事業影響の要約を1文添える。
- `材料インパクト` の `根拠要約` は短い1文にし、ラベル後45〜80字程度、最大90字を目安にする。詳細な数値・複数開示・確認点は `足元材料` / `ファンダ要点` / `開示リンク` に回す。
- `材料インパクト` には `PDF本文でも確認`、`主要損益項目を確認`、`次回開示で確認する局面` のような調査手順や広いチェックリスト文言を入れない。
- `混在/要確認` は、実際にポジティブ要素とネガティブ/不確定要素が併存する場合だけ使う。バッチ内のラベル比率は強制せず、根拠が正しければ全件同一ラベルでも許容する。
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
- 同一内容の開示は、URLが異なっていても1件だけ載せる。TDnet/IRBANKのdocument ID、PDFファイル、同一日時・同一タイトルで同じ資料と判断できるものは重複扱いにし、確認できる場合は `f.irbank.net` のPDF/PR直リンクを優先する。
- リンクラベルは `開示1` / `出典1` / `会社IR` のような汎用名にしない。
- 開示リンクのラベルは必ず `YYYY-MM-DD 開示タイトル(hh:mm)` 形式にし、実際の資料タイトルまたはページタイトルを使う。
- IRBANK個別開示ページ内に `f.irbank.net/pdf/...pdf` または `f.irbank.net/pr/...pdf` が確認できる場合はPDF直リンクを優先する。
- IRBANKのdocument ID内の日付と提出日がズレることがあるため、`f.irbank.net` の日付パスと `開示リンク` ラベル日はIRBANK個別開示ページまたはvalidatorが示す提出日で確認してから使う。
- `https://irbank.net/{code}/{documentId}` より、確認できるなら `https://f.irbank.net/pdf/{yyyymmdd}/{documentId}.pdf` 形式を優先する。
- `https://irbank.net/{code}/{documentId}` のHTML個別開示ページは `開示リンク` に置かない。IRBANK由来の開示は、検証できた `f.irbank.net` のPDF/PR直リンクだけを使う。
- `f.irbank.net` のPDF直リンクが `AccessDenied` / 403 / 404 で開けない場合は投稿に残さず、開ける日本語版の `f.irbank.net` 直リンク、TDnet直リンク、または会社/PRの個別開示直リンクへ切り替える。
- 本文は日本語で、各分析欄に日付・数値・事業ドライバー・確認点を含める。
- 1行メモのような薄い要約にしない。
- ファンダ分析の品質基準は `premium_worker/FUNDAMENTAL_EXAMPLES.md` を参照する。ただし固定フォーマットにはせず、銘柄・材料・開示内容に合わせて構成と重点を変える。
- `足元材料` は調査ログや開示タイトルの羅列ではなく、最新重要開示の日付・材料・数値・確認点を短い時系列で書く。
- `足元材料` と `ファンダ要点` で同じ文を繰り返さない。
- プレミアム分析文は銘柄名だけ差し替えられる汎用テンプレにしない。
- `事業概要` は実際の事業・主力サービス・顧客層を書く。
- 「開示資料で確認できる主要サービス・製品を中心に事業を展開する上場企業」「売上成長、利益率、資本政策、事業提携のどれに効くか」のような実体説明を避けた文は禁止。
- `材料インパクト` / `足元材料` / `ファンダ要点` / `注意点` では、「確認対象です」「確認する局面です」「確認したい局面です」のような汎用的な調査手順・先送り表現を分析の代替にしない。確認した結果として、何が良い/悪い/未確定なのか、どのKPIやリスクに効くのかを書く。`確認軸` は、銘柄固有のKPIやリスクを具体的に列挙する場合だけ使う。
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
- 開示が本当に少ない銘柄では、公式IR/IRBANKを確認したうえで新しい個別開示がないことを本文に明記すれば、古い公式開示を補助的に `開示リンク` へ置いてよい。
- 直近45日内の材料が薄いだけなら除外せず、公式IR/IRBANK確認済みの `様子見` レポートとして投稿する。fail は検証ソース不足、開示リンク未確認、根拠なしに限る。
- `insufficient verified sources` は銘柄ごとに公式IR/ニュース、IRBANK、TDnet/JPX相当を確認した後の個別判断に限る。`fail --input` で一括様子見stub化しない。
- 直近材料を検証できている銘柄は、dry-runのタイトル照合やレポート検証の再試行が続いてもstub化しない。失敗銘柄だけを分離し、validatorが指摘した開示タイトル・日付・直リンク・本文欄を直してgrounded reportを通す。
- 調査/フォローアップ/新規上場レポート、社長名鑑、媒体記事などの代理資料を足元材料の代替として `開示リンク` に置かない。
- POSTEDログの `Reason` は空欄にしない。
- `Reason` には `材料インパクト` の `ラベル：根拠要約` をそのまま残し、`ファンダ要点` は追記しない。
- Discord投稿URLが取得できた場合、プレミアムログの `Reason` は `材料インパクト` をMarkdownリンク化して記録する。
- プレミアム投稿に銘柄別スキャンボタンを付ける場合は、`custom_id=premium_scan:<symbolCode>` / `label=🔍 <symbolCode> をスキャンする` を使い、`screening-bot` と同じDiscord Botアプリから投稿する。Webhook単体投稿では有効ボタンにならない。

## デプロイ・実行方法

- GASプロジェクトは Google Apps Script エディタ上で管理する。
- ユーザーがGAS/コード変更を指示した通常作業では、ローカル `gas.txt` の変更だけで終えず、既定の反映手順でGAS本体も更新する。
- Codex automation実行中、特にプレミアム通知workerの実行・検証・投稿作業中は、ユーザーがその場で明示しない限りGAS本体を編集・反映しない。
- ローカルに clasp を使う場合:
  - `clasp push` でデプロイ
  - `clasp pull` で取得
  - `.clasp.json` は本番GASの `scriptId` と `rootDir: ".clasp-src"` を使う。
  - `.clasp-src/` は `clasp pull/push` 用の生成ディレクトリで、git管理しない。
  - 本番反映時は `clasp pull` でmanifestとファイル名を確認し、`gas.txt` を `.clasp-src/株価記録&週報作成.js` へ反映してから `clasp push -f` する。
- トリガー再設定:
  - `setupAllTriggers()` を手動実行
  - OHLCV固定トリガーだけを再設定する場合は `resetOhlcvFetchTriggersOnly()` を手動実行
- 旧スキーマ移行:
  - `migrateCurrentSchemaToMidtermTracking_()` を手動実行
- `setupAllTriggers()` は既存プロジェクトトリガーを全削除して固定トリガーだけ再登録する。動的な再開トリガー実行中に不用意に実行しない。
- `resetOhlcvFetchTriggersOnly()` は `fetchOHLCVForNewAlertsMidday` / `fetchOHLCVForNewAlerts` の固定トリガーだけを削除・再登録し、動的再開トリガーは触らない。

## 固定トリガー一覧

`setupAllTriggers()` で登録される固定トリガー。

| 関数 | スケジュール | 役割 |
|---|---:|---|
| `buildAndSendWeeklyReport` | 土曜 9:05 JST | 週次レポート送信 |
| `syncMarketHolidays` | 毎月1日 3:10 JST | 内閣府祝日CSV + JPX年末年始休場日を同期 |
| `fetchOHLCVForNewAlertsMidday` | 毎日 13:21 JST | 当日AM分までのOHLCV先行取得。後続チェーンなし |
| `fetchOHLCVForNewAlerts` | 毎日 15:51 JST | OHLCV本番取得 → 日次メンテ → GAP修復チェーン |
| `purgeOldOhlcvDataDaily` | 毎日 2:00 JST | 365日超の古いOHLCV削除 |
| `purgeOldSignalArchiveRowsDaily` | 毎日 2:10 JST | `signals_archive` の保持期限超過データ削除 |

## 動的ワンショットトリガー

`setupAllTriggers()` には含めない。各処理が必要に応じて作成・削除する。

| ハンドラー関数 | 生成元 | 役割 |
|---|---|---|
| `sendDeferredDiscordPayload` | Discord 429 レート制限時 | 延期したDiscordペイロードを再送 |
| `runDailyMaintenanceTrigger` | OHLCV PHASE4完了後 | `runDailyMaintenance` を起動 |
| `quickRepairTrigger` | `runDailyMaintenance` 完了後 / cleanup完了後 | `quickRepairRecentGaps` を起動 |
| `resumeOHLCVFetchMidday` | 13:21先行OHLCV取得の再開時 | `fetchOHLCVForNewAlertsMidday` を再起動 |
| `postprocessMiddayOhlcv` | 旧13:21後処理状態が残る場合 | 追記後のtimestamp正規化・不正timestamp削除を小分けで再開 |
| `resumeMiddayOhlcvRollback` | 13:21先行OHLCV戻し処理の再開時 | 触った銘柄の120日OHLCV削除を再開 |
| `resumeOHLCVFetch` | 15:51 OHLCV本番取得の再開時 | `fetchOHLCVForNewAlerts` を再起動 |
| `resumeDailyMaintenance` | 日次メンテナンス再開時 | `runDailyMaintenanceInternal_` を再開 |
| `resumeQuickRepair` | GAP修復再開時 | `quickRepairRecentGaps` を再開 |
| `resumeOhlcvPostRepairCleanup` | GAP修復後cleanup再開時 | timestamp正規化、AM保護マーキング、日付バケット重複整理、最終sortを再開 |
| `purgeOldOhlcvResumeTrigger` | OHLCV削除未完了時 | `purgeOldOhlcvDataDaily` を再開 |
| `resumeCleanupLegacyGapFailedAndEmptyTimestamps` | 旧OHLCV残骸整理未完了時 | 空timestamp・非09:00/13:00・長期GAP_FAILED整理を再開 |
| `resumeEvaluationOhlcvCoverageRepair` | 評価対象銘柄の120日OHLCV補填未完了時 | `repairEvaluationOhlcvCoverage120` を再開 |
| `resumeHistoricalOhlcvVolumeRepair` | 過去OHLCV出来高補正未完了時 | `repairHistoricalOhlcvVolumes` を再開 |

重要: ワンショットトリガーのラッパー関数は、冒頭で `deleteTriggersByHandler_("自分の関数名")` を呼び、自分自身のトリガーを削除してから本体処理を呼ぶ。
重要: `.after(10 * 1000)` は10秒ぴったりの起動保証ではなく、GAS側の最小待機時間指定。実際の起動はGoogle側の時間主導トリガーキューにより遅れることがある。

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
- A列 timestamp の保存・表示形式は `yyyy/MM/dd HH:mm` に統一し、`yyyy/MM/dd 9:00` を混在させない。
- `09:00 JST` はAM代表行。
- `13:00 JST` はPM代表行。
- B列 `alert_id` には通常取得、`MIDDAY_yyyy-mm-dd`、`MIDDAY_LOCKED_yyyy-mm-dd`、`GAP_REPAIR` などのマーカーが入る。
- `MIDDAY_LOCKED_yyyy-mm-dd` は13:21に `alerts_raw` の出来高を転記したAM保護行。15:51本番、GAP修復、重複整理、MIDDAY掃除でも削除・上書きしない。
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
| `OHLCV_VERBOSE_PM_VOLUME_LOGS` | 任意 | `true` のとき15:51本番の銘柄別PM出来高補正ログを詳細出力 |

### 内部状態

| キー | 用途 |
|---|---|
| `LAST_WEEKLY_REPORT_WEEK` | 週次レポート重複送信防止 |
| `VARIANT_HISTORY_V1` | 週次レポート文言の直近履歴 |
| `DEFERRED_DISCORD_PAYLOAD` | Discord 429時の延期ペイロード |
| `OHLCV_CURRENT_PHASE` | 15:51 OHLCV本番取得フェーズ |
| `OHLCV_PROGRESS_INDEX` | 15:51 OHLCV本番取得の再開カーソル |
| `OHLCV_SYMBOL_LIST` | 15:51 OHLCV本番取得対象銘柄 |
| `OHLCV_NEW_ALERT_COUNT` | 15:51 OHLCV本番取得時の当日シグナル銘柄数 |
| `CURRENT_REFRESH_ID` | 現在のOHLCV取得ID |
| `LAST_TS_MAP` | 銘柄別最終timestamp |
| `SYNC_ENTRY_PRICE_INDEX` | entry_price 同期処理用カーソル |
| `SPLIT_QUEUE` / `SPLIT_INDEX` | 株式分割調整キュー |
| `OHLCV_SPLIT_CACHE` | 株式分割情報キャッシュ |
| `OHLCV_TRACE_LAST` | OHLCVトレース用 |
| `OHLCV_REPAIR_SYMBOLS` | 次回120日再取得する修復対象銘柄 |
| `OHLCV_MANUAL_BUSINESS_DATE` | 手動基準日 |
| `OHLCV_MANUAL_BUSINESS_EXPIRES_AT` | 手動基準日の期限 |
| `OHLCV_MIDDAY_PROGRESS_INDEX` | 13:21先行取得の再開カーソル |
| `OHLCV_MIDDAY_SYMBOL_LIST` | 13:21先行取得対象銘柄 |
| `OHLCV_MIDDAY_NEW_ALERT_COUNT` | 13:21先行取得時の当日シグナル銘柄数 |
| `OHLCV_MIDDAY_LAST_TS_MAP` | 13:21先行取得用の銘柄別最終timestamp |
| `OHLCV_MIDDAY_REFRESH_ID` | 13:21先行取得ID |
| `OHLCV_MIDDAY_FULL_BACKFILL_SYMBOLS` | 13:21で120日取得する真の新規銘柄 |
| `OHLCV_MIDDAY_POSTPROCESS_PENDING` | 旧13:21後処理トリガーが残っているかの印 |
| `OHLCV_MIDDAY_POSTPROCESS_STATE_V1` | 旧13:21後処理の末尾timestamp掃除を小分け再開する状態 |
| `OHLCV_MIDDAY_ROLLBACK_STATE_V1` | 13:21先行取得戻し処理の再開状態 |
| `OHLCV_MIDDAY_ROLLBACK_SYMBOLS_V1` | 13:21先行取得戻し処理で120日削除する銘柄 |
| `DAILY_MAINT_CURSOR` | 日次メンテナンス再開カーソル |
| `DAILY_MAINT_NEW_COUNT` | 日次メンテナンス用の新規件数メタ |
| `DAILY_MAINT_REFRESH_ID` | 日次メンテナンス用の取得IDメタ |
| `QUICK_REPAIR_STATE` | GAP修復の再開状態。v7 |
| `QUICK_REPAIR_TAIL_CLEANUP_STATE` | GAP修復入口の末尾不正timestamp掃除状態 |
| `OHLCV_POST_REPAIR_CLEANUP_STATE_V1` | GAP修復完了後の小分けcleanup状態 |
| `OHLCV_INTRADAY_STALE_SYMBOLS_V1` | Yahoo 1hのOHLCが対象期間で古い/nullの銘柄の一時保留リスト |
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

13:21 と 15:51 は役割が異なる。

#### 13:21: `fetchOHLCVForNewAlertsMidday`

13:21はAM先行取得だけを行う。

- 当日が休場日の場合はスキップ。
- 15:51本番処理が近い場合は再開せず終了。
- 対象銘柄は `alerts_raw` に登場する `BOTTOM` シグナルの銘柄。`TOP` シグナルだけの銘柄は取得対象にしない。
- 今日シグナルが出た銘柄数はメタ情報として `OHLCV_MIDDAY_NEW_ALERT_COUNT` に保持。
- OHLCV未取得銘柄だけ120日分取得。
- 既存OHLCVがある銘柄は、当日AM未取得の場合だけ当日08:00〜13:00:59 JSTを `period1/period2` で取得する。
- 既存OHLCVがある銘柄で `lastTs >= 当日09:00 JST` のものは13:21取得対象から外す。
- fetch終端は当日AM分まで。
- 当日PM行や14:00以降のYahoo足、15:30終値スナップショットは保存しない。
- 13:21の追記は `appendMiddayOhlcvRowsWithoutGuard_()` の軽量appendを使い、既存キー探索、重複ガード、readback削除、広範囲timestamp後処理は行わない。
- 13:21で重複やGAPが残っても、その場で直さず15:51本番、GAP修復、post-repair cleanupへ委譲する。
- 13:21で `alerts_raw` から出来高を転記したAM行は `MIDDAY_LOCKED_yyyy-mm-dd` として保存し、後続処理では保護する。
- 13:21再開時も事前の末尾12,000行掃除や `postprocessMiddayOhlcv` 予約は行わない。
- 13:21取得の入口では、タイムアウト保険として `resumeOHLCVFetchMidday` を6.5分後に必ず予約する。通常の自前pause/resumeと重なっても、次回起動時に同じ入口で安全トリガーを張り直す。
- 13:21取得結果は実行末尾までメモリに溜めず、Yahoo取得バッチごとに `ohlcv_4h` へ追記し、直後にカーソル・銘柄別最終timestamp・120日取得対象を保存する。タイムアウトや15:51引き継ぎ時に、未永続化の取得済み行を失わないようにする。
- 同じ13:21取得カーソルでタイムアウトが続く場合は、次回実行でYahoo取得バッチを縮小し、単一銘柄でも詰まる場合だけ修復キューへ逃がして全体を止めない。
- 日次メンテナンス、GitHub Actions、GAP修復には進まない。
- 完了通知のみ送る。

#### 15:51: `fetchOHLCVForNewAlerts`

15:51が本番チェーンの起点。

```text
fetchOHLCVForNewAlerts
  → PHASE1: OHLCV取得
  → PHASE2: 株式分割検出・価格調整
  → PHASE3: 分割調整キュー適用
  → PHASE4: 取得フロー完了・日次メンテ予約（重複整理は後段）
    → runDailyMaintenanceTrigger
      → runDailyMaintenance
        → quickRepairTrigger
          → quickRepairRecentGaps
```

15:51開始時のルール。

- 残っている `resumeOHLCVFetchMidday` を削除。
- 13:21専用プロパティをクリア。
- 13:21で書き込まれたOHLCV行はシート上の成果として引き継ぐ。
- 13:21から15:51へ引き継がれるのは、`ohlcv_4h` に永続化済みの行だけ。13:21側で未追記のメモリ上データを前提にしない。
- 15:51側では、OHLCV未取得銘柄は120日分、既存OHLCV銘柄は当日PM分だけを取得する。
- 15:51取得の入口では、タイムアウト保険として `resumeOHLCVFetch` を6.5分後に必ず予約する。通常の自前pause/resumeと重なっても、次回起動時に同じ入口で安全トリガーを張り直す。
- 既存OHLCV銘柄で `lastTs >= 当日13:00 JST` のものは15:51取得対象から外す。
- 15:51本番で120日新規取得により同じ日付・銘柄のAM行を取得できた場合、通常の `MIDDAY_yyyy-mm-dd` のAM行は削除対象にできるが、`MIDDAY_LOCKED_yyyy-mm-dd` は保護する。
- 15:51本番の当日PM出来高は、保護AM出来高または13:21保存済みAM出来高があればそれを優先して `日足出来高 - AM出来高` で補正する。AM行自体は上書きしない。
- 当日が休場日の場合はスキップ。
- 対象銘柄は `alerts_raw` に登場する `BOTTOM` シグナルの銘柄。`OHLCV_REPAIR_SYMBOLS` も、その `BOTTOM` 銘柄集合に含まれるものだけ取得対象にする。
- OHLCV未取得銘柄は120日分取得。
- 既存OHLCVがある `OHLCV_REPAIR_SYMBOLS` の銘柄も、`BOTTOM` 銘柄に該当する場合だけ当日PM分を取得し、過去GAPは後段のGAP修復へ委譲する。
- 既存OHLCV銘柄の当日PM取得窓は、当日13:00:00 JSTから15:51実行終了時刻までを `period1/period2` で明示する。
- 15:51 PHASE1の取得結果も実行末尾までメモリに溜めず、Yahoo取得バッチごとに追記し、直後にカーソル・銘柄別最終timestamp・120日取得対象を保存する。
- 15:51 PHASE1でも同じカーソルでYahoo取得が詰まる場合は、次回実行でバッチを縮小し、単一銘柄でも詰まる場合だけ修復キューへ逃がす。

### OHLCV取得フェーズ

| フェーズ | 内容 |
|---|---|
| `PHASE1` | Yahoo Finance 1h足からOHLCV取得 |
| `PHASE2` | 株式分割検出・価格調整 |
| `PHASE3` | 分割調整キューを `ohlcv_4h` に適用 |
| `PHASE4` | 重い重複削除を行わず取得フローを完了し、日次メンテナンスを予約 |

通常の未指定取得窓は `OHLCV_DEFAULT_LOOKBACK_DAYS = 120` 日。

通常取得では、120日超の過去全期間を無制限に取りに行かない。120日より古い補填が必要な場合は、以下のような手動補填関数で銘柄・期間を明示して実行する。

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
- 13:21先行取得、GAP修復、過去出来高補正では、日足出来高を欠損しているAM/PM片側へ寄せない。AM/PM別出来高は1h足の集約値を保存し、欠損は正規再取得で補う。
- 15:51本番取得の当日PMだけは、日足出来高がAM出来高以上の場合に `PM出来高 = 日足出来高 - AM出来高` でPM行の出来高を補正してよい。1h足由来のPM OHLCがある場合はOHLCをそのまま使い、PM行を合成する必要がある場合だけ日足終値で `O=H=L=C` を埋める。

### 日次メンテナンス

主な関数。

- `runDailyMaintenance()`
- `resumeDailyMaintenance()`
- `runDailyMaintenanceTrigger()`

役割。

- 評価日を迎えた `alerts_raw` 行を更新。
- 5/10/20/40営業日後の評価価格、騰落率、勝敗を埋める。
- 全チェックポイントが埋まると `status=COMPLETE`。
- DiscordのOHLCV完了通知は、日次メンテナンス直後ではなく、`quickRepairRecentGaps` 後の `resumeOhlcvPostRepairCleanup` が完了してから送る。
- `GITHUB_PAT` があれば `Ken5InvestmentLab/screening-bot` の `optimize.yml` を起動。
- 完了後に `quickRepairTrigger` を10秒後に予約。

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
- 進捗は `QUICK_REPAIR_STATE` v7 に保存する。
- 再開位置は、実際に処理を通過した銘柄グループの `lastProcessedSymbol` を使う。
- 再開時は直近スキャンをやり直し、既に埋まったグループやマーカー付き未充足日は再取得対象から外す。
- 修復行はB列に `GAP_REPAIR` を入れる。
- 自動GAP修復でYahooから十分な1h足が返らない日は、原則として `GAP_FAILED` を作らずログに残して次回以降の正規再取得対象にする。
- Yahoo 1hのtimestamp配列が新しくてもOHLCが対象期間でnull/古い銘柄は `OHLCV_INTRADAY_STALE_SYMBOLS_V1` に記録し、当日のGAP修復から除外する。日足でAM/PMを仮造りしない。
- 手動補填など明示的に `GAP_FAILED` を作る経路でも、`09:00 JST` / `13:00 JST` の実timestamp以外は保存しない。
- 空timestamp、`00:00`、Yahoo生1h足時刻をマーカーとして保存しない。
- `quickRepairRecentGaps()` 完了時は `dedupeAndSortOhlcv_()` を直接呼ばず、`OHLCV_POST_REPAIR_CLEANUP_STATE_V1` を作って `resumeOhlcvPostRepairCleanup` に委譲する。
- post-repair cleanupは全行timestamp正規化、保護AMマーキング、日付バケット重複整理、最終sortを小分けで進める。保護AM行は削除候補に入れない。
- post-repair cleanupの最終sortは、大規模シートでは6分上限を超えるため無理に実行しない。行数が安全閾値を超える場合はsortをスキップし、後続の重複・GAP検出はunsorted-safeな日付範囲/tailスキャンで吸収する。

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
- cleanup完了後にだけ `CLEANUP_LEGACY_AUTO_QUICK_REPAIR_V1` を見て `quickRepairTrigger` を10秒後に予約。

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
- `alert_id` が `MIDDAY_YYYY-MM-DD` に完全一致する行でも、B列だけからtimestampを推定補正しない。不正行は削除し、対象銘柄を `OHLCV_REPAIR_SYMBOLS` に積む。

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
- 通常の `ohlcv_4h` 追記は `appendRowsToSheet_` を通す。
- 例外として、13:21の軽量MIDDAY追記だけは `appendMiddayOhlcvRowsWithoutGuard_()` を使い、既存キー探索と `timestamp + symbol` 重複ガードをバイパスしてよい。
- 13:21以外では、OHLCV追記前の `timestamp + symbol` 重複ガードをバイパスしない。既存キーがある場合は保護マーカーを優先し、必要な差分は追記ではなく既存行更新で吸収する。
- 追記前にtimestampを `Date` に正規化し、A列へ書く前から `yyyy/MM/dd 09:00` または `yyyy/MM/dd 13:00` のゼロ埋め文字列へ変換する。
- 通常追記はB:Hを書いた後にA列 timestamp を単独で書き、直後にA列を読み返す。空・不正・09:00/13:00以外の行は即削除し、preWrite/postWriteのtimestampサンプルをログに残す。13:21軽量MIDDAY追記では事前正規化だけを行い、readback削除は15:51側へ委譲する。
- A列 timestamp は文字列 `yyyy/MM/dd HH:mm` として書き、readbackでは `Date`、シリアル値、文字列のすべてを正規化して判定する。
- GAP修復では、readbackで実際に保存確認できたOHLCV行だけを補填成功として数える。A列timestamp保存失敗が出た場合は再開トリガーを増やさず停止する。
- 日次チェーンの追記後はGAP修復前に `dedupeAndSortOhlcv_()` を呼ばず、timestamp readback検証と軽量ガードに留める。最終整理はGAP修復完了後の `resumeOhlcvPostRepairCleanup` で小分けに行う。
- `cleanupOhlcvDuplicatesNow()` は6分上限に近づけない。小チャンク・短時間実行・削除数上限で分割し、未完了分は `resumeCleanupOhlcvDuplicates` に自動継続させる。
- Keep full-sheet `cleanupOhlcvDuplicatesNow()` on a sorted row-cursor scan; do not reintroduce per-date boundary probes for the all-period cleanup path.
- Do not run `sortOhlcvSheetByTimestampSafe_()` from the full-sheet cleanup initializer; rely on the existing A-column sort invariant and reserve explicit sorts for dedicated repair/final cleanup paths.
- Keep full-sheet duplicate cleanup batches small and well under the GAS limit; before scheduling the next `resumeCleanupOhlcvDuplicates` trigger, delete existing triggers for that same handler to avoid hitting the Apps Script trigger cap.
- Use `cleanupOhlcvDuplicateResumeTriggersOnly()` to remove stuck duplicate-cleanup resume triggers while preserving the current cleanup state.
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

fetchOHLCVForNewAlertsMidday()             // 13:21先行取得を手動実行
fetchOHLCVForNewAlerts()                   // 15:51本番OHLCVチェーンを手動実行
resetAllOhlcvProperties()                  // OHLCV関連進捗プロパティをリセット
previewRollbackMiddayOhlcv20260511()       // 2026-05-11 13:30取得戻し対象をDryRun確認
rollbackMiddayOhlcv20260511()              // 2026-05-11 13:30取得で触った銘柄の120日OHLCVを削除して修復キューへ積む
resumeMiddayOhlcvRollback()                // 13:21取得戻し処理の再開
resetMiddayOhlcvRollbackState()            // 13:21取得戻し処理の状態リセット

purgeOldOhlcvDataDaily()                   // 365日超のOHLCV削除
purgeOldSignalArchiveRowsDaily()           // signals_archive保持期限超過データ削除

quickScanMissingSessions()                 // セッション欠落診断
quickRepairRecentGaps()                    // GAP修復
resumeQuickRepair()                        // GAP修復再開
resetQuickRepairState()                    // GAP修復状態リセット
auditGapRepairCoverage(14, 2)              // GAP修復結果監査
previewOhlcvPostRepairCleanup()            // GAP修復後cleanupのDryRun確認
startOhlcvPostRepairCleanupNow()           // GAP修復後cleanupを手動開始
resumeOhlcvPostRepairCleanup()             // GAP修復後cleanup再開
resetOhlcvPostRepairCleanupNow()           // GAP修復後cleanup状態リセット

diagOhlcvTimestamps()                      // 無効timestamp診断
diagOneSessionDays()                       // 1セッション日診断
repairEmptyTimestampRows(true)             // 空/無効timestamp削除対象 DryRun
repairEmptyTimestampRows(false)            // 空/無効timestamp削除 本番
cleanupLegacyGapFailedAndEmptyTimestamps(true)   // 旧OHLCV残骸整理 DryRun
cleanupLegacyGapFailedAndEmptyTimestamps(false)  // 旧OHLCV残骸整理 本番
emergencyStopQuickRepairAndCleanOhlcv()    // GAP修復停止→OHLCV整理→完了後quickRepairTrigger予約
previewOhlcvRecovery20260513()              // DryRun audit for 2026/05/13 OHLCV recovery
startOhlcvRecovery20260513()                // start timestamp normalization, cleanup, and GAP repair scheduling
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
