#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { validateFundamentalScore } from './fundamental_scoring_v1.mjs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node validate_fundamental_scores_v1.mjs <scores.json>');
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
const records = Array.isArray(data) ? data : data.scores;
if (!Array.isArray(records) || records.length === 0) {
  throw new Error('score file must be a non-empty array or { scores: [...] }');
}

const seen = new Set();
const errors = [];
for (let i = 0; i < records.length; i++) {
  const record = records[i];
  const prefix = `record[${i}]`;
  if (!String(record.alertId || '').trim()) errors.push(`${prefix}: alertId is required`);
  else if (seen.has(record.alertId)) errors.push(`${prefix}: duplicate alertId ${record.alertId}`);
  else seen.add(record.alertId);

  const result = validateFundamentalScore(record);
  for (const error of result.errors) errors.push(`${prefix}: ${error}`);
  if (String(record.rationale || '').trim().length < 10) errors.push(`${prefix}: rationale is too short`);
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, count: records.length, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  count: records.length,
  scoreMin: Math.min(...records.map(r => r.fundamental_score)),
  scoreMax: Math.max(...records.map(r => r.fundamental_score)),
  scoreAvg: +(records.reduce((s, r) => s + r.fundamental_score, 0) / records.length).toFixed(2)
}, null, 2));
