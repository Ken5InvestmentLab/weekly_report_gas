# Fundamental Scoring Rubric V2 再現性テスト

- as_of: 2026-09-11 (Asia/Tokyo)
- 採点プロセス: 9件（銘柄ごとに3回）
- 比較前検証: 全runでV2 validator・V1互換validatorの双方を通過
- ticker判定: 3 PASS / 0 FAIL
- このテストは同一の一次資料参照・凍結観測値からの採点器再現性を測定し、一次資料からの独立した事実抽出再現性は測定しない。

| 銘柄 | run | 総合点 | material | earnings | growth | financial | capital | governance | catalyst | confidence | risk_flags |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 3121 | 1 | 36 | 10 | 5 | 4 | 4 | 3 | 5 | 5 | 0.90 | dilution, liquidity |
| 3121 | 2 | 36 | 10 | 5 | 4 | 4 | 3 | 5 | 5 | 0.90 | dilution, liquidity |
| 3121 | 3 | 36 | 10 | 5 | 4 | 4 | 3 | 5 | 5 | 0.90 | dilution, liquidity |
| 3121 | 差分上限 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.00 | flags 一致 |
| 6696 | 1 | 30 | 5 | 1 | 4 | 11 | 3 | 3 | 3 | 0.70 | dilution, lawsuit |
| 6696 | 2 | 30 | 5 | 1 | 4 | 11 | 3 | 3 | 3 | 0.70 | dilution, lawsuit |
| 6696 | 3 | 30 | 5 | 1 | 4 | 11 | 3 | 3 | 3 | 0.70 | dilution, lawsuit |
| 6696 | 差分上限 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.00 | flags 一致 |
| 7211 | 1 | 51 | 10 | 10 | 8 | 8 | 5 | 5 | 5 | 0.80 | なし |
| 7211 | 2 | 51 | 10 | 10 | 8 | 8 | 5 | 5 | 5 | 0.80 | なし |
| 7211 | 3 | 51 | 10 | 10 | 8 | 8 | 5 | 5 | 5 | 0.80 | なし |
| 7211 | 差分上限 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.00 | flags 一致 |

## 銘柄別安定性指標

| 銘柄 | score_range | component_abs_delta_sum_max | risk_flags_consistent | confidence_range | stability_pass |
|---|---:|---:|---|---:|---|
| 3121 | 36–36 (Δ0) | 0 | true | 0.90–0.90 (Δ0.00) | PASS |
| 6696 | 30–30 (Δ0) | 0 | true | 0.70–0.70 (Δ0.00) | PASS |
| 7211 | 51–51 (Δ0) | 0 | true | 0.80–0.80 (Δ0.00) | PASS |

## 全体

| 指標 | 結果 |
|---|---:|
| pass_count | 3 |
| fail_count | 0 |
| worst_symbol | なし（全銘柄同差） |
| worst_score_delta | 0 |
| worst_component | なし（全項目同差） |
| worst_component_delta | 0 |
