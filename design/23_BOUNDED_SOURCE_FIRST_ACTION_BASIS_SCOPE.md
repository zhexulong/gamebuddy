# Bounded Source-First Action Basis Scope

## Decision

The target is a **version-locked, scope-bounded, conservative** action-basis derivation. It is not a proof of globally minimal behavior for arbitrary runtime extensions, arbitrary mods, or every possible program context.

For the locked Stardew Valley assembly, base content, actor scope, dynamic-boundary model, and semantic-equivalence standard, the pipeline must:

1. account for every discovered source/content mechanism and every derived dispatch, continuation, selector, registry-write, or receiver edge;
2. preserve unresolved dynamic provenance as an explicit `unknown` edge rather than treating it as absent;
3. resolve an `unknown` only through exact-source proof, a version-locked scope boundary, or controlled runtime evidence;
4. derive an internal basis only relative to a finite, versioned semantic abstraction and context suite; and
5. project public GameBuddy Actions only after the bounded native basis and normal-player closure audit complete.

## Claim boundary

A completed result may claim only:

> For the attested target version and base content, declared normal-player scope, approved dynamic-boundary model, and frozen semantic-equivalence standard, all accounted in-scope paths are represented by the native basis/composition/protocol graph or by an explicit approved boundary.

It may not claim unconditional global minimality, absence of paths outside the declared boundary model, Mod/SMAPI extensibility closure, or GameBuddy Action live/publish success from static analysis.

## Dynamic-boundary dispositions

Every unresolved virtual/interface receiver, delegate/event writer, reflection/type construction, content selector, native/external call, task/iterator continuation, or network route is one of:

- `source_resolved` — exact locked source/content proves the finite target set;
- `runtime_modeled` — controlled target-version runtime evidence supplies an approved finite model;
- `approved_scope_boundary` — exact source anchor and declared scope make it out of scope;
- `unknown_blocking` — remains in the graph and blocks a completion claim.

No disposition is inferred from a method name, directory, helper reuse, an existing GameBuddy Action, a player-outcome label, or an unobserved runtime trace.

## Minimality boundary

The primitive basis is minimal only relative to the separately frozen semantic-equivalence standard. Its finite comparison context preserves actor/target typing, source-derived authoritative post-state observations, pending native continuation state, authority, cancellation/replay, typed failure, and required evidence. Internal implementation reuse does not determine public Action identity.
