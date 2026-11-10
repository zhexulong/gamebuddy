import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type ActionExecutionCoordinator,
  createActionExecutionCoordinator,
} from "./action-execution-coordinator.internal.js";
import type { CompanionInterruption } from "./companion-interruption.js";
import type { ChatRuntimeBindingExecution } from "./continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import { prepareExactChatRuntimeConstruction } from "./continuity-semantic-chat-runtime-construction/continuity-semantic-chat-runtime-construction.internal.js";
import type { ProductionChatRuntimePermit } from "./continuity-semantic-store/continuity-semantic-production-store.js";
import type { GameConnection } from "./game-connection.js";
import {
  assertIntegrationAdapter,
  DEFAULT_INTEGRATION_ACTION_POLICY,
  type GameIntegrationAdapter,
  type IntegrationActionPolicy,
} from "./game-integration-adapter.js";
import { GameplayTaskSubagent } from "./gameplay-task-subagent.js";
import {
  assertProfileMatchesBinding,
  buildChatCompanionSystemPrompt,
  buildGameCompanionSystemPrompt,
  CHAT_SURFACE_SKIP_SIGNATURE,
  createIdentityProfileBinding,
  DEFAULT_IDENTITY_PROFILE,
  type IdentityProfile,
  type IdentityProfileMetadata,
  identityProfileMetadata,
  readIdentityProfileBinding,
  readOrCreateIdentityProfile,
  writeIdentityProfile,
  writeIdentityProfileBinding,
} from "./identity-profile.js";
import { buildCompanionDeskGuidance, COMPANION_DESK_GUIDANCE_FILE_NAME } from "./magic-context-companion-guidance.js";
import { magicContextContentLanguage } from "./magic-context-content-language.js";
import { projectHistorianModel } from "./magic-context-historian-projection.internal.js";
import { protectedToolsForRun } from "./magic-context-protected-tools.js";
import { anchorPiSessionGreeting } from "./pi-session-greeting-anchor.internal.js";
import { alignSessionToTranscriptRows } from "./pi-session-variant-branch.internal.js";
import type { PresentationRuntime } from "./presentation.js";
import {
  MAX_GAME_ENVIRONMENT_FACTS_BYTES,
  renderGameEnvironmentFactsObservation,
  type GameEnvironmentFactsRender,
} from "./game-world-vocabulary.js";
import type { ExecutionReceipt } from "./protocol.js";
import {
  createProviderTurnHeaderScope,
  PROVIDER_TURN_HEADER_EXTENSION_NAME,
  type ProviderTurnHeaderScope,
  providerTurnHeaderExtension,
} from "./provider-turn-header.internal.js";
import { actionRegistryRevision, writeOrVerifyRunManifest } from "./run-manifest.js";
import type { RunTrace } from "./run-trace.js";
import {
  type CompanionIdentity,
  type CompanionModelConfig,
  type CompanionThinkingLevel,
  identityKey,
  type RuntimePaths,
  resolveRuntimePaths,
} from "./runtime-identity.js";
import {
  DEFAULT_COMPANION_LOCALE,
  resolveCompanionLocale,
  resolveGamePromptAddition,
} from "./settings/player-preference-store.js";
import {
  type ExactReceiptRecoveryPort,
  type ReceiptRecoveryOutcome,
  StardewExecutionRecoverySupervisor,
} from "./stardew-execution-recovery-supervisor.js";
import type { TavernAuthoredContextCatalog } from "./tavern/catalog-service.js";
import { mergeModelProviderEntry, modelProviderEntry } from "./tavern/pi-provider-store.js";
import {
  companionPresetPublication,
  formatCompanionPresetLine,
  formatPresetOverlap,
  type GameSessionPreset,
  presetOverlaps,
  readGameSessionPreset,
  renderPresetMainSegment,
} from "./tavern/preset-game-session.js";
import { effectivePresetSampling, type PresetSamplingValues, withPresetSampling } from "./tavern/preset-sampling.js";
import { TAVERN_ENVIRONMENT_PROVIDER_ID } from "./tavern/provider-catalog.js";
import {
  applyToolDescriptionOverrides,
  assertToolSurface,
  type DeclaredToolGroup,
  planToolSurface,
  type ToolSurfacePlan,
} from "./tool-surface.js";
import { createWorldBookTools, type WorldBookBinding } from "./worldbook.js";
export { identityKey, resolveRuntimePaths };
export type { CompanionModelConfig, CompanionThinkingLevel, RuntimePaths };

export const RUNTIME_PACKAGE_VERSIONS = Object.freeze({
  pi: "0.84.4",
  // The artifact identity the Host actually loads: `@cortexkit/pi-magic-context`
  // resolved from `vendor/magic-context/packages/pi-plugin`. Keep this equal to
  // that package's `version`; a run manifest must never record an identity no
  // artifact carries.
  magicContext: "0.48.0-airp.1",
});

/** The selected fork domain; activation gates remain independently fail-closed. */
export const MAGIC_CONTEXT_MEMORY_DOMAIN = "ongoing-interaction" as const;

/**
 * Test-only channel for the fold's window-derived quantities.
 *
 * Magic Context treats these as USER-scope trust keys: a PROJECT file may only RAISE
 * `execute_threshold_tokens`, never lower it. So a harness that wants a real fold inside a CI-sized
 * conversation cannot express it through the project config the Host writes - it needs the
 * user-scope file, which the runtime already owns (`<runtimeCwd>/config/cortexkit/...`).
 *
 * This reads the launcher's request for that, and only for those two internal keys, WITHIN THIS
 * RUNTIME'S OWN ROOT. It is not an operator or browser surface (no Host protocol or management route
 * can select it), and it grants nothing a player could not do by editing that same file in their own
 * runtime root.
 */
type InternalHistorianTestChannel = {
  executeThresholdTokens?: number;
  protectedTokens?: number;
  /**
   * Percent of the model's usable window at which the fold fires. The fold's own trigger is a percentage
   * (65 by default), which is why lowering the token form alone did not make it fire: the token key states a
   * floor, not the trigger. A percentage of 1 makes a real session fold at the scale it actually reaches.
   */
  executeThresholdPercentage?: number;
  /** `off` from the fixture environment: write the protection table with every entry zeroed. */
  protectGameTools?: boolean;
};

function readInternalHistorianTestChannel(): InternalHistorianTestChannel {
  // A fixture-only seam, and it says so on stderr when it is used. Silently honouring an environment
  // variable that changes when a fold happens is how a test-only lever turns into an unexplained behaviour
  // difference in a real run; a value that cannot be parsed is reported rather than dropped.
  const parse = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
      process.stderr.write(`[historian] ignoring ${name}=${JSON.stringify(raw)}: not a positive integer\n`);
      return undefined;
    }
    return value;
  };
  const executeThresholdTokens = parse("GAMEBUDDY_MAGIC_CONTEXT_TEST_EXECUTE_THRESHOLD_TOKENS");
  const protectedTokens = parse("GAMEBUDDY_MAGIC_CONTEXT_TEST_PROTECTED_TOKENS");
  const executeThresholdPercentage = parse("GAMEBUDDY_MAGIC_CONTEXT_TEST_EXECUTE_THRESHOLD_PERCENTAGE");
  // The paired live measurement needs a control arm, and no product surface switches the policy off. Only the
  // exact word `off` is honoured; anything else is reported rather than guessed at.
  const protectToolsRaw = process.env.GAMEBUDDY_MAGIC_CONTEXT_TEST_PROTECTED_TOOLS;
  let protectGameTools: boolean | undefined;
  if (protectToolsRaw !== undefined && protectToolsRaw.trim() !== "") {
    if (protectToolsRaw.trim() === "off") protectGameTools = false;
    else
      process.stderr.write(
        `[historian] ignoring GAMEBUDDY_MAGIC_CONTEXT_TEST_PROTECTED_TOOLS=${JSON.stringify(protectToolsRaw)}: only "off" is recognised\n`,
      );
  }
  if (
    executeThresholdTokens !== undefined ||
    protectedTokens !== undefined ||
    protectGameTools !== undefined ||
    executeThresholdPercentage !== undefined
  )
    process.stderr.write(
      `[historian] fixture fold channel: execute_threshold_tokens=${executeThresholdTokens ?? "(default)"} protected_tokens=${protectedTokens ?? "(default)"} execute_threshold_percentage=${executeThresholdPercentage ?? "(default)"} protected_tools=${protectGameTools === false ? "off" : "(default)"}\n`,
    );
  // Spread conditionally: this project compiles with `exactOptionalPropertyTypes`, so an explicit
  // `undefined` is not the same as an absent key.
  return {
    ...(executeThresholdTokens === undefined ? {} : { executeThresholdTokens }),
    ...(protectedTokens === undefined ? {} : { protectedTokens }),
    ...(executeThresholdPercentage === undefined ? {} : { executeThresholdPercentage }),
    ...(protectGameTools === undefined ? {} : { protectGameTools }),
  };
}

/**
 * Magic Context v0.33.0 auto-search searches raw history by the current Pi
 * session ID, not by GameBuddy's continuity ID. Its only cross-session path is
 * project memory, which deliberately remains outside the approved product
 * scope. Do not enable it as a Chat/Game recall substitute.
 */
export const MAGIC_CONTEXT_RECALL_ENABLED = false;

/**
 * First approved ongoing-interaction gate: native read-only rendering of
 * existing same-opaque-runtime Semantic Memory. This does not grant Host
 * write/read access. Magic Context's native promotion and automatic embedded
 * Historian authoring gates are selected below; auto-search, embedding,
 * Dreamer, and Sidekick stay off.
 */
export const MAGIC_CONTEXT_MEMORY_ENABLED = true;
// Magic Context's own ongoing-interaction Historian can publish eligible
// Semantic facts when it is enabled. The Host never classifies or writes them.
//
// Off as a rollout gate, not by accident - reopening it was an explicit owner
// decision (P7 of the Player-Managed Interaction Memory plan) and that decision
// is still open. Keep it off, but do not expect flipping it to fill the Memory
// notebook: promotion runs only inside a historian fold publish, over an
// *anchored* compartment range, and the fold fires at 65% of the model's usable
// window (measured: a five-turn run sat at 0.38% of a 750,000-token window with
// `times_execute_threshold_reached = 0`). No ordinary conversation reaches it, so
// the notebook's copy names the route that exists - the player asking her to keep
// something - and claims no automatic accumulation.
export const MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED = false;
/**
 * What the provider RENDERED, recorded once per assembled request.
 *
 * The transform asks the registered provider for the block on every request and injects the answer; the
 * session stores MESSAGES, so nothing downstream of a run can say what the model was shown. Measured
 * 2026-11-01 on round18 (24 minutes, 75 assembled plans): the bound session contained `位置:` 0 times,
 * `脚下` 0 times and `待浇水` 0 times, while `formatGameEnvironmentFacts` renders all three correctly when
 * called directly. So two verdict criteria (`tools/live-run/round-verdict.mjs` rows 2 and 5) reported
 * UNOBSERVABLE by construction - the instrument could not see the request, not the product.
 *
 * This file is a RECORD, not a durable document. It lives beside the run manifest under the runtime root,
 * is never written into the session, the transcript or player memory, no product path reads it, and it is
 * non-durable by design - exactly like the block it describes. A reader asks it: was the block rendered
 * on every request or did it vanish; what did the unwatered count say, and did it ever go non-zero; did
 * same-map villagers arrive with tiles; did the line ever reach the byte cap and what did the cap drop.
 */
