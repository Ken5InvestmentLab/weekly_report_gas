#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const WORKER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(WORKER_DIR, "..");
const DEFAULT_STATE_PATH = path.join(WORKER_DIR, "state", "premium_alert_state.json");
const DEFAULT_OUT_DIR = path.join(WORKER_DIR, "out");

const RAW_HEADERS = [
  "alert_id", "received_at", "signal_date", "signal_week_start", "signal_type",
  "timeframe", "symbol_code", "symbol_name", "entry_price", "volume", "tv_symbol",
  "eval_date_5bd", "eval_close_5bd", "perf_5bd", "win_flag_5bd", "reported_5bd",
  "eval_date_10bd", "eval_close_10bd", "perf_10bd", "win_flag_10bd", "reported_10bd",
  "eval_date_20bd", "eval_close_20bd", "perf_20bd", "win_flag_20bd", "reported_20bd",
  "eval_date_40bd", "eval_close_40bd", "perf_40bd", "win_flag_40bd", "reported_40bd",
  "status", "note", "logged_at"
];

const REQUIRED_FIELDS = ["事業概要", "足元材料", "ファンダ要点", "注意点", "開示リンク", "Sources"];
const OPTIONAL_FIELDS = ["材料インパクト"];
const DEFAULT_ALLOWED_HOURS = "13,15";
const DEFAULT_ALLOWED_MINUTES_BY_HOUR = "13:05,15:36";
const DEFAULT_SIGNAL_TYPES = "BOTTOM";
const DEFAULT_ALLOWED_WEEKDAYS = "1,2,3,4,5";
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const LOG_HEADERS = [
  "event_at", "event_type", "alert_id", "symbol_code", "symbol_name",
  "signal_type", "title", "tradingview_url", "disclosure_links",
  "source_urls", "reason"
];

loadDotEnv(path.join(REPO_ROOT, ".env"));
loadDotEnv(path.join(WORKER_DIR, ".env"));

const args = process.argv.slice(2);
const command = args[0] || "help";
const options = parseOptions(args.slice(1));

try {
  switch (command) {
    case "collect":
      await collect(options);
      break;
    case "post":
      await post(options);
      break;
    case "fail":
      await fail(options);
      break;
    case "lock-before":
      await lockBefore(options);
      break;
    case "status":
      status();
      break;
    case "self-test":
      selfTest();
      break;
    case "help":
    default:
      printHelp();
      break;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}

async function collect(opts) {
  const now = new Date();
  const gate = evaluateTimeGate(now, opts.force === true);
  if (!gate.allowed) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: gate.reason,
      jstHour: gate.jstHour,
      jstWeekday: gate.jstWeekday
    }, null, 2));
    return;
  }

  const spreadsheetId = requiredEnv("PREMIUM_SPREADSHEET_ID", "SPREADSHEET_ID");
  const sheetName = env("PREMIUM_SHEET_NAME") || "alerts_raw";
  const maxRows = nonNegativeInt(env("PREMIUM_SCAN_MAX_ROWS"), 0);
  const maxAlerts = nonNegativeInt(env("PREMIUM_MAX_ALERTS_PER_RUN"), 0);
  const statePath = env("PREMIUM_STATE_PATH") || DEFAULT_STATE_PATH;
  const outDir = env("PREMIUM_OUT_DIR") || DEFAULT_OUT_DIR;

  const state = loadState(statePath);
  pruneExpiredClaims(state, now);

  const token = await getGoogleAccessToken([SHEETS_READONLY_SCOPE]);
  const values = await readSheetValues(spreadsheetId, `${sheetName}!A4:AH`, token);
  const allRows = mapRawRows(values);
  const rows = maxRows > 0 ? allRows.slice(-maxRows) : allRows;
  const selected = selectPendingAlerts(rows, state, now);
  const pending = maxAlerts > 0 ? selected.slice(0, maxAlerts) : selected;
  const claimId = crypto.randomUUID();

  for (const alert of pending) {
    state.claims[alert.alertId] = {
      claimId,
      claimedAt: now.toISOString(),
      symbolCode: alert.symbolCode,
      symbolName: alert.symbolName
    };
  }
  saveState(statePath, state);

  ensureDir(outDir);
  const claim = {
    ok: true,
    claimId,
    generatedAt: now.toISOString(),
    claimedCount: pending.length,
    alerts: pending,
    outputReportPath: path.join(outDir, "premium_reports.json"),
    rules: {
      requiredFields: REQUIRED_FIELDS,
      disclosureFallback: "開示リンク未確認",
      prohibited: ["buy/sell recommendations", "target prices", "additional scores"]
    }
  };
  const latestPath = path.join(outDir, "latest_claim.json");
  writeJson(latestPath, claim);
  console.log(JSON.stringify({ ok: true, claimedCount: pending.length, claimPath: latestPath }, null, 2));
}

