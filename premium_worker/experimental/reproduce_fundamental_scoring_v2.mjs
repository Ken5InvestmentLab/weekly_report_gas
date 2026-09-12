#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMPONENT_ORDER } from './fundamental_scoring_v2.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const experimentalDir = path.dirname(scriptPath);
const repoRoot = path.resolve(experimentalDir, '../..');
const masterFixturePath = path.join(experimentalDir, 'fixtures', 'fundamental_scoring_v2_asof_2026-09-11.json');
const scorerPath = path.join(experimentalDir, 'score_fundamental_scoring_v2.mjs');
const v2ValidatorPath = path.join(experimentalDir, 'validate_fundamental_scores_v2.mjs');
const v1ValidatorPath = path.join(experimentalDir, 'validate_fundamental_scores_v1.mjs');
const fixture = JSON.parse(fs.readFileSync(masterFixturePath, 'utf8'));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const outputRoot = path.join(experimentalDir, 'repro_results', `asof_${fixture.as_of}`, `run_${stamp}`);
if (fs.existsSync(outputRoot)) throw new Error(`output directory already exists: ${outputRoot}`);
fs.mkdirSync(outputRoot, { recursive: true });

function execute(args, label) {
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const completedRuns = [];
for (const testCase of fixture.cases) {
  for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
    const runDir = path.join(outputRoot, testCase.symbol, `run_${runIndex}`);
    fs.mkdirSync(runDir, { recursive: true });
    const caseSourceIds = new Set(testCase.sources);
    const isolatedFixture = {
      rubric_version: fixture.rubric_version,
      as_of: fixture.as_of,
      as_of_timezone: fixture.as_of_timezone,
      japan_holidays: fixture.japan_holidays,
      sources: Object.fromEntries(Object.entries(fixture.sources).filter(([sourceId]) => caseSourceIds.has(sourceId))),
      cases: [testCase],
    };
    const inputPath = path.join(runDir, 'input.json');
    const scoresPath = path.join(runDir, 'scores.json');
    const auditPath = path.join(runDir, 'audit.json');
    fs.writeFileSync(inputPath, `${JSON.stringify(isolatedFixture, null, 2)}\n`, 'utf8');

    // A fresh scoring process sees only this symbol's frozen fixture. It cannot read another run's output.
    execute([scorerPath, inputPath, scoresPath, auditPath], `${testCase.symbol} run ${runIndex} scorer`);
    const v2 = execute([v2ValidatorPath, scoresPath, auditPath, inputPath], `${testCase.symbol} run ${runIndex} V2 validator`);
    const v1 = execute([v1ValidatorPath, scoresPath], `${testCase.symbol} run ${runIndex} V1 compatibility validator`);
    fs.writeFileSync(path.join(runDir, 'validator_v2.json'), `${v2.stdout}\n`, 'utf8');
    fs.writeFileSync(path.join(runDir, 'validator_v1.json'), `${v1.stdout}\n`, 'utf8');
    completedRuns.push({ symbol: testCase.symbol, runIndex, runDir, scoresPath, auditPath, inputPath });
  }
}

// No scores are loaded or compared until all 9 sidecars have passed both validators above.
const grouped = new Map();
for (const run of completedRuns) {
  const data = JSON.parse(fs.readFileSync(run.scoresPath, 'utf8'));
  const record = data.scores[0];
  if (!grouped.has(run.symbol)) grouped.set(run.symbol, []);
  grouped.get(run.symbol).push({ run: run.runIndex, record });
}

function pairwise(values) {
  const pairs = [];
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) pairs.push([values[i], values[j]]);
  }
  return pairs;
}

const symbolReports = [];
for (const [symbol, runs] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const scoreValues = runs.map(({ record }) => record.fundamental_score);
  const confidenceValues = runs.map(({ record }) => record.confidence);
  const componentDeltas = Object.fromEntries(COMPONENT_ORDER.map((component) => [component, Math.max(...pairwise(runs.map(({ record }) => record[component])).map(([a, b]) => Math.abs(a - b)))]));
  const componentAbsDeltaSumMax = Math.max(...pairwise(runs.map(({ record }) => record)).map(([a, b]) => COMPONENT_ORDER.reduce((sum, component) => sum + Math.abs(a[component] - b[component]), 0)));
  const riskFlagSets = runs.map(({ record }) => JSON.stringify(record.risk_flags));
  const scoreDelta = Math.max(...scoreValues) - Math.min(...scoreValues);
  const confidenceDelta = Math.max(...confidenceValues) - Math.min(...confidenceValues);
  const stabilityPass = scoreDelta <= 5
    && Object.values(componentDeltas).every((delta) => delta <= 3)
    && componentAbsDeltaSumMax <= 10
    && riskFlagSets.every((flags) => flags === riskFlagSets[0])
    && confidenceDelta <= 0.05;
  symbolReports.push({
    symbol,
    runs: runs.map(({ run, record }) => ({
      run,
      fundamental_score: record.fundamental_score,
      components: Object.fromEntries(COMPONENT_ORDER.map((component) => [component, record[component]])),
      risk_flags: record.risk_flags,
      confidence: record.confidence,
    })),
    score_range: { min: Math.min(...scoreValues), max: Math.max(...scoreValues), delta: scoreDelta },
    component_max_delta: componentDeltas,
    component_abs_delta_sum_max: componentAbsDeltaSumMax,
    risk_flags_consistent: riskFlagSets.every((flags) => flags === riskFlagSets[0]),
    confidence_range: { min: Math.min(...confidenceValues), max: Math.max(...confidenceValues), delta: +confidenceDelta.toFixed(2) },
    stability_pass: stabilityPass,
  });
}