export const ENVIRONMENT_FACTS_RECORD_FILENAME = "environment-facts.jsonl";
export const ENVIRONMENT_FACTS_RECORD_SCHEMA = "gamebuddy_environment_facts_render/v1";
/**
 * The record's bound, sized from the measured turn count rather than guessed.
 *
 * The largest session measured in this loop is 285 turns (`round-verdict.mjs`'s own fold note) and
 * round18 assembled 75 requests in 24 minutes. A recorded line measured 309 B for a busy farm (clock,
 * date, weather, location, tile, held tool, two nearby villagers, two destinations, 24 unwatered crops
 * and stamina), so 285 turns cost ~88 KB. 1200 records is 4.2x the largest measured run and cannot
 * exceed ~740 KB even if every line used the formatter's whole 512 B fact budget. The byte cap is the
 * second net, because the record must stay bounded for a caller that registers its own provider.
 *
 * After either cap the file receives ONE truncation line and then nothing, so a runaway session cannot
 * fill a disk and a reader can see that the tail was cut rather than believe the run ended there.
 */
export const MAX_ENVIRONMENT_FACTS_RECORD_LINES = 1200;
export const MAX_ENVIRONMENT_FACTS_RECORD_BYTES = 1024 * 1024;

/** One line of the record: what was rendered, for which snapshot, and what the cap cost it. */
export type EnvironmentFactsRenderRecord = Readonly<{
  schema: string;
  /** When the transform asked, ISO-8601 - ordering one render against a game event needs a clock. */
  at: string;
  /** The snapshot revision the line was rendered from; `null` when no snapshot was usable. */
  revision: number | null;
  bytes: number;
  /** Whether the rendered line still exceeded `MAX_GAME_ENVIRONMENT_FACTS_BYTES` after the cap ran. */
  overCap: boolean;
  /** Present only when the cap dropped something. */
  dropped?: readonly string[];
  /** The exact string the provider returned - `""` when the block rendered empty (and was stripped). */
  text: string;
}>;

/**
 * Where this run's renders are recorded: beside the run manifest, inside the runtime root.
 *
 * The manifest is per surface session (`resolveRuntimePaths` puts it under `surface-sessions/<id>/` when
 * there is one), so a record written here belongs to one run rather than to every run that shares the
 * continuity - and it is nowhere near `<sessionDir>`, the transcript or the memory store.
 */
export function environmentFactsRecordPath(paths: RuntimePaths): string {
  return join(dirname(paths.runManifestPath), ENVIRONMENT_FACTS_RECORD_FILENAME);
}

/**
 * The provider Magic Context mounts: render the CURRENT snapshot, then record what was rendered.
 *
 * ORDER MATTERS. The render happens first and outside every `try`, so a formatter that throws throws
 * exactly as it did before this record existed - the request path's behaviour is unchanged. Only the
 * RECORD is best-effort: a diagnostic that cannot be written must never become a failed turn, so a write
 * failure disables further writes (one bad path costs one syscall, not one per turn) and the absent file
 * is the report.
 *
 * SYNCHRONOUS, MEASURED, NOT BUFFERED. `appendFileSync` of a 309 B line on this platform (Windows,
 * Node 24) costs 0.15-0.19 ms per call over 500 calls; round18's turn cadence was 24 minutes for 75
 * assembled requests (~19 s per turn, and the provider runs once per request), so the record costs
 * ~0.001% of a turn. Buffering would buy nothing measurable and would lose precisely the interesting
 * turns - the ones immediately before a killed run - which is the failure this record exists for. An
 * `O_APPEND` handle would be cheaper (0.0035 ms) but needs a close hook this provider has none of, and a
 * leaked descriptor per runtime is a worse trade than 0.15 ms.
 */
export function createRenderedEnvironmentFactsProvider(integration: GameConnection, recordPath: string): () => string {
  const connection = integration as import("./game-connection.js").StardewBridgeConnection;
  let lines = 0;
  let bytes = 0;
  let directoryReady = false;
  let writable = true;
  let sealed = false;

  const append = (line: string): void => {
    const size = Buffer.byteLength(line, "utf8");
    try {
      if (!directoryReady) {
        mkdirSync(dirname(recordPath), { recursive: true });
        directoryReady = true;
      }
      appendFileSync(recordPath, line, "utf8");
    } catch {
      writable = false;
      return;
    }
    lines += 1;
    bytes += size;
  };

  const record = (rendered: GameEnvironmentFactsRender, revision: number | null): void => {
    if (!writable || sealed) return;
    const at = new Date().toISOString();
    const line = `${JSON.stringify({
      schema: ENVIRONMENT_FACTS_RECORD_SCHEMA,
      at,
      revision,
      bytes: rendered.bytes,
      overCap: rendered.bytes > MAX_GAME_ENVIRONMENT_FACTS_BYTES,
      ...(rendered.dropped.length === 0 ? {} : { dropped: rendered.dropped }),
      text: rendered.text,
    })}\n`;
    const size = Buffer.byteLength(line, "utf8");
    if (lines >= MAX_ENVIRONMENT_FACTS_RECORD_LINES || bytes + size > MAX_ENVIRONMENT_FACTS_RECORD_BYTES) {
      sealed = true;
      append(
        `${JSON.stringify({
          schema: ENVIRONMENT_FACTS_RECORD_SCHEMA,
          at,
          truncated: true,
          lines,
          bytes,
          reason: "environment_facts_record_cap_reached",
        })}\n`,
      );
      return;
    }
    append(line);
  };

  return (): string => {
    const snapshot = connection.state?.snapshot;
    if (snapshot === null || snapshot === undefined) {
      // Recorded, not skipped: "the block rendered empty" and "the block was never asked for" are
      // different facts, and only the record can tell a vanished block from a run with no snapshot.
      record({ text: "", bytes: 0, dropped: Object.freeze([]) }, null);
      return "";
    }
    const locale = snapshot.presentationLocale?.toLowerCase() ?? "";
    const rendered = renderGameEnvironmentFactsObservation(snapshot, locale.startsWith("zh"));
    record(rendered, Number.isSafeInteger(snapshot.revision) ? snapshot.revision : null);
    return rendered.text;
  };
}
/**
 * Magic Context's native trigger may now run the embedded-SDK, no-tool
 * Historian when its own context-pressure policy requires organization.
 */
export const MAGIC_CONTEXT_HISTORIAN_ENABLED = true;

// Magic Context currently discovers its config and SQLite root through Node
// process globals. Serialize only that extension bootstrap critical section so
// simultaneous Chat/Game runtimes cannot inherit one another's cwd/data root.
let magicContextReloadTail: Promise<void> = Promise.resolve();

export async function reloadMagicContextInRuntimeRoot(
  loader: DefaultResourceLoader,
  runtimeCwd: string,
): Promise<void> {
  const previous = magicContextReloadTail;
  let release: () => void = () => undefined;
  magicContextReloadTail = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  await previous;
  try {
    const previousCwd = process.cwd();
    const previousDataDir = process.env.XDG_DATA_HOME;
    const previousConfigDir = process.env.XDG_CONFIG_HOME;
    const previousStorageDir = process.env.MAGIC_CONTEXT_STORAGE_DIR;
    try {
      process.env.XDG_DATA_HOME = join(runtimeCwd, "data");
      // The extension resolves its USER-scope config through XDG_CONFIG_HOME and falls back to
      // `~/.config` (and to a user Pi installation) without it - so an unset variable means this
      // runtime would read a file from the player's home. Point it at the runtime's own config,
      // alongside the data root, so the runtime touches nothing outside its root.
      process.env.XDG_CONFIG_HOME = join(runtimeCwd, "config");
      // Magic Context's own documentation gives MAGIC_CONTEXT_STORAGE_DIR precedence over the
      // XDG-derived root, so an inherited value decides this runtime's SQLite root *instead of*
      // the root above: the extension then opens a store this runtime does not own. Measured on a
      // live composed turn, that is not merely a misplacement - a store whose migration lane is
      // ahead of this build's schema fence leaves the extension fail-closed, and its guarded
      // context hook aborts the operation (`ctx.abort()`), so the provider request dies in-process
      // with `AbortError: This operation was aborted` and the turn terminalizes `failed` with
      // `runtime_unavailable`. Pin the same runtime-owned root the XDG path derives, so the store
      // is the runtime's whatever the surrounding process carries.
      process.env.MAGIC_CONTEXT_STORAGE_DIR = join(runtimeCwd, "data", "cortexkit", "magic-context");
      process.chdir(runtimeCwd);
      await loader.reload();
    } finally {
      process.chdir(previousCwd);
      if (previousDataDir === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataDir;
      if (previousConfigDir === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigDir;
      if (previousStorageDir === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
      else process.env.MAGIC_CONTEXT_STORAGE_DIR = previousStorageDir;
    }
  } finally {
    release();
  }
}

/**
 * The base Companion tool is read-only and never creates game authority. Its
 * status is sourced from the mounted integration when one exists.
 */
export function createCompanionStatusTool(integration?: GameConnection) {
  return defineTool({
    name: "companion_status",
    label: "Companion Status",
    description: "Report the local Companion Host and mounted game integration status.",
    parameters: Type.Object({}),
    execute: async () => {
      const details = integration === undefined ? undefined : integration.module.status(integration);
      const fullDetails = {
        host: "ready",
        integrationId: integration?.scope.integrationId ?? null,
        connected: details?.connected ?? false,
        capabilities: details === undefined ? [] : [...details.capabilities],
        snapshotRevision: details?.snapshotRevision ?? null,
        latestReceiptState: details?.latestReceiptState ?? null,
        latestReasonCode: details?.latestReasonCode ?? null,
      } as const;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(fullDetails) }],
        details: fullDetails,
      };
    },
  });
}

/** Backward-compatible offline base tool for callers that do not mount an integration. */
export const companionStatusTool = createCompanionStatusTool();

/**
 * A Host-owned companion identity. `continuityId` is the logical shared
 * experience key; legacy game-only callers may omit it and remain partitioned
 * by their exact save/world pair. A dialogue surface has no live world.
 */
export type { CompanionIdentity } from "./runtime-identity.js";

export type GameCompanionIdentity = CompanionIdentity &
  Readonly<{
    saveId: string;
    worldId: string;
  }>;

/**
 * The player-facing Dialogue Director's zero-configuration model: the
 * environment-provided connection. It stays the runtime's model
 * whenever no player connection is active, which keeps a root without player
 * connections byte-for-byte on the previous behaviour and provider store shape.
 */
export const DEFAULT_COMPANION_MODEL_CONFIG: CompanionModelConfig = Object.freeze({
  provider: TAVERN_ENVIRONMENT_PROVIDER_ID,
  modelId: "deepseek-v4.1-flash",
  thinkingLevel: "high",
});

/**
 * The one boundary where a player-typed thinking level meets the embedded
 * runtime's own vocabulary. The value is deliberately NOT clamped or rewritten
 * here: the runtime resolves it against the selected model and falls back to a
 * level that model advertises (pi-ai `clampThinkingLevel`).
 */
function piThinkingLevel(value: string): NonNullable<CreateAgentSessionOptions["thinkingLevel"]> {
  return value as NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
}

/**
 * Internal-only test seam for bounded Magic Context gates. It is deliberately
 * absent from every operator config/CLI/browser protocol; Host production uses
 * the fail-closed constants above.
 */
