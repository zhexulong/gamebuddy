import { createHash } from "node:crypto";

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function locator(source, relativePath, startByte, endByte) {
  const bytes = Buffer.from(source, "utf8");
  return Object.freeze({
    relativePath,
    startByte,
    endByte,
    sliceSha256: sha256(bytes.subarray(startByte, endByte)),
    sourceFileSha256: sha256(bytes),
  });
}
function byteIndex(source, characterIndex) {
  return Buffer.byteLength(source.slice(0, characterIndex), "utf8");
}
function uniqueIndex(source, needle, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0)
    fail("normal_player_ingress_anchor_missing", `Expected exactly one ${label} anchor.`, { needle });
  return first;
}
function method(source, relativePath, signature, label = signature) {
  const start = uniqueIndex(source, signature, label);
  const brace = source.indexOf("{", start + signature.length);
  if (brace < 0) fail("normal_player_ingress_method_malformed", `Missing opening brace for ${label}.`);
  let depth = 0;
  let state = "code";
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "string") {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === '"') state = "code";
      continue;
    }
    if (char === "/" && next === "/") {
      state = "line";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block";
      index += 1;
      continue;
    }
    if (char === '"') {
      state = "string";
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0)
      return locator(source, relativePath, byteIndex(source, start), byteIndex(source, index + 1));
  }
  fail("normal_player_ingress_method_malformed", `Unclosed method ${label}.`);
}
function occurrenceWithin(source, relativePath, owner, needle, label) {
  const bytes = Buffer.from(source, "utf8");
  const body = bytes.subarray(owner.startByte, owner.endByte);
  const token = Buffer.from(needle, "utf8");
  const first = body.indexOf(token);
  if (first < 0 || body.indexOf(token, first + token.length) >= 0)
    fail("normal_player_ingress_anchor_missing", `Expected exactly one ${label} anchor inside its source owner.`, {
      needle,
    });
  return locator(source, relativePath, owner.startByte + first, owner.startByte + first + token.length);
}
function sourceFile(sourceFiles, relativePath) {
  const source = sourceFiles[relativePath];
  if (!source?.text) fail("normal_player_ingress_source_missing", `Missing exact source file ${relativePath}.`);
  return source.text;
}

/**
 * Derive a deliberately partial control-router register from exact source.
 * It proves only direct, native input dispatch facts; every unexpanded
 * branch/hook remains a blocking gap. It never labels an action or primitive.
 */
