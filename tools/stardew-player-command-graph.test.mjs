import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyIngressReachableCall,
  classifyWorldDispatcherCall,
} from "./lib/stardew-player-command-classification.mjs";
import {
  buildPlayerCommandGraph,
  extractDirectCallEdges,
  extractPlayerIngressRoots,
  game1PressUseToolButtonBranchCandidates,
  gameLocationCheckActionBranchCandidates,
  gameLocationPerformActionSelectorCandidates,
  toolBeginUsingBranchCandidates,
  toolEndUsingBranchCandidates,
  toolOverrideBranchCandidates,
} from "./lib/stardew-player-command-graph.mjs";

const updateControlInput = `
  private void UpdateControlInput(GameTime time) {
    bool actionButtonPressed = false;
    bool switchToolButtonPressed = false;
    bool useToolButtonPressed = false;
    bool useToolButtonReleased = false;
    bool moveUpHeld = false;
    bool moveRightHeld = false;
    bool moveDownHeld = false;
    bool moveLeftHeld = false;
    if (actionButtonPressed) {
      CurrentEvent?.receiveMouseClick(1, 2);
      active_menu.receiveLeftClick(getMouseX(), getMouseY());
      active_menu.receiveRightClick(getMouseX(), getMouseY());
      active_menu.receiveKeyPress(Keys.Enter);
      pressActionButton(currentKBState, currentMouseState, currentPadState);
    }
    if (useToolButtonPressed) pressUseToolButton();
    if (useToolButtonReleased) player.EndUsingTool();
    if (switchToolButtonPressed) pressSwitchToolButton();
    if (moveUpHeld || moveRightHeld || moveDownHeld || moveLeftHeld) player.setMoving(1);
  }
  private static void updateActiveMenu(GameTime time) {
    active_menu.receiveLeftClick(getMouseX(), getMouseY());
    active_menu.receiveRightClick(getMouseX(), getMouseY());
    active_menu.receiveKeyPress(Keys.Enter);
  }
  private static void updateTextEntry(GameTime time) {
    textEntry.receiveKeyPress(Keys.Enter);
    textEntry.receiveGamePadButton(Buttons.A);
  }
  private void _update(GameTime time) {
    currentMinigame.receiveKeyPress(Keys.Left);
    currentMinigame.tick(gameTime);
  }
`;

const gameLocationSource = `
  public virtual bool checkAction(Location tileLocation, Rectangle viewport, Farmer who) {
    foreach (Building building in buildings) {
      if (building.doAction(tile, who)) {
        return true;
      }
    }
    if (character.checkAction(who, this)) return true;
    if (value.checkForAction(who)) return true;
    if (value.isSpawnedObject.Value || isErrorItem) {
      if (value.isForage() && who.couldInventoryAcceptThisItem(value)) {
        who.addItemToInventoryBool(value.getOne());
        objects.Remove(vector);
        return true;
      }
    }
    return performAction(mapAction, who, tileLocation);
  }
`;

test("extracts all declared normal-player ingress roots from the target control-router shape", () => {
  const result = extractPlayerIngressRoots(updateControlInput);
  assert.equal(result.state, "extracted");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.ingressRoots.map((root) => root.ingressId),
    [
      "world_action_interaction",
      "world_tool_use",
      "world_tool_release",
      "inventory_toolbar_selection",
      "world_movement",
      "menu_semantic_selection",
      "event_dialogue_or_choice",
      "text_chat_submission",
      "minigame_continuous_control",
    ],
  );
  assert.ok(result.ingressRoots.every((root) => root.classification === "command_path_candidate"));
  assert.ok(result.ingressRoots.every((root) => root.prcpId === null && root.route === null));
});

test("marks a missing ingress branch as unknown rather than treating it as unavailable", () => {
  const result = extractPlayerIngressRoots(updateControlInput.replace("pressUseToolButton();", "/* removed */"));
  const toolUse = result.ingressRoots.find((root) => root.ingressId === "world_tool_use");
  assert.equal(result.state, "incomplete");
  assert.equal(toolUse.classification, "unknown");
  assert.deepEqual(toolUse.missingFragments, ["pressUseToolButton()"]);
});

