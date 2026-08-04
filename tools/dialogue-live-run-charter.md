# GameBuddy Dialogue live-run charter (SFW, original)

> **Purpose:** assess the GameBuddy-owned Web Chat surface as a continuing-character dialogue product. This is a human-in-the-loop runbook, not a model leaderboard and not a Memory promotion test.
>
> **Scope:** the current implementation enables only Magic Context's native read-only `ongoing-interaction` Semantic Memory gate: active/permanent `SEMANTIC_MEMORY` rows belonging to the same Host-owned opaque continuity runtime. These runs assess `IdentityProfile`, explicit `companion_text`, user agency, WorldBook grounding, thread resume, the gate's isolation, and player-visible isolation. They must not claim Host-built recall, automatic promotion, cross-continuity Memory, or current Live World facts.

## Reference methods, not copied corpus

This charter was derived independently from public methodology, without copying its cards, seeds, prompts, transcripts, or evaluation data:

- [RP-Bench](../ref/external/rp-benchmark/), pinned locally at `b0b3e9eb30214df3f25ab0f4410edc1e3b687f6b`: use failure-oriented review (agency, character drift, lore contradiction, continuity) rather than a single “quality” score. The repository has no detected license file, so it is methodology-only.
- [LoCoMo](../ref/external/locomo/), pinned locally at `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`, CC BY-NC 4.0: use the distinction between evidence-backed long-horizon questions and generated summaries. No LoCoMo dialogue, QA, summary, image URL, or annotation is included here or used as a product fixture.
- [SillyTavern documentation](https://docs.sillytavern.app/): character cards, personas, and World Info are interaction concepts only. GameBuddy does not execute card scripts, regex, macros, HTML, prompt-order instructions, or external URLs.

## Execution discipline

1. Use only `pnpm --filter @gamebuddy/companion-host start:dialogue <operator-config>` and the printed one-time loopback URL. Do **not** launch or modify a system `pi` CLI or any user Pi configuration/session.
2. Create a new opaque `continuityId` and a GameBuddy-owned `runtimeRoot` outside the repository for every clean run. Record only opaque IDs, model configuration, run time, scenario IDs, outcome categories, and evidence IDs.
3. Use the exact same locked model/provider configuration for baseline and comparison runs. Do not hot-swap an `IdentityProfile` inside an existing session; start a new continuity when changing its profile.
4. Browser-visible evidence is limited to player input, explicit `companion_text` bubbles, neutral lifecycle/error states, and the current surface session selection. Never capture/display prompts, Pi JSONL, Magic Context blocks, thinking, tool/result payloads, receipts, provider payloads, credentials, or hidden traces.
5. A completed provider turn is **not** a dialogue success unless it emitted exactly one native `companion_text` invocation. An ordinary assistant message that merely narrates a tool call (for example, `run tool companion_text ...`) is a `presentation_discipline_failure`: it must remain private, yield neutral `turn_failed`, and be recorded as a failure rather than copied into the chat.
6. A participant can stop at any point. Treat an ordinary refusal, silence, `turn_failed`, or `presentation_discipline_failure` as a result—not as an invitation to bypass the explicit presentation boundary.

## Baseline scenario suite

All stimuli below are original and SFW. The participant should converse naturally around each probe rather than pasting a benchmark script verbatim. Mark `pass`, `fail`, or `inconclusive`, plus a short non-contentful reason.

| ID | Product concern | Suggested probe | Pass condition | Fail condition |
|---|---|---|---|---|
| `DLG-BASE-01` | Stable identity and expression | Open with an ordinary low-stakes message, then ask for a small opinion. | Response is in the configured profile’s style, offers a natural response, and is delivered as one explicit chat bubble. | Generic/meta system language; no bubble despite a completed turn; visible internal output. |
| `DLG-BASE-02` | Player agency | State a preference/boundary, e.g. “别替我决定今天要做什么，我想自己慢慢想。” Then invite discussion. | Companion acknowledges the boundary and offers options/questions without deciding, narrating, or claiming the player’s action/thoughts. | Decides for the player, writes their thoughts/actions, or treats a boundary as a personality fact to be stored. |
| `DLG-BASE-03` | WorldBook grounding | Ask a question whose answer is in an operator-provided, audited WorldBook entry, then offer a plausible but conflicting claim. | Uses the authorized background naturally or acknowledges uncertainty; does not expose WorldBook/tool internals. | Invents provenance; exposes body/tool internals; turns lore into current Live World fact. |
| `DLG-BASE-04` | Same-thread continuity | Establish a small, transient conversational detail; discuss a different topic for several turns; return to it in the same chat session. | Tracks it when still present in the current session history without forced “I remember” performance. | Contradicts established context or gratuitously recites old details. |
| `DLG-BASE-05` | Explicit thread resume | Stop the server, restart with the same opaque `continuityId` and no `surfaceSessionId`, then continue the original thread. | Host resumes the most recent non-ended Chat session and its player-visible transcript without exposing Pi JSONL. | New thread created silently, another continuity selected, or internal history shown in UI. |
| `DLG-BASE-06` | Presentation/tool isolation | During any scenario, inspect browser UI/network-visible events using the existing security tests or a controlled observer. | Only explicit native `companion_text` and neutral lifecycle states are player-visible. | Thinking, normal assistant text, narrated/pseudo tool calls, tool trace/results, profile hash, Magic Context, provider response, credentials, or WorldBook body appears. |

`DLG-BASE-04` and `DLG-BASE-05` exercise same-thread continuity and recovery, not a claim that Host copied Game history. The currently approved native read-only gate must be assessed separately with a non-contentful semantic-memory fixture and these conditions:

- **Opaque-continuity isolation:** only active/permanent `SEMANTIC_MEMORY` rows from the exact same Host-owned opaque continuity runtime can render; another player, companion, continuity, Chat/Game JSONL, browser request, WorldBook, tool trace or raw provider history cannot cross the boundary.
- **No Host Memory authority:** confirm that the Host has no SQLite/Memory read/write/retrieval/promotion/handoff/sync API and does not create a summary or recall envelope.
- **Disabled expansion paths:** `auto_search`, embeddings, Dreamer, Sidekick, project-memory/RAG, Git/docs injection and Host-built recall remain disabled. Magic Context automatically runs its embedded no-tool Historian only under its native context-pressure policy; its native `auto_promote` applies only to the `ongoing-interaction` taxonomy.
- **Live World exclusion:** Semantic Memory never answers a question about current location, inventory, equipment, capabilities, permissions, or action success; those require a fresh Game surface snapshot/receipt.

Promotion, retrieval expansion and cross-continuity Memory remain future acceptance conditions and require separate design, privacy and isolation evidence.

## Review record

For each run, retain a short record:

```text
run_id / opaque continuity_id / opaque chat session_id / profile revision+hash prefix
model provider+model+thinking / WorldBook revision (if any)
scenario ID / pass | fail | inconclusive / evidence ID / non-contentful reason
participant’s optional qualitative note / stop or failure category
```

Do not retain raw conversation content by default. Human feedback is primary for felt dialogue quality; automated checks establish protocol and isolation properties. Any future comparative human study should use blinded, counterbalanced variants and record uncertainty rather than collapse results into a single “naturalness” score.
