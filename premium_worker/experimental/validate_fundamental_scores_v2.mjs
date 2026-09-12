#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { COMPONENT_ORDER, RISK_FLAGS, SCORE_FIELDS, scoreFactsV2 } from './fundamental_scoring_v2.mjs';
import { validateFundamentalScore } from './fundamental_scoring_v1.mjs';

const [scorePath, auditPath, fixturePath] = process.argv.slice(2);
if (!scorePath || !auditPath || !fixturePath) {
  console.error('usage: node validate_fundamental_scores_v2.mjs <scores.json> <audit.json> <single-case-fixture.json>');
  process.exit(2);
}

const scoresData = JSON.parse(fs.readFileSync(path.resolve(scorePath), 'utf8'));
const audit = JSON.parse(fs.readFileSync(path.resolve(auditPath), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(path.resolve(fixturePath), 'utf8'));
if (!Array.isArray(fixture.cases) || fixture.cases.length !== 1) throw new Error('fixture must contain exactly one case');
if (!Array.isArray(scoresData.scores) || scoresData.scores.length !== 1) throw new Error('scores.json must contain exactly one sidecar score');

const errors = [];
const score = scoresData.scores[0];
const sourceRegistry = fixture.sources || {};
const testCase = fixture.cases[0];
const expectedKeys = ['alertId', 'symbol', 'as_of', ...COMPONENT_ORDER, 'fundamental_score', 'confidence', 'risk_flags', 'rationale'].sort();
if (!isDeepStrictEqual(Object.keys(score).sort(), expectedKeys)) errors.push('sidecar keys differ from the V1-compatible schema');
if (score.symbol !== testCase.symbol || score.alertId !== testCase.alertId || score.as_of !== fixture.as_of || testCase.as_of !== fixture.as_of) {
  errors.push('score identity/as_of does not match the frozen case');
}

for (const sourceId of testCase.sources || []) {
  const source = sourceRegistry[sourceId];
  if (!source) errors.push(`unknown source id: ${sourceId}`);
  else {
    if (source.primary !== true) errors.push(`source is not primary: ${sourceId}`);
    if (source.published_at > fixture.as_of) errors.push(`source is after as_of: ${sourceId}`);
    if (!/^https:\/\//.test(source.url)) errors.push(`source URL must be HTTPS: ${sourceId}`);
  }
}

const evidenceComponent = new Map();
for (const component of COMPONENT_ORDER) {
  const observation = testCase.observations?.[component];
  if (!observation || !Array.isArray(observation.evidence_ids) || observation.evidence_ids.length === 0) {
    errors.push(`${component} has no evidence_ids`);
    continue;
  }
  for (const evidenceId of observation.evidence_ids) {
    if (evidenceComponent.has(evidenceId) && evidenceComponent.get(evidenceId) !== component) {
      errors.push(`evidence ${evidenceId} is scored in multiple components`);
    }
    evidenceComponent.set(evidenceId, component);
    const evidence = testCase.evidence?.[evidenceId];
    if (!evidence) {
      errors.push(`missing evidence registry entry: ${evidenceId}`);
      continue;
    }
    if (!Array.isArray(evidence.source_ids) || evidence.source_ids.length === 0) errors.push(`${evidenceId} has no source_ids`);
    for (const sourceId of evidence.source_ids || []) {
      if (!(testCase.sources || []).includes(sourceId)) errors.push(`${evidenceId} uses source outside case: ${sourceId}`);
      if (!sourceRegistry[sourceId]) errors.push(`${evidenceId} uses unknown source: ${sourceId}`);
    }
  }
}
for (const evidenceId of Object.keys(testCase.evidence || {})) {
  if (!evidenceComponent.has(evidenceId)) errors.push(`unallocated evidence: ${evidenceId}`);
}
for (const issue of testCase.observations?.governance_legal?.issues || []) {
  if (evidenceComponent.get(issue.evidence_id) !== 'governance_legal') errors.push(`governance issue evidence is not allocated only to governance_legal: ${issue.evidence_id}`);
}

const v1Result = validateFundamentalScore(score);
for (const error of v1Result.errors) errors.push(`V1 compatibility: ${error}`);
if (Array.isArray(score.risk_flags)) {
  if (new Set(score.risk_flags).size !== score.risk_flags.length) errors.push('risk_flags contains duplicates');
  if (!isDeepStrictEqual(score.risk_flags, [...score.risk_flags].sort())) errors.push('risk_flags must be sorted deterministically');
  for (const flag of score.risk_flags) if (!RISK_FLAGS.includes(flag)) errors.push(`unknown V2 risk flag: ${flag}`);
}
if (typeof score.confidence === 'number' && Math.round(score.confidence * 20) !== score.confidence * 20) errors.push('confidence must use 0.05 increments');

let expected;
try {
  expected = scoreFactsV2({ ...testCase, as_of: fixture.as_of, sources: fixture.sources, japan_holidays: fixture.japan_holidays });
  if (!isDeepStrictEqual(score, expected.score)) errors.push('sidecar score does not match the V2 deterministic rubric');
  if (!isDeepStrictEqual(audit, expected.audit)) errors.push('audit does not match the V2 evidence/band allocation');
} catch (error) {
  errors.push(`recalculation failed: ${error.message}`);
}

if (audit.symbol !== testCase.symbol || audit.as_of !== fixture.as_of || audit.rubric_version !== 2) errors.push('audit identity/version mismatch');
const auditAllocations = Array.isArray(audit.evidence_allocation) ? audit.evidence_allocation : [];
if (auditAllocations.length !== evidenceComponent.size) errors.push('audit evidence allocation count mismatch');
for (const allocation of auditAllocations) {
  if (evidenceComponent.get(allocation.evidence_id) !== allocation.applied_component) errors.push(`invalid audit allocation for ${allocation.evidence_id}`);
  if (!allocation.source_ids?.every((sourceId) => (testCase.sources || []).includes(sourceId))) errors.push(`invalid audit source mapping for ${allocation.evidence_id}`);
}
for (const [flag, evidenceIds] of Object.entries(audit.risk_flag_evidence || {})) {
  if (!score.risk_flags.includes(flag)) errors.push(`audit maps an inactive risk flag: ${flag}`);
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) errors.push(`risk flag lacks evidence: ${flag}`);
}
for (const flag of score.risk_flags || []) {
  if (!(audit.risk_flag_evidence || {})[flag]) errors.push(`risk flag lacks deterministic evidence map: ${flag}`);
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, symbol: score.symbol, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, symbol: score.symbol, total: score.fundamental_score, confidence: score.confidence, risk_flags: score.risk_flags, source_count: testCase.sources.length, evidence_count: auditAllocations.length }, null, 2));