test("reports command roots as pending candidates until their dispatch and native boundary are reconstructed", () => {
  const graph = buildPlayerCommandGraph(updateControlInput);
  assert.equal(graph.state, "partial");
  assert.equal(graph.commandPaths.length, 0);
  // Root-target candidates have direct control-router provenance; unexpanded
  // dispatcher bodies do not fabricate additional non-root routes.
  assert.equal(graph.commandPathCandidates.length, 6);
  assert.ok(graph.commandPathCandidates.every((candidate) => candidate.sourceEdgeIds.length > 0));
  assert.ok(
    graph.commandPathCandidates.every(
      (candidate) => candidate.status === "boundary_candidate" && candidate.nativeRuleBoundaryCandidate.length > 0,
    ),
  );
  assert.ok(graph.reachableEdges.length > 7);
  assert.ok(graph.reachableEdges.some((edge) => edge.classification === "candidate_dispatch_edge"));
  assert.ok(graph.reachableEdges.some((edge) => edge.classification === "supporting_path"));
  assert.equal(graph.pendingCommandCandidates.length, 9);
  assert.ok(
    graph.pendingCommandCandidates.every(
      (candidate) => Number.isInteger(candidate.candidateEdgeCount) && candidate.candidateEdgeCount >= 0,
    ),
  );
  assert.ok(graph.pendingCommandCandidates.some((candidate) => candidate.candidateEdgeCount > 0));
  assert.equal(graph.unknownReachableEdges.length, 0);
  assert.match(graph.note, /not input-injection routes/);
});

test("walks the first Game1 dispatch hop when target methods are present in the source reconstruction", () => {
  const source = `${updateControlInput}
    private bool pressActionButton() { return tryToCheckAt(tile, player); }
    private bool pressUseToolButton() { return currentLocation.checkAction(tile, viewport, player); }
    private void pressSwitchToolButton() { player.setMoving(64); }
  `;
  const graph = buildPlayerCommandGraph(source, {
    sourceIndex: {
      "StardewValley.GameLocation": { source: gameLocationSource, sourceFile: "StardewValley/GameLocation.cs" },
    },
  });
  assert.ok(graph.reachableEdges.some((edge) => edge.to === "tryToCheckAt"));
  assert.ok(graph.reachableEdges.some((edge) => edge.to === "currentLocation.checkAction"));
  assert.ok(graph.reachableEdges.some((edge) => edge.to === "player.setMoving"));
  assert.ok(
    graph.reachableEdges.some((edge) => edge.to === "building.doAction" && edge.sourceMethod === "checkAction"),
  );
  assert.ok(
    graph.reachableEdges.some(
      (edge) => edge.to === "performAction" && edge.sourceFile === "StardewValley/GameLocation.cs",
    ),
  );
  const worldCheck = graph.commandPathCandidates.find(
    (candidate) => candidate.candidateId === "world_tool_use.world.check_action",
  );
  assert.ok(worldCheck);
  assert.ok(
    worldCheck.sourceEdgeIds.some((edgeId) => edgeId.includes("pressUseToolButton->currentLocation.checkAction")),
  );
  const buildingAction = graph.commandPathCandidates.find(
    (candidate) => candidate.candidateId === "world_action_interaction.building.do_action",
  );
  assert.ok(buildingAction);
  assert.ok(
    buildingAction.sourceEdgeIds.some((edgeId) => edgeId.includes("GameLocation.checkAction->building.doAction")),
  );
  const foragePickup = graph.commandPathCandidates.find(
    (candidate) => candidate.candidateId === "forage.pickup_spawned_object",
  );
  assert.ok(foragePickup);
  assert.equal(foragePickup.sourceEvidence.sourceMethod, "checkAction");
  assert.ok(foragePickup.sourceEvidence.requiredFragments.includes("objects.Remove(vector)"));
});

