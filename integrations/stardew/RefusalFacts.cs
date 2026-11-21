namespace GameBuddy.Stardew;

/// <summary>One refusal code, the action that answers with it, and the ONE fact it names.</summary>
/// <param name="DecidedBy">
/// For a code this action hands to a helper as a VALUE rather than minting at a receipt call: the member whose body
/// decides it. The gate holds such a row only when the action reaches that member and the member names the code.
/// </param>
internal readonly record struct RefusalFactDeclaration(
    string ActionId,
    string Code,
    string Fact,
    RefusalDecision? DecidedBy = null);

/// <summary>Where one forwarded refusal code is decided: the shipped file, and the member whose body answers it.</summary>
internal readonly record struct RefusalDecision(string Path, string Member);

/// <summary>
/// Where one of these actions mints its refusals: the file, and the method whose body is that action's own.
///
/// <para>
/// The scan reads the BODY and not the file. Four of these actions share a file with siblings
/// (<c>face_direction</c>, <c>minecart</c>, <c>level_up</code>, <c>chest_retrieve</code>), so a file-wide scan would report
/// their codes as this action's - and a population that names the wrong members is the defect this whole table exists
/// against.
/// </para>
/// </summary>
internal readonly record struct RefusalScanTarget(string ActionId, string Path, string MethodSignature);

/// <summary>
/// The refusal vocabulary of five actions, and the one fact each code names - declared once, next to the codes
/// themselves.
///
/// <para>
/// THE RULE. A refusal must name the fact that refused it, and two different facts must not share one code.
/// `round84` answered three `move_to_tile` requests with one `target_not_addressable`, one warp with a
/// `navigation_warp_postcondition_mismatch` that named no side, a chest store with a code about a SLOT the request
/// never named, and `answer_dialogue` with `no_modal_present` while a `ShippingMenu` was on screen. Three
/// occurrences of one code is why nobody can fix them: the receipt cannot tell which fact it meant.
/// </para>
/// <para>
/// THE GATE that holds this table is <c>RefusalNamesItsFactTests</c>: it reads the bodies listed in
/// <see cref="ScanTargets"/>, derives the codes minted there, and fails naming any code that has no row here, any row
/// whose code is not in the source it claims, and any code with two facts. The population is the SOURCE, so a new
/// refusal joins it by existing; this table cannot go stale in silence.
/// </para>
/// <para>
/// `Forwarded` rows are codes the scanned bodies hand to a helper that decides them elsewhere
/// (`TileTargetGate`, `ResolveStorageContainerById`, `ShopPurchaseOutcomeFor`). They are declared so a reader sees
/// the whole vocabulary an action can answer with, and the gate reports them apart from the codes it read directly.
/// Each one names the member that decides it, and the gate holds the row only when the action reaches that member and
/// the member's own body names the code - a forwarded row is a checked claim, not a licence to declare anything.
/// </para>
/// </summary>
internal static class RefusalFacts
{
    internal const string MoveToTile = "move_to_tile";
    internal const string NavigateToDestination = "navigate_to_destination";
    internal const string ChestStore = "chest_store";
    internal const string AnswerDialogue = "answer_dialogue";
    internal const string ShopPurchase = "shop_purchase";

