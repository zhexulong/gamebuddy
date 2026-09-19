# 75 Tavern P3 Frontend Modularization and Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the shipped `dialogue-web` P3 exact-active read-only browser into focused React modules, apply the approved three-tier visual system and bilingual browser chrome, and prove that the refactor preserves the frozen `tavern_browser_api/v1` authority and production-composition contracts.

**Architecture:** Keep `p3-browser-api.ts` as the only transport/decoder seam and the root `App` as the only bootstrap/view-state orchestrator. Presentation modules receive validated exact Chat fields and cannot derive capability from additive snapshot fields. P3 renders only the active Chat transcript, reconciled saved draft, and a browser-local language Settings drawer; all Host-backed management, mutation, connection, turn, Memory, and event-stream surfaces remain absent until a later mounted profile publishes them.

**Tech Stack:** React 19.2, TypeScript 5.9, Vite 8.2, Vanilla CSS, Lucide React 1.31, Playwright 1.60, Node.js test runner.

**Specs:**
- `design/26_TAVERN_FRONTEND_DESIGN_SPEC.md`
- `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md`
- `design/47_P3_MOUNTED_BROWSER_PROJECTION_AUTHORITY.md`
- `design/48_CHAT_PIPELINE_P3_STATIC_SHELL_API_COMPOSITION.md`

## Global Constraints

- **P3 is exact and read-only:** the mounted producer profile is `gamebuddy.chat-core.p3`, with only `bootstrap`, `state.read`, and `draft.read`; no write operation is mounted.
- **Producer exactness and consumer forward compatibility are separate:** Host/profile tests require the exact P3 operation/navigation/event-stream projection. The browser decoder may accept compatible additive fields it does not render, as required by `design/40`; additive data never creates DOM, controls, requests, navigation, status, or capability.
- **No capability invention:** render no Chats, Characters, World Info, Memory, send, cancel, export, connection, turn, Game, provider, or model surface from P3.
- **Browser-local Settings only:** the P3 Settings drawer contains only the UI-language preference. It does not represent a Host navigation item or operation and makes no API request.
- **No optimistic behavior:** no editable composer, submit control, synthetic message, unsafe retry, or locally inferred completion exists in this slice.
- **Authored-content isolation:** locale changes affect browser chrome only and preserve companion names, chat titles, transcript text/order, and draft text byte-for-byte.
- **Safe problems:** never render raw Host problem titles, codes, route names, request IDs, or diagnostics. Map typed dispositions to localized player-safe copy. P3 has no retry control because bootstrap is single-use and no safe recovery route is mounted.
- **Artifact integrity:** retain the verified browser manifest, fixed browser build identity, one-listener same-origin composition, fragment-token removal, and exact static-asset boundary.
- **Visual/accessibility:** use Lucide icons rather than Unicode glyphs; no nested cards, gradients, glow, or decorative orbs; meet WCAG AA contrast, 44 x 44 px targets, visible focus, reduced motion, and no horizontal overflow.
- **Cross-platform commands:** package scripts and Playwright startup must not depend on POSIX shell chaining. The composed-browser gate runs only after the Host-owned production builder has freshly built Vite into a private staging root, verified its browser manifest, copied that exact tree into the Host closure, verified the copied static tree, and published the generation.
- **No compatibility layer:** delete obsolete `.p3-*` and unused legacy frontend selectors instead of retaining aliases.

## Scope Matrix

| Surface | Status in this plan | Authority |
|---|---|---|
| Active companion, title, transcript | Implement | Typed P3 snapshot |
| Reconciled saved draft inspection | Implement | Typed P3 draft read |
| Loading and terminal safe-problem states | Implement | P3 bootstrap lifecycle |
| `en` / `zh-CN` browser chrome | Implement | Browser-local preference |
| Language Settings drawer | Implement | Browser-local only; no Host capability claim |
| Chats / Characters / World Info / Memory | Defer | No mounted P3 route/projection |
| Connection / turn / event-stream status | Defer | No renderable typed P3 status fact |
| Composer / send / stop / retry / reconnect | Defer | No mounted P3 mutation/recovery route |
| Provider/model/credential preferences | Defer | P9/later management profile |

