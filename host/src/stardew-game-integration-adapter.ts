import {
  type ActionPolicy,
  DEFAULT_ACTION_POLICY,
  parseActionPolicy,
  STARDEW_ACTION_ADAPTERS,
} from "./action-registry.js";
import { createStardewActionTools, createStardewObservationTools } from "./game-tools.js";
import {
  createIntegrationActionCatalog,
  DEFAULT_INTEGRATION_ACTION_POLICY,
  type GameIntegrationAdapter,
  type IntegrationActionPolicy,
  type IntegrationExecutionReceipt,
  type IntegrationIdentityBinding,
  type IntegrationReceiptEvidence,
  type IntegrationStateView,
  type IntegrationStatusDetails,
  type IntegrationToolContext,
} from "./game-integration-adapter.js";
import { assertAuthenticatedStardewConnection } from "./stardew-integration-launcher-body-program.internal.js";
import { createStardewKnowledgeTools, type KnowledgeBundle } from "./knowledge.js";
import type { ExecutionReceipt } from "./protocol.js";

const STARDew_ACTION_ENTRIES = STARDEW_ACTION_ADAPTERS.map(({ actionId }) => ({
  actionId,
}));

/**
 * The first concrete adapter. Stardew-specific tool/schema/evidence behavior
 * remains here while the Host composition root only consumes this port.
 */
function createStardewGameIntegrationAdapter(): GameIntegrationAdapter {
  const actionCatalog = createIntegrationActionCatalog(STARDew_ACTION_ENTRIES, hasStardewCompletionEvidence);
  return Object.freeze({
    descriptor: Object.freeze({
      integrationId: "stardew",
      version: "bridge-v1",
      toolNamePrefix: "stardew_",
    }),
    actionCatalog,
    defaultPolicy: DEFAULT_INTEGRATION_ACTION_POLICY,
    parsePolicy: (value: unknown): IntegrationActionPolicy => parseActionPolicy(value),
    actorId: (connection) => {
      const authenticated = assertAuthenticatedStardewConnection(connection);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(authenticated.scope.playerId))
        throw new Error("integration_identity_mismatch");
      return authenticated.scope.playerId;
    },
    assertIdentityBinding: (connection, identity: IntegrationIdentityBinding) => {
      const scope = assertAuthenticatedStardewConnection(connection).scope;
      if (
        scope.companionId !== identity.companionId ||
        identity.saveId === undefined ||
        identity.worldId === undefined ||
        scope.saveId !== identity.saveId ||
        scope.worldId !== identity.worldId
      ) {
        throw new Error("integration_identity_binding_mismatch");
      }
    },
    worldScope: (connection) => {
      const scope = assertAuthenticatedStardewConnection(connection).scope;
      return Object.freeze({
        integrationId: scope.integrationId,
        saveId: scope.saveId,
        worldId: scope.worldId,
      });
    },
    createToolSet: ({
      connection,
      knowledge: mountedKnowledge,
      gameVersion: mountedGameVersion,
      policy,
      dispatchAdmissionFactory,
    }: IntegrationToolContext) => {
      const mountedPolicy = (policy ?? DEFAULT_ACTION_POLICY) as ActionPolicy;
      const integration = assertAuthenticatedStardewConnection(connection);
      // Executable tools require the launcher-owned liveness fence. A missing
      // or revoked gate is never a legacy admission path; observations remain
      // available because they do not dispatch gameplay operations.
      const executable = connection.executionGate?.executable === true;
      const knowledge =
        isKnowledgeBundle(mountedKnowledge) && mountedGameVersion !== undefined
          ? createStardewKnowledgeTools(
              {
                ...integration,
                knowledge: mountedKnowledge,
                gameVersion: mountedGameVersion,
              },
              mountedPolicy,
            )
          : ([] as const);
      return Object.freeze({
        observation: createStardewObservationTools(integration, mountedPolicy),
        actions:
          !executable || dispatchAdmissionFactory === undefined
            ? []
            : createStardewActionTools(integration, mountedPolicy, dispatchAdmissionFactory),
        knowledge,
      });
    },
    knowledgeMetadata: ({ knowledge, gameVersion }) => ({
      mounted: isKnowledgeBundle(knowledge),
      gameVersion: gameVersion ?? null,
      bundleVersion: isKnowledgeBundle(knowledge) ? knowledge.bundleVersion : null,
    }),
    status: (connection): IntegrationStatusDetails => {
      const state = assertAuthenticatedStardewConnection(connection).state;
      return {
        connected: state.connected,
        capabilities: [...state.capabilities],
        snapshotRevision: state.snapshot?.revision ?? null,
        latestReceiptState: state.latestReceipt?.state ?? null,
        latestReasonCode: state.latestReasonCode,
      };
    },
    readState: (connection): IntegrationStateView => {
      const integration = assertAuthenticatedStardewConnection(connection);
      const state = integration.state;
      return {
        connected: state.connected,
        sessionId: state.sessionId,
        capabilities: [...state.capabilities],
        ...(state.enabledActionIds === undefined ? {} : { enabledActionIds: [...state.enabledActionIds] }),
        catalogRevision: state.catalogRevision ?? null,
        capabilityRevision: state.policyIdentity?.capabilityRevision ?? null,
        policyIdentity: state.policyIdentity ?? null,
        registrations: [...(state.catalogRegistrations ?? [])],
        snapshotRevision: state.snapshot?.revision ?? null,
        activeExecution:
          state.snapshot?.activeExecution === null || state.snapshot?.activeExecution === undefined
            ? null
            : {
                actionId: state.snapshot.activeExecution.action,
                requestId: state.snapshot.activeExecution.requestId,
                executionId: state.snapshot.activeExecution.executionId,
                state: state.snapshot.activeExecution.state,
              },
        latestReceipt: state.latestReceipt === null ? null : toIntegrationReceipt(state.latestReceipt),
        latestReasonCode: state.latestReasonCode,
      };
    },
    cancelExecution: (connection, requestId, executionId, reasonCode) => {
      const integration = assertAuthenticatedStardewConnection(connection);
      if (typeof integration.cancel !== "function") return "integration_cancel_unavailable";
      return integration.cancel(requestId, executionId, reasonCode);
    },
    parseReceipt: (details: unknown) => parseStardewReceipt(details),
    actionIdForToolName: (toolName: string) => {
      if (!toolName.startsWith("stardew_")) return null;
      const actionId = toolName.slice("stardew_".length);
      return actionCatalog.hasAdapter(actionId) ? actionId : null;
    },
    isCancellationTool: () => false,
  });
}

export const STARDEW_GAME_INTEGRATION_ADAPTER = createStardewGameIntegrationAdapter();

