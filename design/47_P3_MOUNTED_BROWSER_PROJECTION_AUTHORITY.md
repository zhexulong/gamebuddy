# P3a — Mounted Browser Projection Authority

**Status:** frozen prerequisite batch for P3; non-release development only
**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` P3
**Unblocks:** `design/46_CHAT_PIPELINE_BATCH_04_P3_EXACT_SNAPSHOT_BOOTSTRAP.md`

## Why this exists

P3 needs to serialize exact durable Chat state, but the public mounted lease currently provides only durable `chatThreadId` / `chatSurfaceSessionId`. It does not expose the semantic `selectionRevision`, browser-safe opaque handles, a mounted navigation projection, or a truthful no-SSE state. P3 HTTP/frontend must not invent any of these facts from timestamps, hashes, random values, a selector read, or browser input.

This batch supplies only those missing projections. It does not mount HTTP routes, access Tavern filesystem data, create/select a Chat, start provider work, or close the P2 Windows release-evidence blocker.

## Frozen decisions

### 1. Exact binding authority

The semantic runtime coordinator mints one immutable `MountedChatBrowserProjection` while it creates the existing mounted lease. It is derived only from the verified runtime mount record:

```ts
{
  chatHandle: OpaqueHandle;
  selectionGeneration: positive integer; // exact mounted record.vector.selectionRevision
  selectionStateRevision: OpaqueHandle;
  projectMessageHandle(messageId: string): OpaqueHandle;
}
```

- `selectionGeneration` is the verified `selectionRevision` captured by the exact mounted runtime record. It must be `>= 1`; a zero or non-finite revision rejects the mount.
- the projection has no selector/store/runtime-control input or output. It cannot change selection, issue a Chat creation, read a different Chat, or grant operation availability.
- it has no public secret/executable ID. The browser-visible values are Host-minted, opaque and stable only for the one live mounted lease. A restart may mint fresh values; P7 later owns replay/resync semantics.
- `projectMessageHandle` accepts only a validated durable `messageId` from the P3 facade. Its output is an opaque display reference, not a storage ID and not a retrieval capability.

### 2. Handle construction

The coordinator owns a new per-mounted-lease random secret. Every handle is `base64url(HMAC-SHA-256(secret, domain + "\0" + exact binding fields + "\0" + value))`, yielding a canonical 43-character unpadded Base64URL string.

Domains are distinct at minimum for `chat`, `selection-state`, and `message`. The exact `chatThreadId` and `chatSurfaceSessionId` are included in every input. The raw secret, durable IDs used to make handles, and any reversible mapping are never sent to the browser.

P3 retains no cross-restart handle stability claim. It must never rederive handles itself.

### 3. Profile is the route and availability authority

`ComposedTavernProfile` must include frozen `routeIds` and `navigationItemIds` capability slices alongside `operationIds`. All three slices accept only contract-declared entries and reject duplicates. The constructor retains strict exact-key rejection and tier/route validation.

`routeIds` is the sole mount allowlist, including routes that have no player operation (bootstrap, reads, and eventually events). An HTTP server must not register a descriptor missing from its mounted profile's `routeIds`; it must not add a hard-coded baseline route. `operationIds` remains the player-action availability projection; a profile can authorise a read route without claiming a write operation.

The P3 exact-active profile is composition-owned and fixed as:

```ts
composeTavernProfile({
  profileId: "gamebuddy.chat-core.p3",
  releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read"],
  operationIds: [],
  navigationItemIds: ["chat"],
})
```

It deliberately does **not** expose events, draft mutation, submit, cancel, Memory, or Tavern-management operations. P3 snapshot navigation is mechanically projected only from `navigationItemIds`; no HTTP/frontend fallback or implicit item is permitted.

### 4. No SSE before P7

The v1 `eventStream` snapshot field becomes nullable. `null` means *no event-stream capability is mounted*. P3 always returns `eventStream: null`, does not instantiate EventSource, and does not expose an events route. A non-null `{epoch,cursor}` is reserved for P7’s real replay authority and cannot be fabricated by P3.

### 5. Exact mounted scope only

P3’s real mounted path can produce only a selected exact Chat. `selection: null` remains contract-valid for future root/no-selection composition and fixtures, but is **not** an acceptance scenario for the P3 mounted runtime. If the exact mount fails or durable exact content cannot be read, P3 emits a typed problem; it does not start an alternate shell, search for another Chat, or turn an error into `selection: null`.

## Producer → consumer → verifier

1. **Producer:** semantic coordinator’s verified mount record and per-lease secret.
2. **Consumer:** P3 exact durable read facade accepts the full current mounted lease only after the coordinator-owned WeakMap-backed predicate proves it is genuine and current; it retains that lease privately, resolves the canonical identity binding at the exact `chatSurfaceSessionId`, and projects every durable message through `lease.browserProjection.projectMessageHandle`. Its exported result contains only browser-safe `chatHandle`, generation, state revision, and message handles—never durable IDs or a self-attesting mount flag. HTTP projects profile navigation and returns `eventStream: null`.
3. **Verifier:** focused coordinator and browser-contract tests prove no raw durable identifier appears in handles, consistency within a lease, variation across leases, distinct domains, exact selection generation, strict profile acceptance, and null-only pre-P7 event stream schema. The P3 facade additionally emits BrowserMessageV1-compatible `{ handle, role, text, locale, order, revision }`: durable messages carry no language metadata, therefore locale is the literal `und`; append-only durable transcript position supplies the zero-based order; and P3 has no edit/swipe/message mutation, therefore immutable exact records use literal revision `1`. These are P3-local safe projection semantics, not claims of source locale or source revision.

## Mutation lanes

### Lane A — semantic lease projection

**Owned paths:**
- `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts`
- `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.test.ts`

Implement the opaque per-lease projection described above. Preserve the existing lease lifecycle and never export a minting factory or secret.

### Lane B — browser contract/profile truthfulness

**Owned paths:**
- `host/src/tavern/browser-contract/index.ts`
- `host/src/tavern/browser-contract/index.test.ts`

Add profile-owned route and navigation capability plus nullable `eventStream`, with strict validators and unit coverage. This lane does not create a profile at runtime and does not add/mount any route.

## Acceptance

**Given** a verified semantic mount record for an exact selected Chat,

**When** its public lease is obtained,

**Then** it supplies browser-safe projections whose Chat handle, selection generation, selection-state handle and same-message handle are stable within that lease, are domain-separated, and do not equal raw storage identifiers.

**And** a separate lease produces different opaque values while its selection generation continues to come only from its verified semantic vector.

**And** the sole P3 profile permits exactly `bootstrap`, `state.read`, and `draft.read`, projects exactly `chat` navigation, and exposes no write operation.

**And** the snapshot contract accepts `eventStream: null` and refuses invalid/non-contract navigation or malformed non-null stream values.

## Validation

- each lane’s focused tests;
- `pnpm --filter @gamebuddy/companion-host typecheck`;
- Host `build:test` plus the two focused compiled test files;
- `git diff --check`;
- one independent review of the combined diff.

## Exclusions / stop conditions

Stop if implementation requires a durable browser-handle table, cross-process/restart handle continuity, selector mutation/read fallback, a future write route, event replay, a new Tavern store, or static/release-gate changes. P2’s real Windows directory-symlink and non-link reparse evidence remains separately blocked.
