# Experimental Fundamental Scoring

- This directory is non-production. Keep changes, fixtures, generated audits, and reports inside `premium_worker/experimental/`; do not modify or invoke the production posting path, GAS, ordinary-report schema, Discord, spreadsheets, or production state.
- Keep the existing seven Premium component names, order, maxima, and V1-compatible sidecar keys. Store bands, evidence allocations, and test metadata in separate audit/report files; never merge them into ordinary reports or `premium_reports.json`.
- Scores, confidence, and risk flags must derive from explicit normalized observations and fixed rules. Allocate each `evidence_id` to one scored component; risk flags are explanatory indicators, not additional deductions. Do not tune rules to earlier scores or add ticker-specific conditions.
- For a rubric change, run the V1 and V2 unit tests, then run at least three isolated same-`as_of` scoring processes per fixed case. Every output must pass both validators before score comparison.
- A passing 3-symbol × 3-run test is not approval to integrate. Expand to a blind 10-symbol test, then 30 symbols, and meet the declared stability gates before considering production integration. Do not optimize against return correlations before the stability stage passes.