export function hasStardewCompletionEvidence(actionId: string, receipt: IntegrationReceiptEvidence): boolean {
  const rawDetail = receipt.evidence?.detail;
  if (
    receipt.state !== "succeeded" ||
    typeof rawDetail !== "string" ||
    rawDetail.length === 0 ||
    rawDetail.length > 4_096
  )
    return false;
  // The guard above narrows `rawDetail` to string in FUNCTION scope, but type narrowing does not travel across a
  // `switch` boundary into each case, so a plain alias would re-resolve to `unknown` at every `exactEvidence(detail,`
  // call. Give the narrowed value a name that is visibly a string - once, for every case that follows.
  const detail: string = rawDetail;
  // Each published action is explicit. Unsupported schemas fail closed rather
  // than treating a succeeded receipt or a matching substring as completion.
  switch (actionId) {
    case "place_owned_object":
      // Evidence literal: farmhandexecutioncontroller.worldobjectactions.cs ExecutePlaceOwnedObject —
      // target;location;tile;slot;item;terrain_feature;terrain_feature_tapped;native_placement;
      // object_present;placed_qualified_item_id;placed_type;inventory_before;inventory_after.
      // The native branch adds a COPY, so nothing may be decided from a reference; the proof is the
      // object being present on the tile afterwards plus the inventory count dropping by one.
      return (
        receipt.reasonCode === "owned_object_placed" &&
        exactEvidence(
          detail,
          [
            "target",
            "location",
            "tile",
            "slot",
            "item",
            "terrain_feature",
            "terrain_feature_tapped",
            "native_placement",
            "object_present",
            "placed_qualified_item_id",
            "placed_type",
            "inventory_before",
            "inventory_after",
          ],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            e.native_placement === "true" &&
            e.object_present === "true" &&
            e.placed_qualified_item_id === e.item &&
            e.inventory_after !== e.inventory_before &&
            Number.isSafeInteger(Number(e.inventory_before)) &&
            Number.isSafeInteger(Number(e.inventory_after)) &&
            Number(e.inventory_after) === Number(e.inventory_before) - 1,
        )
      );
    case "remove_placed_item":
      // Evidence literal: ExecuteRemovePlacedItem — target;location;tile;item;type;tool;tool_kind;
      // slot;swings;removed;tile_object_after;drops;drop_count;stamina_before;stamina_after.
      // The removal is proved by the tile being empty afterwards, never by a native return value.
      return (
        receipt.reasonCode === "placed_item_removed" &&
        exactEvidence(
          detail,
          [
            "target",
            "location",
            "tile",
            "item",
            "type",
            "tool",
            "tool_kind",
            "slot",
            "swings",
            "removed",
            "tile_object_after",
            "drops",
            "drop_count",
            "stamina_before",
            "stamina_after",
          ],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            e.removed === "true" &&
            e.tile_object_after === "none" &&
            (e.tool_kind === "axe" || e.tool_kind === "pickaxe") &&
            Number.isSafeInteger(Number(e.swings)) &&
            Number(e.swings) >= 1 &&
            Number(e.drop_count) === (e.drops === undefined || e.drops.length === 0 ? 0 : e.drops.split("|").length),
        )
      );
    case "break_container_source":
      // Evidence literal: ExecuteBreakContainerSource — target;location;tile;item;type;tool;slot;
      // swings;container_gone;tile_object_after;drops;drop_count;stamina_before;stamina_after.
      // The seam returns false even when it destroys the container, so the ONLY proof is the
      // container being gone plus the drops the game added during the swing window.
      return (
        receipt.reasonCode === "container_source_broken" &&
        exactEvidence(
          detail,
          [
            "target",
            "location",
            "tile",
            "item",
            "type",
            "tool",
            "slot",
            "swings",
            "container_gone",
            "tile_object_after",
            "drops",
            "drop_count",
            "stamina_before",
            "stamina_after",
          ],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            e.container_gone === "true" &&
            e.tile_object_after === "none" &&
            Number.isSafeInteger(Number(e.swings)) &&
            Number(e.swings) >= 1 &&
            Number(e.drop_count) === (e.drops === undefined || e.drops.length === 0 ? 0 : e.drops.split("|").length),
        )
      );
    case "equip_tool":
      // The frozen contract is ["tool_equipped","already_equipped"]
      // (farmhandactiondevelopmentcontract.cs:74) and the Mod emits exactly those
      // (farmhandexecutioncontroller.resourcetoolactions.cs:434/444). This branch
      // previously required "tool_selected" and a "slot" evidence key, neither of
      // which exists on the production path, so equip_tool could never be judged
      // complete — and the fixtures were built from the same stale literals, which is
      // why every test stayed green. equip_tool/v2 deliberately made slot Mod-private
      // and reports the resolved tool instead.
      //
      // "already_equipped" is the code for the no-change case, and "tool_equipped" is the code for a real switch -
      // so the terminal code and the observed change must AGREE. Accepting `tool_equipped` with `before == expected`
      // (which the first version of this rule did, via the shared clauses) turned "nothing happened" into a
      // completion, which is the worse half of the trade the coverage work was fixing: a permissive rule is worse
      // than a missing one, because a silent drop becomes a wrong success.
      return (
        (receipt.reasonCode === "tool_equipped" || receipt.reasonCode === "already_equipped") &&
        exactEvidence(
          detail,
          ["tool", "before", "expected", "after"],
          (e) =>
            hasOpaqueEvidenceValue(e.tool) &&
            isToolSelectionBeforeValue(e.before) &&
            hasOpaqueEvidenceValue(e.expected) &&
            e.after === e.expected &&
            (receipt.reasonCode === "tool_equipped" ? e.before !== e.expected : e.before === e.expected),
        )
      );
    case "send_multiplayer_chat":
      // Evidence literal: farmhandexecutioncontroller.chatactions.cs — recipient;length;role;sent. The
      // receipt proves the SEND and nothing more, so the rule asks for exactly that: the terminal code, the
      // four keys, `sent=true`, a real role, and a positive length. It deliberately requires NO receiving-side
      // fact, because the Mod cannot observe one (the chat box may not exist on a client at all).
      return (
        receipt.reasonCode === "chat_message_sent" &&
        exactEvidence(detail, ["recipient", "length", "role", "sent"], (e) => {
          const length = integerEvidenceValue(e.length);
          return (
            e.sent === "true" &&
            e.recipient === "all_players" &&
            (e.role === "client" || e.role === "server") &&
            length !== null &&
            length > 0
          );
        })
      );
    case "clear_fish_pond":
      // Evidence literal: farmhandexecutioncontroller.pondactions.cs — the identity, the fish type before and
      // after, the occupant counts, the population gate, the spawn day, the golden-cracker flag and the
      // ejected count. The native seam returns void, so the proof is the OBSERVED reset: BOTH halves of the
      // card's postcondition (occupants 0 AND fish type none), an ejected count equal to what the pond held,
      // and a pond that held something to begin with. The fish are dropped rather than destroyed, so nothing
      // here claims a loss.
      return (
        receipt.reasonCode === "fish_pond_cleared" &&
        exactEvidence(
          detail,
          [
            "pond_id",
            "location",
            "tile_x",
            "tile_y",
            "building_origin",
            "fish_type_before",
            "fish_type_after",
            "occupants_before",
            "occupants_after",
            "population_gate_before",
            "population_gate_after",
            "days_since_spawn_before",
            "days_since_spawn_after",
            "golden_cracker_before",
            "golden_cracker_after",
            "fish_ejected",
          ],
          (e) => {
            const occupantsBefore = integerEvidenceValue(e.occupants_before);
            return (
              occupantsBefore !== null &&
              occupantsBefore > 0 &&
              e.occupants_after === "0" &&
              e.fish_type_after === "none" &&
              integerEvidenceValue(e.fish_ejected) === occupantsBefore &&
              integerEvidenceValue(e.population_gate_after) === 0
            );
          },
        )
      );
    case "build_farm_building":
      // Evidence literal: farmhandexecutioncontroller.buildfarmbuildingactions.cs - the site identity, the
      // building type, the new building id, the money and materials before/after, and the tile's building
      // afterwards. The commission is the observable change, so the rule demands all three halves: money fell
      // by exactly the declared cost, the declared materials were consumed, and the tile now holds the type
      // that was commissioned. A receipt that merely says it called the settlement cannot satisfy those.
      return (
        receipt.reasonCode === "farm_building_built" &&
        exactEvidence(
          detail,
          [
            "target",
            "location",
            "tile",
            "building_type",
            "building_id",
            "money_before",
            "money_after",
            "build_cost",
            "materials_before",
            "materials_after",
            "materials_required",
            "build_days",
            "days_of_construction_left",
            "magical",
            "tile_building_after",
            "native_placement",
          ],
          (e) => {
            const before = integerEvidenceValue(e.money_before);
            const after = integerEvidenceValue(e.money_after);
            const cost = integerEvidenceValue(e.build_cost);
            const materialsBefore = integerEvidenceValue(e.materials_before);
            const materialsAfter = integerEvidenceValue(e.materials_after);
            const materialsRequired = integerEvidenceValue(e.materials_required);
            return (
              before !== null &&
              after !== null &&
              cost !== null &&
              cost > 0 &&
              before - after === cost &&
              materialsBefore !== null &&
              materialsAfter !== null &&
              materialsRequired !== null &&
              materialsRequired > 0 &&
              materialsBefore - materialsAfter === materialsRequired &&
              typeof e.building_id === "string" &&
              e.building_id.length > 0 &&
              typeof e.building_type === "string" &&
              e.building_type.length > 0 &&
              e.tile_building_after === e.building_type
            );
          },
        )
      );
    case "accept_daily_quest":
      // Evidence literal: farmhandexecutioncontroller.questactions.cs - the quest id and type, the day, and the
      // quest-log and day-flag counts before and after. The accept writes the quest log AND the day flag, so the
      // rule requires both: the log grew by exactly one entry and both flags now read true. The target id is
      // required non-empty because the receipt must name WHICH quest was accepted.
      return (
        receipt.reasonCode === "daily_quest_accepted" &&
        exactEvidence(
          detail,
          [
            "daily_quest_id",
            "day_of_month",
            "quest_type",
            "accepted_before",
            "accepted_daily_before",
            "days_left_before",
            "quest_log_before",
            "quest_log_after",
            "days_left_after",
            "accepted_after",
            "accepted_daily_after",
            "daily_after",
            "can_be_cancelled_after",
            "day_accepted_after",
          ],
          (e) => {
            const logBefore = integerEvidenceValue(e.quest_log_before);
            const logAfter = integerEvidenceValue(e.quest_log_after);
            return (
              typeof e.daily_quest_id === "string" &&
              e.daily_quest_id.length > 0 &&
              logBefore !== null &&
              logAfter !== null &&
              logAfter - logBefore === 1 &&
              e.accepted_after === "true" &&
              e.accepted_daily_after === "true" &&
              e.accepted_before === "false"
            );
          },
        )
      );
    case "tailor_clothing":
      // Evidence literal: farmhandexecutioncontroller.tailoringactions.cs - the opaque pair identity, both
      // backpack slots, the two item ids, the produced item id, both item counts before/after, whether the
      // right spot was spent, the output count before/after, and the delivered/dropped disposition. The
      // native `CraftItem` settlement builds the garment AND the menu's own completion consumes the
      // reagents, so the rule requires both halves: the left reagent fell by exactly one (and the right one
      // when the recipe spends it) and the produced stack reached the world (backpack plus ground drop).
      return (
        receipt.reasonCode === "clothing_tailored" &&
        exactEvidence(
          detail,
          [
            "target",
            "left_slot",
            "right_slot",
            "location",
            "left",
            "right",
            "output",
            "left_before",
            "left_after",
            "right_before",
            "right_after",
            "right_spent",
            "output_before",
            "output_after",
            "delivered",
            "dropped",
            "disposition",
            "dropped_debris",
          ],
          (e) => {
            const leftBefore = integerEvidenceValue(e.left_before);
            const leftAfter = integerEvidenceValue(e.left_after);
            const rightBefore = integerEvidenceValue(e.right_before);
            const rightAfter = integerEvidenceValue(e.right_after);
            const outputBefore = integerEvidenceValue(e.output_before);
            const outputAfter = integerEvidenceValue(e.output_after);
            const delivered = integerEvidenceValue(e.delivered);
            const dropped = integerEvidenceValue(e.dropped);
            const rightSpent = e.right_spent === "true";
            return (
              hasOpaqueIdEvidenceValue(e.target) &&
              hasOpaqueEvidenceValue(e.left) &&
              hasOpaqueEvidenceValue(e.right) &&
              hasOpaqueEvidenceValue(e.output) &&
              leftBefore !== null &&
              leftAfter !== null &&
              leftAfter === leftBefore - 1 &&
              rightBefore !== null &&
              rightAfter !== null &&
              rightAfter === (rightSpent ? rightBefore - 1 : rightBefore) &&
              outputBefore !== null &&
              outputAfter !== null &&
              delivered !== null &&
              dropped !== null &&
              dropped >= 0 &&
              // The garment must exist SOMEWHERE (backpack or ground), and the backpack must have grown by
              // exactly what the receipt says it delivered.
              delivered + dropped >= 1 &&
              outputAfter === outputBefore + delivered &&
              // ...and the receipt's own disposition must agree with its split. This is what makes a fully
              // dropped garment acceptable (an honest outcome `delivered >= 1` used to refuse) while still
              // failing a receipt that contradicts itself.
              integerEvidenceValue(e.dropped_debris) === dropped &&
              ((e.disposition === "inventory" && dropped === 0 && delivered >= 1) ||
                (e.disposition === "dropped_on_ground" && delivered === 0 && dropped >= 1) ||
                (e.disposition === "partially_dropped" && delivered >= 1 && dropped >= 1))
            );
          },
        )
      );
    case "color_placed_object":
      // Evidence literal: farmhandexecutioncontroller.colorobjectactions.cs - the opaque target id, the
      // tile, the location, the palette index and the colour before/after read off the chest instance.
      // The game has no callable settlement for this write, so the proof is the OBSERVED change: the
      // colour must equal the palette colour for the named index AND differ from the recorded before
      // value. A repaint to the colour it already carried is `color_already_set`, never a success.
      return (
        receipt.reasonCode === "placed_object_recolored" &&
        exactEvidence(
          detail,
          ["target", "tile", "location", "color_selection", "color_before", "color_after", "color_changed"],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            hasBoundedNonemptyEvidenceValue(e.tile) &&
            hasBoundedNonemptyEvidenceValue(e.location) &&
            integerEvidenceValue(e.color_selection) !== null &&
            hasBoundedNonemptyEvidenceValue(e.color_before) &&
            hasBoundedNonemptyEvidenceValue(e.color_after) &&
            e.color_changed === "true" &&
            e.color_after !== e.color_before,
        )
      );
    case "dye_clothing_with_item":
      // Evidence literal: farmhandexecutioncontroller.tailoringactions.cs - the opaque pair identity, the
      // garment and dye slots, the two item ids, the colour before/expected/after, the strength and its
      // source, whether the colour moved, the prismatic flag after, the dye counts before/after and which
      // spot was spent. `DyeItems` is a no-op on a garment it cannot recolour, so the rule requires the
      // colour to have SETTLED (moved when the dye carries a different colour, stayed when it carries the
      // same one) and the dye to have been consumed as the native spend rule says.
      return (
        receipt.reasonCode === "clothing_dyed" &&
        exactEvidence(
          detail,
          [
            "target",
            "garment_slot",
            "dye_slot",
            "location",
            "garment",
            "dye",
            "colour_before",
            "colour_expected",
            "colour_after",
            "strength",
            "strength_source",
            "colour_changed",
            "prismatic_after",
            "dye_before",
            "dye_after",
            "dye_spent",
            "colour_route",
          ],
          (e) => {
            const dyeBefore = integerEvidenceValue(e.dye_before);
            const dyeAfter = integerEvidenceValue(e.dye_after);
            const dyeSpent = e.dye_spent === "true";
            const changed = e.colour_before !== e.colour_after;
            return (
              hasOpaqueIdEvidenceValue(e.target) &&
              hasOpaqueEvidenceValue(e.garment) &&
              hasOpaqueEvidenceValue(e.dye) &&
              (e.colour_before?.length ?? 0) > 0 &&
              (e.colour_expected?.length ?? 0) > 0 &&
              (e.colour_after?.length ?? 0) > 0 &&
              e.colour_changed === String(changed) &&
              (e.prismatic_after === "true" || e.prismatic_after === "false") &&
              dyeBefore !== null &&
              dyeAfter !== null &&
              dyeAfter === (dyeSpent ? dyeBefore - 1 : dyeBefore) &&
              e.colour_route === "TailoringMenu.GetDyeColor"
            );
          },
        )
      );
    case "accept_special_order":
      // Evidence literal: farmhandexecutioncontroller.specialorders.cs - the opaque target, the board type,
      // the order key and seed, the board marker before and after, the team order-list length before and
      // after, and the two facts read back off the added order. The accept is the board's own two writes, so
      // the rule requires both halves: the list grew by exactly one, the order is present and InProgress, and
      // the board marker flipped from unset to set.
      return (
        receipt.reasonCode === "special_order_accepted" &&
        exactEvidence(
          detail,
          [
            "special_order_id",
            "board_type",
            "quest_key",
            "generation_seed",
            "board_marker_before",
            "board_marker_after",
            "orders_before",
            "orders_after",
            "order_present_after",
            "order_in_progress_after",
          ],
          (e) => {
            const before = integerEvidenceValue(e.orders_before);
            const after = integerEvidenceValue(e.orders_after);
            const seed = integerEvidenceValue(e.generation_seed);
            return (
              hasOpaqueIdEvidenceValue(e.special_order_id) &&
              (e.board_type === "none" || e.board_type === "" ? true : hasBoundedNonemptyEvidenceValue(e.board_type)) &&
              hasBoundedNonemptyEvidenceValue(e.quest_key) &&
              seed !== null &&
              e.board_marker_before === "false" &&
              e.board_marker_after === "true" &&
              before !== null &&
              after !== null &&
              after - before === 1 &&
              e.order_present_after === "true" &&
              e.order_in_progress_after === "true"
            );
          },
        )
      );
    case "claim_museum_reward":
      // Evidence literal: farmhandexecutioncontroller.museumrewards.cs - the opaque target, the museum
      // location, the reward counts before/returned/delivered/recorded/after, the mail-flag counts, and the
      // inventory units. `rewards_collected` is the body's own verdict, so the rule re-derives it: the
      // published set was non-empty, the enumeration returned exactly that many, every one was delivered AND
      // recorded, and a fresh read found nothing left.
      return (
        receipt.reasonCode === "museum_rewards_collected" &&
        exactEvidence(
          detail,
          [
            "target",
            "location",
            "rewards_before",
            "rewards_returned",
            "rewards_delivered",
            "rewards_recorded",
            "rewards_after",
            "mail_flags_before",
            "mail_flags_after",
            "inventory_units_before",
            "inventory_units_after",
            "rewards_collected",
          ],
          (e) => {
            const before = integerEvidenceValue(e.rewards_before);
            const returned = integerEvidenceValue(e.rewards_returned);
            const delivered = integerEvidenceValue(e.rewards_delivered);
            const recorded = integerEvidenceValue(e.rewards_recorded);
            const after = integerEvidenceValue(e.rewards_after);
            const mailBefore = integerEvidenceValue(e.mail_flags_before);
            const mailAfter = integerEvidenceValue(e.mail_flags_after);
            return (
              hasOpaqueIdEvidenceValue(e.target) &&
              hasBoundedNonemptyEvidenceValue(e.location) &&
              before !== null &&
              before >= 1 &&
              returned !== null &&
              returned === before &&
              delivered !== null &&
              delivered === returned &&
              recorded !== null &&
              recorded === returned &&
              after === 0 &&
              mailBefore !== null &&
              mailAfter !== null &&
              mailAfter > mailBefore &&
              integerEvidenceValue(e.inventory_units_before) !== null &&
              integerEvidenceValue(e.inventory_units_after) !== null &&
              e.rewards_collected === "true"
            );
          },
        )
      );
    case "redeem_prize_ticket":
      // Evidence literal: farmhandexecutioncontroller.prizeticketactions.cs ExecuteRedeemPrizeTicket -
      // prize_level;prize_item_id;prize_stack;prize_held_before;prize_held_after;ticket_item_id;
      // tickets_before;tickets_after;prizes_claimed_before;prizes_claimed_after;prize_delivered.
      // The exchange is BOTH halves, so the rule demands both: the ticket stack fell by exactly one from
      // a stack that held one, the pack holds exactly the delivered prize stack more than it did, and the
      // machine's own stat advanced by one. The level the receipt names must be the stat it read, so a
      // receipt cannot report a prize its own level does not produce.
      return (
        receipt.reasonCode === "prize_ticket_redeemed" &&
        exactEvidence(
          detail,
          [
            "prize_level",
            "prize_item_id",
            "prize_stack",
            "prize_held_before",
            "prize_held_after",
            "ticket_item_id",
            "tickets_before",
            "tickets_after",
            "prizes_claimed_before",
            "prizes_claimed_after",
            "prize_delivered",
          ],
          (e) => {
            const ticketsBefore = integerEvidenceValue(e.tickets_before);
            const ticketsAfter = integerEvidenceValue(e.tickets_after);
            const heldBefore = integerEvidenceValue(e.prize_held_before);
            const heldAfter = integerEvidenceValue(e.prize_held_after);
            const claimedBefore = integerEvidenceValue(e.prizes_claimed_before);
            const claimedAfter = integerEvidenceValue(e.prizes_claimed_after);
            const stack = integerEvidenceValue(e.prize_stack);
            return (
              ticketsBefore !== null &&
              ticketsBefore >= 1 &&
              ticketsAfter !== null &&
              ticketsAfter === ticketsBefore - 1 &&
              claimedBefore !== null &&
              claimedAfter !== null &&
              claimedAfter === claimedBefore + 1 &&
              stack !== null &&
              stack >= 1 &&
              heldBefore === 0 &&
              heldAfter !== null &&
              heldAfter === heldBefore + stack &&
              e.prize_delivered === "true" &&
              typeof e.prize_item_id === "string" &&
              e.prize_item_id.length > 0 &&
              typeof e.ticket_item_id === "string" &&
              e.ticket_item_id.length > 0 &&
              integerEvidenceValue(e.prize_level) === claimedBefore
            );
          },
        )
      );
    case "name_entity":
      // Evidence literal: farmhandexecutioncontroller.nameentityactions.cs - the subject, the horse
      // id, the requested name, the name read back and the Mod's own read-back verdict. The
      // entity's stored name IS the terminal, so the rule asks for exactly that: the terminal code,
      // the twelve keys, an entity that was unnamed before the call, and a read-back that matched.
      return (
        receipt.reasonCode === "entity_named" &&
        exactEvidence(
          detail,
          [
            "owner_id",
            "location",
            "actor_tile",
            "horse_tile",
            "horse_owner_id",
            "horse_name",
            "horse_id",
            "name_before",
            "requested",
            "name_after",
            "name_matches_requested",
            "player_horse_name_updated",
          ],
          (e) =>
            typeof e.name_before === "string" &&
            e.name_before === "none" &&
            typeof e.name_matches_requested === "string" &&
            e.name_matches_requested === "true" &&
            typeof e.name_after === "string" &&
            e.name_after.length > 0 &&
            typeof e.requested === "string" &&
            e.name_after === e.requested,
        )
      );

    case "toggle_animal_door":
      // Evidence literal: farmhandexecutioncontroller.animaldooractions.cs:194-197 —
      // target;tile;building_type;animal_door_open_before;animal_door_open_after;
      // animal_door_open_changed;animal_door_amount_before;animal_door_amount_after.
      // The native seam returns void, so the ONLY proof the door moved is the observed flip; the
      // rule therefore requires the before/after pair AND the derived flag to agree.
      return (
        receipt.reasonCode === "animal_door_toggled" &&
        exactEvidence(
          detail,
          [
            "target",
            "tile",
            "building_type",
            "animal_door_open_before",
            "animal_door_open_after",
            "animal_door_open_changed",
            "animal_door_amount_before",
            "animal_door_amount_after",
          ],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            (e.animal_door_open_before === "true" || e.animal_door_open_before === "false") &&
            (e.animal_door_open_after === "true" || e.animal_door_open_after === "false") &&
            e.animal_door_open_before !== e.animal_door_open_after &&
            e.animal_door_open_changed === "true",
        )
      );
    case "withdraw_silo_hay":
      // Evidence literal: farmhandexecutioncontroller.silohaywithdrawactions.cs:96 —
      // target;item;silo_hay_before;silo_hay_after;silo_hay_decreased;carried_before;
      // carried_after;carried_hay_increased;inventory_inserted.
      // The transfer is two-sided, so the rule requires BOTH halves to be visible in the receipt and
      // not merely implied by the terminal code.
      return (
        receipt.reasonCode === "silo_hay_taken" &&
        exactEvidence(
          detail,
          [
            "target",
            "item",
            "silo_hay_before",
            "silo_hay_after",
            "silo_hay_decreased",
            "carried_before",
            "carried_after",
            "carried_hay_increased",
            "inventory_inserted",
          ],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            e.item === "(O)178" &&
            decremented(e.silo_hay_before, e.silo_hay_after) &&
            e.silo_hay_decreased === "true" &&
            incremented(e.carried_before, e.carried_after) &&
            e.carried_hay_increased === "true" &&
            e.inventory_inserted === "true",
        )
      );
    case "use_obelisk":
      // The arrival is minted by the shared travel path (movementactions.cs), whose evidence is the
      // expected/actual destination pair. The tile is deliberately absent: the native layout chooses
      // the landing tile, so only the location can be asserted — the same rule the sibling
      // enter_mine / select_mine_elevator_floor terminals use.
      return (
        receipt.reasonCode === "obelisk_arrived" &&
        exactEvidence(
          detail,
          ["expected", "actual"],
          (e) =>
            hasOpaqueEvidenceValue(e.expected) &&
            hasOpaqueEvidenceValue(e.actual) &&
            e.expected.split(":")[0] === e.actual.split(":")[0],
        )
      );
    case "load_building_chest":
      // Evidence literal: farmhandexecutioncontroller.buildingchestactions.cs — the chest identity
      // prefix (tile;location;target;building_type;building_origin;chest_id;branch) plus item;
      // held_stack_before;held_stack_after;chest_item_before;chest_item_after;chest_slots_before;
      // chest_slots_after;moved_count;released_count;required_count;chest_capacity_before;
      // item_accepted;native_accepted;native_refusal;native_menu_opened.
      //
      // The native branch returns a bool, so the bool is NOT the proof: the rule requires BOTH
      // observed halves of the quantised transfer (the chest gained exactly as many of the named
      // item as the held stack lost) and that the amount is a whole number of the conversion's
      // `required_count` quanta. `native_refusal` names which native data field's gate the
      // refusal belonged to; on a success it must be `none`.
      return (
        receipt.reasonCode === "building_chest_loaded" &&
        exactEvidence(
          detail,
          [
            "tile",
            "location",
            "target",
            "building_type",
            "building_origin",
            "chest_id",
            "branch",
            "item",
            "held_stack_before",
            "held_stack_after",
            "chest_item_before",
            "chest_item_after",
            "chest_slots_before",
            "chest_slots_after",
            "moved_count",
            "released_count",
            "required_count",
            "chest_capacity_before",
            "item_accepted",
            "native_accepted",
            "native_refusal",
            "native_menu_opened",
          ],
          (e) => {
            const heldBefore = integerEvidenceValue(e.held_stack_before);
            const heldAfter = integerEvidenceValue(e.held_stack_after);
            const chestBefore = integerEvidenceValue(e.chest_item_before);
            const chestAfter = integerEvidenceValue(e.chest_item_after);
            const moved = integerEvidenceValue(e.moved_count);
            const released = integerEvidenceValue(e.released_count);
            const required = positiveIntegerEvidence(e.required_count);
            return (
              hasTileEvidenceValue(e.tile) &&
              hasOpaqueIdEvidenceValue(e.target) &&
              e.branch === "load" &&
              hasOpaqueEvidenceValue(e.item) &&
              heldBefore !== null &&
              heldAfter !== null &&
              chestBefore !== null &&
              chestAfter !== null &&
              moved !== null &&
              moved > 0 &&
              released === moved &&
              heldBefore - heldAfter === moved &&
              chestAfter - chestBefore === moved &&
              required !== null &&
              moved % required === 0 &&
              integerEvidenceValue(e.chest_capacity_before) !== null &&
              e.item_accepted === "true" &&
              e.native_accepted === "true" &&
              e.native_refusal === "none" &&
              e.native_menu_opened === "false"
            );
          },
        )
      );
    case "collect_building_chest_output":
      // Evidence literal: farmhandexecutioncontroller.buildingchestactions.cs — the same chest
      // identity prefix plus item;chest_slots_before;chest_slots_after;chest_item_before;
      // chest_item_after;moved_count;carried_before;carried_after;native_accepted;
      // native_menu_opened.
      //
      // Collect auto-collects only a SINGLE stack, so a success must show the named stack leaving
      // the chest (its count and the chest's slot count both fell) AND the actor's inventory
      // gaining exactly that many of the same item; `native_menu_opened` must be false because the
      // >= 2-stack case is refused by name rather than handed to a container menu.
      return (
        receipt.reasonCode === "building_chest_output_collected" &&
        exactEvidence(
          detail,
          [
            "tile",
            "location",
            "target",
            "building_type",
            "building_origin",
            "chest_id",
            "branch",
            "item",
            "chest_slots_before",
            "chest_slots_after",
            "chest_item_before",
            "chest_item_after",
            "moved_count",
            "carried_before",
            "carried_after",
            "native_accepted",
            "native_menu_opened",
          ],
          (e) => {
            const slotsBefore = integerEvidenceValue(e.chest_slots_before);
            const slotsAfter = integerEvidenceValue(e.chest_slots_after);
            const chestBefore = integerEvidenceValue(e.chest_item_before);
            const chestAfter = integerEvidenceValue(e.chest_item_after);
            const moved = integerEvidenceValue(e.moved_count);
            const carriedBefore = integerEvidenceValue(e.carried_before);
            const carriedAfter = integerEvidenceValue(e.carried_after);
            return (
              hasTileEvidenceValue(e.tile) &&
              hasOpaqueIdEvidenceValue(e.target) &&
              e.branch === "collect" &&
              hasOpaqueEvidenceValue(e.item) &&
              slotsBefore !== null &&
              slotsAfter !== null &&
              chestBefore !== null &&
              chestAfter !== null &&
              moved !== null &&
              carriedBefore !== null &&
              carriedAfter !== null &&
              moved > 0 &&
              chestBefore - chestAfter === moved &&
              slotsAfter < slotsBefore &&
              carriedAfter - carriedBefore === moved &&
              e.native_accepted === "true" &&
              e.native_menu_opened === "false"
            );
          },
        )
      );
    case "till_soil":
      return receipt.reasonCode === "soil_tilled" && hasTillSoilCompletionEvidence(detail);
    case "water_crop":
      return receipt.reasonCode === "crop_watered" && hasWaterCropCompletionEvidence(detail);
    case "refill_watering_can":
      return receipt.reasonCode === "watering_can_refilled" && hasRefillWateringCanCompletionEvidence(detail);
    case "dig_artifact_spot":
      return receipt.reasonCode === "artifact_spot_dug" && hasDigArtifactSpotCompletionEvidence(detail);
    case "break_rock_source":
      return receipt.reasonCode === "rock_source_broken" && hasBreakRockSourceCompletionEvidence(detail);
    case "clear_hoedirt":
      return receipt.reasonCode === "hoedirt_cleared" && hasClearHoeDirtCompletionEvidence(detail);
    case "chop_tree_source":
      return receipt.reasonCode === "tree_source_chopped" && hasChopTreeSourceCompletionEvidence(detail);
    case "place_wood_fence":
      return receipt.reasonCode === "wood_fence_placed" && hasWoodFenceCompletionEvidence(detail);
    case "bait_crab_pot":
      return receipt.reasonCode === "crab_pot_baited" && hasBaitCrabPotCompletionEvidence(detail);
    case "plant_seed":
      return (
        receipt.reasonCode === "seed_planted" &&
        exactEvidence(
          detail,
          ["location", "target", "tile", "item", "crop", "inventory_before", "inventory_after"],
          (e) =>
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            hasOpaqueEvidenceValue(e.item) &&
            hasOpaqueEvidenceValue(e.crop) &&
            decremented(e.inventory_before, e.inventory_after),
        )
      );
    case "move_to_tile":
      return receipt.reasonCode === "target_reached" && hasMoveToTileCompletionEvidence(detail);
    case "travel":
      return receipt.reasonCode === "travel_completed" && hasDoorTransitionCompletionEvidence(detail);
    case "ride_minecart":
      return receipt.reasonCode === "minecart_ride_completed" && hasMinecartRideCompletionEvidence(detail);
    case "enter_exit":
      return receipt.reasonCode === "enter_exit_completed" && hasDoorTransitionCompletionEvidence(detail);
    case "navigate_to_destination":
      return receipt.reasonCode === "navigation_completed" && hasNavigationCompletionEvidence(detail);
    case "pickup_forage":
      return receipt.reasonCode === "forage_picked_up" && hasPickupForageCompletionEvidence(detail);
    case "pickup_item":
      return receipt.reasonCode === "item_picked_up" && hasPickupItemCompletionEvidence(detail);
    case "fertilize_tile":
      return receipt.reasonCode === "fertilizer_applied" && hasFertilizeTileCompletionEvidence(detail);
    case "place_crab_pot":
      return receipt.reasonCode === "crab_pot_placed" && hasPlaceCrabPotCompletionEvidence(detail);
    case "machine_inspect":
      return receipt.reasonCode === "machine_inspected" && hasMachineInspectCompletionEvidence(detail);
    case "machine_load":
      return receipt.reasonCode === "machine_coffee_loaded" && hasMachineLoadCompletionEvidence(detail);
    case "machine_collect_output":
      return receipt.reasonCode === "machine_coffee_collected" && hasMachineCollectOutputCompletionEvidence(detail);
    case "collect_animal_product":
      return receipt.reasonCode === "animal_product_collected" && hasCollectAnimalProductCompletionEvidence(detail);
    case "feed_animal":
      return receipt.reasonCode === "hay_placed_in_trough" && hasFeedAnimalCompletionEvidence(detail);
    case "talk_to_npc":
      // Evidence literal: farmhandexecutioncontroller.npcactions.cs - location;target;npc;tile;
      // native_handled;dialogue_up_before;dialogue_up_after;dialogue_box_after;menu_open_after;
      // talked_to_today_before;talked_to_today_after;points_before;points_after;player_can_move_after.
      // The seam returns bool, so the raw handled flag proves nothing on its own: the rule also
      // requires the dialogue to have come UP - that is the world change - and it reports that the
      // actor is left NOT movable, which is the native end state rather than a hidden failure.
      return (
        receipt.reasonCode === "talk_to_npc_talked" &&
        exactEvidence(
          detail,
          [
            "location",
            "target",
            "npc",
            "tile",
            "native_handled",
            "dialogue_up_before",
            "dialogue_up_after",
            "dialogue_box_after",
            "menu_open_after",
            "talked_to_today_before",
            "talked_to_today_after",
            "points_before",
            "points_after",
            "player_can_move_after",
          ],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            e.native_handled === "true" &&
            e.dialogue_up_before === "false" &&
            e.dialogue_up_after === "true" &&
            e.dialogue_box_after === "true",
        )
      );
    case "use_item":
      return receipt.reasonCode === "item_used" && hasUseItemCompletionEvidence(detail);
    case "harvest_crop":
      return receipt.reasonCode === "crop_harvested" && hasHarvestCropCompletionEvidence(detail);
    // ── The rest of the registered action surface (card CARD-P4-9-COMPLETION-EVIDENCE).
    // Every rule below is transcribed from the Mod site named in its comment: the terminal
    // reasonCode that handler mints and the evidence fields it writes on that exact terminal.
    // Where a handler mints the same completion in more than one place, the sites are listed
    // here and the rule admits exactly those shapes. No key, code or relation is invented.
    case "select_mine_elevator_floor":
      // farmhandexecutioncontroller.movementactions.cs:611-617 CompleteTravelAfterWarp:
      //   expected=<location>:<x>,<y>;actual=<location>:<x>,<y>[;level=<mineLevel>]
      // Floor 0 targets the mine-entrance MAP, so `level` is absent there; a generated
      // floor lands in a MineShaft and appends it. The landing TILE is native-chosen.
      return receipt.reasonCode === "mine_elevator_floor_selected" && hasMineElevatorFloorCompletionEvidence(detail);
    case "ride_bus":
      // farmhandexecutioncontroller.busactions.cs:200-210 UpdateBusRide. The world owns the
      // departure; this terminal is the arrival it produced, so the two location facts and
      // the fare are the whole contract. `money_after` is read from the actor afterwards and
      // is reported, never asserted (a fare refund/reward may move it either way).
      return (
        receipt.reasonCode === "bus_arrived" &&
        exactEvidence(
          detail,
          ["origin", "destination", "fare", "money_before", "money_after"],
          (e) =>
            hasBoundedNonemptyEvidenceValue(e.origin) &&
            hasBoundedNonemptyEvidenceValue(e.destination) &&
            e.origin !== e.destination &&
            integerEvidenceValue(e.fare) !== null &&
            integerEvidenceValue(e.money_before) !== null &&
            integerEvidenceValue(e.money_after) !== null,
        )
      );
    case "use_raft":
      // farmhandexecutioncontroller.transportactions.cs:267-269: the native Raft.DoFunction
      // returns void, so the only proof the launch started is the rafting flag flipping.
      return (
        receipt.reasonCode === "raft_launched" &&
        exactEvidence(
          detail,
          ["tile", "is_rafting", "stamina_before", "stamina_after"],
          (e) =>
            hasTileEvidenceValue(e.tile) &&
            e.is_rafting === "true" &&
            finiteEvidenceValue(e.stamina_before) !== null &&
            finiteEvidenceValue(e.stamina_after) !== null,
        )
      );
    case "mount_transport":
      // farmhandexecutioncontroller.cs:1498-1502 UpdateActiveMountTransport. The settle reads
      // the rider's own mount (the native mount removes the horse from the location's
      // characters), so `mounted=true;mounting=false` is the producer's own success state.
      return (
        receipt.reasonCode === "horse_mounted" &&
        exactEvidence(
          detail,
          ["target", "horse_id", "mounted", "mounting"],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            hasOpaqueIdEvidenceValue(e.horse_id) &&
            e.mounted === "true" &&
            e.mounting === "false",
        )
      );
    case "enter_mine":
      // Three producers, one meaning (`mine_entered`, the declared/reached level):
      //   farmhandexecutioncontroller.transportactions.cs:194 — ladder descent, synchronous:
      //     level=<level>;tile=<x>,<y>;from_level=<level>
      //   farmhandexecutioncontroller.transportactions.cs:232 — entrance, synchronous:
      //     level=<level>;tile=<x>,<y>
      //   farmhandexecutioncontroller.movementactions.cs:611-617 — the asynchronous Warped
      //     arrival, where the native layout owns the tile: expected=<loc>:<x>,<y>;
      //     actual=<loc>:<x>,<y>;level=<level>
      return receipt.reasonCode === "mine_entered" && hasMineEntryCompletionEvidence(detail);
    case "express_emote":
      // farmhandexecutioncontroller.expressionactions.cs:82-90: Farmer.doEmote arms the
      // animation synchronously, so `native_dispatched=true` under this terminal is the
      // departure proof. The animation's own completion is not a terminal fact.
      return (
        receipt.reasonCode === "emote_started" &&
        exactEvidence(
          detail,
          ["emote", "native_dispatched"],
          (e) => hasBoundedNonemptyEvidenceValue(e.emote) && e.native_dispatched === "true",
        )
      );
    case "face_direction":
      // farmhandexecutioncontroller.movementactions.cs:800-808: the actor re-reads its own
      // FacingDirection, so the emitted direction is the frozen enum spelling.
      return (
        receipt.reasonCode === "actor_facing_matches" &&
        exactEvidence(
          detail,
          ["direction"],
          (e) => e.direction === "up" || e.direction === "right" || e.direction === "down" || e.direction === "left",
        )
      );
    case "interact_npc_with_item":
      // Two terminals, both real completions of "offer an item to an NPC"
      // (farmhandexecutioncontroller.machinesanimalsitemsactions.cs):
      //   :768-769 — a matching unsatisfied delivery quest was completed: quest_item_delivered;
      //   :888-889 — otherwise the gift path: gift_given.
      return (
        (receipt.reasonCode === "gift_given" && hasGiftGivenCompletionEvidence(detail)) ||
        (receipt.reasonCode === "quest_item_delivered" && hasQuestItemDeliveredCompletionEvidence(detail))
      );
    case "pet_animal":
      // farmhandexecutioncontroller.cs:1524-1529 UpdateActivePet: the native petting callback
      // records the day AND grants friendship, and both are re-read before the terminal.
      return (
        receipt.reasonCode === "pet_completed" &&
        exactEvidence(
          detail,
          [
            "location",
            "target",
            "tile",
            "pet_day",
            "friendship_before",
            "friendship_after",
            "day_recorded",
            "friendship_callback",
          ],
          (e) =>
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            integerEvidenceValue(e.pet_day) !== null &&
            integerEvidenceValue(e.friendship_before) !== null &&
            integerEvidenceValue(e.friendship_after) !== null &&
            e.day_recorded === "true" &&
            e.friendship_callback === "true",
        )
      );
    case "advance_day":
      // SleepAndAdvanceDayLifecycle.cs:835-853 Finish("passed", "day_advanced", settlement).
      // This terminal is read by field membership, not by the shared key/value parser: the
      // lifecycle's BuildReceiptEvidence (:863-894) appends its settlement block to a base
      // list that already carries `topology`, so the emitted detail has a DUPLICATE key and
      // the duplicate-rejecting parser cannot read it. The rule therefore matches the
      // producer's own terminal markers exactly; `day_started_observed=true` is the one the
      // lifecycle gates the `passed` terminal on (DecideDayStart => Confirmed).
      return receipt.reasonCode === "day_advanced" && hasDayAdvancedCompletionEvidence(detail);
    case "clear_debris":
      // farmhandexecutioncontroller.farmingconstructionactions.cs:847-856: the clump is
      // re-resolved by its own opaque identity and `cleared` is exactly "the clump is gone".
      return (
        receipt.reasonCode === "debris_cleared" &&
        exactEvidence(
          detail,
          [
            "location",
            "target",
            "tile",
            "parent",
            "tool",
            "required_upgrade",
            "health_before",
            "health_after",
            "clump_removed",
            "stamina_before",
            "stamina_after",
            "stamina_delta",
            "expected_stamina_cost",
          ],
          (e) =>
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            integerEvidenceValue(e.parent) !== null &&
            (e.tool === "axe" || e.tool === "pickaxe") &&
            integerEvidenceValue(e.required_upgrade) !== null &&
            finiteEvidenceValue(e.health_before) !== null &&
            finiteEvidenceValue(e.health_after) !== null &&
            e.clump_removed === "true" &&
            hasStaminaConservationEvidence(e),
        )
      );
    case "npc_relationship":
      // farmhandexecutioncontroller.machinesanimalsitemsactions.cs:574-578: a read-only
      // inspection that mints Succeeded from the live Friendship it just read.
      return (
        receipt.reasonCode === "npc_relationship_inspected" &&
        exactEvidence(
          detail,
          [
            "location",
            "target",
            "tile",
            "npc",
            "points",
            "status",
            "talked_to_today",
            "gifts_today",
            "gifts_this_week",
          ],
          (e) =>
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            hasOpaqueEvidenceValue(e.npc) &&
            signedIntegerEvidenceValue(e.points) !== null &&
            hasOpaqueEvidenceValue(e.status) &&
            (e.talked_to_today === "true" || e.talked_to_today === "false") &&
            integerEvidenceValue(e.gifts_today) !== null &&
            integerEvidenceValue(e.gifts_this_week) !== null,
        )
      );
    case "equip_wearable":
      // farmhandexecutioncontroller.actorstateactions.cs:185-190 (a repeat of an already
      // satisfied request) and :257-262 (the swap landed). Both are deterministic
      // successes: append-only `slot/target id` identity plus the body slot's occupant.
      return (
        (receipt.reasonCode === "wearable_already_equipped" &&
          exactEvidence(
            detail,
            ["body_slot", "source_slot", "requested", "occupant", "moved"],
            (e) =>
              isWearableBodySlot(e.body_slot) &&
              validSlot(e.source_slot) &&
              hasOpaqueEvidenceValue(e.requested) &&
              e.occupant === e.requested &&
              e.moved === "false",
          )) ||
        (receipt.reasonCode === "wearable_equipped" &&
          exactEvidence(
            detail,
            [
              "body_slot",
              "source_slot",
              "requested",
              "occupant_before",
              "occupant_after",
              "displaced",
              "pack_slot_after",
            ],
            (e) =>
              isWearableBodySlot(e.body_slot) &&
              validSlot(e.source_slot) &&
              hasOpaqueEvidenceValue(e.requested) &&
              isNoneOrOpaqueEvidenceValue(e.occupant_before) &&
              e.occupant_after === e.requested &&
              isNoneOrOpaqueEvidenceValue(e.displaced) &&
              isNoneOrOpaqueEvidenceValue(e.pack_slot_after),
          ))
      );
    case "unequip_wearable":
      // farmhandexecutioncontroller.actorstateactions.cs:297-303 (the slot is already
      // empty) and :374-379 (the wearable landed in the named destination slot).
      return (
        (receipt.reasonCode === "wearable_already_unequipped" &&
          exactEvidence(
            detail,
            ["body_slot", "destination_slot", "occupant", "moved"],
            (e) =>
              isWearableBodySlot(e.body_slot) &&
              validSlot(e.destination_slot) &&
              e.occupant === "none" &&
              e.moved === "false",
          )) ||
        (receipt.reasonCode === "wearable_unequipped" &&
          exactEvidence(
            detail,
            [
              "body_slot",
              "destination_slot",
              "occupant_before",
              "occupant_after",
              "removed",
              "destination_before",
              "destination_after",
              "landed",
            ],
            (e) =>
              isWearableBodySlot(e.body_slot) &&
              validSlot(e.destination_slot) &&
              isNoneOrOpaqueEvidenceValue(e.occupant_before) &&
              e.occupant_after === "none" &&
              hasOpaqueEvidenceValue(e.removed) &&
              e.destination_before === "none" &&
              e.destination_after === e.removed &&
              e.landed === "true",
          ))
      );
    case "dismount_transport":
      // farmhandexecutioncontroller.actorstateactions.cs:439-446: the frozen postcondition
      // is `!who.isRidingHorse()` re-read after the native Horse.dismount call.
      return (
        receipt.reasonCode === "transport_dismounted" &&
        exactEvidence(
          detail,
          ["horse_id", "location", "tile", "riding_before", "mounting_before", "riding_after", "mount_after"],
          (e) =>
            hasOpaqueIdEvidenceValue(e.horse_id) &&
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasTileEvidenceValue(e.tile) &&
            (e.riding_before === "true" || e.riding_before === "false") &&
            (e.mounting_before === "true" || e.mounting_before === "false") &&
            e.riding_after === "false" &&
            e.mount_after === "false",
        )
      );
    case "use_warp_item":
      // farmhandexecutioncontroller.movementactions.cs:574/589-590: the totem's landing tile
      // is chosen inside the game's own delayed callback, so the reached destination
      // LOCATION is the postcondition — the same rule use_obelisk already follows.
      return (
        receipt.reasonCode === "warp_item_arrived" &&
        exactEvidence(
          detail,
          ["expected", "actual"],
          (e) =>
            hasOpaqueEvidenceValue(e.expected) &&
            hasOpaqueEvidenceValue(e.actual) &&
            e.expected.split(":")[0] === e.actual.split(":")[0],
        )
      );
    case "pan_ore":
      // farmhandexecutioncontroller.itemtileactions.cs:531-554: success is the panning site
      // advancing plus the native TimesPanned stat incrementing in the same call.
      return (
        receipt.reasonCode === "ore_panned" &&
        exactEvidence(
          detail,
          [
            "slot",
            "tool",
            "tile",
            "location",
            "site_before",
            "site_after",
            "site_moved",
            "times_panned_before",
            "times_panned_after",
            "pan_output_overflow",
            "inventory_slots_before",
            "inventory_slots_after",
            "inventory_units_before",
            "inventory_units_after",
          ],
          (e) => {
            const before = integerEvidenceValue(e.times_panned_before);
            const after = integerEvidenceValue(e.times_panned_after);
            return (
              validSlot(e.slot) &&
              hasOpaqueEvidenceValue(e.tool) &&
              hasTileEvidenceValue(e.tile) &&
              hasBoundedNonemptyEvidenceValue(e.location) &&
              // The panning site is a live, non-zero tile before the pan (the admission refuses
              // Point.Zero) and the native call clears it afterwards.
              hasTileEvidenceValue(e.site_before) &&
              hasTileEvidenceValue(e.site_after) &&
              e.site_moved === "true" &&
              before !== null &&
              after !== null &&
              after === before + 1 &&
              (e.pan_output_overflow === "true" || e.pan_output_overflow === "false") &&
              integerEvidenceValue(e.inventory_slots_before) !== null &&
              integerEvidenceValue(e.inventory_slots_after) !== null &&
              integerEvidenceValue(e.inventory_units_before) !== null &&
              integerEvidenceValue(e.inventory_units_after) !== null
            );
          },
        )
      );
    case "claim_mail_attachment":
      // farmhandexecutioncontroller.itemtileactions.cs:785-805: `claimed` is exactly
      // `mail_removed && mail_recorded` (the queue lost this letter and the mail registry
      // holds it). The letter-menu and inventory facts are reported, never asserted.
      return (
        receipt.reasonCode === "mail_claimed" &&
        exactEvidence(
          detail,
          [
            "target",
            "tile",
            "location",
            "mail_id",
            "mail_content_known",
            "mail_has_attachment",
            "mail_attachment_commands",
            "mail_recorded_natively",
            "pending_before",
            "pending_after",
            "mail_removed",
            "mail_recorded",
            "letter_opened",
            "letter_closed",
            "collection_overflow_pending",
            "mail_salvage_inventory_units",
            "mail_salvage_debris_units",
            "inventory_slots_before",
            "inventory_slots_after",
            "inventory_units_before",
            "inventory_units_after",
          ],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasBoundedNonemptyEvidenceValue(e.mail_id) &&
            booleanEvidenceValue(e.mail_content_known) &&
            booleanEvidenceValue(e.mail_has_attachment) &&
            integerEvidenceValue(e.mail_attachment_commands) !== null &&
            booleanEvidenceValue(e.mail_recorded_natively) &&
            integerEvidenceValue(e.pending_before) !== null &&
            integerEvidenceValue(e.pending_after) !== null &&
            e.mail_removed === "true" &&
            e.mail_recorded === "true" &&
            booleanEvidenceValue(e.letter_opened) &&
            booleanEvidenceValue(e.letter_closed) &&
            booleanEvidenceValue(e.collection_overflow_pending) &&
            integerEvidenceValue(e.inventory_slots_before) !== null &&
            integerEvidenceValue(e.inventory_slots_after) !== null &&
            integerEvidenceValue(e.inventory_units_before) !== null &&
            integerEvidenceValue(e.inventory_units_after) !== null,
        )
      );
    case "water_pet_bowl":
      // farmhandexecutioncontroller.petbowlactions.cs:112-115: the native watering path ran
      // and the bowl's own watered flag flipped. Same embodied-conservation clause as
      // water_crop, because it runs the same native tool path.
      return receipt.reasonCode === "pet_bowl_watered" && hasWateringToolCompletionEvidence(detail);
    case "water_slime_hutch_trough":
      // farmhandexecutioncontroller.slimehutchtroughactions.cs:135-138: same native tool
      // path and same evidence shape as water_pet_bowl.
      return receipt.reasonCode === "slime_hutch_trough_watered" && hasWateringToolCompletionEvidence(detail);
    case "dismiss_modal":
      // farmhandexecutioncontroller.modalactions.cs:145-152: the close is proved by the
      // modal registry and the dialogue flag, and `close_effect` names which of the two
      // audited close paths actually ran.
      return (
        receipt.reasonCode === "modal_dismissed" &&
        exactEvidence(
          detail,
          ["modal_type", "dismissed", "cleared_modal", "close_effect"],
          (e) =>
            hasOpaqueEvidenceValue(e.modal_type) &&
            e.dismissed === "true" &&
            e.cleared_modal === e.modal_type &&
            (e.close_effect === "native_dialogue_close" || e.close_effect === "pure_cancel"),
        )
      );
    case "answer_dialogue":
      // farmhandexecutioncontroller.modalactions.cs:255-260: the native answer was accepted
      // and the dialogue's own outro started.
      return (
        receipt.reasonCode === "answer_dialogue_answered" &&
        exactEvidence(
          detail,
          ["modal_type", "question", "response_key", "native_answered", "outro_started", "postcondition"],
          (e) =>
            e.modal_type === "DialogueBox" &&
            e.question === "true" &&
            hasBoundedNonemptyEvidenceValue(e.response_key) &&
            e.native_answered === "true" &&
            e.outro_started === "true" &&
            e.postcondition === "dialogue_outro_started",
        )
      );
    case "respond_level_up":
      // Evidence literal: farmhandexecutioncontroller.modalactions.cs:355-516 RequestLocalRespondLevelUp —
      // modal_type;skill;level;is_profession;chosen_profession;remaining_new_levels;pair_settled;
      // profession_settled;menu_closed. The Mod mints `level_up_resolved` only when
      // `pairSettled && professionSettled && !menu.isActive`, and it writes the SAME evidence under
      // `level_up_postcondition_unavailable` when those do not hold — so the terminal code is what
      // separates a resolved menu from an unresolved one, not the shape.
      //
      // All three conjuncts are now readable, which is the point of a completion rule: `menu_closed` is
      // the menu's own active flag re-read after the settlement, and `pair_settled`/`profession_settled`
      // are the engine's own re-reads of the two things the settlement claims to have done
      // (`!actor.newLevels.Contains(pair)`, `!actor.professions.Contains(chosen) || !isProfession`).
      // Before those two were published the rule agreed with the receipt on everything EXCEPT the two
      // facts the success condition turns on — it had to trust the producer for exactly those.
      //
      // What the rule still restates from the shape: the modal was the LevelUpMenu, the settled pair is
      // integral, and the branch the receipt names agrees with the kind of menu it settled
      // (`is_profession=true` names a profession and an ordinary level names `none` — the one reading that
      // would otherwise claim a profession write that never happened).
      //
      // A LevelUpMenu has no pure-cancel path (`cleanupBeforeExit -> okButtonClicked` grants the perk), so
      // `menu_closed` is not decoration: it is the only statement in the receipt that the thing which grants
      // levels stopped showing.
      return (
        receipt.reasonCode === "level_up_resolved" &&
        exactEvidence(
          detail,
          [
            "modal_type",
            "skill",
            "level",
            "is_profession",
            "chosen_profession",
            "remaining_new_levels",
            "pair_settled",
            "profession_settled",
            "menu_closed",
          ],
          (e) =>
            e.modal_type === "LevelUpMenu" &&
            integerEvidenceValue(e.skill) !== null &&
            positiveIntegerEvidence(e.level) !== null &&
            booleanEvidenceValue(e.is_profession) &&
            (e.is_profession === "true"
              ? integerEvidenceValue(e.chosen_profession) !== null
              : e.chosen_profession === "none") &&
            integerEvidenceValue(e.remaining_new_levels) !== null &&
            e.pair_settled === "true" &&
            e.profession_settled === "true" &&
            e.menu_closed === "true",
        )
      );
    case "chest_store":
      // farmhandexecutioncontroller.containeractions.cs:107-113: the chest took the whole stack,
      // the player slot released that same item, and the chest gained exactly the held stack.
      return (
        receipt.reasonCode === "chest_stored" &&
        exactEvidence(
          detail,
          [
            "location",
            "target",
            "tile",
            "container",
            "item",
            "player_stack_before",
            "player_stack_after",
            "source_consumed",
            "chest_stack_before",
            "chest_stack_after",
            "native_menu_opened",
          ],
          (e) => {
            const playerBefore = integerEvidenceValue(e.player_stack_before);
            const chestBefore = integerEvidenceValue(e.chest_stack_before);
            const chestAfter = integerEvidenceValue(e.chest_stack_after);
            return (
              hasBoundedNonemptyEvidenceValue(e.location) &&
              hasOpaqueIdEvidenceValue(e.target) &&
              hasTileEvidenceValue(e.tile) &&
              isStorageContainerKind(e.container) &&
              hasOpaqueEvidenceValue(e.item) &&
              playerBefore !== null &&
              integerEvidenceValue(e.player_stack_after) !== null &&
              e.source_consumed === "true" &&
              chestBefore !== null &&
              chestAfter !== null &&
              chestAfter === chestBefore + playerBefore &&
              e.native_menu_opened === "false"
            );
          },
        )
      );
    case "chest_retrieve":
      // farmhandexecutioncontroller.containeractions.cs:192-196: the whole stack left the chest
      // (`leftover is null`) and the same amount entered the backpack. The stack size itself is
      // not in the receipt, so both observed deltas are required and must agree.
      return (
        receipt.reasonCode === "chest_retrieved" &&
        exactEvidence(
          detail,
          [
            "location",
            "target",
            "tile",
            "container",
            "item",
            "chest_stack_before",
            "chest_stack_after",
            "inventory_before",
            "inventory_after",
            "native_menu_opened",
            "leftover_returned",
          ],
          (e) => {
            const chestBefore = integerEvidenceValue(e.chest_stack_before);
            const chestAfter = integerEvidenceValue(e.chest_stack_after);
            const inventoryBefore = integerEvidenceValue(e.inventory_before);
            const inventoryAfter = integerEvidenceValue(e.inventory_after);
            return (
              hasBoundedNonemptyEvidenceValue(e.location) &&
              hasOpaqueIdEvidenceValue(e.target) &&
              hasTileEvidenceValue(e.tile) &&
              isStorageContainerKind(e.container) &&
              hasOpaqueEvidenceValue(e.item) &&
              chestBefore !== null &&
              chestAfter !== null &&
              inventoryBefore !== null &&
              inventoryAfter !== null &&
              chestAfter < chestBefore &&
              inventoryAfter > inventoryBefore &&
              chestBefore - chestAfter === inventoryAfter - inventoryBefore &&
              e.native_menu_opened === "false" &&
              e.leftover_returned === "false"
            );
          },
        )
      );
    case "chop_stump":
      // farmhandexecutioncontroller.resourcetoolactions.cs:575-584: the native stump fell
      // (health marker -100) or its terrain feature is gone.
      return (
        receipt.reasonCode === "stump_cleared" &&
        exactEvidence(
          detail,
          [
            "target",
            "type",
            "tree",
            "tool",
            "tool_level",
            "health_before",
            "health_after",
            "swings",
            "stump_removed",
            "stamina_before",
            "stamina_after",
            "stamina_delta",
            "expected_stamina_cost",
          ],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            e.type === "tree_stump" &&
            hasOpaqueEvidenceValue(e.tree) &&
            e.tool === "axe" &&
            integerEvidenceValue(e.tool_level) !== null &&
            finiteEvidenceValue(e.health_before) !== null &&
            hasBoundedNonemptyEvidenceValue(e.health_after) &&
            positiveIntegerEvidence(e.swings) !== null &&
            e.stump_removed === "true" &&
            hasStaminaConservationEvidence(e),
        )
      );
    case "plant_sapling":
      // farmhandexecutioncontroller.farmingconstructionactions.cs:386-394: the native placement
      // ran, a Tree now stands on the tile, and the backpack lost exactly one sapling.
      return (
        receipt.reasonCode === "sapling_planted" &&
        exactEvidence(
          detail,
          [
            "location",
            "target",
            "tile",
            "item",
            "slot",
            "tree_type",
            "inventory_before",
            "inventory_after",
            "native_placement",
          ],
          (e) =>
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            hasOpaqueEvidenceValue(e.item) &&
            validSlot(e.slot) &&
            e.tree_type !== "none" &&
            hasOpaqueEvidenceValue(e.tree_type) &&
            decremented(e.inventory_before, e.inventory_after) &&
            e.native_placement === "true",
        )
      );
    case "cut_weeds":
      // farmhandexecutioncontroller.resourcetoolactions.cs:806-807: the native weed branch
      // reported the cut AND the map entry left the world.
      return (
        receipt.reasonCode === "weeds_cut" &&
        exactEvidence(
          detail,
          [
            "target",
            "type",
            "tool",
            "qualified_item_id",
            "health_before",
            "health_after",
            "swings",
            "removed",
            "stamina_before",
            "stamina_after",
            "stamina_delta",
            "expected_stamina_cost",
          ],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            e.type === "weed" &&
            e.tool === "scythe" &&
            hasOpaqueEvidenceValue(e.qualified_item_id) &&
            integerEvidenceValue(e.health_before) !== null &&
            hasBoundedNonemptyEvidenceValue(e.health_after) &&
            positiveIntegerEvidence(e.swings) !== null &&
            e.removed === "true" &&
            hasStaminaConservationEvidence(e),
        )
      );
    case "cut_grass":
      // farmhandexecutioncontroller.resourcetoolactions.cs:740-742: the tuft is gone from the
      // terrain layer. The hay roll inside Grass.TryDropItemsOnCut is deliberately not
      // re-derived (the producer records only what actually changed).
      return (
        receipt.reasonCode === "grass_cut" &&
        exactEvidence(
          detail,
          [
            "target",
            "type",
            "tool",
            "grass_type",
            "weeds_before",
            "weeds_after",
            "swings",
            "removed",
            "tuft_removed",
            "stamina_before",
            "stamina_after",
            "stamina_delta",
            "expected_stamina_cost",
          ],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            e.type === "grass" &&
            e.tool === "scythe" &&
            integerEvidenceValue(e.grass_type) !== null &&
            integerEvidenceValue(e.weeds_before) !== null &&
            hasBoundedNonemptyEvidenceValue(e.weeds_after) &&
            positiveIntegerEvidence(e.swings) !== null &&
            e.removed === "true" &&
            e.tuft_removed === "true" &&
            hasStaminaConservationEvidence(e),
        )
      );
    case "clear_cask":
      // farmhandexecutioncontroller.facilityactions.cs:46-52: `postcondition` is the
      // producer's own re-read of the cask tile (gone, or present and emptied).
      return (
        receipt.reasonCode === "cask_cleared" &&
        exactEvidence(
          detail,
          ["target", "tool", "had_held_object", "held_qualified_item_id", "removed", "postcondition"],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            hasOpaqueEvidenceValue(e.tool) &&
            booleanEvidenceValue(e.had_held_object) &&
            isNoneOrOpaqueEvidenceValue(e.held_qualified_item_id) &&
            booleanEvidenceValue(e.removed) &&
            e.postcondition === "true",
        )
      );
    case "dress_mannequin":
      // farmhandexecutioncontroller.facilityactions.cs:88-98: the named body field of the
      // mannequin now holds exactly the offered item. Slot/item stay in the identity clause.
      return (
        receipt.reasonCode === "mannequin_dressed" &&
        exactEvidence(
          detail,
          ["target", "slot", "item", "stored"],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            validSlot(e.slot) &&
            hasOpaqueEvidenceValue(e.item) &&
            e.stored === "true",
        )
      );
    case "set_sign_display":
      // farmhandexecutioncontroller.facilityactions.cs:129-133: Sign.checkForAction handled the
      // request and the sign's own display slot holds exactly the offered item.
      return (
        receipt.reasonCode === "sign_display_set" &&
        exactEvidence(
          detail,
          ["target", "slot", "item"],
          (e) => hasOpaqueIdEvidenceValue(e.target) && validSlot(e.slot) && hasOpaqueEvidenceValue(e.item),
        )
      );
    case "deposit_silo_hay":
      // farmhandexecutioncontroller.facilityactions.cs:169-171: the silo's own hay counter gained
      // exactly what the held stack lost, and the source slot released that much.
      return (
        receipt.reasonCode === "silo_hay_deposited" &&
        exactEvidence(detail, ["target", "slot", "stored", "hay_before", "hay_after"], (e) => {
          const stored = positiveIntegerEvidence(e.stored);
          const before = integerEvidenceValue(e.hay_before);
          const after = integerEvidenceValue(e.hay_after);
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            validSlot(e.slot) &&
            stored !== null &&
            before !== null &&
            after !== null &&
            after === before + stored
          );
        })
      );
    case "toggle_tool_light":
      // farmhandexecutioncontroller.facilityactions.cs:184-189: the native LightSource.DoFunction
      // returns void, so only the lantern's own flag moving proves the toggle.
      return (
        receipt.reasonCode === "tool_light_toggled" &&
        exactEvidence(
          detail,
          ["slot", "was_on", "is_on"],
          (e) =>
            validSlot(e.slot) &&
            booleanEvidenceValue(e.was_on) &&
            booleanEvidenceValue(e.is_on) &&
            e.was_on !== e.is_on,
        )
      );
    case "harvest_bush":
      // farmhandexecutioncontroller.treebushactions.cs:67-72: the bush's own harvest state flip
      // is the postcondition across every size. A size-4 bush queues its drop inside the native
      // mutex, so the in-frame debris delta is OBSERVED and deliberately not asserted.
      return (
        receipt.reasonCode === "bush_harvested" &&
        exactEvidence(
          detail,
          [
            "target",
            "tile",
            "ready_for_harvest_before",
            "ready_for_harvest_after",
            "debris_before",
            "debris_after",
            "item_dropped_in_frame",
          ],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            e.ready_for_harvest_before === "true" &&
            e.ready_for_harvest_after === "false" &&
            integerEvidenceValue(e.debris_before) !== null &&
            integerEvidenceValue(e.debris_after) !== null &&
            booleanEvidenceValue(e.item_dropped_in_frame),
        )
      );
    case "harvest_fruit_tree":
      // farmhandexecutioncontroller.treebushactions.cs:114-117: Tree.shake produced fruit debris
      // in the same frame, and that debris delta is the whole postcondition.
      return (
        receipt.reasonCode === "fruit_tree_harvested" &&
        exactEvidence(detail, ["target", "tile", "debris_before", "debris_after", "fruit_dropped"], (e) => {
          const before = integerEvidenceValue(e.debris_before);
          const after = integerEvidenceValue(e.debris_after);
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            before !== null &&
            after !== null &&
            after > before &&
            e.fruit_dropped === "true"
          );
        })
      );
    case "shake_tree":
      // farmhandexecutioncontroller.treebushactions.cs:185-188: the seed left the tree AND the
      // native shaken-today lock was recorded, which is exactly the producer's own condition.
      return (
        receipt.reasonCode === "tree_shaken" &&
        exactEvidence(
          detail,
          ["target", "tile", "has_seed_before", "has_seed_after", "shaken_today"],
          (e) =>
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            e.has_seed_before === "true" &&
            e.has_seed_after === "false" &&
            e.shaken_today === "true",
        )
      );
    case "take_pedestal_item":
      // farmhandexecutioncontroller.cs:1326-1331 UpdateActivePedestalTaking: the pedestal's own
      // held object is empty and the backpack gained at least the stack that was on it.
      return (
        receipt.reasonCode === "pedestal_item_taken" &&
        exactEvidence(
          detail,
          ["location", "target", "item", "stack", "inventory_before", "inventory_after", "held_object_empty"],
          (e) => {
            const stack = positiveIntegerEvidence(e.stack);
            const before = integerEvidenceValue(e.inventory_before);
            const after = integerEvidenceValue(e.inventory_after);
            return (
              hasBoundedNonemptyEvidenceValue(e.location) &&
              hasOpaqueIdEvidenceValue(e.target) &&
              hasOpaqueEvidenceValue(e.item) &&
              stack !== null &&
              before !== null &&
              after !== null &&
              after >= before + stack &&
              e.held_object_empty === "true"
            );
          },
        )
      );
    case "toggle_fence_gate":
      // farmhandexecutioncontroller.pedestalfenceactions.cs:131-135: the gate's own position moved
      // between its two native values (0 closed / 88 open), and `is_open` is derived from it.
      return (
        receipt.reasonCode === "fence_gate_toggled" &&
        exactEvidence(detail, ["target", "tile", "gate_position_before", "gate_position_after", "is_open"], (e) => {
          const before = integerEvidenceValue(e.gate_position_before);
          const after = integerEvidenceValue(e.gate_position_after);
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            before !== null &&
            after !== null &&
            ((before === 0 && after === 88) || (before === 88 && after === 0)) &&
            e.is_open === (after === 88 ? "true" : "false")
          );
        })
      );
    case "scythe_crop":
      // farmhandexecutioncontroller.farmingconstructionactions.cs:939-954: the crop left the
      // HoeDirt AND the matching produce debris appeared — the native scythe branch never
      // puts anything in the backpack, so inventory growth is not a postcondition here.
      return (
        receipt.reasonCode === "scythe_crops_harvested" &&
        exactEvidence(
          detail,
          [
            "target",
            "crop",
            "harvested_item",
            "debris_before",
            "debris_after",
            "crop_removed",
            "stamina_before",
            "stamina_after",
            "stamina_delta",
            "expected_stamina_cost",
            "native_scythe",
          ],
          (e) => {
            const before = integerEvidenceValue(e.debris_before);
            const after = integerEvidenceValue(e.debris_after);
            return (
              hasOpaqueIdEvidenceValue(e.target) &&
              hasBoundedNonemptyEvidenceValue(e.crop) &&
              hasOpaqueEvidenceValue(e.harvested_item) &&
              before !== null &&
              after !== null &&
              after > before &&
              e.crop_removed === "true" &&
              e.native_scythe === "true" &&
              hasStaminaConservationEvidence(e)
            );
          },
        )
      );
    case "craft_item":
      // farmhandexecutioncontroller.craftingactions.cs:151-154: the Succeeded terminal is the
      // `remainingStack == 0` branch, i.e. the whole product entered the backpack; the same
      // call also requires exact ingredient consumption, the native craft counter, and no menu.
      return (
        receipt.reasonCode === "crafted_item_created" &&
        exactEvidence(
          detail,
          [
            "location",
            "recipe",
            "output",
            "produced_stack",
            "produced_per_craft",
            "disposition",
            "inventory_gained_stack",
            "dropped_stack",
            "inventory_accepting_before",
            "materials_consumed_exactly",
            "inventory_postcondition",
            "count_before",
            "count_after",
            "count_postcondition",
            "ingredients",
            "dropped_debris",
            "native_menu_opened",
          ],
          (e) => {
            const produced = positiveIntegerEvidence(e.produced_stack);
            const perCraft = positiveIntegerEvidence(e.produced_per_craft);
            const gained = integerEvidenceValue(e.inventory_gained_stack);
            const countBefore = integerEvidenceValue(e.count_before);
            const countAfter = integerEvidenceValue(e.count_after);
            return (
              hasBoundedNonemptyEvidenceValue(e.location) &&
              hasOpaqueEvidenceValue(e.recipe) &&
              hasOpaqueEvidenceValue(e.output) &&
              produced !== null &&
              perCraft !== null &&
              (e.disposition === "added_to_inventory" || e.disposition === "granted_without_inventory_space") &&
              gained !== null &&
              gained === produced &&
              e.dropped_stack === "0" &&
              booleanEvidenceValue(e.inventory_accepting_before) &&
              e.materials_consumed_exactly === "true" &&
              e.inventory_postcondition === "true" &&
              countBefore !== null &&
              countAfter !== null &&
              countAfter === countBefore + perCraft &&
              e.count_postcondition === "true" &&
              hasBoundedNonemptyEvidenceValue(e.ingredients) &&
              integerEvidenceValue(e.dropped_debris) !== null &&
              e.native_menu_opened === "false"
            );
          },
        )
      );
    case "cook_recipe":
      // farmhandexecutioncontroller.cookingactions.cs:244-253 mints two Succeeded terminals:
      //   dish_cooked                    — the whole dish entered the backpack (dropped 0);
      //   dish_cooked_dropped_on_ground  — a full backpack, so the whole dish was dropped.
      // `dish_cooked_output_dropped` is PartiallySucceeded and is refused by the state gate.
      return (
        (receipt.reasonCode === "dish_cooked" && hasCookRecipeCompletionEvidence(detail, false)) ||
        (receipt.reasonCode === "dish_cooked_dropped_on_ground" && hasCookRecipeCompletionEvidence(detail, true))
      );
    case "collect_crab_pot_output":
      // farmhandexecutioncontroller.crabpotactions.cs:177-185: the native 714 branch ran and the
      // pot is back to its empty, unbaited 710 state, with the 1..2 native delivery window in the
      // backpack. `numToCatch` is content/state derived (Crabbing book), so the window is the rule.
      return (
        receipt.reasonCode === "crab_pot_output_collected" &&
        exactEvidence(
          detail,
          [
            "location",
            "target",
            "tile",
            "pot",
            "owner",
            "output",
            "stack_delivered",
            "inventory_before",
            "inventory_after",
            "held_after",
            "ready_after",
            "tile_index_after",
            "bait_after",
            "pot_retained",
            "native_handled",
            "native_entry",
            "fishing_experience_before",
            "fishing_experience_after",
          ],
          (e) => {
            const delivered = integerEvidenceValue(e.stack_delivered);
            const before = integerEvidenceValue(e.inventory_before);
            const after = integerEvidenceValue(e.inventory_after);
            return (
              hasBoundedNonemptyEvidenceValue(e.location) &&
              hasOpaqueIdEvidenceValue(e.target) &&
              hasTileEvidenceValue(e.tile) &&
              e.pot === "(O)710" &&
              hasDecimalOwnerIdEvidenceValue(e.owner) &&
              hasOpaqueEvidenceValue(e.output) &&
              delivered !== null &&
              delivered >= 1 &&
              delivered <= 2 &&
              before !== null &&
              after !== null &&
              after === before + delivered &&
              e.held_after === "none" &&
              e.ready_after === "false" &&
              e.tile_index_after === "710" &&
              e.bait_after === "none" &&
              e.pot_retained === "true" &&
              e.native_handled === "true" &&
              e.native_entry === "GameLocation.checkAction,CrabPot.checkForAction" &&
              integerEvidenceValue(e.fishing_experience_before) !== null &&
              integerEvidenceValue(e.fishing_experience_after) !== null
            );
          },
        )
      );
    case "ship_item":
      // farmhandexecutioncontroller.shippingactions.cs:106-111: the source slot released the
      // stack, the bin gained exactly it, and the native Farm.lastItemShipped is that item.
      return (
        receipt.reasonCode === "item_shipped" &&
        exactEvidence(
          detail,
          [
            "location",
            "target",
            "bin",
            "tile",
            "item",
            "slot",
            "stack",
            "inventory_before",
            "inventory_after",
            "bin_before",
            "bin_after",
            "last_item_shipped_matched",
            "native_menu_opened",
          ],
          (e) => {
            const stack = positiveIntegerEvidence(e.stack);
            const inventoryBefore = integerEvidenceValue(e.inventory_before);
            const inventoryAfter = integerEvidenceValue(e.inventory_after);
            const binBefore = integerEvidenceValue(e.bin_before);
            const binAfter = integerEvidenceValue(e.bin_after);
            return (
              hasBoundedNonemptyEvidenceValue(e.location) &&
              hasOpaqueIdEvidenceValue(e.target) &&
              hasTileEvidenceValue(e.bin) &&
              hasTileEvidenceValue(e.tile) &&
              hasOpaqueEvidenceValue(e.item) &&
              validSlot(e.slot) &&
              stack !== null &&
              inventoryBefore !== null &&
              inventoryAfter !== null &&
              inventoryAfter === inventoryBefore - stack &&
              binBefore !== null &&
              binAfter !== null &&
              binAfter === binBefore + stack &&
              e.last_item_shipped_matched === "true" &&
              e.native_menu_opened === "false"
            );
          },
        )
      );
    case "shop_purchase":
      // Evidence literal: farmhandexecutioncontroller.shopactions.cs - the terminal is minted only when the trade
      // moved BOTH sides (`moneyAfter < moneyBefore && gained > 0`), and the receipt carries:
      // shop;owner;entry;item;requested;purchased;unit_price;money_before;money_after;owned_before;owned_after;
      // gained;stock_before;stock_after;owner_tile;menu_closed;clicks;drops.
      //
      // The rule restates the Mod's OWN success condition from the evidence instead of trusting the code: money
      // went down, goods went up, and the menu really closed. `owner` is `none` when the shop is entered through
      // its counter TILE (no NPC owns it), and the two diagnostics are lists whose entries separate their parts
      // with `|`.
      //
      // Both of those shapes are recent: the tile-opened case used to write an EMPTY `owner=`, and the diagnostics
      // used to embed `;` inside their values - either one splits into fields this module cannot read, which is why
      // the action previously had no rule at all (a rule that cannot match the producer's real detail would look
      // like completion coverage while never accepting a success).
      return (
        receipt.reasonCode === "item_purchased" &&
        exactEvidence(
          detail,
          [
            "shop",
            "owner",
            "entry",
            "item",
            "requested",
            "purchased",
            "unit_price",
            "money_before",
            "money_after",
            "owned_before",
            "owned_after",
            "gained",
            "stock_before",
            "stock_after",
            "owner_tile",
            "menu_closed",
            "clicks",
            "drops",
          ],
          (e) =>
            (e.shop?.length ?? 0) > 0 &&
            (e.owner?.length ?? 0) > 0 &&
            (e.entry === "tile_action" || e.entry === "npc_owner") &&
            hasOpaqueEvidenceValue(e.item) &&
            integerEvidenceValue(e.requested) !== null &&
            integerEvidenceValue(e.purchased) !== null &&
            integerEvidenceValue(e.unit_price) !== null &&
            // NOT `decremented`/`incremented`: those are the exact +/-1 helpers for a single-unit transfer, and a
            // purchase of several units moves money and goods by the price and the quantity. The Mod's own success
            // condition is the inequality (`moneyAfter < moneyBefore && gained > 0`), so the rule states it.
            integerEvidenceValue(e.money_before) !== null &&
            integerEvidenceValue(e.money_after) !== null &&
            (integerEvidenceValue(e.money_after) ?? 0) < (integerEvidenceValue(e.money_before) ?? 0) &&
            integerEvidenceValue(e.owned_before) !== null &&
            integerEvidenceValue(e.owned_after) !== null &&
            (integerEvidenceValue(e.owned_after) ?? 0) > (integerEvidenceValue(e.owned_before) ?? 0) &&
            (integerEvidenceValue(e.gained) ?? 0) > 0 &&
            e.menu_closed === "true" &&
            hasTileEvidenceValue(e.owner_tile),
        )
      );
    default:
      return false;
  }
}

