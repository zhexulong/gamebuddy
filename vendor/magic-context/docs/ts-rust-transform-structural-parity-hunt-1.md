# TS ↔ Rust transform structural parity hunt #1

Audit date: 2026-08-24

## Scope and method

The primary evidence is the serialized Anthropic request body, not reconstructed transform state. I scanned the same-day files under `opencode-anthropic-auth-dumps` in two passes:

1. `scripts/audit-transform-wire-parity.py ... --date 2026-08-24 --per-session 5` compared the five newest bodies from every session then present (10 Rust bodies and 70 TypeScript bodies in the reproducible snapshot).
2. Targeted streaming scans covered all 2,296 same-day bodies present at the initial inventory for placeholders, temporal overlays, reasoning, TodoWrite IDs, assistant block order, and non-200 statuses.

Rust lane sessions were:

- ENGRAM: `ses_0ad83017cffexe0g5N8UG0y3LZ`
- ASTRO: `ses_08df2045bffeBcWcqw60elghER`

Everything else was treated as the TypeScript lane. The read-only `transform_decisions` telemetry cross-check supports that assignment: the two Rust sessions had zero non-null system/tool/model hash operands across their retained 2,000 rows, matching `writeRustTransformDecision` in `packages/plugin/src/features/magic-context/transform-decision-log.ts:167-212`; the sampled TypeScript session had non-null TypeScript-only operands.

All named evidence bodies below have a companion `.meta.json` status of 200 unless explicitly called out.

## Findings

### F1 — fixed: Rust emitted the empty m1 body without its structural wrapper

**Wire evidence**

- Rust / ENGRAM, `2026-08-24T14-47-42-203Z-004583-ses_0ad83017cffexe0g5N8UG0y3LZ-direct-sticky-main.body.json`, message 0, block 2:
  ```text
  (no new content since last materialization)
  ```
- TypeScript, `ses_100a028aaffeVG0zdK3qwcEXf8`, `2026-08-24T09-42-28-750Z-003671-ses_100a028aaffeVG0zdK3qwcEXf8-direct-sticky-main.body.json`, message 0, block 1:
  ```text
  <session-history-since>(no new content since last materialization)</session-history-since>
  ```
- Full targeted scan: 325 Rust heads had the bare form; 809 TypeScript heads had the wrapped form (562 at block 1, 247 at block 2 depending on mural presence).

**Source cross-check**

- TypeScript specification: `packages/plugin/src/hooks/magic-context/inject-compartments.ts:929-931` defines the wrapped placeholder; `:2941-2982` inserts m0 and m1.
- Rust: `crates/mc-module/src/memory_render.rs:22-30` defined the bare constant; `crates/mc-module/src/transform.rs:6882-6885` froze it as m1 and `:11965-11984` served it.

**Adjudication**

TypeScript is the specification. The wrapper is not decorative: it keeps empty and non-empty m1 in the same session-history vocabulary and keeps prompt interpretation stable across a later non-empty delta.

**Severity:** ICL hazard + cache-shape stability; no provider-4xx evidence.

**Disposition:** fixed here. `M1_PLACEHOLDER` now carries the wrapper, the covered-system and canonical-response byte goldens were regenerated, and a literal cross-language regression test was added.

### F2 — fixed: Rust nested the tag inside the temporal marker; TypeScript nests the marker inside the tag

**Wire evidence**

- Rust / ENGRAM, `2026-08-24T14-47-42-203Z-004583-ses_0ad83017cffexe0g5N8UG0y3LZ-direct-sticky-main.body.json`, message 130, block 1:
  ```text
  <!-- +10h 38m -->
  §5436§ .
  ```
- TypeScript / MC, `2026-08-24T08-33-57-109Z-003521-ses_331acff95fferWZOYF1pG0cjOn-direct-sticky-ufuk2.body.json`, message 26, block 0:
  ```text
  §160707§ <!-- +13h 29m -->
  We'll do a opencode restart soon, do you need to rebuild dists?
  ```