Completion means **P3 frontend modularization is complete**. It is not completion of `design/26`, P9 Tavern management, `chat_core_v1`, or the Chat release plan.

## File Structure

```text
dialogue-web/
├── package.json
├── playwright.config.ts
├── src/
│   ├── main.tsx                         # DOM mount only
│   ├── p3-browser-api.ts               # sole P3 transport/decoder seam
│   ├── i18n.ts                         # typed, key-complete chrome catalogs
│   ├── types.ts                        # root view and local panel state
│   ├── style.css                       # P3-only three-tier design system
│   └── components/
│       ├── App.tsx                     # bootstrap/view-state owner
│       ├── AppBar.tsx                  # inert brand, companion, Settings
│       ├── SettingsDrawer.tsx          # locale and focus/history lifecycle
│       ├── Timeline.tsx                # transcript reading axis
│       ├── MessageBubble.tsx           # one validated P3 message
│       ├── DraftSection.tsx            # named read-only region
│       ├── ProblemView.tsx             # localized terminal problem
│       └── SkipLink.tsx                # keyboard skip navigation
└── tests/
    ├── tavern-ui.spec.ts               # contract, locale, a11y, layout
    ├── tavern-visual.spec.ts           # viewport/locale screenshots
    ├── tavern-visual.spec.ts-snapshots/
    ├── manifest-boundary.test.mjs
    └── p3-composed-browser.test.mjs
```

---

### Task 1: Freeze Characterization and Portable Test Commands

**Files:**
- Modify: `dialogue-web/package.json`
- Modify: `dialogue-web/playwright.config.ts`
- Modify: `dialogue-web/tests/manifest-boundary.test.mjs`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Vite on `127.0.0.1:4173`; a freshly published Host-owned production generation for composed-browser validation.
- Produces: focused commands while retaining one complete default frontend gate.

- [x] **Step 1: Establish the red/green baseline**

Run:

```bash
pnpm --filter @gamebuddy/dialogue-web typecheck
pnpm --filter @gamebuddy/dialogue-web exec playwright test tests/tavern-ui.spec.ts
```

Expected: PASS. Record and resolve any pre-existing failure before changing selectors.

- [x] **Step 2: Add the icon dependency and split scripts without weakening `test`**

Add exact `lucide-react: 1.31.0` as a **runtime** dependency (it ships icon SVGs into the browser bundle) and update the lockfile through pnpm. Define:

```json
{
  "test": "pnpm run test:ui && pnpm run test:artifact && pnpm run test:composed",
  "test:ui": "playwright test tests/tavern-ui.spec.ts tests/tavern-visual.spec.ts",
  "test:artifact": "node --test tests/manifest-boundary.test.mjs",
  "test:composed": "node --test tests/p3-composed-browser.test.mjs"
}
```

Keep existing `build`, `dev`, and `typecheck`. Update `manifest-boundary.test.mjs` line 58 from `["react", "react-dom"]` to `["lucide-react", "react", "react-dom"]` (sorted) because `lucide-react` is a runtime dependency that emits tree-shaken SVG into the production bundle. Do not put release-path tests behind an optional `test:all`.

- [x] **Step 3: Make Playwright startup portable**

Use `pnpm exec vite --host 127.0.0.1 --port 4173`, retain existing browser/reporter/retry/trace policy, and add a 30-second timeout. Do not compile Host code through shell `&&`; production composition is prepared separately.

- [x] **Step 4: Verify**

Run typecheck, `test:artifact`, and the current `tavern-ui.spec.ts`. Expected: PASS.

---

### Task 2: Typed Localization and Root View State