type MagicContextFeatureTestOverride = Readonly<{
  /** Preview-only composition may disable the extension itself, not merely its features. */
  loadExtension?: boolean;
  memoryEnabled?: boolean;
  historianEnabled?: boolean;
  /** Test-only trigger compression; never comes from operator/browser config. */
  historianExecuteThresholdTokens?: number;
  historianExecuteThresholdPercentage?: number;
  /**
   * Test-only protection compression, same seam and same reason. Magic Context also keeps a recent
   * tail out of the fold (`protected_tokens`), and that tail is a fraction of the model's range too -
   * on the product's million-token window it is tens of thousands of tokens. A fixture that compresses
   * only the trigger therefore still folds nothing, because the conversation cannot outgrow the
   * protection. CI's fold fixture needs both, and neither knob has an operator or browser surface.
   */
  historianProtectedTokens?: number;
}>;

/** Private composition constant; Preview JSON and every external Host protocol are unable to select it. */
const PREVIEW_MAGIC_CONTEXT_DISABLED: MagicContextFeatureTestOverride = Object.freeze({
  loadExtension: false,
  memoryEnabled: false,
  historianEnabled: false,
});

export type RuntimeSession = Readonly<{
  session: AgentSession;
  /** Opaque Pi session identity, minted by the SessionManager. */
  piSessionId: string;
  sessionManager: SessionManager;
  paths: RuntimePaths;
  identityKey: string;
  identityProfile: IdentityProfileMetadata;
  profile: IdentityProfile;
  extensions: readonly string[];
  /**
   * The mounting decision this session was constructed from: the allowlist it handed Pi, and the capability class
   * behind each name. It is the surface's own record of why each tool may be here, so a reader never has to
   * reconstruct the classification from tool names.
   */
  toolSurface: ToolSurfacePlan;
  /**
   * The turn whose provider request is in flight on this exact session.
   *
   * It is held here rather than sent with the prompt because Pi's `PromptOptions` carries no headers and
   * `models.json` headers are fixed per provider entry: an inline extension reads this holder when Pi fires
   * `before_provider_headers`, so the value travels with the session that sends the request.
   */
  providerTurnHeader: ProviderTurnHeaderScope;
  /** Host-owned surface port; Pi never receives this authority directly. */
  presentation?: PresentationRuntime;
  gameplaySubagent?: GameplayTaskSubagent;
  /** Runtime-local STOP authority; never durable or adapter-owned. */
  interruption?: CompanionInterruption;
  /** This run's span recorder; absent on surfaces that trace nothing. */
  runTrace?: RunTrace;
  /** Requests exact ledger cancellation for a synchronously sealed old epoch. */
  cancelIntegrationEpoch?: (epoch: number, reasonCode: string) => Promise<void>;
  /** Closes runtime action admission and awaits cancellation of every owned request. */
  interruptIntegrationExecutions?: (reasonCode: string) => Promise<void>;
  /** Binds a validated integration receipt to a pre-write correlation, including late receipts after write rejection. */
  bindIntegrationReceipt?: (receipt: ExecutionReceipt) => void;
  /**
   * Explicit relaunch-only recovery: queries a fresh authenticated read-only
   * port and admits receipts into the private coordinator. This is never
   * invoked by a disconnect and never reissues an action request.
   */
  recoverStardewExecutionReceipts?: (port: ExactReceiptRecoveryPort) => Promise<readonly ReceiptRecoveryOutcome[]>;
  /** Removes the one-shot Tavern provider marker binding before Pi disposal. */
  clearTavernNarrativeGateMarker?: () => void;
  /**
   * Emits a bounded parent-IPC runtime identity only for the process-owned
   * Tavern narrative gate. The session ID remains unavailable to all ordinary
   * browser/Host consumers.
   */
  reportTavernNarrativeGateRuntime?: () => void;
  /**
   * Installs a source-owned one-shot provider-start observer on this exact
   * session through the loaded Magic Context extension entry. Returns the
   * explicit unregister; the caller owns one-shot lifecycle and retains no
   * payload, header, or prompt bytes.
   */
  installTavernProviderStartObserver?: (
    onStart: (
      observation: Readonly<{
        sessionId: string;
        statusClass: "success" | "error";
      }>,
    ) => void,
  ) => () => void;
  /** Removes the source-owned generic operational marker before Pi disposal. */
  clearGameOperationalGateMarker?: () => void;
}>;

/** Stable, non-display-name partition for one logical Companion continuity. */
export function assertFrozenFixedTools(tools: readonly ToolDefinition[]): void {
  if (!(Object.isFrozen(tools) && tools.every((tool) => Object.isFrozen(tool))))
    throw new Error("fixed_runtime_tools_must_be_frozen");
  const names = tools.map((tool) => tool.name);
  if (names.some((name) => typeof name !== "string" || name.length === 0) || new Set(names).size !== names.length)
    throw new Error("fixed_runtime_tool_name_collision");
}

/**
 * One private action-agnostic coordinator backs every action surface: typed
 * Route A tool closures, Route B gameplay subagent dispatches, and Host STOP
 * epoch cancellation. It owns admission minting, request/execution correlation,
 * the deterministic receipt-order audit, exact-once cancel, and wake
 * normalization; it never routes an action and never interprets postconditions.
 */
function createRuntimeDispatchController(
  connection: GameConnection,
  options: import("./action-execution-coordinator.internal.js").ActionExecutionCoordinatorOptions = {},
): ActionExecutionCoordinator {
  return createActionExecutionCoordinator(connection, options);
}

function gateIntegrationTool(tool: ToolDefinition, connection: GameConnection): ToolDefinition {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Only action tools are executable operations. Their tool surface is
      // mounted only with a live launcher gate, then rechecked at invocation.
      if (connection.module.actionIdForToolName(tool.name) !== null && connection.executionGate?.executable !== true)
        throw new Error("integration_not_ready");
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/**
 * One span per mounted tool call, attributed by the owner that made the Agent wait. `toolTiming` used to derive the
 * same three owners from the Pi session record; a span carries the category directly.
 */
function tracedTool(tool: ToolDefinition, trace: RunTrace, category: string | undefined): ToolDefinition {
  const attributes = category === undefined ? { tool: tool.name } : { tool: tool.name, category };
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) =>
      await trace.span(tool.name, attributes, () => tool.execute(toolCallId, params, signal, onUpdate, ctx)),
  };
}

/** Game-only marker configuration. It cannot describe or authorize a Chat runtime. */
export type GameOperationalGateConfig = Readonly<{
  nonceSha256: string;
}>;

/** Construction-zone-only Game binding. It is consumed before Pi mounts tools. */
export type GameHostBindingFactory = (
  handle: Readonly<{ interruption: CompanionInterruption }>,
) => PresentationRuntime | undefined;

/** Construction-owned attachment for a bounded Game runtime surface. */
export type ChatRuntimeConstructionProduct = Readonly<{
  runtime: RuntimeSession;
  /**
   * The selection this mount configured Pi with, or `null` when the player has activated no
   * connection. It is the one fact the mounted lease cannot read back off the session itself: Pi
   * answers a model-less session with its own `unknown` placeholder, and reporting that as the
   * player's model would be the same lie in the opposite direction.
   *
   * It is read once per answer rather than captured, because activating a connection replaces it
   * on this same mount.
   */
  appliedModelConfig: () => CompanionModelConfig | null;
  authoredContextCapability: import("@cortexkit/pi-magic-context/tavern").TavernAuthoredContextRuntimeCapability;
  refreshAuthoredContext: (
    currentCapability: import("@cortexkit/pi-magic-context/tavern").TavernAuthoredContextRuntimeCapability,
  ) => Promise<import("@cortexkit/pi-magic-context/tavern").TavernAuthoredContextRuntimeCapability>;
  /** Releases the construction's own store; consumed by the materializer's reverse disposal. */
  closeChatThreadStore: () => void;
  /**
   * Applies the player's current connection selection to this live session in
   * place, resolved through the same construction function a mount uses. It
   * leaves the conversation untouched: only the provider/model the next prompt
   * runs with changes. `null` means the player has no selection yet, so there is
   * nothing to apply; the session keeps whatever it mounted with.
   */
  reloadModelSelection: () => Promise<CompanionModelConfig | null>;
  clearTavernNarrativeGateMarker?: () => void;
}>;