- Full targeted scan found 565 Rust `temporal → tag` carriers and 38,688 TypeScript `tag → temporal` carriers.

**Source cross-check**

- TypeScript explicitly preserves the tag as the outer prefix in `packages/plugin/src/hooks/magic-context/temporal-awareness.ts:138-189`; the transform runs temporal injection before tag injection at `packages/plugin/src/hooks/magic-context/transform.ts:1768-1797`.
- Rust applied the tag first and then prepended the temporal marker in `crates/mc-module/src/transform.rs:8075-8136`, making the temporal marker outermost.

**Adjudication**

TypeScript is the specification. `§N§` is the control/reference prefix and must remain the leading token. Rust's order weakened the visible tag grammar and disagreed byte-for-byte with the established TypeScript tests at `packages/plugin/src/hooks/magic-context/temporal-awareness.test.ts:232-251`.

**Severity:** ICL hazard + cache stability; no provider-4xx evidence.

**Disposition:** fixed here by applying temporal content before the tag overlay. Four Rust assertions now pin `§N§ <!-- +… -->\ntext`; red-first execution showed the former Rust bytes before the renderer change.

### F3 — fixed as a TypeScript bug: elapsed-time markers were attached to standalone transport reminders

**Wire evidence**

- TypeScript / MC, `2026-08-24T08-33-57-109Z-003521-ses_331acff95fferWZOYF1pG0cjOn-direct-sticky-ufuk2.body.json`, message 568, block 0:
  ```text
  §161443§ <!-- +31m -->
  <system-reminder>
  Work wi_091c00e9 finished (completed).
  Review the delivery with work("show", id=wi_091c00e9)
  </system-reminder>
  ```
- The same file contains ordinary authored-user markers, so this is not a disabled-overlay/session confound.
- Rust dumps contained markers on authored user text only. Rust tests separately pin a standalone reminder-shaped user message as transport.

**Source cross-check**

- TypeScript `injectTemporalMarkers` checked only `role === "user"` at `packages/plugin/src/hooks/magic-context/temporal-awareness.ts:152-189`.
- The existing authored-user predicate is `hasMeaningfulUserText` at `packages/plugin/src/hooks/magic-context/read-session-formatting.ts:33-50`.
- Rust filters with `is_authored_user_message` in `crates/mc-module/src/transform.rs:8408-8430` and at the temporal decision walk `:8505-8515`; the transport cases are pinned at `:24022-24103`.

**Adjudication**

This is the allowed exception to TypeScript-as-spec: the TypeScript behavior is itself a bug. A synthetic completion notice has no human-authored elapsed-time semantics, and the shared historian/protected-tail predicate already defines the correct boundary.

**Severity:** ICL/cosmetic semantic noise; no provider or cache risk beyond the unnecessary bytes.

**Disposition:** fixed here. TypeScript temporal injection now requires meaningful authored user text. A red-first test proves a standalone `<system-reminder>` stays byte-identical.

### F4 — follow-up: historical temporal coverage and time basis differ materially

**Wire evidence**

In recent accepted bodies:

- Rust / ENGRAM `2026-08-24T15-02-25-580Z-004729-…body.json` had 2 temporal carriers across 445 messages.
- Rust / ASTRO `2026-08-24T15-13-00-373Z-004837-…body.json` had 4 across 733 messages.
- TypeScript / MC `2026-08-24T15-15-28-310Z-004862-…body.json` had 43 across 953 messages.

The follow-up reran `scripts/audit-transform-wire-parity.py` against the five newest 2026-08-24 bodies in every then-present session. The fresh sample contained 10 Rust bodies from 2 sessions and 75 TypeScript bodies from 15 sessions. It found 25 Rust temporal carriers versus 1,138 TypeScript carriers, reproducing the coverage difference before the source fix.

The bodies are different sessions, so counts alone do not prove a transform defect. Source behavior removes the confound:

- TypeScript re-derives markers from every message's immutable `time.created/time.completed` on every pass (`temporal-awareness.ts:152-189`), and `transform.ts:1785-1787` explicitly promises retroactive annotation when the feature activates.
- Rust only evaluates authored users newer than its persisted overlay frontier (`transform.rs:8505-8613`), uses current request observation/previous response completion for the tail, and uses tag-mint times only for multiple newly observed users. `transform.rs:24235-24260` explicitly pins midlife activation to zero historical gaps.

**Adjudication**

TypeScript is the specification for historical coverage. Rust's no-retroactivity choice was understandable for cache safety, but it was not structurally or semantically equivalent.

The fix carries OpenCode's nested `info.time.created` and `info.time.completed` through CK harness metadata in both the plugin adapter and Rust codec. Rust now walks every message on the immutable TypeScript basis (`previous.completed ?? previous.created` to `current.created`), while retaining the proxy-observation fallback only for timestamp-free harnesses. Existing sessions whose persisted temporal bytes differ consume a dedicated `temporal_parity` renderer-transition class: all visible historical decisions are replaced atomically on one cache-busting fold, and subsequent passes replay the consumed result without trickling older marker changes.

**Severity:** ICL/cosmetic temporal semantics + cache-stability trade-off.

**Disposition:** fixed in follow-up A. A generator-owned, dump-derived cross-language golden pins the `+13h 29m` completed-time basis, the `+31m` created-time fallback after a transport reminder, historical carrier placement, and one-fold replay stability. The corresponding mutation drill proves that ignoring the prior completion time changes the served marker to `+13h 30m` and fails the regression.

### F5 — follow-up: Rust served no thinking blocks despite recent signed reasoning in native history

**Wire evidence**

- Every one of the 190 same-day Rust bodies scanned had zero `thinking` or `reasoning` blocks.
- TypeScript / MC, `2026-08-24T08-33-57-109Z-003521-ses_331acff95fferWZOYF1pG0cjOn-direct-sticky-ufuk2.body.json`, message 495, block 1 retained:
  ```json
  {"type":"thinking","thinking":"The script exited with code 0 despite the output being truncated …","signature":"CAIS4AoKpwEIERgC…"}
  ```
- This is not merely different authoring behavior. A read-only OpenCode-store cross-check found 6,088 native reasoning parts for ENGRAM and 2,262 for ASTRO; their most recent 500/900 native messages contained 66/68 reasoning parts. Example ENGRAM native message `msg_0344b2946001sa0VasC8qPl2CP` was `[step-start, reasoning, text, step-finish]` with an Anthropic signature, while the served Rust request had no thinking carrier.
- Accepted TypeScript bodies do clear most old reasoning, but retained recent signed blocks (for example 16 in recent PLEX and 79 in recent CKCRED bodies).

**Source cross-check**

- TypeScript age clearing is tag-cutoff based at `packages/plugin/src/hooks/magic-context/strip-content.ts:319-351`; merged-assistant healing keeps at most one valid leading block and exempts the newest replayable assistant at `:747-826`. Frozen WRITE/REPLAY gating is at `transform-postprocess-phase.ts:2067-2105`.
- Rust mints age strip units at `crates/mc-module/src/transform.rs:10315-10409`, removes full signed blocks at `:10480-10503`, detects merged-reasoning strips at `:11441-11486`, and performs a final native clear at `:12524-12722`.

**Adjudication**

The wire plus native-store evidence proves a served structural difference, but this audit cannot safely collapse age clearing, merged-assistant healing, migration-time first application, and tag-baseline adoption into one small fix. Removing a complete historical thinking block is provider-valid; rewriting or reordering a signed latest block can cause a provider 400. A same-input cold-start/bust/defer differential is required before changing policy.

**Severity:** high ICL/capability loss + cache continuity; potential provider-4xx risk if fixed incorrectly.

**Disposition:** report-large. Follow-up should replay the same native tail through TypeScript and Rust, compare the exact retained message IDs/signatures after each pass class, and specifically test migration where an inherited high tag coexists with newly minted lower Rust tag numbers.