async function post(opts) {
  const inputPath = opts.input || opts.i;
  if (!inputPath) throw new Error("post requires --input <path>");
  const dryRun = opts["dry-run"] === true;
  const statePath = env("PREMIUM_STATE_PATH") || DEFAULT_STATE_PATH;
  const webhookUrl = dryRun ? "" : requiredEnv("DISCORD_PREMIUM_WEBHOOK_URL");
  const state = loadState(statePath);
  const reports = sortReportsByImpact(normalizeReports(readJson(path.resolve(inputPath))));
  if (!reports.length) throw new Error("report file contains no reports");

  const results = [];
  for (const report of reports) {
    const embed = buildEmbed(report);
    const payload = {
      username: env("DISCORD_PREMIUM_USERNAME") || "天底極致 Premium Report",
      allowed_mentions: { parse: [] },
      embeds: [embed]
    };

    if (dryRun) {
      results.push({ alertId: report.alertId, dryRun: true, payload });
      continue;
    }

    await postDiscord(webhookUrl, payload);
    const claim = state.claims[report.alertId] || {};
    const symbolCode = String(report.symbolCode || claim.symbolCode || extractSymbolCodeFromUrl(embed.url) || "").trim();
    state.posted[report.alertId] = {
      postedAt: new Date().toISOString(),
      symbolCode,
      symbolName: String(report.symbolName || claim.symbolName || ""),
      title: embed.title,
      url: embed.url || "",
      sourceCount: countUrls(JSON.stringify(embed))
    };
    delete state.claims[report.alertId];
    delete state.failed[report.alertId];
    results.push({ alertId: report.alertId, posted: true });
    saveState(statePath, state);
    await writePremiumLogEventsSafe([buildPostLogEvent(report, embed, claim)]);
  }

  if (!dryRun) saveState(statePath, state);
  console.log(JSON.stringify({ ok: true, posted: results.filter(r => r.posted).length, results }, null, 2));
}

async function fail(opts) {
  const statePath = env("PREMIUM_STATE_PATH") || DEFAULT_STATE_PATH;
  const state = loadState(statePath);
  const inputPath = opts.input || opts.i;
  const failures = [];

  if (inputPath) {
    const data = readJson(path.resolve(inputPath));
    const items = Array.isArray(data) ? data : (data.failures || []);
    for (const item of items) failures.push({ alertId: String(item.alertId || ""), reason: String(item.reason || "failed") });
  } else {
    failures.push({ alertId: String(opts["alert-id"] || opts.alertId || ""), reason: String(opts.reason || "failed") });
  }

  const now = new Date().toISOString();
  for (const item of failures) {
    if (!item.alertId) throw new Error("fail requires --alert-id <id> or --input with alertId");
    const previous = state.failed[item.alertId] || {};
    state.failed[item.alertId] = {
      attempts: Number(previous.attempts || 0) + 1,
      lastFailedAt: now,
      reason: item.reason
    };
    delete state.claims[item.alertId];
  }
  saveState(statePath, state);
  await writePremiumLogEventsSafe(failures.map(item => buildFailureLogEvent(item, now)));
  console.log(JSON.stringify({ ok: true, failed: failures.length, failures }, null, 2));
}

async function lockBefore(opts) {
  const cutoffDate = String(opts.date || opts.before || "").trim();
  if (!cutoffDate) throw new Error("lock-before requires --date <yyyy-mm-dd>");
  const cutoffMs = parseJstDateEndMs(cutoffDate);
  const spreadsheetId = requiredEnv("PREMIUM_SPREADSHEET_ID", "SPREADSHEET_ID");
  const sheetName = env("PREMIUM_SHEET_NAME") || "alerts_raw";
  const statePath = env("PREMIUM_STATE_PATH") || DEFAULT_STATE_PATH;
  const state = loadState(statePath);

  const token = await getGoogleAccessToken([SHEETS_READONLY_SCOPE]);
  const values = await readSheetValues(spreadsheetId, `${sheetName}!A4:AH`, token);
  const rows = mapRawRows(values);
  const now = new Date().toISOString();
  const examples = [];
  let locked = 0;
  let alreadyLocked = 0;
  let skippedNoDate = 0;

  for (const row of rows) {
    const receivedAtMs = parseReceivedAtMs(row.receivedAt || row.signalDate);
    if (!receivedAtMs) {
      skippedNoDate++;
      continue;
    }
    if (receivedAtMs > cutoffMs) continue;

    if (state.posted[row.alertId]) {
      alreadyLocked++;
    } else {
      state.posted[row.alertId] = {
        postedAt: now,
        lockedAt: now,
        lockReason: `historical alert received_at <= ${cutoffDate}`,
        receivedAt: row.receivedAt,
        signalType: row.signalType,
        symbolCode: row.symbolCode,
        symbolName: row.symbolName,
        title: `${row.symbolName}（${row.symbolCode}）｜Historical lock`,
        url: row.tradingViewUrl,
        sourceCount: 0
      };
      locked++;
      if (examples.length < 5) examples.push({
        alertId: row.alertId,
        receivedAt: row.receivedAt,
        signalType: row.signalType,
        symbolCode: row.symbolCode,
        symbolName: row.symbolName
      });
    }
    delete state.claims[row.alertId];
    delete state.failed[row.alertId];
  }

  saveState(statePath, state);
  console.log(JSON.stringify({
    ok: true,
    cutoffDate,
    cutoffJstEnd: new Date(cutoffMs).toISOString(),
    scanned: rows.length,
    locked,
    alreadyLocked,
    skippedNoDate,
    statePath,
    examples
  }, null, 2));
}

