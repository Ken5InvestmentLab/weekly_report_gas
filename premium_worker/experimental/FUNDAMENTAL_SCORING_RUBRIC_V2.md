# Fundamental Scoring Rubric V2

## Scope and compatibility

V2 is an experiment-only deterministic scorer. It reads a frozen, source-cited observation fixture and writes the existing Premium sidecar shape. It does not edit or import the production posting path, `worker.mjs`, GAS, spreadsheets, Discord, ordinary-report JSON, or production state. The Premium Report's existing seven component names/order and their 100-point maxima remain unchanged. `fundamental_score`, `confidence`, `risk_flags`, and `rationale` retain the V1 sidecar contract. The component-band audit is stored separately and is never merged into the score JSON.

## Band anchors

The normal path is `observed fact -> deterministic band -> fixed score`. The maximum per component is unchanged.

| Component | Strong positive | Moderate positive | Neutral | Moderate negative | Strong negative |
|---|---:|---:|---:|---:|---:|
| `material_impact` | 18 | 15 | 10 | 5 | 1 |
| `earnings_quality` | 18 | 15 | 10 | 5 | 1 |
| `growth_visibility` | 14 | 11 | 8 | 4 | 1 |
| `financial_strength` | 14 | 11 | 8 | 4 | 1 |
| `capital_structure` | 9 | 7 | 5 | 3 | 1 |
| `governance_legal` | 9 | 7 | 5 | 3 | 1 |
| `catalyst_quality` | 9 | 7 | 5 | 3 | 1 |

The seven maxima sum to 100. No model supplies a free-form point value.

## Component rules

### `material_impact`

This scores the incremental economic effect, not recency. A newly revised full-year operating-profit forecast is strong positive/negative at a change of at least 20% of the prior forecast and moderate at 5–20%; below 5% is neutral. Repeated or previously disclosed revisions do not create a new score. An unforecast contract is moderate positive at 20% of annual revenue and strong at 50%; amounts already included in guidance are ignored. Where a period result can be compared to a time-prorated company plan, the operating-profit gap is divided by annual revenue: at or below −10% is strong negative, −5% to −10% moderate negative, +5% to +10% moderate positive, and at least +10% strong positive. The interval between −5% and +5% is neutral. No revision, no material unforecast contract, and no material plan gap yields neutral. Year-over-year percentage growth alone is not an input to this component.

### `earnings_quality`

The fixed rules consider operating profit, operating margin, operating-profit growth, net-income direction, operating cash flow, and quantified one-off/valuation effects. An operating loss with margin at or below −20%, net loss, and negative latest operating cash flow is strong negative. An operating loss, net loss, or one-off/valuation effect at least 25% of operating profit is moderate negative. Strong positive requires operating-profit growth at least 30%, margin at least 10%, positive net income and operating cash flow, and one-off impact below 10%. Moderate positive uses growth at least 15% and margin at least 5% with the same other conditions. Remaining positive operating profit and positive net income are neutral; otherwise moderate negative. A narrative claim of “earnings growth” without the metrics above has no scoring effect.

### `growth_visibility`

Strong positive requires quantified recurring-metric growth of at least 20% and secured backlog of at least 50% of annual revenue. Moderate positive requires at least 10% recurring growth and backlog of at least 25%. A revenue decline of 25% or more, or plan progress below 50% of elapsed-time progress, is strong negative. A decline greater than 10% in revenue or leading activity, or plan progress below 75%, is moderate negative. Unquantified strategy, a one-off order, or an unsupported forecast is not positive growth visibility.

### `financial_strength`

All amounts in a case use the same currency and scale. The operating-company tests use cash/debt, equity ratio, 12-month maturity coverage, operating cash flow, and interest coverage. Two or more of equity below 25%, negative operating cash flow, interest coverage below 2, and cash/debt below 0.5 produce moderate negative; three or more severe tests (equity below 15%, negative operating cash flow, interest coverage below 1, or net debt with 12-month cash coverage below 0.25) produce strong negative. Equity at least 50%, cash at least equal to debt, and 12-month coverage at least 2 are moderate positive; the same plus positive cash flow is strong positive. Equity at least 30%, nonnegative cash flow, and interest coverage at least 2 (or unavailable) are neutral when no negative anchor applies.

For property-investment models, gross debt alone is not a negative trigger. Equity below 20% plus severe cash-maturity or interest coverage is strong negative. Cash/current maturities below 0.5 or interest coverage below 2 is moderate negative. Equity at least 40%, cash/current maturities at least 1, interest coverage at least 3, and nonnegative operating cash flow is moderate positive; otherwise neutral. Missing coverage is not treated as positive evidence. `debt_excess` and `liquidity` are flags, not additional score deductions.

### `capital_structure`

Potential dilution is `unexercised potential shares / issued shares`, excluding shares already issued. Fixed-price and market-price-resettable instruments are distinguished. For fixed-price potential dilution, the fixed sub-band scores are: 0–5%: 5; over 5–10%: 4; over 10–20%: 3; over 20–30%: 2; over 30%: 1. A resettable/MS warrant reduces the bucket score by a further fixed 2 points (floor zero) and independently emits `ms_warrant`. If no current potential-share amount can be verified, the score is neutral and confidence is lowered; the scorer does not infer that the amount is zero. Fully exercised historical issuance is excluded.