/** Construction-private Chat handoff; publication is owned by this internal layer. */
export async function createChatRuntimeConstructionInternal(
  execution: ChatRuntimeBindingExecution,
  permit: ProductionChatRuntimePermit,
  options: Readonly<{ tavernNarrativeGateNonceSha256?: string }> = {},
): Promise<ChatRuntimeConstructionProduct> {
  const construction = await prepareExactChatRuntimeConstruction(execution, permit, options);
  // A Chat with no activated connection mounts with no model configured in Pi: passing nothing skips
  // the provider entry and the model selection instead of asking the runtime to build one for a model
  // that does not exist. The Pi session itself is still constructed, which is what keeps acquiring a
  // model later a reload of this mount rather than a remount of it.
  const runtime = await createCompanionRuntime(
    construction.identity,
    construction.runtimeRoot,
    undefined,
    construction.modelConfig ?? undefined,
    undefined,
    construction.presentation,
    false,
    undefined,
    construction.surfaceSessionId,
    undefined,
    "chat",
    undefined,
    construction.tavernNarrativeGateNonceSha256,
  );
  let appliedModelConfig = construction.modelConfig;
  /**
   * The mounted runtime's own model reload. It reads the selection the player has
   * now, not the one the mount froze, and applies it to the live session; a
   * selection identical to the applied one is left alone so an idle Chat reads
   * two small files per turn instead of rewriting Pi's provider entry.
   *
   * A mount that opened with no model reaches this with a selection for the first
   * time when the player activates a connection, and it takes the same path a
   * changed selection always took: the same live Pi session adopts the new
   * provider/model, so the conversation the player is reading is the one that
   * starts answering.
   */
  const reloadModelSelection = async (): Promise<CompanionModelConfig | null> => {
    const { modelConfig } = await construction.resolveModelSelection();
    if (modelConfig === null || sameModelConfig(appliedModelConfig, modelConfig)) return modelConfig;
    await applyCompanionModelSelection(runtime.session, construction, modelConfig);
    appliedModelConfig = modelConfig;
    // The historian's model lives in Magic Context's config files, not in the session, so pointing the session at the new
    // model is only half the fact: without this the historian folds on the model the player just left.
    await projectHistorianModelForConstruction(construction, modelConfig);
    return modelConfig;
  };
  try {
    const piSessionId = runtime.sessionManager.getSessionId();
    if (typeof piSessionId !== "string" || piSessionId.length === 0) throw new Error("pi_session_binding_unavailable");
    const catalog: TavernAuthoredContextCatalog = await construction.materializeStableContextForPiSession(piSessionId);
    const { publishGameBuddyAuthoredStableCatalog, replaceGameBuddyAuthoredStableCatalog } = await import(
      "@cortexkit/pi-magic-context/tavern"
    );
    const authoredContextCapability = publishGameBuddyAuthoredStableCatalog(catalog.scope, catalog);
    const refreshAuthoredContext = async (
      currentCapability: import("@cortexkit/pi-magic-context/tavern").TavernAuthoredContextRuntimeCapability,
    ) => {
      const freshCatalog = await construction.materializeDesiredStableContextForPiSession(piSessionId);
      return replaceGameBuddyAuthoredStableCatalog(currentCapability, freshCatalog.scope, freshCatalog);
    };
    // The greeting the Chat opened on becomes the conversation's own first assistant message, before
    // any prompt exists, so the model knows what it just said to the player: the player's first reply
    // has no referent otherwise, and as a system-prompt fact the model reads the greeting as setting,
    // echoes it and confuses persons. It is a read-only history anchor (Order 0) - written once, while
    // the session carries no line of the conversation, never rewritten, and never attributable to a
    // turn: an attempt owns exactly the entries that existed before its prompt, and the ledger has no
    // row for this one. `pi-session-greeting-anchor.internal.ts` owns that guard and its proof.
    //
    // Two orderings are deliberate. It is written last in the construction, so a mount that fails
    // before this leaves no session file behind. And its own failure does not fail the mount: the
    // anchor is context, not authority, and the conversation the player already has must still open
    // (the same rule the durable entry binding follows in `recordSettledPromptEntries`).
    if (construction.openingGreeting !== null) {
      try {
        const anchor = anchorPiSessionGreeting(runtime.session, construction.openingGreeting);
        if (anchor.status === "withheld" && anchor.reason === "greeting_superseded")
          process.stderr.write(
            "[greeting] the session's own first line carries words the transcript's opening row no longer holds\n",
          );
      } catch (error) {
        process.stderr.write(
          `[greeting] the session anchor was not written: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    // The store is the authority for which rows exist; the session is the authority for what the model carries. A mount is
    // the one moment both are known and neither is in flight, so the disagreement is settled here: whatever the session
    // still carries past the store's last row was removed while nothing was mounted - an offline delete or rewind - and
    // the same append-only cut a mounted rewind uses pins it durably.
    const alignment = alignSessionToTranscriptRows(runtime.session, construction.transcriptRows);
    if (alignment.status === "refused")
      process.stderr.write(
        `[mount] the session carries rows the transcript no longer has, and the cut was refused: ${alignment.reason}\n`,
      );
    else if (alignment.dropped > 0)
      process.stderr.write(`[mount] aligned the session to the transcript: dropped ${alignment.dropped} row(s)\n`);
    return Object.freeze({
      runtime,
      appliedModelConfig: () => appliedModelConfig,
      authoredContextCapability,
      refreshAuthoredContext,
      closeChatThreadStore: construction.closeChatThreadStore,
      reloadModelSelection,
      ...(runtime.clearTavernNarrativeGateMarker === undefined
        ? {}
        : { clearTavernNarrativeGateMarker: runtime.clearTavernNarrativeGateMarker }),
    });
  } catch (error) {
    // The construction's store must not outlive a failed runtime mount; the
    // materializer only reverse-disposes a product it actually received.
    try {
      construction.closeChatThreadStore();
    } finally {
      try {
        runtime.clearTavernNarrativeGateMarker?.();
      } finally {
        runtime.session.dispose();
      }
    }
    throw error;
  }
}

export type GameCompanionRuntimeAttachment = Readonly<{
  /** Production-only durable Stardew recovery composition, supplied by the materializer. */
  recoveryJournal?: import("./stardew-logical-action-recovery-journal.js").StardewLogicalActionRecoveryJournal;
  recoveryBinding?: Readonly<{
    scope: Readonly<Record<string, unknown>>;
    bindingIdentity: Readonly<Record<string, unknown>>;
  }>;
  recoveryPort?: ExactReceiptRecoveryPort;
  modelConfig?: CompanionModelConfig;
  gameplaySubagentEnabled: boolean;
  hostBindingFactory: GameHostBindingFactory;
  /** Formal Preview-only composition mode; it has no JSON/operator/CLI representation. */
  disableMagicContextMemory?: true;
}>;

/**
 * Generic Companion runtime construction. This Chat-callable path intentionally
 * has no Game Operational Gate marker parameter.
 */
export async function createCompanionRuntime(
  identity: CompanionIdentity,
  root?: string,
  integration?: GameConnection,
  modelConfig?: CompanionModelConfig,
  actionPolicy?: IntegrationActionPolicy,
  presentation?: PresentationRuntime,
  gameplaySubagentEnabled = false,
  initialProfile?: IdentityProfile,
  surfaceSessionId?: string,
  worldBook?: WorldBookBinding,
  surface?: "chat" | "game",
  internalMagicContextFeatureTestOverride?: MagicContextFeatureTestOverride,

  tavernNarrativeGateNonceSha256?: string,
): Promise<RuntimeSession> {
  return await createRuntimeWithFixedToolsCore(
    identity,
    root,
    integration,
    modelConfig,
    actionPolicy,
    presentation,
    gameplaySubagentEnabled,
    initialProfile,
    surfaceSessionId,
    worldBook,
    surface,
    internalMagicContextFeatureTestOverride,

    tavernNarrativeGateNonceSha256,
    undefined,
    undefined,
    {},
    Object.freeze([]),
  );
}

/**
 * The sole marker-capable runtime construction path. It fixes the surface to
 * Game both in its TypeScript API and in the private runtime configuration.
 */
export async function createGameCompanionRuntime(
  identity: GameCompanionIdentity,
  root: string,
  integration: GameConnection,
  gameSessionId: string,
  gameOperationalGate: GameOperationalGateConfig | undefined,
  gameHostBindingFactory?: GameHostBindingFactory,
  attachment?: GameCompanionRuntimeAttachment,
): Promise<RuntimeSession> {
  if (attachment !== undefined && gameHostBindingFactory !== undefined)
    throw new Error("duplicate_game_host_binding_factory");
  return await createRuntimeWithFixedToolsCore(
    identity,
    root,
    integration,
    attachment?.modelConfig,
    undefined,
    undefined,
    attachment?.gameplaySubagentEnabled ?? false,
    undefined,
    gameSessionId,
    undefined,
    "game",
    attachment?.disableMagicContextMemory === true ? PREVIEW_MAGIC_CONTEXT_DISABLED : undefined,
    undefined,
    gameOperationalGate,
    attachment?.hostBindingFactory ?? gameHostBindingFactory,
    attachment?.recoveryJournal === undefined
      ? {}
      : Object.freeze({
          recoveryJournal: attachment.recoveryJournal,
          ...(attachment.recoveryBinding === undefined ? {} : { recoveryBinding: attachment.recoveryBinding }),
        }),
    Object.freeze([]),
  );
}

/**
 * Refuse a surface whose prompt disagrees with the shared Magic Context config's skip signature.
 *
 * <p>
 * One runtime directory serves both surfaces of a continuity, so the guidance block is switched off per
 * surface by a substring of the Chat prompt (`system_prompt_injection.skip_signatures`). A substring decision
 * has two failure directions and both are silent at the point they matter, so both are refused here, where the
 * prompt is built:
 * </p>
 *
 * <ul>
 *   <li>A Chat prompt that no longer carries the sentence: an edit to the Chat floor would quietly un-skip the
 *       surface and she would be told about five tools she does not have.</li>
 *   <li>A Game prompt that carries it: the player's own instructions are free text appended to the Game prompt,
 *       so a player who pastes that sentence would switch off the archive protocol for their own companion -
 *       deleting, in one paste, the thing this change exists to turn on.</li>
 * </ul>
 */
function assertMagicContextSurfaceSignature(surface: "chat" | "game", systemPrompt: string): void {
  const carries = systemPrompt.includes(CHAT_SURFACE_SKIP_SIGNATURE);
  if (surface === "chat" && !carries) throw new Error("chat_prompt_missing_magic_context_skip_signature");
  if (surface === "game" && carries) throw new Error("game_prompt_carries_magic_context_skip_signature");
}

/**
 * The Game system prompt with the generation preset's `main` entry appended, and the overlap report the pair earns.
 *
 * Two properties this function exists to keep:
 *
 *  - a runtime cwd with no preset (every player root, and Chat) gets the prompt BYTE FOR BYTE. The preset is mounted by
 *    provisioning; a root that has none is not a degraded root and must not be assembled differently.
 *  - an overlap with the floor is REPORTED and both texts are kept. Dropping either would be this function deciding
 *    which sentence wins, and the ruling is "apply the preset", not "apply it where convenient".
 */
function withPresetMain(floor: string, preset: GameSessionPreset | null): string {
  if (preset === null) return floor;
  for (const overlap of presetOverlaps({ preset, floor })) process.stderr.write(`${formatPresetOverlap(overlap)}\n`);
  const segment = renderPresetMainSegment(preset.main);
  return segment.length === 0 ? floor : `${floor}\n${segment}`;
}

/**
 * The sampler values this runtime will really send, or `null` when there is no composed model to read them from.
 *
 * `effectivePresetSampling` is the ONE reading of the adapter's precedence and it fails closed when a value this
 * module wrote is not what the composed model carries, so `null` here can only mean "no composed model" - never "some
 * keys were quietly dropped".
 */
function effectivePresetSamplingValues(
  preset: GameSessionPreset | null,
  model: ReturnType<ModelRuntime["getModel"]> | undefined,
  session: RuntimeSessionResource,
): Readonly<Record<string, number>> | null {
  if (preset === null || model === undefined) return null;
  const level = session.agent.state.thinkingLevel;
  const readings = effectivePresetSampling({
    model,
    thinkingLevel: typeof level === "string" ? level : "off",
    preset: preset.sampling,
  });
  const values: Record<string, number> = {};
  for (const reading of readings) if (typeof reading.value === "number") values[reading.key] = reading.value;
  return Object.freeze(values);
}

/**
 * Create a Pi SDK session without coding-agent discovery. Only the installed,
 * pinned Magic Context extension can load; built-ins, project/user extensions,
 * skills, templates, context files, and coding prompts are excluded.
 */
export async function createRuntimeWithFixedToolsCore(
  identity: CompanionIdentity,
  root?: string,
  integration?: GameConnection,
  modelConfig?: CompanionModelConfig,
  actionPolicy?: IntegrationActionPolicy,
  presentation?: PresentationRuntime,
  gameplaySubagentEnabled = false,
  initialProfile?: IdentityProfile,
  surfaceSessionId?: string,
  worldBook?: WorldBookBinding,
  surface?: "chat" | "game",
  internalMagicContextFeatureTestOverride?: MagicContextFeatureTestOverride,

  tavernNarrativeGateNonceSha256?: string,
  gameOperationalGate?: GameOperationalGateConfig,
  gameHostBindingFactory?: GameHostBindingFactory,
  actionExecutionOptions: import("./action-execution-coordinator.internal.js").ActionExecutionCoordinatorOptions = {},
  fixedTools: readonly ToolDefinition[] = Object.freeze([]),
  /** Construction-private resolved policy supplied only by the fixed-tool composer. */
  resolvedPolicy?: IntegrationActionPolicy,
  /**
   * Declared by the composition that mounts this surface's action vocabulary. The composed Game surface carries the
   * plan builder (`stardew_plan_work`), which exposes the same published action vocabulary the adapter's per-action
   * tools do, so it is the only action surface on that runtime.
   */
  planActionSurface = false,
): Promise<RuntimeSession> {
  // A surface session ID identifies a persistent session; it must never be
  // used to infer the product surface because both Chat and Game have them.
  const runtimeSurface = surface ?? presentation?.surface ?? "game";
  if (tavernNarrativeGateNonceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(tavernNarrativeGateNonceSha256)) {
    throw new Error("invalid_tavern_marker_config");
  }
  if (gameOperationalGate !== undefined && runtimeSurface !== "game") {
    throw new Error("game_operational_marker_requires_game_surface");
  }
  if (gameOperationalGate !== undefined && !/^[a-f0-9]{64}$/.test(gameOperationalGate.nonceSha256)) {
    throw new Error("invalid_game_operational_marker_config");
  }
  const loadMagicContextExtension = internalMagicContextFeatureTestOverride?.loadExtension !== false;
  if (!loadMagicContextExtension && gameOperationalGate !== undefined) {
    throw new Error("game_operational_marker_requires_magic_context");
  }
  const integrationModule: GameIntegrationAdapter | undefined = integration?.module;
  if (integration !== undefined && integrationModule === undefined) throw new Error("integration_module_required");
  if (integration !== undefined) {
    assertIntegrationAdapter(integration.module, integration.scope.integrationId);
    const actorId = integration.module.actorId(integration);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(actorId)) throw new Error("integration_actor_required");
    integration.module.assertIdentityBinding(integration, identity);
  }
  const mountedPolicy =
    resolvedPolicy ??
    (actionPolicy === undefined
      ? (integrationModule?.defaultPolicy ?? DEFAULT_INTEGRATION_ACTION_POLICY)
      : integrationModule === undefined
        ? actionPolicy
        : integrationModule.parsePolicy(actionPolicy));
  const paths = resolveRuntimePaths(identity, root, surfaceSessionId);
  const identityProfileAlreadyExists = await pathExists(paths.identityProfilePath);
  await Promise.all([
    mkdir(paths.runtimeCwd, { recursive: true }),
    mkdir(paths.agentDir, { recursive: true }),
    mkdir(paths.sessionDir, { recursive: true }),
    mkdir(dirname(paths.identityProfileBindingPath), { recursive: true }),
    ...(loadMagicContextExtension ? [mkdir(join(paths.runtimeCwd, ".cortexkit"), { recursive: true })] : []),
  ]);

  const profile =
    initialProfile !== undefined && !identityProfileAlreadyExists
      ? (await writeIdentityProfile(paths.identityProfilePath, initialProfile), initialProfile)
      : await readOrCreateIdentityProfile(paths.identityProfilePath, DEFAULT_IDENTITY_PROFILE);
  const profileMetadata = identityProfileMetadata(profile);
  const existingBinding = await readIdentityProfileBinding(paths.identityProfileBindingPath);
  const existingSessionFiles = await listSessionFiles(paths.sessionDir);
  if (existingBinding === null) {
    // A continuity owns one profile, while every explicit user-visible surface
    // session owns its own session binding. A new surface may therefore see an
    // existing profile but must never adopt pre-existing Pi JSONL without its
    // own binding.
    if (existingSessionFiles.length > 0 || (surfaceSessionId === undefined && identityProfileAlreadyExists))
      throw new Error("identity_profile_mismatch");
  } else {
    assertProfileMatchesBinding(identityKey(identity), profile, existingBinding);
    if (existingBinding.sessionFile !== null && !existingSessionFiles.includes(existingBinding.sessionFile)) {
      throw new Error("identity_profile_mismatch");
    }
    if (existingBinding.sessionFile === null && existingSessionFiles.length > 1) {
      throw new Error("identity_profile_mismatch");
    }
  }

  // Magic Context's project config is intentionally generated in the opaque
  // runtime directory, never in the game repository. The approved v0.33.0-
  // gamebuddy.2 gates are native same-scope SEMANTIC_MEMORY injection and
  // automatic embedded Historian authoring restricted
  // to this Host-owned opaque continuity runtime; auto_search remains off and
  // Host never gains project-memory/SQLite authority.
  const magicContextMemoryEnabled =
    internalMagicContextFeatureTestOverride?.memoryEnabled ?? MAGIC_CONTEXT_MEMORY_ENABLED;
  const magicContextHistorianEnabled =
    internalMagicContextFeatureTestOverride?.historianEnabled ?? MAGIC_CONTEXT_HISTORIAN_ENABLED;
  // Read once: the channel writes a diagnostic line when it is used, so calling it per key would repeat it.
  const protectedToolsChannel = readInternalHistorianTestChannel();
  if (loadMagicContextExtension)
    await writeFile(
      join(paths.runtimeCwd, ".cortexkit", "magic-context.jsonc"),
      JSON.stringify(
        {
          enabled: true,
          embedding: { provider: "off" },
          // Production selects the embedded-SDK, no-tool Historian. The internal
          // override can still disable it for A/B fixtures without changing any
          // Memory authority or exposing an authoring API. No `disallowed_tools` here: a historian runs with
          // zero tools by default upstream (measured: the flag survived as a no-op), so the intent needs no
          // key, and `expand_tools` stays off for the same reason - the historian reads plain text only.
          historian: magicContextHistorianEnabled
            ? {
                model: `${(modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).provider}/${(modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).modelId}`,
                thinking_level: (modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).thinkingLevel,
              }
            : { disable: true },
          ...(internalMagicContextFeatureTestOverride?.historianExecuteThresholdTokens === undefined
            ? {}
            : {
                execute_threshold_tokens: {
                  default: internalMagicContextFeatureTestOverride.historianExecuteThresholdTokens,
                },
              }),
          ...(internalMagicContextFeatureTestOverride?.historianExecuteThresholdPercentage === undefined
            ? {}
            : {
                execute_threshold_percentage:
                  internalMagicContextFeatureTestOverride.historianExecuteThresholdPercentage,
              }),
          ...(internalMagicContextFeatureTestOverride?.historianProtectedTokens === undefined
            ? {}
            : { protected_tokens: internalMagicContextFeatureTestOverride.historianProtectedTokens }),
          // Owner ruling D (2026-10-08): narrow-open Dreamer. Only the two
          // memory-hygiene tasks run. The schedule is the only disable control,
          // so every other canonical task is listed explicitly to keep the
          // upstream defaults from switching them on ("" is off but manually
          // runnable). inject_docs stays false: its default is true and it would
          // write ARCHITECTURE.md/STRUCTURE.md into the m[0] `<project-docs>`
          // block. Model resolution follows the historian convention here: flat
          // entries are adapted to the per-harness blocks in memory by the
          // plugin's project-tier loader, and the project file is never rewritten.
          dreamer: {
            disable: false,
            inject_docs: false,
            model: `${(modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).provider}/${
              (modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).modelId
            }`,
            thinking_level: (modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).thinkingLevel,
            tasks: {
              "classify-memories": { schedule: "0 6 * * *" },
              curate: { schedule: "0 4 * * 0" },
              "map-memories": { schedule: "" },
              verify: { schedule: "" },
              "verify-broad": { schedule: "" },
              "compress-cues": { schedule: "" },
              retrospective: { schedule: "" },
              "maintain-docs": { schedule: "" },
              "evaluate-smart-notes": { schedule: "" },
              "review-user-memories": { schedule: "" },
              "promote-primers": { schedule: "" },
              "refresh-primers": { schedule: "" },
            },
          },
          sidekick: { disable: true },
          // The upstream generic system block is written for a coding agent, and what it carries is the desk
          // protocol: the archive is searchable, ctx_search reads it back, ctx_expand returns one item whole, and
          // a reply opens with a §N§ number. The Game surface needs the first three and must not be given the
          // fourth, so the primary section is the Host's own prose
          // (magic-context-companion-guidance.ts) supplied through the extension's primaryOverride seam, and the
          // runtime clauses (temporal, caveman, language) stay composer-owned. m[0]/m[1] remains the sole native
          // read-only Semantic Memory injection path.
          //
          // skip_signatures is stated rather than left to its upstream default, and it is the surface opt-out:
          // Chat mounts no ctx_* tool, so the protocol would describe tools she does not have there. Both
          // directions are asserted where the prompts are built, because the signature is a substring of the
          // Chat prompt and the Game prompt carries the player's own free text.
          system_prompt_injection: { enabled: true, skip_signatures: [CHAT_SURFACE_SKIP_SIGNATURE] },
          memory: {
            // GameBuddy selects the domain; the vendored Magic Context fork owns
            // historian interpretation, promotion, retrieval, and injection.
            // The Host never gains an SQLite API or writer. Magic Context itself
            // owns any domain-valid promotion triggered by the embedded Historian.
            // Chat/Game retain separate Pi surface sessions. The only approved
            // cross-surface material is Magic Context's native same-continuity
            // read-only Semantic Memory gate; Host does not synthesize recall.
            domain: MAGIC_CONTEXT_MEMORY_DOMAIN,
            enabled: magicContextMemoryEnabled,
            auto_promote: MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
            // Keep explicit to prevent an upstream default flip from silently
            // enabling a current-session hint and being mistaken for continuity recall.
            auto_search: { enabled: MAGIC_CONTEXT_RECALL_ENABLED },
          },
          // Upstream's `todowrite` is its coding-agent task-list tool, and this surface never calls it:
          // the Companion plays Stardew, it does not plan a code change. It is switched OFF here rather
          // than mounted and hidden, so the model is never offered a tool it must not use. The extension
          // itself stays loaded - Memory, the Historian and context assembly all still come from it.
          todowrite: { enabled: false, overlay: false },
          smart_drops: false,
          // Upstream's smart drops cannot be turned off, so this Host states which tool results they
          // must leave alone (see magic-context-protected-tools.ts for the policy and its test for the
          // registry check). A fixture-only environment channel can zero the table for the control arm of
          // the paired live measurement that policy owes - see protectedToolsForRun.
          protected_tools: protectedToolsForRun(protectedToolsChannel.protectGameTools === false),
          temporal_awareness: false,
        },
        null,
        2,
      ),
      "utf8",
    );

  // Magic Context treats a few keys as USER-scope trust decisions, not project ones - by its own
  // security rule, "a repository may only RAISE execute_threshold_tokens …" and "historian model
  // selection is user-level only". The Host writes only the project file above, so those keys would
  // otherwise be read from the PLAYER's own profile (`~/.config/cortexkit/magic-context.jsonc`) or
  // from a user Pi installation's, and our historian would resolve to whatever that machine happens
  // to configure - or to nothing at all on a player's PC. The runtime therefore owns its user-scope
  // config too, inside the runtime root, and the extension bootstrap below points XDG_CONFIG_HOME at
  // it. One rule: this runtime reads and writes nothing outside its own root.
  const magicContextUserConfigDir = join(paths.runtimeCwd, "config");
  if (loadMagicContextExtension) {
    await mkdir(join(magicContextUserConfigDir, "cortexkit"), { recursive: true });
    // Magic Context writes its own prose - the fold's `<new-compartments>` summaries and their one-line titles, the
    // guidance block - from ITS `language` setting, not from the companion prompt, so leaving it unset is what made
    // a Chinese session's own memories arrive in English. The value is the player's companion locale: the surface's
    // own already-resolved presentation locale where it carries one, and otherwise the stored preference the Game
    // core call resolves for itself (it passes no presentation). See magic-context-content-language.ts for the shape
    // the vendor accepts and why an unusable locale is refused rather than written.
    const companionLocale = presentation?.profile.locale ?? (await resolveCompanionLocale(paths.root));
    const contentLanguage = magicContextContentLanguage(companionLocale);
    // The Game surface's primary guidance section, written BEFORE the config that names it. The extension reads
    // both at boot and, when the path names no readable file carrying exactly one marker, warns and falls back to
    // the built-in coding-agent prose - so the order is what makes the seam reachable at all.
    await writeFile(
      join(magicContextUserConfigDir, "cortexkit", COMPANION_DESK_GUIDANCE_FILE_NAME),
      buildCompanionDeskGuidance(presentation?.profile.locale ?? DEFAULT_COMPANION_LOCALE),
      "utf8",
    );
    await writeFile(
      join(magicContextUserConfigDir, "cortexkit", "magic-context.jsonc"),
      JSON.stringify(
        {
          prompt_surface: { guidance_override_path: COMPANION_DESK_GUIDANCE_FILE_NAME },
          ...(contentLanguage === undefined ? {} : { language: contentLanguage }),
          ...(magicContextHistorianEnabled
            ? {
                historian: {
                  pi: {
                    model: `${(modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).provider}/${
                      (modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).modelId
                    }`,
                    thinking_level: (modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).thinkingLevel,
                  },
                },
              }
            : {}),
          ...((internalMagicContextFeatureTestOverride?.historianExecuteThresholdTokens ??
            readInternalHistorianTestChannel().executeThresholdTokens) === undefined
            ? {}
            : {
                execute_threshold_tokens: {
                  default:
                    internalMagicContextFeatureTestOverride?.historianExecuteThresholdTokens ??
                    readInternalHistorianTestChannel().executeThresholdTokens,
                },
              }),
          ...((internalMagicContextFeatureTestOverride?.historianProtectedTokens ??
            readInternalHistorianTestChannel().protectedTokens) === undefined
            ? {}
            : {
                protected_tokens:
                  internalMagicContextFeatureTestOverride?.historianProtectedTokens ??
                  readInternalHistorianTestChannel().protectedTokens,
              }),
          // The fold's real trigger is the percentage; the token key only states a floor. A fixture that wants
          // a fold inside a session-sized conversation has to move this one.
          ...(readInternalHistorianTestChannel().executeThresholdPercentage === undefined
            ? {}
            : {
                execute_threshold_percentage: readInternalHistorianTestChannel().executeThresholdPercentage,
              }),
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });

  // Render/management partition agreement. Magic Context resolves a project
  // identity by walking up from the session cwd looking for a git root; for a
  // host-owned runtime root that walk escapes the root and lands on the user's
  // home repository (a single identity shared by every tenant) or, when the home
  // project is disallowed, on `undefined` (memory injection silently off). The
  // management CRUD facade writes under `gamebuddy:<identity>:continuity:<id>`
  // via resolveGameBuddyMemoryProjectPath, so the render side must be told to
  // read that same partition. This is boot-time and locked, matching setHarness;
  // a second runtime with a DIFFERENT continuity in one process throws instead of
  // silently reading the wrong tenant's memories.
  if (loadMagicContextExtension && magicContextMemoryEnabled) {
    const memoryHooks = await import("@cortexkit/pi-magic-context/memory");
    const renderPartition =
      identity.continuityId === undefined
        ? undefined
        : memoryHooks.resolveGameBuddyMemoryProjectPath(paths.runtimeCwd, identity.continuityId);
    if (renderPartition !== undefined) {
      memoryHooks.setDeclaredProjectIdentity(renderPartition);
    }

    // Non-durable runtime environment facts (game clock, date, weather): the
    // host registers one provider per runtime; the Magic Context transform
    // pass injects its CURRENT value as an idempotent <runtime-environment>
    // block so the companion sees live world state on the next turn without
    // ever writing it to player memory. Facts are read straight from the
    // authenticated Mod snapshot (the same numbers the native game reads).
    // Absent a usable snapshot the provider renders nothing; the block is
    // then stripped by the same pass and the companion sees no stale state.
    if (integration !== undefined && identity.continuityId !== undefined) {
      // The vendored transform owns exactly ONE process-global provider and
      // throws on a second non-undefined registration. A Host process legally
      // mounts a fresh Game runtime after a disconnect/resume: the production
      // lifecycle coordinator closes the previous facade and re-enters
      // (`consumeOwnedFarmhandBridgeConnection` -> `runEnter`), so the later
      // mount must replace the previous runtime's provider with its own
      // authenticated connection instead of failing the boot with
      // `runtime_environment_facts_provider_already_registered`. `undefined` is
      // the vendored module's own removal path: the block is stripped until the
      // replacement provider renders.
      //
      // The provider is built by `createRenderedEnvironmentFactsProvider`, which renders exactly what
      // this closure used to return AND records it beside this run's manifest: the transform calls it
      // once per assembled request, and that call is the only moment the rendered block exists anywhere
      // a later reader could look. Nothing here writes the block into the session or player memory.
      memoryHooks.setRuntimeEnvironmentFacts(undefined);
      memoryHooks.setRuntimeEnvironmentFacts(
        createRenderedEnvironmentFactsProvider(integration, environmentFactsRecordPath(paths)),
      );
    }
  }

  // Resolve the declared runtime dependency rather than a source-relative
  // vendor path. Production artifacts are immutable generations outside the
  // repository, while the package manager binds this file dependency to the
  // same source-owned, prebuilt Magic Context extension in development and CI.
  // The resolver is anchored at `host/` (not the emitted generation) so it
  // cannot accidentally acquire an extension from a user Pi installation.
  const magicContextEntry = resolveMagicContextExtensionEntry();
  // The player's own addition to the Game companion's instructions, resolved ONCE here and
  // carried by this session for its whole life. Read at construction rather than inside the
  // prompt builder for a product reason, not a performance one: a Game session composes its
  // instructions when it starts, so a player who edits the addition mid-game keeps playing the
  // game that started - which is exactly what the settings panel promises beside the field. A
  // per-turn read here would make that sentence false, and the session would change character
  // under the player's hands.
  //
  // Chat never reads it: the addition is the Game surface's own, and a Chat mount that consulted
  // it would be reaching for a setting its own settings group does not show.
  const gamePromptAddition = runtimeSurface === "game" ? await resolveGamePromptAddition(paths.root) : undefined;
  // The generation preset this runtime cwd was provisioned with (`tavern/preset-game-session.ts`). Chat reads none:
  // the ruling is about the Game surface, and a Chat mount that started honouring a preset file would change how
  // every stored conversation is assembled without anyone asking it to.
  const gameSessionPreset =
    runtimeSurface === "game"
      ? await readGameSessionPreset(paths.runtimeCwd, {
          profile,
          ...(presentation?.profile.locale === undefined ? {} : { locale: presentation.profile.locale }),
        })
      : null;
  // One string, built here rather than inline below, because it is also what the two guards read: the shared
  // Magic Context config skips its guidance block by a SUBSTRING of the Chat prompt, so the substring has to be
  // shown to cross no surface boundary in either direction. See `assertMagicContextSurfaceSignature`.
  const companionSystemPrompt =
    runtimeSurface === "chat"
      ? buildChatCompanionSystemPrompt(profile, presentation?.profile.locale)
      : withPresetMain(
          buildGameCompanionSystemPrompt(profile, presentation?.profile.locale, gamePromptAddition),
          gameSessionPreset,
        );
  assertMagicContextSurfaceSignature(runtimeSurface, companionSystemPrompt);
  // The turn a provider request belongs to is stated on the request itself, because nothing else on the
  // wire carries it and a captured body could otherwise only be attributed by its arrival position. The
  // value is set by the provider-start runner and cleared by the same turn; an inline factory is the only
  // per-request seam Pi offers (see `provider-turn-header.internal.ts`), and it survives `noExtensions`,
  // which describes disabled extension PATHS and not an inline factory the Host registers itself.
  const providerTurnHeader = createProviderTurnHeaderScope();
  const loader = new DefaultResourceLoader({
    cwd: paths.runtimeCwd,
    agentDir: paths.agentDir,
    settingsManager: settings,
    noExtensions: true,
    additionalExtensionPaths: loadMagicContextExtension ? [magicContextEntry] : [],
    extensionFactories: [
      {
        name: PROVIDER_TURN_HEADER_EXTENSION_NAME,
        hidden: true,
        factory: (pi) => providerTurnHeaderExtension(pi, providerTurnHeader),
      },
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: companionSystemPrompt,
    appendSystemPrompt: [],
  });
  // The fork must never spawn the external `pi` CLI from a GameBuddy runtime.
  // Preview has no approved Magic Context capability, so it does not mount or
  // bootstrap the extension at all.
  const previousEmbeddedRuntimeMarker = loadMagicContextExtension ? process.env.GAMEBUDDY_EMBEDDED_RUNTIME : undefined;
  if (loadMagicContextExtension) {
    process.env.GAMEBUDDY_EMBEDDED_RUNTIME = "1";
    try {
      // The extension discovers config/data through Node process globals. The
      // helper scopes and serializes that bootstrap so opaque partitions cannot
      // race each other during loader.reload().
      await reloadMagicContextInRuntimeRoot(loader, paths.runtimeCwd);

      if (loader.getExtensions().errors.length > 0) {
        throw new Error(
          `Magic Context extension failed to load: ${loader
            .getExtensions()
            .errors.map((error) => error.error)
            .join("; ")}`,
        );
      }
    } catch (error) {
      if (previousEmbeddedRuntimeMarker === undefined) delete process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
      else process.env.GAMEBUDDY_EMBEDDED_RUNTIME = previousEmbeddedRuntimeMarker;
      throw error;
    }
  } else {
    await loader.reload();
  }

  const sessionManager = SessionManager.continueRecent(paths.runtimeCwd, paths.sessionDir);
  const modelRuntime = await createCompanionModelRuntime(paths.agentDir, modelConfig, gameSessionPreset?.sampling);
  const model =
    modelConfig === undefined ? undefined : modelRuntime.getModel(modelConfig.provider, modelConfig.modelId);
  if (modelConfig !== undefined && model === undefined) throw new Error("companion_model_not_available");

  assertFrozenFixedTools(fixedTools);
  const fixedToolNames = fixedTools.map((tool) => tool.name);
  if (fixedTools.length > 0 && runtimeSurface !== "game") throw new Error("fixed_runtime_tools_require_game_surface");
  const companionStatus = createCompanionStatusTool(integration);
  const runTrace = actionExecutionOptions.trace;
  const dispatchController =
    integration === undefined ? undefined : createRuntimeDispatchController(integration, actionExecutionOptions);
  // One private supervisor per game runtime. It is retained by closure so an
  // explicit relaunch can run exactly one bounded pass over the same
  // coordinator without ever exporting the coordinator itself.
  const receiptRecoverySupervisor =
    dispatchController === undefined ? undefined : new StardewExecutionRecoverySupervisor(dispatchController);
  if (actionExecutionOptions.recoveryJournal !== undefined && actionExecutionOptions.recoveryBinding === undefined)
    throw new Error("stardew_recovery_composition_unavailable");
  if (gameHostBindingFactory !== undefined && (runtimeSurface !== "game" || dispatchController === undefined))
    throw new Error("invalid_game_host_binding_factory");
  const boundPresentation =
    gameHostBindingFactory === undefined
      ? presentation
      : gameHostBindingFactory(Object.freeze({ interruption: dispatchController!.interruption }));
  const integrationToolSet =
    integration !== undefined && integrationModule !== undefined
      ? integrationModule.createToolSet({
          connection: integration,
          knowledge: integration.knowledge,
          ...(integration.gameVersion === undefined ? {} : { gameVersion: integration.gameVersion }),
          policy: mountedPolicy,
          ...(runTrace === undefined ? {} : { trace: runTrace }),
          ...(dispatchController === undefined
            ? {}
            : { dispatchAdmissionFactory: () => dispatchController.createAdmission() }),
        })
      : undefined;
  // A surface that carries the plan builder does not also carry the flat per-action tools: the builder exposes a
  // method for every action the plan form admits (host/src/body-program-script.ts, generated from the registration
  // vocabulary, never hand-written per action), so a one-step tool mounted beside it only invites one-step runs. A
  // tool the adapter does not publish as an action stays mounted - `stardew_stop_action` is deliberately not an
  // action. The decision is the composition's to declare, not a Stardew tool name's to imply here.
  const actionToolsToMount =
    integrationToolSet === undefined
      ? []
      : planActionSurface
        ? integrationToolSet.actions.filter((tool) => integrationModule?.actionIdForToolName(tool.name) === null)
        : integrationToolSet.actions;
  // Tool definitions remain mounted for the lifetime of a Pi session. Every adapter tool therefore receives a
  // Host-owned execution fence so a later lifecycle loss revokes stale closures rather than trusting the adapter
  // to remember to check its own disconnected state. The adapter's own groups are also what CLASSIFY these tools:
  // its observation and action tools act on the live world, and its knowledge bundle is authored context.
  const gateIntegration = (tool: ToolDefinition): ToolDefinition =>
    integration === undefined ? tool : gateIntegrationTool(tool, integration);
  const integrationToolGroups: readonly DeclaredToolGroup[] =
    integrationToolSet === undefined
      ? []
      : [
          {
            toolClass: "game_action",
            tools: [...integrationToolSet.observation, ...actionToolsToMount].map(gateIntegration),
          },
          { toolClass: "world_context", tools: [...integrationToolSet.knowledge].map(gateIntegration) },
        ];
  const worldBookScope = integration === undefined ? null : integration.module.worldScope(integration);
  const worldBookTools =
    worldBook === undefined
      ? []
      : createWorldBookTools(worldBook, worldBookScope ?? undefined, { char: profile.identity.name });
  // `delegate_game_task` is composed but deliberately not mounted here. Every
  // runtime on this surface has a live game session attached, and the tool
  // returned only when its nested agent finished: one call swallowed 172.9 s of
  // a 422 s run, 41% (`toolTiming.byCategory.delegate_game_task` in
  // `tools/_multiday_routine-g112attrib.result.json`; 34.4 s in
  // `tools/_multiday_routine-g118answer.result.json`). Disclosure may only
  // reduce, so the worker and its bounded budget stay composed below for a
  // Chat/ops surface that carries no live session instead of being mounted on
  // this one.
  const gameplaySubagent =
    gameplaySubagentEnabled && runtimeSurface === "game"
      ? integration !== undefined && modelConfig !== undefined
        ? new GameplayTaskSubagent(paths, integration, mountedPolicy, undefined, undefined, () =>
            dispatchController!.createAdmission(),
          )
        : (() => {
            throw new Error("gameplay_subagent_requires_model_and_integration");
          })()
      : undefined;
  // The one place a tool's reach is declared, and the reason this file no longer lists tool names. Chat is a pure
  // dialogue surface: native assistant content is its sole player-visible expression channel, and no status, Magic
  // Context, Game, or delegation tool may steer it into an intermediate tool-use turn, so it composes none and
  // permits none. Game declares each group it assembles, plus the class each extension it loads contributes; a tool
  // added to any of those sources mounts here by its class, with nothing to add to a list.
  const hostToolGroups: readonly DeclaredToolGroup[] =
    runtimeSurface === "chat"
      ? []
      : [
          { toolClass: "host_control", tools: [companionStatus] },
          { toolClass: "program", tools: fixedTools },
          ...integrationToolGroups,
          { toolClass: "world_context", tools: worldBookTools },
        ];
  const toolSurface = planToolSurface({
    surface: runtimeSurface,
    groups: hostToolGroups,
    // The Magic Context extension contributes a session's own archive and memory readers. Its entry is the one
    // extension path this runtime hands the loader, so the class and the load site cannot drift apart.
    extensions: loadMagicContextExtension ? [{ entry: magicContextEntry, toolClass: "session_inspection" }] : [],
    registered: loader.getExtensions().extensions.map((extension) => ({
      entry: extension.path,
      tools: [...extension.tools.keys()],
    })),
  });
  applyToolDescriptionOverrides(loader.getExtensions().extensions, toolSurface);
  const inactiveFixedToolNames = fixedTools.filter((tool) => tool.defaultActive === false).map((tool) => tool.name);
  const expectedToolNames = toolSurface.mounted.filter((name) => !inactiveFixedToolNames.includes(name));
  const customTools = hostToolGroups
    .flatMap((group) => group.tools)
    .map((tool) =>
      runTrace === undefined
        ? tool
        : tracedTool(
            tool,
            runTrace,
            fixedToolNames.includes(tool.name)
              ? "program_tool"
              : integration !== undefined && integration.module.actionIdForToolName(tool.name) !== null
                ? "action_dispatch"
                : undefined,
          ),
    );
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  try {
    ({ session } = await createAgentSession({
      cwd: paths.runtimeCwd,
      agentDir: paths.agentDir,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager,
      modelRuntime,
      ...(model === undefined ? {} : { model }),
      noTools: "all",
      tools: [...toolSurface.mounted],
      customTools,
      // The player's own thinking level is forwarded verbatim: the embedded
      // runtime clamps a level the selected model does not advertise instead of
      // this Host narrowing a value the player typed (design/28 §2.3.1, §2.3.5).
      thinkingLevel: piThinkingLevel(modelConfig?.thinkingLevel ?? "off"),
    }));
  } finally {
    if (loadMagicContextExtension) {
      if (previousEmbeddedRuntimeMarker === undefined) delete process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
      else process.env.GAMEBUDDY_EMBEDDED_RUNTIME = previousEmbeddedRuntimeMarker;
    }
  }

  // After session construction, and only for a runtime that mounted Magic Context: the embedded
  // historian spawns per trigger with this registry, and without it every attempt fails closed.
  if (loadMagicContextExtension) await bindEmbeddedHistorianModelRegistry(modelRuntime);

  // The preset facts ONE bounded line per Game runtime, printed here because they cannot be stated earlier: the
  // thinking level is Pi's clamped answer (not the level the player typed) and the composed model is what the adapter
  // will actually send. The live-run bundle publishes this line rather than re-deriving the same facts from a second
  // copy of the preset, so "did the run load the preset?" is answerable from the run's own record.
  if (runtimeSurface === "game")
    process.stderr.write(
      `${formatCompanionPresetLine(
        companionPresetPublication({
          preset: gameSessionPreset,
          runtimeCwd: paths.runtimeCwd,
          sampling: effectivePresetSamplingValues(gameSessionPreset, model, session),
          contextWindow: model?.contextWindow,
        }),
      )}\n`,
    );

  // Once Pi has returned a session, every subsequent initialization step owns
  // one deterministic reverse path. In particular, publication is cleared
  // before Pi disposal so a reused session id cannot retain stale context.
  let clearTavernNarrativeGateMarker: (() => void) | undefined;
  let reportTavernNarrativeGateRuntime: (() => void) | undefined;
  let clearGameOperationalGateMarker: (() => void) | undefined;
  let installTavernProviderStartObserver:
    | ((
        onStart: (
          observation: Readonly<{
            sessionId: string;
            statusClass: "success" | "error";
          }>,
        ) => void,
      ) => () => void)
    | undefined;
  try {
    // Pi activates every allowlisted tool on construction, including a fixed tool that declared itself
    // `defaultActive: false`: keeping a tool available and declaring it are two decisions, and the second one is
    // this runtime's. The isolation check that follows is a PROPERTY of the mounted set, not an equality against a
    // list: every mounted tool's class is permitted on this surface, no denied-class tool is mounted, and every
    // planned tool that did not declare itself inactive for this run is actually there.
    if (expectedToolNames.length !== toolSurface.mounted.length) session.setActiveToolsByName(expectedToolNames);
    assertToolSurface(
      toolSurface,
      session.agent.state.tools.map((tool) => tool.name),
      inactiveFixedToolNames,
    );
    const activeTools = session.agent.state.tools.map((tool) => tool.name).sort();

    const sessionFile =
      session.sessionFile === undefined || !(await pathExists(session.sessionFile))
        ? null
        : basename(session.sessionFile);
    const expectedSessionFile =
      existingBinding?.sessionFile ?? (existingSessionFiles.length === 1 ? existingSessionFiles[0] : null);
    if (existingBinding !== null && expectedSessionFile !== null && expectedSessionFile !== sessionFile) {
      throw new Error("identity_profile_mismatch");
    }
    await writeIdentityProfileBinding(
      paths.identityProfileBindingPath,
      createIdentityProfileBinding(identityKey(identity), profile, sessionFile),
    );
    const piSessionId = sessionManager.getSessionId();
    if (typeof piSessionId !== "string" || piSessionId.length === 0) {
      throw new Error("pi_session_binding_unavailable");
    }
    if (tavernNarrativeGateNonceSha256 !== undefined) {
      reportTavernNarrativeGateRuntime = () => {
        // Both ways this can fail leave the gate evidence absent, and an absent
        // marker is indistinguishable from a product that simply never reached
        // the provider. A run then reports `no_pre_send_marker` and the reader
        // cannot tell whether the cause is the transport or the product - which
        // is exactly the state that made the provider timing unmeasurable. So
        // say which one it is, on a line the harness already captures.
        if (typeof process.send !== "function" || process.connected !== true) {
          process.stderr.write(
            `[tavern-gate] runtime marker unavailable: send=${typeof process.send} connected=${process.connected === true}\n`,
          );
          return;
        }
        try {
          process.send(
            Object.freeze({
              schema: "gamebuddy-tavern-narrative-gate-runtime/v1",
              piSessionId,
            }),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[tavern-gate] runtime marker rejected: ${message.slice(0, 200)}\n`);
          // Gate evidence failure does not change the actual provider path.
        }
      };
      const bridge = (await import("@cortexkit/pi-magic-context/tavern")) as {
        registerTavernNarrativeGateMarker: (value: Readonly<{ sessionId: string; nonceSha256: string }>) => () => void;
      };
      clearTavernNarrativeGateMarker = bridge.registerTavernNarrativeGateMarker({
        sessionId: piSessionId,
        nonceSha256: tavernNarrativeGateNonceSha256,
      });
    }
    if (gameOperationalGate !== undefined) {
      const bridge = (await import("@cortexkit/pi-magic-context/tavern")) as {
        registerGameOperationalGateMarker: (
          value: Readonly<{
            sessionId: string;
            nonceSha256: string;
            surface: "game";
          }>,
        ) => () => void;
      };
      clearGameOperationalGateMarker = bridge.registerGameOperationalGateMarker({
        sessionId: piSessionId,
        nonceSha256: gameOperationalGate.nonceSha256,
        surface: "game",
      });
    }
    if (loadMagicContextExtension) {
      const bridge = (await import("@cortexkit/pi-magic-context/tavern")) as {
        registerTavernProviderStartObserver: (
          sessionId: string,
          onStart: (
            observation: Readonly<{
              sessionId: string;
              statusClass: "success" | "error";
            }>,
          ) => void,
        ) => () => void;
      };
      if (typeof bridge.registerTavernProviderStartObserver !== "function")
        throw new Error("tavern_provider_start_observer_bridge_unavailable");
      installTavernProviderStartObserver = (onStart) =>
        bridge.registerTavernProviderStartObserver(piSessionId, onStart);
    }
    await writeOrVerifyRunManifest(paths, {
      schemaVersion: 1,
      identity,
      runtime: RUNTIME_PACKAGE_VERSIONS,
      model: {
        provider: modelConfig?.provider ?? null,
        modelId: modelConfig?.modelId ?? null,
        thinkingLevel: modelConfig?.thinkingLevel ?? null,
      },
      gameplaySubagentModel: gameplaySubagent === undefined ? null : gameplaySubagent.modelConfig,
      actionRegistryRevision: actionRegistryRevision(
        integration === undefined || integrationModule === undefined
          ? []
          : integrationModule.actionCatalog.visibleActions(
              integrationModule.readState(integration).registrations ?? [],
              integrationModule.readState(integration).capabilities,
              mountedPolicy,
            ),
      ),
      actionPolicy: mountedPolicy,
      mountedTools: activeTools,
      knowledge:
        integrationModule === undefined
          ? { mounted: false, gameVersion: null, bundleVersion: null }
          : integrationModule.knowledgeMetadata({
              ...(integration === undefined ? {} : { connection: integration }),
              knowledge: integration?.knowledge,
              ...(integration?.gameVersion === undefined ? {} : { gameVersion: integration?.gameVersion }),
            }),
      identityProfile: profileMetadata,
      worldBook: worldBook === undefined ? null : worldBook.metadata,
      presentation: boundPresentation?.profile ?? null,
      featureFlags: {
        gameplaySubagent: gameplaySubagent !== undefined,
        magicContextMemoryDomain: MAGIC_CONTEXT_MEMORY_DOMAIN,
        magicContextMemoryEnabled,
        magicContextAutoPromoteEnabled: MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
        magicContextAutoSearchEnabled: MAGIC_CONTEXT_RECALL_ENABLED,
      },
    });

    return {
      session,
      piSessionId,
      sessionManager,
      paths,
      identityKey: identityKey(identity),
      identityProfile: profileMetadata,
      profile,
      extensions: loader.getExtensions().extensions.map((extension) => extension.path),
      toolSurface,
      providerTurnHeader,
      ...(boundPresentation === undefined ? {} : { presentation: boundPresentation }),
      ...(gameplaySubagent === undefined ? {} : { gameplaySubagent }),
      ...(dispatchController === undefined
        ? {}
        : {
            interruption: dispatchController.interruption,
            cancelIntegrationEpoch: (epoch: number, reasonCode: string) =>
              dispatchController.cancelEpoch(epoch, reasonCode),
            interruptIntegrationExecutions: (reasonCode: string) => dispatchController.interrupt(reasonCode),
            bindIntegrationReceipt: (receipt: ExecutionReceipt) => dispatchController.receiveReceipt(receipt),
            recoverStardewExecutionReceipts: (port) => receiptRecoverySupervisor!.recoverFromFreshBinding(port),
          }),
      ...(runTrace === undefined ? {} : { runTrace }),
      ...(clearTavernNarrativeGateMarker === undefined ? {} : { clearTavernNarrativeGateMarker }),
      ...(reportTavernNarrativeGateRuntime === undefined ? {} : { reportTavernNarrativeGateRuntime }),
      ...(clearGameOperationalGateMarker === undefined ? {} : { clearGameOperationalGateMarker }),
      ...(installTavernProviderStartObserver === undefined ? {} : { installTavernProviderStartObserver }),
    };
  } catch (error) {
    throw await cleanupRuntimeInitializationFailure(
      session,
      clearTavernNarrativeGateMarker,
      clearGameOperationalGateMarker,
      error,
    );
  }
}

