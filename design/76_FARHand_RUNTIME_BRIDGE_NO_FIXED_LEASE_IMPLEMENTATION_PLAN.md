# Farmhand Runtime Bridge No Fixed Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the fixed five-minute Farmhand bridge lease so an already-ready release session never loses ordinary chat or `/stop` authority merely because wall-clock time passes.

**Architecture:** Preserve short-lived attachment-manifest and launcher startup deadlines as pre-admission controls. Remove the launcher-minted bridge expiry from Preview config, fixture projection, Mod config, and `BridgeSession`; runtime bridge authorization remains bound to the authenticated token, exact scope, live generation, game-thread checks, and launcher-owned teardown/disconnect.

**Tech Stack:** TypeScript/Node, PowerShell launcher, C# Stardew/SMAPI Mod, Node/C# contract tests.

**Spec:** `design/AI_GAME_COMPANION_DESIGN.md`

## Global Constraints

- Do not lengthen or renew the five-minute lease: remove the runtime lease capability from release code.
- Keep attachment/session manifest expiry validation as a startup-only admission boundary.
- Keep authenticated token, exact scope, authenticated generation, native game-thread gates, idempotency, and launcher teardown/disconnect revocation.
- Do not add compatibility fields, migrations, or fallbacks for the removed lease config.
- A ready session must accept valid chat/control bridge operations after the old five-minute threshold.

---

### Task 1: Prove and remove Mod runtime lease gating

**Files:**
- Modify: `integrations/stardew/BridgeSession.cs`
- Modify: `integrations/stardew/ModConfig.cs`
- Modify: `integrations/stardew/ModEntry.cs`
- Test: `integrations/stardew/tests/CompanionPresentationPolicyTests.cs`

**Interfaces:**
- Consumes: authenticated generation, exact `BridgeScope`, bridge token, game-thread presentation policy.
- Produces: authenticated bridge operations that remain valid after arbitrary elapsed wall-clock time while the session remains live.

- [ ] Replace the existing expired-lease presentation test with a test that authenticates, advances an injected clock past the former expiry, and still receives `accepted` for a fresh authenticated presentation request.
- [ ] Run the C# policy test and confirm it fails against `bridge_lease_expired` behavior.
- [ ] Remove `ConfigureLease`, lease fields, clock injection, and expiry checks from `BridgeSession`; remove `BridgeLeaseExpiresAtUnixMs` from `ModConfig` and Mod bridge construction.
- [ ] Run the C# policy test and confirm it passes.

### Task 2: Remove the lease from the release launch contract

**Files:**
- Modify: `host/src/farmhand-companion-preview.ts`
- Modify: `host/src/farmhand-companion-preview.test.ts`
- Modify: `tools/lib/stardew-fixture-profile.mjs`
- Modify: `tools/stardew-fixture-profile.test.mjs`
- Modify: `tools/start-farmhand-launcher.ps1`
- Modify: `tools/start-farmhand-launcher.test.mjs`

**Interfaces:**
- Consumes: startup attachment manifest, launcher startup timeout, pipe name/token, exact game identity and locale.
- Produces: lease-free Preview and fixture bridge config containing only pipe token and identity/scope facts.

- [ ] Write/adjust parser and fixture tests so bridge config rejects the removed expiry field and accepts a valid lease-free bridge shape.
- [ ] Run the affected tests and confirm existing lease-bearing shapes fail.
- [ ] Remove lease minting, fixture projection, Preview parsing, and lease-specific listener deadline from the launcher; use the existing startup deadline for bounded pre-ready listener work.
- [ ] Run the affected tests and confirm they pass.

### Task 3: Verify release closure

**Files:**
- Verify: changed files above

- [ ] Run Host typecheck and focused Preview/fixture/launcher tests.
- [ ] Run Stardew Release build and Farmhand C#↔Node interop.
- [ ] Search production sources for removed symbols; allow only startup-only attachment manifest expiry semantics.
- [ ] Run scoped `git diff --check` and rebuild the immutable production artifact before any new live gate.
