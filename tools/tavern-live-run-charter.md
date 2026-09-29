# GameBuddy Tavern release live-run charter (SFW, original)

> **Purpose:** understand what the implemented Tavern release profile is supposed to do, and get its verdict. The verdict itself comes from one automated command (§2) — no operator record, no human observation requirement. This document is not a model leaderboard, does not execute SillyTavern runtime behavior, and does not substitute for parser/fuzz, migration, Magic Context fork, Pi partition, Game Action, or target-game live gates.
>
> **Chat mainline profile:** The active Chat mainline uses the distinct `chat-tavern-live` profile and must pass its repository-owned live orchestrator before the Chat mainline is called release-ready. That profile uses a GameBuddy-owned source-built disposable Chat artifact/runtime and does not depend on the full Windows production pointer, GitHub Actions release artifact, Windows reparse enforcement, guardian, or bundled-runtime gate. Passing it is a Chat/Tavern live claim only; the full Windows release gate remains separate. The profile must still execute real embedded provider turns and real mounted management UI operations with durable read-back; static profile declarations, fixtures, a single happy-path smoke, or retry-after-failure are not substitutes.
>
> **Normative BDD:** [`design/09_BDD_VALIDATION_PLAN.md`](../design/09_BDD_VALIDATION_PLAN.md), scenario **Tavern release live run 只在自动前置通过后验证真实交互闭环**. The implementation scope and release-profile declaration belong to [`design/24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md`](../design/24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md).

<!-- tavern-release-must-flow-coverage
companion-library=TVL-00
manage-chats=TVL-00
new-companion=TVL-02
new-chat=TVL-03
persona-scenario-greeting-selection=TVL-03
effect-aware-causal-guard=TVL-06
worldbook-catalog-binding=TVL-03
character-worldbook-chat-import-export=TVL-01
authenticated-reconnect=TVL-05
memory-management=TVL-09
-->

## 1. Preconditions — what the gate checks, and what you must not assume

The gate performs 1–4 itself and reports their true outcome; you do not need to pre-check anything by hand. Do not compensate for a false prerequisite with manual UI actions — a `blocked` verdict means the run must not be claimed.

1. The automated prerequisites pass. `pnpm check:tavern-release-prerequisites --profile chat-tavern-live` must exit zero with `verdict: "passed"`; the gate runs this itself. In particular, `magic_context_source_contract_only` is a blocked prerequisite, not a manually waivable warning.
2. The build's versioned release profile is known. The `chat-tavern-live` profile deliberately does not run the Windows security prerequisites; they report `not_applicable` instead of passing, and it makes no `fullReleaseClaim`.
3. The version-locked Magic Context stable-source lifecycle tests and the locked SillyTavern semantic-reference anchors pass for this exact vendor revision. Manifest mapping, source markers, or static tests alone never satisfy this prerequisite; it is not a live-pass substitute either.
   - stable-context source/marker/render/fail-closed contract;
   - Character/WorldBook safe-subset import and malicious-input tests;
   - artifact migration, atomic write, revision conflict and read-back tests;
   - opening/message-0/blank/resume tests;
   - Tavern message-command surface guard and browser isolation tests;
   - every enabled L3 flow's own automated contract.
   > The per-`must`-flow mapping (each flow to `TVL-00`–`TVL-09`, with a declared Host route, a durable artifact/operation marker and a compiled contract-test marker) described in [design/09](../design/09_BDD_VALIDATION_PLAN.md) is **not yet implemented** in this prerequisite checker. Do not read this list as a claim that it is enforced: the checker currently establishes the stable-source and semantic-reference prerequisites only, and the flow-level checklist below is the operator-facing exploration, not an automatic gate input.
4. A fresh GameBuddy-owned runtime root has been created outside the repository. Do not use system `pi`, `~/.pi`, pre-existing Pi sessions, user extensions, skills, prompts, configuration or credentials.
5. If you intend to run the §3 manual exploration, use an original, SFW fixture set with the locked fixture-manifest hash. Do not use community Character cards, copied benchmarks, private chat logs, or unreviewed WorldBooks. The gate itself does not need this.
6. The current build, Magic Context vendor version, model/provider configuration, compatibility manifest and semantic-reference registry are known before any run. The gate records the ones it can verify itself; it never asks you to transcribe them into a record.