**Files:**
- Create: `dialogue-web/src/types.ts`
- Modify: `dialogue-web/src/i18n.ts`
- Modify: `dialogue-web/tests/tavern-ui.spec.ts`

**Interfaces:**
- Produces: `Locale`, `MessageKey`, `Messages`, `resolveLocale`, `messages`, `applyDocumentLocale`, `persistLocale`, `ViewState`, and `ActivePanel`.
- Invariant: English owns the key union; Chinese satisfies the exact same keys at compile time.

- [x] **Step 1: Add failing locale tests**

Prove stored preference precedence; invalid preference fallback; `zh`, `zh-Hans`, and `zh-CN` mapping; English fallback; initial `<html lang>` without persisting browser fallback; immediate persisted switching; localized accessible names; and byte-exact authored content after switching.

- [x] **Step 2: Make catalogs exact**

Replace the current broad management catalog with the exact P3 browser-chrome key set; delete dormant keys for send/composer, connection, Chats, Characters, World Info, Memory, Game, receipts, provider/model, and every other unmounted surface. Derive `MessageKey` from the pruned English catalog and declare Chinese with `satisfies Record<MessageKey, string>`. Include skip link, transcript/draft labels, empty/loading states, settings controls, and each safe-problem disposition. Components must not choose inline text by comparing `locale`.

- [x] **Step 3: Separate resolution, DOM application, and persistence**

`resolveLocale` receives testable storage/language inputs or narrow adapters; `applyDocumentLocale` only sets `<html lang>`; `persistLocale` only writes `gamebuddy.tavern.ui-locale`. Browser fallback must not become a stored choice automatically.

- [x] **Step 4: Define narrow state**

```typescript
export type ViewState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; snapshot: P3Snapshot; draft: P3Draft }>
  | Readonly<{
      kind: "problem";
      disposition: "bootstrap_unavailable" | "temporarily_unavailable" | "reconciliation_failed";
    }>;

export type ActivePanel = "none" | "settings";
```

Do not add Host operation, navigation, Memory, connection, or turn facts to browser-local state.

- [x] **Step 5: Verify**

Run typecheck and focused locale tests. Expected: PASS.

---

### Task 3: Three-Tier P3 Stylesheet

**Files:**
- Modify: `dialogue-web/src/style.css`

**Interfaces:**
- Consumes: exact primitive values from `design/26` section 6.
- Produces: primitive, semantic, and component/layout tokens used by every P3 module.

- [x] **Step 1: Add failing browser assertions**

Assert token presence, 44 x 44 px controls, maximum 800 px reading measure, no overflow at all required viewports, full-height loading/problem states, reduced-motion behavior, and at least 4.5:1 contrast for specified text colors on `--surface-panel` using sRGB luminance.

- [x] **Step 2: Replace rather than layer the token system**

Convert raw semantic values to the exact `Primitive -> Semantic -> Component` chain. Use approved `--motion-*` names and remove legacy `--ease-*` aliases after consumers move.

- [x] **Step 3: Reduce CSS to P3-owned selectors**

Retain only the new shell, app bar, transcript, draft, problem, drawer, form, and skip-link selectors. Delete dormant management/composer/send/notice selectors and all `.p3-*` aliases. Do not add compatibility CSS.

- [x] **Step 4: Implement stable geometry**

Use `100dvh`, safe-area insets, fixed app-bar height, `minmax(0, 1fr)` scroll ownership, `min(420px, 100vw)` drawer, stable avatar/control dimensions, `overflow-wrap: anywhere`, and mobile full-height sheet behavior. Do not scale type by viewport width.

- [x] **Step 5: Verify**

Run focused token, contrast, target-size, reduced-motion, and overflow tests. Expected: PASS.

---

### Task 4: Pure Transcript and Draft Modules

