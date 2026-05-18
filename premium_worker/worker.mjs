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

const IMPACT_FIELD = "材料インパクト";
const VALID_MATERIAL_IMPACTS = ["ポジティブ材料", "ネガティブ材料", "様子見", "混在/要確認"];
const REQUIRED_FIELDS = [IMPACT_FIELD, "事業概要", "足元材料", "ファンダ要点", "注意点", "開示リンク", "Sources"];
const OPTIONAL_FIELDS = [];
const DEFAULT_ALLOWED_HOURS = "13,15";
const DEFAULT_ALLOWED_MINUTES_BY_HOUR = "13:00-13:10,15:30-15:40";
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
      jstMinute: gate.jstMinute,
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
  await replayPendingLogEvents_(state, statePath);
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
  receivedAt: alert.receivedAt,
  signalDate: alert.signalDate,
  signalType: alert.signalType,
  symbolCode: alert.symbolCode,
  symbolName: alert.symbolName,
  tradingViewUrl: alert.tradingViewUrl
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
  if (!dryRun) await replayPendingLogEvents_(state, statePath);
  const reports = sortReportsByImpact(normalizeReports(readJson(path.resolve(inputPath))));
  if (!reports.length) throw new Error("report file contains no reports");

  const results = [];
  const postLogEvents = [];
  try {
    for (const report of reports) {
      const claim = state.claims[report.alertId] || null;
      const skipReason = getPostSkipReason(report.alertId, state, claim);
      if (skipReason) {
        results.push({ alertId: report.alertId, skipped: true, reason: skipReason });
        continue;
      }

      await assertNoNewerIrbankDisclosureMiss(report, claim);
      await resolveIrbankPdfDisclosureLinks(report);
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

      const discordMessage = await postDiscord(webhookUrl, payload);
      const discordMessageUrl = buildDiscordMessageUrl(discordMessage);
      const symbolCode = String(report.symbolCode || claim.symbolCode || extractSymbolCodeFromUrl(embed.url) || "").trim();
      state.posted[report.alertId] = {
        postedAt: new Date().toISOString(),
        symbolCode,
        symbolName: String(report.symbolName || claim.symbolName || ""),
        title: embed.title,
        url: embed.url || "",
        discordMessageUrl,
        sourceCount: countUrls(JSON.stringify(embed))
      };
      delete state.claims[report.alertId];
      delete state.failed[report.alertId];
      results.push({ alertId: report.alertId, posted: true, discordMessageUrl });
      postLogEvents.push(buildPostLogEvent(report, embed, claim, discordMessageUrl));
      saveState(statePath, state);
    }
  } finally {
    if (!dryRun) {
      saveState(statePath, state);
      await writePremiumLogEventsSafe(postLogEvents, state, statePath);
    }
  }

  console.log(JSON.stringify({ ok: true, posted: results.filter(r => r.posted).length, results }, null, 2));
}

