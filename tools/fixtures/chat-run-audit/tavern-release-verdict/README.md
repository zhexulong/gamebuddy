
## run-10 (2026-10-04) — Characters surface + vendor close fix, clean-checkout pass

- Generation: test-published p9l (sanctioned test publisher, full runtime tree; built from the same committed tree as this report).
- Surface: mounted profile with the full Characters assembly — 26 operations / 32 routes / [chat, memory, characters] (companion.*, persona/scenario/greeting read+update, chat.archive/restore/trash).
- Prerequisites: passed (magic_context_stable_source passed after vendor 13e973c1d fixed the Windows EBUSY close leak; semantic_reference_attestation passed).
- Runs: main / failure / recovery all passed (runKindSemantics: attempt_labels_not_exercised_distinctions; claims.requiredMustFlowsExecuted=false are the honest pre-existing boundaries).
- Operation evidence: 26/26 producer operations exercised against the generation with durable postconditions (operation-outcomes-10-characters-surface.json), recorded with profile_hash matching the mounted profile (operation-evidence-mapping-characters-surface.json).
- Verdict: passed, blockerIds: [], verified from a clean `git worktree add HEAD` so the gate validated the committed character surface, not the concurrent lanes' uncommitted WIP.
