# 26 Tavern Frontend Design Specification

> **Status:** approved product-design and engineering baseline for the Tavern UI. This document governs player-facing information architecture, three-tier design token architecture, component topology, language behavior, visual language, interaction, accessibility, and acceptance checks. It incorporates the management boundaries from `28_TAVERN_MANAGEMENT_CAPABILITY_MATRIX.md` and the reference-pipeline state delivery model from `72_CHAT_PIPELINE_BATCH_08_P7_REFERENCE_PIPELINE_STATE_DELIVERY.md`. Historical pre-cutover version archived in `design/legacy/26_TAVERN_FRONTEND_DESIGN_SPEC.md`.

## 1. Decision and scope

GameBuddy Tavern is a **character-chat workspace**. Its first screen is the current conversation, not an implementation console, onboarding/marketing page, or game-control dashboard. The product should feel familiar to users of character-chat Tavern software without copying SillyTavern source, CSS, brand, assets, prompts, or power-user feature set.

The player-facing Tavern baseline and its audited current/missing state are specified by `28_TAVERN_MANAGEMENT_CAPABILITY_MATRIX.md`. No incomplete row may be described in UI, docs or release evidence as a finished Tavern management feature.

Until a corresponding management profile and Host route are released, a control is **absent rather than presented as a disabled Tavern lookalike**. The product never implies support for arbitrary remote endpoint execution, prompt/tool/Game-permission configuration, scripts, macros, regex, HTML runtime, extensions, group orchestration, visual-novel layout, or any uncontracted message operation.

## 2. Reference audit and resulting corrections

### 2.1 Sources reviewed

| Reference | What it establishes | What GameBuddy adopts |
|---|---|---|
| `ref/external/SillyTavern` at the commit pinned by design/24 | Chat-first timeline and fixed composer; Character Management, Chat History, World Info, and settings as discoverable drawers/panels; persisted language selection and locale fallback. | Conversation is primary; libraries and settings are contextual panels; terminology follows familiar character-chat nouns. |
| SillyTavern `public/locales/lang.json`, `public/scripts/i18n.js`, `public/locales/zh-cn.json` | `localStorage` preference, browser-locale fallback, `<html lang>` update, explicit selector, Chinese UI vocabulary. | A complete `en` + `zh-CN` keyed catalog, local preference, deterministic fallback, and visible language choice. |
| `TavernAI/TavernAI-v1` public application | Tavern lineage is a character/chat application with characters, chats, worlds, and import/export nearby. | Character/chat content remains close to the conversation instead of becoming a generic operations console. |
| `ref/external/character-card-spec-v2` and `ref/external/character-card-spec-v3` | Character-card text is creator/user data, distinct from UI labels. | Locale switching never rewrites card, World Info, scenario, greeting, or transcript content. |
| `.agents/skills/ui-ux-pro-max` & `.agents/skills/design-system` | Accessibility, stable interaction targets, responsive testing, three-layer semantic theme tokens, motion constraints, and React rendering guidance. | Three-tier tokenized dark-first visual system, accessible native controls, 44 px interaction targets, and viewport/motion validation. |
| `ref/external/Liyuan-Tavern-Reference` (original project: Liyuan) | A local Chinese-first agent roleplay frontend with top-bar panel docking, card/avatar presentation, session/worldline/lorebook panels, decision cards, and separate story/assistant surfaces. | Panel-driven context access, real card imagery where available, choice cards as a distinct interaction primitive, and visible separation between story output and operational status. |

### 2.2 Majority convention versus SillyTavern-specific convention

The common Tavern baseline is: a conversation-focused screen; access to characters and saved chats; creation/import; per-chat setup for Persona, Scenario, and opening when those are implemented; a World Info entry point; and responsive panels on narrow displays. GameBuddy extends this with a single Chat-first Game status and recovery surface: it presents only current typed Host facts and explicit lifecycle controls, never a raw game-control UI or a second hidden dashboard.

SillyTavern-specific power-user breadth is **not** a general Tavern minimum: provider configuration, prompt manager, presets, extension settings, macros, STscript, regex, global lorebook editing, multi-character orchestration, auto-mode, extensive swipe/branch controls, and movable multi-drawer layouts. GameBuddy adopts the former and deliberately excludes the latter.