/**
 * Creates an opaque-runtime-only Pi registry for the locked Companion Agent.
 * Credentials are resolved from CPA_OAI_API_KEY by Pi at request time and are
 * never written into the identity partition.
 */
/** Resolve only the Host-declared Magic Context package entry, never user Pi state. */
export function resolveMagicContextExtensionEntry(): string {
  try {
    // `import.meta.url` is inside Host source or a Host production generation;
    // Node therefore walks only Host's declared dependency ancestry. Resolve
    // using ESM conditions: this extension deliberately exports only `import`,
    // so `createRequire(...).resolve()` would incorrectly reject it.
    const entry = fileURLToPath(import.meta.resolve("@cortexkit/pi-magic-context"));
    if (!existsSync(entry)) throw new Error("missing");
    return entry;
  } catch {
    throw new Error("magic_context_extension_build_required");
  }
}

/**
 * Hand the embedded historian the model registry it refuses to run without.
 *
 * Magic Context's embedded runner fails closed - `spawn_failed: embedded historian ModelRegistry is
 * not bound` - and its own documentation places this call with the embedding Host, after session
 * construction. Nothing called it, so on this Host the historian never produced anything: no
 * compartment was ever created, the decayed-history block stayed empty, and a chapter could never be
 * sealed.
 *
 * The binding is read from a `Symbol.for` slot on `globalThis` rather than by importing the extension
 * entry. Pi loads extensions through jiti (`loadExtensionModule` -> `jiti.import(path, { moduleCache:
 * false })`), so importing the same file here would evaluate a SECOND instance of the extension and
 * bind a registry into module state nothing reads - which is exactly what a first attempt did. The
 * symbol slot is the only channel that crosses that registry boundary.
 *
 * A missing binding in embedded mode is a real fault, not a no-op to swallow: the artifact is meant to
 * expose it, and silently continuing is how this gap went unnoticed for so long.
 */