**Files:**
- Create: `dialogue-web/src/components/SkipLink.tsx`
- Create: `dialogue-web/src/components/MessageBubble.tsx`
- Create: `dialogue-web/src/components/Timeline.tsx`
- Create: `dialogue-web/src/components/DraftSection.tsx`
- Modify: `dialogue-web/tests/tavern-ui.spec.ts`

**Interfaces:**
- `SkipLink({ label }: { label: string })`
- `MessageBubble({ message, authorName, playerLabel })`
- `Timeline({ transcript, companionName, chatTitle, labels })`
- `DraftSection({ draft, labels })`

- [x] **Step 1: Preserve characterization coverage**

Use semantic roles rather than implementation class names. Preserve exact title/name/messages/draft, message count, absence of composer/submit/Memory, one bootstrap request, one draft request, and fragment removal. Retain current rejection tests for invalid browser contract, invalid profile, and malformed transcript.

- [x] **Step 2: Implement pure presentation**

Render exact validated text without inspecting `operations`, `navigation`, `memory`, `turn`, or `eventStream`. Use neutral monograms because P3 has no avatar contract. Use one `<h1>` and sequential headings. An empty transcript shows localized chrome but no synthetic message.

Keep the saved draft as a labeled `<section>`/named `region`, not page-level `contentinfo`; this is the correct landmark and is required by the real composed-browser test.

- [x] **Step 3: Test authored-content resilience**

Cover multiline text, long unbroken tokens, Chinese text, and long title/name values with no clipping, normalization, rewriting, or page overflow.

- [x] **Step 4: Verify**

Run typecheck and focused render tests. Expected: PASS.

---

### Task 5: App Bar and Browser-Local Settings Drawer

**Files:**
- Create: `dialogue-web/src/components/AppBar.tsx`
- Create: `dialogue-web/src/components/SettingsDrawer.tsx`
- Modify: `dialogue-web/tests/tavern-ui.spec.ts`

**Interfaces:**
- `AppBar` renders an inert brand, exact companion name/monogram, and one Settings icon button.
- `SettingsDrawer` consumes only locale callbacks and performs no fetch.

- [x] **Step 1: Add failing authority and dialog tests**

Prove the brand is not a Chats button; no connection/turn status exists; Settings causes no additional API request; no management/mutation controls appear even with additive snapshot data; icon controls are localized Lucide SVGs with 44 px targets; focus enters/traps/restores; Escape/backdrop/Back close; and `?panel=settings` restores only after successful bootstrap while unknown values are ignored.

- [x] **Step 2: Implement AppBar without invented state**

Do not render `Connected`, `Online`, generation state, or status dots. Do not make the brand a panel opener. Use Lucide `Settings`, never Unicode or hand-drawn SVG.

- [x] **Step 3: Implement the one-purpose drawer**

Use Lucide `X`. Include only a native labeled language selector. Implement focus entry, Tab/Shift+Tab cycling, Escape/backdrop closure, invoker restoration, and inert/background interaction suppression.

- [x] **Step 4: Implement safe browser history**

After successful bootstrap removes the fragment, opening Settings pushes `?panel=settings` while preserving unrelated safe query parameters. `popstate` drives closure/restoration. Never store the bootstrap token, snapshot, transcript, draft, or opaque handles in history state.

- [x] **Step 5: Verify**

Run authority and accessibility tests. Expect exactly one bootstrap and one draft request.

---

### Task 6: Root App and Safe Bootstrap States

**Files:**
- Create: `dialogue-web/src/components/App.tsx`
- Create: `dialogue-web/src/components/ProblemView.tsx`
- Modify: `dialogue-web/src/main.tsx`

**Interfaces:**
- `main.tsx` only imports CSS and mounts `<App />` under `StrictMode`.
- `App` owns one-time bootstrap, locale, local panel, and `ViewState`.
- `ProblemView` receives localized safe copy and exposes no retry action.

- [x] **Step 1: Add failing bootstrap-state tests**