function getPostSkipReason(alertId, state, claim) {
  if (state.posted?.[alertId]) return "already posted";
  if (!claim?.claimId) return "no active claim";
  return "";
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

  const dryRun = opts["dry-run"] === true;
  const webhookUrl = dryRun ? "" : requiredEnv("DISCORD_PREMIUM_WEBHOOK_URL");
  const now = new Date();
  const results = [];
  const postLogEvents = [];

  for (const item of failures) {
    if (!item.alertId) throw new Error("fail requires --alert-id <id> or --input with alertId");
    const claim = state.claims[item.alertId] || {};
    const embed = buildSamayomiStubEmbed_(item.alertId, item.reason, claim);
    const payload = {
      username: env("DISCORD_PREMIUM_USERNAME") || "天底極致 Premium Report",
      allowed_mentions: { parse: [] },
      embeds: [embed]
    };
    assertNoInvestmentAdvice(JSON.stringify(payload));

    if (dryRun) {
      results.push({ alertId: item.alertId, dryRun: true, payload });
      continue;
    }

    const discordMessage = await postDiscord(webhookUrl, payload);
    const discordMessageUrl = buildDiscordMessageUrl(discordMessage);
    const symbolCode = String(claim.symbolCode || "").trim();

    state.posted[item.alertId] = {
      postedAt: now.toISOString(),
      symbolCode,
      symbolName: String(claim.symbolName || ""),
      title: embed.title,
      url: embed.url || "",
      discordMessageUrl,
      source: "samayomi_stub",
      reason: item.reason
    };
    delete state.claims[item.alertId];
    saveState(statePath, state);

    postLogEvents.push(buildSamayomiStubLogEvent_(item, embed, claim, now, discordMessageUrl));
    results.push({ alertId: item.alertId, posted: true, samayomiStub: true, discordMessageUrl });
  }

  if (!dryRun) {
    saveState(statePath, state);
    await writePremiumLogEventsSafe(postLogEvents, state, statePath);
  }

  console.log(JSON.stringify({ ok: true, posted: results.filter(r => r.posted).length, results }, null, 2));
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
  const textForPolicy = JSON.stringify(report);
  assertNoInvestmentAdvice(textForPolicy);

  const fieldMap = new Map();
  for (const field of report.fields || []) {
    const name = String(field.name || "").trim();
    if (name) fieldMap.set(name, String(field.value || "").trim());
  }
  if (!fieldMap.has(IMPACT_FIELD) && String(report.materialImpact || "").trim()) {
    fieldMap.set(IMPACT_FIELD, String(report.materialImpact || "").trim());
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
  const dedupedDisclosureLinks = dedupeDisclosureLinkLines(fieldMap.get("開示リンク"));
  fieldMap.set("開示リンク", dedupedDisclosureLinks || "開示リンク未確認");
  assertNoMojibakeText(alertId, report, fieldMap);
  assertDisclosureLinksAreDirectDisclosures(alertId, fieldMap);
  assertNoDuplicateDisclosureLinks(alertId, fieldMap);
  assertSourceLinksAreReferencePages(alertId, fieldMap);
  assertDescriptiveLinkLabels(alertId, fieldMap);
  assertJapaneseNarrativeFields(alertId, fieldMap);
  assertConciseMaterialNarrative(alertId, fieldMap);
  assertNoGenericNarrativeTemplates(alertId, fieldMap);
  assertNoGenericBusinessOverview(alertId, fieldMap);
  assertNoGenericFundamentalPoint(alertId, fieldMap);
  assertNoNarrowDisclosureCaveat(alertId, fieldMap);
  assertNoStaleSingleMaterialSummary(alertId, fieldMap);
  assertNoStaleDisclosureProxyLabels(alertId, fieldMap);
  assertMaterialImpact(alertId, fieldMap);
  const title = buildEmbedTitle(report);

  const fieldNames = [
    ...OPTIONAL_FIELDS.filter(name => fieldMap.has(name) && fieldMap.get(name)),
    ...REQUIRED_FIELDS
  ];
  const fields = fieldNames.map(name => ({
    name,
    value: truncate(formatEmbedFieldValue(name, fieldMap.get(name) || (name === "開示リンク" ? "開示リンク未確認" : "未確認")), 1024),
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

function formatEmbedFieldValue(name, value) {
  const text = String(value || "").trim();
  if (!["開示リンク", "Sources"].includes(name)) return text;
  if (!hasUrl(text) || text === "開示リンク未確認") return text;
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed || /^・/.test(trimmed)) return trimmed;
    return `・${trimmed}`;
  }).join("\n");
}

function assertMaterialImpact(alertId, fieldMap) {
  const normalized = normalizeMaterialImpact(fieldMap.get(IMPACT_FIELD));
  if (!normalized) {
    throw new Error(
      `report ${alertId} field ${IMPACT_FIELD} must start with one of: ${VALID_MATERIAL_IMPACTS.join(", ")}`
    );
  }
  if (!hasMaterialImpactSummary(normalized)) {
    throw new Error(
      `report ${alertId} field ${IMPACT_FIELD} must use "<label>：<source-grounded summary>", not a bare label`
    );
  }
  fieldMap.set(IMPACT_FIELD, normalized);
}

function normalizeMaterialImpact(value) {
  const text = normalizeSpaces(String(value || ""));
  if (!text) return "";

  const patterns = [
    [/^ポジティブ(?:材料)?(?=$|[\s:：。、「」])/i, "ポジティブ材料"],
    [/^ネガティブ(?:材料)?(?=$|[\s:：。、「」])/i, "ネガティブ材料"],
    [/^様子見(?=$|[\s:：。、「」])/i, "様子見"],
    [/^(?:混在\/要確認|混在|要確認)(?=$|[\s:：。、「」])/i, "混在/要確認"]
  ];

  for (const [pattern, label] of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const rest = text.slice(match[0].length).replace(/^[\s:：、。-]+/, "").trim();
    return `${label}${rest ? `：${rest}` : ""}`;
  }
  return "";
}

function hasMaterialImpactSummary(value) {
  const text = normalizeSpaces(String(value || ""));
  for (const label of VALID_MATERIAL_IMPACTS) {
    if (!text.startsWith(`${label}：`)) continue;
    const summary = text.slice(`${label}：`.length).trim();
    return summary.length >= 24 && hasJapaneseText(summary);
  }
  return false;
}

function dedupeDisclosureLinkLines(value) {
  const text = String(value || "").trim();
  if (!text || text === "開示リンク未確認" || !hasUrl(text)) return text;

  const orderedKeys = [];
  const byKey = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const link = extractFirstMarkdownLink(line);
    if (!link) {
      const key = `line:${normalizeDisclosureDuplicateText(line)}`;
      if (!byKey.has(key)) {
        orderedKeys.push(key);
        byKey.set(key, { line, score: 0 });
      }
      continue;
    }

    const key = disclosureDuplicateKey(link.label, link.url);
    const score = disclosureLinkPreferenceScore(link.url);
    const current = byKey.get(key);
    if (!current) {
      orderedKeys.push(key);
      byKey.set(key, { line, score });
    } else if (score > current.score) {
      byKey.set(key, { line, score });
    }
  }

  return orderedKeys.map(key => byKey.get(key)?.line).filter(Boolean).join("\n");
}

function assertNoDuplicateDisclosureLinks(alertId, fieldMap) {
  const value = String(fieldMap.get("開示リンク") || "").trim();
  if (!value || value === "開示リンク未確認") return;

  const seen = new Set();
  for (const { label, url } of extractMarkdownLinks(value)) {
    const key = disclosureDuplicateKey(label, url);
    if (seen.has(key)) {
      throw new Error(`report ${alertId} disclosure link duplicates the same disclosure content: ${label}`);
    }
    seen.add(key);
  }
}

function disclosureDuplicateKey(label, url) {
  return extractDisclosureDocumentKey(url) || `label:${normalizeDisclosureDuplicateText(label)}`;
}

function extractFirstMarkdownLink(value) {
  const match = String(value || "").match(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/);
  return match ? { label: match[1].trim(), url: match[2].trim() } : null;
}

function extractDisclosureDocumentKey(url) {
  const text = String(url || "");
  const irbankId = text.match(/(?:^|\/)(140120\d{12})(?:\.pdf|[/?#]|$)/i);
  if (irbankId) return `tdnet:${irbankId[1].slice(6)}`;

  const yahooPdf = text.match(/(?:^|\/)(20\d{6})(\d{6})\.pdf(?:[?#].*)?$/i);
  if (yahooPdf) return `tdnet:${yahooPdf[1].slice(2)}${yahooPdf[2]}`;

  const tdnetFile = text.match(/[?&](?:file|id|documentId)=([^&#]+)/i);
  if (tdnetFile) return `tdnet-param:${decodeURIComponent(tdnetFile[1]).toLowerCase()}`;

  return "";
}

function disclosureLinkPreferenceScore(url) {
  try {
    const parsed = new URL(String(url || ""));
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "f.irbank.net") return 50;
    if (/tdnet|jpx|release\.tdnet/i.test(host + parsed.pathname)) return 40;
    if (host.includes("finance-frontend") || host.includes("yahoo")) return 30;
    if (isDirectDisclosureFileUrl(url)) return 20;
    if (isDisclosureDetailPageUrl(url)) return 10;
  } catch {
    return 0;
  }
  return 0;
}

function normalizeDisclosureDuplicateText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[‐-―−ー]/g, "-")
    .replace(/[「」『』【】［］\[\]（）()]/g, "")
    .replace(/\d{1,2}:\d{2}/g, "")
    .replace(/\bTDnet\s*PDF\b/gi, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function buildEmbedTitle(report) {
  const baseTitle = truncate(String(report.title || "Premium Snapshot").trim(), 256);
  const url = String(report.url || "");
  if (/tradingview\.com/i.test(url)) {
    const symbolName = String(report.symbolName || "").trim();
    const symbolCode = String(report.symbolCode || extractSymbolCodeFromUrl(url) || "").trim();
    if (symbolName && symbolCode) return truncate(`${symbolName} (${symbolCode}) | TradingView チャート`, 256);
    if (symbolName) return truncate(`${symbolName} | TradingView チャート`, 256);
    if (symbolCode) return truncate(`${symbolCode} | TradingView チャート`, 256);
    if (!/TradingView|チャート/i.test(baseTitle)) return truncate(`${baseTitle} | TradingView チャート`, 256);
  }
  return baseTitle;
}

function assertJapaneseNarrativeFields(alertId, fieldMap) {
  const minimumLengths = new Map([
    ["事業概要", 45],
    ["足元材料", 70],
    ["ファンダ要点", 70],
    ["注意点", 55]
  ]);
  for (const name of ["事業概要", "足元材料", "ファンダ要点", "注意点"]) {
    const value = String(fieldMap.get(name) || "").trim();
    if (!hasJapaneseText(value)) {
      throw new Error(`report ${alertId} field ${name} must be written in Japanese`);
    }
    if (value.length < minimumLengths.get(name)) {
      throw new Error(`report ${alertId} field ${name} is too terse for analysis`);
    }
  }
}

function hasJapaneseText(value) {
  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(String(value || ""));
}

function assertNoMojibakeText(alertId, report, fieldMap) {
  const checks = [
    ["title", report.title],
    ["symbolName", report.symbolName],
    ...[...fieldMap.entries()].map(([name, value]) => [`field ${name}`, value])
  ];

  for (const [label, rawValue] of checks) {
    const value = stripMarkdownUrls(String(rawValue || ""));
    if (/\?{4,}/.test(value)) {
      throw new Error(`report ${alertId} ${label} contains mojibake question marks`);
    }
    if (/\uFFFD/.test(value)) {
      throw new Error(`report ${alertId} ${label} contains Unicode replacement characters`);
    }
  }
}

function stripMarkdownUrls(value) {
  return String(value || "")
    .replace(/\]\(https?:\/\/[^)\s]+(?:\?[^)\s]*)?\)/gi, "]()")
    .replace(/https?:\/\/[^\s)\]]+/gi, "");
}

function assertConciseMaterialNarrative(alertId, fieldMap) {
  const materials = String(fieldMap.get("足元材料") || "").trim();
  const fundamentals = String(fieldMap.get("ファンダ要点") || "").trim();
  const disclosure = String(fieldMap.get("開示リンク") || "").trim();
  if (hasUrl(disclosure) && /^公式IR\/IRBANKを(?:45日|四十五日|少なくとも45日)/.test(materials)) {
    throw new Error(`report ${alertId} field 足元材料 must lead with material events, not an IRBANK research-log caveat`);
  }
  assertNoMaterialTitleDump(alertId, materials);

  const materialSentences = materials
    .split("。")
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 35);
  for (const sentence of materialSentences) {
    if (fundamentals.includes(sentence)) {
      throw new Error(`report ${alertId} repeats the same long sentence in 足元材料 and ファンダ要点`);
    }
  }
}

function assertNoMaterialTitleDump(alertId, materials) {
  const firstSentence = String(materials || "").split("。")[0] || "";
  const quotedTitleCount = (firstSentence.match(/「[^」]{8,}」/g) || []).length;
  if (
    /^20\d{2}[-年\/.]\s*\d{1,2}[-月\/.]\s*\d{1,2}日?に/.test(firstSentence) &&
    quotedTitleCount >= 1 &&
    /も確認/.test(firstSentence)
  ) {
    throw new Error(`report ${alertId} field 足元材料 must summarize disclosure substance, not prepend disclosure title lists`);
  }
  if (quotedTitleCount >= 2 && /確認/.test(firstSentence)) {
    throw new Error(`report ${alertId} field 足元材料 must not dump multiple disclosure titles before the analysis`);
  }
}

function assertNoGenericNarrativeTemplates(alertId, fieldMap) {
  const fields = ["事業概要", "足元材料", "ファンダ要点", "注意点"];
  const genericPatterns = [
    {
      pattern: /開示資料で確認できる主要サービス・製品を中心に事業を展開する上場企業/,
      reason: "company overview must describe the actual business, not say it was confirmed from disclosures"
    },
    {
      pattern: /売上成長、利益率、資本政策、事業提携のどれに効くか/,
      reason: "company overview must identify the relevant driver for this company"
    },
    {
      pattern: /IRBANKの開示一覧でも45日前後の新しい材料として追えるため/,
      reason: "material narrative must explain the disclosure's impact, not the research method"
    },
    {
      pattern: /事業進捗、業績変化、資本政策のいずれに影響するかが確認点/,
      reason: "material narrative must choose the concrete impact path"
    },
    {
      pattern: /継続収益の拡大、一過性損益、資金調達、提携・M&Aのどれに分類されるか/,
      reason: "fundamental point must classify the material instead of listing generic categories"
    },
    {
      pattern: /次回決算で売上、営業利益、現金収支への反映を確認したい局面/,
      reason: "fundamental point must name the company-specific KPI or accounting line"
    },
    {
      pattern: /開示単体では金額、契約期間、希薄化、一過性の区別が十分に読み切れない/,
      reason: "risk note must name the disclosure-specific uncertainty"
    },
    {
      pattern: /売買判断ではなく、追加IRと決算資料で実際の収益貢献を確認する前提/,
      reason: "risk note must not rely on generic not-investment-advice boilerplate"
    }
  ];

  for (const field of fields) {
    const value = String(fieldMap.get(field) || "");
    for (const { pattern, reason } of genericPatterns) {
      if (pattern.test(value)) {
        throw new Error(`report ${alertId} field ${field} is too generic: ${reason}`);
      }
    }
  }
}

function assertNoGenericBusinessOverview(alertId, fieldMap) {
  const value = String(fieldMap.get("事業概要") || "");
  const genericPatterns = [
    {
      pattern: /開示資料で確認できる/,
      reason: "describe the actual business, not the source used to identify it"
    },
    {
      pattern: /主要サービス・製品を中心に事業を展開/,
      reason: "name the actual product, service, or business line"
    },
    {
      pattern: /事業を展開する上場企業/,
      reason: "being listed is not a business overview"
    },
    {
      pattern: /直近の材料は、?売上成長、?利益率、?資本政策、?事業提携/,
      reason: "do not list generic impact buckets in the overview"
    },
    {
      pattern: /どれに効くかを分けて見る必要/,
      reason: "choose the relevant business driver instead of deferring the analysis"
    }
  ];

  for (const { pattern, reason } of genericPatterns) {
    if (pattern.test(value)) {
      throw new Error(`report ${alertId} field 事業概要 is too generic: ${reason}`);
    }
  }
}

function assertNoGenericFundamentalPoint(alertId, fieldMap) {
  const value = String(fieldMap.get("ファンダ要点") || "");
  const genericPatterns = [
    {
      pattern: /ファンダ面では、?この開示/,
      reason: "do not start from 'this disclosure'; name the company's business driver directly"
    },
    {
      pattern: /この開示が[^。]*(?:どれに分類されるか|いずれに分類されるか|分類されるかが重要)/,
      reason: "choose the actual impact category instead of listing possible categories"
    },
    {
      pattern: /後続として、?次回決算で/,
      reason: "avoid a generic follow-up phrase; specify the next KPI or accounting item"
    },
    {
      pattern: /次回決算で(?:売上|売上高)、?営業利益、?現金収支/,
      reason: "do not use the same sales/profit/cash-flow checklist for every company"
    },
    {
      pattern: /実際の収益貢献を確認/,
      reason: "replace generic revenue-contribution wording with a company-specific metric"
    }
  ];

  for (const { pattern, reason } of genericPatterns) {
    if (pattern.test(value)) {
      throw new Error(`report ${alertId} field ファンダ要点 is too generic: ${reason}`);
    }
  }
}

function assertNoNarrowDisclosureCaveat(alertId, fieldMap) {
  const materials = String(fieldMap.get("足元材料") || "");
  const disclosure = String(fieldMap.get("開示リンク") || "");
  if (hasSparseDisclosureFallback(fieldMap)) return;
  const narrowPatterns = [
    /業績修正や決算短信[^。]*確認できず/,
    /決算短信[^。]*直リンク[^。]*確認できず/,
    /大型業績修正[^。]*確認できず/,
    /個別の業績修正[^。]*確認できず/,
    /同日付近[^。]*(?:確認できず|未確認)/,
    /直接的な[^。]*(?:ファイル|開示|直リンク)[^。]*(?:確認できず|未確認)/,
    /(?:大型|直近)[^。]*(?:ファイル|開示|直リンク)[^。]*(?:確認できず|未確認)/,
    /開示リンク[^。]*(?:未確認扱い|未確認)/
  ];
  if (narrowPatterns.some(pattern => pattern.test(materials)) || /開示リンク未確認扱い/.test(disclosure)) {
    throw new Error(`report ${alertId} field 足元材料 is too narrowly scoped; check company IR/TDnet for non-earnings disclosures`);
  }
}

function assertNoStaleSingleMaterialSummary(alertId, fieldMap) {
  const materials = String(fieldMap.get("足元材料") || "");
  const reliesOnAnnualPresentation = /20[0-9]{2}年度決算説明資料を確認/.test(materials);
  const mentionsRecentIr = /(第[１1一]四半期|月次|業績予想|固定資産|特別利益|最新IR|最新資料)/.test(materials);
  if (reliesOnAnnualPresentation && !mentionsRecentIr) {
    throw new Error(`report ${alertId} field 足元材料 may be stale; scan the latest IR library and newer disclosures before relying on an annual presentation`);
  }
}

function assertNoStaleDisclosureProxyLabels(alertId, fieldMap) {
  const value = String(fieldMap.get("開示リンク") || "").trim();
  if (!value || value === "開示リンク未確認") return;
  const alwaysProxyPatterns = [
    /新規上場会社紹介レポート/,
    /COMPANY RESEARCH/i,
    /フォローアップレポート/,
    /スポンサードリサーチレポート/,
    /調査レポート/,
    /社長名鑑/
  ];
  const staleOfficialPatterns = [
    /有価証券報告書/,
    /統合報告書/,
    /IRプレゼンテーション補足資料/,
    /平成[0-9０-９]+年/,
    /^[^0-9０-９]*会社説明会資料$/,
    /^[^0-9０-９]*IR説明会資料$/
  ];
  for (const { label } of extractMarkdownLinks(value)) {
    if (alwaysProxyPatterns.some(pattern => pattern.test(label))) {
      throw new Error(`report ${alertId} disclosure link uses a proxy document instead of a current direct disclosure: ${label}`);
    }
    if (staleOfficialPatterns.some(pattern => pattern.test(label)) && !hasSparseDisclosureFallback(fieldMap)) {
      throw new Error(`report ${alertId} disclosure link uses a stale/proxy document instead of a current direct disclosure: ${label}`);
    }
  }
}

function hasSparseDisclosureFallback(fieldMap) {
  const text = `${fieldMap.get("足元材料") || ""}\n${fieldMap.get("注意点") || ""}`;
  return /公式IR\/IRBANKを(?:45日|四十五日|少なくとも45日)[^。]*(?:新しい|直近)[^。]*(?:個別開示|適時開示)[^。]*(?:見当たらず|確認できず|限定的)/.test(text)
    || /公式IRとIRBANKを(?:45日|四十五日|少なくとも45日)[^。]*(?:新しい|直近)[^。]*(?:個別開示|適時開示)[^。]*(?:見当たらず|確認できず|限定的)/.test(text);
}

function assertDescriptiveLinkLabels(alertId, fieldMap) {
  for (const name of ["開示リンク", "Sources"]) {
    const value = String(fieldMap.get(name) || "").trim();
    if (name === "開示リンク" && value === "開示リンク未確認") continue;
    for (const { label } of extractMarkdownLinks(value)) {
      if (isGenericLinkLabel(label)) {
        throw new Error(`report ${alertId} field ${name} has non-descriptive link label: ${label}`);
      }
    }
  }
}

function assertDisclosureLinksAreDirectDisclosures(alertId, fieldMap) {
  const value = String(fieldMap.get("開示リンク") || "").trim();
  if (value === "開示リンク未確認") return;
  for (const { label, url } of extractMarkdownLinks(value)) {
    if (!isDirectDisclosureLinkUrl(url)) {
      throw new Error(`report ${alertId} disclosure link must be a direct disclosure URL: ${label}`);
    }
    if (!isTimestampedDisclosureLabel(label)) {
      throw new Error(`report ${alertId} disclosure link label must be "YYYY-MM-DD 開示タイトル(hh:mm)": ${label}`);
    }
  }
}

function isTimestampedDisclosureLabel(label) {
  return /^20\d{2}-\d{2}-\d{2}\s+\S.+\((?:[01]?\d|2[0-3]):[0-5]\d\)$/.test(normalizeDisclosureLabelForDisplay(label));
}

function normalizeDisclosureLabelForDisplay(label) {
  return String(label || "")
    .normalize("NFKC")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

function assertSourceLinksAreReferencePages(alertId, fieldMap) {
  for (const { label, url } of extractMarkdownLinks(fieldMap.get("Sources") || "")) {
    if (isDirectDisclosureLinkUrl(url)) {
      throw new Error(`report ${alertId} source link must be a reference/listing page URL, not a direct disclosure URL: ${label}`);
    }
  }
}

function extractMarkdownLinks(value) {
  const links = [];
  const pattern = /\[([^\]\n]+)\]\(https?:\/\/[^)\s]+(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(String(value || ""))) !== null) {
    const raw = match[0].match(/\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)$/);
    links.push({ label: match[1].trim(), url: raw ? raw[1] : "" });
  }
  return links;
}

function isGenericLinkLabel(label) {
  const text = String(label || "").trim();
  return /^(?:開示|出典|資料|リンク|link|source|sources|ir|pdf|url)\s*[0-9０-９]*$/i.test(text)
    || /^(?:会社IR|会社IRページ|公式サイト|会社概要|製品情報|株価情報|会社プロフィール|会社開示PDF|決算短信PDF|調査レポートPDF|IRライブラリ|資料情報)$/i.test(text);
}

function isDirectDisclosureFileUrl(url) {
  const text = String(url || "").trim().toLowerCase();
  return /\.pdf(?:$|[?#])/.test(text) || /td_download\.cgi/.test(text);
}

function isDirectDisclosureLinkUrl(url) {
  return isDirectDisclosureFileUrl(url) || isDisclosureDetailPageUrl(url);
}

async function resolveIrbankPdfDisclosureLinks(report) {
  const fields = Array.isArray(report.fields) ? report.fields : [];
  const field = fields.find(item => String(item.name || "").trim() === "開示リンク");
  if (!field || !field.value || String(field.value).trim() === "開示リンク未確認") return report;
  field.value = await replaceMarkdownLinkUrls(field.value, async url => resolveIrbankDisclosurePdfUrl(url));
  return report;
}

async function assertNoNewerIrbankDisclosureMiss(report, claim) {
  const alertId = String(report.alertId || "").trim();
  const symbolCode = String(report.symbolCode || claim?.symbolCode || "").trim();
  if (!symbolCode) return;

  const receivedAtMs = parseReceivedAtMs(report.receivedAt || claim?.receivedAt || "");
  const cutoffMs = receivedAtMs
    ? receivedAtMs - 45 * 24 * 60 * 60 * 1000
    : Date.now() - 45 * 24 * 60 * 60 * 1000;

  const candidates = dedupeDisclosureCandidates([
    ...(await fetchIrbankDisclosureCandidates(symbolCode)),
    ...(await fetchYahooFinanceDisclosureCandidates(symbolCode))
  ]);

  const fundamentalCandidates = candidates
    .filter(item => item.disclosedAtMs >= cutoffMs)
    .filter(item => isFundamentalDisclosureTitle(item.title))
    .sort((a, b) => b.disclosedAtMs - a.disclosedAtMs);

  if (!fundamentalCandidates.length) return;

  const newest = fundamentalCandidates[0];
  const sameTimeNewest = fundamentalCandidates.filter(item => item.disclosedAtMs === newest.disclosedAtMs);

  const reportText = getReportAllText(report);
  const disclosureText = getReportFieldValue(report, "開示リンク");

  const missing = sameTimeNewest.filter(item => {
    const titleHit = reportText.includes(item.title) || looseTitleIncluded(reportText, item.title);
    const urlHit = disclosureText.includes(item.url) || disclosureText.includes(item.documentId);
    const dateHit = reportMentionsDisclosureDate(reportText, item);
    return !(titleHit || urlHit) || !dateHit;
  });

  if (missing.length) {
    const list = missing.map(item => {
      const source = item.sourceName ? ` [${item.sourceName}]` : "";
      return `${item.dateText} ${item.timeText || ""} ${item.title}${source}`;
    }).join(" / ");
    throw new Error(
      `report ${alertId} may be stale: newer fundamentally material disclosure exists for ${symbolCode}: ${list}`
    );
  }

  const newestDateMs = startOfJstDateMs(newest.disclosedAtMs);
  const reportMaxDateMs = extractNewestDateMentionMs(reportText);

  if (reportMaxDateMs && reportMaxDateMs < newestDateMs) {
    throw new Error(
      `report ${alertId} uses an older disclosure while newer fundamentally material disclosure exists for ${symbolCode}: ${newest.dateText} ${newest.title}`
    );
  }
}

async function fetchIrbankDisclosureCandidates(symbolCode) {
  const code = String(symbolCode || "").trim();
  if (!/^[0-9A-Z]{4,5}$/i.test(code)) return [];

  const url = `https://irbank.net/${encodeURIComponent(code)}/ir`;

  let html = "";
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });
    if (!response.ok) return [];
    html = await response.text();
  } catch {
    return [];
  }

  const results = [];
  const linkPattern = new RegExp(
    `<a[^>]+href=["']\\/${code}\\/(\\d{12,})["'][^>]*>([\\s\\S]*?)<\\/a>`,
    "gi"
  );

  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const documentId = match[1];
    const rawTitle = stripHtml(match[2]);
    const beforeContext = html.slice(Math.max(0, match.index - 500), match.index);
    const context = html.slice(Math.max(0, match.index - 700), Math.min(html.length, linkPattern.lastIndex + 700));

    const dateInfo = extractNearestDisclosureDateInfo(beforeContext, rawTitle) || extractDisclosureDateInfo(context);
    if (!dateInfo.dateText || !dateInfo.disclosedAtMs) continue;

    results.push({
      symbolCode: code,
      documentId,
      title: normalizeSpaces(rawTitle),
      dateText: dateInfo.dateText,
      timeText: dateInfo.timeText,
      disclosedAtMs: dateInfo.disclosedAtMs,
      url: `https://irbank.net/${code}/${documentId}`,
      sourceUrl: url
    });
  }

  return dedupeDisclosureCandidates(results);
}