### `governance_legal`

Issues are classified as `lawsuit`, `accounting_issue`, `disclosure_issue`, `regulatory_issue`, or `governance_issue`. For pending lawsuits, the claim is compared with net assets: at least 50% and a quantified provision below half the claim is strong negative. A claim at least 50% with a provision at or above half, or with provision status undisclosed, is moderate negative; claims at least 10% are moderate negative when less than half is provided or provision status is unknown. Thus missing provision information is not silently converted to a zero provision. Smaller claims do not trigger a score deduction from the lawsuit category alone. A closed or fully remediated issue is not active. Material accounting, formal disclosure, regulatory, and governance issues have separate explicit predicates in the scorer. An explicit going-concern disclosure maps to strong negative and an explicit listing-risk disclosure to moderate negative. Risk flags do not themselves change the score. A lawsuit evidence item is allocated to `governance_legal`; its flag does not subtract again in material impact or catalyst quality.

### `catalyst_quality`

The scorer derives elapsed Japanese business sessions from the event date, `as_of`, and the fixture holiday list. Freshness contributes 2/1/0/−1 for 0–1/2–5/6–20/>20 sessions. Timing contributes +2 for within five business days, +1 for a later known date, 0 for occurred/unspecified-neutral timing, and −1 when unknown. Novelty is +1 for new, 0 for planned, and −1 for repeated material. Amount clarity is +1 for exact, 0 for a range, and −1 for qualitative-only. A direct near-term business link contributes +1; its absence contributes −1. The resulting catalyst-strength total is mapped to a band; direction selects the band's sign. Positive catalyst strength at 6 or more is strong positive, 4–5 moderate positive, 2–3 neutral, 0–1 moderate negative, and below 0 strong negative. Negative direction at 6 or more is strong negative, 4–5 moderate negative, and lower values neutral. Mixed/neutral direction maps to neutral. Thus freshness alone cannot produce a high score, and material size is not re-scored here.

### `confidence`

Confidence starts at 1.00 and is reduced mechanically: missing primary financial statement −0.20; latest cash flow missing −0.05; unquantified legal impact −0.05; unresolved legal outcome −0.10; incomplete capital terms −0.10; unquantified material amount −0.05; conflicting sources −0.10; valuation-only asset coverage proxy −0.05; incomplete primary-disclosure scan −0.05; missing comparable period −0.05. The result is clamped to 0.50–1.00 and rounded to 0.05 increments. This is an evidence-completeness index, not a subjective probability.

## Deterministic flags and overlap controls

Flags are generated from facts, never free-form prose:

| Flag | Trigger |
|---|---|
| `dilution` | quantified potential shares exceed 5% of issued shares |
| `ms_warrant` | an active market-price-resettable warrant is disclosed |
| `debt_excess` | operating model: debt / positive net assets at least 2.0 or interest cover below 1.2; property-investment model: debt / book-value property-asset proxy at least 0.85 or interest cover below 1.2 |
| `liquidity` | cash / debt due within 12 months is below 0.5 |
| `lawsuit` | a formal lawsuit is not closed/remediated |
| `accounting_issue` | an unresolved material accounting issue is disclosed |
| `disclosure_issue` | a formal delay/material correction is not fully remediated |
| `regulatory_issue` | an unresolved formal regulatory action is disclosed |
| `going_concern` | the issuer explicitly discloses going-concern material uncertainty |
| `listing_risk` | the issuer/exchange explicitly discloses listing-risk status |

Each score observation has `evidence_id` entries mapped to exactly one component. A source document may support distinct factual observations, but the same evidence ID cannot be allocated to multiple scored components. The sidecar's risk flag maps to the component that owns the evidence and never acts as an extra point deduction. Audit/band details remain in a separate file.

## Reproducibility protocol

`reproduce_fundamental_scoring_v2.mjs` creates nine isolated one-case fixtures (3 symbols × 3 runs) at the identical `as_of`. Each scoring run is a fresh Node process and sees only its symbol's frozen source manifest and normalized facts. Each output must pass `validate_fundamental_scores_v2.mjs` and the existing V1 validator before the runner reads any result for pairwise comparison. V2 validation checks the strict sidecar keys, source cutoff, V1 schema and total, deterministic re-calculation, component/evidence allocation, and flag evidence.

The test evaluates deterministic mapping from source-cited normalized observations to scores. It does not claim that three independent extractors would normalize raw disclosures identically. That is a separate future blind-extraction test. No score is tuned to previous runs or to named-company special cases.

Run from the repository root:

```powershell
node premium_worker/experimental/test_fundamental_scoring_v1.mjs
node premium_worker/experimental/test_fundamental_scoring_v2.mjs
node premium_worker/experimental/reproduce_fundamental_scoring_v2.mjs
```

Generated per-run inputs, sidecars, audits, validator logs, and stability summaries live under `premium_worker/experimental/repro_results/` only. No production bot integration is authorized before broader blind tests pass.
