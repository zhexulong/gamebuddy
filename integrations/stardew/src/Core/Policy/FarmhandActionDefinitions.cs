namespace GameBuddy.Stardew.Core.Policy;

public enum FarmhandActionLifecycle { Published, LiveVerified, Experimental }
public static class FarmhandActionLifecycleWire { public static string ToWireValue(this FarmhandActionLifecycle lifecycle) => lifecycle switch { FarmhandActionLifecycle.Published => "published", FarmhandActionLifecycle.LiveVerified => "live_verified", FarmhandActionLifecycle.Experimental => "experimental", _ => throw new ArgumentOutOfRangeException(nameof(lifecycle)) }; }
public enum FarmhandOperationKind { Execution, ReadOnly }
public static class FarmhandOperationKindWire { public static string ToWireValue(this FarmhandOperationKind kind) => kind switch { FarmhandOperationKind.Execution => "execution", FarmhandOperationKind.ReadOnly => "read_only", _ => throw new ArgumentOutOfRangeException(nameof(kind)) }; }
/// <summary>
/// The symbolic value half of a <see cref="FarmhandActionResourceTemplateClaim"/>. It says what the claim
/// materializes to, never a live identity: the Mod re-derives that on the game thread.
/// </summary>
public enum FarmhandResourceTemplateValue
{
    /// <summary>`embodied_actor`: the current scoped player.</summary>
    ScopePlayer = 1,

    /// <summary>
    /// `tool:&lt;category&gt;`: a tool of that category at ANY upgrade level satisfies the claim; among the owned ones the
    /// best is selected and ties go to the smallest slot.
    ///
    /// <para>
    /// There used to be a `BasicOnly` value here, `(0, 0)`, declared by `chop_tree_source` and `break_rock_source` on the
    /// axe/pickaxe and by `chop_stump` - while `water_crop`, `cut_weeds` and `cut_grass` in the SAME file declared
    /// `AnyUpgrade`. Two spells for one question cannot both be right.
    /// </para>
    /// <para>
    /// The claim's own docblock justified `BasicOnly` by "the native handler refuses an upgraded pickaxe". I checked that
    /// against the game (`ref/external/.../Pickaxe.cs`, `Axe.cs`) and it is false: `Pickaxe` refuses `UpgradeLevel < 2`,
    /// i.e. it demands MORE than basic, and only for `Name.Contains("Boulder")` tiles (Pickaxe.cs:180-190) that the
    /// native breakable-stone category (`Category == -999 && Name == "Stone"`, Object.cs:6082) cannot select; `Axe` has no
    /// upgrade-level refusal at all. So `(0, 0)` admitted exactly the tier the game rejects and
    /// refused every tier it accepts: the two actions would have permanently stopped working the moment a player
    /// upgraded an axe, which is the first week of a normal playthrough.
    /// </para>
    /// <para>
    /// No live run caught it because every run so far starts from level-0 tools - measured 2026-10-30: `toolSlots`
    /// reported `upgradeLevel: 0` for axe, hoe, watering can, pickaxe and scythe. A defect that only appears after an
    /// upgrade is invisible to a harness that never upgrades.
    /// </para>
    /// </summary>
    AnyUpgrade = 2,

    /// <summary>
    /// `tool:&lt;category&gt;`: exactly the level-0 tool. NO ACTION DECLARES THIS.
    ///
    /// <para>
    /// It is kept because the BodyProgram wire vocabulary carries it
    /// (`BodyProgramResourceTemplateValue.ToolBasicOnly`), so a journal written by a build that emitted it still reads.
    /// </para>
    /// <para>
    /// `chop_tree_source`, `break_rock_source` and `chop_stump` used to declare it, justified by "the native handler
    /// refuses an upgraded pickaxe". Checked against the game, that is backwards: `Pickaxe` refuses
    /// `UpgradeLevel &lt; 2` - it demands MORE than basic, and only for `Name.Contains("Boulder")` tiles
    /// (Pickaxe.cs:180-190) that the breakable-stone category cannot select - and `Axe` refuses no upgrade level at all.
    /// `(0, 0)` therefore admitted exactly the tier the game rejects and
    /// refused every tier it accepts, so those actions would have stopped working the moment a player upgraded an axe.
    /// No live run caught it because every run starts from level-0 tools (measured 2026-10-30: `upgradeLevel: 0` for
    /// all five tool slots).
    /// </para>
    /// </summary>
    BasicOnly = 3,
}
public sealed record FarmhandActionArgument(string Name, string Type, IReadOnlyList<string>? Enum = null, string? Description = null);
/// <summary>Mod-owned symbolic resource claim; ScopePlayer materializes embodied_actor to the current scoped player.
/// A `tool:&lt;category&gt;` key is the SAME shape with a different subject: the tool that category names, which the
/// handler requires the actor to OWN and takes as the current tool by selecting it, and whose value half is the
/// upgrade-level requirement (<see cref="FarmhandResourceTemplateValue.AnyUpgrade"/> /
/// <see cref="FarmhandResourceTemplateValue.BasicOnly"/>).</summary>
public sealed record FarmhandActionResourceTemplateClaim(string Key, FarmhandResourceTemplateValue Value);

/// <summary>
/// Where the actor's body must be before an action can happen.
///
/// Declared beside the claims but deliberately NOT a claim: `embodied_actor` and `tool:&lt;category&gt;` say what the
/// action OCCUPIES for its duration, and a spatial precondition says where the body must already be. Folding the
/// second into the first would give a resource claim two meanings, and the Host's projection reads claims as
/// resources.
///
/// Why it exists: measured 2026-10-25, the companion submitted a one-node program `enter_exit(3,12)` while it was in
/// bed at `FarmHouse(9,9)`. The Mod refused with `door_out_of_range` - correctly - and the companion learned the
/// precondition only by being refused, then added `move_to_tile(3,11)` on its second attempt and succeeded. A
/// refusal that teaches is worse than a shape that says so.
/// </summary>
/// <param name="Relation">The surface's own word for the relationship, e.g. `adjacent`.</param>
/// <param name="WithinTiles">How far away that relationship allows, or null when the surface states no distance.</param>
public sealed record FarmhandActionApproachRequirement(string Relation, int? WithinTiles)
{
    /// <summary>You must already stand beside the target, in a step of your own: the handler refuses from further
    /// away (`enter_exit`'s `door_out_of_range`, `pickup_forage`'s `observation_binding_target_out_of_range`).</summary>
    public static readonly FarmhandActionApproachRequirement Adjacent = new("adjacent", 1);

    /// <summary>
    /// The action closes the distance itself, so there is nothing for the caller to stand beside first and no distance
    /// to state.
    ///
    /// <para>
    /// Every handler that begins its own approach leg (<c>TryBeginToolApproach</c> / <c>TryBeginBuildingApproach</c>,
    /// or its own <c>LocalMoveSpec</c> for <c>pickup_item</c>) declares this. `adjacent` would be false in front of the
    /// companion - it would spend a separate `move_to_tile` on a precondition the action satisfies on its own - and
    /// declaring NOTHING was worse than either: `plan_shape` answered `approach_requirement_undeclared`, which the
    /// model cannot tell from "no constraint" (measured 2026-11-06: thirteen such answers for `cut_weeds` in one run,
    /// whose handler walks in at `farmhandexecutioncontroller.resourcetoolactions.cs`).
    /// </para>
    /// <para>
    /// `ApproachDeclarationCoverageTests` derives the population of this relation from the handler sources, so a
    /// declaration added here without the leg - or a leg added without the declaration - fails by action id.
    /// </para>
    /// </summary>
    public static readonly FarmhandActionApproachRequirement SelfWalked = new("self_walked", null);
}
/// <summary>Action-specific typed binding metadata owned exclusively by Mod registration.</summary>
public sealed record FarmhandActionObservationBindingDescriptor(string Type, int Version, bool Required, IReadOnlyList<string> RequiredProperties);
/// <summary>
/// What ONE clearing swing costs the actor, and what it buys.
///
/// <para>
/// The GAIN is the same on every declaration, so it is stated once here rather than repeated per row: the occupant
/// leaves the tile and the tile becomes passable. The COST differs per action and is what a caller weighing "clear it
/// or go around it" has to put beside a route length: which tool the swing needs, and how many dispatched turns it takes
/// from the caller (always one - a clearing action is one action).
/// </para>
/// <para>
/// STAMINA IS NOT PINNED HERE, on purpose. The charge is the engine's own formula per clear KIND
/// (<see cref="GameBuddy.Stardew.Core.ClearCostTable"/>, `2 * (power + 1) - MiningLevel * 0.1` for a pickaxe and so
/// on) and it moves with the tool the actor is actually holding and the skill level it actually has - a number typed
/// into the catalog would be wrong for every actor but the one it was measured on. What the row knows and the engine
/// formula does not is WHICH tool the swing needs.
/// </para>
/// </summary>
/// <param name="Tool">
/// The engine tool family the swing selects (`axe`, `pickaxe`, `scythe`), or <c>TargetDecidesTool</c> for a row whose
/// tool requirement travels with the TARGET instead (`ResourceClump.performToolAction` decides by clump index).
/// </param>
/// <param name="Turns">How many dispatched actions the clear costs. One, for every row: clearing is one action.</param>
public sealed record FarmhandClearingCost(string Tool, int Turns)
{
    /// <summary>The tool requirement is the TARGET's own, not this row's.</summary>
    public const string TargetDecidesTool = "target_requirement";
}

/// <summary>
/// One action's declaration of the occupants it removes, with the price its own row states for removing them.
///
/// <para>
/// Occupants and price travel together because a refusal quotes both in one breath ("a weed is in the way; `cut_weeds`
/// removes it for one turn with the scythe"), and two separate fields would let a row declare a clearer without ever
/// saying what dispatching it costs.
/// </para>
/// </summary>
/// <param name="Occupants">The engine's own names for what one swing removes.</param>
/// <param name="Cost">What that one swing costs: the tool family it selects, and one turn.</param>
/// <param name="Destructive">
/// Whether the swing DESTROYS SOMETHING THE PLAYER PUT THERE, as opposed to taking something out of the way.
///
/// <para>
/// WHY THE FLAG IS ON THE DECLARATION. The declaration is what a consumer reads to answer "what removes this" - and the
/// `for_each` heal asks exactly that question about a tile the row was refused on, then dispatches the answer without
/// being asked to. A `Clears` entry that merely OPENED the tile and one that LEVELS what she planted were the same word,
/// so a pass over a strip that happened to run through her crop scythed it: a destructive effect the player could not
/// foresee, produced by a step neither she nor the player wrote. Half the declaration - the half that says whether
/// dispatching it is a wipe - was simply missing.
/// </para>
/// <para>
/// THE FLAG IS ANSWERED AT EVERY ROW, and that is why the helper takes it as a required argument rather than defaulting
/// to `false`: a new clearing declaration that never had to think about it would be the same silence this field was
/// added to end, and `NoPassDispatchesADestructiveClearingAction` would keep passing because the new row answered
/// nothing. A destructive declaration is still a REAL declaration - an agent that is asked to harvest a crop may
/// dispatch `scythe_crop` - it is only never dispatched ON THE PLAYER'S BEHALF.
/// </para>
/// <para>
/// WHY EACH ENTRY ANSWERS WHAT IT DOES, one line each:
/// </para>
/// <list type="bullet">
/// <item>`scythe_crop` (crop) - DESTRUCTIVE: the crop on the tile is the player's own planting, and the scythe's two
/// terminals (`HoeDirt.performToolAction`, HoeDirt.cs:713-735) are "take a ready scythe-method crop" and "clear a dead
/// one". Neither opens a way through the tile, and the first loses a crop she was about to harvest; `harvest_crop` is
/// what resolves a crop.</item>
/// <item>`cut_grass` (grass) - DESTRUCTIVE, and it is the arguable one: a grass tuft is what a grass starter plants for
/// animals, so a swing at one can take feed she deliberately put there. Cutting it drops hay, which is a real reason to
/// want it - but that decision is hers, not a pass's.</item>
/// <item>`cut_weeds` (weed) - not: a weed is not planted and nothing of hers is behind it; cutting it is how the tile is
/// opened.</item>
/// <item>`chop_tree` (tree) - not: a wild tree is not planted stock, and chopping it drops the wood it was holding - the
/// swing produces her a resource rather than taking one.</item>
/// <item>`chop_stump` (tree_stump) - not: a stump is what a felled tree leaves behind, and chopping it drops its wood.
/// </item>
/// <item>`break_rock` (stone) - not: a stone is terrain, and breaking it drops the stone or ore inside it.</item>
/// <item>`clear_debris` / `break_resource_clump` (the clump occupants) - not: a stump, hollow log, meteorite or boulder
/// is natural debris, and the clump's own `performToolAction` drops its resources.</item>
/// </list>
/// </param>
/// <param name="RefusalDetail">
/// What a refusal on this occupant says BEYOND the code, in words - or null on a declaration whose swing destroys nothing
/// of hers.
///
/// <para>
/// WHY IT LIVES BESIDE THE FLAG. `no_safe_clear:grass:cut_grass` is a parseable word and, to the model reading it, a dead
/// end: it says a swing was withheld and never says that dispatching `cut_grass` is a legitimate decision of hers, nor what
/// that swing costs. The flag and the sentence are one fact in two forms - a boolean for the code path, a sentence for the
/// model - so they are declared in one place. A sentence in a table beside the catalogue would keep describing a swing
/// after the declaration stopped marking it destructive.
/// </para>
/// <para>
/// IT IS REQUIRED AT EVERY ROW of the helper that writes it, for the same reason <see cref="Destructive"/> is: a new
/// destructive row that never had to answer would reproduce the silence this field ends, and
/// `EveryDestructiveClearanceSaysWhatItDestroysInTheRefusedRow` names such a row by occupant and action.
/// </para>
/// </param>
public sealed record FarmhandClearingDeclaration(IReadOnlyList<string> Occupants, FarmhandClearingCost Cost, bool Destructive, string? RefusalDetail = null);

