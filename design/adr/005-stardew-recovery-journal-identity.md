---
id: ADR-005-STARDEW-RECOVERY-JOURNAL-IDENTITY
type: adr
status: current
owner: game-runtime
---

# Stardew recovery journal identity

## Context

A Host response timeout does not prove that the Mod rejected an action. Recovery must keep the original logical action lineage, query the Mod receipt through a fresh authenticated binding, and avoid a second native dispatch.

The first Host journal draft made `ownerId` and `epoch` document-wide identity. That is invalid because both describe one runtime admission and are intentionally new across normal admissions and Host restarts.

## Decision

The journal file is identified by its Host-owned recovery directory and stable product/continuity/Stardew scope. It is not identified by a runtime admission owner, a STOP epoch, Pi session data, process identity, or bridge generation.

Each record retains the original `ownerId` and `epoch` as immutable historical dispatch facts. A fresh Host uses a new runtime lifecycle owner and imports the old record only for recovery correlation. It does not recreate the old admission or use its owner/epoch as current cancellation authority.

A journal record stores only bounded query material and transport state. The Mod remains the source of execution and receipt truth. Recovery uses the original `{requestId, idempotencyKey}` to query a fresh authenticated Mod binding; it does not call `execute()` or resend an envelope.

## Consequences

- The journal can contain records from different runtime owners and epochs in one stable scope.
- Normal actions keep their fresh runtime-local owner and epoch semantics.
- A missing, malformed, expired, scope-mismatched, binding-mismatched, or unavailable receipt becomes `recovery_required`; it is not evidence of `not_accepted`.
- Existing unrecoverable historical attempts do not gain recovery material retroactively.
