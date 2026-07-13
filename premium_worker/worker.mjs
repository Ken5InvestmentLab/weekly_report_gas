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
const MATERIAL_IMPACT_SUMMARY_MAX_CHARS = 90;
const MATERIAL_IMPACT_PROCEDURAL_FRAGMENTS = [
  "PDF本文でも",
  "PDF本文",
  "開示本文",
  "次回開示で確認する局面",
  "主要損益項目を確認",
  "売上・利益進捗、会社予想、セグメント動向を確認",
  "開示内容を確認"
];
const MATERIAL_IMPACT_AWKWARD_PATTERNS = [
  /開示は.+を含み/,
  /に関するを/,
  /ならびを/,
  /第[0-9０-９一二三四]四半期を/,
  /の特を/,
  /お知を/,
  /にを含み/,
  /に関する$/,
  /について$/
];
const MATERIAL_IMPACT_WEAK_SUMMARY_PATTERNS = [
  /が支えです。?$/,
  /が焦点です。?$/,
  /が重いです。?$/
];
const REQUIRED_FIELDS = [IMPACT_FIELD, "事業概要", "足元材料", "ファンダ要点", "注意点", "開示リンク", "Sources"];
const OPTIONAL_FIELDS = [];
const MIN_REFERENCE_SOURCE_URLS = 2;
const MAX_REFERENCE_SOURCE_URLS = 4;
const LARGE_BATCH_QUALITY_MIN_REPORTS = 10;
const LARGE_BATCH_MAX_NO_DISCLOSURE_RATIO = 0.10;
const LARGE_BATCH_MAX_SPARSE_RATIO = 0.10;
const LARGE_BATCH_AVG_LENGTH_MIN = {
  "足元材料": 85,
  "ファンダ要点": 80,
  "注意点": 60
};
const PREMIUM_SCAN_BUTTON_PREFIX = "premium_scan:";
const LIST_BULLET = "\u30fb";
const DISCORD_COMPONENT_ACTION_ROW = 1;
const DISCORD_COMPONENT_BUTTON = 2;
const DISCORD_BUTTON_STYLE_SECONDARY = 2;
const DISCORD_BUTTON_STYLE_LINK = 5;
const DEFAULT_ALLOWED_HOURS = "13,15";
const DEFAULT_ALLOWED_MINUTES_BY_HOUR = "13:00-13:10,15:30-15:40";
const DEFAULT_SIGNAL_TYPES = "BOTTOM";
const DEFAULT_ALLOWED_WEEKDAYS = "1,2,3,4,5";
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const disclosureCandidatesBySymbol = new Map();
const disclosureHeadStatusByUrl = new Map();
const irbankDisclosurePdfByUrl = new Map();
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

  if (dryRun) {
    const localErrors = collectDryRunLocalValidationErrors(reports, state);
    if (localErrors.length) {
      throw new Error(formatDryRunValidationErrors("dry-run local preflight", localErrors));
    }
  }

  const results = [];
  const postLogEvents = [];
  const dryRunErrors = [];
  try {
    for (const report of reports) {
      const claim = state.claims[report.alertId] || null;
      const skipReason = getPostSkipReason(report.alertId, state, claim);
      if (skipReason) {
        results.push({ alertId: report.alertId, skipped: true, reason: skipReason });
        continue;
      }

      let reportWithClaim;
      let embed;
      let payload;
      try {
        reportWithClaim = hydrateReportWithClaim(report, claim);
        await assertNoNewerIrbankDisclosureMiss(reportWithClaim, claim);
        await resolveIrbankPdfDisclosureLinks(reportWithClaim);
        embed = buildEmbed(reportWithClaim);
        payload = {
          username: env("DISCORD_PREMIUM_USERNAME") || "天底極致 Premium Report",
          allowed_mentions: { parse: [] },
          embeds: [embed],
          components: buildPremiumScanComponents(reportWithClaim, claim, embed.url)
        };
      } catch (error) {
        if (!dryRun) throw error;
        dryRunErrors.push({
          alertId: String(report.alertId || "unknown"),
          message: String(error?.message || error)
        });
        continue;
      }

      if (dryRun) {
        results.push({ alertId: reportWithClaim.alertId, dryRun: true, payload });
        continue;
      }

      const discordMessage = await postPremiumDiscord(payload, webhookUrl);
      const discordMessageUrl = buildDiscordMessageUrl(discordMessage);
      const symbolCode = String(reportWithClaim.symbolCode || claim?.symbolCode || extractSymbolCodeFromUrl(embed.url) || "").trim();
      state.posted[reportWithClaim.alertId] = {
        postedAt: new Date().toISOString(),
        symbolCode,
        symbolName: String(reportWithClaim.symbolName || claim?.symbolName || ""),
        title: embed.title,
        url: embed.url || "",
        discordMessageUrl,
        sourceCount: countUrls(JSON.stringify(embed))
      };
      delete state.claims[reportWithClaim.alertId];
      delete state.failed[reportWithClaim.alertId];
      results.push({ alertId: reportWithClaim.alertId, posted: true, discordMessageUrl });
      postLogEvents.push(buildPostLogEvent(reportWithClaim, embed, claim, discordMessageUrl));
      saveState(statePath, state);
    }
  } finally {
    if (!dryRun) {
      saveState(statePath, state);
      await writePremiumLogEventsSafe(postLogEvents, state, statePath);
    }
  }

  if (dryRunErrors.length) {
    throw new Error(formatDryRunValidationErrors("dry-run disclosure validation", dryRunErrors));
  }

  console.log(JSON.stringify({ ok: true, posted: results.filter(r => r.posted).length, results }, null, 2));
}

function collectDryRunLocalValidationErrors(reports, state) {
  const errors = [];
  for (const report of reports || []) {
    const alertId = String(report.alertId || "unknown");
    const claim = state.claims?.[report.alertId] || null;
    if (getPostSkipReason(report.alertId, state, claim)) continue;

    const reportWithClaim = hydrateReportWithClaim(report, claim);
    if (hasResolvableIrbankDisclosureDetailLink(reportWithClaim)) continue;

    try {
      buildEmbed(reportWithClaim);
    } catch (error) {
      errors.push({ alertId, message: String(error?.message || error) });
    }
  }
  return errors;
}

function hasResolvableIrbankDisclosureDetailLink(report) {
  const value = getReportFieldValue(report, "開示リンク");
  return extractMarkdownLinks(value).some(link => Boolean(normalizeIrbankDisclosureDetailUrl(link.url)));
}