function extractNearestDisclosureDateInfo(beforeText, titleText = "") {
  const value = normalizeSpaces(stripHtml(beforeText));
  const matches = [...value.matchAll(/(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})/g)];
  if (!matches.length) return null;

  const match = matches[matches.length - 1];
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return null;

  const time = normalizeSpaces(stripHtml(titleText)).match(/(\d{1,2}):(\d{2})/);
  const hour = time ? Number(time[1]) : 0;
  const minute = time ? Number(time[2]) : 0;
  const disclosedAtMs = Date.UTC(year, month - 1, day, hour - 9, minute, 0);

  return {
    dateText: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    timeText: time ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : "",
    disclosedAtMs
  };
}

async function fetchYahooFinanceDisclosureCandidates(symbolCode) {
  const code = String(symbolCode || "").trim();
  if (!/^[0-9A-Z]{4,5}$/i.test(code)) return [];

  const suffixes = ["T", "O", "N", "S", "F"];
  const results = [];

  for (const suffix of suffixes) {
    const sourceUrl = `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.${suffix}/disclosure`;
    let html = "";
    try {
      const response = await fetch(sourceUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      });
      if (!response.ok) continue;
      html = await response.text();
    } catch {
      continue;
    }

    const linkPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const href = normalizeHtmlUrl(match[1], sourceUrl);
      const rawText = normalizeSpaces(stripHtml(match[2]));
      if (!/TDnet\s+PDF/i.test(rawText)) continue;

      const parsed = parseYahooFinanceDisclosureText(rawText);
      if (!parsed.title || !parsed.dateText || !parsed.disclosedAtMs) continue;

      results.push({
        symbolCode: code,
        documentId: href,
        title: parsed.title,
        dateText: parsed.dateText,
        timeText: parsed.timeText,
        disclosedAtMs: parsed.disclosedAtMs,
        url: href,
        sourceUrl,
        sourceName: `Yahoo Finance ${suffix}`
      });
    }
  }

  return dedupeDisclosureCandidates(results);
}