const passCount = symbolReports.filter((report) => report.stability_pass).length;
const failCount = symbolReports.length - passCount;
const worstSymbolCandidate = [...symbolReports].sort((a, b) => b.score_range.delta - a.score_range.delta || a.symbol.localeCompare(b.symbol))[0];
const worstSymbol = worstSymbolCandidate?.score_range.delta > 0 ? worstSymbolCandidate : null;
let worstComponent = null;
for (const report of symbolReports) {
  for (const component of COMPONENT_ORDER) {
    const delta = report.component_max_delta[component];
    if (!worstComponent || delta > worstComponent.delta) worstComponent = { symbol: report.symbol, component, delta };
  }
}
if (worstComponent?.delta === 0) worstComponent = null;

const summary = {
  rubric_version: 2,
  as_of: fixture.as_of,
  as_of_timezone: fixture.as_of_timezone,
  independent_process_count: completedRuns.length,
  all_runs_validated_before_comparison: true,
  validators: ['validate_fundamental_scores_v2.mjs', 'validate_fundamental_scores_v1.mjs'],
  thresholds: { total_score_max_delta: 5, component_max_delta: 3, component_abs_delta_sum_max: 10, confidence_max_delta: 0.05, risk_flags: 'exact match' },
  symbols: symbolReports,
  overall: {
    pass_count: passCount,
    fail_count: failCount,
    worst_symbol: worstSymbol?.symbol ?? null,
    worst_score_delta: worstSymbol?.score_range.delta ?? 0,
    worst_component: worstComponent?.component ?? null,
    worst_component_delta: worstComponent?.delta ?? 0,
  },
  interpretation: 'Measures deterministic scoring from identical frozen, source-cited normalized observations in isolated Node processes; it does not measure independent extraction of facts from raw documents.',
};

const summaryPath = path.join(outputRoot, 'stability_report.json');
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
const lines = [
  '# Fundamental Scoring Rubric V2 再現性テスト',
  '',
  `- as_of: ${summary.as_of} (${summary.as_of_timezone})`,
  `- 採点プロセス: ${summary.independent_process_count}件（銘柄ごとに3回）`,
  '- 比較前検証: 全runでV2 validator・V1互換validatorの双方を通過',
  `- ticker判定: ${passCount} PASS / ${failCount} FAIL`,
  '- このテストは同一の一次資料参照・凍結観測値からの採点器再現性を測定し、一次資料からの独立した事実抽出再現性は測定しない。',
  '',
  '| 銘柄 | run | 総合点 | material | earnings | growth | financial | capital | governance | catalyst | confidence | risk_flags |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
];
for (const report of symbolReports) {
  for (const run of report.runs) {
    const values = COMPONENT_ORDER.map((component) => run.components[component]);
    lines.push(`| ${report.symbol} | ${run.run} | ${run.fundamental_score} | ${values.join(' | ')} | ${run.confidence.toFixed(2)} | ${run.risk_flags.join(', ') || 'なし'} |`);
  }
  lines.push(`| ${report.symbol} | 差分上限 | ${report.score_range.delta} | ${COMPONENT_ORDER.map((component) => report.component_max_delta[component]).join(' | ')} | ${report.confidence_range.delta.toFixed(2)} | flags ${report.risk_flags_consistent ? '一致' : '不一致'} |`);
}
lines.push('', '## 銘柄別安定性指標', '', '| 銘柄 | score_range | component_abs_delta_sum_max | risk_flags_consistent | confidence_range | stability_pass |', '|---|---:|---:|---|---:|---|');
for (const report of symbolReports) {
  lines.push(`| ${report.symbol} | ${report.score_range.min}–${report.score_range.max} (Δ${report.score_range.delta}) | ${report.component_abs_delta_sum_max} | ${report.risk_flags_consistent} | ${report.confidence_range.min.toFixed(2)}–${report.confidence_range.max.toFixed(2)} (Δ${report.confidence_range.delta.toFixed(2)}) | ${report.stability_pass ? 'PASS' : 'FAIL'} |`);
}
lines.push('', '## 全体', '', '| 指標 | 結果 |', '|---|---:|', `| pass_count | ${passCount} |`, `| fail_count | ${failCount} |`, `| worst_symbol | ${worstSymbol?.symbol ?? 'なし（全銘柄同差）'} |`, `| worst_score_delta | ${worstSymbol?.score_range.delta ?? 0} |`, `| worst_component | ${worstComponent?.component ?? 'なし（全項目同差）'} |`, `| worst_component_delta | ${worstComponent?.delta ?? 0} |`, '');
const markdownPath = path.join(outputRoot, 'stability_report.md');
fs.writeFileSync(markdownPath, `${lines.join('\n').trimEnd()}\n`, 'utf8');
console.log(JSON.stringify({ outputRoot, summaryPath, markdownPath, overall: summary.overall }, null, 2));
if (failCount > 0) process.exitCode = 1;