The regular current-Web-Chat research baseline remains [`dialogue-live-run-charter.md`](dialogue-live-run-charter.md). Do not claim that its `DLG-BASE-*` result is a Tavern release result.

## 2. Evidence hygiene

Collect and keep only opaque IDs, hashes, counters and non-contentful outcomes. Do **not** retain raw dialogue by default and never capture or display:

```text
system prompt / prompt wire / m[0] or m[1] text / Magic Context SQLite or blocks
thinking / tool trace or result / receipt payload / provider payload / credentials
Pi JSONL or internal session path / bridge token / unconsented audio
```

The release gate enforces this itself: its evidence is opaque by construction (lowercase-hex IDs and SHA-256 hashes only), and the report writer that persists its output rejects any content-bearing field. A price of that is that the gate cannot read a free-text note even if you write one — there is deliberately no field for it.

A fluent model response is not evidence that persistence, source placement, privacy or surface isolation worked.

### The machine-readable live verdict

There is **no operator record**. The gate never asks a human to observe a run, and no supplied document can stand in for run evidence. One command produces the verdict:

```bash
node tools/run-tavern-release-live-gate.mjs --orchestrate --profile chat-tavern-live
```

It runs the automated prerequisites itself, then drives the real `main`/`failure`/`recovery` narrative attempts through the production composition bootstrap. Its verdict is derived, never asserted:

- **`passed`** (exit 0) — the automated prerequisites genuinely pass, every planned run carries its own production artifact identity plus an observed real embedded provider turn, and the mounted `ComposedTavernProfile` operation-to-evidence mapping validates against the exact mounted profile.
- **`blocked`** (exit 2) — an automated prerequisite is missing or failing. No narrative run is attempted; `blocked` is never papered over with attempts.
- **`inconclusive`** (exit 2) — evidence is incomplete or contradictory: a planned run is missing or did not genuinely pass, or the operation evidence is absent or does not match the mounted profile.

`--mounted-profile <profile.json>` and `--operation-evidence-mapping <mapping.json>` supply the mounted-profile evidence that the report cannot derive by itself; `--report <path>` writes a create-only content-free copy. The orchestrator's real run summaries and operation evidence are release-gate inputs, not product-path facts.

The mapping is validated against the exact mounted profile: the identity must match either by the exact profile object or by the `profile_id` + canonical `profile_hash` pair, every mapped operation must be one the profile declares, and every evidence ID must be opaque. The one optional key is `evidence_kind`, which may be `"automation_evidence"` — the label `tools/record-tavern-ui-operation-evidence.mjs` stamps on the mapping it exports from the authenticated UI/API run — and nothing else. Any other evidence kind, and any key beyond that schema, fails closed, so the mapping can never carry a note, a caption, or a claim.

### Not part of this gate

Semantic quality and long-term memory consolidation are **audit** work, not gate criteria. They produce readable measurements and root-cause attribution via `chat_run_audit/v1` (and the run-to-run comparison tooling), and they do not block the Chat mainline release. The only correctness failure this gate is a boundary for is an explicit one such as cross-continuity Memory leakage; model fluency, persona fidelity, prose quality and needle-fact recall are measured there, not gated here.

## 3. Manual exploration runbook (optional)

This section is a **manual exploratory runbook** for a human driving the local authenticated loopback Tavern UI. It is not the release gate and it produces no release verdict: nothing here is required to run, and no human observation is required to release. The gate in §2 is the only pass/blocked/inconclusive authority. Use this section when you want to look at the product by hand.

Use the local authenticated loopback Tavern UI only. The participant may stop at any time.