Liyuan adds useful roleplay-specific patterns but is not a scope template. Its top bar demonstrates that panels can be discoverable and remembered, its message renderer keeps narrative text separate from process activity, and its choice cards make consequential decisions legible. However, its many technical panels, dense tool/assistant controls, and single-language assumptions would make a narrow Tavern product feel like an agent console. GameBuddy therefore keeps player actions near the chat and hides implementation/tooling surfaces entirely. A panel title must answer a player question; if it answers an operator question, it does not belong in the Tavern UI.

This corrects the earlier fixed three-column proposal. On desktop, management may be a collapsible secondary rail or one contextual drawer. It must not be a permanent right-side detail column. On mobile, management is a full-height sheet; it is not a compressed three-column layout or an ambiguous choice between a drawer and bottom navigation.

## 3. Player vocabulary

Use these labels consistently. A label is only shipped when its operation is actually shipped.

| UI key | English | Simplified Chinese | Notes |
|---|---|---|---|
| `characters` | Characters | 角色 | Roleplay companions, not player Personas. |
| `chatHistory` | Chat History | 聊天记录 | Saved conversations. |
| `newChat` | New Chat | 新聊天 | Creates a new conversation, not a new companion. |
| `newCharacter` | New Character | 新建角色 | Only the real creation/import flow. |
| `persona` | Persona | 用户设定 | The player's Tavern presentation. |
| `scenario` | Scenario | 情景 | A Tavern premise, never a Game fact. |
| `openingMessage` | Opening Message | 开场白 | The selected first companion message. |
| `alternateGreetings` | Alternate Greetings | 其他开场白 | Only when actual variants are selectable. |
| `worldInfo` | World Info | 世界书 | A chat attachment/view, not a full editor. |
| `importCharacterCard` | Import Character Card | 导入角色卡 | Imports a card for review. |
| `reviewDetails` | Review character details | 确认角色信息 | Reviewable imported material. |
| `exportChat` | Export Chat | 导出聊天 | Never label it JSONL unless that exact format is implemented. |
| `language` | Language | 语言 | Global UI preference. |

Never expose `Host`, `runtime`, `controlled`, `candidate`, `binding`, `read-back`, `profile revision`, hash, opaque ID, provenance, source revision, or internal route names as ordinary product text. These remain implementation and evidence concepts. Player-facing outcomes are concise: `Character created`, `Chat created`, `World Info updated`, or `Couldn’t open this chat`.

## 4. Information architecture and component topology

### 4.1 Default conversation shell

The default and refresh-resumed screen contains:

1. **`AppBar`**: A compact 56 px application bar with the brand mark (`GameBuddy`), active companion name with fallback monogram, an unobtrusive connection/turn status indicator, and affordances to open contextual panels (`Chats`, `Characters`, `World Info`, `Settings`).
2. **`Timeline`**: A single independently scrollable conversation timeline (`max-width: 800px`). Player and companion messages have distinct but restrained treatments. Character avatars appear only when backed by a real safe avatar contract; otherwise use a stable neutral monogram placeholder, not a decorative symbol.
3. **`Composer` / `DraftSection`**: A fixed bottom composer with a labeled auto-resizing textarea (min 48 px, max 176 px), submit action, and contextual controls (e.g. Stop, Export). In the P3 read-only phase, this renders as a dedicated read-only draft inspection area without interactive send controls.
4. **`ProblemBanner`**: A clean, accessible recovery alert displayed when bootstrap or state reconciliation fails, providing actionable retry/reconnect steps without technical jargon.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ AppBar (56px) [GB] Mira · Online                      [Chats][Chars][Set] │
├────────────────────────────────────────────────────────────────────────────┤
│ Timeline (640-800px center measure)                                        │
│                                                                            │
│  [M] Mira                                                                  │
│      ┌─────────────────────────────────────────────────────────────┐       │
│      │ A durable opening message.                                  │       │
│      └─────────────────────────────────────────────────────────────┘       │
│                                                                            │
│                                                          You [Y]           │
│                               ┌────────────────────────────────────┐       │
│                               │ A durable player reply.            │       │
│                               └────────────────────────────────────┘       │
│                                                                            │
├────────────────────────────────────────────────────────────────────────────┤
│ Composer / Saved Draft (fixed bottom, 48-176px + safe-area insets)        │
└────────────────────────────────────────────────────────────────────────────┘
```

#### Entry and recovery states

The shell has explicit, non-fabricated first-run states:

- **No active character:** show a compact empty conversation state with `Create character` and `Import character card`. Do not show a disabled composer, fake transcript, or a generic marketing hero.
- **Character exists, no active chat:** show the active character and `New chat` / `Chat history`; the composer remains unavailable until a real chat is opened or created.
- **Blank chat:** show the character context and an enabled composer, but no synthetic system message.
- **Loading a chat:** retain the already-rendered conversation until the replacement transcript has atomically arrived; use a small in-place loading notice. Do not clear the timeline first.
- **Reconnect / offline:** retain readable transcript and draft. Sending is disabled only while the request cannot be accepted, with a concise retry/reconnect notice. Reconnection never duplicates, replays, or invents messages.
- **Send or generation failure:** preserve the draft and prior transcript, identify the failed action, and offer the real next action (`Try again` only when the exact request is safe to retry; otherwise `Reconnect` or `Edit message`).

#### Delivery model and submission state machine

In accordance with `design/72` (P7 Reference Pipeline):
- **No optimistic submit:** The player message bubble is rendered strictly after receiving the `202 Accepted` response with committed representation or authoritative `/state` read-back. The browser never fabricates an uncommitted bubble.
- **In-flight locking:** Composer is disabled upon submit, remains disabled while turn is active, and is re-enabled only from a validated snapshot showing `active turn`.
- **Bounded polling:** State updates during turn execution are retrieved via bounded `GET /api/tavern/v1/state` polling (utilizing unmounted SSE if available). Every state update is an atomic snapshot replacement.

### 4.2 Contextual panels (Single Drawer Model)

Panel entry points are intentionally few and grouped by player intent. There is **exactly one management panel (drawer) open at a time**, anchored to the right (`width: min(420px, 100vw)`), with an animated backdrop (`#0007`), keyboard focus trap, and Escape/Backdrop close support:

- **Chats:** current chat, Chat History, and New Chat;
- **Characters:** active character summary, Characters, New Character, and Import Character Card;
- **World Info:** available/selected status and attach/remove when permitted;
- **Import / Export:** Import Character Card plus only the exact export formats the active content supports;
- **Game:** current typed game connection/surface state, published capability summary, active execution, latest authoritative outcome, and only separately released independent Game lifecycle controls; absent until its Host projection exists.
- **Settings:** Language selector (`English` / `简体中文`) with immediate re-render and local persistence; plus read-only profile summaries when published.

### 4.3 Characters and chats

**Characters** is a searchable/scannable library only when server metadata contains player-readable names and summaries. Every visible command is real:

- `View`/`Open` only appears when it has a matching selection route;
- `Create` and `Import Character Card` lead to their implemented flows;
- a newly created character is described as created, not as made active, switched, or attached to the current chat unless the server confirms that exact transition.

**Chat History** is a chat picker, not an operations list. Each item contains only backed player-readable data such as a title/opening summary and activity time. Opening a chat atomically refreshes the active thread, transcript, message 0, World Info state, character context, and state polling. On failure it retains the existing conversation and announces no success.

### 4.4 New Chat

New Chat is a short contextual form, not a standalone administrative page. It contains exactly the catalog fields returned by the Host:

- Persona: readable display name plus a concise source-authorized summary;
- Scenario: readable display name and short preview, never provenance/owner;
- Opening: blank, first message, and each alternate greeting with a safe, source-authorized preview; no raw artifact IDs;
- Dialogue Examples only if a versioned Host catalog, selection route, materialization contract, and player-readable labels are released together. Until then, do not mention or simulate the control.

Creation result must be explicit: a durable greeting message 0 is rendered before success is shown, while a blank opening contains no empty bubble. The new chat becomes active only if the Host response confirms activation; if creation is intentionally inert, the UI says `Chat created` and offers an actual `Open chat` action.

### 4.5 World Info

Call the player feature `World Info` / `世界书`; keep `WorldBookBinding` in code only. The UI differentiates:

- `Available`: a World Info item can be used for this chat;
- `In this chat`: the exact active chat has selected it, verified by the current chat read endpoint;
- `Removed`: no World Info is selected;
- `Locked`: the current conversation no longer permits changing it.

Show Attach, Remove, and unavailable/locked states only when their corresponding server operations exist. A World Info attachment is described as chat background, never as a current Game-world truth.

### 4.6 Import and export

Import Character Card follows a comprehensible staged flow:

1. Select or paste a supported character card.
2. Review every returned field classification in player language: usable, not included, or unavailable, with a short safe reason.
3. Select only material eligible for review; an empty eligible state explains that no character details can be used, without pretending the import succeeded as a runnable character.
4. Confirm `Create New Character`; show the exact confirmed outcome.

The page never describes inert imported data as active, nor suggests that scripts, macros, HTML, extensions, preset settings, or external resources were loaded. Chat and World Info exports occur after explicit user action and are named only for their actual published format.

### 4.7 Eligible reply operation

The current release profile declares an effect-aware chat operation. Therefore the UI must expose it only on the newest eligible pure-Tavern companion reply, using the exact Host contract. It is contextual to that reply, never a generic toolbar feature. It visibly handles unavailable, stale, external-effect, and failure states without claiming a retry/swipe succeeded. No other message operation is shown until its independent contract is released.

## 5. Localization and language behavior

### 5.1 Release contract

`en` and `zh-CN` ship together with complete locale catalogs for every player-facing UI key: navigation, controls, validation, empty/loading/error states, notices, tooltips, `aria-label`s, titles, file names, and date/time formats. A missing `zh-CN` key falls back to English and is detected in CI; the UI must never display a raw localization key.

The locale resolution order is:

1. `localStorage["gamebuddy.tavern.ui-locale"]` when it is `en` or `zh-CN`;
2. `navigator.languages`, then `navigator.language`, mapped so `zh`, `zh-Hans`, and `zh-CN` resolve to `zh-CN`;
3. `en`.

The Settings panel provides an always-visible `Language / 语言` selector with the native choices `English` and `简体中文`. It works from desktop and mobile, persists only this browser UI preference, updates `document.documentElement.lang`, and re-renders immediately. A page reload is permissible only if state restoration preserves the active chat, current panel/route, and unsent draft; in-place re-render is preferred.

### 5.2 Chrome versus authored content

Locale changes translate **UI chrome only**. They must never translate, normalize, reorder, summarize, or rewrite:

- character and Persona names/descriptions;
- Scenario, greeting, Dialogue Example, or World Info text;
- imported card documents/reports beyond their UI classification labels;
- player and companion transcript messages;
- stored artifact values, chat selection, or identity data.

UI locale and conversation/message locale are separate settings. Selecting English UI cannot force a Chinese character to speak English, and selecting Chinese UI cannot alter a user’s message language. The client must not send a hard-coded UI locale as a model-language instruction. Any future reply-language feature requires its own explicit, player-visible contract.

### 5.3 Date, time, and text resilience

Use `Intl.DateTimeFormat` for locale-sensitive UI dates while retaining stored timestamps unchanged. Design all buttons, headings, list rows, notices, and menus for both English and Chinese expansion. User-authored text wraps at word or grapheme boundaries without horizontal overflow.

## 6. Visual system and three-tier token architecture

### 6.1 Direction

Use a dark-first, content-first character-chat interface. The reference is Tavern interaction density and hierarchy, not a literal medieval tavern or a copy of SillyTavern’s visual design. No hero section, parchment treatment, marketing card grid, blur/glass effects, gradient orb, purple-blue gradient, or artificial character content.

The visual system is organized into a formal **three-tier design token architecture** (`Primitive → Semantic → Component`):

```text
Layer 1: Primitive Tokens (Raw Palette, Radii, Motion curves)
      ↓
Layer 2: Semantic Tokens (Surface, Text, Border, Accent, Feedback)
      ↓
Layer 3: Component & Layout Tokens (AppBar, Timeline, Composer, Drawer)
```

### 6.2 Token definitions