function status() {
  const statePath = env("PREMIUM_STATE_PATH") || DEFAULT_STATE_PATH;
  const state = loadState(statePath);
  console.log(JSON.stringify({
    ok: true,
    statePath,
    posted: Object.keys(state.posted).length,
    failed: Object.keys(state.failed).length,
    claims: Object.keys(state.claims).length,
    gate: evaluateTimeGate(new Date(), false)
  }, null, 2));
}

function mapRawRows(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const headers = values[0].map(v => String(v || "").trim());
  const index = {};
  for (const name of RAW_HEADERS) index[name] = headers.indexOf(name);
  if (index.alert_id < 0 || index.symbol_code < 0) {
    throw new Error("alerts_raw header row does not match expected schema");
  }

  return values.slice(1)
    .map(row => {
      const get = name => {
        const i = index[name];
        return i >= 0 ? row[i] : "";
      };
      const symbolCode = cleanCell(get("symbol_code"));
      const tvSymbol = normalizeTradingViewSymbol(cleanCell(get("tv_symbol")) || (symbolCode ? `TSE:${symbolCode}` : ""));
      return {
        alertId: cleanCell(get("alert_id")),
        receivedAt: cleanCell(get("received_at")),
        signalDate: cleanCell(get("signal_date")),
        signalType: cleanCell(get("signal_type")),
        timeframe: cleanCell(get("timeframe")),
        symbolCode,
        symbolName: cleanCell(get("symbol_name")),
        entryPrice: cleanCell(get("entry_price")),
        volume: cleanCell(get("volume")),
        tvSymbol,
        tradingViewUrl: buildTradingViewUrl(tvSymbol)
      };
    })
    .filter(row => row.alertId && row.symbolCode);
}

function selectPendingAlerts(rows, state, now) {
  const retryAfterMs = positiveInt(env("PREMIUM_RETRY_AFTER_MINUTES"), 24 * 60) * 60 * 1000;
  const maxAttempts = positiveInt(env("PREMIUM_MAX_ATTEMPTS"), 3);
  const signalTypes = allowedSignalTypes();
  return [...rows].sort(compareAlertsNewestFirst).filter(row => {
    if (!signalTypes.has(normalizeSignalType(row.signalType))) return false;
    if (state.posted[row.alertId]) return false;
    const claim = state.claims[row.alertId];
    if (claim && Date.parse(claim.claimedAt || "") + CLAIM_TTL_MS > now.getTime()) return false;
    const failed = state.failed[row.alertId];
    if (failed) {
      if (Number(failed.attempts || 0) >= maxAttempts) return false;
      const failedAt = Date.parse(failed.lastFailedAt || "");
      if (Number.isFinite(failedAt) && failedAt + retryAfterMs > now.getTime()) return false;
    }
    return true;
  });
}

function compareAlertsNewestFirst(a, b) {
  const byReceivedAt = parseReceivedAtMs(b.receivedAt) - parseReceivedAtMs(a.receivedAt);
  if (byReceivedAt) return byReceivedAt;
  return String(b.alertId || "").localeCompare(String(a.alertId || ""));
}

function parseReceivedAtMs(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (match) {
    const [, y, m, d, hh = "0", mm = "0", ss = "0"] = match;
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) - 9, Number(mm), Number(ss));
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJstDateEndMs(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) throw new Error(`invalid JST cutoff date: ${value}`);
  const [, y, m, d] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d), 14, 59, 59, 999);
}

function normalizeSignalType(value) {
  return String(value || "").trim().toUpperCase();
}

function allowedSignalTypes() {
  const raw = env("PREMIUM_SIGNAL_TYPES") || DEFAULT_SIGNAL_TYPES;
  const items = raw.split(",").map(normalizeSignalType).filter(Boolean);
  return new Set(items.length ? items : [DEFAULT_SIGNAL_TYPES]);
}