/** The four lowercase boolean spellings the Mod writes with `bool.ToString().ToLowerInvariant()`. */
function booleanEvidenceValue(value: string | undefined): boolean {
  return value === "true" || value === "false";
}

/** The six actor body slots the wearable family publishes
 * (farmhandexecutioncontroller.actorstateactions.cs:146). */
function isWearableBodySlot(value: string | undefined): boolean {
  return (
    value === "hat" ||
    value === "boots" ||
    value === "shirt" ||
    value === "pants" ||
    value === "left_ring" ||
    value === "right_ring"
  );
}

/** The two storage kinds the container family can resolve (a player chest or the fridge). */
function isStorageContainerKind(value: string | undefined): boolean {
  return value === "chest" || value === "fridge";
}

/**
 * movementactions.cs:611-617 CompleteTravelAfterWarp for select_mine_elevator_floor.
 * Floor 0 targets the mine-entrance MAP and emits only the expected/actual pair; a
 * generated floor lands in a MineShaft and appends `level`. In both shapes only the
 * destination LOCATION is a postcondition - the native layout picks the landing tile.
 */
function hasMineElevatorFloorCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const keys = Object.keys(evidence);
  const generatedFloor = keys.length === 3 && "level" in evidence;
  if (keys.length !== 2 && !generatedFloor) return false;
  if (!("expected" in evidence) || !("actual" in evidence)) return false;
  if (generatedFloor && positiveIntegerEvidence(evidence.level) === null) return false;
  return (
    hasOpaqueEvidenceValue(evidence.expected) &&
    hasOpaqueEvidenceValue(evidence.actual) &&
    evidence.expected.split(":")[0] === evidence.actual.split(":")[0]
  );
}

