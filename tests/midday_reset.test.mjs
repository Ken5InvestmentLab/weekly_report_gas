import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../gas.txt', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next);
}
const names = ['MIDDAY_STATE_KEY', 'MIDDAY_SYMBOL_LIST_KEY', 'MIDDAY_NEW_ALERT_COUNT_KEY',
  'MIDDAY_LAST_TS_MAP_KEY', 'MIDDAY_REFRESH_ID_KEY', 'MIDDAY_FULL_BACKFILL_SYMBOLS_KEY',
  'MIDDAY_FETCH_INFLIGHT_KEY', 'GLOBAL_WATCHDOG_OHLCV_MIDDAY_ACTIVE_KEY',
  'GLOBAL_WATCHDOG_OHLCV_MAIN_ACTIVE_KEY', 'PHASE_KEY', 'MAIN_PHASE1_FETCH_INFLIGHT_KEY',
  'MIDDAY_RESUME_HANDLER'];
function harness(initial, available = true) {
  const values = new Map(Object.entries(initial));
  const deletedHandlers = [];
  let cacheClears = 0;
  let releases = 0;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => values.get(key) ?? null,
      deleteProperty: key => values.delete(key)
    }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => available, releaseLock: () => releases++
    }) },
    clearCachedRawAlertVolumeMap_: () => cacheClears++,
    deleteTriggersByHandler_: handler => deletedHandlers.push(handler),
    console: { log() {} }
  });
  const constants = names.map(name => source.match(new RegExp(`const ${name} = [^;]+;`))[0]).join('\n');
  vm.runInContext(constants + '\n' + functionSource('clearMiddayOhlcvState_') + '\n' + functionSource('resetMiddayOhlcvProgress'), context);
  return { run: () => context.resetMiddayOhlcvProgress(), values, deletedHandlers,
    get cacheClears() { return cacheClears; }, get releases() { return releases; } };
}

test('manual midday reset clears stale queue/cache and watchdog marker while preserving unrelated state', () => {
  const h = harness({
    OHLCV_MIDDAY_PROGRESS_INDEX: '130', OHLCV_MIDDAY_SYMBOL_LIST: '["157A"]',
    OHLCV_MIDDAY_LAST_TS_MAP: '{"157A":1}', OHLCV_MIDDAY_NEW_ALERT_COUNT: '0',
    OHLCV_MIDDAY_REFRESH_ID: 'MIDDAY_2026-09-03',
    OHLCV_MIDDAY_FULL_BACKFILL_SYMBOLS: '[]', OHLCV_MIDDAY_FETCH_INFLIGHT_V1: '{}',
    GLOBAL_WATCHDOG_ACTIVE_OHLCV_MIDDAY_V1: 'active',
    OHLCV_REPAIR_SYMBOLS: '["1726"]', SPREADSHEET_ID: 'unchanged',
    OHLCV_MIDDAY_MEGA_REPORT_DISPATCHED_REFRESH_ID_V1: 'already-dispatched'
  });
  assert.equal(h.run().previous.cursor, '130');
  assert.deepEqual([...h.values.keys()].sort(), [
    'OHLCV_MIDDAY_MEGA_REPORT_DISPATCHED_REFRESH_ID_V1', 'OHLCV_REPAIR_SYMBOLS', 'SPREADSHEET_ID'
  ]);
  assert.deepEqual(h.deletedHandlers, ['resumeOHLCVFetchMidday']);
  assert.equal(h.cacheClears, 1);
  assert.equal(h.releases, 1);
});

test('reset does not mutate state when another execution owns the script lock', () => {
  const h = harness({ OHLCV_MIDDAY_PROGRESS_INDEX: '130' }, false);
  assert.throws(() => h.run(), /実行中/);
  assert.equal(h.values.get('OHLCV_MIDDAY_PROGRESS_INDEX'), '130');
  assert.equal(h.cacheClears, 0);
  assert.equal(h.releases, 0);
});

test('reset refuses to clear a cache shared with a pending afternoon run', () => {
  for (const key of ['OHLCV_CURRENT_PHASE', 'GLOBAL_WATCHDOG_ACTIVE_OHLCV_MAIN_V1', 'OHLCV_PHASE1_FETCH_INFLIGHT_V1']) {
    const h = harness({ [key]: 'active', OHLCV_MIDDAY_PROGRESS_INDEX: '130' });
    assert.throws(() => h.run(), /15:51/);
    assert.equal(h.values.size, 2);
    assert.equal(h.cacheClears, 0);
    assert.equal(h.releases, 1);
  }
});
