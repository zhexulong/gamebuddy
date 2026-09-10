# GameBuddy Stardew Valley Companion Live-Run Charter (SFW, Dialogue + Cooperation)

> **Purpose:** Assess the GameBuddy-owned Stardew Valley Humanlike Companion as an embodied, continuing-character dialogue and cooperative play product. This is an audited human-in-the-loop runbook, not an open-ended autonomous game-playing loop or model leaderboard.
>
> **Scope:** The companion operates as an independent Farmhand in an authenticated Stardew Valley multiplayer session. These runs assess embodied micro-actions (`face_direction`, `express_emote`, `equip_tool`), native conversation presentation (`companion_text` bubbles), receipt-attached local observation (`BridgeLocalObservation`), and structured execution logging. They must not claim generic multi-hop autonomous navigation, unverified farming DAG completion, or background memory promotion.

---

## 1. Reference Principles and Non-Goals

1. **Failure-Oriented Assessment:** Assess whether the companion maintains character agency, avoids hallucinated world facts, respects physical game-thread constraints, and faithfully reflects actual player and world state.
2. **Explicit Presentation Boundary:** Only explicit native `companion_text` chat bubbles and native emote bubbles are player-visible in the game. System prompts, model reasoning/thinking, JSON tool calls, and bridge receipts must never appear in game presentation.
3. **Bounded Human-in-the-Loop Scenario:** This charter specifies bounded scenarios with explicit stimuli and expected responses. It explicitly does **not** test unbounded autonomous play, automated crop farming loops, or mine combat.
4. **Player World Independence:** The Player Host process persists independently under its non-kill-on-close Job. Ending the live run session or disconnecting the companion stops AI action authority but does not terminate the player's farm or save file.

---

## 2. Execution Discipline and Operational SOP

For full task-generic operating procedures, environment preflights, and failure taxonomy, see [`fixtures/stardew/RUNBOOK.md`](../fixtures/stardew/RUNBOOK.md) (`## Native humanlike companion live observation and verification SOP`).

1. **Operational Topologies & Commands:**
   - **Mode A (Automated Driver):** `node tools/start-smapi-and-run-live.mjs` (spawns SMAPI, bounds pipe wait to 90s, runs scenario, leaves window open 15s for visual observation, cleans up).
   - **Mode B (Attached Driver):** `node tools/run-stardew-companion-live-coop-01.mjs` (attaches directly to already running game with save loaded).
2. **Session Setup & Concurrency Mutex:**
   - Connect using the official coordinator and local bridge pipe. Verify the AI Farmhand is bound to the target cabin and registered with `BridgeScope.PlayerId`.
   - Mod `ExecutionManager` enforces that the embodied actor executes at most one active native mutation at any time. If multiple tools are invoked in one turn, the Host must serialize them sequentially (waiting for terminal `succeeded` receipt before dispatching the next).
3. **Generic Visual Observability Discipline:**
   - **Delta Observability Principle:** Visual verification is valid only if the post-action physical state visibly contrasts with the actor's immediate pre-action state. When asserting a target state identical to the resting state, introduce contrastive intermediate transitions.
   - **Animation Settling Window:** Actions with sprite animations, emote balloons, or tool wielding require a 2.0–2.5s settling pause before subsequent actions or teardown.
4. **Structured Audit Retention & Git Hygiene:**
   - Live runs generate two local diagnostic files: `tools/stardew-companion-live-run.log.json` and `tools/stardew-companion-live-run-report.md`.
   - **CRITICAL HYGIENE:** These files are ephemeral local audit logs only and **must NEVER be committed to the repository**.
5. **Zero-Tolerance for Presentation Discipline Failures:**
   - If an assistant turn completes without calling `companion_text` or if internal thinking/tool JSON leaks into chat bubbles, the run is marked as `presentation_discipline_failure`.

### 2.1 Specific Operational Caveats (现场核验注意点)

- **Bed Spawn Facing Delta:** The player spawns in bed facing `Down`. Directly dispatching `face_direction: down` produces 0 pixel change; verify against a contrasting cardinal direction first (e.g. `left` towards the room) before asserting facing.
- **Default Active Tool Slot Delta:** Character defaults to `Slot 0`. Dispatching `equip_tool: slot 0` causes no toolbar movement; verify with a contrasting slot (e.g. Slot 1 then Slot 0) to observe selection changes.
- **Emote Animation Busy Mutex:** `Farmer.doEmote` runs for ~2 seconds. Dispatching another emote while `isEmoting` is true results in `rejected/emote_busy`. Allow ≥ 2.5s between emote dispatches.
- **Chat Presentation Readiness:** Ensure the game world has fully faded in and `Game1.chatBox` is instantiated before dispatching dialogue presentation requests.

