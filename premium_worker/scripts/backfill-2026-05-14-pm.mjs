#!/usr/bin/env node
// One-time backfill: write the 8 BOTTOM alerts posted on 2026-05-14 16:06 JST to premium_alert_log.
// These were posted to Discord successfully but the spreadsheet write silently failed.
// Run from the weekly_report_gas directory: node premium_worker/scripts/backfill-2026-05-14-pm.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(WORKER_DIR, "..");

loadDotEnv(path.join(REPO_ROOT, ".env"));
loadDotEnv(path.join(WORKER_DIR, ".env"));

const SHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const LOG_HEADERS = [
  "event_at", "event_type", "alert_id", "symbol_code", "symbol_name",
  "signal_type", "title", "tradingview_url", "disclosure_links",
  "source_urls", "reason"
];

// 8 alerts posted at 2026-05-14 16:06 JST (07:06 UTC), missing from premium_alert_log.
const BACKFILL_ENTRIES = [
  {
    alertId: "tv_3c13b74fd131649521b08116a3b1b277",
    symbolCode: "7371",
    symbolName: "Zenken",
    postedAt: "2026-05-14T07:06:13.750Z",
    discordMessageUrl: "https://discord.com/channels/1479418833352785944/1501035137817640960/1504379292920971324",
    tvUrl: "https://www.tradingview.com/chart/?symbol=TSE%3A7371"
  },
  {
    alertId: "tv_1507059dbbd7445d1bc3bb6fa22acb02",
    symbolCode: "4486",
    symbolName: "ユナイトアンドグロウ",
    postedAt: "2026-05-14T07:06:14.415Z",
    discordMessageUrl: "https://discord.com/channels/1479418833352785944/1501035137817640960/1504379295789744319",
    tvUrl: "https://www.tradingview.com/chart/?symbol=TSE%3A4486"
  },
  {
    alertId: "tv_e6895a1553514fe68871aaef541d76c4",
    symbolCode: "4712",
    symbolName: "KeyHolder",
    postedAt: "2026-05-14T07:06:15.060Z",
    discordMessageUrl: "https://discord.com/channels/1479418833352785944/1501035137817640960/1504379298725761064",
    tvUrl: "https://www.tradingview.com/chart/?symbol=TSE%3A4712"
  },
  {
    alertId: "tv_d3a345a8f23473df843d1a22be05c209",
    symbolCode: "288A",
    symbolName: "ラクサス・テクノロジーズ",
    postedAt: "2026-05-14T07:06:15.789Z",
    discordMessageUrl: "https://discord.com/channels/1479418833352785944/1501035137817640960/1504379301594796114",
    tvUrl: "https://www.tradingview.com/chart/?symbol=TSE%3A288A"
  },
  {
    alertId: "tv_8936c66c07ced088f1b0536f2370980c",
    symbolCode: "7992",
    symbolName: "セーラー万年筆",
    postedAt: "2026-05-14T07:06:16.577Z",
    discordMessageUrl: "https://discord.com/channels/1479418833352785944/1501035137817640960/1504379304614695013",
    tvUrl: "https://www.tradingview.com/chart/?symbol=TSE%3A7992"
  },
  {
    alertId: "tv_78706ea2edea79e375a684ec204dfafb",
    symbolCode: "8007",
    symbolName: "高島",
    postedAt: "2026-05-14T07:06:17.292Z",
    discordMessageUrl: "https://discord.com/channels/1479418833352785944/1501035137817640960/1504379308079321158",
    tvUrl: "https://www.tradingview.com/chart/?symbol=TSE%3A8007"
  },
  {
    alertId: "tv_6569f6e5920b792f3ae36f242a44429e",
    symbolCode: "9450",
    symbolName: "ファイバーゲート",
    postedAt: "2026-05-14T07:06:18.146Z",
    discordMessageUrl: "https://discord.com/channels/1479418833352785944/1501035137817640960/1504379311312998501",
    tvUrl: "https://www.tradingview.com/chart/?symbol=TSE%3A9450"
  },
  {
    alertId: "tv_03d7b243dd44a223306430c66468d69d",
    symbolCode: "8166",
    symbolName: "タカキュー",
    postedAt: "2026-05-14T07:06:18.816Z",
    discordMessageUrl: "https://discord.com/channels/1479418833352785944/1501035137817640960/1504379314328567878",
    tvUrl: "https://www.tradingview.com/chart/?symbol=TSE%3A8166"
  }
];