/**
 * The three producer shapes of enter_mine's `mine_entered` terminal:
 *   transportactions.cs:194  level;tile;from_level — ladder descent, synchronous;
 *   transportactions.cs:232  level;tile            — mine entrance, synchronous;
 *   movementactions.cs:611-617 expected;actual;level — the asynchronous Warped arrival,
 *     where the native MineShaft layout owns the landing tile.
 * All three prove the same declared/reached level; none is admitted with a foreign shape.
 */
function hasMineEntryCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const keys = Object.keys(evidence);
  if (keys.length === 3 && "level" in evidence && "tile" in evidence && "from_level" in evidence)
    return (
      positiveIntegerEvidence(evidence.level) !== null &&
      positiveIntegerEvidence(evidence.from_level) !== null &&
      hasTileEvidenceValue(evidence.tile)
    );
  if (keys.length === 2 && "level" in evidence && "tile" in evidence)
    return positiveIntegerEvidence(evidence.level) !== null && hasTileEvidenceValue(evidence.tile);
  if (keys.length === 3 && "expected" in evidence && "actual" in evidence && "level" in evidence)
    return (
      hasOpaqueEvidenceValue(evidence.expected) &&
      hasOpaqueEvidenceValue(evidence.actual) &&
      evidence.expected.split(":")[0] === evidence.actual.split(":")[0] &&
      positiveIntegerEvidence(evidence.level) !== null
    );
  return false;
}

