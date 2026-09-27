/**
 * Stardew source-analysis vocabulary.
 *
 * This file is the single home for every Stardew-specific name the source-analysis
 * tools rely on: native interaction shapes, the player-input roots, menu signals,
 * gameplay field classifiers, and the curated semantic-equivalence table.
 *
 * Why it lives here rather than in `tools/`: these are **game facts**, not devkit
 * facts. `95_CROSS_GAME_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md` states the
 * devkit must not make "Stardew world facts, tiles, locations, tools, warps, or
 * fixtures portable to another game" and must not become "a cross-game action
 * taxonomy". A second game adapter supplies its own equivalent module; nothing here
 * should be generalised into the shared devkit.
 *
 * Every value is derived from the target-version decompiled tree
 * (`ref/external/StardewValleyDecompiled/Stardew Valley`) and was verified by running
 * the tools against it. Changing a value here changes what the tools can find, so each
 * block records how it was validated.
 */

// ---------------------------------------------------------------------------
// Native interaction shapes
// ---------------------------------------------------------------------------

/**
 * Method names that can carry a player-visible native mutation.
 *
 * Union of two sources, both required:
 *   ① shape names found by reading the target tree (the base set)
 *   ② method names appearing as registered action seams (so a registered seam can
 *      never be missed even if its name is not one of the obvious shapes)
 *
 * `leftClick`/`leftClicked`/`clicked` were added after tracing
 * `Game1.pressUseToolButton → GameLocation.leftClick → Building.leftClicked`:
 * `ShippingBin.leftClicked()` is the **menu-free** shipping entry point, and the
 * earlier hand-written list missed the whole family.
 */
export const STARDEW_INTERACTION_SHAPES = Object.freeze([
  "checkAction",
  "performAction",
  "performToolAction",
  "performUseAction",
  "performObjectDropInAction",
  "placementAction",
  "DoFunction",
  "checkForAction",
  "rotate",
  "animateSpecialMove",
  "receiveGift",
  "addItem",
  "collect",
  "eatObject",
  "shipItem",
  "createItem",
  "warpFarmer",
  "tryToCheckAt",
  "GetItemsForPlayer",
  "getShippingBin",
  "pet",
  "canBePlacedHere",
  "CheckPetAnimal",
  "CheckInspectAnimal",
  "leftClick",
  "leftClicked",
  "clicked",
]);

/** Gameplay-shaped method names, matched against a reachable exit. */
export const STARDEW_GAMEPLAY_SHAPES =
  /^(checkAction|performUseAction|performToolAction|performObjectDropInAction|placementAction|DoFunction|checkForAction|rotate|animateSpecialMove|performAction|pet|receiveGift|addItem|collect|eatObject|canBePlacedHere|shipItem|createItem|warpFarmer|tryToCheckAt|GetItemsForPlayer|getShippingBin|receiveActionPress|receiveRightClick|exitThisMenu|answerDialogueAction)$/;

// ---------------------------------------------------------------------------
// Player input roots
// ---------------------------------------------------------------------------

/**
 * The nine normal-player ingress roots recorded by
 * `17_WHOLE_GAME_SOURCE_FIRST_SEMANTIC_KERNEL_ATLAS.md`, mapped to the native methods
 * each one dispatches through.
 *
 * Indexing the whole tree once is the only expensive step (~7.5s); adding a root costs
 * milliseconds. Covering all nine therefore costs almost nothing and changes results:
 * with only the first two, `CraftingRecipe.createItem` looks unreachable, while
 * `menu_semantic_selection` reaches it in one hop.
 */
export const STARDEW_INGRESS_ROOT_GROUPS = Object.freeze({
  world_action_interaction: ["pressActionButton", "tryToCheckAt"],
  world_tool_use: ["pressUseToolButton", "BeginUsingTool", "FireTool"],
  world_tool_release: ["EndUsingTool"],
  inventory_toolbar_selection: ["shiftToolbar"],
  world_movement: ["setMoving", "UpdateControlInput"],
  menu_semantic_selection: ["receiveLeftClick", "receiveKeyPress", "tryToPurchaseItem", "clickCraftingRecipe"],
  event_dialogue_or_choice: ["answerDialogue"],
  text_chat_submission: ["showTextEntry", "updateTextEntry"],
  minigame_continuous_control: ["updateMinigame"],
});

/** `Check*` shapes are only accepted at the input routing layer (depth 1). */
export const STARDEW_ROUTING_LAYER_SHAPE = /^Check[A-Z]\w*$/;
export const STARDEW_ROUTING_LAYER_DEPTH = 1;

// ---------------------------------------------------------------------------
// Menu binding signals
// ---------------------------------------------------------------------------

/**
 * Menu signals. `Utility.TryOpenShopMenu` is listed explicitly because its name has no
 * `Menu` suffix, so a `new *Menu(` scan alone silently misses every shop.
 */