function buildEmbed(report) {
  const alertId = String(report.alertId || "").trim();
  if (!alertId) throw new Error("report is missing alertId");
  const title = buildEmbedTitle(report);
  const textForPolicy = JSON.stringify(report);
  assertNoInvestmentAdvice(textForPolicy);

  const fieldMap = new Map();
  for (const field of report.fields || []) {
    const name = String(field.name || "").trim();
    if (name) fieldMap.set(name, String(field.value || "").trim());
  }

  for (const name of REQUIRED_FIELDS) {
    if (!fieldMap.has(name)) fieldMap.set(name, name === "開示リンク" ? "開示リンク未確認" : "");
  }
  if (!fieldMap.get("開示リンク")) fieldMap.set("開示リンク", "開示リンク未確認");
  if (!hasUrl(fieldMap.get("開示リンク")) && fieldMap.get("開示リンク") !== "開示リンク未確認") {
    fieldMap.set("開示リンク", `${fieldMap.get("開示リンク")}\n開示リンク未確認`);
  }
  if (!hasUrl(fieldMap.get("Sources"))) {
    throw new Error(`report ${alertId} must include at least one URL in Sources`);
  }

  const fieldNames = [
    ...OPTIONAL_FIELDS.filter(name => fieldMap.has(name) && fieldMap.get(name)),
    ...REQUIRED_FIELDS
  ];
  const fields = fieldNames.map(name => ({
    name,
    value: truncate(fieldMap.get(name) || (name === "開示リンク" ? "開示リンク未確認" : "未確認"), 1024),
    inline: false
  }));

  return {
    title,
    url: normalizeEmbedUrl(report.url || ""),
    color: resolveEmbedColor(report, fieldMap),
    timestamp: new Date().toISOString(),
    fields,
    footer: { text: "Premium fundamental snapshot / Not investment advice" }
  };
}

function buildEmbedTitle(report) {
  const baseTitle = truncate(String(report.title || "Premium Snapshot").trim(), 256);
  const url = String(report.url || "");
  if (/tradingview\.com/i.test(url) && !/TradingView|チャート/i.test(baseTitle)) {
    return truncate(`TradingViewチャート｜${baseTitle}`, 256);
  }
  return baseTitle;
}

function resolveEmbedColor(report, fieldMap) {
  if (report.color != null && String(report.color).trim() !== "") return Number(report.color);
  const impact = String(report.materialImpact || fieldMap.get("材料インパクト") || "");
  if (/様子見|中立|要確認|混在|watch|neutral|mixed/i.test(impact)) return 0xF9A825;
  if (/ポジティブ|positive/i.test(impact)) return 0x2E7D32;
  if (/ネガティブ|negative/i.test(impact)) return 0xC62828;
  return 5793266;
}

function sortReportsByImpact(reports) {
  const order = new Map([
    ["positive", 0],
    ["watch", 1],
    ["negative", 2],
    ["unknown", 3]
  ]);
  return reports
    .map((report, index) => ({ report, index, rank: order.get(classifyReportImpact(report)) ?? 3 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(item => item.report);
}

function classifyReportImpact(report) {
  const direct = String(report.materialImpact || "");
  const fromFields = Array.isArray(report.fields)
    ? report.fields.find(field => String(field.name || "").trim() === "材料インパクト")
    : null;
  const text = `${direct}\n${fromFields ? String(fromFields.value || "") : ""}`;
  if (/様子見|中立|要確認|混在|watch|neutral|mixed/i.test(text)) return "watch";
  if (/ポジティブ|positive/i.test(text)) return "positive";
  if (/ネガティブ|negative/i.test(text)) return "negative";
  return "unknown";
}

function assertNoInvestmentAdvice(text) {
  const prohibited = [
    /買い推奨/,
    /売り推奨/,
    /目標株価/,
    /追加採点/,
    /[0-9０-９]+点満点/,
    /スコア\s*[:：]\s*[0-9０-９]/,
    /購入推奨|売却推奨|買うべき|売るべき/,
    /利確|損切り/
  ];
  for (const pattern of prohibited) {
    if (pattern.test(text)) throw new Error(`report contains prohibited wording: ${pattern}`);
  }
}

async function postDiscord(webhookUrl, payload) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (response.status >= 200 && response.status < 300) return;

    const body = await response.text();
    if (response.status === 429 && attempt < 3) {
      const retryAfter = parseRetryAfterMs(response, body);
      if (retryAfter <= 30000) {
        await sleep(retryAfter);
        continue;
      }
    }
    throw new Error(`Discord webhook failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  }
}

async function readSheetValues(spreadsheetId, range, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
  url.searchParams.set("majorDimension", "ROWS");
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Sheets API failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
  }
  const data = await response.json();
  return data.values || [];
}

async function updateSheetValues(spreadsheetId, range, values, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
  url.searchParams.set("valueInputOption", "USER_ENTERED");
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ range, majorDimension: "ROWS", values })
  });
  if (!response.ok) {
    throw new Error(`Sheets update failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
  }
  return response.json();
}

async function appendSheetValues(spreadsheetId, range, values, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`);
  url.searchParams.set("valueInputOption", "USER_ENTERED");
  url.searchParams.set("insertDataOption", "INSERT_ROWS");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ majorDimension: "ROWS", values })
  });
  if (!response.ok) {
    throw new Error(`Sheets append failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
  }
  return response.json();
}

async function batchUpdateSpreadsheet(spreadsheetId, requests, accessToken) {
  if (!requests.length) return {};
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ requests })
  });
  if (!response.ok) {
    throw new Error(`Sheets batchUpdate failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
  }
  return response.json();
}

async function getSpreadsheetSheets(spreadsheetId, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`);
  url.searchParams.set("fields", "sheets.properties(sheetId,title)");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Sheets metadata failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
  }
  const data = await response.json();
  return (data.sheets || []).map(sheet => sheet.properties);
}

