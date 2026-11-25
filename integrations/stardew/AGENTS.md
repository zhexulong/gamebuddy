# Stardew Mod & Game Action Guidelines

This directory owns the Stardew Valley SMAPI integration, native action seams, and action-development contracts (`integrations/stardew/action-development/ACTION_RUNBOOK.md`).

## Authority & Boundaries
- **Mod is the single authority** for action metadata (name, sentence, target kinds), argument bounds, player capability policy (`config.json` with `ActionPolicyVersion: 1`), and typed execution/chore receipts. Host and browser layers hold restrictive projections only.
- **No duplicated search or scoring on the Mod**: Pure text matching lives on the Host; the Mod publishes the destination index (`TryDestinationIndex`) and never duplicates search/ranking logic.
- **Game-thread-only**: All Stardew/SMAPI APIs execute on the game thread (`BridgeProtocol` / `BridgeSession` drained via `UpdateTicked`). Never call game APIs from background tasks.

## Action Implementation Invariants
- **Self-contained actions**: Every tool action declares its own tool and preconditions via a unified guard-first preamble; plans never require a separate `equip` step before an action.
- **Sync & async terminals**: Synchronous native operations may return an immediate terminal instead of `accepted`; callers and tests must accept either path and assert the terminal.
- **Structured, layer-specific refusals**: Every refusal must name the refusing layer, node/action, and what was compared. Distinct physical causes (e.g., bare tile vs. stone) keep distinct refusal codes.
- **Zero workarounds**: Establish a red check first. Never add arbitrary sleeps, retry loops, or compiler suppressions (`#pragma warning disable`) to paper over game-thread timing.

## Action Lifecycle
1. **Freeze boundary**: Prefer `Reuse` or `Compose` over `Split/new`. Verify the native seam (`ref/external/StardewValleyDecompiled/`) and freeze `Given / When / Then`, postconditions, and non-goals before coding.
2. **Implement**: Deliver one connected path (`request → game-thread admission → native commit → terminal receipt → fresh postcondition`).
3. **Close**: Run deterministic package checks, runner contract gates, and a single-action live slice (`tools/live-action.mjs`, see `tools/live-run/AGENTS.md`). Never relabel static setup or incomplete evidence as a live pass.
4. **Publish**: Update Mod catalog/policy authority first, then update restrictive Host/protocol projections.

## Verification Commands
- **Mod build** (0 warnings, 0 errors; `TreatWarningsAsErrors`):
  `dotnet build integrations/stardew/GameBuddy.Stardew.csproj -c Release`
- **Action package & runner contract gates**:
  `pnpm --dir integrations/stardew/action-development action:ci`
  `pnpm audit:stardew-native-local-runner-contract`
  `pnpm test:stardew-native-local-runner-fixture-contract`
- **Single-action live slice** (replaces retired `action:preflight` / `action:run-live`):
  `node tools/live-action.mjs --action <actionId>`