Cover missing handoff, retryable Host problem, reconciliation problem, malformed response, and Strict Mode. Assert one redemption attempt, no raw title/code/request ID, localized copy, no retry button, and full-viewport layout.

- [x] **Step 2: Extract the root without changing transport semantics**

Preserve `bootstrapStarted`. Remove `#boot` only after snapshot/draft reconciliation succeeds. Never re-read or replay a consumed token.

- [x] **Step 3: Map failures safely**

Map missing token to `bootstrap_unavailable`, typed retryable problem to `temporarily_unavailable`, and all contract/profile/reconciliation/malformed/unknown failures to `reconciliation_failed`. Never render `problem.title` or `problem.code`.

- [x] **Step 4: Assemble only P3**

Render `SkipLink`, `AppBar`, `Timeline`, `DraftSection`, and optional `SettingsDrawer`. Pass exact Chat fields downward; do not pass unrendered capability projections to presentation modules.

- [x] **Step 5: Verify**

Run typecheck and the behavioral suite directly:

```bash
pnpm --filter @gamebuddy/dialogue-web exec playwright test tests/tavern-ui.spec.ts
```

Expected: PASS. Do not invoke `test:ui` until Task 7 has created `tavern-visual.spec.ts`.

---

### Task 7: Visual, Responsive, and Accessibility Matrix

**Files:**
- Create: `dialogue-web/tests/tavern-visual.spec.ts`
- Create: `dialogue-web/tests/tavern-visual.spec.ts-snapshots/*`
- Modify: `dialogue-web/tests/tavern-ui.spec.ts`

**Interfaces:**
- Consumes: deterministic original SFW fixtures only.
- Produces: presentation evidence, never authority evidence.

- [x] **Step 1: Test the required viewport/locale matrix**

Test closed and open Settings at 375 x 667, 768 x 900, 1024 x 900, and 1440 x 1000 in `en` and `zh-CN`, plus 667 x 375 phone landscape. Assert no overflow/overlap, stable controls, readable timeline, visible draft, and reachable Settings.

- [x] **Step 2: Add deterministic screenshots**

Use `toHaveScreenshot` with animations disabled and fixed timezone/locale. Commit Windows Chromium baselines matching CI. Fixtures must contain no production dialogue, provider/credential, Pi/Magic Context, or real-run opaque data.

- [x] **Step 3: Cover semantic keyboard behavior**

Test skip-link activation, sequential headings, named transcript/draft regions, localized icon labels/tooltips, modal focus lifecycle, browser Back, reduced motion, and 44 px targets.

- [x] **Step 4: Preserve consumer forward compatibility without granting UI**

Keep a fixture with additive `operations`, navigation, turn, World Info, Memory, and event stream. It may decode under `design/40`, but DOM and network behavior must remain transcript + draft + browser-local Settings only.

Separately retain `host/src/dialogue-web.test.ts`, including `P3 mounts only profile-authorized v1 bootstrap, state, and draft reads` and `P3 rejects profiles other than its frozen exact profile`. These producer-side tests must prove exact routes, empty operations, exact `chat` navigation, `eventStream: null`, unavailable Memory, and rejection of widened/reordered profiles. Do not confuse consumer compatibility with producer permission.

- [x] **Step 5: Verify twice**

Run the complete Playwright suite normally and with `CI=1`. Expect no retries, focused/skipped tests, or screenshot mismatch.

---

### Task 8: Production Composition and Final Gate

**Files:**
- Modify only if semantic selectors intentionally change: `dialogue-web/tests/p3-composed-browser.test.mjs`
- No Host contract/profile production changes are in scope.

**Interfaces:**
- Consumes: a generation published by `host/scripts/build-production-artifact.mjs`, whose owner builds the current frontend source into private staging and verifies/copies it before publication.
- Produces: producer exact-profile evidence and proof that the current modular source is the shipped same-origin artifact.

- [x] **Step 1: Run source checks**