/**
 * The gift branch of interact_npc_with_item
 * (farmhandexecutioncontroller.machinesanimalsitemsactions.cs:885-889). Succeeded is exactly
 * `giftGiven && consumedExactlyOne && (giftRecorded || pointsChanged)`, and the native answer
 * is asked with `showResponse: false`, so no dialogue may have been mounted.
 */
function hasGiftGivenCompletionEvidence(detail: string): boolean {
  return exactEvidence(
    detail,
    [
      "location",
      "target",
      "tile",
      "npc",
      "item",
      "slot",
      "stack_before",
      "points_before",
      "gifts_today_before",
      "gifts_this_week_before",
      "quest_25_completed_before",
      "stack_after",
      "points_after",
      "gifts_today_after",
      "gifts_this_week_after",
      "quest_25_completed_after",
      "update_gift_limit",
      "showed_response",
      "gift_recorded",
      "points_changed",
      "spouse_jealousy",
      "spouse_points_before",
      "spouse_points_after",
      "menu_open_after",
      "dialogue_open_after",
    ],
    (e) =>
      hasBoundedNonemptyEvidenceValue(e.location) &&
      hasOpaqueIdEvidenceValue(e.target) &&
      hasTileEvidenceValue(e.tile) &&
      hasOpaqueEvidenceValue(e.npc) &&
      hasOpaqueEvidenceValue(e.item) &&
      validSlot(e.slot) &&
      positiveIntegerEvidence(e.stack_before) !== null &&
      signedIntegerEvidenceValue(e.points_before) !== null &&
      integerEvidenceValue(e.gifts_today_before) !== null &&
      integerEvidenceValue(e.gifts_this_week_before) !== null &&
      booleanEvidenceValue(e.quest_25_completed_before) &&
      integerEvidenceValue(e.stack_after) !== null &&
      Number(e.stack_after) === Number(e.stack_before) - 1 &&
      signedIntegerEvidenceValue(e.points_after) !== null &&
      integerEvidenceValue(e.gifts_today_after) !== null &&
      integerEvidenceValue(e.gifts_this_week_after) !== null &&
      booleanEvidenceValue(e.quest_25_completed_after) &&
      booleanEvidenceValue(e.update_gift_limit) &&
      e.showed_response === "false" &&
      booleanEvidenceValue(e.gift_recorded) &&
      booleanEvidenceValue(e.points_changed) &&
      (e.gift_recorded === "true" || e.points_changed === "true") &&
      booleanEvidenceValue(e.spouse_jealousy) &&
      signedIntegerEvidenceValue(e.spouse_points_before) !== null &&
      signedIntegerEvidenceValue(e.spouse_points_after) !== null &&
      booleanEvidenceValue(e.menu_open_after) &&
      booleanEvidenceValue(e.dialogue_open_after),
  );
}

