import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../gas.txt", import.meta.url), "utf8");

function loadTriggerSchedulingApi({ createFailures = 0 } = {}) {
  const start = source.indexOf("function getProjectTriggersByHandler_");
  const end = source.indexOf("\nfunction armGlobalWatchdogMarker_", start);
  assert.ok(start >= 0 && end > start, "trigger scheduling helpers must be extractable");

  const events = [];
  const oldTrigger = {
    id: "old",
    getHandlerFunction() { return "resumeJob"; }
  };
  let failuresLeft = createFailures;
  const properties = new Map();
  const context = {
    Number,
    Object,
    String,
    Date,
    JSON,
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) { return properties.has(key) ? properties.get(key) : null; },
          setProperty(key, value) { properties.set(key, String(value)); },
          deleteProperty(key) { properties.delete(key); }
        };
      }
    },
    ScriptApp: {
      getProjectTriggers() { return [oldTrigger]; },
      deleteTrigger(trigger) { events.push(`delete:${trigger.id}`); },
      newTrigger(handlerName) {
        return {
          timeBased() { return this; },
          after(delayMs) { events.push(`after:${handlerName}:${delayMs}`); return this; },
          create() {
            events.push(`create:${handlerName}`);
            if (failuresLeft > 0) {
              failuresLeft -= 1;
              throw new Error("temporary trigger service error");
            }
            return { id: "new", getHandlerFunction() { return handlerName; } };
          }
        };
      }
    },
    Utilities: {
      sleep(ms) { events.push(`sleep:${ms}`); }
    }
  };
  vm.createContext(context);
  vm.runInContext(
    `const GLOBAL_EXECUTION_WATCHDOG_REPAIR_AFTER_MS = 30000;\n${source.slice(start, end)}\n` +
      "globalThis.api = { scheduleRecoveryTriggerReplacing_ };",
    context
  );
  return { api: context.api, events };
}

test("replacement trigger is created before the old trigger is deleted", () => {
  const { api, events } = loadTriggerSchedulingApi();
  const result = api.scheduleRecoveryTriggerReplacing_("resumeJob", 60000);

  assert.equal(result.ok, true);
  assert.equal(result.replacedTriggers, 1);
  assert.ok(events.indexOf("create:resumeJob") < events.indexOf("delete:old"));
});

test("old trigger survives when every create attempt fails", () => {
  const { api, events } = loadTriggerSchedulingApi({ createFailures: 3 });

  assert.throws(
    () => api.scheduleRecoveryTriggerReplacing_("resumeJob", 60000),
    /temporary trigger service error/
  );
  assert.equal(events.filter(event => event === "create:resumeJob").length, 3);
  assert.equal(events.some(event => event.startsWith("delete:")), false);
});

test("transient trigger creation errors retry before replacing", () => {
  const { api, events } = loadTriggerSchedulingApi({ createFailures: 2 });
  const result = api.scheduleRecoveryTriggerReplacing_("resumeJob", 60000);

  assert.equal(result.attempt, 3);
  assert.deepEqual(events.filter(event => event.startsWith("sleep:")), ["sleep:1000", "sleep:2000"]);
  assert.ok(events.indexOf("delete:old") > events.lastIndexOf("create:resumeJob"));
});

test("all one-shot trigger creation is centralized", () => {
  assert.doesNotMatch(
    source,
    /deleteTriggersByHandler_\([^\n]+\);\s*\n\s*ScriptApp\.newTrigger/
  );

  const directCreateCount = (source.match(/ScriptApp\.newTrigger/g) || []).length;
  assert.equal(directCreateCount, 8, "only the central one-shot, recurring watchdog, and six fixed builders may create triggers directly");

  for (const helper of [
    "scheduleOhlcvResume_",
    "scheduleQuickRepairResume_",
    "scheduleEvaluationOhlcvCoverageResume_",
    "scheduleSingleOhlcvPostCleanupTrigger_",
    "scheduleSingleOhlcvPostRepairCleanupTrigger_",
    "scheduleSingleOhlcvPostRepairFinalSortTrigger_"
  ]) {
    const helperStart = source.indexOf(`function ${helper}`);
    assert.ok(helperStart >= 0, `${helper} must exist`);
    const helperEnd = source.indexOf("\n}", helperStart);
    assert.match(source.slice(helperStart, helperEnd + 2), /scheduleRecoveryTriggerReplacing_/);
  }
});

test("global watchdog covers fixed triggers and every resumable chain", () => {
  for (const fixedHandler of [
    "buildAndSendWeeklyReport",
    "syncMarketHolidays",
    "fetchOHLCVForNewAlertsMidday",
    "fetchOHLCVForNewAlerts",
    "purgeOldOhlcvDataDaily",
    "purgeOldSignalArchiveRowsDaily"
  ]) {
    assert.match(source, new RegExp(`handler:\\s*${fixedHandler.startsWith("fetchOHLCV") ? "(?:OHLCV_[A-Z_]+|\\\"" + fixedHandler + "\\\")" : "\\\"" + fixedHandler + "\\\""}`));
  }

  for (const recoveryId of [
    "weekly_report",
    "holiday_sync",
    "purge_old_ohlcv",
    "purge_signal_archive",
    "deferred_discord",
    "ohlcv_main",
    "ohlcv_midday",
    "ohlcv_midday_postprocess",
    "ohlcv_midday_rollback",
    "daily_maintenance",
    "ohlcv_post_maintenance_cleanup",
    "quick_repair",
    "ohlcv_post_repair_cleanup",
    "ohlcv_post_repair_final_sort",
    "evaluation_ohlcv_coverage",
    "historical_ohlcv_volume",
    "historical_alert_pm_volume",
    "historical_alert_am_volume",
    "ohlcv_recovery_timestamp",
    "cleanup_legacy_ohlcv",
    "cleanup_ohlcv_duplicates"
  ]) {
    assert.match(source, new RegExp(`id:\\s*\\\"${recoveryId}\\\"`), `watchdog job ${recoveryId} must remain covered`);
  }
});

test("PM to AM repair handoff consumes its flag only after the next trigger is secured", () => {
  const start = source.indexOf("function scheduleChainedAmRepairIfRequested_");
  const end = source.indexOf("\nfunction repairHistoricalAlertsRawVolume_", start);
  assert.ok(start >= 0 && end > start, "PM to AM handoff must be extractable");

  const handoff = source.slice(start, end);
  const stateWrite = handoff.indexOf('props.setProperty("HIST_ALERT_VOL_REPAIR_AM_V1"');
  const triggerCreate = handoff.indexOf('scheduleRecoveryTriggerReplacing_("resumeRepairHistoricalAmVolumeFromAlertsRaw"');
  const flagDelete = handoff.indexOf("props.deleteProperty(HIST_ALERTS_VOL_REPAIR_CHAIN_KEY)");

  assert.ok(stateWrite >= 0 && stateWrite < triggerCreate);
  assert.ok(triggerCreate < flagDelete);
});