## Follow-up B — post-start reasoning absence and recurrent text-order 400

The latest module start was `2026-08-24T15:47:20Z`. A cutoff scan from that instant through the retained dump inventory found:

- Rust: 79 bodies across ENGRAM and ASTRO, zero thinking blocks anywhere, and `newest_assistant_reasoning_presence={absent:79}`.
- TypeScript: 309 bodies, 12,094 signed thinking blocks in total, and newest-assistant reasoning present in 104 bodies (`absent:205,present:104`).

This is post-start traffic, so the original F5 difference did not close with the metadata-shell exemption alone. `scripts/audit-transform-wire-parity.py` now accepts `--after` and emits both `newest_assistant_reasoning_presence` and the complete newest-assistant block vector per lane.

### Real-row and wire reproduction

ENGRAM native message `msg_0348483e9001xBB7Ya0H5bfkvm`, created at `2026-08-24T16:04:54.889Z`, persisted this whole vector:

```text
[step-start, signed reasoning, text, completed bash tool, step-finish]
```

The next request, `2026-08-24T16-05-27-159Z-005347-ses_0ad83017cffexe0g5N8UG0y3LZ-direct-sticky-main.body.json`, returned 400. Its newest assistant at message 351 was:

```text
[tool_use(mcp_Bash), text("§5696§ Three construction sites …")]
```

The thinking block was absent and the persisted pre-tool text had moved after the tool. The durable module state had tags 5696/5697 for that message, reasoning watermark 16129, and no `reasoning_age` or `merged_reasoning` strip unit for the message. The newest-assistant exemption therefore had to survive both age state and native encode-back.

The initial hypothesis was only partly correct. `encodeOpenCodeMessagesToCk` retains the reasoning block itself; it does not copy a signature nested under `metadata.anthropic.signature` into CK. Whole-vector matching can still accept that signature mismatch because it compares kinds, but any other CK/native vector disagreement enters the fallback. Replaying the persisted row with the reasoning carrier absent from CK reproduced the exact old fallback shape before this fix:

```text
[tool, step-finish, step-start, text]
```

After OpenCode's provider projection, that is the observed `[tool_use, text]` 400 shape. The same fallback also removed the signed native reasoning carrier.

### Fix and non-vacuity

The codec now has two independent belts:

1. Unmatched blocks are inserted relative to their nearest matched native anchor. A unique same-kind persisted part is replaced at its original native index instead of being appended. A final serve-wide invariant moves post-tool text before the first tool unless the persisted native message itself had text after a tool.
2. The newest replayable assistant's reasoning exemption is passed separately through full and incremental native encoding. If CK omits or cannot match that reasoning block, the codec reattaches the original native reasoning part, including its Anthropic signature, without exempting unrelated text or tool mutations. The native attachment cache key includes this reasoning-exemption bit.

Generated TS fixtures pin the ASTRO `[step-start, reasoning, tool, step-finish]` row and the ENGRAM recurrence row. The ENGRAM regression failed red as `[tool, step-finish, step-start, text]`; disabling the serve-wide belt failed a fresh assistant as `[tool, text]`. The ASTRO regression failed red with no reasoning block, and disabling the incremental reasoning exemption made the full/incremental differential fail. All deliberate breaks were restored.

**Disposition:** fixed in current source; no push or deploy was performed here. Production-wire confirmation remains required after the next deployment. This supersedes the claim that the metadata-shell exemption alone closed F5 and upgrades the coupled text-order fallback to P0.

## Exclusions observed

### X1 — `bg_7ce17719`: final assistant `[tool_use, text]` ordering

Two ENGRAM requests returned 400:

- `2026-08-24T14-38-45-570Z-004516-…body.json`, message 337 was `[tool_use, text]`, followed by the matching user tool result.
- `2026-08-24T14-48-44-816Z-004592-…body.json`, message 373 had the same shape.