function parseYahooFinanceDisclosureText(text, now = new Date()) {
  const value = normalizeSpaces(text);
  const meta = value.match(/\s((?:20\d{2}[\/.-])?\d{1,2}[\/.-]\d{1,2})\s+(\d{1,2}):(\d{2})\s+TDnet\s+PDF/i);
  if (!meta) return { title: "", dateText: "", timeText: "", disclosedAtMs: 0 };

  const title = normalizeSpaces(value.slice(0, meta.index));
  const dateParts = meta[1].split(/[\/.-]/).map(part => Number(part));
  const hour = Number(meta[2]);
  const minute = Number(meta[3]);
  if (!title || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    return { title: "", dateText: "", timeText: "", disclosedAtMs: 0 };
  }

  let year;
  let month;
  let day;
  if (dateParts.length === 3) {
    [year, month, day] = dateParts;
  } else {
    year = getJstYear(now);
    [month, day] = dateParts;
    const candidateMs = Date.UTC(year, month - 1, day, hour - 9, minute, 0);
    if (candidateMs > now.getTime() + 24 * 60 * 60 * 1000) year -= 1;
  }

  if (!year || !month || !day) return { title: "", dateText: "", timeText: "", disclosedAtMs: 0 };

  const disclosedAtMs = Date.UTC(year, month - 1, day, hour - 9, minute, 0);
  return {
    title,
    dateText: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    timeText: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    disclosedAtMs
  };
}

function getJstYear(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric"
  }).format(now));
}

function normalizeHtmlUrl(href, baseUrl) {
  const text = String(href || "").trim();
  if (!text) return "";
  try {
    return new URL(text, baseUrl).toString();
  } catch {
    return text;
  }
}

function extractDisclosureDateInfo(text) {
  const value = normalizeSpaces(stripHtml(text));

  const ymd =
    value.match(/(20\d{2})[年\/.-]\s*(\d{1,2})[月\/.-]\s*(\d{1,2})日?/) ||
    value.match(/(20\d{2})(\d{2})(\d{2})/);

  if (!ymd) return { dateText: "", timeText: "", disclosedAtMs: 0 };

  const year = Number(ymd[1]);
  const month = Number(ymd[2]);
  const day = Number(ymd[3]);

  const time = value.match(/(\d{1,2}):(\d{2})/);
  const hour = time ? Number(time[1]) : 0;
  const minute = time ? Number(time[2]) : 0;

  const disclosedAtMs = Date.UTC(year, month - 1, day, hour - 9, minute, 0);

  return {
    dateText: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    timeText: time ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : "",
    disclosedAtMs
  };
}

function isFundamentalDisclosureTitle(title) {
  return classifyDisclosureTitle(title) === "fundamental";
}

function isRoutineDisclosureTitle(title) {
  return classifyDisclosureTitle(title) === "routine";
}

