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
const DEFAULT_ALLOWED_HOURS = "14,16";
const DEFAULT_ALLOWED_WEEKDAYS = "1,2,3,4,5";
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

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
  const maxRows = positiveInt(env("PREMIUM_SCAN_MAX_ROWS"), 300);
  const maxAlerts = positiveInt(env("PREMIUM_MAX_ALERTS_PER_RUN"), 3);
  const statePath = env("PREMIUM_STATE_PATH") || DEFAULT_STATE_PATH;
  const outDir = env("PREMIUM_OUT_DIR") || DEFAULT_OUT_DIR;

  const state = loadState(statePath);
  pruneExpiredClaims(state, now);

  const token = await getGoogleAccessToken();
  const values = await readSheetValues(spreadsheetId, `${sheetName}!A4:AH`, token);
  const rows = mapRawRows(values).slice(-maxRows);
  const pending = selectPendingAlerts(rows, state, now).slice(0, maxAlerts);
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
  const reports = normalizeReports(readJson(path.resolve(inputPath)));
  if (!reports.length) throw new Error("report file contains no reports");

  const results = [];
  for (const report of reports) {
    const embed = buildEmbed(report);
    const payload = {
      username: env("DISCORD_PREMIUM_USERNAME") || "天底極致 Premium",
      allowed_mentions: { parse: [] },
      embeds: [embed]
    };

    if (dryRun) {
      results.push({ alertId: report.alertId, dryRun: true, payload });
      continue;
    }

    await postDiscord(webhookUrl, payload);
    state.posted[report.alertId] = {
      postedAt: new Date().toISOString(),
      title: embed.title,
      url: embed.url || "",
      sourceCount: countUrls(JSON.stringify(embed))
    };
    delete state.claims[report.alertId];
    delete state.failed[report.alertId];
    results.push({ alertId: report.alertId, posted: true });
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
  console.log(JSON.stringify({ ok: true, failed: failures.length, failures }, null, 2));
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
      const tvSymbol = cleanCell(get("tv_symbol")) || (symbolCode ? `TYO:${symbolCode}` : "");
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
  return rows.filter(row => {
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

function buildEmbed(report) {
  const alertId = String(report.alertId || "").trim();
  if (!alertId) throw new Error("report is missing alertId");
  const title = truncate(String(report.title || "Premium Snapshot").trim(), 256);
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

  const fields = REQUIRED_FIELDS.map(name => ({
    name,
    value: truncate(fieldMap.get(name) || (name === "開示リンク" ? "開示リンク未確認" : "未確認"), 1024),
    inline: false
  }));

  return {
    title,
    url: normalizeUrl(report.url || ""),
    color: Number(report.color || "5793266"),
    timestamp: new Date().toISOString(),
    fields,
    footer: { text: "Premium fundamental snapshot / Not investment advice" }
  };
}

function assertNoInvestmentAdvice(text) {
  const prohibited = [
    /買い推奨/,
    /売り推奨/,
    /目標株価/,
    /追加採点/,
    /[0-9０-９]+点満点/,
    /スコア\s*[:：]\s*[0-9０-９]/
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

async function getGoogleAccessToken() {
  const serviceAccount = loadServiceAccount();
  const nowSec = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
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
  const allowedWeekdays = parseNumberSet(env("PREMIUM_ALLOWED_JST_WEEKDAYS") || DEFAULT_ALLOWED_WEEKDAYS);
  if (allowedHours && !allowedHours.has(jst.jstHour)) {
    return { allowed: false, reason: "outside allowed JST hours", ...jst };
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
    hour: "2-digit"
  }).formatToParts(date);
  const hour = Number(parts.find(p => p.type === "hour")?.value);
  const weekdayText = parts.find(p => p.type === "weekday")?.value;
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { jstHour: hour, jstWeekday: weekdayMap[weekdayText] || 0 };
}

function parseNumberSet(value) {
  const text = String(value || "").trim();
  if (!text || text === "*") return null;
  return new Set(text.split(",").map(s => Number(s.trim())).filter(Number.isFinite));
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

function cleanCell(value) {
  return String(value == null ? "" : value).trim();
}

function buildTradingViewUrl(tvSymbol) {
  const symbol = String(tvSymbol || "").trim();
  return symbol ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}` : "";
}

function normalizeUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) throw new Error(`invalid URL: ${url}`);
  return url;
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
  assert.equal(buildTradingViewUrl("TYO:7203"), "https://www.tradingview.com/chart/?symbol=TYO%3A7203");
  const embed = buildEmbed({
    alertId: "a1",
    title: "テスト（1234）｜Premium Snapshot",
    url: "https://www.tradingview.com/chart/?symbol=TYO%3A1234",
    fields: [
      { name: "事業概要", value: "製造業の会社。" },
      { name: "足元材料", value: "直近決算を確認。" },
      { name: "ファンダ要点", value: "売上と利益の推移を要確認。" },
      { name: "注意点", value: "材料の鮮度に注意。" },
      { name: "開示リンク", value: "" },
      { name: "Sources", value: "[IR](https://example.com/ir)" }
    ]
  });
  assert.equal(embed.fields.find(f => f.name === "開示リンク").value, "開示リンク未確認");
  assert.throws(() => buildEmbed({
    alertId: "a2",
    fields: REQUIRED_FIELDS.map(name => ({ name, value: name === "Sources" ? "no source" : "x" }))
  }), /Sources/);
  const gate = evaluateTimeGate(new Date("2026-05-05T05:00:00Z"), false);
  assert.equal(gate.jstHour, 14);
  console.log(JSON.stringify({ ok: true, selfTest: "passed" }, null, 2));
}

function printHelp() {
  console.log(`Usage:
  node premium_worker/worker.mjs collect [--force]
  node premium_worker/worker.mjs post --input <premium_reports.json> [--dry-run]
  node premium_worker/worker.mjs fail --alert-id <id> --reason <reason>
  node premium_worker/worker.mjs status
  node premium_worker/worker.mjs self-test`);
}
