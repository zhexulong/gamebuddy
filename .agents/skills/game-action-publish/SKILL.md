---
name: game-action-publish
description: "Publish or withdraw one already-attested game action through its game-owned catalog and policy. Use only after the action's owning project has closed its required gates."
---

# Game Action Publish

Publication is a game-owned authority decision. Host registries, schemas, docs,
and devkit reports are restrictive projections; they cannot publish an action
the game catalog/policy has not granted. Use the owning project's canonical
publication/check command from `ACTION_RUNBOOK.md`; documentation and static
projections never authorize publication.

## 1. Verify publish inputs

Read the game-owned catalog/policy entry, exact action identity/version,
completed evidence, required independent review, target-runtime claim, and
withdrawal conditions. If any condition is absent, return the action to
`game-action-close` as blocked.

## 2. Make one authority change

The catalog/policy owner changes publication state. Update restrictive
Host/protocol/tool projections only after that authority change, and prove they
cannot add capabilities absent from the game-owned surface. Keep gameplay
semantics with the game adapter; this skill cannot change them.

## 3. Verify projection and withdrawal

Check advertised capability, typed request admission, receipt/postcondition
projection, and withdrawal. A withdrawn action must disappear or reject through
every consumer surface according to the game-owned policy.

## Completion

Record the catalog decision, exact evidence it consumed, publication/check
command outcome, projection smoke outcome, withdrawal behavior, and remaining
non-guarantees. Do not treat a devkit bundle, static descriptor, or Host-only
tool as publication.