/**
 * The delivery-quest branch of interact_npc_with_item
 * (farmhandexecutioncontroller.machinesanimalsitemsactions.cs:747-769). Succeeded is exactly
 * `deliveryCompleted && consumedRequiredNumber && noModalMounted`, where `noModalMounted` is the
 * receipt's own `dialogue_open_after=false && menu_open_after=false` pair.
 */
function hasQuestItemDeliveredCompletionEvidence(detail: string): boolean {
  return exactEvidence(
    detail,
    [
      "location",
      "target",
      "tile",
      "npc",
      "item",
      "slot",
      "stack_before",
      "points_before",
      "gifts_today_before",
      "gifts_this_week_before",
      "quest_25_completed_before",
      "quest_id",
      "quest_target",
      "quest_item",
      "quest_number",
      "quest_daily",
      "quest_completed_before",
      "quest_completed_after",
      "quest_stays_in_log",
      "completed_quests_before",
      "completed_quests_after",
      "stack_after",
      "points_after",
      "friendship_amount",
      "quest_25_completed_after",
      "showed_response",
      "dialogue_open_after",
      "menu_open_after",
    ],
    (e) => {
      const stackBefore = positiveIntegerEvidence(e.stack_before);
      const requiredNumber = positiveIntegerEvidence(e.quest_number);
      const stackAfter = integerEvidenceValue(e.stack_after);
      return (
        hasBoundedNonemptyEvidenceValue(e.location) &&
        hasOpaqueIdEvidenceValue(e.target) &&
        hasTileEvidenceValue(e.tile) &&
        hasOpaqueEvidenceValue(e.npc) &&
        hasOpaqueEvidenceValue(e.item) &&
        validSlot(e.slot) &&
        stackBefore !== null &&
        signedIntegerEvidenceValue(e.points_before) !== null &&
        integerEvidenceValue(e.gifts_today_before) !== null &&
        integerEvidenceValue(e.gifts_this_week_before) !== null &&
        booleanEvidenceValue(e.quest_25_completed_before) &&
        hasBoundedNonemptyEvidenceValue(e.quest_id) &&
        hasOpaqueEvidenceValue(e.quest_target) &&
        hasOpaqueEvidenceValue(e.quest_item) &&
        requiredNumber !== null &&
        booleanEvidenceValue(e.quest_daily) &&
        e.quest_completed_before === "false" &&
        e.quest_completed_after === "true" &&
        booleanEvidenceValue(e.quest_stays_in_log) &&
        integerEvidenceValue(e.completed_quests_before) !== null &&
        integerEvidenceValue(e.completed_quests_after) !== null &&
        Number(e.completed_quests_after) >= Number(e.completed_quests_before) &&
        stackAfter !== null &&
        stackAfter === stackBefore - requiredNumber &&
        signedIntegerEvidenceValue(e.points_after) !== null &&
        positiveIntegerEvidence(e.friendship_amount) !== null &&
        booleanEvidenceValue(e.quest_25_completed_after) &&
        e.showed_response === "false" &&
        e.dialogue_open_after === "false" &&
        e.menu_open_after === "false"
      );
    },
  );
}

/**
 * advance_day's `day_advanced` terminal, read by exact field membership because
 * SleepAndAdvanceDayLifecycle.BuildReceiptEvidence (:863-894) appends its settlement block to a
 * base list that already carries `topology`, so the duplicate-rejecting key/value parser cannot
 * read the detail at all. `day_started_observed=true` is the marker the lifecycle gates the
 * `passed` terminal on (DecideDayStart => Confirmed, :811-813).
 */
