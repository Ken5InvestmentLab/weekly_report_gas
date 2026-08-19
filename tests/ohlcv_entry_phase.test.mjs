import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../gas.txt", import.meta.url), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function: ${name}`);
}

function createProperties(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getProperty(key) { return values.has(key) ? values.get(key) : null; },
    setProperty(key, value) { values.set(key, String(value)); },
    deleteProperty(key) { values.delete(key); },
    values
  };
}

const constants = `
const PHASE_KEY = "OHLCV_CURRENT_PHASE";
const STATE_KEY = "OHLCV_PROGRESS_INDEX";
const SYMBOL_LIST_KEY = "OHLCV_SYMBOL_LIST";
const NEW_ALERT_COUNT_KEY = "OHLCV_NEW_ALERT_COUNT";
const MAIN_FULL_BACKFILL_SYMBOLS_KEY = "OHLCV_MAIN_FULL_BACKFILL_SYMBOLS";
const MAIN_PHASE1_FETCH_INFLIGHT_KEY = "OHLCV_PHASE1_FETCH_INFLIGHT_V1";
const OHLCV_COMPLETION_NOTICE_PENDING_KEY = "OHLCV_COMPLETION_NOTICE_PENDING_V1";
const GLOBAL_WATCHDOG_OHLCV_MAIN_ACTIVE_KEY = "GLOBAL_WATCHDOG_ACTIVE_OHLCV_MAIN_V1";
const OHLCV_REPAIR_SYMBOLS_PRESERVE_KEY = "OHLCV_REPAIR_SYMBOLS_PRESERVE_V1";
const OHLCV_FRESH_START_PENDING_KEY = "OHLCV_FRESH_START_PENDING_V1";
`;

test("fresh fixed OHLCV run clears saved phase progress but preserves repair work", () => {
  const props = createProperties({
    OHLCV_CURRENT_PHASE: "PHASE2",
    OHLCV_PROGRESS_INDEX: "1085",
    OHLCV_SYMBOL_LIST: '["7203"]',
    OHLCV_NEW_ALERT_COUNT: "20",
    OHLCV_MAIN_FULL_BACKFILL_SYMBOLS: '["7203"]',
    OHLCV_PHASE1_FETCH_INFLIGHT_V1: '{"cursor":0}',
    LAST_TS_MAP: '{"7203":1}',
    CURRENT_REFRESH_ID: "old_session",
    SPLIT_QUEUE: '[{"symbol":"7203"}]',
    SPLIT_INDEX: "42",
    OHLCV_SPLIT_CACHE: '{}',
    OHLCV_COMPLETION_NOTICE_PENDING_V1: '{}',
    GLOBAL_WATCHDOG_ACTIVE_OHLCV_MAIN_V1: "2026-08-19T06:55:54.000Z",
    OHLCV_REPAIR_SYMBOLS: '["6758"]',
    OHLCV_REPAIR_SYMBOLS_PRESERVE_V1: "true",
    OHLCV_FRESH_START_PENDING_V1: "true"
  });
  let cacheClears = 0;
  const context = {
    Object,
    PropertiesService: { getScriptProperties() { return props; } },
    clearCachedRawAlertVolumeMap_() { cacheClears++; },
    getOhlcvRuntimeState_() {
      return {
        phase: props.getProperty("OHLCV_CURRENT_PHASE") || "PHASE1",
        cursor: props.getProperty("OHLCV_PROGRESS_INDEX") || "",
        symbolsSaved: !!props.getProperty("OHLCV_SYMBOL_LIST")
      };
    }
  };
  vm.createContext(context);
  vm.runInContext(
    constants +
      extractFunction("clearOhlcvMainProgressProperties_") + "\n" +
      extractFunction("hasOhlcvMainResumeState_") + "\n" +
      extractFunction("prepareFreshOhlcvMainRun_") + "\n" +
      "globalThis.prepareFreshOhlcvMainRun_ = prepareFreshOhlcvMainRun_;",
    context
  );

  const previous = context.prepareFreshOhlcvMainRun_();
  assert.equal(previous.phase, "PHASE2");
  assert.equal(previous.cursor, "1085");
  assert.equal(previous.hadResumeState, true);
  assert.equal(cacheClears, 1);

  for (const key of [
    "OHLCV_CURRENT_PHASE",
    "OHLCV_PROGRESS_INDEX",
    "OHLCV_SYMBOL_LIST",
    "OHLCV_NEW_ALERT_COUNT",
    "OHLCV_MAIN_FULL_BACKFILL_SYMBOLS",
    "OHLCV_PHASE1_FETCH_INFLIGHT_V1",
    "LAST_TS_MAP",
    "CURRENT_REFRESH_ID",
    "SPLIT_QUEUE",
    "SPLIT_INDEX",
    "OHLCV_SPLIT_CACHE",
    "OHLCV_COMPLETION_NOTICE_PENDING_V1",
    "OHLCV_REPAIR_SYMBOLS_PRESERVE_V1",
    "OHLCV_FRESH_START_PENDING_V1"
  ]) {
    assert.equal(props.getProperty(key), null, `${key} must be cleared`);
  }
  assert.equal(props.getProperty("OHLCV_REPAIR_SYMBOLS"), '["6758"]');
  assert.equal(props.getProperty("GLOBAL_WATCHDOG_ACTIVE_OHLCV_MAIN_V1"), "2026-08-19T06:55:54.000Z");
});