---

## 3. Baseline Scenario Suite

| ID | Product Concern | Stimulus / Procedure | Pass Condition | Fail Condition |
|---|---|---|---|---|
| `SDW-LIVE-COOP-01` | Morning Greeting & Cooperation Readiness | Player approaches companion on the farm, greets verbally, and asks companion to get ready with a farm tool. | 1. Companion turns to face player (`face_direction`).<br/>2. Emotes positive reaction (`express_emote: happy/yes`).<br/>3. Responds in-character via `companion_text` bubble.<br/>4. Equips requested tool (`equip_tool`).<br/>5. Receipt returns terminal `succeeded` with valid `BridgeLocalObservation`. | Ignored stimulus; wrong facing; leaked JSON; missing tool equip; action rejection without valid reason code. |
| `SDW-LIVE-COOP-02` | Directional Attention & Emotive Reaction | Player moves to a different cardinal side of the companion (up/down/left/right) and speaks. | 1. Companion correctly identifies player's relative direction.<br/>2. Dispatches `face_direction` with correct cardinal value (`0..3`).<br/>3. Sprite facing animation syncs without frame stutter.<br/>4. Natural conversational response delivered. | Facing opposite direction; sprite stutter; `actor_moving` error; silence. |
| `SDW-LIVE-COOP-03` | Clean Disconnect & Reconnect Continuity | Companion is disconnected mid-day, then reconnects with a fresh session instance. | 1. Player Host game world remains completely intact.<br/>2. Reconnect executes observation and companion conversation resync.<br/>3. No old tasks or actions are auto-replayed.<br/>4. Companion resumes ready status (`ready-actions-paused` or `ready`). | Player game crashes or exits; old actions re-execute; chat state corrupts; bridge deadlock. |

---

## 4. Dual-Artifact Log Schemas

### 4.1 Structured JSON (`stardew-companion-live-run.log.json`)

```json
{
  "runId": "opaque-uuid",
  "scenarioId": "SDW-LIVE-COOP-01",
  "timestamp": "2026-09-09T10:30:00.000Z",
  "targetVersion": "1.6.15.24356",
  "smapiVersion": "4.5.2",
  "model": "provider/model-id",
  "events": [
    {
      "step": 1,
      "kind": "player_stimulus",
      "text": "早上好，今天地里杂草不少，拿上工具准备干活啦！"
    },
    {
      "step": 2,
      "kind": "companion_presentation",
      "bubbleText": "早上好！我这就把工具拿出来，今天听你的安排~"
    },
    {
      "step": 3,
      "kind": "action_dispatch",
      "actionId": "face_direction",
      "requestId": "req-001",
      "idempotencyKey": "idem-001",
      "args": { "direction": "down" }
    },
    {
      "step": 4,
      "kind": "execution_receipt",
      "requestId": "req-001",
      "state": "succeeded",
      "evidence": "face_direction:down:completed",
      "observation": {
        "location": "Farm",
        "tile": { "x": 64, "y": 15 },
        "facing": 2,
        "inGameTime": "0630",
        "playerNearby": true,
        "revision": 1
      }
    }
  ],
  "outcome": "pass"
}
```

### 4.2 Review Record (`stardew-companion-live-run-report.md`)

```markdown
# Live-Run Audit Report: SDW-LIVE-COOP-01

- **Run ID**: `<runId>`
- **Scenario**: `SDW-LIVE-COOP-01` (Morning Greeting & Cooperation Readiness)
- **Model**: `<modelProvider>/<modelName>`
- **Result**: `PASS` | `FAIL` | `INCONCLUSIVE`
- **Observations**:
  - Dialogue delivery: natural character persona, 1 bubble rendered.
  - Action execution: `face_direction` (succeeded), `express_emote` (succeeded), `equip_tool` (succeeded).
  - Observation sync: valid observation payload attached to terminal receipts.
  - Zero presentation leakage detected.
```