export const STARDEW_MENU_FIELDS = /Game1\.(activeClickableMenu|currentMinigame|currentMenu)/;
export const STARDEW_MENU_CONSTRUCTOR = /new ([A-Z]\w*Menu)\s*\(/g;
export const STARDEW_MENU_OPENERS = Object.freeze([
  "Utility.TryOpenShopMenu",
  "TryOpenShopMenu",
  "OpenDonationMenu",
  "OpenRewardMenu",
  "OpenShopMenu",
  "ActivateKitchen",
  "createQuestionDialogue",
  "CreateQuestionDialogue",
  "createYesNoResponses",
]);

// ---------------------------------------------------------------------------
// Semantics domains
// ---------------------------------------------------------------------------

/**
 * Native methods that carry a gameplay mutation.
 *
 * `17_` records that the nine ingress roots are source evidence, not a promise that
 * every root reaches the AI Farmhand, and that UI/window injection stays forbidden.
 * Exits outside this set are classified separately so scope decisions stay auditable.
 */
export const STARDEW_GAMEPLAY_MUTATIONS = Object.freeze([
  "checkAction",
  "performAction",
  "performToolAction",
  "performUseAction",
  "performObjectDropInAction",
  "placementAction",
  "DoFunction",
  "checkForAction",
  "rotate",
  "animateSpecialMove",
  "receiveGift",
  "addItem",
  "collect",
  "eatObject",
  "shipItem",
  "createItem",
  "warpFarmer",
  "tryToCheckAt",
  "GetItemsForPlayer",
  "getShippingBin",
  "pet",
  "canBePlacedHere",
  "CheckPetAnimal",
  "CheckInspectAnimal",
]);

export const STARDEW_MENU_UI_EXITS = Object.freeze([
  "exitThisMenu",
  "receiveRightClick",
  "receiveLeftClick",
  "receiveKeyPress",
]);

export const STARDEW_EVENT_DIALOGUE_EXITS = Object.freeze([
  "answerDialogue",
  "answerDialogueAction",
  "receiveActionPress",
]);

/** Query helpers pulled into the call graph by filename, not player exits. */
export const STARDEW_QUERY_HELPER_FILES = /GameStateQuery(Extensions)?\.cs/;

// ---------------------------------------------------------------------------
// Curated semantic equivalence
// ---------------------------------------------------------------------------

/**
 * Exit → already-published action, where the Mod reaches the same player-visible
 * capability through a different entry point.
 *
 * Each entry needs a reason that stands on its own, because the whole point is that
 * the register does not already record this mapping. Entries are added only after
 * reading both the exit and the action's handler.
 */
export const STARDEW_SEMANTIC_EQUIVALENT_EXITS = Object.freeze({
  pet: {
    actions: ["pet_animal"],
    why: "FarmAnimal.pet and Pet.checkAction are the same petting intent; the Mod registers only the latter",
  },
  CheckPetAnimal: {
    actions: ["pet_animal"],
    why: "Game1.pressActionButton's pet routing reaches FarmAnimal.pet, same intent as pet_animal",
  },
  CheckInspectAnimal: {
    actions: ["pet_animal"],
    why: "the already-petted branch of the same routing; still calls FarmAnimal.pet, so not a separate intent",
  },
});

// ---------------------------------------------------------------------------
// Field classification
// ---------------------------------------------------------------------------

/**
 * Visual/timer/input-lock fields. Writing them does not constitute a gameplay
 * terminal state.
 *
 * Deliberately excludes bare `Location` / `TileLocation` / `Position`: for
 * `placementAction` those writes **are** the placement terminal. The earlier deny-list
 * included them and wrongly pushed four placement units into the "not gameplay" tier.
 */
export const STARDEW_NON_GAMEPLAY_FIELDS =
  /^(NeedsUpdate|invincTimer|HitTimerInstance|HitTimer|lidFlapTimer|lidFlapping|jawPosition|xVelocity|yVelocity|layerDepth|scaleChange|rotationChange|facing|Sprite|frame|loop|flicker|lightRadius|lightcolor|startSound|MusicDuckTimer|haltAfterCheck|freezePause|canReleaseTool|CanMove|pingPong|displayType|statueTimer|showWantBubbleTimer|_alreadyAttempingRemoval)$/i;

/** Purely cosmetic fields, recorded but excluded from gameplay effect accounting. */
export const STARDEW_COSMETIC_FIELDS =
  /^(jitterStrength|shakeTimer|shakeRotation|maxShake|flipped|alpha|alphaFade|currentParentTileIndex|IndexOfMenuItemView|delayBeforeAnimationStart|motion|acceleration|scale|rotation)$/i;

/** Actor resource fields: writing them is the action's cost, not its world terminal. */
export const STARDEW_COST_FIELDS = /^(Stamina|waterLeft|WaterLeft|health|Health|Money)$/i;

/** Multiplayer-sensitive token patterns the sensitivity checker derives from source. */
export const STARDEW_MP_REJECT_PATTERN =
  /Context\.IsMultiplayer|!Game1\.IsMasterGame|getAllFarmers\(\)\.Count\(\)\s*!=\s*1|Game1\.server\s+is not null/;