async function ensureSheetWithHeader(spreadsheetId, sheetName, headers, accessToken) {
  let sheets = await getSpreadsheetSheets(spreadsheetId, accessToken);
  let sheet = sheets.find(item => item.title === sheetName);
  if (!sheet) {
    await batchUpdateSpreadsheet(spreadsheetId, [{ addSheet: { properties: { title: sheetName } } }], accessToken);
    sheets = await getSpreadsheetSheets(spreadsheetId, accessToken);
    sheet = sheets.find(item => item.title === sheetName);
  }
  if (!sheet) throw new Error(`Could not create or find sheet: ${sheetName}`);

  const headerRange = `${quoteSheetName(sheetName)}!A1:${columnName(headers.length)}1`;
  const headerValues = await readSheetValues(spreadsheetId, headerRange, accessToken);
  const current = headerValues[0] || [];
  const isEmpty = current.length === 0 || current.every(value => String(value || "").trim() === "");
  if (isEmpty) await updateSheetValues(spreadsheetId, headerRange, [headers], accessToken);
  return sheet.sheetId;
}

async function writePremiumLogEventsSafe(events) {
  if (!events.length) return;
  try {
    const config = getPremiumLogConfig();
    if (!config) return;
    const token = await getGoogleAccessToken([SHEETS_WRITE_SCOPE]);
    await ensureSheetWithHeader(config.spreadsheetId, config.logSheetName, LOG_HEADERS, token);
    await deleteOldPremiumLogRows(config, token);
    await appendSheetValues(
      config.spreadsheetId,
      `${quoteSheetName(config.logSheetName)}!A:${columnName(LOG_HEADERS.length)}`,
      events.map(logEventToRow),
      token
    );
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      warning: "premium log spreadsheet write skipped",
      error: error.message
    }, null, 2));
  }
}

async function deleteOldPremiumLogRows(config, accessToken) {
  const sheetId = await ensureSheetWithHeader(config.spreadsheetId, config.logSheetName, LOG_HEADERS, accessToken);

  const range = `${quoteSheetName(config.logSheetName)}!A2:${columnName(LOG_HEADERS.length)}`;
  const values = await readSheetValues(config.spreadsheetId, range, accessToken);
  if (!values.length) return;

  const cutoffMs = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
  const rowNumbersToDelete = [];
  values.forEach((row, index) => {
    const eventAtMs = Date.parse(row[0] || "");
    if (Number.isFinite(eventAtMs) && eventAtMs < cutoffMs) {
      rowNumbersToDelete.push(index + 2);
    }
  });
  if (!rowNumbersToDelete.length) return;

  const requests = buildDeleteRowRequests(sheetId, rowNumbersToDelete);
  await batchUpdateSpreadsheet(config.spreadsheetId, requests, accessToken);
}

function getPremiumLogConfig() {
  const spreadsheetId = env("PREMIUM_LOG_SPREADSHEET_ID");
  if (!spreadsheetId) return null;
  const sourceId = env("PREMIUM_SPREADSHEET_ID") || env("SPREADSHEET_ID");
  if (sourceId && spreadsheetId === sourceId) {
    throw new Error("PREMIUM_LOG_SPREADSHEET_ID must be different from PREMIUM_SPREADSHEET_ID to protect the existing GAS spreadsheet");
  }
  return {
    spreadsheetId,
    logSheetName: env("PREMIUM_LOG_SHEET_NAME") || "premium_alert_log",
    retentionDays: positiveInt(env("PREMIUM_LOG_RETENTION_DAYS"), 90)
  };
}