The same historical instances replay inside later 200 bodies, so the provider rejection is specifically tied to the newest/final assistant run. At audit time no additional independent ordering failure was found. Follow-up B supersedes that conclusion with the `16:05:27Z` recurrence and fixes the remaining fallback.

### X2 — `bg_4257e8ad`: `{reduced, summary}` tool-input envelope

Rust bodies exposed the known envelope while TypeScript directly shortened original input values with `...[truncated]`:

- Rust / ENGRAM `2026-08-24T14-47-42-203Z-004583-…body.json`, message 201, `mcp_Edit` input used `{"path":…,"reduced":true,"summary":"{…}"}`.
- Historical Rust replay at message 341 used `"reduced":"true"` (string) with `filePath`, while current Rust construction at `crates/mc-module/src/ck_wire.rs:523-555` emits a boolean. This mixed bool/string replay is an amendment for the owner: normalization must cover retained historical envelopes, not only freshly reduced blocks.
- TypeScript skeleton construction is `packages/plugin/src/hooks/magic-context/tool-drop-target.ts:107-154,227-245`; Rust selection/skeleton payloads are `crates/mc-module/src/selection.rs:657-743`.

The envelope, foreign-key truncation, canonical-key-order, and mixed historical type are not fixed here.

## Structural checks with no additional divergence

### m0/m1 head and cache anchors

Apart from F1, both lanes served one provider user head containing m0 text, optional mural image immediately after m0, then m1 text. Mural presence changes the cache-control positions identically. The Rust build path is `transform.rs:6844-6891,11939-11986`; TypeScript is `inject-compartments.ts:2012-2059,2941-2982`.

The read-only cached-state cross-check also showed that ENGRAM's old 35,287-byte TypeScript m1 content was present by heading inside the larger Rust m0; the observed Rust placeholder therefore represented a real fold, not missing history.

### Synthetic TodoWrite pair

No same-day body contained `mc_synthetic_todo_`, so there is no production-wire observation to adjudicate. Source and cross-language goldens agree on `mc_synthetic_todo_<sha256[:16]>`, assistant tool call followed by user tool result, and anchor-stable replay:

- TypeScript: `todo-view.ts:84-201`, `transform-postprocess-phase.ts:160-353`.
- Rust: `injection.rs:78-192`, `transform.rs:7309-7376,12037-12065,12324-12365`, native collapse in `codec/opencode.rs:916-948`.
- Goldens: `crates/mc-module/testdata/injection-golden.json` and `testdata/codec/serve-native-golden.json`.

This remains an evidence gap, not a claimed pass.

### System prompt composition

Every sampled body in both lanes used the same four-element Anthropic `system` array. Entry 3 alone carried `cache_control:{type:"ephemeral",ttl:"1h"}`; identity, Magic Context guidance, and the date line occupied the same entry and order. The module does not independently rebuild this provider system array.

A shared non-parity anomaly exists: dumps created on 2026-08-24 still said `Today's date: Sun Aug 23 2026`. Both lanes had the same stale line, so it is upstream of the TS/Rust transform split and was not changed here.

### Tag classes and dropped placeholders

Both lanes prefixed assistant text, authored user text, and textual tool results with `§N§ `. Neither lane tagged tool calls, thinking blocks, images, or synthetic m0/m1. Both emitted `[dropped §N§]` for visible reduced carriers and the same tagged compaction-summary text. Apparent bare `[dropped]` hits in the initial TypeScript substring scan came from source/documentation quoted inside m0, not placeholder blocks.

TypeScript prefixing is `shared/tag-transcript.ts:207-576,673-682,814-985`; Rust is `transform.rs:7913-7945,8075-8199,8257-8272`.

### Trailing request shapes

Accepted bodies in both lanes ended with a user message: usually a single `tool_result`, occasionally authored text, and sometimes `tool_result + text`. No orphan results or duplicate `tool_use` IDs were found in the sampled structural pass. Rust's additional final-tail belt is `transform.rs:11494-11588`. The only non-200 trailing shape is exclusion X1.