| Step | Participant action | Expected observable result | Evidence if you keep any |
|---|---|---|---|
| `TVL-00` | Open the authenticated loopback Tavern UI and inspect the Companion Library and Recent/Manage Chats. | Only the release profile's Library and chat-management flows are enabled; later/unsupported flow controls are absent or unavailable. | release-profile/UI evidence ID |
| `TVL-01` | Import the original SFW ST-compatible fixture. | Preview/report classifies all fields; unsupported active fields are reported and not executed. No running Companion changes. | import-report ID + candidate ID |
| `TVL-02` | Review approved material and choose **Create New Companion**. | A new opaque Companion/Continuity and profile revision are created; no existing Companion is silently changed. | artifact read-back IDs |
| `TVL-03` | Create a New Chat; choose the profile's Persona and effective Scenario; choose first, alternate or blank opening. | The selected opening is durable before display as message 0, or the durable `blank` sentinel creates no empty bubble. Source/provenance is visible only through the approved player-facing UI. | thread/opening read-back ID |
| `TVL-04` | Conduct an original multi-turn SFW Chat. | Each player-visible Companion response is an explicit approved presentation; ordinary output and internals remain invisible. Scenario and actual dialogue history/Memory can coexist, but Scenario is not shown as Live World fact. | neutral lifecycle/presentation evidence IDs |
| `TVL-05` | Refresh, reconnect SSE, then restart Host using the same owned runtime root. | The exact ChatThread and selected opening/transcript resume. No new Chat, opening replay, prompt/internal-history display, or silent continuity change occurs. | before/after thread read-back IDs |
| `TVL-06` | **Only if** the release profile declares a Chat-only message operation as `must`, operate on the newest eligible pure-Tavern reply (for example its enabled retry/swipe path). Otherwise mark this row `not_applicable`. | Only an enabled Tavern operation is available; it remains bound to the active Tavern thread/message and preserves the configured causal guard. | command + thread read-back IDs |
| `TVL-07` | Attempt no unsupported feature. Verify the current UI against the release profile. | `later` flows remain hidden/unavailable and explicitly unsupported flows are not implied by imported metadata or SillyTavern names. | release-profile/UI evidence ID |
| `TVL-09` | Open the authenticated Memory panel; create an original semantic Memory, edit it with the returned current revision, then archive/restore it. If the UI offers `INTERACTION_EPISODE`, attempt only an original player–Companion interaction episode; do not record a tool/action/snapshot workflow. | The panel operates only in the active opaque Continuity. Player mutations use current-revision conflict protection, affect only the structured Memory entry, and never expose raw history, Pi JSONL, prompts, receipts, or Magic Context storage. Archive/restore changes injection eligibility without claiming source-history erasure. | memory operation/read-back IDs |

Do not attempt Game Action, Game UI manipulation, or a Tavern message operation on a Game presentation during this run.

## 4. Optional cross-surface step

Only run `TVL-08` when the release profile explicitly declares Chat → Game → exact-origin-Chat return as a Tavern `must` flow **and** the formal Game binding/fresh-snapshot gate for the build has independently passed.

| Step | Participant action | Required observable result |
|---|---|---|
| `TVL-08` | Enter Game from the current Tavern thread and return through the formal surface flow. | Game has no Tavern message handles, bubbles, replay/edit/swipe/branch operations, or Scenario-as-Live-World presentation. Return restores the exact origin ChatThread without replaying Greeting, copying/summarizing Context, or claiming Game fact rollback. |

This is a surface-lifecycle check only. It does not satisfy a Farmhand, Game Action, Portfolio, or companion-experience live gate.

## 5. Verdict

The verdict is the gate's, not a reader's. `node tools/run-tavern-release-live-gate.mjs --orchestrate --profile chat-tavern-live` derives it from evidence and exits 0 only for `passed`:

- **`passed`** — the automated prerequisites genuinely pass, every planned `main`/`failure`/`recovery` run carries a production artifact identity and an observed real embedded provider turn, and the mounted operation evidence validates. The claims block stays honest: `fullReleaseClaim` and `requiredMustFlowsExecuted` are **false by construction in every profile** — this gate never mints a full-release claim, and a `passed` verdict for `chat-tavern-live` is a Chat/Tavern live claim only. This is still not a statement about semantic quality or memory consolidation; those are audit work, not gate criteria.
- **`blocked`** — an automated prerequisite is missing or failing; do not run around it manually, and no narrative run is attempted in that state.
- **`inconclusive`** — evidence is incomplete or contradictory: a planned run is missing, did not genuinely pass, or the mounted operation evidence is absent or does not match the mounted profile. Preserve it as inconclusive.

A `fail` is not a verdict this command returns: an observable wrong behavior (internal-data exposure, silent mutation, wrong-thread resume, unauthorized active import behavior, a surface-boundary breach, or a cross-continuity Memory leak) surfaces as a `blocked`/`inconclusive` run with its reason code and, when found, must be recorded and fixed before the gate is re-run. Never upgrade `blocked`, `inconclusive`, or a subjective positive impression to `passed`, and never read `passed` as an endorsement of the prose. A participant refusal, silence, `turn_failed`, absence of required explicit presentation, Stop, or neutral error is a result to record — not a reason to bypass the product boundary.