function buildLogRow(entry) {
  const label = `ポジティブ材料または様子見: 2026-05-14 16:06 JST Discord投稿済み（スプシ書き込み障害のため遡及記録）`;
  const reason = `[${label.replace(/\]/g, "\\]")}](${entry.discordMessageUrl})`;
  const sourceUrls = [
    `[Yahoo!ファイナンス ${entry.symbolName}(${entry.symbolCode}) 株式情報](https://finance.yahoo.co.jp/quote/${entry.symbolCode}.T)`,
    `[IRBANK ${entry.symbolName}(${entry.symbolCode}) 開示一覧](https://irbank.net/${entry.symbolCode}/ir)`
  ].join("\n");
  return [
    entry.postedAt,
    "POSTED",
    entry.alertId,
    entry.symbolCode,
    entry.symbolName,
    "BOTTOM",
    `${entry.symbolName} (${entry.symbolCode}) | TradingView チャート`,
    entry.tvUrl,
    "開示リンク未確認",
    sourceUrls,
    reason
  ];
}

async function getGoogleAccessToken() {
  let serviceAccountJson;
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  const jsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (b64) {
    serviceAccountJson = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } else if (jsonStr) {
    serviceAccountJson = JSON.parse(jsonStr);
  } else if (credPath) {
    serviceAccountJson = JSON.parse(fs.readFileSync(credPath, "utf8"));
  } else {
    throw new Error("No Google credentials found");
  }

  const { private_key, client_email } = serviceAccountJson;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: client_email,
    scope: SHEETS_WRITE_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  })).toString("base64url");

  const { createSign } = await import("node:crypto");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(private_key, "base64url");
  const jwt = `${header}.${payload}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  if (!res.ok) throw new Error(`Token error: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function ensureSheetExists(spreadsheetId, sheetName, token) {
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!metaRes.ok) throw new Error(`Sheets metadata error: ${await metaRes.text()}`);
  const meta = await metaRes.json();
  const exists = (meta.sheets || []).some(s => s.properties?.title === sheetName);
  if (exists) return;

  const addRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] })
    }
  );
  if (!addRes.ok) throw new Error(`Add sheet error: ${await addRes.text()}`);
}

async function appendRows(spreadsheetId, sheetName, rows, token) {
  const range = `${sheetName}!A:K`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows })
    }
  );
  if (!res.ok) throw new Error(`Append error: ${await res.text()}`);
  return await res.json();
}

async function writeHeaderIfEmpty(spreadsheetId, sheetName, token) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName + "!A1:K1")}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Read header error: ${await res.text()}`);
  const data = await res.json();
  const current = (data.values || [])[0] || [];
  if (current.length > 0) return;
  await appendRows(spreadsheetId, sheetName, [LOG_HEADERS], token);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const spreadsheetId = process.env.PREMIUM_LOG_SPREADSHEET_ID;
const sheetName = process.env.PREMIUM_LOG_SHEET_NAME || "premium_alert_log";

if (!spreadsheetId) {
  console.error("PREMIUM_LOG_SPREADSHEET_ID not set");
  process.exit(1);
}

console.log(`Writing ${BACKFILL_ENTRIES.length} backfill rows to ${spreadsheetId} / ${sheetName} ...`);

const token = await getGoogleAccessToken();
await ensureSheetExists(spreadsheetId, sheetName, token);
await writeHeaderIfEmpty(spreadsheetId, sheetName, token);

const rows = BACKFILL_ENTRIES.map(buildLogRow);
const result = await appendRows(spreadsheetId, sheetName, rows, token);
console.log(JSON.stringify({ ok: true, written: rows.length, updatedRange: result.updates?.updatedRange }, null, 2));