function formatDryRunValidationErrors(stage, errors) {
  const items = errors || [];
  const lines = items.map(item => {
    const message = String(item.message || "validation failed").replace(/\s+/g, " ").trim();
    return `- ${item.alertId || "unknown"}: ${message}`;
  });
  return `${stage} failed for ${items.length} report(s):\n${lines.join("\n")}`;
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

  assertFailCommandScope(failures, opts, Boolean(inputPath));
  assertFailStateScope(failures, opts, state, new Date());

  const dryRun = opts["dry-run"] === true;
  const webhookUrl = dryRun ? "" : requiredEnv("DISCORD_PREMIUM_WEBHOOK_URL");
  if (!dryRun) await replayPendingLogEvents_(state, statePath);
  const now = new Date();
  const results = [];
  const postLogEvents = [];

  try {
    for (const item of failures) {
    if (!item.alertId) throw new Error("fail requires --alert-id <id> or --input with alertId");
    const claim = state.claims[item.alertId] || {};
    const embed = buildSamayomiStubEmbed_(item.alertId, item.reason, claim);
    const payload = {
      username: env("DISCORD_PREMIUM_USERNAME") || "天底極致 Premium Report",
      allowed_mentions: { parse: [] },
      embeds: [embed],
      components: buildPremiumScanComponents(claim, claim, embed.url)
    };
    assertNoInvestmentAdvice(JSON.stringify(payload));

    if (dryRun) {
      results.push({ alertId: item.alertId, dryRun: true, payload });
      continue;
    }

    const discordMessage = await postPremiumDiscord(payload, webhookUrl);
    const discordMessageUrl = buildDiscordMessageUrl(discordMessage);
    const symbolCode = String(claim.symbolCode || "").trim();
    const logEvent = buildSamayomiStubLogEvent_(item, embed, claim, now, discordMessageUrl);

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
    postLogEvents.push(logEvent);
    results.push({ alertId: item.alertId, posted: true, samayomiStub: true, discordMessageUrl });
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

function assertFailCommandScope(failures, opts = {}, isInputBatch = false) {
  const allowMassFail = isMassFailOverrideEnabled(opts);
  if (allowMassFail) return;

  const insufficient = failures.filter(item => isInsufficientSourceReason(item.reason));
  if (!insufficient.length) return;

  if (isInputBatch) {
    throw new Error(
      "batch insufficient-source fail is rejected; verify each alert individually and use fail --alert-id only for alerts that truly lack grounded sources"
    );
  }

  const maxInsufficientFails = positiveInt(env("PREMIUM_MAX_INSUFFICIENT_FAILS_PER_COMMAND"), 1);
  if (insufficient.length > maxInsufficientFails) {
    throw new Error(
      `too many insufficient-source fail stubs in one command (${insufficient.length}); verify each alert individually or set PREMIUM_ALLOW_MASS_FAIL_STUBS=true for a deliberate manual override`
    );
  }
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

function hydrateReportWithClaim(report, claim) {
  const merged = { ...(report || {}) };
  const claimTradingViewUrl = String(claim?.tradingViewUrl || "").trim();

  if (!String(merged.symbolCode || "").trim() && claim?.symbolCode) {
    merged.symbolCode = claim.symbolCode;
  }
  if (!String(merged.symbolName || "").trim() && claim?.symbolName) {
    merged.symbolName = claim.symbolName;
  }
  if (!String(merged.signalType || "").trim() && claim?.signalType) {
    merged.signalType = claim.signalType;
  }
  if (!String(merged.url || "").trim() && claimTradingViewUrl) {
    merged.url = claimTradingViewUrl;
  }

  const url = String(merged.url || "").trim();
  if (!String(merged.symbolCode || "").trim()) {
    const symbolCode = extractSymbolCodeFromUrl(url);
    if (symbolCode) merged.symbolCode = symbolCode;
  }

  return merged;
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
  assertNarrativeMentionedDisclosuresAreLinked(alertId, fieldMap);
  assertJapaneseNarrativeFields(alertId, fieldMap);
  assertNoSymbolCodeInCaution(alertId, report, fieldMap);
  assertNoSymbolIdentityLeadInFundamentals(alertId, report, fieldMap);
  assertConciseMaterialNarrative(alertId, fieldMap);
  assertNoGenericNarrativeTemplates(alertId, fieldMap);
  assertMonthlyNarrativeGrounding(alertId, fieldMap);
  assertNoProceduralAnalysisLanguage(alertId, fieldMap);
  assertNoGenericBusinessOverview(alertId, fieldMap);
  assertNoGenericFundamentalPoint(alertId, fieldMap);
  assertNoNarrowDisclosureCaveat(alertId, fieldMap);
  assertNoStaleSingleMaterialSummary(alertId, fieldMap);
  assertNoStaleDisclosureProxyLabels(alertId, fieldMap);
  assertMaterialImpact(alertId, fieldMap);
  assertPreferredDateStyle(alertId, fieldMap);
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
    if (!trimmed || trimmed.startsWith(LIST_BULLET)) return trimmed;
    return `${LIST_BULLET}${trimmed}`;
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
  assertConciseMaterialImpact(alertId, normalized);
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

function assertConciseMaterialImpact(alertId, value) {
  const parsed = splitMaterialImpact(value);
  if (!parsed) return;

  const { summary } = parsed;
  if (summary.length > MATERIAL_IMPACT_SUMMARY_MAX_CHARS) {
    throw new Error(
      `report ${alertId} field ${IMPACT_FIELD} summary must be under ${MATERIAL_IMPACT_SUMMARY_MAX_CHARS} chars`
    );
  }
  if (/[\r\n]/.test(summary)) {
    throw new Error(`report ${alertId} field ${IMPACT_FIELD} must be a single line`);
  }
  if (/…|\.{2,}|[\[\]]/.test(summary)) {
    throw new Error(`report ${alertId} field ${IMPACT_FIELD} must not use ellipses or pasted disclosure-title brackets`);
  }
  if (/(?:Notice|Summary|Consolidated Financial|Financial Results|Updated)/i.test(summary)) {
    throw new Error(`report ${alertId} field ${IMPACT_FIELD} must summarize in Japanese, not paste an English disclosure title`);
  }
  if (/(?:に関するお知らせ|について(?:は|が|を)?|の開示について)/.test(summary)) {
    throw new Error(`report ${alertId} field ${IMPACT_FIELD} must state the event and business effect, not paste the disclosure title`);
  }
  for (const fragment of MATERIAL_IMPACT_PROCEDURAL_FRAGMENTS) {
    if (summary.includes(fragment)) {
      throw new Error(
        `report ${alertId} field ${IMPACT_FIELD} summary is too procedural: ${fragment}`
      );
    }
  }
  for (const pattern of MATERIAL_IMPACT_AWKWARD_PATTERNS) {
    if (pattern.test(summary)) {
      throw new Error(
        `report ${alertId} field ${IMPACT_FIELD} summary has awkward Japanese from a truncated disclosure title: ${pattern}`
      );
    }
  }
  for (const pattern of MATERIAL_IMPACT_WEAK_SUMMARY_PATTERNS) {
    if (pattern.test(summary)) {
      throw new Error(
        `report ${alertId} field ${IMPACT_FIELD} summary is too vague; summarize the material and business effect: ${pattern}`
      );
    }
  }

  const sentenceMarks = [...summary.matchAll(/[。！？!?]/g)];
  if (sentenceMarks.length > 1) {
    throw new Error(`report ${alertId} field ${IMPACT_FIELD} summary must be one concise sentence`);
  }
  if (sentenceMarks.length === 1 && sentenceMarks[0].index !== summary.length - 1) {
    throw new Error(`report ${alertId} field ${IMPACT_FIELD} summary must keep details outside the impact field`);
  }
}

function splitMaterialImpact(value) {
  const text = normalizeSpaces(String(value || ""));
  for (const label of VALID_MATERIAL_IMPACTS) {
    if (!text.startsWith(`${label}：`)) continue;
    return { label, summary: text.slice(`${label}：`.length).trim() };
  }
  return null;
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
    ["事業概要", 35],
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

function assertNoSymbolCodeInCaution(alertId, report, fieldMap) {
  const symbolCode = String(report.symbolCode || extractSymbolCodeFromUrl(report.url || "") || "").trim();
  if (!symbolCode) return;

  const caution = normalizeSpaces(String(fieldMap.get("注意点") || ""));
  if (caution.startsWith(symbolCode)) {
    throw new Error(`report ${alertId} field 注意点 must not start with the symbol code; the embed title already identifies the symbol`);
  }
}

function assertNoSymbolIdentityLeadInFundamentals(alertId, report, fieldMap) {
  const symbolCode = String(report.symbolCode || extractSymbolCodeFromUrl(report.url || "") || "").trim();
  const symbolName = normalizeSpaces(String(report.symbolName || "")).replace(/[()（）]/g, "");
  const fundamentals = normalizeSpaces(String(fieldMap.get("ファンダ要点") || ""));
  if (!fundamentals) return;

  if (symbolCode && new RegExp(`^${escapeRegExp(symbolCode)}(?:では|は|の|で|：|:)`).test(fundamentals)) {
    throw new Error(`report ${alertId} field ファンダ要点 must not start with the symbol code; the embed title already identifies the symbol`);
  }
  if (symbolCode && new RegExp(`^[^。]{0,24}[（(]${escapeRegExp(symbolCode)}[）)](?:では|は|の|で|：|:)`).test(fundamentals)) {
    throw new Error(`report ${alertId} field ファンダ要点 must not start with the symbol name/code; the embed title already identifies the symbol`);
  }
  if (symbolName) {
    const plainName = escapeRegExp(symbolName.replace(symbolCode, "").trim());
    if (plainName && new RegExp(`^${plainName}(?:では|は|の|で|：|:)`).test(fundamentals)) {
      throw new Error(`report ${alertId} field ファンダ要点 must not start with the symbol name; the embed title already identifies the symbol`);
    }
  }
}

function assertPreferredDateStyle(alertId, fieldMap) {
  const materialImpact = String(fieldMap.get(IMPACT_FIELD) || "");
  if (/\b20\d{2}-\d{2}-\d{2}\b/.test(materialImpact)) {
    throw new Error(`report ${alertId} field ${IMPACT_FIELD} should omit calendar dates; keep it to the material and business impact`);
  }

  const currentMaterials = String(fieldMap.get("足元材料") || "");
  if (/\b20\d{2}-\d{2}-\d{2}\b/.test(currentMaterials)) {
    throw new Error(`report ${alertId} field 足元材料 should use M月D日 style instead of YYYY-MM-DD for calendar dates`);
  }
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
  const datedDisclosureMentions = (String(materials || "").match(/\d{1,2}月\d{1,2}日の/g) || []).length;
  if (datedDisclosureMentions >= 4 || /本文上の補助材料として扱い/.test(materials)) {
    throw new Error(`report ${alertId} field 足元材料 must analyze selected material disclosures, not dump a dated disclosure list`);
  }
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
  const fields = [IMPACT_FIELD, "事業概要", "足元材料", "ファンダ要点", "注意点"];
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
      pattern: /同期間の追加開示も踏まえると/,
      reason: "do not use batch-compression transition wording instead of company-specific analysis"
    },
    {
      pattern: /今回の開示は、?[^。]{0,180}に効くかで評価が変わります/,
      reason: "state the actual impact path instead of deferring to a generic impact question"
    },
    {
      pattern: /収益寄与が単発なら限定的ですが/,
      reason: "replace reusable one-off contribution boilerplate with the actual revenue or margin driver"
    },
    {
      pattern: /開示後の数値で[^。]{0,180}(?:が崩れる場合|材料の見え方が弱まり)/,
      reason: "risk notes must name the concrete KPI risk, not a reusable post-disclosure fallback"
    },
    {
      pattern: /月次動向が主材料で、[^。]{0,120}会社計画との差を見極める段階/,
      reason: "monthly disclosures must be read and summarized with actual same-store/all-store/customer metrics"
    },
    {
      pattern: /最新開示は管理・体制面が中心|体制更新は[^。]{0,80}管理面への影響が中心/,
      reason: "do not use routine governance filings as a filler material narrative"
    },
    {
      pattern: /管理・体制面が中心で、[^。]{2,40}への直接効果は限定的/,
      reason: "material impact must be based on the selected fundamental disclosure, not a routine governance filing"
    },
    {
      pattern: /支配株主関連は補助材料|支配株主関係と人事|支配株主等に関する事項は資本関係の補助情報|親会社関連開示は補助情報|統治関連更新/,
      reason: "do not frame routine controlling-shareholder or governance notices as supplemental fundamental material"
    },
    {
      pattern: /株式報酬[^。]{0,80}(?:人材面の更新|役員インセンティブ|インセンティブ面の開示|直結しません|本業材料)|(?:譲渡制限付)?株式報酬[^。]{0,80}更新/,
      reason: "do not use routine stock-compensation filings as filler in premium fundamentals"
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
    },
    {
      pattern: /…|\.{3,}/,
      reason: "analysis fields must not contain truncated disclosure-title fragments"
    },
    {
      pattern: /主材料に置きます|直接評価する材料/,
      reason: "material narrative must be written as analysis, not as a construction note"
    },
    {
      pattern: /売上拡張または資本効率|を崩さず利益化|ファンダ面の焦点/,
      reason: "fundamental point must avoid reusable template wording"
    },
    {
      pattern: /取得・提携・還元の費用|効果が[^。]{0,80}に偏り|一過性材料で終わります/,
      reason: "risk note must avoid reusable caution templates"
    },
    {
      pattern: /Notice Regarding|Summary|Consolidated Financial|Financial Results|Updated/i,
      reason: "analysis fields must not paste English disclosure-title fragments"
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

function assertMonthlyNarrativeGrounding(alertId, fieldMap) {
  const disclosureLinks = String(fieldMap.get("開示リンク") || "");
  const narrativeFields = [IMPACT_FIELD, "足元材料", "ファンダ要点", "注意点"];
  const narrative = narrativeFields.map(name => String(fieldMap.get(name) || "")).join(" ");
  const combined = `${disclosureLinks} ${narrative}`;
  if (!/月次/.test(combined)) return;

  if (!/月次/.test(narrative)) {
    throw new Error(`report ${alertId} references a monthly disclosure but does not discuss the monthly substance in narrative fields`);
  }

  const hasMonthlyMetric = /\d+(?:\.\d+)?\s*(?:%|％|億円|百万円|万円|円)/.test(narrative);
  if (!hasMonthlyMetric) {
    throw new Error(`report ${alertId} discusses monthly disclosure without actual monthly metrics; include YoY, all-store/same-store, customer count, average spend, or sales figures`);
  }

  const weaknessPattern = /(?:月次[^。]{0,80}(?:弱|悪化|鈍化|減収|前年割れ|マイナス|下回)|(?:弱|悪化|鈍化|減収|前年割れ|マイナス|下回)[^。]{0,80}月次)/;
  if (weaknessPattern.test(narrative) && !/\d+(?:\.\d+)?\s*(?:%|％)/.test(narrative)) {
    throw new Error(`report ${alertId} classifies monthly trend as weak without numeric monthly evidence`);
  }
}

function assertFailStateScope(failures, opts = {}, state = {}, now = new Date()) {
  if (isMassFailOverrideEnabled(opts)) return;

  const insufficient = failures.filter(item => isInsufficientSourceReason(item.reason));
  if (!insufficient.length) return;

  const maxRecentFails = positiveInt(env("PREMIUM_MAX_INSUFFICIENT_FAILS_PER_WINDOW"), 3);
  const windowMinutes = positiveInt(env("PREMIUM_INSUFFICIENT_FAIL_WINDOW_MINUTES"), 60);
  const cutoffMs = now.getTime() - windowMinutes * 60 * 1000;
  let recent = 0;

  for (const posted of Object.values(state.posted || {})) {
    if (posted?.source !== "samayomi_stub") continue;
    if (!isInsufficientSourceReason(posted.reason)) continue;
    const postedMs = Date.parse(posted.postedAt || "");
    if (Number.isFinite(postedMs) && postedMs >= cutoffMs) recent++;
  }

  const total = recent + insufficient.length;
  if (total > maxRecentFails) {
    throw new Error(
      `too many recent insufficient-source fail stubs (${total}/${maxRecentFails}) in ${windowMinutes} minutes; repair grounded reports or set PREMIUM_ALLOW_MASS_FAIL_STUBS=true for a deliberate manual override`
    );
  }
}

function isMassFailOverrideEnabled(opts = {}) {
  return opts["allow-mass-fail"] === true || /^(1|true|yes)$/i.test(env("PREMIUM_ALLOW_MASS_FAIL_STUBS"));
}

function isInsufficientSourceReason(reason) {
  return /insufficient\s+verified\s+sources/i.test(String(reason || ""));
}

function assertNoProceduralAnalysisLanguage(alertId, fieldMap) {
  const business = String(fieldMap.get("事業概要") || "");
  const businessPatterns = [
    /直近開示で示された事業領域を軸に/,
    /開示タイトルからは.*材料になります/,
    /売上成長と採算改善を確認する局面/
  ];
  if (businessPatterns.some(pattern => pattern.test(business))) {
    throw new Error(`report ${alertId} field 事業概要 is too generic: describe only the company's actual business, products, services, or customers`);
  }

  const fields = ["材料インパクト", "足元材料", "ファンダ要点", "注意点"];
  const proceduralPatterns = [
    /読み取れる結果は/,
    /今回の開示では[^。]*具体的に追います/,
    /これらのKPIが[^。]*どこに効くか[^。]*追います/,
    /売上成長、粗利率、営業利益率、資金繰りのどこに効くか/,
    /(?:どこ|どれ|いずれ|何)に(?:効く|影響する)か/,
    /(?:具体的に)?(?:追います|追っていきます|見ます|見ていきます|確認していきます)/,
    /(?:開示内容|今回の開示|当該材料)[^。]*(?:確認点|確認軸|見る必要があります)/,
    /(?:売上成長|利益率|資本政策|事業提携)[^。]*(?:どこ|どれ|いずれ)[^。]*(?:効く|影響)/,
    /確認対象です/,
    /確認する局面です/,
    /確認したい局面です/,
    /確認したい/,
    /確認する局面/,
    /見極めたい/,
    /見極めが必要/,
    /見たい/,
    /次回進捗待ちです/,
    /PDF本文と開示一覧で、当該材料の発生日と内容を確認しました/,
    /還元・成長施策の具体化が材料です/,
    /事業進捗と株主還元・財務影響を合わせて確認する局面/,
    /短期の期待だけでなく契約条件と進捗開示を確認したい局面/,
    /通期予想に対する達成度が確認軸/,
    /(?:確認|チェック|検証)(?:していく|する)(?:必要があります|局面です|対象です)/,
    /(?:材料|開示|決算|月次)[^。]*(?:を|で)(?:見ます|確認します)/,
    /見る必要があ(?:る|ります)/,
    /一時要因と本業採算のどちらが数値を動かしたかを分けて見る必要があります/
  ];

  for (const field of fields) {
    const value = String(fieldMap.get(field) || "");
    const hit = proceduralPatterns.find(pattern => pattern.test(value));
    if (hit) {
      throw new Error(`report ${alertId} field ${field} uses procedural placeholder language instead of analysis: ${hit}`);
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
    },
    {
      pattern: /(?:収益|収益性|業績|利益|売上|採算)[^。]*(?:左右|効きやすい|中心になる)/,
      reason: "business overview must describe only the business; put revenue drivers and KPIs in ファンダ要点"
    },
    {
      pattern: /(?:収益源|収益ドライバー|KPI|月次売上|来場者数|客単価|粗利率|稼働率|受注残|資金繰り|配当方針|自己株取得)/,
      reason: "business overview must not include revenue drivers, KPIs, margins, funding, or shareholder-return items"
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
  const links = extractMarkdownLinks(value);
  if (links.length > 8) {
    throw new Error(`report ${alertId} field 開示リンク has too many disclosure links (${links.length}); include only material links used in the analysis`);
  }
  for (const { label, url } of links) {
    if (!isDirectDisclosureLinkUrl(url)) {
      throw new Error(`report ${alertId} disclosure link must be a direct disclosure URL: ${label}`);
    }
    if (!isTimestampedDisclosureLabel(label)) {
      throw new Error(`report ${alertId} disclosure link label must be "YYYY-MM-DD 開示タイトル(hh:mm)": ${label}`);
    }
  }
}

function assertNarrativeMentionedDisclosuresAreLinked(alertId, fieldMap) {
  const disclosureText = String(fieldMap.get("開示リンク") || "");
  if (!hasUrl(disclosureText)) return;

  const narrativeText = ["足元材料", "ファンダ要点", "注意点"]
    .map(name => String(fieldMap.get(name) || ""))
    .join("\n");

  for (const title of extractQuotedDisclosureTitles(narrativeText)) {
    if (!isDisclosureLikeTitle(title)) continue;
    if (!looseTitleIncluded(disclosureText, title)) {
      throw new Error(`report ${alertId} mentions disclosure in narrative but omits it from 開示リンク: ${title}`);
    }
  }
}

function extractQuotedDisclosureTitles(text) {
  return [...String(text || "").matchAll(/「([^」]{12,180})」/g)]
    .map(match => normalizeSpaces(match[1]))
    .filter(Boolean);
}

function isDisclosureLikeTitle(title) {
  const text = String(title || "");
  return /お知らせ|決算|短信|説明資料|招集通知|電子提供|NOTICE|MATERIALS|Training Industry|トップ・トレーニング|配当|自己株|株式|制度|選出|開示|報告|計画|予想|差異|資料/.test(text);
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
  return isDirectDisclosureFileUrl(url) || isAllowedDisclosureDetailPageUrl(url);
}

function isAllowedDisclosureDetailPageUrl(url) {
  if (!isDisclosureDetailPageUrl(url)) return false;
  try {
    const host = new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, "");
    return host !== "irbank.net";
  } catch {
    return false;
  }
}

async function resolveIrbankPdfDisclosureLinks(report) {
  const fields = Array.isArray(report.fields) ? report.fields : [];
  const field = fields.find(item => String(item.name || "").trim() === "開示リンク");
  if (!field || !field.value || String(field.value).trim() === "開示リンク未確認") return report;
  field.value = await replaceMarkdownLinkUrls(field.value, async url => resolveIrbankDisclosurePdfUrl(url));
  field.value = await dropUnavailableIrbankPdfDisclosureLinks(field.value, report.alertId);
  return report;
}

async function dropUnavailableIrbankPdfDisclosureLinks(value, alertId = "") {
  const lines = String(value || "").split(/\r?\n/);
  const kept = [];
  let removed = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const link = extractFirstMarkdownLink(line);
    if (!link || !isIrbankPdfFileUrl(link.url)) {
      if (line) kept.push(line);
      continue;
    }

    const status = await fetchDisclosureHeadStatus(link.url);
    if (isUnavailableDisclosureStatus(status)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }

  if (removed && !kept.some(line => hasUrl(line))) {
    throw new Error(`report ${alertId || "unknown"} all f.irbank.net disclosure PDF links were unavailable`);
  }
  return kept.join("\n");
}

function isIrbankPdfFileUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return host === "f.irbank.net" && /^\/(?:pdf|pr)\/.+\.pdf$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function fetchDisclosureHeadStatus(url) {
  const key = String(url || "").trim();
  if (!disclosureHeadStatusByUrl.has(key)) {
    disclosureHeadStatusByUrl.set(key, (async () => {
      try {
        const response = await fetch(key, {
          method: "HEAD",
          signal: AbortSignal.timeout(10000)
        });
        return response.status;
      } catch {
        return 0;
      }
    })());
  }
  return disclosureHeadStatusByUrl.get(key);
}

function isUnavailableDisclosureStatus(status) {
  return [401, 403, 404, 410].includes(Number(status));
}

async function assertNoNewerIrbankDisclosureMiss(report, claim) {
  const symbolCode = String(report.symbolCode || claim?.symbolCode || "").trim();
  if (!symbolCode) return;

  const receivedAtMs = parseReceivedAtMs(report.receivedAt || claim?.receivedAt || "");
  const cutoffMs = receivedAtMs
    ? receivedAtMs - 45 * 24 * 60 * 60 * 1000
    : Date.now() - 45 * 24 * 60 * 60 * 1000;

  const candidates = await fetchDisclosureCandidatesForSymbol(symbolCode);

  assertNoNewerDisclosureCandidatesAccounted(report, claim, candidates, cutoffMs);
}

async function fetchDisclosureCandidatesForSymbol(symbolCode) {
  const code = String(symbolCode || "").trim();
  if (!disclosureCandidatesBySymbol.has(code)) {
    disclosureCandidatesBySymbol.set(code, (async () => {
      const irbank = await fetchIrbankDisclosureCandidates(code);
      const yahoo = await fetchYahooFinanceDisclosureCandidates(code);
      return dedupeDisclosureCandidates([...irbank, ...yahoo]);
    })());
  }
  return disclosureCandidatesBySymbol.get(code);
}

function assertNoNewerDisclosureCandidatesAccounted(report, claim, candidates, cutoffMs) {
  const alertId = String(report.alertId || "").trim();
  const symbolCode = String(report.symbolCode || claim?.symbolCode || "").trim();
  if (!symbolCode) return;

  const reviewedCandidates = dedupeDisclosureCandidates(candidates || [])
    .filter(item => item.disclosedAtMs >= cutoffMs)
    .sort((a, b) => b.disclosedAtMs - a.disclosedAtMs);

  if (!reviewedCandidates.length) return;

  const newest = reviewedCandidates[0];
  const sameTimeNewest = reviewedCandidates.filter(item => item.disclosedAtMs === newest.disclosedAtMs);

  const reportText = getReportAllText(report);
  const narrativeText = getReportNarrativeText(report);
  const disclosureText = getReportFieldValue(report, "開示リンク");

  const mentionedButUnlinked = reviewedCandidates.filter(item => {
    const titleMentioned = narrativeText.includes(item.title) || looseTitleIncluded(narrativeText, item.title);
    if (!titleMentioned) return false;
    const titleLinked = disclosureText.includes(item.title) || looseTitleIncluded(disclosureText, item.title);
    const urlLinked = disclosureText.includes(item.url) || disclosureText.includes(item.documentId);
    return !(titleLinked || urlLinked);
  });

  if (mentionedButUnlinked.length) {
    const list = mentionedButUnlinked.map(item => `${item.dateText} ${item.timeText || ""} ${item.title}`).join(" / ");
    throw new Error(
      `report ${alertId} mentions disclosure in narrative but omits it from 開示リンク: ${list}`
    );
  }

  const materialCandidates = reviewedCandidates.filter(isFundamentallyMaterialDisclosureCandidate);
  if (!materialCandidates.length) return;

  const newestMaterial = materialCandidates[0];
  const sameTimeNewestMaterial = materialCandidates.filter(item => item.disclosedAtMs === newestMaterial.disclosedAtMs);

  const missing = sameTimeNewestMaterial.filter(item => {
    if (isDisclosureCandidateAccountedInReport(item, reportText, disclosureText)) return false;
    if (isTranslatedMirrorDisclosureCandidate(item)) {
      const siblingAccounted = sameTimeNewestMaterial.some(peer => {
        if (peer === item) return false;
        if (isTranslatedMirrorDisclosureCandidate(peer)) return false;
        return isDisclosureCandidateAccountedInReport(peer, reportText, disclosureText);
      });
      if (siblingAccounted) return false;
    }
    return true;
  });

  if (missing.length) {
    const list = missing.map(item => {
      const source = item.sourceName ? ` [${item.sourceName}]` : "";
      return `${item.dateText} ${item.timeText || ""} ${item.title}${source}`;
    }).join(" / ");
    throw new Error(
      `report ${alertId} may be stale: newer disclosure exists for ${symbolCode} and must be read/accounted for: ${list}`
    );
  }

  const newestDateMs = startOfJstDateMs(newestMaterial.disclosedAtMs);
  const reportMaxDateMs = extractNewestDateMentionMs(reportText);

  if (reportMaxDateMs && reportMaxDateMs < newestDateMs) {
    throw new Error(
      `report ${alertId} uses an older disclosure while newer disclosure exists for ${symbolCode}: ${newestMaterial.dateText} ${newestMaterial.title}; read the newer disclosure and mention its effect or why older material remains primary`
    );
  }
}

function isDisclosureCandidateAccountedInReport(item, reportText, disclosureText) {
  const titleHit = reportText.includes(item.title) || looseTitleIncluded(reportText, item.title);
  const urlHit = disclosureText.includes(item.url) || disclosureText.includes(item.documentId);
  const dateHit = reportMentionsDisclosureDate(reportText, item);
  return (titleHit || urlHit) && dateHit;
}

function isTranslatedMirrorDisclosureCandidate(item) {
  const title = normalizeSpaces(String(item?.title || ""));
  if (!title) return false;
  if (!hasJapaneseText(title)) return true;
  return /Notice|Summary|Consolidated Financial|Financial Results|Announcement|Materials|Regarding/i.test(title);
}

function isFundamentallyMaterialDisclosureCandidate(item) {
  const title = normalizeSpaces(String(item?.title || ""));
  if (!title) return false;
  if (isRoutineAdministrativeDisclosureTitle(title)) return false;
  return true;
}

function isRoutineAdministrativeDisclosureTitle(title) {
  const text = normalizeSpaces(String(title || ""));
  if (!text) return false;

  if (/親会社等の決算に関するお知らせ|非上場の親会社等の決算情報に関するお知らせ|非上場の親会社等の決算に関するお知らせ/.test(text)) {
    return true;
  }
  if (/動画配信及び質疑応答のご案内|決算説明会動画配信|質疑応答のご案内/.test(text)) {
    return true;
  }
  if (/アナリストレポート公開|調査レポート|シェアードリサーチ|Shared Research/i.test(text)) {
    return true;
  }
  if (/譲渡制限付株式としての自己株式の処分|譲渡制限付株式報酬としての自己株式の?処分|譲渡制限付株式報酬としての新株式発行|株式報酬型ストックオプション|株式報酬.*制度|払込完了に関するお知らせ/.test(text)) {
    return true;
  }
  if (/^(?:定款の一部変更|定款一部変更|定款変更|定款\s)/.test(text)) {
    return true;
  }
  if (/取締役候補者の辞退|取締役候補者.*選任|取締役の役付変更|代表取締役及び役員の決定に関するお知らせ/.test(text)) {
    return true;
  }
  if (/取締役会の実効性に関する評価結果|取締役会.*実効性評価/.test(text)) {
    return true;
  }

  const materialGovernancePatterns = [
    /代表取締役|社長|CEO|CFO|監査法人|会計監査人|不適切|不正|調査委員会|訴訟|判決|行政処分|規制|上場維持|改善期間|特設注意|監理銘柄|整理銘柄|支配株主.*異動|主要株主.*異動|筆頭株主.*異動|親会社.*異動|支配株主.*変更|主要株主.*変更|筆頭株主.*変更|親会社.*変更|MBO|TOB|公開買付|資本政策|資本コスト|株価を意識|配当|自己株式取得|自己株式の取得|株主還元|新株|新株予約権|第三者割当|公募|売出|CB|社債|借入|資金調達|M&A|合併|会社分割|事業譲渡|事業譲受|子会社化|持分譲渡|固定資産|特別利益|特別損失|業績予想|月次|決算/
  ];
  if (materialGovernancePatterns.some(pattern => pattern.test(text))) return false;

  return [
    /コーポレート・ガバナンスに関する報告書/,
    /コーポレートガバナンスに関する報告書/,
    /Corporate Governance Report/i,
    /独立役員届出書/,
    /定時株主総会招集/,
    /定時株主総会資料/,
    /定時株主総会.*動画配信/,
    /質疑応答のご案内/,
    /電子提供措置事項/,
    /法令及び定款に基づく/,
    /組織変更及び人事異動/,
    /人事異動に関するお知らせ/,
    /人事の異動について/,
    /役員人事に関するお知らせ/,
    /当社及び子会社役員人事に関するお知らせ/,
    /役員候補者の選任に関するお知らせ/,
    /役員の異動に関するお知らせ/,
    /取締役.*体制に関するお知らせ/,
    /執行役員.*体制に関するお知らせ/,
    /譲渡制限付株式としての自己株式の処分/,
    /譲渡制限付株式報酬としての自己株式の処分/,
    /譲渡制限付株式報酬としての新株式発行/,
    /株式報酬型ストックオプション/,
    /払込完了に関するお知らせ/,
    /支配株主等(?:\([^)]*\))?に関する事項について/,
    /親会社等の決算に関するお知らせ/,
    /非上場の親会社等の決算情報に関するお知らせ/
  ].some(pattern => pattern.test(text));
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
  if (!isValidCalendarDate(year, month, day)) return null;

  const time = normalizeSpaces(stripHtml(titleText)).match(/(\d{1,2}):(\d{2})/);
  const hour = time ? Number(time[1]) : 0;
  const minute = time ? Number(time[2]) : 0;
  if (!isValidClockTime(hour, minute)) return null;
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
  if (!title || !isValidClockTime(hour, minute)) {
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

  if (!isValidCalendarDate(year, month, day)) {
    return { title: "", dateText: "", timeText: "", disclosedAtMs: 0 };
  }

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

function isValidCalendarDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return false;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isValidClockTime(hour, minute) {
  return Number.isInteger(hour) && Number.isInteger(minute) &&
    hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
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
    value.match(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/);

  if (!ymd) return { dateText: "", timeText: "", disclosedAtMs: 0 };

  const year = Number(ymd[1]);
  const month = Number(ymd[2]);
  const day = Number(ymd[3]);

  const time = value.match(/(\d{1,2}):(\d{2})/);
  const hour = time ? Number(time[1]) : 0;
  const minute = time ? Number(time[2]) : 0;

  if (!isValidCalendarDate(year, month, day) || !isValidClockTime(hour, minute)) {
    return { dateText: "", timeText: "", disclosedAtMs: 0 };
  }

  const disclosedAtMs = Date.UTC(year, month - 1, day, hour - 9, minute, 0);

  return {
    dateText: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    timeText: time ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : "",
    disclosedAtMs
  };
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

function getReportNarrativeText(report) {
  return (report.fields || [])
    .filter(field => ["足元材料", "ファンダ要点", "注意点"].includes(String(field.name || "").trim()))
    .map(field => `${field.name || ""}\n${field.value || ""}`)
    .join("\n");
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
    .normalize("NFKC")
    .replace(/[（(]\d{1,2}:\d{2}[）)]/g, "")
    .replace(/[ \t\r\n　]/g, "")
    .replace(/[【】「」『』（）()〔〕［］[\]・、，,.．:：/／\-‐‑–—]/g, "")
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
  if (!irbankDisclosurePdfByUrl.has(normalized)) {
    irbankDisclosurePdfByUrl.set(normalized, (async () => {
      try {
        const response = await fetch(normalized);
        if (!response.ok) return normalized;
        const html = await response.text();
        return extractIrbankPdfUrlFromHtml(html, extractIrbankDisclosureId(normalized)) || normalized;
      } catch {
        return normalized;
      }
    })());
  }
  return irbankDisclosurePdfByUrl.get(normalized);
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
    if (isCompanyDisclosureDetailPath(pathname)) return true;
  } catch {
    return false;
  }
  return false;
}

function isCompanyDisclosureDetailPath(pathname) {
  const text = String(pathname || "");
  if (/\.(?:css|js|png|jpe?g|gif|svg|webp|ico)(?:$|[?#])/i.test(text)) return false;
  if (/\/(?:ir|news|press|release|releases|resources|results|library)\/?$/i.test(text)) return false;
  if (/\/(?:ir|news|press|release|releases|resources|results|library)\.(?:html?|php|aspx)$/i.test(text)) return false;
  return /\/(?:ir|news|press|release|releases|resources)\//i.test(text);
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

function buildPremiumScanComponents(report = {}, claim = {}, embedUrl = "") {
  const chartUrl = normalizeTradingViewUrl(String(embedUrl || report.url || claim.tradingViewUrl || ""));
  const symbolCode = String(
    report.symbolCode ||
    claim.symbolCode ||
    extractSymbolCodeFromUrl(chartUrl || report.url || claim.tradingViewUrl || "")
  ).trim().toUpperCase();

  if (!/^\d{3,4}[A-Z]?$/.test(symbolCode)) return [];

  const components = [{
    type: DISCORD_COMPONENT_BUTTON,
    style: DISCORD_BUTTON_STYLE_SECONDARY,
    custom_id: `${PREMIUM_SCAN_BUTTON_PREFIX}${symbolCode}`,
    label: `🔍 ${symbolCode} をスキャンする`
  }];

  if (isTradingViewUrl(chartUrl)) {
    components.push({
      type: DISCORD_COMPONENT_BUTTON,
      style: DISCORD_BUTTON_STYLE_LINK,
      label: "📊 チャートを見る",
      url: chartUrl
    });
  }

  return [{
    type: DISCORD_COMPONENT_ACTION_ROW,
    components
  }];
}

function isTradingViewUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return /(^|\.)tradingview\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function hasInteractiveComponents(payload) {
  return Array.isArray(payload?.components) && payload.components.length > 0;
}

function toBotMessagePayload(payload) {
  const { username, avatar_url, ...messagePayload } = payload || {};
  return messagePayload;
}

function withoutComponents(payload) {
  const { components, ...fallbackPayload } = payload || {};
  return fallbackPayload;
}

async function postPremiumDiscord(payload, webhookUrl) {
  const botToken = env("DISCORD_PREMIUM_BOT_TOKEN") || env("DISCORD_BOT_TOKEN") || env("DISCORD_TOKEN");
  const hasButtons = hasInteractiveComponents(payload);

  if (hasButtons && botToken) {
    const channelId = env("DISCORD_PREMIUM_CHANNEL_ID") || await resolveWebhookChannelId(webhookUrl);
    if (channelId) return postDiscordBot(channelId, botToken, toBotMessagePayload(payload));
  }

  if (hasButtons) {
    console.warn("[premium] scan buttons were omitted because Discord bot token/channel configuration is missing");
  }
  return postDiscord(webhookUrl, withoutComponents(payload));
}

async function resolveWebhookChannelId(webhookUrl) {
  const explicit = env("DISCORD_PREMIUM_CHANNEL_ID");
  if (explicit) return explicit;
  if (!webhookUrl) return "";

  try {
    const response = await fetch(new URL(webhookUrl), {
      method: "GET",
      headers: { "User-Agent": "premium-alert-worker" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return "";
    const data = await response.json();
    return String(data.channel_id || "").trim();
  } catch {
    return "";
  }
}

async function postDiscordBot(channelId, botToken, payload) {
  const url = new URL(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bot ${botToken}`
      },
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
    throw new Error(`Discord bot post failed: HTTP ${response.status} ${body.slice(0, 500)}`);
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
  const reports = Array.isArray(data) ? data : (Array.isArray(data.reports) ? data.reports : null);
  if (reports) {
    assertNoRepeatedNarrativeTemplates(reports);
    assertReportSourceCoverage(reports);
    assertLargeBatchQualityFloor(reports);
    return reports;
  }
  throw new Error("report file must be an array or { reports: [...] }");
}

function assertReportSourceCoverage(reports) {
  const errors = [];
  for (const report of reports || []) {
    const symbol = String(report.symbolCode || report.alertId || "unknown");
    const alertId = String(report.alertId || symbol);
    const fields = fieldsToMap(report.fields || []);
    const sourceLinks = extractMarkdownLinks(fields.get("Sources") || "");
    const urls = sourceLinks.map(link => normalizeReferenceUrlForDuplicate(link.url)).filter(Boolean);
    const uniqueUrls = new Set(urls);

    if (urls.length < MIN_REFERENCE_SOURCE_URLS) {
      errors.push(
        `report ${alertId} field Sources must include at least ${MIN_REFERENCE_SOURCE_URLS} reference/listing URLs; ` +
        `use company IR plus IRBANK/Yahoo/TDnet-style listing pages, and keep direct disclosures in 開示リンク`
      );
    } else if (urls.length > MAX_REFERENCE_SOURCE_URLS) {
      errors.push(
        `report ${alertId} field Sources has too many URLs (${urls.length}); keep only ${MIN_REFERENCE_SOURCE_URLS}-${MAX_REFERENCE_SOURCE_URLS} reference/listing pages`
      );
    } else if (uniqueUrls.size !== urls.length) {
      errors.push(`report ${alertId} field Sources duplicates the same reference URL with different labels`);
    }
  }
  if (errors.length) {
    throw new Error(`report source coverage failed for ${errors.length} report(s):\n- ${errors.join("\n- ")}`);
  }
}

function normalizeReferenceUrlForDuplicate(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    const removableParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
    for (const key of removableParams) parsed.searchParams.delete(key);
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return String(url || "").trim().toLowerCase();
  }
}

function assertLargeBatchQualityFloor(reports) {
  const items = reports || [];
  if (items.length < LARGE_BATCH_QUALITY_MIN_REPORTS) return;

  const noDisclosure = [];
  const sparseFallback = [];
  const lengths = Object.fromEntries(Object.keys(LARGE_BATCH_AVG_LENGTH_MIN).map(name => [name, []]));

  for (const report of items) {
    const symbol = String(report.symbolCode || report.alertId || "unknown");
    const fields = fieldsToMap(report.fields || []);
    const disclosure = String(fields.get("開示リンク") || "").trim();
    if (!hasUrl(disclosure) || disclosure === "開示リンク未確認") noDisclosure.push(symbol);
    if (hasSparseDisclosureFallback(fields)) sparseFallback.push(symbol);

    for (const name of Object.keys(LARGE_BATCH_AVG_LENGTH_MIN)) {
      lengths[name].push(String(fields.get(name) || "").trim().length);
    }
  }

  const maxNoDisclosure = Math.max(2, Math.ceil(items.length * LARGE_BATCH_MAX_NO_DISCLOSURE_RATIO));
  if (noDisclosure.length > maxNoDisclosure) {
    throw new Error(
      `large premium batch has too many reports without direct 開示リンク (${noDisclosure.length}/${items.length}); ` +
      `repair source coverage before posting. examples=${noDisclosure.slice(0, 8).join(", ")}`
    );
  }

  const maxSparse = Math.max(3, Math.ceil(items.length * LARGE_BATCH_MAX_SPARSE_RATIO));
  if (sparseFallback.length > maxSparse) {
    throw new Error(
      `large premium batch has too many sparse-disclosure fallback reports (${sparseFallback.length}/${items.length}); ` +
      `re-scan official IR/IRBANK/TDnet-style lists and use grounded materials where available. examples=${sparseFallback.slice(0, 8).join(", ")}`
    );
  }

  for (const [fieldName, minAverage] of Object.entries(LARGE_BATCH_AVG_LENGTH_MIN)) {
    const values = lengths[fieldName] || [];
    const average = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    if (average < minAverage) {
      throw new Error(
        `large premium batch field ${fieldName} average length is too terse (${average.toFixed(1)} chars); ` +
        `large batches must preserve company-specific analysis quality`
      );
    }
  }
}

function assertNoRepeatedNarrativeTemplates(reports) {
  const narrativeFields = ["足元材料", "ファンダ要点", "注意点"];
  const genericTemplatePatterns = [
    /決算・還元・提携などが収益性、資本効率、事業進捗へ与える実質影響が焦点/,
    /株主還元や資本効率方針はROE、PBR、総還元性向/,
    /決算開示では売上高、営業利益、粗利率、受注・販売数量/,
    /月次データは稼働人数、稼働率、既存店・販売数量/,
    /提携・M&A・資産関連の材料は、売上貢献時期、利益率、資金負担/,
    /還元策は短期的な需給支えになります/
  ];

  const seen = new Map();
  const narrativeFieldsForTemplateCheck = [...new Set([IMPACT_FIELD, ...narrativeFields])];
  const repeatedSentenceBuckets = new Map();
  for (const report of reports || []) {
    const symbol = String(report.symbolCode || report.alertId || "unknown");
    for (const fieldName of narrativeFieldsForTemplateCheck) {
      const value = String((report.fields || []).find(field => field.name === fieldName)?.value || "").trim();
      if (!value) continue;
      const genericHit = genericTemplatePatterns.find(pattern => pattern.test(value));
      if (genericHit) {
        throw new Error(`report ${report.alertId || symbol} field ${fieldName} uses a generic repeated template: ${genericHit}`);
      }
      if (value.length < 40) continue;
      const key = `${fieldName}\n${value}`;
      const previous = seen.get(key);
      if (previous) {
        throw new Error(`reports ${previous} and ${symbol} reuse the same ${fieldName}; write company-specific analysis`);
      }
      seen.set(key, symbol);
      for (const sentenceKey of normalizeNarrativeTemplateSentences(value, report)) {
        const bucketKey = `${fieldName}\n${sentenceKey}`;
        const bucket = repeatedSentenceBuckets.get(bucketKey) || { fieldName, symbols: [] };
        if (!bucket.symbols.includes(symbol)) bucket.symbols.push(symbol);
        repeatedSentenceBuckets.set(bucketKey, bucket);
      }
    }
  }
  assertNoOverusedNarrativeSentences(repeatedSentenceBuckets, reports);
}

function normalizeNarrativeTemplateSentences(value, report = {}) {
  const text = normalizeSpaces(value);
  if (!text) return [];

  const symbolName = String(report.symbolName || "").trim();
  const symbolCode = String(report.symbolCode || "").trim();
  const splitPattern = new RegExp(`[${String.fromCharCode(0x3002)}.!?]+`);
  const datePattern = new RegExp(`[0-9]{1,2}${String.fromCharCode(0x6708)}[0-9]{1,2}${String.fromCharCode(0x65e5)}`, "g");
  const quotePattern = new RegExp(`${String.fromCharCode(0x300c)}[^${String.fromCharCode(0x300d)}]+${String.fromCharCode(0x300d)}`, "g");
  const items = [];

  for (const rawSentence of text.split(splitPattern)) {
    let sentence = normalizeSpaces(rawSentence);
    if (sentence.length < 24) continue;
    sentence = sentence
      .replace(/\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/g, "<LINK>")
      .replace(/https?:\/\/\S+/g, "<URL>")
      .replace(datePattern, "<DATE>")
      .replace(quotePattern, "<TITLE>")
      .replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>")
      .replace(/[A-Za-z0-9_.()\-:,/ ]{8,}/g, "<TOKEN>");
    if (symbolName) sentence = sentence.replace(new RegExp(escapeRegExp(symbolName), "g"), "<NAME>");
    if (symbolCode) sentence = sentence.replace(new RegExp(escapeRegExp(symbolCode), "g"), "<CODE>");
    sentence = normalizeSpaces(sentence);
    if (sentence.length >= 24 && /[\u3040-\u30ff\u3400-\u9fff]/.test(sentence)) items.push(sentence);
  }

  return [...new Set(items)];
}

function assertNoOverusedNarrativeSentences(buckets, reports) {
  const threshold = 3;
  for (const bucket of buckets.values()) {
    if (bucket.symbols.length < threshold) continue;
    throw new Error(
      `reports reuse the same normalized narrative sentence in ${bucket.fieldName} across ${bucket.symbols.length} symbols; ` +
      `write company-specific analysis. examples=${bucket.symbols.slice(0, 8).join(", ")}`
    );
  }
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  return symbol ? `https://jp.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}` : "";
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
    url.hostname = "jp.tradingview.com";
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
  assert.equal(buildTradingViewUrl("TYO:7203"), "https://jp.tradingview.com/chart/?symbol=TSE%3A7203");
  assert.equal(buildTradingViewUrl("TSE:8285"), "https://jp.tradingview.com/chart/?symbol=TSE%3A8285");
  assert.equal(
    normalizeTitleForCompare("2026年４月度 月次売上概況"),
    normalizeTitleForCompare("2026年4月度月次売上概況")
  );
  assert.equal(
    normalizeTitleForCompare("2026年12月期 第１四半期決算説明資料"),
    normalizeTitleForCompare("2026年12月期第1四半期決算説明資料")
  );
  assert.equal(
    normalizeTitleForCompare("第１四半期決算説明動画公開のお知らせ（17:00）"),
    normalizeTitleForCompare("第1四半期決算説明動画公開のお知らせ")
  );
  const embed = buildEmbed({
    alertId: "a1",
    title: "テスト（1234）｜Premium Snapshot",
    url: "https://jp.tradingview.com/chart/?symbol=TYO%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "ポジティブ材料: 会社開示で売上と営業利益の増加が確認でき、受注環境も改善している。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "直近決算では売上と利益の推移が確認材料。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差が材料です。継続性が利益評価を左右します。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善継続が評価を左右します。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  });
  assert.equal(embed.title, "テスト (1234) | TradingView チャート");
  assert.equal(embed.url, "https://jp.tradingview.com/chart/?symbol=TSE%3A1234");
  assert.equal(embed.color, 0x2E7D32);
  assert.equal(embed.fields[0].name, "材料インパクト");
  assert.equal(embed.fields.find(f => f.name === "開示リンク").value, "開示リンク未確認");
  const claimHydratedEmbed = buildEmbed(hydrateReportWithClaim({
    alertId: "claim-title",
    symbolCode: "4321",
    fields: embed.fields
  }, {
    symbolCode: "4321",
    symbolName: "ClaimName",
    tradingViewUrl: "https://jp.tradingview.com/chart/?symbol=TSE%3A4321"
  }));
  assert.equal(claimHydratedEmbed.title.startsWith("ClaimName (4321) | TradingView"), true);
  assert.notEqual(claimHydratedEmbed.title, "Premium Snapshot");
  assert.equal(claimHydratedEmbed.url, "https://jp.tradingview.com/chart/?symbol=TSE%3A4321");
  assert.deepEqual(sortReportsByImpact([
    { alertId: "n", materialImpact: "ネガティブ材料" },
    { alertId: "p", materialImpact: "ポジティブ材料" },
    { alertId: "w", materialImpact: "様子見" }
  ]).map(report => report.alertId), ["p", "w", "n"]);
  const sourceField = symbolCode => ({
    name: "Sources",
    value: `[IRBANK テスト${symbolCode} 開示一覧](https://irbank.net/${symbolCode}/ir)\n[Yahoo!ファイナンス テスト${symbolCode} 適時開示一覧](https://finance.yahoo.co.jp/quote/${symbolCode}.T/disclosure)`
  });
  const disclosureField = symbolCode => ({
    name: "開示リンク",
    value: `[2026-05-08 決算短信に関するお知らせ(15:00)](https://f.irbank.net/pdf/20260508/14012026050852${String(symbolCode).padStart(4, "0")}.pdf)`
  });
  assert.throws(() => normalizeReports({ reports: [
    {
      alertId: "source-single",
      symbolCode: "1111",
      fields: [
        { name: "Sources", value: "[IRBANK テスト1111 開示一覧](https://irbank.net/1111/ir)" }
      ]
    }
  ] }), /Sources must include at least 2 reference/);
  assert.throws(() => normalizeReports({ reports: [
    {
      alertId: "source-duplicate",
      symbolCode: "1111",
      fields: [
        { name: "Sources", value: "[IRBANK テスト1111 開示一覧](https://irbank.net/1111/ir)\n[別ラベル](https://irbank.net/1111/ir/)" }
      ]
    }
  ] }), /Sources duplicates the same reference URL/);
  assert.throws(() => normalizeReports({ reports: [
    {
      alertId: "source-batch-a",
      symbolCode: "1111",
      fields: [{ name: "Sources", value: "[IRBANK A](https://irbank.net/1111/ir)" }]
    },
    {
      alertId: "source-batch-b",
      symbolCode: "2222",
      fields: [{ name: "Sources", value: "[IRBANK B](https://irbank.net/2222/ir)" }]
    }
  ] }), error => {
    assert.match(error.message, /source-batch-a/);
    assert.match(error.message, /source-batch-b/);
    return true;
  });
  const localPreflightErrors = collectDryRunLocalValidationErrors([
    { alertId: "preflight-a", fields: [{ name: "Sources", value: "missing" }] },
    { alertId: "preflight-b", fields: [{ name: "Sources", value: "missing" }] }
  ], {
    posted: {},
    claims: {
      "preflight-a": { claimId: "claim-a" },
      "preflight-b": { claimId: "claim-b" }
    }
  });
  assert.deepEqual(localPreflightErrors.map(item => item.alertId), ["preflight-a", "preflight-b"]);
  const localPreflightMessage = formatDryRunValidationErrors("dry-run local preflight", localPreflightErrors);
  assert.match(localPreflightMessage, /preflight-a/);
  assert.match(localPreflightMessage, /preflight-b/);
  assert.deepEqual(collectDryRunLocalValidationErrors([
    {
      alertId: "preflight-irbank-detail",
      fields: [{
        name: "開示リンク",
        value: "[2026-05-08 決算短信(15:00)](https://irbank.net/1234/140120260508521234)"
      }]
    }
  ], {
    posted: {},
    claims: { "preflight-irbank-detail": { claimId: "claim-detail" } }
  }), []);
  assert.throws(() => normalizeReports({ reports: Array.from({ length: 10 }, (_, index) => {
    const symbolCode = String(4100 + index);
    return {
      alertId: `large-no-disclosure-${symbolCode}`,
      symbolCode,
      fields: [
        sourceField(symbolCode),
        { name: "開示リンク", value: "開示リンク未確認" }
      ]
    };
  }) }), /too many reports without direct 開示リンク/);
  assert.throws(() => normalizeReports({ reports: Array.from({ length: 10 }, (_, index) => {
    const symbolCode = String(4200 + index);
    return {
      alertId: `large-terse-${symbolCode}`,
      symbolCode,
      fields: [
        sourceField(symbolCode),
        disclosureField(symbolCode),
        { name: "足元材料", value: `5月${index + 1}日の開示は売上確認材料です。` },
        { name: "ファンダ要点", value: `受注と利益率が重要です。${index}` },
        { name: "注意点", value: `費用増がリスクです。${index}` }
      ]
    };
  }) }), /average length is too terse/);
  assert.throws(() => normalizeReports({ reports: [
    { alertId: "dup1", symbolCode: "1111", fields: [{ name: "ファンダ要点", value: "株主還元や資本効率方針はROE、PBR、総還元性向、手元資金の配分を左右します。本業利益の伸びを伴う還元なら評価しやすい一方、利益が弱い局面では持続性が焦点です。" }] },
    { alertId: "dup2", symbolCode: "2222", fields: [{ name: "ファンダ要点", value: "株主還元や資本効率方針はROE、PBR、総還元性向、手元資金の配分を左右します。本業利益の伸びを伴う還元なら評価しやすい一方、利益が弱い局面では持続性が焦点です。" }] }
  ] }), /generic repeated template|reuse the same/);
  const repeatedTemplateReports = ["1111", "2222", "3333"].map((symbolCode, index) => ({
    alertId: `template-${symbolCode}`,
    symbolCode,
    symbolName: `テスト${symbolCode}`,
    fields: [{
      name: REQUIRED_FIELDS[2],
      value: `テスト${symbolCode}では、今回の材料は単発の開示タイトルだけでなく、次回決算で営業利益率、資金残高、受注・顧客指標に残るかで評価が変わります。追加確認${index}は銘柄ごとに別の補足です。`
    }]
  }));
  assert.throws(() => normalizeReports({ reports: repeatedTemplateReports }), /same normalized narrative sentence/);
  const largeBatchTemplateReports = Array.from({ length: 100 }, (_, index) => {
    const symbolCode = String(3000 + index);
    const repeated = index < 3
      ? "今回の材料は単発の開示タイトルだけでなく、次回決算で営業利益率、資金残高、受注・顧客指標に残るかで評価が変わります。"
      : `個別材料${index}は受注単価、利益率、資金繰りへの波及がそれぞれ異なるため、銘柄固有に評価します。`;
    return {
      alertId: `large-template-${symbolCode}`,
      symbolCode,
      symbolName: `大型テスト${symbolCode}`,
      fields: [{ name: REQUIRED_FIELDS[2], value: `大型テスト${symbolCode}では、${repeated}` }]
    };
  });
  assert.throws(() => normalizeReports({ reports: largeBatchTemplateReports }), /same normalized narrative sentence/);
  assert.throws(() => buildEmbed({
    alertId: "monthly-no-metrics",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "様子見：月次は需要を示すが、店舗採算と粗利率への波及はまだ限定的です。" },
      { name: "事業概要", value: "衣料品、服飾雑貨、生活雑貨を自社店舗とECサイトで販売し、国内外の複数ブランドを運営する小売企業です。" },
      { name: "足元材料", value: "5月14日の月次売上は店舗需要の方向感を示す材料です。店舗とECの動きが分かれたという説明だけでは足りず、在庫回転、値引き率、粗利率へどう波及したかを本文で扱う必要があります。" },
      { name: "ファンダ要点", value: "店舗客数、EC比率、在庫回転、値引き率が重要です。月次の強弱を扱う場合は、実店舗、EC、既存店、全店を分けて、売上増減が粗利率と固定費吸収へどう残るかまで具体化します。" },
      { name: "注意点", value: "月次だけでは販管費や在庫評価は分かりません。休日要因、セール比率、前年水準の反動、店舗改装の影響で売上の見え方が変わるため、タイトルだけの強弱判定は誤りになります。" },
      { name: "開示リンク", value: "[2026-05-14 月次売上速報に関するお知らせ(15:00)](https://example.com/monthly.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /without actual monthly metrics/);
  assert.throws(() => buildEmbed({
    alertId: "generic-disclosure-impact-template",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "様子見：契約開示は受注拡大の入口だが、導入単価と粗利率への寄与はまだ限定的です。" },
      { name: "事業概要", value: "法人向けクラウドサービスを提供し、業務支援ソフトと関連サポートを展開する会社です。" },
      { name: "足元材料", value: "5月14日の新規契約開示は、大口顧客への導入が始まったことを示します。同期間の追加開示も踏まえると、法人向けクラウドサービスの顧客獲得、稼働人員、契約単価、解約率へのつながりが焦点です。" },
      { name: "ファンダ要点", value: "法人向けクラウドサービスでは、導入社数、ARPU、解約率、サポート人員の稼働が重要です。今回の開示は、法人向けクラウドサービスの顧客獲得効率、稼働率、単価改善、継続契約の積み上げに効くかで評価が変わります。収益寄与が単発なら限定的ですが、導入社数とARPUに残れば業績の下支えになります。" },
      { name: "注意点", value: "開示後の数値で法人向けクラウドサービスの成約件数、稼働率、顧客単価、広告費率が崩れる場合は材料の見え方が弱まります。" },
      { name: "開示リンク", value: "[2026-05-14 新規契約に関するお知らせ(15:00)](https://example.com/contract.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /too generic/);
  assert.throws(() => buildEmbed({
    alertId: "a2",
    fields: REQUIRED_FIELDS.map(name => ({ name, value: name === "Sources" ? "no source" : "x" }))
  }), /Sources/);
  assert.throws(() => buildEmbed({
    alertId: "symbol-code-caution",
    title: "テスト（1234）｜Premium Snapshot",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "様子見：会社開示は売上への寄与がまだ限定的で、受注と粗利率の継続確認が必要です。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "直近決算では売上と利益の推移が確認材料。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差が材料です。継続性が利益評価を左右します。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善継続が評価を左右します。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "1234では需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。短期の株価材料と中期の業績改善は分けて確認する。" },
      { name: "開示リンク", value: "開示リンク未確認" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  }), /field 注意点 must not start with the symbol code/);
  assert.throws(() => buildEmbed({
    alertId: "impact-date-style",
    title: "テスト（1234）｜Premium Snapshot",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "様子見：2026-05-08の会社開示は売上への寄与がまだ限定的で、受注と粗利率の継続確認が必要です。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "5月8日に決算と通期計画を開示しました。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差が材料です。数量増と価格転嫁の継続性が利益評価を左右します。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善継続が評価を左右します。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。短期の株価材料と中期の業績改善は分けて確認する。" },
      { name: "開示リンク", value: "開示リンク未確認" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  }), /field 材料インパクト should omit calendar dates/);
  assert.throws(() => buildEmbed({
    alertId: "current-material-date-style",
    title: "テスト（1234）｜Premium Snapshot",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "様子見：会社開示は売上への寄与がまだ限定的で、受注と粗利率の継続確認が必要です。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "2026-05-08に決算と通期計画を開示しました。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差が材料です。数量増と価格転嫁の継続性が利益評価を左右します。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善継続が評価を左右します。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。短期の株価材料と中期の業績改善は分けて確認する。" },
      { name: "開示リンク", value: "開示リンク未確認" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  }), /field 足元材料 should use M月D日 style/);
  assert.throws(() => buildEmbed({
    alertId: "a3",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
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
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "直近決算では売上と利益の推移が確認材料。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差が材料です。継続性が利益評価を左右します。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善継続が評価を左右します。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "[2026-04-30 業績予想修正に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[出典1](https://example.com/ir)" }
    ]
  }), /non-descriptive link label/);
  assert.throws(() => buildEmbed({
    alertId: "a4b",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "公式IR/IRBANKを45日分確認したが、直近の個別開示は見当たらず、確認できる開示は限定的。2026年4月30日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。" },
      { name: "ファンダ要点", value: "業績予想修正は本業の採算改善と一過性要因を分けた評価になります。利益率、受注残、キャッシュフローの改善継続と会社計画との進捗差が重要で、在庫水準と資金繰りも利益評価を左右します。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "[2026-04-30 業績予想修正に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  }), /research-log caveat/);
  assert.throws(() => buildEmbed({
    alertId: "a4bb",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "医療機関向けソフトを提供するIT企業で、病院・診療所向けの業務支援ソフトと関連クラウドサービスを展開しています。" },
      { name: "足元材料", value: "2026-04-01に「子会社化完了に関するお知らせ」、「新製品提供開始に関するお知らせ」も確認。医療ITの製品ライン拡充とM&Aが同日に進み、導入施設数と保守収入の拡大が確認点になる。" },
      { name: "ファンダ要点", value: "医療ITでは導入施設数、保守・クラウド利用料、解約率、開発人員の稼働率が重要。買収子会社の売上・利益貢献と新製品の導入ペースが重要です。既存レセプト点検ソフトとのクロスセル余地も評価材料です。" },
      { name: "注意点", value: "M&Aは統合費用、既存製品との重複、医療機関への導入期間がリスクになる。販売開始後の契約件数と単価が収益化を左右します。" },
      { name: "開示リンク", value: "[2026-04-01 子会社化完了に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /mentions disclosure in narrative but omits it from 開示リンク/);
  assert.throws(() => buildEmbed({
    alertId: "a4c",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "ポジティブ材料：業績予想修正で利益進捗が改善し、受注残と採算改善が評価材料。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "2026年4月30日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。在庫水準と資金繰りも含めて、利益率、受注残、キャッシュフローの改善継続が本業評価を左右します。" },
      { name: "ファンダ要点", value: "在庫水準と資金繰りも含めて、利益率、受注残、キャッシュフローの改善継続が本業評価を左右します。会社予想との進捗差、在庫、資金繰りも重要になり、一過性利益と本業採算の切り分けが重要です。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "[2026-04-30 業績予想修正に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  }), /repeats the same long sentence/);
  assert.throws(() => buildEmbed({
    alertId: "a4d",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "テスト（1234）は、開示資料で確認できる主要サービス・製品を中心に事業を展開する上場企業です。直近の材料は、売上成長、利益率、資本政策、事業提携のどれに効くかを分けて見る必要があります。" },
      { name: "足元材料", value: "2026年4月10日の適時開示で新しい契約を確認しました。IRBANKの開示一覧でも45日前後の新しい材料として追えるため、事業進捗、業績変化、資本政策のいずれに影響するかが確認点です。" },
      { name: "ファンダ要点", value: "ファンダ面では、この開示が継続収益の拡大、一過性損益、資金調達、提携・M&Aのどれに分類されるかが重要です。売上、営業利益、現金収支への反映が未確定です。" },
      { name: "注意点", value: "開示単体では金額、契約期間、希薄化、一過性の区別が十分に読み切れない場合があります。売買判断ではなく、追加IRと決算資料で実際の収益貢献を確認する前提です。" },
      { name: "開示リンク", value: "[2026-04-10 新規契約締結に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /too generic/);
  assert.throws(() => buildEmbed({
    alertId: "a4e",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "店舗向けクラウド在庫管理を提供するSaaS企業で、小売店向けの在庫管理機能と関連クラウドサービスを展開しています。" },
      { name: "足元材料", value: "2026年4月10日に大手小売チェーンへの新規導入を開示し、導入店舗数の拡大がARR増加につながるかが確認材料になっている。既存顧客への追加機能販売も評価材料です。" },
      { name: "ファンダ要点", value: "ファンダ面では、この開示が継続収益の拡大、一過性損益、資金調達、提携・M&Aのどれに分類されるかが重要です。売上、営業利益、現金収支への反映が未確定です。" },
      { name: "注意点", value: "導入店舗数が増えても初期費用中心だとARRへの寄与は限定的になる。小売チェーン内の展開率、月額単価、解約率の開示が次の確認点。" },
      { name: "開示リンク", value: "[2026-04-10 大手小売チェーンへの新規導入に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /ファンダ要点 is too generic/);
  assert.throws(() => buildEmbed({
    alertId: "a4f",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A441A",
    symbolCode: "441A",
    symbolName: "NE",
    fields: [
      { name: "事業概要", value: "NE（441A）は、開示資料で確認できる主要サービス・製品を中心に事業を展開する上場企業です。直近の材料は、売上成長、利益率、資本政策、事業提携のどれに効くかを分けて見る必要があります。" },
      { name: "足元材料", value: "2026年4月17日に業務提携を開示し、EC支援サービスの連携先拡大が利用店舗数と追加機能利用につながるかが確認材料になる。株主優待だけでなく本業KPIへの接続は未確定です。" },
      { name: "ファンダ要点", value: "EC支援SaaSでは利用店舗数、解約率、ARPU、連携サービス経由の取扱量が収益の見方になる。提携は新規顧客獲得と既存顧客単価のどちらに効くかで評価が分かれます。" },
      { name: "注意点", value: "提携は基本合意段階だと収益化時期と契約条件が読みづらい。導入社数、手数料率、開発負担、既存顧客への追加販売率が次の確認点になる。" },
      { name: "開示リンク", value: "[2026-04-17 Cafe24 Corp.との業務提携に関する基本合意書の締結に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[NE IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /事業概要 is too generic/);
  assert.throws(() => buildEmbed({
    alertId: "a5",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "直近決算では売上と利益の推移が確認材料。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差が材料です。継続性が利益評価を左右します。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善継続が評価を左右します。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "[2026-04-30 業績予想修正に関するお知らせ(15:00)](https://example.com/disclosure)" },
      { name: "Sources", value: "[株主・投資家情報｜テスト株式会社](https://example.com/ir)" }
    ]
  }), /direct disclosure URL/);
  assert.throws(() => buildEmbed({
    alertId: "a6",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "直近決算では売上と利益の推移が確認材料。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差が材料です。継続性が利益評価を左右します。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善継続が評価を左右します。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "[2026-04-30 業績予想修正に関するお知らせ(15:00)](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[業績予想修正に関するお知らせ](https://example.com/disclosure.pdf)" }
    ]
  }), /source link must be a reference\/listing page URL/);
  assert.throws(() => buildEmbed({
    alertId: "a8",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "同日付近の業績修正や決算短信の直リンクは確認できず、会社概要と株式情報を参照した。非決算のIR開示がないかは別途確認が必要であり、この表現は公式IR一覧の確認不足を招くため使用しない。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善継続が評価を左右します。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "開示リンク未確認" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /too narrowly scoped/);
  assert.throws(() => buildEmbed({
    alertId: "a9",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "通信販売と法人向けサービスを扱う小売企業で、カタログ通販、EC、法人向け販売サービスを展開しています。" },
      { name: "足元材料", value: "2025年度決算説明資料を確認し、株主・投資家情報や事業内容ページもSourcesで参照。株主還元方針変更、優待廃止、再建計画など、収益改善と株主政策が同時に確認材料になっている。" },
      { name: "ファンダ要点", value: "黒字化計画は重要な材料だが、小売事業では在庫回転、粗利率、広告費、物流費の改善が伴う必要がある。既存顧客基盤を活かした再成長の進捗が評価材料です。" },
      { name: "注意点", value: "カタログやEC需要の鈍化、在庫評価、物流費、広告費、構造改革費用に注意。還元方針変更は短期需給に影響しやすく、本業改善とは分けた評価になります。" },
      { name: "開示リンク", value: "[2025-05-15 2025年度 決算説明資料(15:00)](https://example.com/2025_presentation.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /may be stale/);
  assert.throws(() => buildEmbed({
    alertId: "a10",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "施設向けサービスを提供する企業で、導入施設向けの継続利用サービスと関連運営支援を展開しています。" },
      { name: "足元材料", value: "2026年5月1日に第1四半期決算関連資料が開示され、売上成長と利益進捗、サービス導入数の推移が確認材料になっている。古い有価証券報告書だけでは足元材料として不十分。" },
      { name: "ファンダ要点", value: "継続課金型の事業は安定性がある一方、導入施設数、利用率、単価、配送・洗濯・人件費が利益率を左右する。四半期進捗と通期計画との差が評価材料です。" },
      { name: "注意点", value: "制度変更、施設稼働、物流費、人件費、競合サービスの影響に注意。売上成長が続いてもコスト増で利益率が鈍る可能性がある。" },
      { name: "開示リンク", value: "[2025-06-27 有価証券報告書 第29期(15:00)](https://example.com/securities.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /stale\/proxy document/);
  const sparseDisclosureEmbed = buildEmbed({
    alertId: "a10b",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "様子見：直近45日内の新しい個別材料が乏しく、次回開示待ちの状態。" },
      { name: "事業概要", value: "単一領域のサービスを展開する企業で、法人・個人向けに専門サービスと関連サポートを提供しています。" },
      { name: "足元材料", value: "確認できる新しい個別材料は乏しく、古い公式資料で事業構成、収益源、リスク要因だけを補助しています。新規材料としては扱いにくく、足元の進捗は未確定です。" },
      { name: "ファンダ要点", value: "新しい個別材料が乏しいため、足元の評価は保留気味。既存事業の継続性、利益率、資金繰り、固定費の吸収状況、受注や契約数の変化、次回決算での進捗確認が重要になる。" },
      { name: "注意点", value: "公式IR/IRBANKを45日分確認したが、直近の個別開示は見当たらず、確認できる開示は限定的。古い資料だけで短期材料を強く評価せず、足元の裏付けはまだ限定的です。" },
      { name: "開示リンク", value: "[2025-06-27 有価証券報告書 第29期(15:00)](https://example.com/securities.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)\n[テスト株式会社 会社概要](https://example.com/company)" }
    ]
  });
  assert.equal(sparseDisclosureEmbed.fields.some(field => field.name === "開示リンク"), true);
  assert.throws(() => buildEmbed({
    alertId: "a10c",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "2026年5月14日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。利益率、受注残、キャッシュフローの改善継続が本業評価を左右します。" },
      { name: "ファンダ要点", value: "販売数量、価格転嫁、固定費吸収、在庫水準が利益率の確認点になる。会社予想との進捗差や資金繰りも重要で、一過性利益と本業採算の切り分けが重要です。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://example.com/20260514534210.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /材料インパクト/);
  assert.throws(() => buildEmbed({
    alertId: "a10c2",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "ネガティブ材料" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "2026年5月14日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。利益率、受注残、キャッシュフローの改善継続が本業評価を左右します。" },
      { name: "ファンダ要点", value: "販売数量、価格転嫁、固定費吸収、在庫水準が利益率の確認点になる。会社予想との進捗差や資金繰りも重要で、一過性利益と本業採算の切り分けが重要です。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://example.com/20260514534210.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /bare label/);
  assert.throws(() => buildEmbed({
    alertId: "a10c3",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "ポジティブ材料：2026年5月14日の業績予想修正で売上高、営業利益、経常利益、純利益の計画が引き上がり、販売数量、価格転嫁、固定費吸収、在庫水準、資金繰り、営業CF改善まで確認材料が広がっている。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "2026年5月14日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。利益率、受注残、キャッシュフローの改善継続が本業評価を左右します。" },
      { name: "ファンダ要点", value: "販売数量、価格転嫁、固定費吸収、在庫水準が利益率の確認点になる。会社予想との進捗差や資金繰りも重要で、一過性利益と本業採算の切り分けが重要です。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://example.com/20260514534210.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /under 90 chars/);
  assert.throws(() => buildEmbed({
    alertId: "a10c4",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "混在/要確認：PDF本文でも主要損益項目を確認し、次回開示で確認する局面。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "2026年5月14日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。利益率、受注残、キャッシュフローの改善継続が本業評価を左右します。" },
      { name: "ファンダ要点", value: "販売数量、価格転嫁、固定費吸収、在庫水準が利益率の確認点になる。会社予想との進捗差や資金繰りも重要で、一過性利益と本業採算の切り分けが重要です。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://example.com/20260514534210.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /procedural placeholder language|too procedural/);
  assert.throws(() => assertConciseMaterialImpact(
    "a10c4awkward",
    "ポジティブ材料：2026-05-12開示は2026年3月期決算説明資料、中期経営計画の数値目標の見直しに関するを含み、還元や事業進捗の支えになる。"
  ), /awkward Japanese/);
  assert.throws(() => assertConciseMaterialImpact(
    "a10c4weak",
    "ポジティブ材料：2026-05-12の決算説明資料と中計見直しで、仮設機材事業の収益改善が支えです。"
  ), /too vague/);
  assert.throws(() => buildEmbed({
    alertId: "a10c4b",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "様子見：月次売上105.0%と決算で需要は追えるが、成約単価と利益率の改善は限定的。" },
      { name: "事業概要", value: "専門職向け人材紹介と求人広告を手掛ける人材サービス企業で、企業向け採用支援と求職者向け転職支援を提供しています。" },
      { name: "足元材料", value: "2026年5月14日に第1四半期決算と月次売上105.0%を開示し、採用需要の強弱を同時に確認できる材料になっています。月次売上は堅調でも、紹介成約の単価と粗利率が伸びなければ営業利益への寄与は限定的です。" },
      { name: "ファンダ要点", value: "月次売上105.0%、国内人材紹介の成約数、コンサルタント生産性、求人単価、海外売上がKPIです。1Q決算と月次は採用需要の強弱を同時に示します。今回の開示では、これらのKPIが売上成長、粗利率、営業利益率、資金繰りのどこに効くかを具体的に追います。" },
      { name: "注意点", value: "求人需要が鈍ると成約数と単価が同時に下がり、人件費と広告費の固定負担が利益率を圧迫します。海外売上が伸びても国内紹介の採算が弱い場合は利益改善が遅れます。" },
      { name: "開示リンク", value: "[2026-05-14 第1四半期決算短信(15:30)](https://example.com/20260514.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /procedural placeholder language/);
  assert.throws(() => buildEmbed({
    alertId: "a10c4c",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "様子見：月次売上105.0%は需要の強弱を示すが、粗利率と固定費吸収への波及は限定的。" },
      { name: "事業概要", value: "専門職向け人材紹介と求人広告を手掛ける人材サービス企業で、企業向け採用支援と求職者向け転職支援を提供しています。" },
      { name: "足元材料", value: "2026年5月14日に第1四半期決算と月次売上105.0%を開示し、採用需要の強弱を同時に示しています。月次売上は堅調でも、紹介成約の単価と粗利率が伸びなければ営業利益への寄与は限定的です。" },
      { name: "ファンダ要点", value: "月次売上105.0%、国内人材紹介の成約数、コンサルタント生産性、求人単価、海外売上がKPIです。決算資料では成約数と利益率を見ます。読み取れる結果は、売上成長よりも粗利率と固定費吸収の強弱が評価材料です。" },
      { name: "注意点", value: "求人需要が鈍ると成約数と単価が同時に下がり、人件費と広告費の固定負担が利益率を圧迫します。海外売上が伸びても国内紹介の採算が弱い場合は利益改善が遅れます。" },
      { name: "開示リンク", value: "[2026-05-14 第1四半期決算短信(15:30)](https://example.com/20260514.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /procedural placeholder language/);
  assert.throws(() => buildEmbed({
    alertId: "a10c4d",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A4680",
    symbolCode: "4680",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "様子見：月次売上105.0%は需要を示すが、粗利率と固定費吸収への波及は限定的。" },
      { name: "事業概要", value: "ボウリング、アミューズメント、カラオケ、スポッチャを国内外で運営するレジャー企業です。月次売上、来場者数、客単価、米国店舗、出店・改装投資が収益を左右します。" },
      { name: "足元材料", value: "2026年5月14日に月次売上105.0%を開示し、国内外施設の需要動向が材料になっています。来場回復が続いても改装・出店費用が先行すると利益率への寄与は限定的です。" },
      { name: "ファンダ要点", value: "月次売上105.0%、来場者数、客単価、米国店舗、出店・改装投資はファンダ要点で扱うKPIです。既存施設の稼働と投資負担のバランスが利益率を左右します。" },
      { name: "注意点", value: "レジャー需要は休日・天候・訪日客動向で振れやすく、出店や改装の投資負担が重い場合は売上増でも営業利益率が伸びにくくなります。" },
      { name: "開示リンク", value: "[2026-05-14 月次売上に関するお知らせ(15:00)](https://example.com/20260514.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /事業概要 is too generic/);
  assert.throws(() => buildEmbed({
    alertId: "a10c5",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A3798",
    symbolCode: "3798",
    symbolName: "ULSグループ",
    fields: [
      { name: "材料インパクト", value: "ポジティブ材料：2026-05-20開示で2026年3月期決算説明会資料を確認し、還元・成長施策の具体化が材料です。" },
      { name: "事業概要", value: "ULSグループは直近開示で示された事業領域を軸に、売上成長と採算改善を確認する局面です。開示タイトルからは事業施策、資本政策、決算進捗の組み合わせが材料になります。" },
      { name: "足元材料", value: "2026-05-20の2026年3月期決算説明会資料が直近の中心材料です。同日資料では増配と成長施策が示され、事業進捗と株主還元・財務影響を合わせて確認する局面です。" },
      { name: "ファンダ要点", value: "決算数値では売上、営業利益、経常利益、純利益の進捗と、通期予想に対する達成度が確認軸です。増配・資本政策が同時に出ている場合は、利益成長と還元余力の両立が未確定です。" },
      { name: "注意点", value: "提携・M&A系の材料は、統合費用、顧客移行、収益貢献時期が遅れるリスクがあります。短期の期待に対し、契約条件と進捗開示が未確定です。" },
      { name: "開示リンク", value: "[2026-05-20 2026年3月期決算説明会資料(10:30)](https://example.com/20260520.pdf)" },
      { name: "Sources", value: "[ULSグループ IR情報](https://example.com/ir)" }
    ]
  }), /procedural placeholder language|too generic/);
  const dedupeEmbed = buildEmbed({
    alertId: "a10d",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "混在/要確認：業績改善は確認できるが、投資負担と継続性の確認が必要。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "2026年5月14日に業績予想修正を開示し、売上と利益の進捗が確認材料になっている。利益率、受注残、キャッシュフローの改善継続が本業評価を左右します。" },
      { name: "ファンダ要点", value: "販売数量、価格転嫁、固定費吸収、在庫水準が利益率の確認点になる。会社予想との進捗差や資金繰りも重要で、一過性利益と本業採算の切り分けが重要です。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://example.com/20260514534210.pdf)\n[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://f.irbank.net/pdf/20260514/140120260514534210.pdf)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  });
  assert.equal(dedupeEmbed.fields.find(field => field.name === "開示リンク").value, `${LIST_BULLET}[2026-05-14 業績予想修正に関するお知らせ(15:30)](https://f.irbank.net/pdf/20260514/140120260514534210.pdf)`);
  assert.equal(formatEmbedFieldValue("Sources", "[IRニュース一覧](https://example.com/ir)").startsWith(LIST_BULLET), true);
  assert.equal(formatEmbedFieldValue("Sources", "[IRニュース一覧](https://example.com/ir)").includes("?"), false);
  const logEvent = buildPostLogEvent({
    alertId: "a11",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "混在/要確認: 事業進捗はあるが、利益率と資金繰りの確認が必要。" },
      { name: "ファンダ要点", value: "増収は確認できるが、投資負担と利益率改善の継続性は未確定です。" },
      { name: "足元材料", value: "直近資料で事業進捗を確認。" },
      { name: "開示リンク", value: "[決算短信](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[IRニュース一覧](https://example.com/ir)" }
    ]
  }, { title: "テスト (1234) | TradingView チャート", url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234" }, {});
  assert.equal(logEvent.reason, "混在/要確認：事業進捗はあるが、利益率と資金繰りの確認が必要。");
  const linkedLogEvent = buildPostLogEvent({
    alertId: "a11b",
    symbolCode: "8165",
    symbolName: "千趣会",
    fields: [
      { name: "材料インパクト", value: "混在/要確認：利益改善余地はあるが、投資負担と継続性の確認が必要。" },
      { name: "ファンダ要点", value: "1Qは売上高91.66億円で前年同期比7.1%減ながら、営業損失は9.88億円と前年同期から損失幅が縮小。固定資産売却益と本業改善は分けた評価になります。" },
      { name: "足元材料", value: "直近資料で第1四半期決算と月次を確認。" },
      { name: "開示リンク", value: "[決算短信](https://example.com/disclosure.pdf)" },
      { name: "Sources", value: "[IRニュース一覧](https://example.com/ir)" }
    ]
  }, { title: "千趣会 (8165) | TradingView チャート", url: "https://jp.tradingview.com/chart/?symbol=TSE%3A8165" }, {}, "https://discord.com/channels/1/2/3");
  assert.equal(linkedLogEvent.reason, "[混在/要確認：利益改善余地はあるが、投資負担と継続性の確認が必要。](https://discord.com/channels/1/2/3)");
  assert.equal(extractIrbankPdfUrlFromHtml('<a href="https://f.irbank.net/pr/20260401/140120260326590425.pdf">PDF</a>', "140120260326590425"), "https://f.irbank.net/pr/20260401/140120260326590425.pdf");
  assert.equal(extractIrbankPdfUrlFromHtml('<a href="https://f.irbank.net/pdf/20260430/140120260430514206.pdf">PDF</a>', "140120260430514206"), "https://f.irbank.net/pdf/20260430/140120260430514206.pdf");
  assert.throws(() => buildEmbed({
    alertId: "mentioned-disclosure-unlinked",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A9610",
    symbolCode: "9610",
    symbolName: "ウィルソン",
    fields: [
      { name: "材料インパクト", value: "混在/要確認：赤字は縮小したが、資本増強と受注回復の確認が必要です。" },
      { name: "事業概要", value: "法人向け研修、組織開発、リーダーシップ育成を提供する教育研修会社です。" },
      { name: "足元材料", value: "5月15日の通期決算では経常損失が続きましたが、前年より赤字幅は縮小しています。新株発行と新株予約権行使が資本を下支えしており、営業回復だけではまだ弱い状態です。" },
      { name: "ファンダ要点", value: "2026年6月2日の「トップ・トレーニングサービス企業 20 社」は営業面の信用材料ですが、法人研修の受注額、講師稼働率、海外子会社の採算が戻らなければ売上転換は限定的です。" },
      { name: "注意点", value: "新株発行による希薄化と研修需要の回復時期が利益回復を左右します。表彰は案件獲得の補助材料であり、粗利率と継続受注が改善しない場合は赤字縮小が止まりやすいです。" },
      { name: "開示リンク", value: "[2026-05-15 2026年3月期決算短信〔日本基準〕(連結)(15:30)](https://f.irbank.net/pdf/20260515/140120260515537096.pdf)" },
      { name: "Sources", value: "[ウィルソン・ラーニング IR情報](https://www.wlw.co.jp/ir/)" }
    ]
  }), /mentions disclosure in narrative but omits it from 開示リンク/);
  assert.doesNotThrow(() => buildEmbed({
    alertId: "mentioned-disclosure-linked",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A9610",
    symbolCode: "9610",
    symbolName: "ウィルソン",
    fields: [
      { name: "材料インパクト", value: "混在/要確認：赤字は縮小したが、資本増強と受注回復の確認が必要です。" },
      { name: "事業概要", value: "法人向け研修、組織開発、リーダーシップ育成を提供する教育研修会社です。" },
      { name: "足元材料", value: "5月15日の通期決算では経常損失が続きましたが、前年より赤字幅は縮小しています。新株発行と新株予約権行使が資本を下支えしており、営業回復だけではまだ弱い状態です。" },
      { name: "ファンダ要点", value: "2026年6月2日の「トップ・トレーニングサービス企業 20 社」は営業面の信用材料ですが、法人研修の受注額、講師稼働率、海外子会社の採算が戻らなければ売上転換は限定的です。" },
      { name: "注意点", value: "新株発行による希薄化と研修需要の回復時期が利益回復を左右します。表彰は案件獲得の補助材料であり、粗利率と継続受注が改善しない場合は赤字縮小が止まりやすいです。" },
      { name: "開示リンク", value: "[2026-06-02 人材開発情報大手Training Industryの「トップ・トレーニングサービス企業 20 社」に5年連続で選出(11:00)](https://japan.wilsonlearning.com/resources/pr-260602_0/)\n[2026-05-15 2026年3月期決算短信〔日本基準〕(連結)(15:30)](https://f.irbank.net/pdf/20260515/140120260515537096.pdf)" },
      { name: "Sources", value: "[ウィルソン・ラーニング IR情報](https://www.wlw.co.jp/ir/)" }
    ]
  }));
  const perovskiteDisclosure = {
    dateText: "2026-06-19",
    timeText: "15:40",
    title: "ペロブスカイト太陽電池事業に関するプロジェクト投資枠組み協定書の締結及び30万USDの前受金受領のお知らせ",
    url: "https://f.irbank.net/pdf/20260619/140120260619574294.pdf",
    documentId: "140120260619574294",
    sourceName: "IRBANK",
    disclosedAtMs: Date.UTC(2026, 5, 19, 6, 40, 0)
  };
  assert.throws(() => assertNoNewerDisclosureCandidatesAccounted({
    alertId: "stale-5216",
    symbolCode: "5216",
    fields: [
      { name: "足元材料", value: "6月15日の新株予約権と資金使途変更を中心に、希薄化と資金繰りを整理しています。" },
      { name: "開示リンク", value: "[2026-06-15 第三者割当による新株式発行に関するお知らせ(16:00)](https://f.irbank.net/pdf/20260615/140120260615570766.pdf)" }
    ]
  }, { symbolCode: "5216" }, [perovskiteDisclosure], Date.UTC(2026, 4, 8, 0, 0, 0)), /newer disclosure exists/);
  assert.doesNotThrow(() => assertNoNewerDisclosureCandidatesAccounted({
    alertId: "reviewed-5216",
    symbolCode: "5216",
    fields: [
      { name: "足元材料", value: "6月19日に投資枠組み協定と30万USDの前受金受領を開示し、正式契約・出資転換・返還可否は未確定です。" },
      { name: "開示リンク", value: "[2026-06-19 ペロブスカイト太陽電池事業に関するプロジェクト投資枠組み協定書の締結及び30万USDの前受金受領のお知らせ(15:40)](https://f.irbank.net/pdf/20260619/140120260619574294.pdf)" }
    ]
  }, { symbolCode: "5216" }, [perovskiteDisclosure], Date.UTC(2026, 4, 8, 0, 0, 0)));
  const governanceDisclosure = {
    dateText: "2026-05-22",
    timeText: "11:00",
    title: "役員退職慰労金制度の廃止に関するお知らせ",
    url: "https://www2.jpx.co.jp/disc/52870/140120260521543824.pdf",
    documentId: "140120260521543824",
    sourceName: "Yahoo Finance O",
    disclosedAtMs: Date.UTC(2026, 4, 22, 2, 0, 0)
  };
  assert.throws(() => assertNoNewerDisclosureCandidatesAccounted({
    alertId: "unlinked-5287",
    symbolCode: "5287",
    fields: [
      { name: "注意点", value: "5月22日の役員退職慰労金制度の廃止に関するお知らせは報酬体系見直しのガバナンス材料です。" },
      { name: "開示リンク", value: "[2026-05-15 2026年3月期 決算短信〔日本基準〕（非連結）(11:00)](https://f.irbank.net/pdf/20260515/140120260513530229.pdf)" }
    ]
  }, { symbolCode: "5287" }, [governanceDisclosure], Date.UTC(2026, 4, 8, 0, 0, 0)), /mentions disclosure in narrative but omits it from 開示リンク/);
  assert.doesNotThrow(() => assertNoNewerDisclosureCandidatesAccounted({
    alertId: "linked-5287",
    symbolCode: "5287",
    fields: [
      { name: "注意点", value: "5月22日の役員退職慰労金制度の廃止に関するお知らせは報酬体系見直しのガバナンス材料です。" },
      { name: "開示リンク", value: "[2026-05-22 役員退職慰労金制度の廃止に関するお知らせ(11:00)](https://www2.jpx.co.jp/disc/52870/140120260521543824.pdf)" }
    ]
  }, { symbolCode: "5287" }, [governanceDisclosure], Date.UTC(2026, 4, 8, 0, 0, 0)));
  const routineCgDisclosure = {
    dateText: "2026-06-26",
    timeText: "15:57",
    title: "コーポレート・ガバナンスに関する報告書 2026/06/26",
    url: "https://example.com/cg.pdf",
    documentId: "cg-3896",
    sourceName: "Yahoo Finance T",
    disclosedAtMs: Date.UTC(2026, 5, 26, 6, 57, 0)
  };
  const midtermDisclosure = {
    dateText: "2026-05-28",
    timeText: "15:30",
    title: "第5次中期経営計画策定のお知らせ",
    url: "https://f.irbank.net/pdf/20260528/140120260528552222.pdf",
    documentId: "140120260528552222",
    sourceName: "IRBANK",
    disclosedAtMs: Date.UTC(2026, 4, 28, 6, 30, 0)
  };
  assert.doesNotThrow(() => assertNoNewerDisclosureCandidatesAccounted({
    alertId: "routine-cg-skipped-3896",
    symbolCode: "3896",
    fields: [
      { name: "足元材料", value: "5月28日の第5次中期経営計画では機能紙の受注、原燃料価格、海外向け販売の改善が利益率を左右します。" },
      { name: "開示リンク", value: "[2026-05-28 第5次中期経営計画策定のお知らせ(15:30)](https://f.irbank.net/pdf/20260528/140120260528552222.pdf)" }
    ]
  }, { symbolCode: "3896" }, [routineCgDisclosure, midtermDisclosure], Date.UTC(2026, 4, 8, 0, 0, 0)));
  const controlChangeDisclosure = {
    dateText: "2026-06-29",
    timeText: "15:30",
    title: "親会社及び主要株主である筆頭株主の異動に関するお知らせ",
    url: "https://f.irbank.net/pdf/20260629/140120260629582800.pdf",
    documentId: "140120260629582800",
    sourceName: "IRBANK",
    disclosedAtMs: Date.UTC(2026, 5, 29, 6, 30, 0)
  };
  assert.throws(() => assertNoNewerDisclosureCandidatesAccounted({
    alertId: "material-governance-missing-3222",
    symbolCode: "3222",
    fields: [
      { name: "足元材料", value: "5月1日の決算では既存店売上と食品粗利の改善が確認材料です。" },
      { name: "開示リンク", value: "[2026-05-01 2026年2月期決算短信(15:00)](https://f.irbank.net/pdf/20260501/140120260501511111.pdf)" }
    ]
  }, { symbolCode: "3222" }, [controlChangeDisclosure], Date.UTC(2026, 4, 8, 0, 0, 0)), /newer disclosure exists/);
  assert.throws(() => buildEmbed({
    alertId: "routine-cg-filler",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A3896",
    symbolCode: "3896",
    symbolName: "阿波製紙",
    fields: [
      { name: "材料インパクト", value: "様子見：阿波製紙の最新開示は管理・体制面が中心で、機能紙の受注への直接効果は限定的です。" },
      { name: "事業概要", value: "自動車・水処理・産業用途の機能紙、濾材、分離膜支持体などを製造する特殊紙メーカーです。" },
      { name: "足元材料", value: "6月26日の阿波製紙の体制更新は、機能紙の受注より管理面への影響が中心です。5月28日の中期経営計画では機能紙の受注、原燃料価格、海外向け販売、設備稼働率が利益率を左右します。" },
      { name: "ファンダ要点", value: "機能紙の受注、原燃料価格、海外向け販売、設備稼働率、製品ミックスが利益率を左右します。高付加価値品の数量回復が鈍い場合、原燃料高を吸収できません。" },
      { name: "注意点", value: "中期計画の施策が受注単価と設備稼働率に表れない場合、海外向け販売の伸びより固定費負担が先に残ります。原燃料価格の上昇を価格転嫁できない局面では、製品ミックス改善も利益に残りにくくなります。" },
      { name: "開示リンク", value: "[2026-05-28 第5次中期経営計画策定のお知らせ(15:30)](https://f.irbank.net/pdf/20260528/140120260528552222.pdf)" },
      { name: "Sources", value: "[IRBANK 阿波製紙(3896) 開示一覧](https://irbank.net/3896/ir)" }
    ]
  }), /routine governance filings|routine governance filing/);
  assert.throws(() => buildEmbed({
    alertId: "routine-controlling-shareholder-filler",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A3231",
    symbolCode: "3231",
    symbolName: "野村不動産ホールディングス",
    fields: [
      { name: "材料インパクト", value: "様子見：支配株主関連は補助材料で、通期決算の分譲・賃貸・開発パイプラインが実体です。" },
      { name: "事業概要", value: "住宅分譲、都市開発、賃貸、資産運用、仲介・管理などを展開する総合不動産グループです。" },
      { name: "足元材料", value: "4月24日の2026年3月期決算短信では、マンション分譲、オフィス賃貸、開発物件の引き渡し、資産回転が業績の中心になります。販売速度、賃貸空室率、資産売却益が利益の振れを作ります。" },
      { name: "ファンダ要点", value: "分譲マンション販売戸数、粗利率、賃貸空室率、開発パイプライン、資産売却益が重要です。不動産市況と金利が販売速度を左右し、開発採算と在庫回転が営業利益率に反映されます。" },
      { name: "注意点", value: "不動産開発は引き渡し時期で利益が偏ります。金利上昇や建築費高騰が続くと、用地取得と販売価格のバランスが悪化し、完成在庫の資金負担も増えます。" },
      { name: "開示リンク", value: "[2026-04-24 2026年3月期決算短信〔日本基準〕(連結)(15:30)](https://f.irbank.net/pdf/20260424/140120260424510126.pdf)" },
      { name: "Sources", value: "[IRBANK 野村不動産ホールディングス(3231) 開示一覧](https://irbank.net/3231/ir)" }
    ]
  }), /routine controlling-shareholder|routine governance/);
  assert.equal(getPostSkipReason("posted-alert", { posted: { "posted-alert": {} }, claims: {} }, null), "already posted");
  assert.equal(getPostSkipReason("unclaimed-alert", { posted: {}, claims: {} }, null), "no active claim");
  assert.equal(getPostSkipReason("claimed-alert", { posted: {}, claims: { "claimed-alert": { claimId: "c1" } } }, { claimId: "c1" }), "");
  assert.throws(() => buildEmbed({
    alertId: "a7",
    url: "https://jp.tradingview.com/chart/?symbol=TSE%3A1234",
    symbolCode: "1234",
    symbolName: "テスト",
    fields: [
      { name: "材料インパクト", value: "混在/要確認：短期材料はあるが、事業KPIへの反映確認が必要。" },
      { name: "事業概要", value: "精密部品を扱う製造業で、国内外の顧客向けに加工品と関連サービスを提供する会社です。" },
      { name: "足元材料", value: "直近決算では売上と利益の推移が確認材料。受注環境、原材料価格、固定費吸収の状況に加え、会社予想との進捗差が材料です。継続性が利益評価を左右します。" },
      { name: "ファンダ要点", value: "増収要因が数量増なのか価格転嫁なのかで評価が変わる。利益率、在庫、キャッシュフローの改善継続が評価を左右します。会社予想との進捗差も重要になる。" },
      { name: "注意点", value: "短期の株価材料と中期の業績改善は分けて確認する。需要変動、為替、原材料価格、顧客集中に注意し、単発利益の有無もリスクです。" },
      { name: "開示リンク", value: "[2026-02-12 自己株式取得結果に関するお知らせ(15:00)](https://irbank.net/1234/140120260212558146)" },
      { name: "Sources", value: "[テスト株式会社 IRニュース一覧](https://example.com/ir/news)" }
    ]
  }), /direct disclosure URL/);
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
  assert.equal(extractSymbolCodeFromUrl("https://jp.tradingview.com/chart/?symbol=TYO%3A8285"), "8285");
  const scanComponents = buildPremiumScanComponents(
    { symbolCode: "3917" },
    {},
    "https://jp.tradingview.com/chart/?symbol=TSE%3A3917"
  );
  assert.equal(scanComponents[0].type, DISCORD_COMPONENT_ACTION_ROW);
  assert.equal(scanComponents[0].components[0].type, DISCORD_COMPONENT_BUTTON);
  assert.equal(scanComponents[0].components[0].style, DISCORD_BUTTON_STYLE_SECONDARY);
  assert.equal(scanComponents[0].components[0].custom_id, "premium_scan:3917");
  assert.equal(scanComponents[0].components[0].label, "🔍 3917 をスキャンする");
  assert.equal(scanComponents[0].components[1].type, DISCORD_COMPONENT_BUTTON);
  assert.equal(scanComponents[0].components[1].style, DISCORD_BUTTON_STYLE_LINK);
  assert.equal(scanComponents[0].components[1].label, "📊 チャートを見る");
  assert.equal(scanComponents[0].components[1].url, "https://jp.tradingview.com/chart/?symbol=TSE%3A3917");
  assert.deepEqual(buildPremiumScanComponents({ symbolCode: "BAD" }), []);
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
  assert.equal(extractNearestDisclosureDateInfo("invalid document date 2049/97/69", "Correction (15:10)"), null);
  assert.equal(extractDisclosureDateInfo("document id 140120180209476969").dateText, "");
  assert.equal(extractDisclosureDateInfo("standalone date 20260511").dateText, "2026-05-11");
  assert.throws(() => assertFailCommandScope([
    { alertId: "f1", reason: "insufficient verified sources" },
    { alertId: "f2", reason: "insufficient verified sources" }
  ], { input: "failures.json" }, true), /batch insufficient-source fail is rejected/);
  assert.doesNotThrow(() => assertFailCommandScope([
    { alertId: "f1", reason: "insufficient verified sources" }
  ], { "alert-id": "f1" }, false));
  assert.doesNotThrow(() => assertFailCommandScope([
    { alertId: "f1", reason: "insufficient verified sources" },
    { alertId: "f2", reason: "insufficient verified sources" }
  ], { "allow-mass-fail": true, input: "failures.json" }, true));
  const oldWindowMax = process.env.PREMIUM_MAX_INSUFFICIENT_FAILS_PER_WINDOW;
  const oldWindowMinutes = process.env.PREMIUM_INSUFFICIENT_FAIL_WINDOW_MINUTES;
  process.env.PREMIUM_MAX_INSUFFICIENT_FAILS_PER_WINDOW = "3";
  process.env.PREMIUM_INSUFFICIENT_FAIL_WINDOW_MINUTES = "60";
  const recentStubState = {
    posted: {
      f1: { source: "samayomi_stub", reason: "insufficient verified sources", postedAt: "2026-06-17T04:00:00.000Z" },
      f2: { source: "samayomi_stub", reason: "insufficient verified sources", postedAt: "2026-06-17T04:01:00.000Z" },
      f3: { source: "samayomi_stub", reason: "insufficient verified sources", postedAt: "2026-06-17T04:02:00.000Z" }
    }
  };
  assert.doesNotThrow(() => assertFailStateScope([
    { alertId: "f4", reason: "insufficient verified sources" }
  ], { "allow-mass-fail": true }, recentStubState, new Date("2026-06-17T04:30:00.000Z")));
  assert.throws(() => assertFailStateScope([
    { alertId: "f4", reason: "insufficient verified sources" }
  ], { "alert-id": "f4" }, recentStubState, new Date("2026-06-17T04:30:00.000Z")), /too many recent insufficient-source fail stubs/);
  assert.doesNotThrow(() => assertFailStateScope([
    { alertId: "f4", reason: "insufficient verified sources" }
  ], { "alert-id": "f4" }, recentStubState, new Date("2026-06-17T05:30:00.000Z")));
  restoreEnv("PREMIUM_MAX_INSUFFICIENT_FAILS_PER_WINDOW", oldWindowMax);
  restoreEnv("PREMIUM_INSUFFICIENT_FAIL_WINDOW_MINUTES", oldWindowMinutes);
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