```bash
pnpm --filter @gamebuddy/dialogue-web typecheck
pnpm --filter @gamebuddy/dialogue-web test:ui
pnpm --filter @gamebuddy/dialogue-web test:artifact
pnpm exec biome check dialogue-web/src dialogue-web/tests/tavern-ui.spec.ts dialogue-web/tests/tavern-visual.spec.ts
```

- [x] **Step 2: Run the producer-side exact-profile gate**

Run:

```bash
pnpm --filter @gamebuddy/companion-host test
```

Require the unchanged `host/src/dialogue-web.test.ts` cases to pass, especially exact P3 routes, empty operations, exact `chat` navigation, `eventStream: null`, unavailable Memory, and rejection of widened, reordered, or renamed profiles. This is producer evidence; the browser additive fixture is not a substitute.

- [x] **Step 3: Publish through the production owner**

Prepare vendored Magic Context exactly as CI does on a fresh checkout, then run:

```bash
pnpm --filter @gamebuddy/companion-host build
```

The Host builder itself must invoke Vite against the current `dialogue-web` source into a new private `.build-staging/<buildId>` root, verify its browser manifest, copy exactly those bytes into the production closure, verify the copied `browser/tavern/v1` tree, and only then atomically publish a new `host/dist/current.json` generation. Record the previous and resulting generation IDs and require them to differ. Do not run standalone `dialogue-web build` as provenance, use a stale generation, or use a mocked listener.

- [x] **Step 4: Run the complete frontend gate against that generation**

Run `pnpm --filter @gamebuddy/dialogue-web test`. Require mocked UI/visual tests, artifact boundary, and `p3-composed-browser.test.mjs` without route mocks. Verify it resolves the just-recorded generation, all API requests are same-origin, exact title/transcript/draft render, and the bootstrap fragment is removed.

- [x] **Step 5: Run hygiene checks**

Run `git diff --check` and `pnpm check:text-hygiene`. Inspect the scoped diff and confirm unrelated dirty-worktree changes were not overwritten.

- [x] **Step 6: Independent final review**

A fresh read-only reviewer must answer:

1. Can additive P3 data create any control, status, request, or navigation path?
2. Are one-time bootstrap, draft reconciliation, safe failures, artifact identity, and one-listener composition preserved?
3. Is every chrome/accessibility string localized while authored values remain exact?
4. Do keyboard, responsive, contrast, reduced-motion, and screenshot gates cover all `design/26` requirements applicable to this slice?
5. Are non-P3 management and release claims explicitly deferred?

Any blocker returns to its owning task and reruns the focused and final gates.

## Acceptance Scenario

**Given** a freshly built verified browser artifact mounted with the exact `gamebuddy.chat-core.p3` profile and one exact active Chat,

**When** the player opens the one-time same-origin URL, switches browser chrome between English and Simplified Chinese, operates local Settings by pointer/keyboard/Escape/backdrop/Back, and uses the required viewport matrix,

**Then** bootstrap is redeemed exactly once, only the exact transcript and reconciled draft render, the secret fragment is removed, authored content remains exact, and the tokenized UI is accessible and non-overlapping,

**And** additive unrendered snapshot data cannot create a Host-backed control, status, request, route, or success claim,

**And** malformed identity/content and bootstrap failures produce localized terminal states without raw diagnostics or unsafe retry,

**And** the same modular browser bytes pass the manifest boundary and real one-listener composed-browser test.

## Stop Conditions

Stop for a new owning design/profile decision if implementation requires:

- rendering Chats, Characters, World Info, Memory, Game, provider/model, connection, turn, or event-stream state;
- adding a Host route, operation, navigation item, recovery action, retry, SSE, or mutation;
- changing `tavern_browser_api/v1`, `gamebuddy.chat-core.p3`, browser artifact identity, bootstrap/cookie/origin admission, or manifest semantics;
- importing Host runtime/domain modules into the frontend;
- accepting a stale/pre-existing production artifact as final composition evidence.
