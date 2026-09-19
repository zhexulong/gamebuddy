# 83 Tavern Full Management Frontend & Backend Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the frontend (`dialogue-web`) with verified versioned backend HTTP contracts (`TavernBrowserContractV1` in `host/src/tavern/browser-contract`), enabling persistent chat list querying, atomic title renaming, persistent draft save/discard synchronization, real-time SSE event streaming, and authentic snapshot fact wiring for World Info and Memory drawers without any mock data or fake lore.

**Architecture:** Connect `dialogue-web` components strictly across the HTTP/SSE boundary using `tavern_browser_api/v1` routes (`/api/tavern/v1/chats`, `/api/tavern/v1/chat/title`, `/api/tavern/v1/draft`, `/api/tavern/v1/events`, `/api/tavern/v1/messages`, `/api/tavern/v1/turns/:turnHandle/cancel`). Enforce CSRF token transmission, unpadded base64url idempotency keys, optimistic concurrency locks via `selectionGeneration` and `expectedManagementRevision`, and ensure all drawers (Chats, Characters, World Info, Memory, Settings) are strictly grounded in validated `TavernStateSnapshotV1` facts and SSE live events.

**Tech Stack:** React 19.2, TypeScript 5.9, Vite 8.2, TypeBox 1.1, Node.js Test Runner, Playwright 1.60.

**Specs:**
- `design/26_TAVERN_FRONTEND_DESIGN_SPEC.md`
- `design/28_TAVERN_MANAGEMENT_CAPABILITY_MATRIX.md`
- `design/29_TAVERN_CHAT_LIFECYCLE_V1.md`
- `design/78_CHAT_PIPELINE_FULL_PRODUCT_IMPLEMENTATION_PLAN.md`
- `host/src/tavern/browser-contract/index.ts`

---

## Global Constraints

- **Zero Mock / Zero Fake Data:** No hardcoded lore, fake default memories, or fabricated model names. Empty states must render standard localized placeholders.
- **Strict Boundary Modularity:** Frontend code in `dialogue-web` must never import internal Host Node.js classes/services. All interactions cross the `TavernBrowserContractV1` HTTP/SSE boundary.
- **Contract Boundary Integrity:** All API calls must conform strictly to `TavernBrowserContractV1` TypeBox schemas.
- **Security & CSRF Isolation:** Mutating requests (`POST`, `PUT`, `DELETE`) must carry the authentic `X-CSRF-Token` header and unpadded base64url `Idempotency-Key` where required.
- **Bilingual Internationalization:** Every new label, empty state, and status notice must be defined in `dialogue-web/src/i18n.ts` for both `en` and `zh-CN`.
- **Pipeline-Level BDD:** Every change must maintain 100% pass rate in Playwright visual/BDD tests, manifest boundary isolation tests, and host integration test batches.

---

### Task 1: Persistent Chat List & Atomic Title Renaming Integration

**Files:**
- Modify: `dialogue-web/src/p3-browser-api.ts`
- Modify: `dialogue-web/src/components/App.tsx`
- Modify: `dialogue-web/src/components/drawers/ChatsDrawer.tsx`
- Test: `dialogue-web/tests/tavern-ui.spec.ts`

**Interfaces:**
- Consumes: `GET /api/tavern/v1/chats` (`ChatListQueryV1Schema`), `PUT /api/tavern/v1/chat/title` (`RenameChatTitleCommandV1Schema`) from `host/src/tavern/browser-contract/index.ts`
- Produces: 
  - `fetchChatList(csrfToken?: string): Promise<ChatListV1>`
  - `renameChatTitle(chatHandle: string, title: string, expectedManagementRevision: number, selectionGeneration: number, csrfToken: string): Promise<ChatTitleV1>`

**Steps:**
- [x] Add `fetchChatList` and `renameChatTitle` client functions in `dialogue-web/src/p3-browser-api.ts` conforming to `TavernBrowserContractV1`.
- [x] Connect `ChatsDrawer` in `App.tsx` to automatically query the real chat list upon opening when the route is available in the mounted profile.
- [x] Implement atomic title renaming with optimistic UI update, server confirmation, and rollback/reload on 409 conflict.
- [x] Add automated Playwright tests in `tavern-ui.spec.ts` verifying real chat list rendering, selected chat highlight, and title renaming.

---

