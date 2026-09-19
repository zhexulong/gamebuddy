# Chat Pipeline — P3 Static Shell / API Same-Origin Composition

**Status:** frozen follow-on implementation brief; serial after P3 exact snapshot/bootstrap/draft slice. **Non-release.**

**Parents:**
- `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md`
- `design/41_CHAT_PIPELINE_BATCH_02_P2_STATIC_ARTIFACT.md`
- `design/43_CHAT_PIPELINE_BATCH_03_P2_OUTER_ARTIFACT_COMPOSITION.md`
- `design/46_CHAT_PIPELINE_BATCH_04_P3_EXACT_SNAPSHOT_BOOTSTRAP.md`
- `design/47_P3_MOUNTED_BROWSER_PROJECTION_AUTHORITY.md`

## Why a separate batch exists

P3 intentionally owns only the exact read facade, its three v1 API routes, and a read-only browser client. It explicitly excludes static-server mounting and browser artifact launch. The API adapter must therefore not claim that its loopback origin is a player-openable browser URL: `GET /` is not one of the mounted P3 API routes and returns no shell.

The verified browser shell already has a build identity of:

```ts
{ browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.tavern.browser.v1" }
```

The mounted P3 API profile instead has identity `gamebuddy.chat-core.p3`. Those are distinct facts owned by distinct layers. A safe player-openable same-origin composition needs an explicit binding between them; it must not replace either identity, infer a profile from filesystem metadata, add route aliases, or use a second listener plus permissive CORS.

## Objective

For one already-mounted P3 exact Chat runtime, construct **one loopback HTTP listener** that:

1. verifies the copied static browser artifact before listening through `verifyTavernStaticArtifact()` with the fixed build identity;
2. serves only the verified shell at `/` and exact manifest-listed static assets;
3. routes only the mounted `ComposedTavernProfile` P3 API paths to the existing P3 API adapter;
4. makes the browser’s fragment bootstrap handoff reach the same-origin API without a browser-set `Origin` header;
5. closes static and API connections before the mounted lease/facade is released.

This batch composes existing owners. It does not change P3 durable projection, browser contract schemas, artifact manifest schema, artifact publication, profile taxonomy, Chat selection/lifecycle, provider execution, SSE, draft mutation, Memory, release evidence, or P2’s Windows blocker.

## Authority graph

```text
fixed published browser artifact identity
  + fixed P3 composed profile
  + real mounted P3 read facade
  + private one-time bootstrap handoff
  ↓ serial Host composition
one loopback origin
  ├─ GET / and exact manifest assets → verified immutable static bytes
  └─ exact P3 API profile routes → existing v1 P3 adapter
```

The browser artifact identity proves build provenance only. `ComposedTavernProfile` remains the sole API route/operation/navigation authority. The static manifest never grants API routes, and the API profile never authorizes arbitrary asset paths.

## Frozen mount semantics

- The browser artifact root is the fixed internal production-artifact subtree `browser/tavern/v1`; it is neither CLI input nor discovered by glob/search/fallback.
- Before binding the listener, the composition verifies exactly `tavern-browser-artifact-manifest.json` via `verifyTavernStaticArtifact(root, { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.tavern.browser.v1" }, inspector)`.
- The outer listener dispatches by the closed static allowlist and the P3 profile’s exact route descriptors. It does not expose the static manifest, source maps, directory listing, SPA fallback, unknown dotted paths, legacy dialogue paths, or unmounted browser-contract routes.
- API requests retain P3’s exact loopback Host and same-origin checks. Browser scripts never set `Origin`: browsers generate it for the bootstrap POST. For cookie-authenticated safe GET reads, API admission accepts either exact `Origin` or a browser-generated `Sec-Fetch-Site: same-origin` request; an unguessable Strict session cookie remains mandatory.
- A browser launch URL is minted only by this composition, as `http://127.0.0.1:<port>/#boot=<private-token>`. It is never returned by the API-only adapter.
- On shutdown, stop accepting work, close all active connections in both static/API dispatch paths, then close the listener, then revoke the P3 facade/lease. No active HTTP request may retain a live facade read across lease closure.

## Required implementation shape

Use one serial writer. It may introduce a narrow composition module and focused tests, and it may modify the production dialogue entrypoint only as needed to invoke that module. Prefer a handler-level API adapter seam over proxying through a second local TCP server. A second listener would make same-origin and lifecycle ownership ambiguous and is not approved.

The composition must receive the already-created P3 facade, frozen profile, bootstrap token, fixed artifact root and published inspector capability as typed construction inputs. It must reject structural profiles and identity mismatches before listen. It must retain no raw durable IDs or browser secrets beyond its private handoff/session lifetime.

## Acceptance

Given a verified published browser subtree and an exact mounted P3 facade/profile,

when the serial composer starts,

then `GET /#boot=<token>` returns the verified shell, static asset requests are confined to the manifest allowlist, and the browser can redeem the one-time token through same-origin `POST /api/tavern/v1/bootstrap` then read `/state` and `/draft` without script-supplied `Origin` headers.

And unknown/legacy API paths, static manifest/source-map/unknown asset paths, cross-origin bootstrap, unauthenticated reads, and an artifact/profile identity mismatch each fail closed.

And shutting down active requests completes before lease/facade close.

## Required evidence

- focused Host composition test with a synthetic verified artifact and narrow fake P3 facade;
- real browser startup test using the composed listener and the shipped P3 client, with no route mocks;
- Host typecheck and `build:test` plus focused tests;
- Dialogue Web typecheck and production browser build through the existing verified production builder path;
- artifact verifier test remains green;
- `git diff --check` and independent review.

## Blocking conditions

P2 Windows reparse live evidence remains blocked. Passing this batch does not close P2, make the browser pipeline released, or permit a release claim. Stop for a new design decision if composition requires CORS, a second browser/API listener, a profile identity rewrite, fallback/static discovery, a legacy route, a P3 write operation, SSE/replay, or a second durable authority.
