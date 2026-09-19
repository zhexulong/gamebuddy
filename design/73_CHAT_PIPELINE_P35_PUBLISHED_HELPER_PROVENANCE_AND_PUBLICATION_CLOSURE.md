# Chat Pipeline P3.5 — Published Helper Provenance and Publication Closure

**Status:** frozen remediation prerequisite
**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md`
**Depends on:** `design/70_CHAT_PIPELINE_P35_HANDLE_BOUND_LOCK_RECLAIM.md`, `design/72_CHAT_PIPELINE_P35_NATIVE_ROOT_AND_LIVENESS_CLOSURE.md`
**Scope:** only the Windows stale-lock helper's emitted-pair adapter, build publication, and focused evidence. No Chat, provider, browser, P4c, P5, or release-gate semantics.

## Blocking review findings

The native helper now retains a no-follow root-to-leaf HANDLE chain and refuses delete sharing. That does not by itself prove the emitted executable that was hashed is the executable later spawned. The Host adapter also used lexical ancestor containment, while the builder used pathname preflight followed by pathname publication and manifest writing. These are separate authority boundaries.

## Frozen rules

1. **Published pair only.** Production adapter resolution accepts only the pair co-located in the selected Host-TCB production generation. Source/test code must use an explicit test/build capability. No repository `.dist` fallback exists in production.
2. **Physical ancestor proof.** Before minting a production capability, every existing ancestor from artifact root through pair directory and both pair files is checked as a regular non-reparse object and its physical identity is compared with the captured canonical path. A lexical `relative()` check alone is insufficient. Any missing, changed, linked, reparse, or ambiguous object fails closed.
3. **Invocation revalidation.** A capability does not cache an unchecked pathname. Immediately before each spawn, the adapter revalidates the complete pair, canonical manifest, helper digest, and physical ancestor identity. If any fact differs, it fails closed. The selected generation is a Host-TCB deployment input, not an ACL-sealed capability; a second hash is not treated as an atomic check-to-spawn proof. The reference pipeline makes no claim to prevent a malicious same-user principal already able to modify the Host deployment TCB from replacing an executable after this check and before pathname process creation.
4. **Publication is non-destructive.** The builder never recursively removes or overwrites an output. A complete valid pair is reused. A fresh publication reserves a previously absent output using exclusive creation and publishes only into that reservation. Manifest creation is exclusive and never follows an existing link/reparse entry. Any pre-existing object, reparse, extra entry, incomplete pair, replacement, or ambiguous identity fails closed without touching an external target.
5. **Evidence.** Tests cover pair ancestor junctions, post-verification helper/manifest replacement, exclusive manifest creation, output reservation, and valid-pair reuse. Native rename/ancestor tests remain smoke tests unless a deterministic helper barrier is available; they cannot be presented as synchronized post-open evidence. The Windows fixture must separately prove the retained root-to-leaf lock HANDLE chain rejects or safely classifies leaf and ancestor rename attempts during its observation window.

## Threat boundary

The accepted deployment boundary is the one already owned by `design/24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md`: a verified Host deployment root and its ACL/operations are Host TCB. This card guards accidental or observed source/artifact reparse, junction, non-regular entry, manifest, digest, and publication drift inside that boundary. It does not add a distinct Windows service identity, a privileged publisher, or an ACL seal claim against a malicious same-user process that can already modify the deployment TCB. The repository's `windows-legacy-authority-seal` feasibility spike demonstrates why a same-user ACL rewrite cannot honestly establish that stronger claim.

## Completion

P3.5 remains incomplete until adapter, builder, emitted artifact, and Windows live/focused tests pass and an independent review finds no concrete helper provenance or publication bypass **within this accepted Host-TCB deployment boundary**. This card does not claim P4c, reference-pipeline completion, `chat_core_v1 released`, or overall release.