async function bindEmbeddedHistorianModelRegistry(modelRuntime: ModelRuntime): Promise<void> {
  const slot = Symbol.for("magic-context.pi.embedded-historian-binding");
  const binding = (
    globalThis as typeof globalThis & {
      [slot]?: { bind(registry: ModelRegistry): boolean };
    }
  )[slot];
  // Never fatal. This runs on every Chat and Game runtime construction, and a missing binding means the
  // extension did not publish it - a real gap, but one that must not take the whole runtime down. It is
  // reported on stderr (the composed child's log) so the gap stays visible instead of silent.
  if (binding === undefined) {
    process.stderr.write(
      "[historian] embedded historian binding unavailable: the mounted Magic Context did not publish one\n",
    );
    return;
  }
  // The facade is synchronous over the runtime's catalog, and the historian resolves its model through
  // `find()`, so the catalog has to be loaded before the registry is handed over.
  const registry = new ModelRegistry(modelRuntime);
  await registry.refresh();
  if (!binding.bind(registry)) process.stderr.write("[historian] embedded historian refused the model registry\n");
}

type RuntimeSessionResource = Awaited<ReturnType<typeof createAgentSession>>["session"];

async function cleanupRuntimeInitializationFailure(
  session: RuntimeSessionResource,
  clearNarrativeGateMarker: (() => void) | undefined,
  clearOperationalGateMarker: (() => void) | undefined,
  primary: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  try {
    clearNarrativeGateMarker?.();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    clearOperationalGateMarker?.();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    session.dispose();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) throw new AggregateError([primary, ...cleanupErrors], "runtime_initialization_failed");
  throw primary;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function listSessionFiles(sessionDir: string): Promise<string[]> {
  return (await readdir(sessionDir)).filter((entry) => /^[A-Za-z0-9._-]{1,256}\.jsonl$/.test(entry)).sort();
}

/**
 * Writes the runtime's provider entry into Pi's own `models.json` without
 * discarding the entries of other writers.
 *
 * `models.json` belongs to the embedded Pi runtime, and more than one runtime
 * identity, provider and player connection writes to it over a Host lifetime.
 * Replacing the whole document would delete a sibling entry every time a
 * runtime starts. Merging keeps every other provider entry intact, and on a
 * root with no other entry the merged document is the previous single-provider
 * document, byte for byte.
 */

async function createCompanionModelRuntime(
  agentDir: string,
  config: CompanionModelConfig | undefined,
  /**
   * The generation preset's sampler values, for the surfaces that apply a preset. Omitted everywhere else, which
   * leaves the provider entry byte-identical to what it was before this parameter existed.
   */
  presetSampling?: PresetSamplingValues,
): Promise<ModelRuntime> {
  const modelsPath = join(agentDir, "models.json");
  // The selection decides the provider entry. An operator/environment model
  // writes the frozen `cpa-oai` block this Host has always written; a player
  // connection writes its own catalog endpoint, and the escape hatch writes the
  // endpoint the player supplied.
  const selection = config === undefined ? null : await modelProviderEntry(agentDir, config);
  if (config !== undefined && selection === null) throw new Error("companion_model_endpoint_unavailable");
  if (selection !== null && config !== undefined) {
    // `samplingParams` is the ONE layer the adapter merges into the request body last (design §5), so the preset's
    // values ride `modelOverrides[<modelId>]` through the same `mergeModelProviderEntry` every other writer uses.
    const entry =
      presetSampling === undefined
        ? selection.entry
        : withPresetSampling(selection.entry, config.modelId, presetSampling);
    await mergeModelProviderEntry(join(agentDir, "models.json"), selection.providerId, entry);
  }
  // Offline by default. Selecting the explicitly configured Agent model is the
  // operator's opt-in to provider networking; no request occurs merely while
  // creating or resuming the session.
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: config !== undefined,
  });
}