    /// <summary>
    /// Every fact a refusal of these five actions can name, one row per code. A row whose code is spelled
    /// `family:<parameter>` is the family head the wire carries before its parameter.
    /// </summary>
    internal static IReadOnlyList<RefusalFactDeclaration> Declared { get; } = Array.AsReadOnly(new[]
    {
        // ---- move_to_tile ------------------------------------------------------------------------------------
        Row(MoveToTile, "world_not_ready", "no world is loaded, or the actor has no current location, so there is nothing to act in"),
        Row(MoveToTile, "invalid_target_tile", "the coordinates are not a finite whole-number tile"),
        Row(MoveToTile, "deadline_expired", "the deadline had already passed when the request arrived"),
        Row(MoveToTile, "invalid_deadline", "the deadline was further ahead than this action accepts"),
        Row(MoveToTile, "body_release_unavailable", "the body was still held after the previous execution was cancelled"),
        Row(MoveToTile, "location_unavailable", "the actor's current location could not be read"),
        Row(MoveToTile, "native_controller_owned", "the actor's own movement is driven by a native path controller"),
        Row(MoveToTile, "target_off_map", "the coordinate is not a tile of the map the actor is standing on"),
        Row(MoveToTile, "target_not_addressable", "the cell exists and neither it nor its four neighbours admits a body"),
        Row(MoveToTile, "target_is_on_another_map", "the coordinate names another map's door back into this one"),
        Row(MoveToTile, "target_tile_occupied", "a body stands on the tile and no neighbouring tile is free"),
        Row(MoveToTile, "no_native_path", "no walkable route from here to the target's neighbourhood exists"),
        Row(MoveToTile, "path_blocked_by_character", "a character stands in the middle of the walk"),
        Row(MoveToTile, "native_path_ended", "the native path ended before the actor arrived"),
        Row(MoveToTile, "target_out_of_reach", "the walk stopped beside the target, outside the native interaction radius"),
        Row(MoveToTile, "clear_step_blocked", "the first clearing step this walk needs is itself blocked"),
        Row(MoveToTile, "approach_out_of_reach", "the substituted standing tile is outside the native radius of the requested one"),
        Row(MoveToTile, "player_not_actionable", "the engine's own CanMove flag went false mid-walk, and the evidence names who holds her and what ends it"),
        Forwarded(MoveToTile, "body_owned", "another execution owns the body when the request arrives", "ExecutionAdmission.cs", "Describe"),

        // ---- navigate_to_destination --------------------------------------------------------------------------
        Row(NavigateToDestination, "navigation_warp_not_local_player", "the arrival event was not this actor's warp"),
        Row(NavigateToDestination, "navigation_warp_arrived_on_another_map", "the arrival map is not the leg's target map"),
        Row(NavigateToDestination, "navigation_warp_source_mismatch", "the warp came from a map other than the leg's source"),
        Row(NavigateToDestination, "navigation_deadline_expired_after_warp", "the deadline passed after the warp, so the arrival cannot be judged"),
        Row(NavigateToDestination, "destination_access_indeterminate", "the destination runtime or its transition decision could not be read this frame"),
        Row(NavigateToDestination, "destination_closed_hours", "the destination is shut at this hour, per the world's own schedule"),
        Row(NavigateToDestination, "destination_selector_invalid", "the selector names no destination this generation publishes: a label no row declares, a blank spelling, or a handle that is not a `dr1_` one"),
        Forwarded(NavigateToDestination, "destination_selector_ambiguous", "more than one destination declares the requested spelling, so no single one was bound", "integrations/stardew/navigation/acceptednavigationexecution.cs", "Resolve"),
        Forwarded(NavigateToDestination, "destination_selector_stale", "the ref handle is no longer usable, and the store names which condition refused it: its own five-minute lifetime passed, or the runtime, scope or destination generation it was issued under is not the current one", "integrations/stardew/navigation/acceptednavigationexecution.cs", "MapRefFailure"),
        Row(NavigateToDestination, "navigation_approach_unavailable", "no standable tile beside the first leg's transition entry exists"),
        Row(NavigateToDestination, "navigation_multi_hop_arm_failed", "the next leg of the route could not be armed, so the route stops here"),
        Row(NavigateToDestination, "approach_unavailable", "the approach arm to the first leg failed and named no code of its own"),
        Forwarded(NavigateToDestination, "body_owned", "another execution owns the body when the request arrives", "ExecutionAdmission.cs", "Describe"),

        // ---- chest_store --------------------------------------------------------------------------------------
        Row(ChestStore, "item_not_owned", "the pack holds no stack of the item id the request named"),
        Row(ChestStore, "item_slot_changed", "the pack holds the item, at a different slot than the spelling the request used"),
        Row(ChestStore, "chest_full", "the chest did not take the whole stack"),
        Forwarded(ChestStore, "chest_target_changed", "no live container answers the id the request named", "farmhandexecutioncontroller.containeractions.cs", "ResolveStorageContainerById"),
        Forwarded(ChestStore, "container_not_storage", "the container is there and its contents are not this room's storage", "farmhandexecutioncontroller.containeractions.cs", "ResolveStorageContainerById"),
        Row(ChestStore, "container_in_use", "another player holds the container's own lock"),
        Row(ChestStore, "container_lock_not_granted", "the container's lock was asked for and not granted in this tick"),
        Row(ChestStore, "hollow_ring_no_step_out", "the target is the tile the actor stands on, and no step out of it exists"),
        Forwarded(ChestStore, "no_reachable_approach", "no standing tile beside the target is reachable", "farmhandexecutioncontroller.movementactions.cs", "DescribeNoReachableApproach"),
        Forwarded(ChestStore, "no_cuttable_blocker", "the blocker in the way is one no published action clears", "farmhandexecutioncontroller.movementactions.cs", "DescribeFrontierClearance"),
        Forwarded(ChestStore, "body_owned", "another execution owns the body when the request arrives", "ExecutionAdmission.cs", "Describe"),

        // ---- answer_dialogue ----------------------------------------------------------------------------------
        Row(AnswerDialogue, "no_modal_present", "nothing is mounted: `activeClickableMenu` is null"),
        Row(AnswerDialogue, "modal_not_answerable", "a modal is mounted and offers no response this action can give"),
        Row(AnswerDialogue, "event_has_no_dialogue_box", "a scene is running and holds no dialogue box this action could answer"),
        Row(AnswerDialogue, "invalid_response_key", "the response key is blank or longer than the accepted bound"),
        Row(AnswerDialogue, "response_key_not_offered", "the key is not one of the responses the open box offers"),
        Row(AnswerDialogue, "world_not_ready", "no world is loaded, or the actor has no current location, so there is nothing to act in"),
        Row(AnswerDialogue, "native_sleep_prompt_owned_by_sleep", "the prompt is the bed question, whose day crossing belongs to `sleep`"),
        Row(AnswerDialogue, "answer_dialogue_not_accepted", "the native answer leaf returned without settling the question"),
        Row(AnswerDialogue, "answer_dialogue_native_exception", "the native answer call threw"),
        Forwarded(AnswerDialogue, "body_owned", "another execution owns the body when the request arrives", "ExecutionAdmission.cs", "Describe"),

        // ---- shop_purchase ------------------------------------------------------------------------------------
        Row(ShopPurchase, "world_not_ready", "no world is loaded, or the actor has no current location, so there is nothing to act in"),
        Row(ShopPurchase, "missing_expected_item", "the request named no item id"),
        Row(ShopPurchase, "missing_expected_target_id", "the request named no counter"),
        Row(ShopPurchase, "invalid_quantity", "the requested quantity is not a positive integer"),
        Row(ShopPurchase, "modal_open", "a menu was already open, so the shop's own menu could not be read"),
        Row(ShopPurchase, "shop_target_unavailable", "no counter in this room answers the id the request named"),
        Row(ShopPurchase, "shop_target_is_a_shop_id_not_a_counter", "the id names a shop and not one of its counters"),
        Row(ShopPurchase, "shop_counter_out_of_reach", "the counter tile is outside the native click radius, or no eligible owner can run it here"),
        Row(ShopPurchase, "shop_closed_today", "the owner entry that would run the counter carries a closed message"),
        Row(ShopPurchase, "shop_tile_gate_refused", "the tile's own native gate refuses today"),
        Row(ShopPurchase, "shop_tile_requires_dialogue", "the tile opens a question dialogue instead of a shop"),
        Row(ShopPurchase, "shop_stock_unreadable", "the shop's stock rows could not be read"),
        Row(ShopPurchase, "item_not_sold_here", "no counter in this room carries the item"),
        Row(ShopPurchase, "item_sold_by_another_counter", "this counter's rows do not carry it, and another counter here does"),
        Row(ShopPurchase, "shop_item_absent_from_sale", "the opened menu's own forSale list does not hold the item"),
        Row(ShopPurchase, "shop_item_beyond_last_page", "the engine's own pager could not bring the sale's row on screen"),
        Row(ShopPurchase, "insufficient_money", "the purse cannot pay the unit price for one"),
        Row(ShopPurchase, "out_of_stock", "the stock row's own count is zero"),
        Row(ShopPurchase, "inventory_cannot_accept", "the pack cannot hold the goods the entry would deliver"),
        Row(ShopPurchase, "shop_purchase_refused", "the engine's own purchase path refused, in its own words"),
        Row(ShopPurchase, "shop_menu_unavailable", "the opened menu is not a ShopMenu"),
        Row(ShopPurchase, "shop_purchase_native_exception", "the native purchase call threw"),
        Forwarded(ShopPurchase, "purchase_partial", "the trade moved only one side of the exchange", "farmhandexecutioncontroller.shopactions.cs", "ShopPurchaseOutcomeFor"),
        Forwarded(ShopPurchase, "body_owned", "another execution owns the body when the request arrives", "ExecutionAdmission.cs", "Describe"),
    });

    /// <summary>
    /// Bodies the handler closure cannot reach but the action still answers with: the navigation warp postcondition is
    /// an EVENT entry (<c>CompleteNavigationAfterWarp</c>), not a call the request path makes, so nothing in the closure
    /// walks to it.
    /// </summary>
    internal static IReadOnlyList<RefusalScanTarget> ExtraBodies { get; } = Array.AsReadOnly(new[]
    {
        new RefusalScanTarget(NavigateToDestination, "farmhandexecutioncontroller.cs", "internal void CompleteNavigationAfterWarp(bool isLocalPlayer, string? oldLocation"),
    });

    private static RefusalFactDeclaration Row(string actionId, string code, string fact) => new(actionId, code, fact);

    private static RefusalFactDeclaration Forwarded(
        string actionId,
        string code,
        string fact,
        string path,
        string member) => new(actionId, code, fact, new RefusalDecision(path, member));
}