/// <summary>Versioned descriptor contract owned exclusively by Mod registration.</summary>
/// <remarks><see cref="WatchdogMs"/> is the descriptor-owned static execution
/// budget for Body Program nodes of this action (default 60s). It is a Mod
/// registration fact, not an Agent-facing field: the Mod derives a fresh
/// absolute deadline at admission time (watchdog authority decision
/// 2026-09-20). `navigate_to_destination` declares an action-specific 10-minute
/// budget matching its ordinary-pipeline deadline ceiling.</remarks>
/// <param name="TargetFamily">
/// The <see cref="FarmhandActionDescriptor"/>'s snapshot family: the `BridgeSnapshot` array that supplies this
/// action's targets, or null for an action that addresses nothing a snapshot publishes.
///
/// <para>
/// Declared because the two halves of every action are otherwise unconnected: `Discover*` publishes rows and the
/// per-action preflight refuses them, both in this assembly, with nothing naming which family belongs to which
/// action. Eight shipped defects are that one shape - `treeChopSourceTargets` published a health predicate the chop
/// preflight did not accept, `forageTargets` published no `observationId` for a binding the action required,
/// `shippingBinTargets` was organised by pack slot while `ship_item` wanted an item id, `rockSourceTargets` filtered
/// `health == 1` so every real ore was invisible, `cropTargets` counted a season-killed crop as harvestable, and
/// `enter_exit` consulted only `location.doors` while the snapshot published edge warps too.
/// </para>
/// <para>
/// The name is the WIRE field (`cropTargets`, not `CropTargets`), because that is what a caller reads and what a
/// refusal should tell it to read. `TargetFamilyRoundTripTests` derives its population from these declarations and
/// fails by name for any action whose family the snapshot does not publish, or whose published rows its own
/// preflight refuses.
/// </para>
/// </param>
/// <param name="Clears">
/// The OCCUPANTS this action removes, in the engine's own names for them (`weed` for `Object.IsWeeds`,
/// `quarry_boulder` for `ResourceClump.quarryBoulderIndex`, `grass` for the `Grass` terrain feature), WITH the price
/// of one swing (<see cref="FarmhandClearingCost"/>), or null for an action that clears nothing.
///
/// <para>
/// Declared because a `clear_step_blocked` refusal has to name an action the caller can dispatch AND let it weigh that
/// dispatch against walking around: the alternative - a kind-to-action table beside the catalog - is the defect this
/// file already pays for elsewhere, because the table would keep naming an action after that action stopped accepting
/// the occupant. The join reads this field (<see cref="GameBuddy.Stardew.Core.ClearingActionSurface"/>), so a
/// declaration and its consequence are one edit.
/// </para>
/// <para>
/// Only the actions that OPEN a route declare it: `harvest_crop` takes a crop off a tile the crop was never blocking,
/// `clear_hoedirt` takes soil that was never a wall, and `harvest_bush` HARVES a bush that is squarely in the way -
/// which is why a bush answers `no_published_action_clears:bush` instead of advertising a harvest as a way through. An
/// occupant left undeclared is reported as `no_published_action_clears:&lt;kind&gt;` rather than guessed at.
/// </para>
/// <para>
/// A declaration also says whether its swing DESTROYS what the player put there
/// (<see cref="FarmhandClearingDeclaration.Destructive"/>), because the `for_each` heal dispatches what it reads here on
/// a tile nobody asked it to work. A route that has to go THROUGH a crop is not a route: the crop is the goal, not the
/// obstruction.
/// </para>
/// </param>
/// <param name="Synthetic">
/// This action performs its effect without the NPC counter the player would use.
///
/// <para>
/// WHY IT IS DECLARED. `build_farm_building` deducts the `Data/Buildings` cost and materials itself and calls
/// `GameLocation.buildStructure` directly: it never opens Robin's carpenter menu, never waits for the hours she works, and
/// never joins her build queue. That is a deliberate product decision, and before this field it was indistinguishable
/// from a normal counter purchase - the descriptor, the artifact and the receipt all described a building that appeared,
/// and none of them said the transaction a player would have made at her counter never happened. A caller reading the
/// published surface could not tell the two apart.
/// </para>
/// <para>
/// FALSE IS THE DEFAULT AND IS NOT PUBLISHED: an action that does go through the counter says nothing, and the artifact
/// omits the member, so the field is a claim only where the claim is true. `synthetic_effect_undeclared`
/// (`integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/SyntheticEffectDeclarationTests.cs`) derives its
/// population from this catalogue plus the handlers' own placement settlements, so an action that starts bypassing a
/// counter without saying so fails there by name.
/// </para>
/// </param>
public sealed record FarmhandActionDescriptor(IReadOnlyList<FarmhandActionArgument> Arguments, IReadOnlyDictionary<string, string> OutputFacts, IReadOnlyList<FarmhandActionResourceTemplateClaim> ResourceTemplate, string Effect, string Postcondition, string? NativeBinding = null, FarmhandActionObservationBindingDescriptor? SceneTarget = null, FarmhandExecutionAcceptanceFacts? Acceptance = null, FarmhandActionApproachRequirement? Approach = null, long WatchdogMs = FarmhandActionCatalog.DefaultWatchdogMs, string? TargetFamily = null, FarmhandClearingDeclaration? Clears = null, bool Synthetic = false);
/// <summary>The only ordinary-Farmhand operation membership and descriptor source.</summary>
public sealed record FarmhandActionRegistration(string ActionId, string FamilyId, int IdentityVersion, FarmhandActionLifecycle Lifecycle, FarmhandOperationKind Kind, FarmhandActionHandlerGroup? HandlerGroup, FarmhandActionDescriptor? Descriptor = null);
public enum FarmhandActionHandlerGroup { Movement, Farming, Gathering, MachinesAndAnimals, ResourceTools, Expression, WorldLifecycle, Modal }
public static class FarmhandActionHandlerGroupWire
{
    public static string ToWireValue(this FarmhandActionHandlerGroup group) => group switch
    {
        FarmhandActionHandlerGroup.Movement => "movement",
        FarmhandActionHandlerGroup.Farming => "farming",
        FarmhandActionHandlerGroup.Gathering => "gathering",
        FarmhandActionHandlerGroup.MachinesAndAnimals => "machines_and_animals",
        FarmhandActionHandlerGroup.ResourceTools => "resource_tools",
        FarmhandActionHandlerGroup.Expression => "expression",
        FarmhandActionHandlerGroup.WorldLifecycle => "world_lifecycle",
        FarmhandActionHandlerGroup.Modal => "modal",
        _ => throw new ArgumentOutOfRangeException(nameof(group)),
    };
}

public static class FarmhandActionCatalog
{
    /// <summary>
    /// One native chat line's worth of text. The native ingress is a single 896-px line (ChatBox.cs:91) that stops
    /// accepting input once the text would overrun it (ChatTextBox.cs:39), so a longer payload is not a chat line at
    /// all. It lives HERE, on the Core side, because both the wire validator and the Mod handler must read the same
    /// number - an argument the wire accepts but the handler refuses (or the reverse) is a registered capability that
    /// cannot be invoked, which is the defect `quantity` once was.
    /// </summary>
    public const int ChatMessageMaximumLength = 256;

    public static readonly IReadOnlyList<string> EmoteEnum = Array.AsReadOnly(new[]
    {
        "happy", "sad", "heart", "exclamation", "note", "sleep", "game", "question",
        "x", "pause", "blush", "angry", "yes", "no", "sick", "laugh", "surprised",
        "hi", "taunt", "uh", "music"
    });

    public static readonly IReadOnlyList<string> DirectionEnum = Array.AsReadOnly(new[]
        {
            "up", "right", "down", "left"
        });

    /// <summary>
    /// The two ways a displayed <c>LevelUpMenu</c> can be settled, plus the ordinary confirmation.
    ///
    /// <c>confirm</c> is legal only for an ordinary level and <c>branch_a</c>/<c>branch_b</c> only for a
    /// profession milestone; the Mod refuses the other pairings by name. There is deliberately no "pick the
    /// first branch" value: which professions level 10 offers depends on the level-5 choice
    /// (<c>LevelUpMenu.cs:428-436</c>), so a default would decide the companion's growth path for it.
    /// </summary>
    public static readonly IReadOnlyList<string> LevelUpChoiceEnum = Array.AsReadOnly(new[]
        {
            "confirm", "branch_a", "branch_b"
        });

    /// <summary>Semantic tool selector for equip_tool/v2. Mod resolves a canonical
    /// category to the deterministically best owned item; slot stays private.
    ///
    /// `lantern` is the word a tool action needs when the tool it drives is neither a resource tool nor a weapon:
    /// `toggle_tool_light` acts through the actor's own `Lantern`. It is published here rather than hidden because the
    /// vocabulary is the ONE place a `tool:&lt;category&gt;` claim, an `equip_tool` selector and a `toolSlots[].category`
    /// all read, and a second list of words beside it is the two-spellings defect this file keeps paying for.</summary>
    public static readonly IReadOnlyList<string> ToolEnum = Array.AsReadOnly(new[]
    {
        "axe", "pickaxe", "hoe", "watering_can", "fishing_rod", "weapon", "scythe", "shears", "milk_pail", "pan", "lantern", "raft"
    });

    private static readonly IReadOnlyList<FarmhandActionResourceTemplateClaim> EmbodiedActorResource = Array.AsReadOnly(new[]
    {
        new FarmhandActionResourceTemplateClaim("embodied_actor", FarmhandResourceTemplateValue.ScopePlayer),
    });

    /// <summary>
    /// The SAME claim shape as <see cref="EmbodiedActorResource"/>, with the TOOL the handler needs as its subject:
    /// `tool:&lt;category&gt;` plus the upgrade-level requirement that handler enforces. It is a resource claim and not a
    /// new descriptor field because it names a native resource the action needs; the one fact the Host cannot derive
    /// from the world and therefore could not plan around (it used to guess, then eat a
    /// `*_not_equipped_in_requested_slot` refusal). Category vocabulary is <see cref="FarmhandActionCatalog.ToolEnum"/>,
    /// the same one `equip_tool` selects on, so a planner can satisfy the claim with the action it already has - and
    /// the handler takes that tool out of the pack instead of requiring it in the actor's hand.
    /// </summary>
    private static IReadOnlyList<FarmhandActionResourceTemplateClaim> ToolResource(string category, FarmhandResourceTemplateValue upgrade) => Array.AsReadOnly(new[]
    {
        new FarmhandActionResourceTemplateClaim("embodied_actor", FarmhandResourceTemplateValue.ScopePlayer),
        new FarmhandActionResourceTemplateClaim($"tool:{category}", upgrade),
    });

    /// <summary>Descriptor-owned static watchdog for ordinary short actions</summary>
    /// (hang protection, not ETA; watchdog authority decision 2026-09-20).</summary>
    public const long DefaultWatchdogMs = 60_000;

    /// <summary>Action-specific Body Program watchdog for navigate_to_destination, matching its own published ceiling.</summary>
    /// <summary>
    /// The ceiling for an ORDINARY action's declared deadline: one minute. It is the FALLBACK for an action whose
    /// registration publishes no watchdog, and it is the same number the Host uses when it sizes a dispatch deadline
    /// (`DEFAULT_DISPATCH_DEADLINE_MS`), so the two sides fall back identically.
    ///
    /// Both sides otherwise read the action's OWN published watchdog: `BridgeSession.IsFreshExecutionRequest` accepts
    /// a deadline up to `descriptor.WatchdogMs`, and the Host sizes the deadline from that same number. The two used to
    /// disagree - the text below records that this ceiling "was the reason `advance_day` could not converge", while
    /// `IsFreshExecutionRequest` kept its own hard-coded split beside the parameterised ceiling, so a multi-day run's
    /// own `advance_day` was refused by name (`invalid_deadline`).
    /// </summary>
    public const long OrdinaryActionCeilingMs = 60_000;

    public const long NavigationWatchdogMs = 600_000;

    /// <summary>
    /// Action-specific watchdog for the cross-day lifecycle. A co-op night waits
    /// on other players' native ready state, a save, and a new-day transition, so
    /// it cannot fit the 60s ordinary-action ceiling; 10 minutes matches the
    /// navigation ceiling and the lifecycle's own ready-barrier budget.
    /// </summary>
    public const long LifecycleWatchdogMs = 600_000;