function sameModelConfig(left: CompanionModelConfig | null, right: CompanionModelConfig | null): boolean {
  // A mount that opened with no model has nothing in common with any selection, so acquiring one is
  // always a change to apply rather than a no-op that leaves the session on Pi's placeholder model.
  if (left === null || right === null) return false;
  return (
    left.provider === right.provider && left.modelId === right.modelId && left.thinkingLevel === right.thinkingLevel
  );
}

/**
 * Points an already-running Chat session at the player's current selection.
 *
 * The two setters Pi exposes for this (`setModel`, `setThinkingLevel`) append a
 * `model_change` / `thinking_level_change` entry to the session, which would
 * rewrite the conversation's own record for a fact that is not part of the
 * conversation. A player's selection is not an event in the transcript, so the
 * runtime takes the same two state assignments Pi's own model refresh takes and
 * leaves the session's entries exactly as they were; the next prompt reads the
 * new model, and the greeting anchor and every settled exchange keep pointing at
 * the model that produced them.
 */
/**
 * Writes the historian's model and thinking level into the two Magic Context config files a mount owns.
 *
 * Extracted from the mount's inline writers so the live model reload can reach exactly the same fact. The files are what the
 * embedded historian reads - it never looks at the Pi session's model - so a reload that repoints only the session leaves the
 * historian folding on the model the player just left.
 *
 * Failure is not fatal: the conversation the player is looking at must keep working, and a historian on a stale model is the
 * status quo this fixes rather than a new breakage. It is reported so the gap stays visible.
 */