function classifyDisclosureTitle(title) {
  const text = String(title || "");

  // 1. ファンダとして必ず優先したい開示
  if (
    /決算短信|四半期決算|決算説明資料|決算補足説明資料/.test(text) ||
    /業績予想|業績修正|上方修正|下方修正|通期予想|連結予想/.test(text) ||
    /配当|増配|減配|復配|無配|剰余金|自己株式|自社株|株主還元/.test(text) ||
    /資本コスト|株価を意識|PBR|ROE|資本政策|資本効率/.test(text) ||
    /中期経営|中計|経営計画|事業計画/.test(text) ||
    /月次|受注|売上速報|販売状況|稼働率/.test(text) ||
    /買収|譲渡|取得|売却|合併|会社分割|事業譲受|事業譲渡/.test(text) ||
    /提携|資本業務|業務提携|共同開発|大型受注|契約締結/.test(text) ||
    /固定資産|特別利益|特別損失|減損|貸倒|投資有価証券/.test(text) ||
    /新株予約権|第三者割当|公募増資|CB|MSワラント|希薄化/.test(text)
  ) {
    return "fundamental";
  }

  // 2. 人事でも、ファンダ/ガバナンス上重要になりやすいもの
  if (
    /代表取締役|社長交代|CEO|CFO|会長交代/.test(text) ||
    /監査法人|会計監査人|不適切会計|不正|調査委員会|特別調査/.test(text) ||
    /訴訟|行政処分|規制|上場維持|改善報告|監理銘柄|特設注意市場/.test(text)
  ) {
    return "fundamental";
  }

  // 3. 原則スルーでよい通常開示
  if (
    /人事異動|役員人事|執行役員|組織変更|定款一部変更|支配株主等に関する事項/.test(text) ||
    /株主総会|招集通知|独立役員届出|コーポレート・ガバナンス報告書/.test(text)
  ) {
    return "routine";
  }

  return "other";
}

function getReportFieldValue(report, fieldName) {
  const field = (report.fields || []).find(item => String(item.name || "").trim() === fieldName);
  return String(field?.value || "");
}

function getReportAllText(report) {
  return [
    report.title,
    report.symbolCode,
    report.symbolName,
    ...(report.fields || []).map(field => `${field.name || ""}\n${field.value || ""}`)
  ].join("\n");
}

function looseTitleIncluded(reportText, title) {
  const a = normalizeTitleForCompare(reportText);
  const b = normalizeTitleForCompare(title);
  if (!b) return false;

  if (a.includes(b)) return true;

  // 「資本コストや株価を意識した経営の実現に向けた対応について」系の短縮表現も拾う
  if (/資本コスト/.test(title) && /資本コスト/.test(reportText)) return true;
  if (/株価を意識/.test(title) && /株価を意識/.test(reportText)) return true;
  if (/決算短信/.test(title) && /決算短信/.test(reportText)) return true;

  return false;
}

function normalizeTitleForCompare(value) {
  return String(value || "")
    .replace(/[ \t\r\n　]/g, "")
    .replace(/[【】「」『』（）()〔〕]/g, "")
    .trim();
}

function reportMentionsDisclosureDate(reportText, item) {
  const date = String(item.dateText || "");
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return false;

  const patterns = [
    `${year}年${month}月${day}日`,
    `${year}/${month}/${day}`,
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    `${month}月${day}日`
  ];

  return patterns.some(pattern => reportText.includes(pattern));
}

function extractNewestDateMentionMs(text) {
  const matches = [...String(text || "").matchAll(/(20\d{2})[年\/.-]\s*(\d{1,2})[月\/.-]\s*(\d{1,2})日?/g)];
  let max = 0;

  for (const match of matches) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const ms = Date.UTC(year, month - 1, day, -9, 0, 0);
    if (Number.isFinite(ms) && ms > max) max = ms;
  }

  return max;
}