function hasDayAdvancedCompletionEvidence(detail: string): boolean {
  const fields = detail.split(";");
  return (
    fields.includes("state=passed") &&
    fields.includes("reason=day_advanced") &&
    fields.includes("day_started_observed=true")
  );
}

/**
 * The shared body of water_pet_bowl and water_slime_hutch_trough
 * (farmhandexecutioncontroller.petbowlactions.cs:98-115,
 * farmhandexecutioncontroller.slimehutchtroughactions.cs:121-138). Both run the same native
 * watering-tool path, so both owe the same relation water_crop already asserts: the watered
 * flag flipped from false to true, at most one unit left the can (a bottomless can or an
 * enchantment legitimately consumes none), and the embodied stamina half closes.
 */
function hasWateringToolCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "before_watered",
    "after_watered",
    "water_before",
    "water_after",
    "water_consumed",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
    "native_menu_opened",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.water_before);
  const after = integerEvidenceValue(evidence.water_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.before_watered === "false" &&
    evidence.after_watered === "true" &&
    before !== null &&
    after !== null &&
    after <= before &&
    before - after <= 1 &&
    evidence.water_consumed === "true" &&
    evidence.native_menu_opened === "false" &&
    hasStaminaConservationEvidence(evidence)
  );
}

/**
 * cook_recipe's two Succeeded terminals (farmhandexecutioncontroller.cookingactions.cs:244-253).
 * `droppedOutput` selects the branch: false is `dish_cooked` (the whole dish entered the
 * backpack), true is `dish_cooked_dropped_on_ground` (a full backpack, whole dish dropped).
 * The partially-dropped terminal is PartiallySucceeded and never reaches this rule.
 */
function hasCookRecipeCompletionEvidence(detail: string, droppedOutput: boolean): boolean {
  return exactEvidence(
    detail,
    [
      "location",
      "recipe",
      "station",
      "crafted",
      "crafted_stack",
      "quality",
      "seasoning_used",
      "space_prechecked",
      "inventory_before",
      "inventory_after",
      "delivered",
      "dropped",
      "disposition",
      "recipes_cooked_before",
      "recipes_cooked_after",
      "count_incremented",
      "native_menu_opened",
      "native_entry",
    ],
    (e) => {
      const craftedStack = positiveIntegerEvidence(e.crafted_stack);
      const delivered = integerEvidenceValue(e.delivered);
      const dropped = integerEvidenceValue(e.dropped);
      const cookedBefore = integerEvidenceValue(e.recipes_cooked_before);
      const cookedAfter = integerEvidenceValue(e.recipes_cooked_after);
      return (
        hasBoundedNonemptyEvidenceValue(e.location) &&
        hasOpaqueEvidenceValue(e.recipe) &&
        hasBoundedNonemptyEvidenceValue(e.station) &&
        e.station.includes("@") &&
        hasOpaqueEvidenceValue(e.crafted) &&
        craftedStack !== null &&
        integerEvidenceValue(e.quality) !== null &&
        // `seasoning_used={seasoning is not null}` is the one boolean the cooking
        // producer interpolates without ToLowerInvariant, so it is spelled Title-case.
        (e.seasoning_used === "True" || e.seasoning_used === "False") &&
        booleanEvidenceValue(e.space_prechecked) &&
        integerEvidenceValue(e.inventory_before) !== null &&
        integerEvidenceValue(e.inventory_after) !== null &&
        delivered !== null &&
        dropped !== null &&
        delivered === craftedStack - dropped &&
        Number(e.inventory_after) === Number(e.inventory_before) + delivered &&
        (droppedOutput
          ? dropped > 0 && delivered === 0 && e.disposition === "dropped_on_ground"
          : dropped === 0 && delivered > 0 && e.disposition === "inventory") &&
        cookedBefore !== null &&
        cookedAfter !== null &&
        cookedAfter === cookedBefore + 1 &&
        e.count_incremented === "true" &&
        hasBoundedNonemptyEvidenceValue(e.native_entry) &&
        e.native_menu_opened === "false"
      );
    },
  );
}

function exactEvidence(
  detail: string,
  expectedKeys: readonly string[],
  validate: (evidence: Readonly<Record<string, string>>) => boolean,
): boolean {
  const evidence = parseSemicolonEvidence(detail);
  return (
    evidence !== null &&
    Object.keys(evidence).length === expectedKeys.length &&
    expectedKeys.every((key) => key in evidence) &&
    validate(evidence)
  );
}
function validSlot(value: string | undefined): boolean {
  const slot = integerEvidenceValue(value);
  return slot !== null && slot <= 36;
}
function decremented(before: string | undefined, after: string | undefined): boolean {
  const left = integerEvidenceValue(before);
  const right = integerEvidenceValue(after);
  return left !== null && right !== null && right === left - 1;
}

/** The exact +1 counterpart of `decremented`, for a transfer's receiving side. */
function incremented(before: string | undefined, after: string | undefined): boolean {
  const left = integerEvidenceValue(before);
  const right = integerEvidenceValue(after);
  return left !== null && right !== null && right === left + 1;
}

function hasNavigationCompletionEvidence(detail: string): boolean {
  // The Mod emits exactly this navigation_completed evidence only from a fresh
  // post-warp coordinator re-read at the destination. It contains only the
  // canonical opaque destination identity and a fresh actual location assertion
  // together with the two Mod postcondition markers; never a route/tile/warp.
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["destination", "location", "arrived", "postcondition"];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  return (
    hasOpaqueEvidenceValue(evidence.destination) &&
    hasOpaqueEvidenceValue(evidence.location) &&
    evidence.arrived === "true" &&
    evidence.postcondition === "true"
  );
}

function hasMoveToTileCompletionEvidence(detail: string): boolean {
  return exactEvidence(detail, ["tile", "target", "arrival", "path"], (e) => {
    const target = parseCanonicalIntegralTile(e.target);
    const tile = parseFormatTile(e.tile);
    return (
      target !== null &&
      tile !== null &&
      canBeSerializedExactArrival(tile, target) &&
      e.arrival === "exact" &&
      e.path === "stardew_native"
    );
  });
}

/**
 * The request producer admits integral [0, 1000] target tiles and serializes
 * them with `:0.##`; preserve that canonical integer spelling in the receipt.
 */
function parseCanonicalIntegralTile(value: string | undefined): readonly [number, number] | null {
  if (value === undefined) return null;
  const match = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return x <= 1000 && y <= 1000 ? [x, y] : null;
}

/** Parses exactly the nonnegative canonical output grammar of C# `:0.##`. */
function parseFormatTile(value: string | undefined): readonly [number, number] | null {
  if (value === undefined) return null;
  // `:0.##` omits a zero fractional part and never retains a trailing zero.
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{0,1}[1-9]))?,(0|[1-9][0-9]*)(?:\.([0-9]{0,1}[1-9]))?$/.exec(value);
  if (match === null) return null;
  const x = Number(match[1]) + Number(`0.${match[2] ?? "0"}`);
  const y = Number(match[3]) + Number(`0.${match[4] ?? "0"}`);
  // A successful requested edge tile may round to 1000.2; the exact-arrival
  // relation below imposes the tighter target-relative bound.
  return x <= 1000.2 && y <= 1000.2 ? [x, y] : null;
}

function canBeSerializedExactArrival(tile: readonly [number, number], target: readonly [number, number]): boolean {
  // The producer succeeds when |actual - target|² <= 0.04 (radius 0.2).
  // `:0.##` quantizes each displayed coordinate by at most 0.005, so an
  // emitted coordinate q is possible iff max(|q-target|-0.005, 0) per axis
  // can still lie within that radius. This rejects tiles definitely outside
  // every successful producer value without inventing a looser tolerance.
  const x = Math.max(Math.abs(tile[0] - target[0]) - 0.005, 0);
  const y = Math.max(Math.abs(tile[1] - target[1]) - 0.005, 0);
  return x * x + y * y <= 0.04;
}

function hasTillSoilCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "before",
    "after",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    evidence.location !== "none" &&
    hasTileEvidenceValue(evidence.target) &&
    evidence.before === "none" &&
    evidence.after === "HoeDirt" &&
    hasStaminaConservationEvidence(evidence)
  );
}

function hasWaterCropCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "before_watered",
    "after_watered",
    "water_before",
    "water_after",
    "water_consumed",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.water_before);
  const after = integerEvidenceValue(evidence.water_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    evidence.location !== "none" &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.before_watered === "false" &&
    evidence.after_watered === "true" &&
    before !== null &&
    after !== null &&
    // FarmhandExecutionController emits only waterConsumed plus before/after
    // quantities: bottomless cans and watering-can enchantments legitimately
    // report a consumed watering operation without decrementing WaterLeft.
    // Therefore accept exactly the producer-observable relation, 0 or 1 used,
    // rather than inventing an unavailable branch discriminator.
    after <= before &&
    before - after <= 1 &&
    evidence.water_consumed === "true" &&
    hasStaminaConservationEvidence(evidence)
  );
}

/** Parses bounded key/value evidence without accepting duplicate fields. */
function parseSemicolonEvidence(detail: string): Readonly<Record<string, string>> | null {
  const result: Record<string, string> = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) return null;
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (
      !(key in result) &&
      // Camel-case keys are legal: the frozen pickup_forage contract names its key
      // `targetIdentity`, and a lower-case-only grammar made that evidence
      // unparseable, so the action could never complete. The point of this check is
      // to reject protocol scalar sentinels and junk, not to forbid capitals.
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) &&
      value.length <= 512
    ) {
      result[key] = value;
      continue;
    }
    return null;
  }
  return result;
}

// Evidence values are serialized with up to four decimal places; allow rounding plus binary floating-point noise.
const STAMINA_EVIDENCE_EPSILON = 0.011;

/**
 * Family-level embodied conservation: every tool action mutation has two halves
 * (world + agent stamina). A succeeded receipt must prove the stamina half
 * closes the loop: before/after/delta/expected all present, delta consistent
 * with before→after, and the actual spend equals the native formula so a
 * power/formula drift (e.g. power=0 feeding stamina back) is caught here.
 */
function hasStaminaConservationEvidence(evidence: Readonly<Record<string, string>>): boolean {
  const staminaBefore = finiteEvidenceValue(evidence.stamina_before);
  const staminaAfter = finiteEvidenceValue(evidence.stamina_after);
  const staminaDelta = finiteEvidenceValue(evidence.stamina_delta);
  const expectedStaminaCost = finiteEvidenceValue(evidence.expected_stamina_cost);
  return (
    staminaBefore !== null &&
    staminaAfter !== null &&
    staminaDelta !== null &&
    expectedStaminaCost !== null &&
    Math.abs(staminaAfter - staminaBefore - staminaDelta) <= 0.001 &&
    Math.abs(-staminaDelta - expectedStaminaCost) <= STAMINA_EVIDENCE_EPSILON &&
    staminaDelta <= 0 &&
    expectedStaminaCost >= 0
  );
}

function hasDigArtifactSpotCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "result_target",
    "tile",
    "tool",
    "slot",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
    "qualified_item_id",
    "source_present_before",
    "source_present_after",
    "hoedirt_present_before",
    "hoedirt_present_after",
    "source_removed",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasOpaqueIdEvidenceValue(evidence.result_target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.tool === "hoe" &&
    slot !== null &&
    slot >= 0 &&
    slot <= 36 &&
    hasStaminaConservationEvidence(evidence) &&
    // Mirror the Mod's native predicate exactly: the diggable category is the two
    // ids `Object.cs:1310` routes through the single `t is Hoe` branch, not any id.
    // Accepting every id here would also admit a non-diggable item such as
    // `(O)388` (Wood).
    (evidence.qualified_item_id === "(O)590" || evidence.qualified_item_id === "(O)SeedSpot") &&
    evidence.source_present_before === "true" &&
    evidence.source_present_after === "false" &&
    evidence.hoedirt_present_before === "false" &&
    evidence.hoedirt_present_after === "true" &&
    evidence.source_removed === "true"
  );
}

function hasRefillWateringCanCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "target",
    "slot",
    "can",
    "water_before",
    "water_after",
    "water_max",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.water_before);
  const after = integerEvidenceValue(evidence.water_after);
  const max = integerEvidenceValue(evidence.water_max);
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasOpaqueEvidenceValue(evidence.can) &&
    validSlot(evidence.slot) &&
    before !== null &&
    after !== null &&
    max !== null &&
    before < max &&
    after === max &&
    hasStaminaConservationEvidence(evidence)
  );
}

function hasBreakRockSourceCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "target",
    "tool",
    "slot",
    "qualified_item_id",
    "durability_before",
    "durability_after",
    "removed",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.tool === "pickaxe" &&
    validSlot(evidence.slot) &&
    evidence.qualified_item_id === "(O)2" &&
    evidence.durability_before === "1" &&
    evidence.durability_after === "removed" &&
    evidence.removed === "true" &&
    hasStaminaConservationEvidence(evidence)
  );
}

function hasClearHoeDirtCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "tool",
    "slot",
    "crop_before",
    "hoedirt_present_before",
    "hoedirt_present_after",
    "removed",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.tool === "pickaxe" &&
    slot !== null &&
    slot >= 0 &&
    slot <= 36 &&
    evidence.crop_before === "false" &&
    evidence.hoedirt_present_before === "true" &&
    evidence.hoedirt_present_after === "false" &&
    evidence.removed === "true" &&
    hasStaminaConservationEvidence(evidence)
  );
}

function hasWoodFenceCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "source",
    "location",
    "x",
    "y",
    "target",
    "item",
    "slot",
    "source_empty_before",
    "is_fence",
    "is_gate",
    "health",
    "max_health",
    "inventory_before",
    "inventory_after",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const x = integerEvidenceValue(evidence.x);
  const y = integerEvidenceValue(evidence.y);
  const slot = integerEvidenceValue(evidence.slot);
  const health = finiteEvidenceValue(evidence.health);
  const maxHealth = finiteEvidenceValue(evidence.max_health);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    evidence.source === "(O)322" &&
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    x !== null &&
    x <= 1000 &&
    y !== null &&
    y <= 1000 &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.item === "(O)322" &&
    slot !== null &&
    slot <= 36 &&
    evidence.source_empty_before === "true" &&
    evidence.is_fence === "true" &&
    evidence.is_gate === "false" &&
    health !== null &&
    health > 0 &&
    maxHealth !== null &&
    maxHealth >= health &&
    before === 1 &&
    after === 0
  );
}

function hasBaitCrabPotCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "source",
    "location",
    "x",
    "y",
    "target",
    "pot",
    "slot",
    "owner",
    "bait_before",
    "bait_after",
    "inventory_before",
    "inventory_after",
    "actionable",
    "active_execution",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const x = integerEvidenceValue(evidence.x);
  const y = integerEvidenceValue(evidence.y);
  const slot = integerEvidenceValue(evidence.slot);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    evidence.source === "(O)685" &&
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    evidence.location !== "none" &&
    x !== null &&
    x <= 1000 &&
    y !== null &&
    y <= 1000 &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.pot === "(O)710" &&
    slot !== null &&
    slot <= 36 &&
    hasDecimalOwnerIdEvidenceValue(evidence.owner) &&
    evidence.bait_before === "none" &&
    evidence.bait_after === "(O)685" &&
    before === 1 &&
    after === 0 &&
    evidence.actionable === "true" &&
    evidence.active_execution === "null"
  );
}

function hasChopTreeSourceCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "target",
    "tool",
    "slot",
    "tree",
    "health_before",
    "health_after",
    "stump_before",
    "stump_after",
    "source_transformed",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.tool === "axe" &&
    validSlot(evidence.slot) &&
    hasBoundedNonemptyEvidenceValue(evidence.tree) &&
    evidence.health_before === "1" &&
    evidence.health_after === "5" &&
    evidence.stump_before === "false" &&
    evidence.stump_after === "true" &&
    evidence.source_transformed === "true" &&
    hasStaminaConservationEvidence(evidence)
  );
}