    /// <summary>
    /// Every occupant a `ResourceClump` can be that the native tool table prices, in the engine's OWN constant names
    /// (<c>ResourceClump.cs:15-35</c>): <c>stumpIndex</c>, <c>hollowLogIndex</c>, <c>meteoriteIndex</c>,
    /// <c>boulderIndex</c>, <c>quarryBoulderIndex</c> and the four <c>mineRock*Index</c> rows.
    ///
    /// <para>
    /// One list for both clump actions, because which clump a swing removes is a property of the CLUMP
    /// (<c>ResourceClump.performToolAction</c>) - neither action picks its tool family, so neither can address a subset.
    /// </para>
    /// <para>
    /// Declared ABOVE <see cref="Registrations"/> because static field initializers run in declaration order: a list
    /// below the catalog it feeds is still null when the catalog is built, which the compiler reports as a possible null
    /// argument and which would have thrown at type initialization.
    /// </para>
    /// </summary>
    private static readonly string[] ClumpOccupants =
    {
        "stump", "hollow_log", "meteorite", "boulder", "quarry_boulder",
        "mine_rock_1", "mine_rock_2", "mine_rock_3", "mine_rock_4",
    };

    /// <summary>
    /// What a `no_safe_clear:crop:scythe_crop` refusal says once the code has been read: the tile is HER planting, the
    /// scythe ends it, and `harvest_crop` is the action that resolves a crop.
    ///
    /// <para>
    /// One sentence, because it is the sentence the model reads in a refused row's `detail` - the cost of the swing that was
    /// withheld and the action that takes the crop the way it was meant to be taken.
    /// </para>
    /// </summary>
    private const string ScytheCropRefusalDetail =
        "The crop on this tile is one you planted: scythe_crop levels it and loses the harvest, and harvest_crop is the action that resolves a crop.";

    /// <summary>
    /// What a `no_safe_clear:grass:cut_grass` refusal says once the code has been read: the grass is an ASSET, not refuse.
    ///
    /// <para>
    /// Operator ruling, and the reason the swing is destructive at all: a Grass Starter costs 100g and players plant it at
    /// the coop door for grazing; without a silo, cutting it yields no hay at all - it simply evaporates. A companion that
    /// cut it "to tidy up" would destroy something the player paid for and could not recover. Cutting it remains a
    /// legitimate decision, so the sentence says whose decision it is instead of forbidding it.
    /// </para>
    /// </summary>
    private const string CutGrassRefusalDetail =
        "This grass is animal feed you paid for: a Grass Starter costs 100g and, with no silo, cutting it yields no hay - dispatch cut_grass yourself if that is your decision.";