```css
/* ==========================================================================
   Layer 1: Primitive Tokens
   ========================================================================== */
:root {
  --palette-gray-950: #121212;
  --palette-gray-900: #1b1a1a;
  --palette-gray-800: #252323;
  --palette-gray-700: #383331;
  --palette-gray-600: #655b55;
  --palette-gray-400: #90877e;
  --palette-gray-200: #c8c0b6;
  --palette-gray-100: #f5f0e8;

  --palette-burgundy-base: #c8787d;
  --palette-burgundy-hover: #d07a7f;
  --palette-burgundy-dark: #3d272b;
  --palette-burgundy-selection: #533137;
  --palette-burgundy-border: #71454b;

  --palette-gold-base: #d6a85b;
  --palette-teal-base: #4fae9a;
  --palette-crimson-base: #d96565;

  --motion-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --motion-ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
  --motion-duration-fast: 150ms;
  --motion-duration-normal: 220ms;

  /* ==========================================================================
     Layer 2: Semantic Tokens
     ========================================================================== */
  --surface-canvas: var(--palette-gray-950);
  --surface-panel: var(--palette-gray-900);
  --surface-raised: var(--palette-gray-800);

  --text-primary: var(--palette-gray-100);
  --text-secondary: var(--palette-gray-200);
  --text-disabled: var(--palette-gray-400);

  --border-subtle: var(--palette-gray-700);
  --border-strong: var(--palette-gray-600);

  --accent: var(--palette-burgundy-base);
  --accent-hover: var(--palette-burgundy-hover);
  --selection: var(--palette-burgundy-selection);
  --focus-ring: var(--palette-gold-base);

  --success: var(--palette-teal-base);
  --warning: var(--palette-gold-base);
  --danger: var(--palette-crimson-base);

  /* ==========================================================================
     Layer 3: Component & Layout Tokens
     ========================================================================== */
  --appbar-height: 56px;
  --composer-min-height: 48px;
  --composer-max-height: 176px;
  --timeline-reading-measure: 800px;
  --drawer-max-width: 420px;
  --touch-target-min: 44px;

  --radius-xs: 3px;
  --radius-sm: 6px;
  --radius-md: 12px;
}
```

Primary text, secondary text, disabled text, accent, success, warning, and danger text on `--surface-panel` meet WCAG AA 4.5:1 at the specified values; large text/icons meet at least 3:1. A light theme is not implied or exposed until separately designed and tested.

### 6.3 Typography, images, and icons

Use a system sans-serif stack with Chinese fallbacks for all interface text:
```css
font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif;
```
Avoid remote font dependencies. A restrained local serif fallback may be used for a small character title treatment, never for body text or compact controls.

Use a single installed/declared vector icon family (Lucide specification). Do not use Unicode glyphs or emoji as structural navigation, status, send, export, or close icons. Icon-only controls include a localized tooltip (`title`) and accessible name; familiar icon plus text is used for destructive or ambiguous commands. All avatar imagery must have a safe server contract; otherwise render a neutral monogram placeholder.

### 6.4 Components and motion

- **Buttons, input fields, rows, and panels** use stable dimensions, clear hover/pressed/focus/disabled states, and a 4/8 px spacing rhythm. No nested decorative cards. A drawer is a focused overlay, not a card inside a card.
- **Layout constraints**: app bar height 56 px (plus safe area), composer minimum 48 px and maximum 176 px before its textarea scrolls, desktop conversation reading measure 640–800 px, drawer width `min(420px, 100vw)`, and list rows minimum 52 px. Message groups use 12–20 px vertical separation; do not place messages inside a grid of cards.
- **Motion**: Panel open/close (220 ms), status transitions, and message entrance (150 ms) use standard cubic bezier curves. `@media (prefers-reduced-motion: reduce)` removes transform animations. Interaction feedback occurs within 150 ms without shifting surrounding layout.

## 7. Responsive, navigation, and accessibility contract

### 7.1 Responsive behavior

| Viewport | Required layout |
|---|---|
| 1440 and 1024 px | Conversation remains primary; contextual drawer overlays or docks cleanly without cramping the 640–800 px reading measure. |
| 768 px | Conversation remains full-height; contextual panel overlays with backdrop. |
| 375 px | Single conversation screen with compact app bar; drawer opens as a full-height sheet (100vw); composer remains accessible. |
| Phone landscape | Composer, menu controls, and visible timeline remain reachable; no horizontal page scroll. |

Use dynamic viewport sizing and appropriate safe-area insets (`env(safe-area-inset-bottom)`) for fixed app bars and composers. All pointer controls have a 44 by 44 CSS-pixel minimum hit target.

### 7.2 Panel and browser-history behavior

Opening a panel updates URL/state so refresh can restore it. Browser Back and mobile back first close the active panel; they do not silently discard a draft or leave the chat. Panels support Escape and backdrop close where no unsaved form requires confirmation. Opening a panel moves keyboard focus to its title or first meaningful control, traps focus while modal, and restores focus to the invoking control on close.

### 7.3 Semantic and assistive behavior