async function projectHistorianModelForConstruction(
  construction: Readonly<{ identity: CompanionIdentity; runtimeRoot: string; surfaceSessionId: string }>,
  config: CompanionModelConfig,
): Promise<void> {
  const { runtimeCwd } = resolveRuntimePaths(
    construction.identity,
    construction.runtimeRoot,
    construction.surfaceSessionId,
  );
  const model = `${config.provider}/${config.modelId}`;
  try {
    await projectHistorianModel({ runtimeCwd, model, thinkingLevel: config.thinkingLevel });
  } catch (error) {
    process.stderr.write(
      `[historian] the model projection was not updated: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function applyCompanionModelSelection(
  session: RuntimeSessionResource,
  construction: Readonly<{ identity: CompanionIdentity; runtimeRoot: string; surfaceSessionId: string }>,
  config: CompanionModelConfig,
): Promise<void> {
  const { agentDir } = resolveRuntimePaths(
    construction.identity,
    construction.runtimeRoot,
    construction.surfaceSessionId,
  );
  const modelRuntime = await createCompanionModelRuntime(agentDir, config);
  const model = modelRuntime.getModel(config.provider, config.modelId);
  if (model === undefined) throw new Error("companion_model_not_available");
  session.agent.state.model = model;
  // The mount forwards the player's level verbatim and Pi clamps it to what the
  // selected model advertises (design/28 §2.3.5). The reload reaches the same
  // state by asking the session, now pointed at the new model, which levels it
  // accepts.
  const requested = piThinkingLevel(config.thinkingLevel);
  const supported = session.getAvailableThinkingLevels();
  session.agent.state.thinkingLevel = supported.includes(requested) ? requested : (supported[0] ?? "off");
}