test("splits target-version GameLocation.checkAction into separately evidenced source branch candidates", () => {
  const source = `${updateControlInput}
    private bool pressActionButton() { return tryToCheckAt(tile, player); }
  `;
  const graph = buildPlayerCommandGraph(source, {
    sourceIndex: {
      "StardewValley.GameLocation": { source: gameLocationSource, sourceFile: "StardewValley/GameLocation.cs" },
    },
  });
  // The small fixture source only contains two branch shapes; discovery must
  // report those exact source branches, not fabricate all catalog definitions.
  const ids = graph.commandPathCandidates.map((candidate) => candidate.candidateId);
  assert.ok(ids.includes("building.action_at_tile"));
  assert.ok(ids.includes("forage.pickup_spawned_object"));
  assert.ok(!ids.includes("npc.action_at_tile"));
  assert.equal(new Set(ids).size, ids.length, "each source branch candidate ID must be unique");
  for (const candidate of graph.commandPathCandidates.filter((candidate) =>
    ["building.action_at_tile", "forage.pickup_spawned_object"].includes(candidate.candidateId),
  )) {
    assert.equal(candidate.status, "boundary_candidate");
    assert.equal(candidate.route, null);
    assert.equal(candidate.sourceEvidence.sourceMethod, "checkAction");
    assert.ok(candidate.sourceEvidence.branchRange.end > candidate.sourceEvidence.branchRange.start);
    assert.deepEqual(candidate.sourceEdgeIds, [
      "StardewValley.Game1.tryToCheckAt->StardewValley.GameLocation.checkAction",
    ]);
  }
});

test("splits source-proved tool-use branches without treating Tool.DoFunction as one generic command", () => {
  const source = `${updateControlInput}
    private bool pressUseToolButton() {
      if (player.UsingTool) { player.CurrentTool.DoFunction(player.currentLocation, 1, 2, 1, player); return true; }
      if (player.ActiveObject != null) { Vector2 target = Utility.GetNearbyValidPlacementPosition(player, currentLocation, player.ActiveObject, 1, 2); if (Utility.tryToPlaceItem(currentLocation, player.ActiveObject, 1, 2)) return true; }
      if (player.ActiveObject == null && player.CurrentTool != null) { player.BeginUsingTool(); }
      return false;
    }
  `;
  const ingress = extractPlayerIngressRoots(source);
  const edges = extractDirectCallEdges(source, "pressUseToolButton", {
    ingressId: "world_tool_use",
    dispatcherClassification: true,
  });
  const candidates = game1PressUseToolButtonBranchCandidates(source, edges, ingress);
  assert.deepEqual(candidates.map((candidate) => candidate.candidateId).sort(), [
    "item.place_at_valid_target",
    "tool.begin_using_at_position",
    "tool.continue_using_at_position",
  ]);
  for (const candidate of candidates) {
    assert.equal(candidate.status, "boundary_candidate");
    assert.equal(candidate.route, null);
    assert.equal(candidate.sourceEvidence.sourceMethod, "pressUseToolButton");
  }
});

test("expands dynamic tool dispatch into concrete override candidates rather than a generic Tool.DoFunction route", () => {
  const source = `${updateControlInput}
    private bool pressUseToolButton() {
      if (player.UsingTool) { player.CurrentTool.DoFunction(player.currentLocation, 1, 2, 1, player); return true; }
      if (player.ActiveObject == null && player.CurrentTool != null) { player.BeginUsingTool(); }
      return false;
    }
  `;
  const ingress = extractPlayerIngressRoots(source);
  const edges = extractDirectCallEdges(source, "pressUseToolButton", {
    ingressId: "world_tool_use",
    dispatcherClassification: true,
  });
  const candidates = toolOverrideBranchCandidates(
    {
      "StardewValley.Tools.Hoe": {
        sourceFile: "StardewValley/Tools/Hoe.cs",
        source: `public class Hoe {
      public override void DoFunction() { if (location.makeHoeDirt(item)) { location.checkForBuriedItem(1, 2, explosion: false, detectOnly: false, who); } }
    }`,
      },
      "StardewValley.Tools.Pan": {
        sourceFile: "StardewValley/Tools/Pan.cs",
        source: `public class Pan {
      public override void DoFunction() { who.addItemsByMenuIfNecessary(getPanItems(location, who)); location.orePanPoint.Value = Point.Zero; }
    }`,
      },
    },
    edges,
    ingress,
  );
  assert.deepEqual(candidates.map((candidate) => candidate.candidateId).sort(), [
    "hoe.till_diggable_tile",
    "pan.collect_ore_pan_point",
  ]);
  for (const candidate of candidates) {
    assert.equal(candidate.status, "boundary_candidate");
    assert.equal(candidate.route, null);
    assert.ok(candidate.sourceEdgeIds.some((edgeId) => edgeId.includes("pressUseToolButton")));
  }
});

