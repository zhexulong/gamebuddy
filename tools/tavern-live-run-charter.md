# GameBuddy Tavern release live-run charter (SFW, original)

> **Purpose:** run the implemented Tavern release profile with a real participant after its automated release prerequisites have passed. This runbook validates an end-to-end product flow; it is not a model leaderboard, does not execute SillyTavern runtime behavior, and does not substitute for parser/fuzz, migration, Magic Context fork, Pi partition, Game Action, or target-game live gates.
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

## 1. Preconditions — do not begin otherwise

Mark the run **blocked** and record the failed prerequisite; do not compensate with manual UI actions if any is false.

1. Run `pnpm check:tavern-release-prerequisites`. It must exit zero with `verdict: "passed"`; a nonzero `blocked` result is evidence that this live run must not begin. In particular, `magic_context_source_contract_only` is a blocked prerequisite, not a manually waivable warning.
2. The build has a versioned release profile (`selected_l3_v1`) whose `must` flows are known. The checker maps every current `must` flow to `TVL-00`–`TVL-09`; it deliberately excludes `later` and explicitly unsupported flows.
3. The build has passed the automated contracts required by that profile. The prerequisite checker fails closed unless **each selected `must` flow** has all three: a declared Host route, a durable Host artifact/operation marker, and a matching marker in the compiled Host contract-test command. Manifest mapping, source markers, or static tests alone never satisfy this prerequisite. Required evidence is limited to safe source-level markers plus the compiled Host test command; it is not a live-pass substitute.
   - stable-context source/marker/render/fail-closed contract;
   - Character/WorldBook safe-subset import and malicious-input tests;
   - artifact migration, atomic write, revision conflict and read-back tests;
   - opening/message-0/blank/resume tests;
   - Tavern message-command surface guard and browser isolation tests;
   - every enabled L3 flow's own automated contract.
4. A fresh GameBuddy-owned runtime root has been created outside the repository. Do not use system `pi`, `~/.pi`, pre-existing Pi sessions, user extensions, skills, prompts, configuration or credentials.
5. The operator has an original, SFW fixture set with the locked fixture-manifest hash. Do not use community Character cards, copied benchmarks, private chat logs, or unreviewed WorldBooks.
6. The current build, Magic Context vendor version, model/provider configuration, compatibility manifest and semantic-reference registry are recorded before launching the UI.

The regular current-Web-Chat research baseline remains [`dialogue-live-run-charter.md`](dialogue-live-run-charter.md). Do not claim that its `DLG-BASE-*` result is a Tavern release result.

## 2. Evidence hygiene

Record only opaque IDs and non-contentful outcomes. Do **not** retain raw dialogue by default and never capture or display:

```text
system prompt / prompt wire / m[0] or m[1] text / Magic Context SQLite or blocks
thinking / tool trace or result / receipt payload / provider payload / credentials
Pi JSONL or internal session path / bridge token / unconsented audio
```

Use the following minimal record:

```text
run_id / controlled anonymous operator_id / started_at / build commit / release-profile hash
Magic Context vendor version / provider+model configuration
compatibility-manifest + semantic-reference-registry + fixture-manifest hashes
opaque companion_id / continuity_id / chat_thread_id / surface_session_id
step_id / pass | fail | blocked | inconclusive / artifact-or-readback evidence ID / controlled non-contentful reason category
optional controlled stop/failure category only; no free-text qualitative note, personal data, or dialogue content
```

A fluent model response is not evidence that persistence, source placement, privacy or surface isolation worked.

### Versioned machine-readable operator record

After the automated prerequisite command passes, an operator may run the separate validator with `node tools/run-tavern-release-live-gate.mjs --record <privacy-safe-record.json>`. It does not drive the UI, collect telemetry, or create observations. It only validates a supplied record and returns `inconclusive` unless every required observation is directly recorded by the operator and prerequisites pass.

The input is a JSON object with `schema_version: 1`, opaque lowercase-hex metadata IDs (16–128 characters), SHA-256 hashes for the listed versioned artifacts, and an `observations` array. Each observation permits **only** `step_id`, `outcome`, `reason_category`, `operator_observed_at`, and non-empty opaque `evidence_ids`. The validator rejects unknown fields (including dialogue, prompts, paths, notes, payloads, or UI captures), duplicate steps, missing must-flow steps, invalid IDs/hashes, and a `pass` without `reason_category: "observed"`. `TVL-06` alone may be `not_applicable`, and only with `operation_not_declared`.

This is evidence-record validation, not a TVL execution harness. In the absence of an authentic operator record it returns `inconclusive`; it never represents UI-driven Tavern success.

## 3. Required flow

Use the local authenticated loopback Tavern UI only. The participant may stop at any time.

| Step | Participant action | Required observable result | Evidence |
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

- **pass** — every release-profile `must` step passes; evidence record is complete; no unresolved safety, privacy, source/materialization, persistence, surface-isolation or causality failure remains.
- **fail** — a required step produces an observable wrong behavior, including internal-data exposure, silent mutation, wrong-thread resume, unauthorized active import behavior, or a surface-boundary breach.
- **blocked** — an automated prerequisite is missing or failing; do not run around it manually.
- **inconclusive** — insufficient observation, provider/runtime interruption without contradictory outcome, or participant stop. Preserve it as inconclusive.

A participant refusal, silence, `turn_failed`, absence of required explicit presentation, Stop, or neutral error is a result to record—not a reason to bypass the product boundary. Never upgrade `blocked`, `inconclusive`, or a subjective positive impression to `pass`.