test("queued stale OHLCV resume exits instead of starting a new PHASE1", () => {
  const props = createProperties();
  let consumed = 0;
  let runnerCalls = 0;
  const context = {
    PropertiesService: { getScriptProperties() { return props; } },
    consumeTemporaryTrigger_() { consumed++; },
    getOhlcvRuntimeState_() { return { phase: props.getProperty("OHLCV_CURRENT_PHASE") || "PHASE1" }; },
    writeProcessLog_() {},
    traceOhlcv_() {},
    debugLogToSheet_() {},
    getOhlcvBusinessDateKey_() { return "2026-08-19"; },
    getManualOhlcvBusinessDateKey_() { return ""; },
    runFetchOHLCVForNewAlerts_(resumeSavedState) {
      runnerCalls++;
      return { resumed: resumeSavedState };
    },
    setupResumeTrigger_() {},
    console
  };
  vm.createContext(context);
  vm.runInContext(
    constants +
      extractFunction("hasOhlcvMainResumeState_") + "\n" +
      extractFunction("resumeOHLCVFetch") + "\n" +
      "globalThis.resumeOHLCVFetch = resumeOHLCVFetch;",
    context
  );

  const staleResult = context.resumeOHLCVFetch();
  assert.equal(staleResult.ok, true);
  assert.equal(staleResult.skipped, true);
  assert.equal(staleResult.reason, "stale_resume_without_state");
  assert.equal(consumed, 1);
  assert.equal(runnerCalls, 0);

  props.setProperty("OHLCV_CURRENT_PHASE", "PHASE2");
  const resumeResult = context.resumeOHLCVFetch();
  assert.equal(resumeResult.resumed, true);
  assert.equal(runnerCalls, 1);

  props.deleteProperty("OHLCV_CURRENT_PHASE");
  props.setProperty("OHLCV_FRESH_START_PENDING_V1", "true");
  const freshAfterLockBusy = context.resumeOHLCVFetch();
  assert.equal(freshAfterLockBusy.resumed, false);
  assert.equal(runnerCalls, 2);
});

test("fixed and resume OHLCV entries use separate execution modes", () => {
  const fixedEntry = extractFunction("fetchOHLCVForNewAlerts");
  const runner = extractFunction("runFetchOHLCVForNewAlerts_");
  const resumeEntry = extractFunction("resumeOHLCVFetch");

  assert.match(fixedEntry, /runFetchOHLCVForNewAlerts_\(false\)/);
  assert.match(runner, /if \(resumeSavedState !== true\)\s*{\s*const previousState = prepareFreshOhlcvMainRun_\(\)/);
  assert.match(resumeEntry, /runFetchOHLCVForNewAlerts_\(!freshStartPending\)/);
  assert.match(source, /id:\s*"ohlcv_main"[\s\S]*?pending:\s*!!allProps\[GLOBAL_WATCHDOG_OHLCV_MAIN_ACTIVE_KEY\]\s*\|\|\s*allProps\[OHLCV_FRESH_START_PENDING_KEY\] === "true"/);
});