function startOfJstDateMs(ms) {
  const date = new Date(ms);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = Number(parts.find(p => p.type === "year")?.value);
  const month = Number(parts.find(p => p.type === "month")?.value);
  const day = Number(parts.find(p => p.type === "day")?.value);

  return Date.UTC(year, month - 1, day, -9, 0, 0);
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dedupeDisclosureCandidates(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = item.documentId ? String(item.documentId) : `${item.url || ""}:${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

async function replaceMarkdownLinkUrls(value, resolver) {
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(String(value || ""))) !== null) {
    result += String(value).slice(lastIndex, match.index);
    const label = match[1];
    const url = match[2];
    const resolved = await resolver(url);
    result += `[${label}](${resolved || url})`;
    lastIndex = pattern.lastIndex;
  }
  result += String(value || "").slice(lastIndex);
  return result;
}

async function resolveIrbankDisclosurePdfUrl(url) {
  const normalized = normalizeIrbankDisclosureDetailUrl(url);
  if (!normalized) return url;
  try {
    const response = await fetch(normalized);
    if (!response.ok) return normalized;
    const html = await response.text();
    return extractIrbankPdfUrlFromHtml(html, extractIrbankDisclosureId(normalized)) || normalized;
  } catch {
    return normalized;
  }
}

function normalizeIrbankDisclosureDetailUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    parsed.hash = "";
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "irbank.net") return "";
    if (!isDisclosureDetailPageUrl(parsed.toString())) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function extractIrbankDisclosureId(url) {
  try {
    const pathname = new URL(String(url || "")).pathname;
    const match = pathname.match(/\/([0-9]{12,})\/?$/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function extractIrbankPdfUrlFromHtml(html, disclosureId = "") {
  const escapedId = String(disclosureId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const specificPattern = escapedId
    ? new RegExp(`https?:\\/\\/f\\.irbank\\.net\\/(?:pr|pdf)\\/[^"'<>\\s)]+\\/${escapedId}\\.pdf`, "i")
    : null;
  const specific = specificPattern ? String(html || "").match(specificPattern) : null;
  if (specific) return specific[0];
  const fallback = String(html || "").match(/https?:\/\/f\.irbank\.net\/(?:pr|pdf)\/[^"'<>\s)]+\.pdf/i);
  return fallback ? fallback[0] : "";
}

function isDisclosureDetailPageUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname;
    if (host === "irbank.net" && /^\/[0-9A-Z]{4,5}\/[0-9]{12,}\/?$/i.test(pathname)) return true;
    if (host === "irbank.net" && /^\/E[0-9A-Z]+\/[0-9]{12,}\/?$/i.test(pathname)) return true;
    if (host === "prtimes.jp" && /^\/main\/html\/rd\/p\/[0-9.]+\.html$/i.test(pathname)) return true;
  } catch {
    return false;
  }
  return false;
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
  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.text();
    if (response.status >= 200 && response.status < 300) return body ? JSON.parse(body) : {};

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

function buildDiscordMessageUrl(message) {
  const channelId = String(message?.channel_id || "").trim();
  const messageId = String(message?.id || "").trim();
  const guildId = String(message?.guild_id || env("DISCORD_PREMIUM_GUILD_ID") || env("DISCORD_GUILD_ID") || "").trim();
  if (!guildId || !channelId || !messageId) return "";
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

async function readSheetValues(spreadsheetId, range, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
  url.searchParams.set("majorDimension", "ROWS");
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  const data = await fetchGoogleJson("Sheets read", url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return data.values || [];
}

async function updateSheetValues(spreadsheetId, range, values, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
  url.searchParams.set("valueInputOption", "USER_ENTERED");
  return fetchGoogleJson("Sheets update", url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ range, majorDimension: "ROWS", values })
  });
}

async function appendSheetValues(spreadsheetId, range, values, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`);
  url.searchParams.set("valueInputOption", "USER_ENTERED");
  url.searchParams.set("insertDataOption", "INSERT_ROWS");
  return fetchGoogleJson("Sheets append", url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ majorDimension: "ROWS", values })
  });
}

async function batchUpdateSpreadsheet(spreadsheetId, requests, accessToken) {
  if (!requests.length) return {};
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  return fetchGoogleJson("Sheets batchUpdate", url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ requests })
  });
}

async function getSpreadsheetSheets(spreadsheetId, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`);
  url.searchParams.set("fields", "sheets.properties(sheetId,title)");
  const data = await fetchGoogleJson("Sheets metadata", url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return (data.sheets || []).map(sheet => sheet.properties);
}

async function fetchGoogleJson(label, url, options) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, options);
    const body = await response.text();
    if (response.ok) return body ? JSON.parse(body) : {};
    if (isRetriableGoogleStatus(response.status) && attempt < 4) {
      await sleep(googleRetryDelayMs(response, body, attempt));
      continue;
    }
    throw new Error(`${label} failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  }
  throw new Error(`${label} failed after retries`);
}

function isRetriableGoogleStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function googleRetryDelayMs(response, body, attempt) {
  const retryAfter = parseRetryAfterMs(response, body);
  if (retryAfter !== 1000) return Math.min(retryAfter, 90000);
  return Math.min(5000 * (2 ** attempt), 60000);
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

async function writePremiumLogEventsCore_(events) {
  if (!events.length) return;
  if (env("PREMIUM_LOG_FORCE_FAIL")) throw new Error("forced failure for testing (PREMIUM_LOG_FORCE_FAIL)");
  const config = getPremiumLogConfig();
  if (!config) return;
  const token = await getGoogleAccessToken([SHEETS_WRITE_SCOPE]);
  const sheetId = await ensureSheetWithHeader(config.spreadsheetId, config.logSheetName, LOG_HEADERS, token);
  await deleteOldPremiumLogRows(config, token, sheetId);
  await appendSheetValues(
    config.spreadsheetId,
    `${quoteSheetName(config.logSheetName)}!A:${columnName(LOG_HEADERS.length)}`,
    events.map(logEventToRow),
    token
  );
}

async function writePremiumLogEventsSafe(events, state, statePath) {
  if (!events.length) return;
  try {
    await writePremiumLogEventsCore_(events);
    if (state && state.pendingLogEvents && state.pendingLogEvents.length > 0) {
      state.pendingLogEvents = [];
      if (statePath) saveState(statePath, state);
    }
  } catch (error) {
    const alertIds = events.map(e => e.alertId).filter(Boolean);
    console.error(JSON.stringify({
      ok: false,
      reason: "premium_log_write_failed",
      alert_ids: alertIds,
      error: error.message
    }));
    if (state && statePath) {
      state.pendingLogEvents = [...(state.pendingLogEvents || []), ...events];
      saveState(statePath, state);
    }
    process.exitCode = 2;
  }
}

async function replayPendingLogEvents_(state, statePath) {
  if (!state.pendingLogEvents || !state.pendingLogEvents.length) return;
  const events = state.pendingLogEvents;
  state.pendingLogEvents = [];
  saveState(statePath, state);
  try {
    await writePremiumLogEventsCore_(events);
    console.log(JSON.stringify({ ok: true, replayed: events.length, note: "pending log events replayed" }));
  } catch (error) {
    state.pendingLogEvents = events;
    saveState(statePath, state);
    console.error(JSON.stringify({
      ok: false,
      reason: "premium_log_replay_failed",
      pending: events.length,
      error: error.message
    }));
    process.exitCode = 2;
  }
}

async function deleteOldPremiumLogRows(config, accessToken, sheetId) {
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

function buildPostLogEvent(report, embed, claim, discordMessageUrl = "") {
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
    reason: buildPostLogReason(report, fields, discordMessageUrl)
  };
}

function buildPostLogReason(report, fields, discordMessageUrl = "") {
  const rawImpact = fields.get("材料インパクト") || report.materialImpact || "";
  const impact = normalizeMaterialImpact(rawImpact) || normalizeOneLine(rawImpact);
  const fundamental = firstSentence(fields.get("ファンダ要点") || "");
  const material = firstSentence(fields.get("足元材料") || "");
  const basis = normalizeOneLine(fundamental || material);
  const summary = truncate(impact || basis, discordMessageUrl ? 800 : 1000);
  if (summary && discordMessageUrl) return `[${escapeMarkdownLinkLabel(summary)}](${discordMessageUrl})`;
  return summary;
}

function firstSentence(value) {
  const text = normalizeOneLine(value);
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if ("。！？".includes(char)) return text.slice(0, i + 1);
    if (".!?".includes(char) && !isAsciiDigit(text[i - 1]) && !isAsciiDigit(text[i + 1])) {
      return text.slice(0, i + 1);
    }
  }
  return text;
}

function isAsciiDigit(value) {
  return /[0-9]/.test(String(value || ""));
}

function escapeMarkdownLinkLabel(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function normalizeOneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function buildSamayomiStubEmbed_(alertId, reason, claim) {
  const symbolCode = String(claim?.symbolCode || "").trim();
  const symbolName = String(claim?.symbolName || alertId).trim();
  const tvUrl = normalizeEmbedUrl(String(claim?.tradingViewUrl || ""));
  const title = symbolName && symbolCode
    ? `${symbolName} (${symbolCode}) | TradingView チャート`
    : `${alertId} | TradingView チャート`;
  const yahooUrl = symbolCode ? `https://finance.yahoo.co.jp/quote/${symbolCode}.T` : "";
  const irbankIrUrl = symbolCode ? `https://irbank.net/${symbolCode}/ir` : "";
  const reasonText = String(reason || "材料確認不足").slice(0, 120);

  const sources = [
    yahooUrl ? `[Yahoo!ファイナンス ${symbolName}(${symbolCode}) 株式情報](${yahooUrl})` : "",
    irbankIrUrl ? `[IRBANK ${symbolName}(${symbolCode}) 開示一覧](${irbankIrUrl})` : ""
  ].filter(Boolean).join("\n");

  return {
    title,
    url: tvUrl,
    color: 0x808080,
    timestamp: new Date().toISOString(),
    fields: [
      { name: "材料インパクト", value: `様子見：検証済みソースが不足しており、個別材料の強弱は次回開示待ち（${reasonText}）。`, inline: false },
      { name: "事業概要", value: `${symbolName}（${symbolCode}）は東証上場銘柄。自動処理時点で十分な個別材料を確認できず、様子見判断とした。`, inline: false },
      { name: "足元材料", value: `公式IRとIRBANKを少なくとも45日間確認したが、直近の個別開示・適時開示は限定的（${reasonText}）。次回の四半期決算・適時開示で改めて確認予定。`, inline: false },
      { name: "ファンダ要点", value: "現時点で積み上がった個別材料が薄く様子見とした。次の決算短信・適時開示・月次データが出た時点で改めてファンダを精査する。", inline: false },
      { name: "注意点", value: "このスナップショットは材料確認不足のため様子見扱い。次の開示イベントを確認してから材料を再評価したい。", inline: false },
      { name: "開示リンク", value: "開示リンク未確認", inline: false },
      { name: "Sources", value: sources || "確認済みソースなし", inline: false }
    ],
    footer: { text: "Premium fundamental snapshot / Not investment advice" }
  };
}

function buildSamayomiStubLogEvent_(item, embed, claim, now, discordMessageUrl) {
  const symbolCode = String(claim?.symbolCode || "").trim();
  const symbolName = String(claim?.symbolName || "").trim();
  const signalType = String(claim?.signalType || "BOTTOM").trim();
  const reasonText = String(item.reason || "").slice(0, 800);
  const impact = normalizeOneLine((embed.fields || []).find(f => f.name === IMPACT_FIELD)?.value || "");
  const summary = impact || `様子見：${reasonText}`;
  const reason = discordMessageUrl
    ? `[${escapeMarkdownLinkLabel(truncate(summary, 800))}](${discordMessageUrl})`
    : truncate(summary, 1000);
  return {
    eventAt: now.toISOString(),
    eventType: "POSTED",
    alertId: item.alertId,
    symbolCode,
    symbolName,
    signalType,
    title: embed.title || "",
    tradingViewUrl: embed.url || "",
    disclosureLinks: "開示リンク未確認",
    sourceUrls: (embed.fields || []).find(f => f.name === "Sources")?.value || "",
    reason
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
  const pairs = [];
  for (const item of text.split(",")) {
    const trimmed = item.trim();
    const range = trimmed.match(/^(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2})$/);
    if (range) {
      const [, startHour, startMinute, endHour, endMinute] = range.map(Number);
      const start = startHour * 60 + startMinute;
      const end = endHour * 60 + endMinute;
      if (!isValidJstMinute(startHour, startMinute) || !isValidJstMinute(endHour, endMinute) || end < start) continue;
      for (let minuteOfDay = start; minuteOfDay <= end; minuteOfDay++) {
        pairs.push(formatMinutePair(Math.floor(minuteOfDay / 60), minuteOfDay % 60));
      }
      continue;
    }

    const point = trimmed.match(/^(\d{1,2}):(\d{1,2})$/);
    if (point) {
      const [, hour, minute] = point.map(Number);
      if (isValidJstMinute(hour, minute)) pairs.push(formatMinutePair(hour, minute));
    }
  }
  return pairs.length ? new Set(pairs) : null;
}

function isValidJstMinute(hour, minute) {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function formatMinutePair(hour, minute) {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return { version: 1, posted: {}, failed: {}, claims: {}, pendingLogEvents: [] };
  const state = readJson(statePath);
  return {
    version: 1,
    posted: state.posted || {},
    failed: state.failed || {},
    claims: state.claims || {},
    pendingLogEvents: Array.isArray(state.pendingLogEvents) ? state.pendingLogEvents : []
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
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "ポジティブ材料: 会社開示で売上と営業利益の増加が確認でき、受注環境も改善している。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社。受注環境と工場稼働率が収益に効きやすい。" },
      { name: "足元材料", value: "直近決算では売上と利益の推移が確認材料。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差も見る必要がある。単発材料ではなく継続性も確認したい。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善が続くかを確認したい。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無も見たい。" },
      { name: "開示リンク", value: "" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  });
  assert.equal(embed.title, "テスト (1234) | TradingView チャート");
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
  assert.throws(() => buildEmbed({
    alertId: "a3",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "Software vendor." },
      { name: "足元材料", value: "Recent earnings." },
      { name: "ファンダ要点", value: "Profitability matters." },
      { name: "注意点", value: "Watch costs." },
      { name: "開示リンク", value: "開示リンク未確認" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  }), /must be written in Japanese/);
  assert.throws(() => buildEmbed({
    alertId: "a4",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社。受注環境と工場稼働率が収益に効きやすい。" },
      { name: "足元材料", value: "直近決算では売上と利益の推移が確認材料。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差も見る必要がある。単発材料ではなく継続性も確認したい。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善が続くかを確認したい。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無も見たい。" },
      { name: "開示リンク", value: "[2026-04-30 業績予想修正に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[出典1](https://example.com/ir)" }
    ]
  }), /non-descriptive link label/);
  assert.throws(() => buildEmbed({
    alertId: "a4b",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社。受注環境と工場稼働率が収益に効きやすい。" },
      { name: "足元材料", value: "公式IR/IRBANKを45日分確認したが、直近の個別開示は見当たらず、確認できる開示は限定的。2026年4月30日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。" },
      { name: "ファンダ要点", value: "業績予想修正は本業の採算改善と一過性要因を分けて確認する必要がある。利益率、受注残、キャッシュフローの改善が続くか、次回決算で会社計画との進捗差も見たい。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無も見たい。" },
      { name: "開示リンク", value: "[2026-04-30 業績予想修正に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  }), /research-log caveat/);
  assert.throws(() => buildEmbed({
    alertId: "a4bb",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "医療機関向けソフトを提供するIT企業で、導入施設数、保守料、クラウド利用料、開発人員の稼働が収益を左右する会社。" },
      { name: "足元材料", value: "2026-04-01に「子会社化完了に関するお知らせ」、「新製品提供開始に関するお知らせ」も確認。医療ITの製品ライン拡充とM&Aが同日に進み、導入施設数と保守収入の拡大が確認点になる。" },
      { name: "ファンダ要点", value: "医療ITでは導入施設数、保守・クラウド利用料、解約率、開発人員の稼働率が重要。買収子会社の売上・利益貢献と新製品の導入ペースを見たい。既存レセプト点検ソフトとのクロスセル余地も確認点になる。" },
      { name: "注意点", value: "M&Aは統合費用、既存製品との重複、医療機関への導入期間がリスクになる。販売開始後の契約件数と単価を確認したい。" },
      { name: "開示リンク", value: "[2026-04-01 子会社化完了に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /disclosure title lists/);
  assert.throws(() => buildEmbed({
    alertId: "a4c",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社。受注環境と工場稼働率が収益に効きやすい。" },
      { name: "足元材料", value: "2026年4月30日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。利益率、受注残、キャッシュフローの改善が次回決算でも続くかを確認したい。" },
      { name: "ファンダ要点", value: "利益率、受注残、キャッシュフローの改善が次回決算でも続くかを確認したい。会社予想との進捗差、在庫、資金繰りも重要になり、一過性利益と本業採算を分けて見る必要がある。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無も見たい。" },
      { name: "開示リンク", value: "[2026-04-30 業績予想修正に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  }), /repeats the same long sentence/);
  assert.throws(() => buildEmbed({
    alertId: "a4d",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "テスト（1234）は、開示資料で確認できる主要サービス・製品を中心に事業を展開する上場企業です。直近の材料は、売上成長、利益率、資本政策、事業提携のどれに効くかを分けて見る必要があります。" },
      { name: "足元材料", value: "2026年4月10日の適時開示で新しい契約を確認しました。IRBANKの開示一覧でも45日前後の新しい材料として追えるため、事業進捗、業績変化、資本政策のいずれに影響するかが確認点です。" },
      { name: "ファンダ要点", value: "ファンダ面では、この開示が継続収益の拡大、一過性損益、資金調達、提携・M&Aのどれに分類されるかが重要です。後続として、次回決算で売上、営業利益、現金収支への反映を確認したい局面です。" },
      { name: "注意点", value: "開示単体では金額、契約期間、希薄化、一過性の区別が十分に読み切れない場合があります。売買判断ではなく、追加IRと決算資料で実際の収益貢献を確認する前提です。" },
      { name: "開示リンク", value: "[2026-04-10 新規契約締結に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /too generic/);
  assert.throws(() => buildEmbed({
    alertId: "a4e",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "店舗向けクラウド在庫管理を月額課金で提供するSaaS企業で、導入店舗数、解約率、追加機能単価が収益の中心になる会社。" },
      { name: "足元材料", value: "2026年4月10日に大手小売チェーンへの新規導入を開示し、導入店舗数の拡大がARR増加につながるかが確認材料になっている。既存顧客への追加機能販売もあわせて見る局面。" },
      { name: "ファンダ要点", value: "ファンダ面では、この開示が継続収益の拡大、一過性損益、資金調達、提携・M&Aのどれに分類されるかが重要です。後続として、次回決算で売上、営業利益、現金収支への反映を確認したい局面です。" },
      { name: "注意点", value: "導入店舗数が増えても初期費用中心だとARRへの寄与は限定的になる。小売チェーン内の展開率、月額単価、解約率の開示が次の確認点。" },
      { name: "開示リンク", value: "[2026-04-10 大手小売チェーンへの新規導入に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /ファンダ要点 is too generic/);
  assert.throws(() => buildEmbed({
    alertId: "a4f",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A441A",
    symbolCode: "441A",
    symbolName: "NE",
    fields: [
      { name: "事業概要", value: "NE（441A）は、開示資料で確認できる主要サービス・製品を中心に事業を展開する上場企業です。直近の材料は、売上成長、利益率、資本政策、事業提携のどれに効くかを分けて見る必要があります。" },
      { name: "足元材料", value: "2026年4月17日に業務提携を開示し、EC支援サービスの連携先拡大が利用店舗数と追加機能利用につながるかが確認材料になる。株主優待だけでなく本業KPIへの接続を見たい。" },
      { name: "ファンダ要点", value: "EC支援SaaSでは利用店舗数、解約率、ARPU、連携サービス経由の取扱量が収益の見方になる。提携が新規顧客獲得か既存顧客単価の上昇かを分けて確認したい。" },
      { name: "注意点", value: "提携は基本合意段階だと収益化時期と契約条件が読みづらい。導入社数、手数料率、開発負担、既存顧客への追加販売率が次の確認点になる。" },
      { name: "開示リンク", value: "[2026-04-17 Cafe24 Corp.との業務提携に関する基本合意書の締結に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[NE IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /事業概要 is too generic/);
  assert.throws(() => buildEmbed({
    alertId: "a5",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社。受注環境と工場稼働率が収益に効きやすい。" },
      { name: "足元材料", value: "直近決算では売上と利益の推移が確認材料。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差も見る必要がある。単発材料ではなく継続性も確認したい。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善が続くかを確認したい。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無も見たい。" },
      { name: "開示リンク", value: "[2026-04-30 業績予想修正に関するお知らせ(15:00)](https://example.com/disclosure)" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  }), /direct disclosure URL/);
  assert.throws(() => buildEmbed({
    alertId: "a6",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社。受注環境と工場稼働率が収益に効きやすい。" },
      { name: "足元材料", value: "直近決算では売上と利益の推移が確認材料。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差も見る必要がある。単発材料ではなく継続性も確認したい。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善が続くかを確認したい。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無も見たい。" },
      { name: "開示リンク", value: "[2026-04-30 業績予想修正に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[業績予想修正に関するお知らせ](https://example.com/disclosure.pdf)" }
    ]
  }), /source link must be a reference\/listing page URL/);
  assert.throws(() => buildEmbed({
    alertId: "a8",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社。受注環境と工場稼働率が収益に効きやすい。" },
      { name: "足元材料", value: "同日付近の業績修正や決算短信の直リンクは確認できず、会社概要と株式情報を参照した。非決算のIR開示がないかは別途確認が必要であり、この表現は公式IR一覧の確認不足を招くため使用しない。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善が続くかを確認したい。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無も見たい。" },
      { name: "開示リンク", value: "開示リンク未確認" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /too narrowly scoped/);
  assert.throws(() => buildEmbed({
    alertId: "a9",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "通信販売と法人向けサービスを扱う小売企業で、在庫管理、物流費、販促効率、顧客基盤の維持が収益性を左右する会社。" },
      { name: "足元材料", value: "2025年度決算説明資料を確認し、株主・投資家情報や事業内容ページもSourcesで参照。株主還元方針変更、優待廃止、再建計画など、収益改善と株主政策が同時に確認材料になっている。" },
      { name: "ファンダ要点", value: "黒字化計画は重要な材料だが、小売事業では在庫回転、粗利率、広告費、物流費の改善が伴う必要がある。既存顧客基盤を活かした再成長がどこまで進むかを確認したい。" },
      { name: "注意点", value: "カタログやEC需要の鈍化、在庫評価、物流費、広告費、構造改革費用に注意。還元方針変更は短期需給に影響しやすく、本業改善と分けて見る必要がある。" },
      { name: "開示リンク", value: "[2025-05-15 2025年度 決算説明資料(15:00)](https://example.com/2025_presentation.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /may be stale/);
  assert.throws(() => buildEmbed({
    alertId: "a10",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "施設向けサービスを継続課金で提供する企業で、導入先数、利用者数、物流・人件費の管理が収益性を左右する会社。" },
      { name: "足元材料", value: "2026年5月1日に第1四半期決算関連資料が開示され、売上成長と利益進捗、サービス導入数の推移が確認材料になっている。古い有価証券報告書だけでは足元材料として不十分。" },
      { name: "ファンダ要点", value: "継続課金型の事業は安定性がある一方、導入施設数、利用率、単価、配送・洗濯・人件費が利益率を左右する。四半期進捗と通期計画との差を確認したい。" },
      { name: "注意点", value: "制度変更、施設稼働、物流費、人件費、競合サービスの影響に注意。売上成長が続いてもコスト増で利益率が鈍る可能性がある。" },
      { name: "開示リンク", value: "[2025-06-27 有価証券報告書 第29期(15:00)](https://example.com/securities.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /stale\/proxy document/);
  const sparseDisclosureEmbed = buildEmbed({
    alertId: "a10b",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "様子見：直近45日内の新しい個別材料が乏しく、次回開示待ちの状態。" },
      { name: "事業概要", value: "単一領域のサービスを展開する企業で、契約数、単価、固定費の推移が業績確認の中心になる会社。" },
      { name: "足元材料", value: "確認できる新しい個別材料は乏しく、古い公式資料で事業構成、収益源、リスク要因だけを補助確認する局面。新規材料としては扱わず、次回決算や会社開示で足元の進捗を確認したい。" },
      { name: "ファンダ要点", value: "新しい個別材料が乏しいため、足元の評価は保留気味。既存事業の継続性、利益率、資金繰り、固定費の吸収状況、受注や契約数の変化、次回決算での進捗確認が重要になる。" },
      { name: "注意点", value: "公式IR/IRBANKを45日分確認したが、直近の個別開示は見当たらず、確認できる開示は限定的。古い資料だけで短期材料を強く評価せず、次の会社開示や決算で裏付けを取りたい。" },
      { name: "開示リンク", value: "[2025-06-27 有価証券報告書 第29期(15:00)](https://example.com/securities.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)\n[テスト株式会社 会社概要](https://example.com/company)" }
    ]
  });
  assert.equal(sparseDisclosureEmbed.fields.some(field => field.name === "開示リンク"), true);
  assert.throws(() => buildEmbed({
    alertId: "a10c",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社。受注環境と工場稼働率が収益に効きやすい。" },
      { name: "足元材料", value: "2026年5月14日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。利益率、受注残、キャッシュフローの改善が次回決算でも続くかを確認したい。" },
      { name: "ファンダ要点", value: "販売数量、価格転嫁、固定費吸収、在庫水準が利益率の確認点になる。会社予想との進捗差や資金繰りも重要で、一過性利益と本業採算を分けて見る必要がある。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無も見たい。" },
      { name: "開示リンク", value: "[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://example.com/20260514534210.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /材料インパクト/);
  assert.throws(() => buildEmbed({
    alertId: "a10c2",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "ネガティブ材料" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社。受注環境と工場稼働率が収益に効きやすい。" },
      { name: "足元材料", value: "2026年5月14日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。利益率、受注残、キャッシュフローの改善が次回決算でも続くかを確認したい。" },
      { name: "ファンダ要点", value: "販売数量、価格転嫁、固定費吸収、在庫水準が利益率の確認点になる。会社予想との進捗差や資金繰りも重要で、一過性利益と本業採算を分けて見る必要がある。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無も見たい。" },
      { name: "開示リンク", value: "[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://example.com/20260514534210.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /bare label/);
  const dedupeEmbed = buildEmbed({
    alertId: "a10d",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "混在/要確認：業績改善は確認できるが、投資負担と継続性の確認が必要。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社。受注環境と工場稼働率が収益に効きやすい。" },
      { name: "足元材料", value: "2026年5月14日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。利益率、受注残、キャッシュフローの改善が次回決算でも続くかを確認したい。" },
      { name: "ファンダ要点", value: "販売数量、価格転嫁、固定費吸収、在庫水準が利益率の確認点になる。会社予想との進捗差や資金繰りも重要で、一過性利益と本業採算を分けて見る必要がある。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無も見たい。" },
      { name: "開示リンク", value: "[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://example.com/20260514534210.pdf)\n[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://f.irbank.net/pdf/20260514/140120260514534210.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  });
  assert.equal(dedupeEmbed.fields.find(field => field.name === "開示リンク").value, "・[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://f.irbank.net/pdf/20260514/140120260514534210.pdf)");
  const logEvent = buildPostLogEvent({
    alertId: "a11",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "混在/要確認: 事業進捗はあるが、利益率と資金繰りの確認が必要。" },
      { name: "ファンダ要点", value: "増収は確認できるが、投資負担と利益率の改善確認が必要。次回決算で継続性を見たい。" },
      { name: "足元材料", value: "直近資料で事業進捗を確認。" },
      { name: "開示リンク", value: "[決算短信](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[IRニュース一覧](https://example.com/ir)" }
    ]
  }, { title: "テスト (1234) | TradingView チャート", url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234" }, {});
  assert.equal(logEvent.reason, "混在/要確認：事業進捗はあるが、利益率と資金繰りの確認が必要。");
  const linkedLogEvent = buildPostLogEvent({
    alertId: "a11b",
    symbolCode: "8165",
    symbolName: "千趣会",
    fields: [
      { name: "材料インパクト", value: "混在/要確認：利益改善余地はあるが、投資負担と継続性の確認が必要。" },
      { name: "ファンダ要点", value: "1Qは売上高91.66億円で前年同期比7.1%減ながら、営業損失は9.88億円と前年同期から損失幅が縮小。固定資産売却益と本業改善は分けて確認したい。" },
      { name: "足元材料", value: "直近資料で第1四半期決算と月次を確認。" },
      { name: "開示リンク", value: "[決算短信](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[IRニュース一覧](https://example.com/ir)" }
    ]
  }, { title: "千趣会 (8165) | TradingView チャート", url: "https://www.tradingview.com/chart/?symbol=TSE%3A8165" }, {}, "https://discord.com/channels/1/2/3");
  assert.equal(linkedLogEvent.reason, "[混在/要確認：利益改善余地はあるが、投資負担と継続性の確認が必要。](https://discord.com/channels/1/2/3)");
  assert.equal(extractIrbankPdfUrlFromHtml('<a href="https://f.irbank.net/pr/20260401/140120260326590425.pdf">PDF</a>', "140120260326590425"), "https://f.irbank.net/pr/20260401/140120260326590425.pdf");
  assert.equal(extractIrbankPdfUrlFromHtml('<a href="https://f.irbank.net/pdf/20260430/140120260430514206.pdf">PDF</a>', "140120260430514206"), "https://f.irbank.net/pdf/20260430/140120260430514206.pdf");
  assert.equal(getPostSkipReason("posted-alert", { posted: { "posted-alert": {} }, claims: {} }, null), "already posted");
  assert.equal(getPostSkipReason("unclaimed-alert", { posted: {}, claims: {} }, null), "no active claim");
  assert.equal(getPostSkipReason("claimed-alert", { posted: {}, claims: { "claimed-alert": { claimId: "c1" } } }, { claimId: "c1" }), "");
  const detailEmbed = buildEmbed({
    alertId: "a7",
    url: "https://www.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "混在/要確認：短期材料はあるが、事業KPIへの反映確認が必要。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社。受注環境と工場稼働率が収益に効きやすい。" },
      { name: "足元材料", value: "直近決算では売上と利益の推移が確認材料。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差も見る必要がある。単発材料ではなく継続性も確認したい。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善が続くかを確認したい。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無も見たい。" },
      { name: "開示リンク", value: "[2026-02-12 自己株式取得結果に関するお知らせ(15:00)](https://irbank.net/1234/140120260212558146)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  });
  assert.equal(detailEmbed.fields.find(f => f.name === "開示リンク").value, "・[2026-02-12 自己株式取得結果に関するお知らせ(15:00)](https://irbank.net/1234/140120260212558146)");
  assert.equal(detailEmbed.fields.find(f => f.name === "Sources").value, "・[テスト株式会社 IRニュース一覧](https://example.com/ir/news)");
  const previousHours = process.env.PREMIUM_ALLOWED_JST_HOURS;
  const previousMinutes = process.env.PREMIUM_ALLOWED_JST_MINUTES;
  process.env.PREMIUM_ALLOWED_JST_HOURS = "13,15";
  process.env.PREMIUM_ALLOWED_JST_MINUTES = "13:00-13:10,15:30-15:40";
  const gate1300 = evaluateTimeGate(new Date("2026-05-05T04:00:00Z"), false);
  const gate1305 = evaluateTimeGate(new Date("2026-05-05T04:05:00Z"), false);
  const gate1306 = evaluateTimeGate(new Date("2026-05-05T04:06:00Z"), false);
  const gate1310 = evaluateTimeGate(new Date("2026-05-05T04:10:00Z"), false);
  const gate1311 = evaluateTimeGate(new Date("2026-05-05T04:11:00Z"), false);
  const gate1530 = evaluateTimeGate(new Date("2026-05-05T06:30:00Z"), false);
  const gate1536 = evaluateTimeGate(new Date("2026-05-05T06:36:00Z"), false);
  const gate1537 = evaluateTimeGate(new Date("2026-05-05T06:37:00Z"), false);
  const gate1540 = evaluateTimeGate(new Date("2026-05-05T06:40:00Z"), false);
  const gate1541 = evaluateTimeGate(new Date("2026-05-05T06:41:00Z"), false);
  assert.equal(gate1300.allowed, true);
  assert.equal(gate1305.allowed, true);
  assert.equal(gate1306.allowed, true);
  assert.equal(gate1310.allowed, true);
  assert.equal(gate1311.allowed, false);
  assert.equal(gate1530.allowed, true);
  assert.equal(gate1536.allowed, true);
  assert.equal(gate1537.allowed, true);
  assert.equal(gate1540.allowed, true);
  assert.equal(gate1541.allowed, false);
  assert.equal(gate1541.reason, "outside allowed JST minute slots");
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
  const yahooDisclosure = parseYahooFinanceDisclosureText(
    "Full-year earnings 5/11 15:30 TDnet PDF (348KB)",
    new Date("2026-05-12T00:00:00Z")
  );
  assert.equal(yahooDisclosure.dateText, "2026-05-11");
  assert.equal(yahooDisclosure.timeText, "15:30");
  assert.equal(yahooDisclosure.title, "Full-year earnings");
  const nearestDisclosureDate = extractNearestDisclosureDateInfo("quote date 2026/05/11 previous disclosure 2026/02/10", "Q3 earnings (15:30)");
  assert.equal(nearestDisclosureDate.dateText, "2026-02-10");
  assert.equal(nearestDisclosureDate.timeText, "15:30");
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