test("expands source-proved tool begin into the FishingRod timing phase", () => {
  const source = `${updateControlInput}\nprivate bool pressUseToolButton() { if (player.ActiveObject == null && player.CurrentTool != null) player.BeginUsingTool(); return true; }`;
  const ingress = extractPlayerIngressRoots(source);
  const beginEdges = [
    {
      ingressId: "world_tool_use",
      to: "StardewValley.Tool.beginUsing",
      edgeId: "Farmer.performBeginUsingTool->StardewValley.Tool.beginUsing",
    },
  ];
  const candidates = toolBeginUsingBranchCandidates(
    {
      "StardewValley.Tools.FishingRod": {
        sourceFile: "StardewValley/Tools/FishingRod.cs",
        source: `public class FishingRod {
      public override bool beginUsing() { who.UsingTool = true; isTimingCast = true; who.canReleaseTool = false; setTimingCastAnimation(who); return true; }
    }`,
      },
    },
    beginEdges,
    ingress,
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.candidateId),
    ["fishing_rod.begin_cast_timing"],
  );
  assert.equal(candidates[0].route, null);
});

test("expands tool release into FishingRod cast without treating every endUsing lifecycle helper as a command", () => {
  const source = `${updateControlInput}\nprivate void UpdateControlInput() { useToolButtonReleased; player.EndUsingTool(); }`;
  const ingress = extractPlayerIngressRoots(source);
  const releaseEdges = [
    {
      ingressId: "world_tool_release",
      to: "StardewValley.Tool.endUsing",
      edgeId: "Farmer.performEndUsingTool->StardewValley.Tool.endUsing",
    },
  ];
  const candidates = toolEndUsingBranchCandidates(
    {
      "StardewValley.Tool": {
        sourceFile: "StardewValley/Tool.cs",
        source: `public class Tool {
      public virtual void endUsing() {
        who.canReleaseTool = false;
        if (this is FishingRod fishingRod && who.IsLocalPlayer && Game1.activeClickableMenu == null) {
          if (!fishingRod.hit) DoFunction(who.currentLocation, 1, 2, 1, who);
        }
        else if (!(this is MeleeWeapon)) { animate(); }
      }
    }`,
      },
    },
    releaseEdges,
    ingress,
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.candidateId),
    ["fishing_rod.cast_on_tool_release"],
  );
  assert.ok(candidates.every((candidate) => candidate.route === null && candidate.status === "boundary_candidate"));
});

test("does not claim a combat DoDamage override from the ordinary tool-use path without a source-proved dispatch edge", () => {
  const source = `${updateControlInput}
    private bool pressUseToolButton() { if (player.UsingTool) player.CurrentTool.DoFunction(player.currentLocation, 1, 2, 1, player); return true; }
  `;
  const ingress = extractPlayerIngressRoots(source);
  const edges = extractDirectCallEdges(source, "pressUseToolButton", {
    ingressId: "world_tool_use",
    dispatcherClassification: true,
  });
  const candidates = toolOverrideBranchCandidates(
    {
      "StardewValley.Tools.MeleeWeapon": {
        sourceFile: "StardewValley/Tools/MeleeWeapon.cs",
        source: `public class MeleeWeapon {
      public virtual void DoDamage() { if (location.damageMonster(areaOfEffect, 1, 2, false, 1, 1, 1, 1, false, who)) { } }
    }`,
      },
    },
    edges,
    ingress,
  );
  assert.deepEqual(candidates, []);
});