### Task 2: Persistent Draft State & Auto-Sync Integration

**Files:**
- Modify: `dialogue-web/src/p3-browser-api.ts`
- Modify: `dialogue-web/src/components/App.tsx`
- Modify: `dialogue-web/src/components/Composer.tsx`
- Test: `dialogue-web/tests/tavern-ui.spec.ts`

**Interfaces:**
- Consumes: `PUT /api/tavern/v1/draft` (`SaveDraftCommandV1Schema`), `DELETE /api/tavern/v1/draft` (`DiscardDraftCommandV1Schema`)
- Produces:
  - `saveDraft(text: string, selectionGeneration: number, expectedRevision: number, csrfToken: string): Promise<BrowserDraftV1>`
  - `discardDraft(selectionGeneration: number, expectedRevision: number, csrfToken: string): Promise<BrowserDraftV1>`

**Steps:**
- [x] Add `saveDraft` and `discardDraft` client functions to `dialogue-web/src/p3-browser-api.ts` returning `BrowserDraftV1`.
- [x] Implement debounced draft auto-save in `Composer` / `App.tsx` on text change with `expectedRevision` tracking.
- [x] Trigger `discardDraft` upon successful message submission to clear the server-persisted draft.
- [x] Verify draft reconciliation and revision conflict handling in `tavern-ui.spec.ts`.

---

### Task 3: Real-Time SSE Event Stream Binding

**Files:**
- Modify: `dialogue-web/src/p3-browser-api.ts`
- Modify: `dialogue-web/src/components/App.tsx`
- Test: `dialogue-web/tests/tavern-ui.spec.ts`

**Interfaces:**
- Consumes: `GET /api/tavern/v1/events` (`text/event-stream` returning `BrowserEventV1`)
- Produces: `createTavernEventStream(onEvent: (event: BrowserEventV1) => void, onError: (err: unknown) => void): { close(): void }`

**Steps:**
- [x] Add `createTavernEventStream` client function using browser native `EventSource`.
- [x] Subscribe to SSE events in `App.tsx` when `snapshot.eventStream` is present.
- [x] React to `message.committed`, `turn.state_changed`, and `draft.changed` events by updating state without full page reload.
- [x] Handle reconnection and resync (`stream.resync_required`) cleanly.
- [x] Add tests in `tavern-ui.spec.ts` verifying event-driven state updates.

---

### Task 4: Authentic Snapshot Fact Wiring (World Info & Memory Drawers)

**Files:**
- Modify: `dialogue-web/src/components/drawers/WorldInfoDrawer.tsx`
- Modify: `dialogue-web/src/components/drawers/MemoryDrawer.tsx`
- Modify: `dialogue-web/src/components/App.tsx`
- Test: `dialogue-web/tests/tavern-ui.spec.ts`

**Interfaces:**
- Consumes: `snapshot.chat.worldInfo` and `snapshot.memory` from `TavernStateSnapshotV1`
- Produces: Authentic rendering of active World Info bindings and Memory entries, with strict localized empty states when unpopulated

**Steps:**
- [x] Wire `snapshot.chat.worldInfo` into `WorldInfoDrawer` to display genuine active lorebook entries and keywords.
- [x] Wire `snapshot.memory` into `MemoryDrawer` to render authentic companion memories.
- [x] Ensure that when entries are empty, a clean, localized empty state is shown without any fake fallback data.
- [x] Handle `memory.changed` SSE events to re-read or update memories in real time.
- [x] Add Playwright tests in `tavern-ui.spec.ts` verifying World Info and Memory rendering with real and empty payloads.

---

### Task 5: Full Repository Regression & End-to-End Build Verification

**Files:**
- Test: `dialogue-web` test suite (`pnpm --filter @gamebuddy/dialogue-web test`)
- Test: `companion-host` test suite (`pnpm --filter @gamebuddy/companion-host test`)
- Build: Production & test artifacts (`pnpm --filter @gamebuddy/companion-host build && pnpm --filter @gamebuddy/companion-host build:test`)

**Steps:**
- [x] Run `pnpm --filter @gamebuddy/dialogue-web test` to verify all 25+ UI, visual, and manifest tests pass.
- [x] Run `pnpm --filter @gamebuddy/companion-host test` to verify all 13 test batches pass.
- [x] Rebuild and verify production artifact digests and manifest boundary seals.
