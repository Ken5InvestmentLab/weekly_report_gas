#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { scoreFactsV2 } from './fundamental_scoring_v2.mjs';

const [fixturePath, scorePath, auditPath] = process.argv.slice(2);
if (!fixturePath || !scorePath || !auditPath) {
  console.error('usage: node score_fundamental_scoring_v2.mjs <single-case-fixture.json> <scores.json> <audit.json>');
  process.exit(2);
}

const fixture = JSON.parse(fs.readFileSync(path.resolve(fixturePath), 'utf8'));
if (!Array.isArray(fixture.cases) || fixture.cases.length !== 1) {
  throw new Error('fixture must contain exactly one case');
}
const result = scoreFactsV2({ ...fixture.cases[0], as_of: fixture.as_of, sources: fixture.sources, japan_holidays: fixture.japan_holidays });
fs.mkdirSync(path.dirname(path.resolve(scorePath)), { recursive: true });
fs.mkdirSync(path.dirname(path.resolve(auditPath)), { recursive: true });
fs.writeFileSync(path.resolve(scorePath), `${JSON.stringify({ scores: [result.score] }, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.resolve(auditPath), `${JSON.stringify(result.audit, null, 2)}\n`, 'utf8');
process.stdout.write(JSON.stringify({ symbol: result.score.symbol, total: result.score.fundamental_score, confidence: result.score.confidence, risk_flags: result.score.risk_flags }));