function buildPostLogEvent(report, embed, claim) {
  const fields = fieldsToMap(report.fields || []);
  return {
    eventAt: new Date().toISOString(),
    eventType: "POSTED",
    alertId: String(report.alertId || ""),
    symbolCode: String(report.symbolCode || claim.symbolCode || ""),
    symbolName: String(report.symbolName || claim.symbolName || ""),
    signalType: String(report.signalType || claim.signalType || ""),
    title: embed.title || "",
    tradingViewUrl: embed.url || "",
    disclosureLinks: fields.get("開示リンク") || fields.get("髢狗､ｺ繝ｪ繝ｳ繧ｯ") || "",
    sourceUrls: fields.get("Sources") || "",
    reason: ""
  };
}

function buildFailureLogEvent(item, eventAt) {
  return {
    eventAt,
    eventType: "FAILED",
    alertId: item.alertId,
    symbolCode: "",
    symbolName: "",
    signalType: "",
    title: "",
    tradingViewUrl: "",
    disclosureLinks: "",
    sourceUrls: "",
    reason: item.reason
  };
}

function logEventToRow(event) {
  return [
    event.eventAt || new Date().toISOString(),
    event.eventType || "",
    event.alertId || "",
    event.symbolCode || "",
    event.symbolName || "",
    event.signalType || "",
    event.title || "",
    event.tradingViewUrl || "",
    truncate(event.disclosureLinks || "", 5000),
    truncate(event.sourceUrls || "", 5000),
    truncate(event.reason || "", 1000)
  ];
}

function fieldsToMap(fields) {
  const map = new Map();
  for (const field of fields) {
    const name = String(field.name || "").trim();
    if (name) map.set(name, String(field.value || "").trim());
  }
  return map;
}

function buildDeleteRowRequests(sheetId, rowNumbers) {
  const sorted = [...rowNumbers].sort((a, b) => b - a);
  const groups = [];
  for (const rowNumber of sorted) {
    const last = groups[groups.length - 1];
    if (last && rowNumber === last.startRow - 1) last.startRow = rowNumber;
    else groups.push({ startRow: rowNumber, endRow: rowNumber });
  }
  return groups.map(group => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: group.startRow - 1,
        endIndex: group.endRow
      }
    }
  }));
}

function rowToWidth(row, width) {
  const result = row.slice(0, width);
  while (result.length < width) result.push("");
  return result;
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'`;
}

function columnName(index) {
  let n = index;
  let out = "";
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

async function getGoogleAccessToken(scopes = [SHEETS_READONLY_SCOPE]) {
  const serviceAccount = loadServiceAccount();
  const nowSec = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccount.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    exp: nowSec + 3600,
    iat: nowSec
  };
  const jwt = signJwt({ alg: "RS256", typ: "JWT" }, claim, serviceAccount.private_key);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new Error(`Google token request failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error("Google token response did not include access_token");
  return data.access_token;
}

function loadServiceAccount() {
  const inline = env("GOOGLE_SERVICE_ACCOUNT_JSON");
  const b64 = env("GOOGLE_SERVICE_ACCOUNT_JSON_B64");
  const file = env("GOOGLE_APPLICATION_CREDENTIALS") || env("GOOGLE_SERVICE_ACCOUNT_FILE");

  let raw = "";
  if (inline) raw = inline;
  else if (b64) raw = Buffer.from(b64, "base64").toString("utf8");
  else if (file) raw = fs.readFileSync(path.resolve(file), "utf8");
  else throw new Error("Missing Google service account credentials");

  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Google service account JSON must include client_email and private_key");
  }
  return parsed;
}

function signJwt(header, claim, privateKey) {
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedClaim = base64url(JSON.stringify(claim));
  const signingInput = `${encodedHeader}.${encodedClaim}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function evaluateTimeGate(now, force) {
  const jst = getJstParts(now);
  if (force) return { allowed: true, forced: true, ...jst };
  const allowedHours = parseNumberSet(env("PREMIUM_ALLOWED_JST_HOURS") || DEFAULT_ALLOWED_HOURS);
  const allowedMinutePairs = parseMinutePairs(env("PREMIUM_ALLOWED_JST_MINUTES") || DEFAULT_ALLOWED_MINUTES_BY_HOUR);
  const allowedWeekdays = parseNumberSet(env("PREMIUM_ALLOWED_JST_WEEKDAYS") || DEFAULT_ALLOWED_WEEKDAYS);
  if (allowedHours && !allowedHours.has(jst.jstHour)) {
    return { allowed: false, reason: "outside allowed JST hours", ...jst };
  }
  if (allowedMinutePairs && !allowedMinutePairs.has(`${jst.jstHour}:${String(jst.jstMinute).padStart(2, "0")}`)) {
    return { allowed: false, reason: "outside allowed JST minute slots", ...jst };
  }
  if (allowedWeekdays && !allowedWeekdays.has(jst.jstWeekday)) {
    return { allowed: false, reason: "outside allowed JST weekdays", ...jst };
  }
  return { allowed: true, ...jst };
}

function getJstParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(date);
  const hour = Number(parts.find(p => p.type === "hour")?.value);
  const minute = Number(parts.find(p => p.type === "minute")?.value);
  const weekdayText = parts.find(p => p.type === "weekday")?.value;
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { jstHour: hour, jstMinute: minute, jstWeekday: weekdayMap[weekdayText] || 0 };
}

function parseNumberSet(value) {
  const text = String(value || "").trim();
  if (!text || text === "*") return null;
  return new Set(text.split(",").map(s => Number(s.trim())).filter(Number.isFinite));
}

function parseMinutePairs(value) {
  const text = String(value || "").trim();
  if (!text || text === "*") return null;
  const pairs = text.split(",")
    .map(item => item.trim().match(/^(\d{1,2}):(\d{1,2})$/))
    .filter(Boolean)
    .map(([, hour, minute]) => `${Number(hour)}:${String(Number(minute)).padStart(2, "0")}`);
  return pairs.length ? new Set(pairs) : null;
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return { version: 1, posted: {}, failed: {}, claims: {} };
  const state = readJson(statePath);
  return {
    version: 1,
    posted: state.posted || {},
    failed: state.failed || {},
    claims: state.claims || {}
  };
}

function saveState(statePath, state) {
  ensureDir(path.dirname(statePath));
  writeJson(statePath, state);
}

function pruneExpiredClaims(state, now) {
  for (const [alertId, claim] of Object.entries(state.claims || {})) {
    const claimedAt = Date.parse(claim.claimedAt || "");
    if (!Number.isFinite(claimedAt) || claimedAt + CLAIM_TTL_MS <= now.getTime()) {
      delete state.claims[alertId];
    }
  }
}

function normalizeReports(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.reports)) return data.reports;
  throw new Error("report file must be an array or { reports: [...] }");
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