function hasDoorTransitionCompletionEvidence(detail: string): boolean {
  // An ordinary warp/enter_exit emits exactly {expected, actual}: the ride's own
  // objective identity belongs to `ride_minecart`, whose terminal is separate.
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["expected", "actual"];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  return warpPostconditionHolds(evidence);
}

function hasMinecartRideCompletionEvidence(detail: string): boolean {
  // A minecart ride ends in the same Warped postcondition, but the ride has to
  // name which published objective it actually rode: the coordinate pair alone
  // cannot distinguish two destinations on one station tile.
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["expected", "actual", "network", "destination"];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  if (!hasBoundedNonemptyEvidenceValue(evidence.network)) return false;
  if (!hasBoundedNonemptyEvidenceValue(evidence.destination)) return false;
  return warpPostconditionHolds(evidence);
}

/** The Warped postcondition both `travel` and `ride_minecart` share. */
function warpPostconditionHolds(evidence: Readonly<Record<string, string>>): boolean {
  const expected = parseWarpDestination(evidence.expected);
  const actual = parseWarpDestination(evidence.actual);
  return (
    expected !== null &&
    actual !== null &&
    actual.location === expected.location &&
    actual.x === expected.x &&
    actual.y === expected.y
  );
}

/**
 * Parses the producer's `location:x,y` destination grammar. The location is
 * greedy up to the final colon so native names that themselves contain a
 * colon still round-trip; the trailing coordinates are canonical integers.
 */
function parseWarpDestination(value: string | undefined): { location: string; x: number; y: number } | null {
  if (value === undefined) return null;
  const match = /^(.*):(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) return null;
  const location = match[1];
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!hasBoundedNonemptyEvidenceValue(location) || x > 1000 || y > 1000) return null;
  return { location, x, y };
}

function hasPickupForageCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["location", "targetIdentity", "tile", "item", "removed", "inventory_before", "inventory_after"];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.targetIdentity) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasOpaqueEvidenceValue(evidence.item) &&
    evidence.removed === "true" &&
    before !== null &&
    after !== null &&
    after === before + 1
  );
}
function hasPickupItemCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "item",
    "stack",
    "native_auto_collect",
    "chunk_removed",
    "inventory_before",
    "inventory_after",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const stack = integerEvidenceValue(evidence.stack);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasOpaqueEvidenceValue(evidence.item) &&
    stack !== null &&
    stack >= 1 &&
    evidence.native_auto_collect === "true" &&
    evidence.chunk_removed === "true" &&
    before !== null &&
    after !== null &&
    after >= before + stack
  );
}

function hasHarvestCropCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "crop",
    "item",
    "native_path_return",
    "native_accepted",
    "regrows",
    "phase_before",
    "phase_after",
    "day_of_phase_before",
    "day_of_phase_after",
    "regrow_advanced",
    "inventory_before",
    "inventory_after",
    "inventory_gained",
    "crop_present_after",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const phaseBefore = integerEvidenceValue(evidence.phase_before);
  const dayOfPhaseBefore = integerEvidenceValue(evidence.day_of_phase_before);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  if (
    !hasBoundedNonemptyEvidenceValue(evidence.location) ||
    !hasOpaqueIdEvidenceValue(evidence.target) ||
    !hasTileEvidenceValue(evidence.tile) ||
    !hasOpaqueEvidenceValue(evidence.crop) ||
    !hasOpaqueEvidenceValue(evidence.item) ||
    evidence.native_accepted !== "true" ||
    evidence.inventory_gained !== "true" ||
    before === null ||
    after === null ||
    after <= before ||
    phaseBefore === null ||
    dayOfPhaseBefore === null
  )
    return false;
  if (evidence.regrows === "true") {
    // A regrowing harvest keeps the crop and advances its phase/day; the
    // native path return is deliberately unconstrained because the producer
    // documents that a successful regrow harvest normally falls through.
    const phaseAfter = integerEvidenceValue(evidence.phase_after);
    const dayOfPhaseAfter = integerEvidenceValue(evidence.day_of_phase_after);
    return (
      evidence.crop_present_after === "true" &&
      evidence.regrow_advanced === "true" &&
      phaseAfter !== null &&
      phaseAfter >= phaseBefore &&
      dayOfPhaseAfter !== null &&
      dayOfPhaseAfter > dayOfPhaseBefore
    );
  }
  if (evidence.regrows === "false") {
    // A non-regrowing harvest destroys the crop through the native path.
    return (
      evidence.crop_present_after === "false" &&
      evidence.phase_after === "none" &&
      evidence.day_of_phase_after === "none" &&
      evidence.native_path_return === "true"
    );
  }
  return false;
}

function hasFertilizeTileCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "item",
    "fertilizer_before",
    "fertilizer_after",
    "inventory_before",
    "inventory_after",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasOpaqueEvidenceValue(evidence.item) &&
    isNoneOrOpaqueEvidenceValue(evidence.fertilizer_before) &&
    evidence.fertilizer_after === evidence.item &&
    before !== null &&
    after !== null &&
    after === before - 1
  );
}

function hasPlaceCrabPotCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "source",
    "location",
    "x",
    "y",
    "target",
    "item",
    "slot",
    "source_empty_before",
    "is_crab_pot",
    "owner",
    "offset_x",
    "offset_y",
    "overlay_tiles",
    "inventory_before",
    "inventory_after",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const x = integerEvidenceValue(evidence.x);
  const y = integerEvidenceValue(evidence.y);
  const slot = integerEvidenceValue(evidence.slot);
  const offsetX = finiteEvidenceValue(evidence.offset_x);
  const offsetY = finiteEvidenceValue(evidence.offset_y);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    evidence.source === "(O)710" &&
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    x !== null &&
    x <= 1000 &&
    y !== null &&
    y <= 1000 &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.item === "(O)710" &&
    slot !== null &&
    slot <= 36 &&
    evidence.source_empty_before === "true" &&
    evidence.is_crab_pot === "true" &&
    hasDecimalOwnerIdEvidenceValue(evidence.owner) &&
    offsetX !== null &&
    offsetY !== null &&
    hasCrabPotOverlayEvidence(evidence.overlay_tiles) &&
    before !== null &&
    after !== null &&
    after === before - 1
  );
}

/**
 * The producer joins only count>0 overlay tiles as `x,y:count|...`; the
 * shared evidence grammar rejects empty values, so a completed receipt must
 * carry at least one overlay tile.
 */
function hasCrabPotOverlayEvidence(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^(?:0|[1-9][0-9]*),(?:0|[1-9][0-9]*):[1-9][0-9]*(?:\|(?:0|[1-9][0-9]*),(?:0|[1-9][0-9]*):[1-9][0-9]*)*$/.test(
    value,
  );
}

function hasMachineInspectCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "machine",
    "ready_for_harvest",
    "minutes_until_ready",
    "held",
    "last_input",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const minutes = signedIntegerEvidenceValue(evidence.minutes_until_ready);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasOpaqueEvidenceValue(evidence.machine) &&
    (evidence.ready_for_harvest === "true" || evidence.ready_for_harvest === "false") &&
    minutes !== null &&
    isNoneOrOpaqueEvidenceValue(evidence.held) &&
    isNoneOrOpaqueEvidenceValue(evidence.last_input)
  );
}

function hasMachineLoadCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "machine",
    "slot",
    "input",
    "input_stack_before",
    "input_stack_after",
    "last_input",
    "held",
    "ready_for_harvest",
    "minutes_until_ready",
    "expected_minutes_until_ready",
    "native_check_action",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  // The processing window is NOT a content constant: the Mod derives it from the
  // live machine data (the matched ItemPlacedInMachine rule plus the machine's
  // ReadyTimeModifiers) and reports the derived expectation next to the observed
  // value, so a content rebalance cannot turn a legitimate native load into
  // either a false success or a false failure. Host only proves the two agree.
  const observedMinutes = positiveIntegerEvidence(evidence.minutes_until_ready);
  const expectedMinutes = positiveIntegerEvidence(evidence.expected_minutes_until_ready);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.machine === "(BC)12" &&
    slot !== null &&
    slot <= 36 &&
    evidence.input === "(O)433" &&
    evidence.input_stack_before === "5" &&
    evidence.input_stack_after === "removed" &&
    evidence.last_input === "(O)433" &&
    evidence.held === "(O)395" &&
    evidence.ready_for_harvest === "false" &&
    observedMinutes !== null &&
    expectedMinutes !== null &&
    observedMinutes === expectedMinutes &&
    evidence.native_check_action === "true"
  );
}

function hasMachineCollectOutputCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "machine",
    "output",
    "input",
    "ready_before",
    "minutes_until_ready_before",
    "inventory_coffee_before",
    "inventory_coffee_after",
    "held_after",
    "ready_after",
    "native_check_action",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.inventory_coffee_before);
  const after = integerEvidenceValue(evidence.inventory_coffee_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.machine === "(BC)12" &&
    evidence.output === "(O)395" &&
    evidence.input === "(O)433" &&
    evidence.ready_before === "true" &&
    evidence.minutes_until_ready_before === "0" &&
    before !== null &&
    after !== null &&
    after === before + 1 &&
    evidence.held_after === "none" &&
    evidence.ready_after === "false" &&
    evidence.native_check_action === "true"
  );
}

function hasUseItemCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "slot",
    "item",
    "stack_before",
    "stack_after",
    "edibility",
    "drink",
    "stamina_before",
    "stamina_after",
    "health_before",
    "health_after",
    "animation_complete",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  const stackBefore = integerEvidenceValue(evidence.stack_before);
  const stackAfter = integerEvidenceValue(evidence.stack_after);
  const edibility = signedIntegerEvidenceValue(evidence.edibility);
  const staminaBefore = finiteEvidenceValue(evidence.stamina_before);
  const staminaAfter = finiteEvidenceValue(evidence.stamina_after);
  const healthBefore = integerEvidenceValue(evidence.health_before);
  const healthAfter = integerEvidenceValue(evidence.health_after);
  return (
    slot !== null &&
    slot <= 36 &&
    hasOpaqueEvidenceValue(evidence.item) &&
    stackBefore !== null &&
    stackBefore >= 1 &&
    stackAfter !== null &&
    stackAfter === stackBefore - 1 &&
    edibility !== null &&
    (evidence.drink === "true" || evidence.drink === "false") &&
    staminaBefore !== null &&
    staminaAfter !== null &&
    healthBefore !== null &&
    healthBefore >= 0 &&
    healthAfter !== null &&
    healthAfter >= 0 &&
    evidence.animation_complete === "true"
  );
}

function hasFeedAnimalCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "slot",
    "native_handled",
    "trough_filled",
    "hay_before",
    "hay_after",
    "hay_consumed",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  const before = integerEvidenceValue(evidence.hay_before);
  const after = integerEvidenceValue(evidence.hay_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    slot !== null &&
    slot <= 36 &&
    evidence.native_handled === "true" &&
    evidence.trough_filled === "true" &&
    before !== null &&
    before >= 1 &&
    after !== null &&
    after === before - 1 &&
    evidence.hay_consumed === "true"
  );
}

function hasCollectAnimalProductCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "animal",
    "tool",
    "produce",
    "produce_stack",
    "produce_cleared",
    "inventory_before",
    "inventory_after",
    "inventory_gained",
    "animation_complete",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const produceStack = integerEvidenceValue(evidence.produce_stack);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasDecimalOwnerIdEvidenceValue(evidence.animal) &&
    (evidence.tool === "milk_pail" || evidence.tool === "shears") &&
    hasOpaqueEvidenceValue(evidence.produce) &&
    produceStack !== null &&
    produceStack >= 1 &&
    produceStack <= 2 &&
    evidence.produce_cleared === "true" &&
    before !== null &&
    after !== null &&
    after >= before + produceStack &&
    evidence.inventory_gained === "true" &&
    evidence.animation_complete === "true" &&
    hasStaminaConservationEvidence(evidence) &&
    // MilkPail/Shears deduct a flat 4f; the agent must observe exactly that
    // embodied cost so an animation counting the wrong number of tool uses is
    // caught at the approval boundary, not silently accepted.
    Math.abs(Number(evidence.expected_stamina_cost) - 4) <= STAMINA_EVIDENCE_EPSILON
  );
}

function integerEvidenceValue(value: string | undefined): number | null {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function finiteEvidenceValue(value: string | undefined): number | null {
  if (value === undefined || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isNoneOrOpaqueEvidenceValue(value: string | undefined): value is string {
  return value === "none" || hasOpaqueEvidenceValue(value);
}

function signedIntegerEvidenceValue(value: string | undefined): number | null {
  if (value === undefined || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** A canonical positive integer: the machine is in a running processing window. */
function positiveIntegerEvidence(value: string | undefined): number | null {
  const number = integerEvidenceValue(value);
  return number !== null && number > 0 ? number : null;
}

function hasBoundedNonemptyEvidenceValue(value: string | undefined): value is string {
  return hasOpaqueEvidenceValue(value);
}

/** `none` is an explicit producer literal only for the absent equipped tool. */
function isToolSelectionBeforeValue(value: string | undefined): value is string {
  return value === "none" || hasOpaqueEvidenceValue(value);
}

function hasTileEvidenceValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const match = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(value);
  return match !== null && Number(match[1]) <= 1000 && Number(match[2]) <= 1000;
}

function hasOpaqueEvidenceValue(value: string | undefined): value is string {
  // Opaque native values may have game-specific grammar, but protocol scalar
  // sentinels are never meaningful evidence of a materialized object.
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !["none", "null", "undefined", "true", "false", "nan", "infinity"].includes(value.toLowerCase())
  );
}

function hasOpaqueIdEvidenceValue(value: string | undefined): value is string {
  // Preserve the stricter identity grammar, while rejecting every protocol
  // scalar/sentinel spelling already rejected for opaque non-ID evidence.
  return hasOpaqueEvidenceValue(value) && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Stardew multiplayer IDs can exceed JavaScript's safe integer range. */
function hasDecimalOwnerIdEvidenceValue(value: string | undefined): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value);
}

function parseStardewReceipt(details: unknown): IntegrationExecutionReceipt | null {
  if (!isRecord(details) || typeof details.receiptJson !== "string") return null;
  try {
    const value = JSON.parse(details.receiptJson) as unknown;
    if (
      !isRecord(value) ||
      typeof value.requestId !== "string" ||
      typeof value.executionId !== "string" ||
      typeof value.actionId !== "string" ||
      typeof value.state !== "string" ||
      typeof value.reasonCode !== "string"
    )
      return null;
    return {
      requestId: value.requestId,
      executionId: value.executionId,
      actionId: value.actionId,
      state: value.state,
      reasonCode: value.reasonCode,
      revision: typeof value.revision === "number" ? value.revision : null,
      evidence: isRecord(value.evidence) ? value.evidence : null,
      // A recovered receipt carries the same notices the live one did, validated
      // with the wire's bound so a malformed journal entry is dropped rather than
      // forwarded to the Agent.
      ...(isNativeNoticeList(value.nativeNotices) ? { nativeNotices: value.nativeNotices } : {}),
    };
  } catch {
    return null;
  }
}

/** The wire bound for notice lists, mirrored so a recovered receipt is validated too. */
function isNativeNoticeList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 8 &&
    value.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 512)
  );
}

function toIntegrationReceipt(receipt: ExecutionReceipt): IntegrationExecutionReceipt {
  return {
    requestId: receipt.requestId,
    executionId: receipt.executionId,
    actionId: receipt.actionId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    evidence: receipt.evidence,
    // Forwarded only when present: an absent field means the window captured no
    // notice, which is a different fact from an empty one.
    ...(receipt.nativeNotices == null ? {} : { nativeNotices: receipt.nativeNotices }),
  };
}

function isKnowledgeBundle(value: unknown): value is KnowledgeBundle {
  return typeof value === "object" && value !== null && (value as { bundleVersion?: unknown }).bundleVersion === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