- Native buttons, forms, labels, selects, checkboxes, and dialog semantics are used whenever available.
- Every icon-only action has localized `aria-label`, tooltip, and visible focus ring. State is not communicated by color alone.
- A polite live region announces connection, generation, completion, and failure once; it does not re-read the whole transcript on refresh.
- Sending maintains useful focus in the composer. View changes move focus to the new panel heading. Error messages identify the failed user action and a next step without implementation jargon.
- Semantic heading levels are sequential; a skip link (`.skip-link`) reaches the conversation before any long navigation list.

## 8. Contract status and release engineering alignment

### 8.1 Post-cutover contract alignment

Under the frozen `tavern_browser_api/v1` architecture (`40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md`):

1. **P3 Exact Snapshot Baseline**:
   - Bootstrap handoff is single-use (`POST /api/tavern/v1/bootstrap`).
   - State reads require the unguessable session cookie (`GET /api/tavern/v1/state`, `GET /api/tavern/v1/draft`).
   - Browser renders only the mounted Chat transcript and draft; additive projection data never mints unauthorized capability surfaces.
2. **P7 Reference Pipeline Delivery** (`design/72`):
   - Submission produces a `202 SubmitMessageResultV1` with committed representation.
   - Bounded `/state` polling tracks turn progress to completion/failure without raw SSE dependencies.
   - Idempotency status reconciliation via `POST /api/tavern/v1/message-submission-status`.
   - Complete recovery across page reload and Host restart without message duplication or fake greeting replay.
3. **Truthful library & panel actions**:
   - Absent controls are omitted rather than displayed as disabled dummies.
   - UI locale isolation (`en` / `zh-CN`) is preserved across all states.

## 9. Implementation acceptance checklist

### Product correctness

- [ ] Every rendered primary action has a matching released route and observable success/failure state; no inert CTA or placeholder operation remains.
- [ ] No-character, no-active-chat, blank-chat, loading, reconnect/offline, send failure, generation failure, and retry states meet section 4.1 and do not expose implementation diagnostics.
- [ ] New Chat renders real durable message 0 or a non-message blank state; `GET /api/tavern/v1/state` and reconnect retain the exact selected chat without replay.
- [ ] Component implementation directly consumes the three-tier tokens in `style.css` and the localized catalog in `i18n.ts`. No raw unstyled `.p3-*` classes or hardcoded strings remain.
- [ ] Player bubble rendering strictly follows durable acceptance (no optimistic pre-rendering).
- [ ] World Info distinguishes available, selected, removed, and locked states without presenting it as a Game fact.
- [ ] Import review shows all safe classifications and never implies execution of unsupported card fields.

### Localization

- [ ] `en` and `zh-CN` catalogs are complete and key parity is tested in CI.
- [ ] Stored preference (`localStorage["gamebuddy.tavern.ui-locale"]`), browser mapping, and English fallback are tested.
- [ ] Switching language preserves active chat, panel/route, selection, and composer draft; it updates `<html lang>` and all accessible names.
- [ ] Authored/imported/transcript text and model/message language are unchanged by a UI locale switch.

### Interaction and accessibility

- [ ] Keyboard tab order, skip link, modal focus trap, Escape/backdrop close, browser Back, live regions, disabled states, and focus restoration are tested.
- [ ] Icon actions use one declared vector family (SVG), localized names/tooltips, stable dimensions, and at least 44 px hit targets.
- [ ] `prefers-reduced-motion` is respected; text and controls meet WCAG AA contrast targets without relying on color alone.
- [ ] Cross-platform Playwright test harness runs reliably on Windows and CI.

### Visual validation

- [ ] Screenshots and interaction checks run at 375, 768, 1024, and 1440 px in both English and Simplified Chinese; phone landscape is included.
- [ ] Long labels, dynamic status, empty states, errors, imported names, and authored text do not overflow, overlap, or alter fixed-control dimensions.
- [ ] The test fixture uses original SFW content and does not retain dialogue, prompt, Pi, Magic Context, provider, or credential data in visual artifacts.

## 10. Explicit non-goals

This specification does not authorize a SillyTavern runtime clone, full SillyTavern file compatibility, a prompt editor, arbitrary card/script execution, external media, a visual-novel theme, or Game controls in Tavern. It changes user-visible design only; all existing Host authority, runtime isolation, content-safety, and Magic Context ownership boundaries remain in force beneath the player-facing vocabulary.