function parseOptions(items) {
  const out = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = items[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function env(key) {
  return String(process.env[key] || "").trim();
}

function requiredEnv(...keys) {
  for (const key of keys) {
    const value = env(key);
    if (value) return value;
  }
  throw new Error(`Missing required environment variable: ${keys.join(" or ")}`);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function cleanCell(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeTradingViewSymbol(tvSymbol) {
  const symbol = String(tvSymbol || "").trim();
  return symbol.replace(/^TYO:/i, "TSE:");
}

function buildTradingViewUrl(tvSymbol) {
  const symbol = normalizeTradingViewSymbol(tvSymbol);
  return symbol ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}` : "";
}

function normalizeUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) throw new Error(`invalid URL: ${url}`);
  return url;
}

function normalizeEmbedUrl(value) {
  const url = normalizeUrl(value);
  if (!url) return "";
  return normalizeTradingViewUrl(url);
}

function extractSymbolCodeFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const symbol = normalizeTradingViewSymbol(url.searchParams.get("symbol") || "");
    const match = symbol.match(/^[A-Z]+:(.+)$/i);
    return match ? match[1] : symbol;
  } catch {
    return "";
  }
}

function normalizeTradingViewUrl(value) {
  try {
    const url = new URL(value);
    if (!/tradingview\.com$/i.test(url.hostname)) return value;
    const symbol = url.searchParams.get("symbol");
    if (symbol) url.searchParams.set("symbol", normalizeTradingViewSymbol(symbol));
    return url.toString();
  } catch {
    return value;
  }
}

function hasUrl(value) {
  return /https?:\/\/[^\s)\]]+/i.test(String(value || ""));
}

function countUrls(value) {
  return (String(value || "").match(/https?:\/\/[^\s)\]]+/gi) || []).length;
}

function truncate(value, max) {
  const text = String(value || "").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function parseRetryAfterMs(response, body) {
  const header = response.headers.get("retry-after");
  if (header && Number.isFinite(Number(header))) return Math.ceil(Number(header) * 1000);
  try {
    const json = JSON.parse(body);
    if (Number.isFinite(Number(json.retry_after))) return Math.ceil(Number(json.retry_after) * 1000);
  } catch {}
  return 1000;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function selfTest() {
  assert.equal(normalizeTradingViewSymbol("TYO:7203"), "TSE:7203");
  assert.equal(buildTradingViewUrl("TYO:7203"), "https://www.tradingview.com/chart/?symbol=TSE%3A7203");
  assert.equal(buildTradingViewUrl("TSE:8285"), "https://www.tradingview.com/chart/?symbol=TSE%3A8285");
  const embed = buildEmbed({
    alertId: "a1",
    title: "テスト（1234）｜Premium Snapshot",
    url: "https://www.tradingview.com/chart/?symbol=TYO%3A1234",
    fields: [
      { name: "材料インパクト", value: "ポジティブ材料: 会社開示で確認できる増益要因。" },
      { name: "事業概要", value: "製造業の会社。" },
      { name: "足元材料", value: "直近決算を確認。" },
      { name: "ファンダ要点", value: "売上と利益の推移を要確認。" },
      { name: "注意点", value: "材料の鮮度に注意。" },
      { name: "開示リンク", value: "" },
      { name: "Sources", value: "[IR](https://example.com/ir)" }
    ]
  });
  assert.equal(embed.title, "TradingViewチャート｜テスト（1234）｜Premium Snapshot");
  assert.equal(embed.url, "https://www.tradingview.com/chart/?symbol=TSE%3A1234");
  assert.equal(embed.color, 0x2E7D32);
  assert.equal(embed.fields[0].name, "材料インパクト");
  assert.equal(embed.fields.find(f => f.name === "開示リンク").value, "開示リンク未確認");
  assert.deepEqual(sortReportsByImpact([
    { alertId: "n", materialImpact: "ネガティブ材料" },
    { alertId: "p", materialImpact: "ポジティブ材料" },
    { alertId: "w", materialImpact: "様子見" }
  ]).map(report => report.alertId), ["p", "w", "n"]);
  assert.throws(() => buildEmbed({
    alertId: "a2",
    fields: REQUIRED_FIELDS.map(name => ({ name, value: name === "Sources" ? "no source" : "x" }))
  }), /Sources/);
  const previousHours = process.env.PREMIUM_ALLOWED_JST_HOURS;
  const previousMinutes = process.env.PREMIUM_ALLOWED_JST_MINUTES;
  process.env.PREMIUM_ALLOWED_JST_HOURS = "13,15";
  process.env.PREMIUM_ALLOWED_JST_MINUTES = "13:05,15:36";
  const gate1305 = evaluateTimeGate(new Date("2026-05-05T04:05:00Z"), false);
  const gate1536 = evaluateTimeGate(new Date("2026-05-05T06:36:00Z"), false);
  const gate1535 = evaluateTimeGate(new Date("2026-05-05T06:35:00Z"), false);
  assert.equal(gate1305.allowed, true);
  assert.equal(gate1536.allowed, true);
  assert.equal(gate1535.allowed, false);
  assert.equal(gate1535.reason, "outside allowed JST minute slots");
  restoreEnv("PREMIUM_ALLOWED_JST_HOURS", previousHours);
  restoreEnv("PREMIUM_ALLOWED_JST_MINUTES", previousMinutes);

  const previousSignalTypes = process.env.PREMIUM_SIGNAL_TYPES;
  process.env.PREMIUM_SIGNAL_TYPES = "BOTTOM";
  const selected = selectPendingAlerts([
    { alertId: "top-new", receivedAt: "2026/05/03 12:00:00", signalType: "TOP", symbolCode: "1111" },
    { alertId: "bottom-old", receivedAt: "2026/05/01 12:00:00", signalType: "BOTTOM", symbolCode: "1111" },
    { alertId: "bottom-new", receivedAt: "2026/05/02 12:00:00", signalType: "BOTTOM", symbolCode: "1111" },
    { alertId: "bottom-posted", receivedAt: "2026/05/03 12:00:00", signalType: "BOTTOM", symbolCode: "2222" }
  ], {
    posted: { "bottom-posted": { postedAt: "2026-05-03T03:00:00.000Z" } },
    failed: {},
    claims: {}
  }, new Date("2026-05-05T00:00:00Z"));
  assert.deepEqual(selected.map(row => row.alertId), ["bottom-new", "bottom-old"]);
  restoreEnv("PREMIUM_SIGNAL_TYPES", previousSignalTypes);
  const cutoff = parseJstDateEndMs("2026-05-01");
  assert.ok(parseReceivedAtMs("2026/05/01 23:59:59") <= cutoff);
  assert.ok(parseReceivedAtMs("2026/05/02 00:00:00") > cutoff);
  assert.equal(extractSymbolCodeFromUrl("https://www.tradingview.com/chart/?symbol=TYO%3A8285"), "8285");
  console.log(JSON.stringify({ ok: true, selfTest: "passed" }, null, 2));
}

function restoreEnv(key, value) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}

function printHelp() {
  console.log(`Usage:
  node premium_worker/worker.mjs collect [--force]
  node premium_worker/worker.mjs post --input <premium_reports.json> [--dry-run]
  node premium_worker/worker.mjs fail --alert-id <id> --reason <reason>
  node premium_worker/worker.mjs lock-before --date <yyyy-mm-dd>
  node premium_worker/worker.mjs status
  node premium_worker/worker.mjs self-test`);
}