export function deriveNativeNormalPlayerControlSlice({ sourceFiles, attestation }) {
  const gamePath = "StardewValley/Game1.cs";
  const farmerPath = "StardewValley/Farmer.cs";
  const game = sourceFile(sourceFiles, gamePath);
  const farmer = sourceFile(sourceFiles, farmerPath);
  const update = method(game, gamePath, "protected override void Update(GameTime gameTime)", "Game1.Update");
  const updateInternal = method(game, gamePath, "private void _update(GameTime gameTime)", "Game1._update");
  const control = method(game, gamePath, "private void UpdateControlInput(GameTime time)", "Game1.UpdateControlInput");
  const pressAction = method(
    game,
    gamePath,
    "public static bool pressActionButton(KeyboardState currentKBState, MouseState currentMouseState, GamePadState currentPadState)",
    "Game1.pressActionButton",
  );
  const pressUse = method(game, gamePath, "public static bool pressUseToolButton()", "Game1.pressUseToolButton");
  const pressSwitch = method(
    game,
    gamePath,
    "public static void pressSwitchToolButton()",
    "Game1.pressSwitchToolButton",
  );
  const fireTool = method(farmer, farmerPath, "public void FireTool()", "Farmer.FireTool");
  const move = method(farmer, farmerPath, "public void setMoving(byte command)", "Farmer.setMoving");
  const callUpdateInternal = occurrenceWithin(
    game,
    gamePath,
    update,
    "_update(gameTime2);",
    "Game1.Update -> _update call",
  );
  const callControl = occurrenceWithin(
    game,
    gamePath,
    updateInternal,
    "UpdateControlInput(gameTime);",
    "Game1._update -> UpdateControlInput call",
  );
  const keyboardRead = occurrenceWithin(
    game,
    gamePath,
    control,
    "GetKeyboardState();",
    "Game1.UpdateControlInput keyboard read",
  );
  const actionCall = occurrenceWithin(
    game,
    gamePath,
    control,
    "pressActionButton(currentKBState, currentMouseState, currentPadState)",
    "Game1 control action dispatch",
  );
  const toolCall = occurrenceWithin(game, gamePath, control, "pressUseToolButton()", "Game1 control tool dispatch");
  const switchCall = occurrenceWithin(
    game,
    gamePath,
    control,
    "pressSwitchToolButton();",
    "Game1 control switch dispatch",
  );
  const fireCall = occurrenceWithin(game, gamePath, control, "player.FireTool();", "Game1 control fire-tool dispatch");
  const movingCall = occurrenceWithin(
    game,
    gamePath,
    control,
    "player.setMoving(1);",
    "Game1 control movement dispatch",
  );
  const hook = occurrenceWithin(
    game,
    gamePath,
    control,
    "hooks.OnGame1_UpdateControlInput(",
    "Game1 control hook boundary",
  );
  const dynamicUi = occurrenceWithin(
    game,
    gamePath,
    control,
    "CurrentEvent?.receiveMouseClick",
    "Game1 event dynamic dispatch",
  );
  const guard = occurrenceWithin(
    game,
    gamePath,
    control,
    "if (actionButtonPressed || (dialogueUp && useToolButtonPressed))",
    "Game1 action input guard",
  );
  const toolGuard = occurrenceWithin(
    game,
    gamePath,
    control,
    "if (useToolButtonPressed && (!player.UsingTool || player.CurrentTool is MeleeWeapon)",
    "Game1 tool input guard",
  );
  const switchGuard = occurrenceWithin(
    game,
    gamePath,
    control,
    "if (switchToolButtonPressed && !player.UsingTool",
    "Game1 switch input guard",
  );
  const moveGuard = occurrenceWithin(
    game,
    gamePath,
    control,
    "else if (pauseTime <= 0f && locationRequest == null",
    "Game1 movement input guard",
  );
  const gaps = [
    {
      gapId: "gap:game1-control-hook",
      sourceLocator: hook,
      kind: "unresolved_delegate_target",
      blocksRootClosure: true,
    },
    {
      gapId: "gap:game1-control-uninventoried-exits",
      sourceLocator: control,
      kind: "uninventoried_router_exit",
      blocksRootClosure: true,
    },
    {
      gapId: "gap:game1-event-receiver",
      sourceLocator: dynamicUi,
      kind: "unresolved_virtual_target",
      blocksRootClosure: true,
    },
  ];
  const callerEdges = [
    {
      edgeId: "edge:update-to-internal",
      callerDeclaration: update,
      callsite: callUpdateInternal,
      dispatchKind: "direct",
      targetDeclaration: updateInternal,
      inputProvenance: "not_proven",
      guardLocators: [],
      targetResolutionState: "resolved",
    },
    {
      edgeId: "edge:internal-to-control",
      callerDeclaration: updateInternal,
      callsite: callControl,
      dispatchKind: "direct",
      targetDeclaration: control,
      inputProvenance: "not_proven",
      guardLocators: [],
      targetResolutionState: "resolved",
    },
    {
      edgeId: "edge:control-to-action",
      callerDeclaration: control,
      callsite: actionCall,
      dispatchKind: "direct",
      targetDeclaration: pressAction,
      inputProvenance: "input_derived_branch",
      guardLocators: [guard],
      targetResolutionState: "resolved",
    },
    {
      edgeId: "edge:control-to-fire-tool",
      callerDeclaration: control,
      callsite: fireCall,
      dispatchKind: "direct",
      targetDeclaration: fireTool,
      inputProvenance: "input_derived_branch",
      guardLocators: [toolGuard],
      targetResolutionState: "resolved",
    },
    {
      edgeId: "edge:control-to-use-tool",
      callerDeclaration: control,
      callsite: toolCall,
      dispatchKind: "direct",
      targetDeclaration: pressUse,
      inputProvenance: "input_derived_branch",
      guardLocators: [toolGuard],
      targetResolutionState: "resolved",
    },
    {
      edgeId: "edge:control-to-switch-tool",
      callerDeclaration: control,
      callsite: switchCall,
      dispatchKind: "direct",
      targetDeclaration: pressSwitch,
      inputProvenance: "input_derived_branch",
      guardLocators: [switchGuard],
      targetResolutionState: "resolved",
    },
    {
      edgeId: "edge:control-to-movement",
      callerDeclaration: control,
      callsite: movingCall,
      dispatchKind: "direct",
      targetDeclaration: move,
      inputProvenance: "input_derived_branch",
      guardLocators: [moveGuard],
      targetResolutionState: "resolved",
    },
  ];
  const path = ["edge:update-to-internal", "edge:internal-to-control"];
  return {
    schemaVersion: 1,
    artifactKind: "native_normal_player_ingress_and_caller_register",
    attestation,
    scope: {
      actor: "current_normal_local_player",
      inputMode: "native_game_input",
      excludedModes: ["npc_or_ai_initiated", "remote_player_message_only", "test_or_debug_only", "mod_external_only"],
    },
    entrypoints: [
      {
        entrypointId: "entrypoint:game1-update-control-input",
        declaration: control,
        entrypointKind: "source_called_input_router",
        callerFact: "exact_source_callsite",
        callerLocator: callControl,
        inputWitnesses: [{ kind: "input_state_read", locator: keyboardRead }],
      },
    ],
    callerEdges,
    routerExitInventories: [
      {
        routerId: "router:game1-update-control-input",
        routerDeclaration: control,
        edgeIdsInSourceOrder: callerEdges.slice(2).map((edge) => edge.edgeId),
        inventoryState: "partial",
        gapIds: gaps.map((gap) => gap.gapId),
      },
    ],
    roots: [
      {
        rootId: "root:game1-press-action",
        declaration: pressAction,
        rootKind: "direct_input_dispatch_target",
        predecessorEdgeIds: ["edge:control-to-action"],
        ingressPath: {
          entrypointId: "entrypoint:game1-update-control-input",
          orderedEdgeIds: [...path, "edge:control-to-action"],
        },
        selectionWitness: { firstInputDispatchEdgeId: "edge:control-to-action", dispatchGuardLocators: [guard] },
        incomingCallerInventory: "partial_with_gap",
        disposition: "normal_player_root",
      },
      {
        rootId: "root:game1-press-use-tool",
        declaration: pressUse,
        rootKind: "direct_input_dispatch_target",
        predecessorEdgeIds: ["edge:control-to-use-tool"],
        ingressPath: {
          entrypointId: "entrypoint:game1-update-control-input",
          orderedEdgeIds: [...path, "edge:control-to-use-tool"],
        },
        selectionWitness: { firstInputDispatchEdgeId: "edge:control-to-use-tool", dispatchGuardLocators: [toolGuard] },
        incomingCallerInventory: "partial_with_gap",
        disposition: "normal_player_root",
      },
      {
        rootId: "root:game1-press-switch-tool",
        declaration: pressSwitch,
        rootKind: "direct_input_dispatch_target",
        predecessorEdgeIds: ["edge:control-to-switch-tool"],
        ingressPath: {
          entrypointId: "entrypoint:game1-update-control-input",
          orderedEdgeIds: [...path, "edge:control-to-switch-tool"],
        },
        selectionWitness: {
          firstInputDispatchEdgeId: "edge:control-to-switch-tool",
          dispatchGuardLocators: [switchGuard],
        },
        incomingCallerInventory: "partial_with_gap",
        disposition: "normal_player_root",
      },
      {
        rootId: "root:farmer-fire-tool",
        declaration: fireTool,
        rootKind: "direct_input_dispatch_target",
        predecessorEdgeIds: ["edge:control-to-fire-tool"],
        ingressPath: {
          entrypointId: "entrypoint:game1-update-control-input",
          orderedEdgeIds: [...path, "edge:control-to-fire-tool"],
        },
        selectionWitness: { firstInputDispatchEdgeId: "edge:control-to-fire-tool", dispatchGuardLocators: [toolGuard] },
        incomingCallerInventory: "partial_with_gap",
        disposition: "normal_player_root",
      },
      {
        rootId: "root:farmer-set-moving",
        declaration: move,
        rootKind: "direct_input_dispatch_target",
        predecessorEdgeIds: ["edge:control-to-movement"],
        ingressPath: {
          entrypointId: "entrypoint:game1-update-control-input",
          orderedEdgeIds: [...path, "edge:control-to-movement"],
        },
        selectionWitness: { firstInputDispatchEdgeId: "edge:control-to-movement", dispatchGuardLocators: [moveGuard] },
        incomingCallerInventory: "partial_with_gap",
        disposition: "normal_player_root",
      },
    ],
    gaps,
    analysisBoundary: {
      normalPlayerIngressCallerRecovery: "partial_control_router_slice",
      sourceOwnerResolution: "not_performed",
      transitionDerivation: "not_performed",
      primitiveDerivation: "not_performed",
      playerOperationDerivation: "not_performed",
      publicActionProjection: "not_performed",
    },
  };
}