test("expands a source-proved map Action branch into literal selector candidates without a raw dispatcher route", () => {
  const source = `
    public virtual bool performAction(string[] action, Farmer who, Location tileLocation) {
      string value = action[0];
      switch (value) {
        case "Mine": return true;
        case "Town": return true;
      }
      return false;
    }
  `;
  const selectors = gameLocationPerformActionSelectorCandidates(
    { typeName: "StardewValley.GameLocation", sourceFile: "StardewValley/GameLocation.cs", source },
    [{ candidateId: "map.action_property" }],
  );
  assert.deepEqual(
    selectors.map((candidate) => candidate.candidateId),
    ["map.action_property.case.literal.Mine", "map.action_property.case.literal.Town"],
  );
  for (const candidate of selectors) {
    assert.equal(candidate.route, null);
    assert.equal(candidate.status, "boundary_candidate");
    assert.equal(candidate.sourceEvidence.parentCandidateId, "map.action_property");
    assert.equal(candidate.sourceEvidence.branchKind, "literal_operation_selector");
  }
  assert.deepEqual(
    gameLocationPerformActionSelectorCandidates(
      { typeName: "StardewValley.GameLocation", sourceFile: "StardewValley/GameLocation.cs", source },
      [],
    ),
    [],
  );
});

test("rejects a source-fragment conjunction when branch fragments belong to different branches", () => {
  const splitBranches = `
    public virtual bool checkAction(Location tileLocation, Rectangle viewport, Farmer who) {
      if (value.isSpawnedObject.Value || isErrorItem) { if (value.isForage()) return true; }
      if (who.couldInventoryAcceptThisItem(value)) { who.addItemToInventoryBool(value.getOne()); }
      objects.Remove(vector);
      return false;
    }
  `;
  const ingress = extractPlayerIngressRoots(updateControlInput);
  const roots = [{ ingressId: "world_action_interaction", to: "tryToCheckAt" }];
  const candidates = gameLocationCheckActionBranchCandidates(
    { typeName: "StardewValley.GameLocation", sourceFile: "StardewValley/GameLocation.cs", source: splitBranches },
    roots,
    ingress,
  );
  assert.equal(candidates.length, 0);
});

test("classifies only known continuous helpers as supporting and retains unknown calls unresolved", () => {
  assert.deepEqual(classifyIngressReachableCall("currentMinigame.tick"), {
    classification: "supporting_path",
    reason: "native_lifecycle_or_continuous_control_progression",
  });
  assert.equal(classifyIngressReachableCall("currentLocation.checkAction"), null);
  assert.equal(classifyIngressReachableCall("player.EndUsingTool"), null);
  assert.deepEqual(classifyWorldDispatcherCall("pressUseToolButton", "getOldMouseX"), {
    classification: "supporting_path",
    reason: "target_resolution_or_native_tool_setup",
  });
  assert.equal(classifyWorldDispatcherCall("pressUseToolButton", "currentLocation.checkAction"), null);
  assert.equal(classifyWorldDispatcherCall("pressActionButton", "Utility.tryToPlaceItem"), null);
});

test("extracts direct calls as candidate edges without mistaking language keywords for native calls", () => {
  const edges = extractDirectCallEdges(
    `
    private void pressActionButton() {
      if (ready) currentLocation.checkAction(tile, viewport, player);
      foreach (var animal in animals) animal.pet(player);
      return;
    }
  `,
    "pressActionButton",
  );
  assert.deepEqual(
    edges.map((edge) => edge.to),
    ["animal.pet", "currentLocation.checkAction"],
  );
  assert.ok(edges.every((edge) => edge.classification === "candidate_dispatch_edge"));
});

test("fails closed when the Game1 control-router itself cannot be located", () => {
  const graph = buildPlayerCommandGraph("public void OtherMethod() { }");
  assert.equal(graph.state, "unknown");
  assert.equal(graph.ingressRoots.length, 0);
  assert.match(graph.errors[0], /UpdateControlInput could not be located/);
});