    public static readonly IReadOnlyList<FarmhandActionRegistration> Registrations = Array.AsReadOnly(new[]
    {
        E("move_to_tile", "movement_navigation", FarmhandActionHandlerGroup.Movement, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"))),
        E("equip_tool", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("tool", "string", ToolEnum) }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "native_action_postcondition", "Game1.player.CurrentToolIndex"), FarmhandActionLifecycle.Published, "toolSlots"),
        E("travel", "transport_warps", FarmhandActionHandlerGroup.Movement, Transition(entersDoor: false), FarmhandActionLifecycle.Published, "warps"),
        // Native 1.6 minecart travel is a distinct action, not a `travel`
        // objective family. Both the Mod's execution parser and
        // FarmhandExecutionAcceptance are exact-shape allow-lists with no
        // optional-argument concept, so a second argument shape means a second
        // action: `travel` stays {x,y} (one native warp at the source tile) and
        // `ride_minecart` declares {x,y,expectedTargetId} where x,y is the
        // minecart STATION tile and expectedTargetId selects one advertised
        // (station, destination) ride. LiveVerified: the target-version
        // native-local gate passed (fixtures/stardew/RUNBOOK.md) on the repaired
        // fixture (scenario name + real UnlockCondition); publication review is
        // still owed for the final `published` rung.
        E("ride_minecart", "transport_warps", FarmhandActionHandlerGroup.Movement, MinecartRide() with { Approach = FarmhandActionApproachRequirement.Adjacent }, FarmhandActionLifecycle.LiveVerified, "minecartTargets"),
        // The bus has no reusable UI-free warp seam: its fare, the driver check,
        // the control freeze and the cutscene all live inside
        // BusStop.answerDialogue("Bus_Yes"). This action therefore drives the
        // native ticket interaction and waits for the arrival the game itself
        // produces (see farmhandexecutioncontroller.busactions.cs).
        E("ride_bus", "transport_warps", FarmhandActionHandlerGroup.Movement, new FarmhandActionDescriptor(
            Array.Empty<FarmhandActionArgument>(),
            new Dictionary<string, string>(),
            EmbodiedActorResource,
            "write",
            "bus_arrived",
            "BusStop.checkAction+answerDialogue"), FarmhandActionLifecycle.LiveVerified),
        E("select_mine_elevator_floor", "world_navigation", FarmhandActionHandlerGroup.Movement, ElevatorFloor(), FarmhandActionLifecycle.LiveVerified, "mineElevatorFloorTargets"),
        E("use_raft", "water_travel", FarmhandActionHandlerGroup.Movement, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, AutoSelectedToolSlotMeaning), new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer") }, new Dictionary<string, string>(), ToolResource("raft", FarmhandResourceTemplateValue.AnyUpgrade), "write", "raft_launched")), FarmhandActionLifecycle.LiveVerified, "raftTargets"),
        // approachRequirement IS declared here, as `self_walked`: both handlers walk the actor in themselves
        // (`TryBeginToolApproach`), so "you must already stand beside this" would be false and stating a distance
        // would be a second, invented spelling of the leg. Declaring nothing was worse than either - `plan_shape`
        // then answered `approach_requirement_undeclared`, which the model cannot tell from "no constraint".
        //
        // The declaration lives on `FarmhandActionCatalog` and `FarmhandActionSurfacePublication` (the
        // `action-surface.v1.json` artifact), and `BridgeSession` also publishes it on the `hello_ack`
        // `FarmhandActionDescriptorWire` so `plan_shape` can answer with it.
        E("mount_transport", "animal_transport", FarmhandActionHandlerGroup.Movement, SelfWalked(A(null, null, "horse_mounted", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string"))), FarmhandActionLifecycle.LiveVerified, "horseTargets"),
        E("enter_mine", "world_navigation", FarmhandActionHandlerGroup.Movement, SelfWalked(A(null, null, "mine_entered", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string"))), FarmhandActionLifecycle.LiveVerified, "mineEntranceTargets"),
        // The way OUT of a mine level, and its own action rather than an `enter_mine` argument: the level's exit ladder
        // (Buildings tile 115) opens the game's `ExitMine` question, whose Leave response performs the warp itself
        // (MineShaft.cs:3073-3081 -> GameLocation.cs:12388-12401). `enter_mine` owns the descent ladder (173) and
        // refuses this tile by name with `use_action=use_mine_ladder`; this action owns 115 and refuses 173 the same
        // way. Round30 measured the gap: a companion inside a freshly generated level was published no ladder at all
        // and stayed in the mine until it passed out. Experimental: it has no live gate yet, and promotion to
        // LiveVerified is a separate catalog edit owned by the parent.
        E("use_mine_ladder", "world_navigation", FarmhandActionHandlerGroup.Movement, SelfWalked(A(null, null, "mine_left", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string"))), FarmhandActionLifecycle.LiveVerified, "mineEntranceTargets"),
        // `enter_exit` resolves a warp from (x,y) and refuses when the actor is more than one tile from it
// (`Utility.tileWithinRadiusOfPlayer(sourceX, sourceY, 1, player)`), so the body must already stand beside the
// door. Measured 2026-10-25: the companion submitted this as a one-node program from its bed six tiles away and
// learned the precondition only by being refused. Declared here so `plan_shape` can say it instead.
E("enter_exit", "movement_navigation", FarmhandActionHandlerGroup.Movement, Transition(entersDoor: true), FarmhandActionLifecycle.Published, "warps"),
        // till_soil drives the actor's own Hoe: the handler takes the hoe its claim names before tilling
        // (`tool_not_owned:hoe` when the pack holds none), so the hoe is an unconditional requirement - declared the way
        // water_crop declares its can, and for the same reason: a planner cannot see a tool requirement the surface never
        // states. Which hoe is NOT declared (the handler accepts any upgrade level). Its arguments stay {x,y}: the Mod
        // derives the target identity it uses for the approach leg itself (`till_soil_x_y`), so there is no id for the
        // caller to copy.
        E("till_soil", "farming_crops", FarmhandActionHandlerGroup.Farming, SelfWalked(A(null, ToolResource("hoe", FarmhandResourceTemplateValue.AnyUpgrade), "native_action_postcondition", ("x","integer"),("y","integer"))), FarmhandActionLifecycle.Published, "soilTiles"),
        E("pickup_forage", "resource_gathering", FarmhandActionHandlerGroup.Gathering, PickupForage() with { Approach = FarmhandActionApproachRequirement.Adjacent }, FarmhandActionLifecycle.Published, "forageTargets"), E("pickup_item", "inventory_items", FarmhandActionHandlerGroup.Gathering, SelfWalked(TargetItem()), FarmhandActionLifecycle.Published, "itemTargets"),
        // water_crop drives the actor's own WateringCan: the handler selects the can its claim names before watering
        // (`tool_not_owned:watering_can` when the pack holds none), so the can is an unconditional requirement.
        // Which can is NOT declared: the handler accepts any upgrade level (its `watering_can_empty` refusal is about
        // the can's water, runtime state a planner cannot read from the surface).
        E("water_crop", "farming_crops", FarmhandActionHandlerGroup.Farming, SelfWalked(TargetWith("watering_can", FarmhandResourceTemplateValue.AnyUpgrade)), FarmhandActionLifecycle.Published, "cropTargets"), E("plant_seed", "farming_crops", FarmhandActionHandlerGroup.Farming, SelfWalked(SlotItemTarget()), FarmhandActionLifecycle.Published, "seedTargets"), E("fertilize_tile", "farming_crops", FarmhandActionHandlerGroup.Farming, SelfWalked(SlotItemTarget()), FarmhandActionLifecycle.Published, "fertilizerTargets"),
        E("machine_inspect", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(MachineInspect()), FarmhandActionLifecycle.Published, "machineTargets"), E("machine_load", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(MachineLoad()), FarmhandActionLifecycle.Published, "machineTargets"), E("machine_collect_output", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(Target()), FarmhandActionLifecycle.Published, "machineTargets"),
        E("collect_animal_product", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(SlotTarget(ItemSlotMeaning)), FarmhandActionLifecycle.Published, "animalProductTargets"), E("feed_animal", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(SlotTarget(ItemSlotMeaning)), FarmhandActionLifecycle.Published, "feedTroughTargets"), E("use_item", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, Described(new[] { new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string") }), FarmhandActionLifecycle.Published, "foodTargets"),
        E("harvest_crop", "farming_crops", FarmhandActionHandlerGroup.Farming, SelfWalked(TargetItem()), FarmhandActionLifecycle.Published, "harvestTargets"), E("place_wood_fence", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(SlotItemTarget("(O)322")), FarmhandActionLifecycle.Published, "woodFenceTargets"), E("place_crab_pot", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(SlotItemTarget("(O)710")), FarmhandActionLifecycle.Published, "crabPotTargets"), E("bait_crab_pot", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(SlotItemTarget("(O)685")), FarmhandActionLifecycle.Published, "baitCrabPotTargets"),

        E("place_owned_object", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "owned_object_placed", "Object.placementAction")), FarmhandActionLifecycle.LiveVerified, "worldObjectTargets"),
        E("remove_placed_item", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, AutoSelectedToolSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), ToolResource("axe_or_pickaxe", FarmhandResourceTemplateValue.AnyUpgrade), "write", "placed_item_removed", "Object.performRemoveAction")), FarmhandActionLifecycle.LiveVerified, "worldObjectTargets"),
        // PICKING FURNITURE UP IS NOT `remove_placed_item` WITH A DIFFERENT TOOL. Furniture is
        // `Furniture` in `location.furniture` (GameLocation.cs:452), never in `location.objects`, it is
        // addressed by its own tile rather than by a key, and the native pickup
        // (`GameLocation.removeQueuedFurniture`, GameLocation.cs:8074-8101) does not swing a tool at all:
        // it performs the piece's own removal teardown, takes it out of the collection and delivers it to
        // the backpack. So the argument shape carries no `slot` either - which slot receives the piece is
        // the game's own decision (first free slot), exactly as `ship_item` declines to name one.
        //
        // `placed_furniture_picked_up` is the observed postcondition (gone from the collection AND one
        // more in the pack), and the action is registered `Experimental`: it stays off the Agent surface
        // until it passes its own native-local live gate, and promotion is a separate catalog edit owned
        // by the parent.
        E("move_placed_furniture", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string", null, "The opaque `placed_furniture` target id of the piece standing on this tile, copied from the `worldObjectTargets` entry of the MOST RECENT observe result. It binds the location, the tile and the item, so it is also what proves the piece is still the one you saw.") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "placed_furniture_picked_up", "GameLocation.removeQueuedFurniture"), FarmhandActionLifecycle.LiveVerified, "worldObjectTargets"),
        E("break_container", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, AutoSelectedToolSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), ToolResource("heavy_hitter", FarmhandResourceTemplateValue.AnyUpgrade), "write", "container_source_broken", "BreakableContainer.performToolAction")), FarmhandActionLifecycle.LiveVerified, "worldObjectTargets"),
        // TURNING A PLACED PIECE IS THE MISSING HALF OF PLACEMENT. The lane can put a piece down
        // (`place_owned_object`), pick it up (`move_placed_furniture`) and repaint a chest
        // (`color_placed_object`), but nothing could turn what is already standing, so every layout the
        // companion built stayed the way the first tile happened to orient it.
        //
        // It is NOT `place_owned_object` with an extra argument: that action's subject is a placement
        // CANDIDATE (a tile plus a backpack slot, the object does not exist yet), and this one's subject is
        // a piece ALREADY in `location.furniture`, named by the same opaque `placed_furniture` id
        // `move_placed_furniture` takes. No slot is declared, because no item is involved.
        //
        // `furniture_rotated` is the observed postcondition: the piece's own `currentRotation` read AFTER the
        // native call differs from the value read before it, the rotated footprint is the one the game's own
        // `Furniture.canBePlacedHere` accepts, and the piece is still standing on the tile it was named on.
        // A rotation that would push the piece into a neighbour is put BACK and refused by name
        // (`furniture_rotation_blocked_by_occupant`), never reported as a success the world does not show.
        //
        // Registered `Experimental` for the same reason as its sibling: it stays off the Agent surface until
        // it passes its own native-local live gate, and promotion is a separate catalog edit.
        E("rotate_furniture", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string", null, "The opaque `placed_furniture` target id of the piece standing on this tile, copied from the `worldObjectTargets` entry of the MOST RECENT observe result. It binds the location, the tile and the item, so it is also what proves the piece is still the one you saw.") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "furniture_rotated", "Furniture.rotate"), FarmhandActionLifecycle.Experimental, "worldObjectTargets"),
        // TAKING A FENCE DOWN IS NOT `remove_placed_item` WITH A FENCE IN FRONT OF IT. The fence's own write is
        // `Fence.performToolAction` (Fence.cs:436-474), which overrides the Object-shaped guards that action mirrors:
        // the question "can this tool break THIS fence" is answered by `Fence.IsValidRemovalTool` (Fence.cs:478-513)
        // from `Data/Fences`, and a GATE is a separate branch that only an Axe or a Pickaxe reaches (:447-454).
        // `remove_placed_item`'s `RemovesThisObject` knows none of that, so it would admit a tool the fence refuses and
        // report an uncertain postcondition twelve swings later instead of naming the reason.
        //
        // The native method ALSO returns false on every branch, including the one that destroyed the fence (:473), so
        // success can only be the fence being GONE from `location.objects` plus the drops it produced.
        //
        // The target id is the object identity `remove_placed_item` already publishes for the same fence
        // (`BuildPlacedItemTargetId`): one fence, one id, whichever action takes it down.
        E("remove_fence", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ToolSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string", null, "The opaque object target id of the fence on this tile, copied from the `worldObjectTargets` entry of the MOST RECENT observe result.") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "fence_removed", "Fence.performToolAction"), FarmhandActionLifecycle.Experimental, "worldObjectTargets"),
        // A FISH TANK IS FURNITURE, and it is the only thing that decides what it will hold. `FishTankFurniture`
        // lives in `location.furniture` (GameLocation.cs:452), so the target id is the same `placed_furniture` id the
        // pickup and the rotation take - one piece, one id. The deposit itself is the tank's own
        // `checkForAction` (FishTankFurniture.cs:220-268), whose acceptance rule (`CanBeDeposited`, :270-309) reads
        // `Data/Aquarium` for the normal case and a closed vanilla id list plus a hat branch for the rest; this action
        // does not restate any of it.
        //
        // The item is named by the SLOT it occupies, because the native method reads the HELD item
        // (`who.ActiveObject`/`who.CurrentItem`, :235). `expectedQualifiedItemId` binds the stack, so a slot whose
        // contents changed under a waiting request is refused rather than depositing something the caller never named.
        //
        // `fish_tank_item_deposited` is the observed postcondition: the tank's own `heldItems` grew by exactly one with
        // this item at the end, and the pack lost exactly one. A deposit the engine took the item for but never
        // completed is put back the way the native failure callback does it (:255-263) and reported as
        // `fish_tank_deposit_not_observed`, never as a success.
        E("put_item_in_fish_tank", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string"), new FarmhandActionArgument("expectedTargetId", "string", null, "The opaque `placed_furniture` target id of the tank standing on this tile, copied from the `worldObjectTargets` entry of the MOST RECENT observe result.") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "fish_tank_item_deposited", "FishTankFurniture.checkForAction"), FarmhandActionLifecycle.Experimental, "worldObjectTargets"),
        // PUTTING SOMETHING ON A PEDESTAL IS THE PEDESTAL'S OWN DECISION, and its seam has one branch a caller must never
        // reach: while it already holds an item, `performObjectDropInAction` KNOCKS THAT ITEM OFF and answers false
        // (ItemPedestal.cs:97-101). So an occupied pedestal is refused BY NAME before the call, and the remaining
        // acceptance is the pedestal's own two guards asked through `probe: true` - the item must be trashable (:93-96) and
        // must be EXACTLY a plain `Object` (:102), which excludes hats, clothing and furniture.
        //
        // The pedestal is an OBJECT in `location.objects`, not furniture, and its identity here is published as
        // `worldObjectTargets` kind `empty_pedestal`. `pedestalTargets` cannot supply it: that family is the TAKE
        // projection and carries only a pedestal that already holds something.
        //
        // `pedestal_item_placed` is the observed postcondition: the pedestal's own `heldObject` is this item and the pack
        // lost exactly one. `match`/`locked` are reported because the pedestal writes them itself when the item it wants
        // lands, so the caller can see it just satisfied a shrine rather than merely decorating.
        E("place_item_on_pedestal", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string"), new FarmhandActionArgument("expectedTargetId", "string", null, "The opaque `empty_pedestal` target id of the pedestal on this tile, copied from the `worldObjectTargets` entry of the MOST RECENT observe result. It binds the location, the tile and the pedestal itself.") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "pedestal_item_placed", "ItemPedestal.performObjectDropInAction"), FarmhandActionLifecycle.Experimental, "worldObjectTargets"),
        // Declares the axe its handler requires, like break_rock declares its pickaxe. Without the claim there was
        // nothing for the handler to select from, so it demanded the caller pre-equip - the one asymmetry between
        // chopping and the three actions that had already moved to declared tool selection.
        E("chop_tree", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, Clears(SelfWalked(SlotTargetWith("axe", FarmhandResourceTemplateValue.AnyUpgrade, AutoSelectedToolSlotMeaning)), "axe", destructive: false, null, "tree"), FarmhandActionLifecycle.Published, "treeChopSourceTargets"),
        E("break_rock", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, Clears(SelfWalked(SlotTargetWith("pickaxe", FarmhandResourceTemplateValue.AnyUpgrade, AutoSelectedToolSlotMeaning)), "pickaxe", destructive: false, null, "stone"), FarmhandActionLifecycle.Published, "rockSourceTargets"), E("clear_hoedirt", "farming_crops", FarmhandActionHandlerGroup.Farming, SelfWalked(SlotTargetWith("pickaxe", FarmhandResourceTemplateValue.AnyUpgrade, AutoSelectedToolSlotMeaning)), FarmhandActionLifecycle.Published, "clearHoeDirtTargets"), E("dig_artifact_spot", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(SlotTargetWith("hoe", FarmhandResourceTemplateValue.AnyUpgrade, AutoSelectedToolSlotMeaning)), FarmhandActionLifecycle.Published, "artifactSpotTargets"), E("refill_watering_can", "farming_crops", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(SlotTargetWith("watering_can", FarmhandResourceTemplateValue.AnyUpgrade, AutoSelectedToolSlotMeaning)), FarmhandActionLifecycle.Published, "refillWateringCanTargets"),
        R("inspect_world_map", "world_navigation"), R("find_destination", "world_navigation"), R("observe_scene", "world_perception"),
        E("navigate_to_destination", "world_navigation", FarmhandActionHandlerGroup.Movement, new FarmhandActionDescriptor(
            new[] { new FarmhandActionArgument("destination", "destination_selector") },
            new Dictionary<string, string> { ["arrival"] = "destination_arrival" },
            EmbodiedActorResource, "write", "arrived_at_destination",
            WatchdogMs: NavigationWatchdogMs)),
        E("clear_debris", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, Clears(SelfWalked(SlotTarget(CarriedToolSlotMeaning)), FarmhandClearingCost.TargetDecidesTool, destructive: false, null, ClumpOccupants), FarmhandActionLifecycle.LiveVerified, "debrisTargets"),
        // The same ResourceClumps, addressed the way every other tool action is now addressed: no `slot`, and the
        // handler resolves, selects and restores the tool itself. `clear_debris` above still obeys the caller's slot
        // and still needs the named slot to hold a usable tool, which is the contract that killed whole plan chains
        // (4a4012db); this row is the shape those actions moved to.
        //
        // It declares NO `tool:` claim, and that is the honest registration rather than an omission: WHICH tool a clump
        // needs is a property of the clump (`ResourceClump.performToolAction`, ResourceClump.cs:150-234 - 600 needs an
        // Axe at upgrade 1, 602 an Axe at 2, 672 a Pickaxe at 2, 148/622 a Pickaxe at 3, 752-758 any Pickaxe), and a
        // row that claimed one family would be wrong for every clump of the other. The requirement therefore travels
        // with the TARGET, from the same one table the native switch is mirrored in, and the refusal is named
        // `clump_tool_too_weak` instead of the slot-and-holding words the old contract used.
        // `Experimental`, not `Published`: a gate descriptor is a promise that this action has its own live-run gate
        // (check-stardew-action-promotion.mjs:150-156), and no live gate has been run for it. Promotion to
        // LiveVerified is the parent's step and lands with that gate, the way move_placed_furniture's did.
        E("break_resource_clump", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, Clears(Target(), FarmhandClearingCost.TargetDecidesTool, destructive: false, null, ClumpOccupants), FarmhandActionLifecycle.Experimental, "debrisTargets"),
        // Fishing. `waterTargets` is the engine's own castable-tile answer (`GameLocation.canFishHere` + `isTileFishable`),
        // and the postcondition is `fish_caught` because that is the fact the receipt measures a before/after of
        // (`fish_caught_before`/`fish_caught_after` around `Farmer.fishCaught`).
        //
        // `Published`, NOT `Experimental`: an experimental action is off the agent surface, so no run can dispatch it and
        // no live evidence is ever obtainable for it - a task naming it can never be satisfied (the task table's own
        // falsifier says so: "reads fish_here, which the Mod registers Experimental - no run can dispatch it"). The
        // missing half is the Host's, and it is the promotion gate that names it field by field; `LiveVerified` stays
        // for the run that proves the catch is credited by the engine.
        E("fish_here", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(A(null, ToolResource("fishing_rod", FarmhandResourceTemplateValue.AnyUpgrade), "fish_caught", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string"))), FarmhandActionLifecycle.Published, "waterTargets"),
        E("npc_relationship", "npc_social", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(Target()), FarmhandActionLifecycle.LiveVerified, "npcRelationshipTargets"),
        E("pet_animal", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(Target()), FarmhandActionLifecycle.LiveVerified, "petTargets"),
        E("pet_farm_animal", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(Target()), FarmhandActionLifecycle.LiveVerified, "farmAnimalPetTargets"),
        E("water_pet_bowl", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(TargetWith("watering_can", FarmhandResourceTemplateValue.AnyUpgrade)), FarmhandActionLifecycle.LiveVerified, "petBowlTargets"),
        E("water_slime_hutch_trough", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(TargetWith("watering_can", FarmhandResourceTemplateValue.AnyUpgrade)), FarmhandActionLifecycle.LiveVerified, "slimeHutchTroughTargets"),
        E("interact_npc_with_item", "npc_social", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(SlotItemTarget()), FarmhandActionLifecycle.LiveVerified, "npcRelationshipTargets"),
        // Talking is the OTHER half of NPC.checkAction (NPC.cs:2464) and is its own
        // action rather than an optional argument on the gift action, because the
        // protocol has no optional arguments and the two intents are orthogonal
        // (owner ruling: method-layer verdict NPC.checkAction@2464 ->
        // newPrimitive("talk_to_npc"), stardew-action-inventory-reconciliation.mjs:406).
        // Same {x,y,expectedTargetId} shape as npc_relationship: the actor names the
        // villager through the NPC family's opaque target id and the Mod re-resolves
        // the person on the game thread. Experimental: it stays off the default Agent
        // surface until it passes its own native-local live gate, and the promotion to
        // LiveVerified is a separate catalog edit owned by the parent.
        E("talk_to_npc", "npc_social", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(A(null, null, "npc_talked", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string"))), FarmhandActionLifecycle.LiveVerified, "npcRelationshipTargets"),
        E("express_emote", "expression", FarmhandActionHandlerGroup.Expression, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("emote", "string", EmoteEnum) }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "emote_started", "Farmer.doEmote"), FarmhandActionLifecycle.LiveVerified),
        E("face_direction", "movement_navigation", FarmhandActionHandlerGroup.Movement, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("direction", "string", DirectionEnum) }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "actor_facing_matches", "Farmer.faceDirection"), FarmhandActionLifecycle.LiveVerified),
        E("chest_store", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(ContainerItemTarget(ChestStoreItemMeaning)), FarmhandActionLifecycle.LiveVerified, "chests"),
        E("chest_retrieve", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(ContainerItemTarget(ChestRetrieveItemMeaning)), FarmhandActionLifecycle.LiveVerified, "chests"),
        E("chop_stump", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, Clears(SelfWalked(SlotTargetWith("axe", FarmhandResourceTemplateValue.AnyUpgrade, AutoSelectedToolSlotMeaning)), "axe", destructive: false, null, "tree_stump"), FarmhandActionLifecycle.LiveVerified, "treeStumpTargets"),
        E("plant_sapling", "farming_crops", FarmhandActionHandlerGroup.Farming, SelfWalked(SlotItemTarget()), FarmhandActionLifecycle.LiveVerified, "treeSaplingTargets"),
        // Scythe actions: the handler selects the actor's own scythe before swinging, from the `tool:scythe` claim
        // below. A scythe has no upgrade ladder, so "any" is exact.
        E("cut_weeds", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, Clears(SelfWalked(SlotTargetWith("scythe", FarmhandResourceTemplateValue.AnyUpgrade, AutoSelectedToolSlotMeaning)), "scythe", destructive: false, null, "weed"), FarmhandActionLifecycle.LiveVerified, "weedTargets"),
        E("cut_grass", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, Clears(SelfWalked(SlotTargetWith("scythe", FarmhandResourceTemplateValue.AnyUpgrade, AutoSelectedToolSlotMeaning)), "scythe", destructive: true, CutGrassRefusalDetail, "grass"), FarmhandActionLifecycle.LiveVerified, "grassTargets"),
        E("clear_cask", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, AutoSelectedToolSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), ToolResource("heavy_hitter_not_melee_weapon", FarmhandResourceTemplateValue.AnyUpgrade), "write", "cask_cleared", "Cask.performToolAction")), FarmhandActionLifecycle.LiveVerified, "caskTargets"),
        E("dress_mannequin", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, HeldItemSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "mannequin_dressed", "Mannequin.performObjectDropInAction")), FarmhandActionLifecycle.LiveVerified, "mannequinTargets"),
        E("set_sign_display", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, HeldItemSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "sign_display_set", "Sign.checkForAction")), FarmhandActionLifecycle.LiveVerified, "signTargets"),
        E("deposit_silo_hay", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, HeldItemSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "silo_hay_deposited", "GameLocation.tryToAddHay")), FarmhandActionLifecycle.LiveVerified, "siloTargets"),
        E("toggle_tool_light", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, AutoSelectedToolSlotMeaning), new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer") }, new Dictionary<string, string>(), ToolResource("lantern", FarmhandResourceTemplateValue.AnyUpgrade), "write", "tool_light_toggled", "Lantern.DoFunction"), FarmhandActionLifecycle.LiveVerified, "lanternSlots"),
        E("withdraw_silo_hay", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "silo_hay_taken", "GameLocation.GetHayFromAnySilo")), FarmhandActionLifecycle.LiveVerified, "siloTargets"),
        E("use_obelisk", "transport_warps", FarmhandActionHandlerGroup.Movement, A(null, null, "obelisk_arrived", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string")) with { Approach = FarmhandActionApproachRequirement.Adjacent }, FarmhandActionLifecycle.LiveVerified, "obeliskTargets"),
        E("toggle_animal_door", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "animal_door_toggled", "Building.ToggleAnimalDoor")), FarmhandActionLifecycle.LiveVerified, "animalDoorTargets"),
        // Item/tile lane. use_warp_item is the native object branch plus the consumption the
        // action-button dispatch pairs with it; pan_ore is the one-use panning lifecycle; the
        // mailbox claim is the TALK/claim verb on a map Action tile. All three stay
        // Experimental until each passes its own native-local live gate.
        E("use_warp_item", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "warp_item_arrived", "Object.performUseAction"), FarmhandActionLifecycle.LiveVerified, "warpItemTargets"),
        E("pan_ore", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, AutoSelectedToolSlotMeaning), new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer") }, new Dictionary<string, string>(), ToolResource("pan", FarmhandResourceTemplateValue.AnyUpgrade), "write", "ore_panned", "Pan.DoFunction"), FarmhandActionLifecycle.LiveVerified, "panSites"),
        E("claim_mail_attachment", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "mail_claimed", "GameLocation.mailbox")), FarmhandActionLifecycle.LiveVerified, "mailboxTargets"),
        // The building-chest pair. Some buildings declare their OWN storage in Data/Buildings
        // (BuildingData.Chests: the Mill's Input/Output, the Junimo Hut's Output), reached by
        // a click on a building tile rather than by any C# class, so neither
        // chest_store/chest_retrieve (player-owned Chests and the fridge) nor
        // machine_load/machine_collect_output (one machine's heldObject) can serve them.
        // Both drive the terminal public `Building.PerformBuildingChestAction`
        // (Building.cs:746) that the native click path ends in, and both prove their
        // postcondition from the world afterwards. Experimental: they stay off the default
        // Agent surface until each passes its own native-local live gate, and the promotion
        // to LiveVerified is a separate catalog edit owned by the parent.
        E("load_building_chest", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(BuildingChestLoad()), FarmhandActionLifecycle.LiveVerified, "buildingChestTargets"),
        E("collect_building_chest_output", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(BuildingChestCollect()), FarmhandActionLifecycle.LiveVerified, "buildingChestTargets"),
        E("scythe_crop", "farming_crops", FarmhandActionHandlerGroup.Farming, Clears(SelfWalked(SlotTargetWith("scythe", FarmhandResourceTemplateValue.AnyUpgrade, AutoSelectedToolSlotMeaning)), "scythe", destructive: true, ScytheCropRefusalDetail, "crop"), FarmhandActionLifecycle.LiveVerified, "scytheCropTargets"),
        E("harvest_bush", "resource_gathering", FarmhandActionHandlerGroup.Farming, SelfWalked(Target()), FarmhandActionLifecycle.LiveVerified, "bushTargets"),
        E("harvest_fruit_tree", "resource_gathering", FarmhandActionHandlerGroup.Farming, SelfWalked(Target()), FarmhandActionLifecycle.LiveVerified, "fruitTreeTargets"),
        E("shake_tree", "resource_gathering", FarmhandActionHandlerGroup.Farming, SelfWalked(Target()), FarmhandActionLifecycle.LiveVerified, "shakeTreeTargets"),
        E("take_pedestal_item", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(Target()), FarmhandActionLifecycle.LiveVerified, "pedestalTargets"),
        E("toggle_fence_gate", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(Target()), FarmhandActionLifecycle.LiveVerified, "fenceGateTargets"),
        // Loop-closure W0a pre-registration. W0a owns registration and routing;
        // the native bodies are lane-owned partials
        // (farmhandexecutioncontroller.{crafting,cooking,crabpot,shipping}actions.cs)
        // whose placeholder terminals are replaced by lanes B/C/D/E.
        // craft_item and cook_recipe share one shape: both carry the opaque recipe
        // content identity in expectedTargetId, which the Mod re-validates against
        // the live craftingRecipes/cookingRecipes table on the game thread (an
        // unknown or unlearned recipe fails closed). cook_recipe's W-rule cooking
        // station adjacency is derived and re-checked Mod-side from the live world,
        // exactly like the other action-level game-thread re-validations, rather
        // than trusting a client-supplied station coordinate.
        // collect_crab_pot_output reuses the machine-collect target shape;
        // ship_item names a shipping bin and an item, with no slot: a walk to a bin
        // takes tens of ticks and a magnet pickup or a stack merge shifts every slot
        // behind the one that changed, so the slot a request closed over is a stale
        // perception by the time it arrives. The body resolves the FIRST carried stack
        // of the item id on arrival instead, the same rule chest_store uses.
        E("craft_item", "crafting_cooking", FarmhandActionHandlerGroup.MachinesAndAnimals, A(null, null, "native_action_postcondition", ("expectedTargetId", "string")), FarmhandActionLifecycle.LiveVerified, "craftingRecipeTargets"),
        E("cook_recipe", "crafting_cooking", FarmhandActionHandlerGroup.MachinesAndAnimals, A(null, null, "native_action_postcondition", ("expectedTargetId", "string")), FarmhandActionLifecycle.LiveVerified, "cookingRecipeTargets"),
        E("collect_crab_pot_output", "buildings_farm_management", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(Target()), FarmhandActionLifecycle.LiveVerified, "crabPotCollectTargets"),
        // Buying is the mirror of ship_item and lives in the same economy family. Its
        // declared shape is (expectedTargetId, expectedQualifiedItemId, quantity): the
        // target is an opaque shop identity, the item is the wire identity of the good,
        // and quantity is clamped against live stock and the purse on the game thread.
        E("shop_purchase", "shops_economy", FarmhandActionHandlerGroup.MachinesAndAnimals, ShopPurchase(), FarmhandActionLifecycle.LiveVerified, "shopTargets"),
        E("ship_item", "shops_economy", FarmhandActionHandlerGroup.MachinesAndAnimals, SelfWalked(ShipItem()), FarmhandActionLifecycle.LiveVerified, "shippingBinTargets"),

        // The actor's OWN attachment state. All three change what the farmer is wearing or
        // riding rather than a world tile, so every postcondition is an ACTOR fact and the opaque
        // target id names a body slot of the actor (hat/boots/shirt/pants/left_ring/right_ring)
        // instead of a coordinate. Both wearable actions drive Farmer.Equip<TItem>, the method the
        // native InventoryPage click path ends in; dismount_transport drives the Horse.dismount
        // terminal the game's own non-interactive callers use. Experimental: each stays off the
        // default Agent surface until it passes its own native-local live gate, and promotion to
        // LiveVerified is a separate catalog edit owned by the parent.
        E("equip_wearable", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, "Backpack slot HOLDING the wearable to equip. `snapshot.toolSlots` lists tools only, so this is NOT a tool slot."), new FarmhandActionArgument("expectedQualifiedItemId", "string"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "wearable_equipped", "Farmer.Equip"), FarmhandActionLifecycle.LiveVerified, "wearableTargets"),
        E("unequip_wearable", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, "Backpack slot the wearable is taken OFF into. It must be EMPTY: an occupied destination is refused by name (`wearable_destination_slot_occupied`)."), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "wearable_unequipped", "Farmer.Equip"), FarmhandActionLifecycle.LiveVerified, "wearableTargets"),
        E("dismount_transport", "animal_transport", FarmhandActionHandlerGroup.Movement, new FarmhandActionDescriptor(Array.Empty<FarmhandActionArgument>(), new Dictionary<string, string>(), EmbodiedActorResource, "write", "transport_dismounted", "Horse.dismount"), FarmhandActionLifecycle.LiveVerified),
    // WIA §4.2 modal-handling family: the ONE action that may run while the
    // world holds a modal. `dismiss_modal` only closes an informational native
    // dialogue (a DialogueBox with no pending question); answering a question
    // dialogue is answer_dialogue's future seam (design 7.4.2) and is refused
    // here. It carries no arguments: the target is the currently open modal
    // itself, and readiness is native state. The receipt is minted by the one
    // execution ledger and the Modal admission profile (AdmitExecution) is the
    // only profile that grants it admission.
    E("dismiss_modal", "modal_handling", FarmhandActionHandlerGroup.Modal, new FarmhandActionDescriptor(
        Array.Empty<FarmhandActionArgument>(),
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "modal_dismissed",
        "DialogueBox.closeDialogue"), FarmhandActionLifecycle.LiveVerified),
            E("answer_dialogue", "modal_handling", FarmhandActionHandlerGroup.Modal, new FarmhandActionDescriptor(
                new[] { new FarmhandActionArgument("responseKey", "string") },
                new Dictionary<string, string>(),
                EmbodiedActorResource,
                "write",
                "answer_dialogue_answered",
                "GameLocation.answerDialogue"), FarmhandActionLifecycle.LiveVerified),
            // respond_level_up settles the pending level-up the actor is being shown: an ordinary level through
            // the menu's own `okButtonClicked` (LevelUpMenu.cs:637-643), or one of the two profession branches at
            // levels 5/10, which the engine only offers inside a mouse handler (:485-506) - a public call sequence,
            // the same shape color_placed_object and ride_minecart accepted.
            //
            // It is NOT dismiss_modal: an ACTIVE LevelUpMenu grants its perk when it closes
            // (cleanupBeforeExit -> okButtonClicked, :629-635), so the menu has no pure-cancel path, and the
            // profession branch writes `Farmer.professions` (a persisted, synced field).
            //
            // `choice` is the game's own input domain and `expectedSkill`/`expectedLevel` are the binding: the Mod
            // refuses unless the displayed menu is about that exact pair.
            E("respond_level_up", "modal_handling", FarmhandActionHandlerGroup.Modal, new FarmhandActionDescriptor(
                new[]
                {
                    new FarmhandActionArgument("choice", "string", LevelUpChoiceEnum),
                    new FarmhandActionArgument("expectedSkill", "integer"),
                    new FarmhandActionArgument("expectedLevel", "integer"),
                },
                new Dictionary<string, string>(),
                EmbodiedActorResource,
                "write",
                "level_up_resolved",
                "LevelUpMenu.okButtonClicked"), FarmhandActionLifecycle.LiveVerified, "pendingLevelUpChoices"),
        // M2 cross-day lifecycle wiring. The catalog contract
        // (single_player_sleep_and_advance_day / end_day_with_all_players_ready)
        // is coordinated, but the AI's own share of it is one bounded native
        // lifecycle: walk to the actor's own bed, let the native sleep path run
        // exactly as the keyboard/mouse paths do, declare local ready through
        // that same native path, then OBSERVE the native Saving/Saved/DayStarted
        // pipeline. It carries no arguments because the target is the actor's own
        // bed and the ready state is native; nothing about it is client-supplied.
        // The receipt is minted by the one execution ledger, so a coordinated
        // terminal (requires_other_player) is traceable rather than a second
        // receipt authority.
        E("sleep", "world_lifecycle", FarmhandActionHandlerGroup.WorldLifecycle, Lifecycle(), FarmhandActionLifecycle.LiveVerified),
        // The one SOCIAL act that is not about an NPC in front of the actor: say a line to the whole lobby
        // through the game's own chat egress (`Multiplayer.sendChatMessage`, Multiplayer.cs:1127). No body, no
        // geometry, no target, no world write - it takes exactly one string and its terminal proves the SEND.
        E("send_multiplayer_chat", "npc_social", FarmhandActionHandlerGroup.Expression, A(null, null, "chat_message_sent", ("text", "string")), FarmhandActionLifecycle.LiveVerified),
        // Empties a built fish pond through `FishPond.ClearPond()` (Buildings/FishPond.cs:840) -
        // public, no arguments, and reached in-game only through the pond menu's two-click
        // confirmation, which is UI-only state with no game-logic fork. The body DROPS the fish as
        // ground debris and resets the pond, which is the destructiveness the boundary card names.
        E("color_placed_object", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string"), new FarmhandActionArgument("colorSelection", "integer") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "placed_object_recolored", "DiscreteColorPicker.getColorFromSelection")), FarmhandActionLifecycle.LiveVerified, "colorTargets"),
      E("clear_fish_pond", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "fish_pond_cleared", "FishPond.ClearPond")), FarmhandActionLifecycle.LiveVerified, "fishPondTargets"),
        // Commission a NEW farm building through `GameLocation.buildStructure` (GameLocation.cs:16926
        // -> :16800), the exact settlement `CarpenterMenu.tryToBuild` calls at :1087. Only the BUILD
        // branch of the carpenter menu is this action; demolish, move and paint are separate world
        // changes and are deferred. The cost the seam does NOT charge (the Data/Buildings BuildCost
        // and BuildMaterials) is debited by the handler itself, because the only native debit lives
        // on the menu (CarpenterMenu.ConsumeResources) and driving the menu is forbidden.
        //
        // `Synthetic: true` is the honest half of that: the companion spends the gold and the wood and
        // places the structure without Robin's counter, her hours or her build queue, so a reader of the
        // artifact can tell this apart from a commission the player would have made there.
        E("build_farm_building", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SelfWalked(new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("buildingType", "string"), new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "farm_building_built", "GameLocation.buildStructure", Synthetic: true)), FarmhandActionLifecycle.LiveVerified, "farmBuildingTargets"),
        // Accepting the day's help-wanted quest. The handler carries ONLY the write half of
        // Billboard.receiveLeftClick's acceptQuestButton branch (Menus/Billboard.cs:363-374): the
        // daily/accepted/daysLeft fields on Game1.questOfTheDay, the quest-log entry and
        // Farmer.acceptedDailyQuest. The branch's click sound and button refresh are presentation
        // and are not reproduced. Experimental: it has no live gate yet, and promotion to
        // LiveVerified is a separate catalog edit owned by the parent.
        E("accept_daily_quest", "quests_journal", FarmhandActionHandlerGroup.WorldLifecycle, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "daily_quest_accepted", "Quest.accept"), FarmhandActionLifecycle.LiveVerified, "dailyQuestTargets"),
        // accept_special_order takes one offered special order through the creation half's public,
        // menu-free face (FarmerTeam.AddSpecialOrder, FarmerTeam.cs:681). The board's own Accept branch also
        // writes the board marker, which the handler reproduces; see
        // farmhandexecutioncontroller.specialorders.cs.
        E("accept_special_order", "quests_journal", FarmhandActionHandlerGroup.WorldLifecycle, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "special_order_accepted", "FarmerTeam.AddSpecialOrder"), FarmhandActionLifecycle.LiveVerified, "specialOrderTargets"),
        // claim_museum_reward collects the museum's computed reward set through the two native members the
        // reward menu's own flow uses (LibraryMuseum.getRewardsForPlayer + LibraryMuseum.OnRewardCollected);
        // see farmhandexecutioncontroller.museumrewards.cs.
        E("claim_museum_reward", "quests_journal", FarmhandActionHandlerGroup.WorldLifecycle, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "museum_rewards_collected", "LibraryMuseum.getRewardsForPlayer"), FarmhandActionLifecycle.LiveVerified, "museumRewardTargets"),
        // Give the actor's OWN horse its name through the game's own naming settlement
        // (`Horse.nameHorse`, Characters/Horse.cs:570): public, UI-free, and the body the naming
        // menu's own callback binding (Horse.cs:637) ends in. The subject is the actor's own
        // horse (`Utility.findHorseForPlayer`), so it carries the wire's one free-text argument
        // and NO target id - an unnamed horse is published by no projection.
        E("name_entity", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, A(null, null, "entity_named", ("text", "string")), FarmhandActionLifecycle.LiveVerified),
        // Redeeming one prize ticket at the machine. The exchange is the timed branch inside
        // `PrizeTicketMenu.update` (Menus/PrizeTicketMenu.cs:180-185): the prize the machine's own track
        // head derives, the native `addItemToInventoryBool` delivery, `Items.ReduceId("PrizeTicket", 1)`
        // and `stats.Increment("ticketPrizesClaimed")`. There is no single settlement to call and the
        // click handler only arms UI state (:145-160), so the handler reproduces that PUBLIC CALL
        // SEQUENCE and re-derives the choice from the game's own public faces
        // (`PrizeTicketMenu.getPrizeItem` + the live `ticketPrizesClaimed` stat) - the B1b form
        // `design/domains/stardew/menu-bound-and-ui-boundary.md` 2.1 already ruled on.
        // No arguments: the subject is the actor's own ticket stack and the machine's own track
        // position, both native state that no projection publishes. Experimental: it has no live gate
        // yet, and promotion to LiveVerified is a separate catalog edit owned by the parent.
        E("redeem_prize_ticket", "shops_economy", FarmhandActionHandlerGroup.WorldLifecycle, new FarmhandActionDescriptor(Array.Empty<FarmhandActionArgument>(), new Dictionary<string, string>(), EmbodiedActorResource, "write", "prize_ticket_redeemed", "PrizeTicketMenu.getPrizeItem"), FarmhandActionLifecycle.LiveVerified),
        // The sewing machine. Both actions are backpack transactions: the actor names TWO slots and the
        // opaque pair identity discovery published. `tailor_clothing` consumes the cloth and the reagent a
        // live recipe pairs and produces that recipe's garment (`TailoringMenu.CraftItem`);
        // `dye_clothing_with_item` recolours one existing garment from one dye item
        // (`TailoringMenu.DyeItems`). Neither carries a coordinate: the subject is the actor's own backpack,
        // not a world tile. Experimental: each stays off the default Agent surface until it passes its own
        // native-local live gate, and promotion to LiveVerified is a separate catalog edit owned by the
        // parent. See farmhandexecutioncontroller.tailoringactions.cs.
        E("tailor_clothing", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("leftSlot", "integer"), new FarmhandActionArgument("rightSlot", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "clothing_tailored", "TailoringMenu.CraftItem"), FarmhandActionLifecycle.LiveVerified, "tailoringTargets"),
        E("dye_clothing_with_item", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("leftSlot", "integer"), new FarmhandActionArgument("rightSlot", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "clothing_dyed", "TailoringMenu.DyeItems"), FarmhandActionLifecycle.LiveVerified, "tailoringTargets"),
        // The blacksmith's geode counter. The geode is NOT a menu slot: `GeodeMenu` holds it as the CURSOR
        // item (`heldItem`, GeodeMenu.cs:133) and mints the treasure from it inside its own update
        // (:373-385, delivered at :230). So the request names the BACKPACK slot the geode comes from plus
        // the id it expects to find there, and no coordinate: the counter is Clint's own dialogue case
        // (GameLocation.cs:12345-12346, `Game1.activeClickableMenu = new GeodeMenu()`), not a world tile.
        // Experimental: no live gate yet, and promotion to LiveVerified is a separate catalog edit owned
        // by the parent. See farmhandexecutioncontroller.geodeactions.cs.
        E("open_geode", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, "The backpack slot holding the geode, taken from the observation inventory row."), new FarmhandActionArgument("expectedQualifiedItemId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "geode_opened", "GeodeMenu.receiveLeftClick"), FarmhandActionLifecycle.Experimental),
    });

    /// <summary>
    /// Every registered action whose WORKING PRECONDITION is an open modal - the set the registration's own
    /// handler group already declares (<see cref="FarmhandActionHandlerGroup.Modal"/>).
    ///
    /// It is derived here rather than written out beside each gate that needs it, because two gates DO need it and
    /// they have to agree: the flat admission decides which actions may be admitted while a menu is up, and the
    /// Body Program pump decides which nodes may be dispatched while one is up. A hand-written second list would let
    /// the pump refuse the very node that exists to close the menu the pump is waiting for - which is what it did:
    /// `dismiss_modal` parked for the whole cadence window whenever a modal was open. Deriving from the catalog means
    /// registering an action as modal-resolving is ONE edit, and both gates move together.
    /// </summary>
    public static readonly IReadOnlySet<string> ModalResolvingActionIds = new HashSet<string>(
        Registrations.Where(registration => registration.HandlerGroup == FarmhandActionHandlerGroup.Modal).Select(registration => registration.ActionId),
        StringComparer.Ordinal);

    /// <summary>Whether an action's working precondition is an open modal. Unknown ids are not.</summary>
    public static bool IsModalResolving(string? actionId) => actionId is not null && ModalResolvingActionIds.Contains(actionId);

    /// <summary>
    /// The modal-family members whose HANDLER has an event path: called while an event runs, they act on the event's
    /// own dialogue box instead of waiting for the scene to end.
    ///
    /// <para>
    /// WHY THIS EXISTS. The admission admitted the modal family only while a modal was mounted AND no cutscene was
    /// running, so a cutscene refused the family - and a cutscene's own dialogue box is the ONE thing two of its three
    /// handlers exist to close. Measured from a live run's transcript: four retries over twenty minutes against
    /// `cutscene_active`, ending in "Persistent cutscene ... I just wait." and <c>镇上好像有事件正演着，我的脚被定住了，动不了。</c>
    /// The agent was right about the mechanism and had no action to try.
    /// </para>
    /// <para>
    /// Membership is a CLAIM about the handler, so it is not derivable from the catalog row: `CutsceneModalAdmissionTests`
    /// reads each member's handler body and each member's own event seam (`Game1.eventUp` for a branch,
    /// `DialogueBox.closeDialogue` for the native close that advances an event), failing by name when a member here has
    /// lost that seam - or when a handler grows one without joining here. Every other modal-family member must be
    /// declared in <see cref="ModalFamilyActionsWithoutAnEventPath"/> instead, so a new row cannot stay undecided.
    /// </para>
    /// </summary>
    public static readonly IReadOnlySet<string> EventActingActionIds = new HashSet<string>(
        new[]
        {
            // Answers a question raised inside the cutscene, on the event itself (`Event.answerDialogue`).
            "answer_dialogue",
            // Closes the cutscene's informational box through the native close, which advances the event.
            "dismiss_modal",
        },
        StringComparer.Ordinal);

    /// <summary>
    /// The modal-family members whose handler has NO event path, each with the native reason. An entry here is a
    /// decision, not an omission: the action stays refused while an event runs (`cutscene_active`) because nothing its
    /// handler does can reach the event.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> ModalFamilyActionsWithoutAnEventPath =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["respond_level_up"] =
                "its handler requires Game1.activeClickableMenu to BE a LevelUpMenu, and the engine raises that menu only "
                + "from the overnight rollover (Game1.cs:9121-9134), never from an event: no event branch exists and a "
                + "cutscene holding a LevelUpMenu is not a state the engine produces",
        };

    /// <summary>Whether an action's handler acts on a RUNNING event. Unknown ids, and ids with no event path, are not.</summary>
    public static bool IsEventActing(string? actionId) => actionId is not null && EventActingActionIds.Contains(actionId);

    static FarmhandActionCatalog() { if (Registrations.Select(x => x.ActionId).Distinct(StringComparer.Ordinal).Count() != Registrations.Count) throw new InvalidOperationException("Farmhand action registrations must have unique action IDs."); }
    private static FarmhandActionRegistration E(string id, string family, FarmhandActionHandlerGroup group, FarmhandActionDescriptor descriptor, FarmhandActionLifecycle lifecycle = FarmhandActionLifecycle.Published, string? targetFamily = null) => new(id, family, 1, lifecycle, FarmhandOperationKind.Execution, group, targetFamily is null ? descriptor : descriptor with { TargetFamily = targetFamily });

    /// <summary>
    /// The same descriptor with its approach requirement declared as <see cref="FarmhandActionApproachRequirement.SelfWalked"/>:
    /// this action's handler closes the distance itself, so the surface says so instead of saying nothing.
    ///
    /// One wrapper rather than a `with { Approach = ... }` at every row, because the fact is the same on all of them and
    /// `ApproachDeclarationCoverageTests` derives the set of rows that must carry it from the handlers themselves.
    /// </summary>
    private static FarmhandActionDescriptor SelfWalked(FarmhandActionDescriptor descriptor) =>
        descriptor with { Approach = FarmhandActionApproachRequirement.SelfWalked };

    /// <summary>
    /// The same descriptor with the OCCUPANTS it removes and the PRICE of removing them declared, in the engine's own
    /// names for the occupants.
    ///
    /// <para>
    /// It lives on the action rather than in a table beside the catalog because the question it answers is asked at a
    /// refusal - "what of mine takes this weed away, and what does that cost me?" - and a table beside the surface
    /// would keep naming an action after that action stopped accepting the occupant.
    /// <see cref="GameBuddy.Stardew.Core.ClearingActionSurface"/> is the join: it reads these declarations and nothing
    /// else.
    /// </para>
    /// <para>
    /// One wrapper rather than a `with { Clears = ... }` at every row, because `E` already re-writes the descriptor for
    /// its target family and a nested `with` at each of the eight rows would obscure which of the two facts each row is
    /// declaring. `turns` is one on every row: a clearing action is one dispatched action.
    /// </para>
    /// <para>
    /// <paramref name="destructive"/> and <paramref name="refusalDetail"/> are BOTH REQUIRED, and the rows justify their
    /// own answer in <see cref="FarmhandClearingDeclaration.Destructive"/>. They are required because the flag's absence is
    /// the defect it exists to remove: a default would let the next clearing row declare a wipe as a way through without
    /// ever noticing that the two are different, and would let it refuse by code alone without saying what the code means.
    /// </para>
    /// </summary>
    private static FarmhandActionDescriptor Clears(FarmhandActionDescriptor descriptor, string tool, bool destructive, string? refusalDetail, params string[] occupants) =>
        descriptor with { Clears = new FarmhandClearingDeclaration(Array.AsReadOnly(occupants), new FarmhandClearingCost(tool, 1), destructive, refusalDetail) };

    private static FarmhandActionRegistration R(string id, string family) => new(id, family, 1, FarmhandActionLifecycle.Published, FarmhandOperationKind.ReadOnly, null, A(null, Array.Empty<FarmhandActionResourceTemplateClaim>(), "observation_complete"));
    private static FarmhandActionDescriptor A(IReadOnlyDictionary<string,string>? facts = null, IReadOnlyList<FarmhandActionResourceTemplateClaim>? resources = null, string postcondition = "native_action_postcondition", params (string,string)[] args) => new(args.Select(x => new FarmhandActionArgument(x.Item1,x.Item2)).ToArray(), facts ?? new Dictionary<string,string>(), resources ?? EmbodiedActorResource, resources is { Count: 0 } ? "read" : "write", postcondition);

    /// <summary>
    /// The same descriptor with each argument carrying a MEANING.
    ///
    /// A separate entry point because `A` takes `(name, type)` pairs, and passing a description as the second element
    /// of a pair silently writes a sentence into `type` - measured 2026-10-29, `use_raft` published
    /// `"slot": {"type": "The TOOL's backpack slot..."}`. A signature that cannot express the mistake is worth more
    /// than a comment warning about it.
    /// </summary>
    private static FarmhandActionDescriptor Described(FarmhandActionArgument[] arguments, string postcondition = "native_action_postcondition") => new(arguments, new Dictionary<string,string>(), EmbodiedActorResource, "write", postcondition);

    /// <summary>
    /// What `slot` means on an action whose handler compares the named slot against the actor's held one.
    ///
    /// Published per ARGUMENT rather than as one Host-side paragraph, because the families disagree: some handlers read
    /// `Items[CurrentToolIndex]` and refuse a slot that is not the held one, while an item action's slot is any pack
    /// index. One sentence covering both was false for one of them - measured 2026-10-29, the Host carried exactly such a
    /// sentence ("never a backpack index") that is false for all four of them.
    ///
    /// <para>
    /// An action that declares a `tool:&lt;category&gt;` claim publishes <see cref="AutoSelectedToolSlotMeaning"/> instead:
    /// its handler selects the tool its own claim names and restores the actor's selection afterwards, so a slot that
    /// differs from `currentToolSlot` is recorded rather than refused. `InventoryAddressabilityTests` reads each published
    /// claim and fails when an action's slot description and its enforcement disagree.
    /// </para>
    ///
    /// <para>
    /// WHO STILL PUBLISHES THIS SENTENCE, and why it is a gap rather than a design: the five actions whose requirement is
    /// a native PREDICATE rather than a category - `clear_cask` and `break_container` (any `isHeavyHitter()` tool),
    /// `remove_placed_item` (an Axe OR a Pickaxe), `toggle_tool_light` (a Lantern) and `use_raft` (a Raft). A
    /// `tool:&lt;category&gt;` claim names one category and cannot say "any of these", so those handlers still demand the
    /// hand. `ToolPreconditionUniformityTests.TheActionsWhoseToolRequirementIsAPredicateAreNamed` prints them on every
    /// run; that list shrinking is the measure of this gap closing, and it is what stops the sentence from spreading.
    /// </para>
    /// </summary>
    private const string ToolSlotMeaning = "The TOOL's backpack slot, which must also be `snapshot.currentToolSlot`: the tool family validates `CurrentToolIndex == slot` and the tool's own type. `equipFor` writes the equip step and answers this slot for you.";

    /// <summary>What `slot` means on an action that consumes an inventory item: any backpack index, no tool rule.</summary>
    private const string ItemSlotMeaning = "The item's backpack slot. Unlike a tool action's slot this need not be the held one - `snapshot.toolSlots` lists tools only, so an item's slot is never published there.";

    /// <summary>
    /// What `slot` means on an action that takes a carried TOOL and does not require it to be the held one.
    ///
    /// Every action that consumes a tool declares a `tool:` claim and selects the tool it names itself
    /// (`ResolveDeclaredTool` / `TrySelectDeclaredTool`), so the number a caller passes is recorded in the receipt and
    /// never compared to `CurrentToolIndex`. Publishing <see cref="ToolSlotMeaning"/> there demanded something nothing
    /// checks: a caller reading it would believe a mismatch is refused when it is ignored.
    /// </summary>
    private const string AutoSelectedToolSlotMeaning = "The TOOL's backpack slot, copied from `snapshot.toolSlots`. This action selects the tool its own `tool:` claim declares and restores the actor's selection afterwards, so the number need NOT be `snapshot.currentToolSlot` - it is reported in the receipt, not validated against the held slot.";

    /// <summary>
    /// What `slot` means on an action whose named slot must hold the exact item AND be the held one.
    ///
    /// `clear_debris` is the tool case of this shape: it uses the tool in the named slot but never requires it to be
    /// held. The item actions below do require it, and they read `Items[CurrentToolIndex]` through `TryGetHeldItem`.
    /// </summary>
    private const string CarriedToolSlotMeaning = "The TOOL's backpack slot, copied from `snapshot.toolSlots`. The slot must hold a tool this action can use, but it need not be `snapshot.currentToolSlot`: the handler takes the tool from the named slot directly.";

    /// <summary>What `slot` means on an action that consumes a held non-tool item (clothing, a display item, hay).</summary>
    private const string HeldItemSlotMeaning = "The backpack slot HOLDING the item this action consumes, which must also be `snapshot.currentToolSlot`: the handler reads `Items[CurrentToolIndex]` and refuses with a named `*_not_held_in_requested_slot` code when the named slot is not the held one. `snapshot.currentToolSlotItem` names what that slot holds.";

    /// <summary>
    /// What `x`/`y` mean on a location-transition action: the WARP or DOOR tile you stand next to, never the tile you
    /// end up on.
    ///
    /// Measured 2026-10-30 (`round8`): the companion was at `Farm:60,26` and called
    /// `builder.enter_exit({ x: 64, y: 14 })` - the FarmHouse door's own source tile, which it had read from
    /// `snapshot.warps[]`. The script COMPILED, and the runtime then refused with
    /// `door_out_of_range source=64,14;door=64,14` because the actor was sixteen tiles away. The refusal carried
    /// `requiredArguments: [{name:"x",type:"integer"},{name:"y",type:"integer"}]`, so the model already knew the
    /// names - what it could not know is that these coordinates name the SOURCE side of a transition. Every other
    /// action family in this catalog uses `x`/`y` for the tile being acted on, which makes the wrong reading the
    /// natural one.
    /// </summary>
    public const string TransitionSourceTileMeaning = "The SOURCE tile of the transition - the door or warp tile you must already be standing next to. This is NOT the destination: which map and tile you arrive at is decided by the warp itself, and `snapshot.warps[]` lists each one as `{sourceX, sourceY, target, accessible}` with the source side matching these coordinates.";
    private static FarmhandActionDescriptor Target() => A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("expectedTargetId","string"));

    /// <summary>
    /// A location transition whose coordinates name the door/warp SOURCE tile.
    ///
    /// `enterExit` is true only for `enter_exit`, and the distinction is measured rather than stylistic: `execute`
    /// resolves the warp from the coordinates and drives the transition itself, so `travel` reaches
    /// `travel_completed` from wherever the actor stands - 15 receipts in the 2026-10-30 run, none refused for distance.
    /// `enter_exit` additionally goes through the native door action, which needs the actor ADJACENT to the door tile
    /// (`door_out_of_range source=64,14;door=64,14` while it stood at `60,26`). Declaring an approach for a
    /// self-walking action is a false precondition: it tells the caller to do work the action will do.
    /// </summary>
    private static FarmhandActionDescriptor Transition(bool entersDoor) => new(
        new[]
        {
            new FarmhandActionArgument("x", "integer", null, TransitionSourceTileMeaning),
            new FarmhandActionArgument("y", "integer", null, TransitionSourceTileMeaning),
        },
        new Dictionary<string, string>(),
        Array.Empty<FarmhandActionResourceTemplateClaim>(),
        "write",
        "native_action_postcondition")
    {
        // A transition's x/y is the warp SOURCE tile, and an edge exit's source lies one tile OUTSIDE the map, so this
        // action's coordinate floor is the producer's own source floor rather than the walk-target one. Every other
        // action using x/y keeps the default 0: an off-map tile is never a walk target.
        Acceptance = new FarmhandExecutionAcceptanceFacts(
            MinimumTileCoordinate: FarmhandWarpCoordinateRange.MinimumSourceCoordinate),
        Approach = entersDoor ? FarmhandActionApproachRequirement.Adjacent : null,
    };

    private static FarmhandActionDescriptor TargetWith(string toolCategory, FarmhandResourceTemplateValue toolUpgrade) => A(null, ToolResource(toolCategory, toolUpgrade), "native_action_postcondition", ("x","integer"),("y","integer"),("expectedTargetId","string"));

    private static FarmhandActionDescriptor SlotTargetWith(string toolCategory, FarmhandResourceTemplateValue toolUpgrade, string slotMeaning) => new(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, slotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), ToolResource(toolCategory, toolUpgrade), "write", "native_action_postcondition");
    private static FarmhandActionDescriptor TargetItem() => A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("expectedQualifiedItemId","string"),("expectedTargetId","string"));
    private static FarmhandActionDescriptor PickupForage() => new(
        new[]
        {
            new FarmhandActionArgument("x", "integer"),
            new FarmhandActionArgument("y", "integer"),
            new FarmhandActionArgument("expectedQualifiedItemId", "string"),
            new FarmhandActionArgument("expectedTargetId", "string"),
        },
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "native_action_postcondition",
        null,
        new FarmhandActionObservationBindingDescriptor("ObservationBinding", 1, true, new[] { "observationId", "ref" }));
    private static FarmhandActionDescriptor SlotTarget(string slotMeaning) => new(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, slotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "native_action_postcondition");

    /// <summary>
    /// What `chestId` means on the two container actions: the published identity of the container, which IS
    /// its address.
    ///
    /// No `x`/`y` beside it, because that would be the same fact twice: `BuildContainerTargetId` hashes the
    /// location, the tile and the chest type into this one id, and the body reverses that by walking the
    /// location's containers and matching the id (`ResolveStorageContainerById`) - so the tile is *derived*
    /// here rather than trusted from the caller, and a container that has moved no longer matches anything.
    /// </summary>
    private const string ChestIdMeaning = "The container's published id, copied from `targetId` of the chestStoreTargets / chestRetrieveTargets row you mean. It already names the location, the tile and the chest type, so there is no separate `x`/`y` argument: the body re-derives the tile from this id and refuses `chest_target_changed` when no live container answers to it (removed, moved, or replaced by another chest type). A fridge is named by the same kind of id.";

    /// <summary>
    /// What `expectedQualifiedItemId` means when storing: which carried item to put in.
    ///
    /// No `slot`, and the reason is the item itself rather than a convenience. The container half of this
    /// action is named by ONE identity, and the pack half is the same kind of fact: the body takes the first
    /// carried stack of this item id - the exact rule `chest_retrieve` has always used on the container side
    /// (`GetItemsForPlayer().FirstOrDefault(...)`) - so two carried stacks of one item are one address here
    /// too. The slot that actually moved is published in the receipt's evidence.
    /// </summary>
    private const string ChestStoreItemMeaning = "The item id to move, copied from `qualifiedItemId` of the chestStoreTargets row. There is no `slot`: the body takes the FIRST stack of this item id in the backpack and releases exactly that stack, and the receipt's `source_slot` names which one moved. Refused `item_not_owned_in_slot` when the backpack holds none of it by then.";

    /// <summary>What `expectedQualifiedItemId` means when taking: which item inside the container to withdraw.</summary>
    private const string ChestRetrieveItemMeaning = "The item id to move, copied from `qualifiedItemId` of the chestRetrieveTargets row. There is no `slot`: the body takes the FIRST stack in the container holding this item id, so the item id is the whole address on the container's side too. Refused `chest_empty` when nothing there still holds it.";

    /// <summary>
    /// A storage-container action: name the container, name the item.
    ///
    /// Two arguments and no geometry, because a container action's subject is a container and an item - the
    /// tile and the pack slot are facts the snapshot already publishes, and asking for them again asked the
    /// caller to keep two spellings of one address in sync (`slot` for `chest_retrieve` was worse still: the
    /// item lives in the CHEST's slots, and the handler never read the value at all). Perception mirrors the
    /// world completely; this descriptor is the execution slice, and the slice is the two facts the body
    /// cannot derive - which container, which item. Everything else it re-derives on the game thread.
    /// </summary>
    private static FarmhandActionDescriptor ContainerItemTarget(string itemMeaning) => new(
        new[]
        {
            new FarmhandActionArgument("chestId", "string", null, ChestIdMeaning),
            new FarmhandActionArgument("expectedQualifiedItemId", "string", null, itemMeaning),
        },
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "native_action_postcondition");

    /// <summary>
    /// load_building_chest carries a required `slot` because the native Load branch reads
    /// `who.ActiveObject` (Building.cs:764) — the HELD item, which is `Items[CurrentToolIndex]`
    /// — and not "some item in the pack", unlike chest_store. The slot names the inventory
    /// slot to HOLD for the call, which is what the branch reads; this action selects it around
    /// the call and restores the previous selection afterwards, refusing with
    /// item_not_owned_in_slot when the slot holds no Object. x,y is the building chest's
    /// published interaction tile and expectedTargetId the opaque "which building's which
    /// chest" id.
    /// </summary>
    private static FarmhandActionDescriptor BuildingChestLoad() => new(
        new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, "The backpack slot holding the item to load. This action SELECTS that slot for the native call and restores the previous selection after, so it need not be the held one now - but it is not a tool slot."), new FarmhandActionArgument("expectedTargetId", "string") },
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "building_chest_loaded",
        "Building.PerformBuildingChestAction");

    /// <summary>
    /// collect_building_chest_output takes no slot: the native Collect branch takes whatever
    /// single stack the chest holds, and a chest holding two or more stacks is refused by name
    /// (building_chest_requires_menu) rather than handed to the container menu the branch would
    /// otherwise open.
    /// </summary>
    private static FarmhandActionDescriptor BuildingChestCollect() => new(
        new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") },
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "building_chest_output_collected",
        "Building.PerformBuildingChestAction");

    /// <summary>
    /// ride_minecart carries the station tile plus the opaque published ride
    /// selector, and names the ride's own terminal so the Host can map exactly
    /// this action's postcondition instead of a bare coordinate pair.
    /// </summary>
    /// <summary>shop_purchase carries an opaque shop target, the good's wire identity and a
    /// quantity. It deliberately has no coordinates: it buys from a shop the actor already
    /// stands next to, and refuses with shop_counter_out_of_reach otherwise, because
    /// walking is move_to_tile's job — so a walk failure is never reported as a trade
    /// failure.</summary>
    private static FarmhandActionDescriptor ShopPurchase() => A(
        null,
        null,
        "item_purchased",
        ("expectedTargetId", "string"), ("expectedQualifiedItemId", "string"), ("quantity", "integer"));

    private static FarmhandActionDescriptor MinecartRide() => A(
        null,
        null,
        "minecart_ride_completed",
        ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string"));

    /// <summary>
    /// The mine elevator has no client coordinate: its whole intent is WHICH
    /// already-reached floor to select, and the native floor set is a pure function
    /// of the live <c>MineShaft.lowestLevelReached</c> (floor 0, plus every multiple
    /// of 5 up to min(lowestLevelReached, 120) — the exact enumeration
    /// <c>MineElevatorMenu</c> builds at MineElevatorMenu.cs:16/37). The Mod
    /// re-derives that set on the game thread and refuses an unadvertised floor, so a
    /// client cannot use this action to teleport to a level the player has not
    /// reached.
    ///
    /// Terminal: the selection the menu itself performs —
    /// <c>Game1.enterMine(floor)</c> after setting the public
    /// <c>Farmer.ridingMineElevator</c> flag (the mine entrance reads it to place the
    /// actor on the elevator tile rather than the ladder), or for floor 0 the
    /// <c>Game1.warpFarmer("Mine", 17, 4)</c> return. Both are public; the floor
    /// SELECTION only exists inside the menu's receiveLeftClick, which is why this is
    /// an action rather than a travel target. See
    /// farmhandexecutioncontroller.mineelevatoractions.cs.
    /// </summary>
    private static FarmhandActionDescriptor ElevatorFloor() => A(
        null,
        null,
        "mine_elevator_floor_selected",
        ("expectedTargetId", "string"));

    /// <summary>
    /// ship_item's subject is a shipping bin and an item, so it declares the bin's footprint tile (a hint the body
    /// never executes against - the live bin is re-resolved by its opaque id) and the item id the body resolves the
    /// FIRST carried stack of. The item id's meaning is published here because `plan_shape` answers from it.
    /// </summary>
    private static string ShipItemMeaning =>
        "The item id to ship, copied from `qualifiedItemId` of the shippingBinTargets row. There is no `slot`: the body takes the FIRST carried stack of this item id on arrival and ships exactly that stack, because the walk to a bin takes many ticks and a magnet pickup or a stack merge shifts slots on the way. The receipt's `slot` names which stack actually moved.";

    /// <summary>
    /// The item id the ship body resolves on arrival. A separate helper from <see cref="TargetItem"/> because this
    /// action's item is what it hands to the native bin, not what it harvests from a tile.
    /// </summary>
    private static FarmhandActionDescriptor ShipItem() => new(
        new[]
        {
            new FarmhandActionArgument("x", "integer"),
            new FarmhandActionArgument("y", "integer"),
            new FarmhandActionArgument("expectedQualifiedItemId", "string", null, ShipItemMeaning),
            new FarmhandActionArgument("expectedTargetId", "string", null, ShippingBinIdMeaning),
        },
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "native_action_postcondition");

    /// <summary>
    /// The opaque shipping-bin identity, stated where the action that takes it can publish it: it already binds the
    /// location and the bin's footprint, so the body re-resolves the live bin from it and a bin that moved or was
    /// replaced is refused as `shipping_bin_target_changed` rather than retargeted.
    /// </summary>
    private const string ShippingBinIdMeaning =
        "The bin's published id, copied from `targetId` of the shippingBinTargets row. It already names the location and the bin's footprint, so the body re-resolves the live bin from it; a bin that has moved or been replaced is refused `shipping_bin_target_changed` instead of being retargeted onto whatever now stands there.";

    /// <summary>advance_day carries no arguments: its target is the actor's own bed and its
    /// readiness is native state, so no client coordinate, slot, or target identity is trusted.</summary>
    private static FarmhandActionDescriptor Lifecycle() => new FarmhandActionDescriptor(
        Array.Empty<FarmhandActionArgument>(),
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "day_advanced",
        null) with
    {
        WatchdogMs = FarmhandActionCatalog.LifecycleWatchdogMs,
    };
    /// <summary>
    /// `machine_load`'s subject is a machine tile, a carried slot and the item that slot holds. The item is NOT pinned
    /// here: which inputs a machine accepts is the machine's own content (`Data/Machines`), so the surface names the
    /// machine row that answers it instead of restating one answer in this source.
    ///
    /// <para>
    /// It used to be `SlotItemTarget("(O)433")` - one Keg rule (five coffee beans) published as a general machine
    /// action, with the handler refusing every other machine by name. The pin was a boundary in the wrong place: the
    /// game has a whole table of machine rules, and `Data/Machines` already states every one of them. Measured
    /// 2026-10-31: a furnace, a preserves jar and a cheese press were all refused by an action whose name promised
    /// machines generally.
    /// </para>
    /// </summary>
    private static FarmhandActionDescriptor MachineLoad() => Described(new[]
    {
        new FarmhandActionArgument("x", "integer"),
        new FarmhandActionArgument("y", "integer"),
        new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning),
        new FarmhandActionArgument("expectedQualifiedItemId", "string", null, MachineLoadItemMeaning),
        new FarmhandActionArgument("expectedTargetId", "string"),
    });

    /// <summary>
    /// Where `machine_load`'s item comes from: the machine, not this catalog. The body re-reads the machine's own
    /// `Data/Machines` rows on the game thread and asks the machine itself whether it takes this item, so the value a
    /// caller can copy is the one discovery published on that machine's row.
    /// </summary>
    private const string MachineLoadItemMeaning =
        "The item to load into the machine, copied from `loadInputQualifiedItemId` of the machineTargets row. The machine's own Data/Machines rows decide which inputs it accepts and how many it consumes; the row publishes the item that machine takes. An input its data does not accept is refused `machine_load_unsupported_input`, and that refusal names the inputs the machine does take.";

    private static FarmhandActionDescriptor SlotItemTarget(string? exactQualifiedItemId = null) => exactQualifiedItemId is null
            ? Described(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string"), new FarmhandActionArgument("expectedTargetId", "string") })
            : Described(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string", null, ExactItemPinMeaning(exactQualifiedItemId)), new FarmhandActionArgument("expectedTargetId", "string") }) with
        {
            Acceptance = new FarmhandExecutionAcceptanceFacts(ExactExpectedQualifiedItemId: exactQualifiedItemId),
        };

    /// <summary>
    /// The sentence that publishes an exact item pin on the argument the pin narrows.
    ///
    /// The pin is a real product boundary where an action takes exactly one item: `place_wood_fence` takes `(O)322`,
    /// `place_crab_pot` `(O)710`, `bait_crab_pot` `(O)685`. What was wrong was that a caller could not SEE it: the
    /// argument is a bare `string` and the only way to learn the restriction was to be refused. `plan_shape` answers
    /// from these descriptions, so this is where a caller looks BEFORE writing a plan.
    ///
    /// `machine_load` used to be in this list and is not any more: the item a machine accepts is its own content row,
    /// so it is published on the machine row (`loadInputQualifiedItemId`) rather than pinned here - see
    /// <see cref="MachineLoadItemMeaning"/>.
    ///
    /// Derived from the SAME value that builds the acceptance fact, never a second spelling: the published sentence
    /// cannot promise something the enforcement does not do, and a new exact-pinned action inherits it by declaring
    /// its pin once.
    /// </summary>
    private static string ExactItemPinMeaning(string exactQualifiedItemId) =>
        $"Exactly {exactQualifiedItemId}, and no other qualified item id: this action's acceptance refuses every other value on this argument before any native call runs. Copy the id from the target's own published field instead of substituting the item you would rather use.";
    /// <summary>
    /// Frozen Body Program read-only source descriptor: machine_inspect is a
    /// read-only observation whose declared output fact machine_target_id:string
    /// carries the action-validated opaque machine target identity that
    /// machine_load's expectedTargetId binds via RFC 6901 on the exact
    /// producing {programId,nodeId,nodeAttempt}.
    /// </summary>
    private static FarmhandActionDescriptor MachineInspect() => new(
        new[] { new FarmhandActionArgument("x","integer"), new FarmhandActionArgument("y","integer"), new FarmhandActionArgument("expectedTargetId","string") },
        new Dictionary<string, string> { ["machine_target_id"] = "string" },
        EmbodiedActorResource, "read", "native_action_postcondition");
}
