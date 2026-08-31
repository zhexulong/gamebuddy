# Nudge hygiene calibration — 2026-08-16

This is a report-only replay of the frozen `severity = clamp(U / max(T, 1), 0, 1)` formula. No thresholds or constants were changed.

## Method

- Replayed the three requested session IDs from the supplied `context-snapshot.db` VACUUM-INTO copy and paired OpenCode raw-message snapshot.
- Opened both inputs read-only and enabled SQLite `PRAGMA query_only`.
- Required `MAGIC_CONTEXT_TEST_DATA_DIR`; the replay refuses inputs or outputs outside that directory.
- Reconstructed each final live tail after its latest compartment coverage boundary, applied persisted drops and strip transforms, then ran the same part-typed TypeScript hygiene walk used by the nudge baseline.
- Used the default protected reserve of 20 tags. Reasoning, synthetic messages, reminder spans, and dropped sentinels were excluded by the production walk.

Reproduction:

```sh
MAGIC_CONTEXT_TEST_DATA_DIR="$PWD/.fixture" \
  bun packages/plugin/scripts/nudge-hygiene-calibration.ts \
  --output "$PWD/.fixture/nudge-hygiene-calibration.json"
```

## Results

| Snapshot | Session | U | T | Severity | Band |
|---|---|---:|---:|---:|---|
| Primary 872k | `ses_331acff95fferWZOYF1pG0cjOn` | 67,168 | 74,545 | 0.901 | channel2 |
| Sol Mason seat | `ses_ff4877c64ffeuz39TRkYrWS2eg` | 151,151 | 159,540 | 0.947 | channel2 |
| Fresh session | `ses_ff48ad7efffeL51ppGolXXefEd` | 93,780 | 108,817 | 0.862 | channel2 |

Severity distribution by band:

| Band | Count |
|---|---:|
| quiet | 0 |
| gentle | 0 |
| firm | 0 |
| urgent | 0 |
| channel2 | 3 |

The current snapshots all land in channel2. This report does not change the owner-set bands; any threshold adjustment requires owner sign-off.

## Positive control and walk cost

- Flagship positive control: `U=162,000`, `T=249,000`, severity `0.651` → **channel2**.
- A 249,008-token rendered-tail fixture measured **2.108 ms p95** over 31 warm-memo walks, below the frozen `<15 ms p95` gate.
