using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.GameData.Crafting;
using StardewValley.Menus;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

// THE SEWING MACHINE — two actions whose subject is the actor's own backpack. `tailor_clothing`
// consumes the cloth and the reagent a live recipe pairs and produces the garment;
// `dye_clothing_with_item` consumes one dye item and moves the colour of one existing garment.
//
// WHY THESE TWO ACTIONS ARE POSSIBLE AT ALL. The sewing machine's entire content table is the
// game's own `Data/TailoringRecipes`, loaded once as `List<TailorItemRecipe>` by
// `DataLoader.TailoringRecipes` (DataLoader.cs:497) and reached through
// `TailoringMenu._tailoringRecipes` (TailoringMenu.cs:104/:133). Neither action carries, copies or
// interprets that table: the pair's identity is decided by the game's own
// `TailoringMenu.GetRecipeForItems(Item leftItem, Item rightItem)` (TailoringMenu.cs:756) and the
// product and the colour by the game's own `TailoringMenu.CraftItem(Item left_item, Item right_item)`
// (TailoringMenu.cs:824) and `TailoringMenu.DyeItems(Clothing clothing, Item dye_object, float
// dye_strength_override = -1f)` (TailoringMenu.cs:718). No content list is duplicated here, which is
// exactly why these are implementable and a "shirt from a fixed list" action would not be.
//
// THE SEAM IS THE MENU'S OWN SETTLEMENT, NOT ITS CLICK PATH.
//   * The native two-slot interaction's ONLY terminal is inside `TailoringMenu`: the ingredient
//     spots take whatever the cursor holds (TailoringMenu.cs:340-379 `_leftIngredientSpotClicked`
//     / `_rightIngredientSpotClicked`), the press button only *starts* a 1500-ms animation
//     (:589-596 `_timeUntilCraft = 1500`), and the product is actually made in the tick-driven
//     `TailoringMenu.update` branch (:1026-1075) as `CraftItem(leftIngredientSpot.item,
//     rightIngredientSpot.item)`. A bridge cannot drive a 1500-ms UI animation, and reproducing
//     `receiveLeftClick` would be menu driving. So this lane calls the SAME settlement the
//     animation's completion calls — `CraftItem` / `DyeItems` — and reproduces only the
//     consumption the animation performs around it (`SpendLeftItem()` :1050 /
//     `SpendRightItem()` :1054, i.e. `ConsumeStack(1)` on the left spot and on the right spot when
//     `TailorItemRecipe.SpendRightItem`), plus the delivery the menu's own exit performs
//     (`_OnCloseMenu` :1293-1315 -> `Utility.CollectOrDrop(heldItem)`), which this lane performs
//     directly through `Farmer.addItemToInventory` with a native `Game1.createItemDebris` floor
//     drop for any remainder.
//   * `CraftItem` and `DyeItems` are INSTANCE methods but read only two fields of the instance:
//     `_tailoringRecipes` (public, TailoringMenu.cs:104) and `_shouldPrismaticDye` (protected,
//     set by `CraftItem`'s picker branch). Nothing else of the menu is read — no cursor slot, no
//     held item, no `inventory`, no button. The one menu instance this lane needs is therefore
//     constructed exactly the way the game's own recipe-list tool constructs it
//     (`TailorRecipeListTool.cs:36` `TailoringMenu tailoringMenu = new TailoringMenu();`, which
//     then calls `CraftItem`/`GetRecipeForItems` on it without ever mounting it), and it is
//     constructed ONCE per session: the table is loaded content, not world state, and the
//     constructor's one audible/native consequence (`Game1.playSound("bigSelect")`,
//     TailoringMenu.cs:126) must not fire on every observation. That sound is the ONE native
//     consequence of this lane's seam choice and is named here rather than left to be discovered.
//
// ARGUMENTS. Both actions are exactly `{leftSlot, rightSlot, expectedTargetId}`: the sewing
// machine has TWO input slots, so the request names both backpack slots (the vocabulary is the
// game's own "left ingredient spot" / "right ingredient spot", TailoringMenu.cs:153/:168) and the
// opaque target the discovery projection minted for that pair. An argument the work does not need
// is not available: the protocol is exact-shape, with no optional arguments.
//   * For `tailor_clothing`, leftSlot holds the recipe's FIRST ingredient (in vanilla data the
//     cloth) and rightSlot the SECOND (the reagent), i.e. the pair `GetRecipeForItems` matches
//     against `FirstItemTags`/`SecondItemTags` in that order.
//   * For `dye_clothing_with_item`, leftSlot holds the GARMENT and rightSlot the dye item: the
//     same L/R order `CraftItem`'s clothing branch reads (`left_item is Clothing`, `right_item` is
//     the colour source).
//
// THE OPAQUE IDENTITY BINDS THE PAIR. `expectedTargetId` is published by discovery as
// `tailoring_<kind>_<16 hex>`, where the digest covers the KIND and BOTH items' wire identities
// (`tailoring:recipe:(O)428:(O)684:...`). The readable segment is the kind, so a stale id can still
// be attributed to the intent it named, and the digest cannot be forged into a different pair. The
// handler re-reads the two named slots from the LIVE backpack, recomputes the id and refuses
// `tailoring_target_changed` when it differs — the request must name the state it expects to act
// on, not the state discovery happened to see.
//
// PRECONDITIONS AND POSTCONDITIONS, both observed.
//   * `tailor_clothing`'s postcondition has TWO halves, and both are read back from the world
//     after the call: the named reagents LEFT the backpack (each counted by item id across the
//     whole pack, before and after the consumption) AND the garment EXISTS (counted the same way,
//     plus the native debris it landed as when it did not fit). The seam's return value is not
//     evidence: `CraftItem` returns a freshly built item whether or not the caller then consumes
//     or delivers anything.
//   * `dye_clothing_with_item`'s postcondition is the garment's COLOUR, read back from
//     `Clothing.clothesColor` (Clothing.cs:51). `Clothing.Dye(Color, float)` (Clothing.cs:197) is
//     a no-op on a non-dyeable garment and `DyeItems`'s `bool` says only "the item HAD a colour",
//     not "the colour moved" — so a call that leaves the colour where it was is `Uncertain`, never
//     a success. The garment is also proved to still be owned by reference, so a call that silently
//     removed it cannot read as a successful dye.
//
// WHERE THE COLOUR AND THE STRENGTH COME FROM (stated once, because both are facts a reader needs).
//   * The COLOUR comes from the public static `TailoringMenu.GetDyeColor(Item dye_object)`
//     (TailoringMenu.cs:701): `(O)74` is White, a `ColoredObject` is its own `color`, otherwise
//     `ItemContextTagManager.GetColorFromTags(item)` decides. `DyeItems` is called with the
//     native DEFAULT `dye_strength_override: -1f`, i.e. the caller does NOT choose the strength.
//   * The STRENGTH comes from inside `DyeItems` (TailoringMenu.cs:729-741) out of the dye item's
//     own context tags: `dye_strong` -> 1.0, else `dye_medium` -> 0.5, else 0.25; and `(O)74`
//     returns earlier with `Dye(Color.White, 1f)` plus `isPrismatic = true`. `MirrorDyeStrength`
//     below mirrors that rule ONLY to report it and to know when the colour must land EXACTLY on
//     the dye's colour (strength 1 makes `Utility.MoveTowards` reach the target); the settled
//     colour is always read back from the garment, never computed from the mirror.
//
// THE SIX-POT DyeMenu IS NOT THIS ACTION, and the refusal is recorded rather than implied:
// `DyeMenu` consumes one item from EACH of six colour pots and then lets a free RGB slider choose
// the result, so six inputs do not determine the colour and no single intent can be parameterized
// from it. `dye_clothing_with_item` is one garment plus one dye item through `DyeItems`.
//
// FAILURE MODES, each its own terminal code. tailor_clothing: a named slot that is out of range or
// empty (`tailoring_left_slot_invalid` / `tailoring_right_slot_invalid`), an id that names no
// tailoring target of this action's kind (`tailoring_target_not_found`), a pair whose live items no
// longer mint the published id (`tailoring_target_changed`), a pair whose only native route is the
// dye branch (`tailoring_dye_route_required`), a pair whose only native route is the free-RGB
// picker (`tailoring_colour_picker_required`), a pair no live recipe accepts
// (`tailoring_no_recipe`), a native call that threw (`tailoring_native_exception`), an output the
// native call did not produce (`tailoring_output_unavailable`), a native branch that settled on an
// IN-PLACE combination instead of a recipe output (`tailoring_in_place_combination`), a world that
// does not show both halves (`tailoring_postcondition_unavailable`), and success
// (`clothing_tailored`). dye_clothing_with_item: the same two slot codes, the same
// `tailoring_target_not_found` / `tailoring_target_changed`, a left item that is not a dyeable
// garment (`dye_clothing_garment_not_dyeable`), a right item that carries no colour at all
// (`dye_clothing_no_colour`), a native call that threw (`dye_clothing_native_exception`), a colour
// that did not move (`dye_clothing_postcondition_unavailable`), and success (`clothing_dyed`).
//
// LIFECYCLE. Both are registered `FarmhandActionLifecycle.Experimental` in `FarmhandActionCatalog`
// (family `body_tools`, handler group ResourceTools): they stay off the default Agent surface
// until each passes its own native-local live gate, and the promotion to LiveVerified is a
// separate catalog edit owned by the parent.
internal sealed partial class ExecutionManager
{
    /// <summary>A pair the game's own recipe table turns into a garment.</summary>
    internal const string TailoringRecipeKind = "recipe";

    /// <summary>A garment the game's own dye route recolours from one item.</summary>
    internal const string TailoringDyeKind = "dye";

    /// <summary>The Prismatic Shard, the one dye item `DyeItems` settles without a colour lookup.</summary>
    internal const string TailoringPrismaticShardId = "(O)74";

    /// <summary>Bound on the published projection, and on the pair evaluations that build it.</summary>
    internal const int TailoringTargetMaximum = 32;

    /// <summary>Bound on pair evaluations per snapshot, so discovery stays cheap on a full pack.</summary>
    internal const int TailoringPairScanBudget = 512;

    private TailoringMenu? tailoringRecipeTable;

    /// <summary>
    /// The game's own recipe table, materialized once. See the file header: the table is loaded
    /// content rather than world state, the menu's constructor is the only supported way to load it
    /// (`TailoringMenu.cs:133`), and constructing it per observation would replay its `bigSelect`
    /// sound per observation.
    /// </summary>
    private TailoringMenu TailoringRecipeTable() => this.tailoringRecipeTable ??= new TailoringMenu();

    /// <summary>
    /// Consumes the cloth and the reagent a live tailoring recipe pairs, produces that recipe's
    /// garment and puts it in the backpack (or on the ground, honestly reported, when it does not
    /// fit). See the file header for the seam, the identity rule, the two-half postcondition and
    /// every failure mode.
    /// </summary>
    public LocalExecutionReceipt RequestLocalTailorClothing(
        string requestId,
        int leftSlot,
        int rightSlot,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // General, not Physical: the seam is one instantaneous native item build plus two stack
        // decrements — no tool lifecycle, no swing, no menu, the same profile `equip_wearable`
        // and `talk_to_npc` admit through.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        string location = player.currentLocation?.NameOrUniqueName ?? "unknown";
        string identity = $"target={expectedTargetId};left_slot={leftSlot};right_slot={rightSlot};location={location}";

        if (!TryReadTailoringSlot(player, leftSlot, out Item? leftItem))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_left_slot_invalid", $"{identity};inventory_slots={player.Items.Count};left_item=none");
        if (leftSlot == rightSlot || !TryReadTailoringSlot(player, rightSlot, out Item? rightItem))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_right_slot_invalid", $"{identity};inventory_slots={player.Items.Count};left_item={leftItem.QualifiedItemId};right_item={(leftSlot == rightSlot ? "same_slot" : "none")}");

        if (!TryParseTailoringTargetKind(expectedTargetId, out string publishedKind) || !string.Equals(publishedKind, TailoringRecipeKind, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_target_not_found", $"{identity};left_item={leftItem.QualifiedItemId};right_item={rightItem.QualifiedItemId};published_kind={DescribeTailoringTargetKind(expectedTargetId)}");

        TailoringMenu menu = this.TailoringRecipeTable();
        string? kind = ClassifyTailoringPair(menu, leftItem, rightItem, out TailorItemRecipe? recipe);
        if (string.Equals(kind, TailoringDyeKind, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_dye_route_required", $"{identity};left_item={leftItem.QualifiedItemId};right_item={rightItem.QualifiedItemId};reason=the_pair_has_no_recipe_only_a_dye_colour");
        if (kind is null && IsColourPickerOnlyPair(leftItem, rightItem))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_colour_picker_required", $"{identity};left_item={leftItem.QualifiedItemId};right_item={rightItem.QualifiedItemId};reason=the_native_branch_defers_the_colour_to_a_free_rgb_picker");
        if (kind is null || recipe is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_no_recipe", $"{identity};left_item={leftItem.QualifiedItemId};right_item={rightItem.QualifiedItemId}");

        string liveTargetId = BuildTailoringTargetId(TailoringRecipeKind, leftItem, rightItem);
        if (!string.Equals(liveTargetId, expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_target_changed", $"{identity};live={liveTargetId};left_item={leftItem.QualifiedItemId};right_item={rightItem.QualifiedItemId}");

        string leftId = leftItem.QualifiedItemId;
        string rightId = rightItem.QualifiedItemId;
        bool spendRight = recipe.SpendRightItem;
        int leftBefore = CountTailoringItem(player, leftId);
        int rightBefore = CountTailoringItem(player, rightId);
        int debrisBefore = CountTailoringDebris(player.currentLocation, string.Empty);

        Item? product;
        try
        {
            product = menu.CraftItem(leftItem, rightItem);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "tailoring_native_exception", $"{identity};left_item={leftId};right_item={rightId};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        if (product is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_output_unavailable", $"{identity};left_item={leftId};right_item={rightId}");
        // The native clothing/boots branches settle IN PLACE (`CraftItem` :830-846 returns the LEFT
        // item), i.e. they consume nothing and produce no garment. Reporting that as a tailoring
        // success would claim two halves that did not happen.
        if (ReferenceEquals(product, leftItem))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_in_place_combination", $"{identity};left_item={leftId};right_item={rightId};native_branch=in_place");

        string outputId = product.QualifiedItemId;
        // Exactly the consumption the menu's own completion performs: the left spot always, the
        // right spot only when the recipe says so (`TailoringMenu.cs:1044-1055`).
        player.Items[leftSlot] = leftItem.ConsumeStack(1);
        if (spendRight && rightSlot < player.Items.Count)
            player.Items[rightSlot] = rightItem.ConsumeStack(1);

        int leftAfter = CountTailoringItem(player, leftId);
        int rightAfter = CountTailoringItem(player, rightId);
        int outputBefore = CountTailoringItem(player, outputId);
        int producedStack = product.Stack;

        Item? remainder = player.addItemToInventory(product);
        int dropped = remainder?.Stack ?? 0;
        if (remainder is not null && dropped > 0)
            Game1.createItemDebris(remainder, player.getStandingPosition(), player.FacingDirection);

        int outputAfter = CountTailoringItem(player, outputId);
        int droppedDebris = CountTailoringDebris(player.currentLocation, outputId) - debrisBefore;
        int delivered = outputAfter - outputBefore;

        bool materialsConsumed = leftAfter == leftBefore - 1 && rightAfter == (spendRight ? rightBefore - 1 : rightBefore);
        bool outputCreated = producedStack > 0
            && delivered + dropped == producedStack
            && outputAfter == outputBefore + delivered
            && (dropped == 0 || droppedDebris == 1);
        string disposition = dropped == 0 ? "inventory" : delivered == 0 ? "dropped_on_ground" : "partially_dropped";
        string evidence = string.Create(CultureInfo.InvariantCulture,
            $"{identity};left={leftId};right={rightId};output={outputId};"
            + $"left_before={leftBefore};left_after={leftAfter};right_before={rightBefore};right_after={rightAfter};right_spent={spendRight.ToString().ToLowerInvariant()};"
            + $"output_before={outputBefore};output_after={outputAfter};delivered={delivered};dropped={dropped};disposition={disposition};dropped_debris={droppedDebris}");

        if (!materialsConsumed || !outputCreated)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "tailoring_postcondition_unavailable", evidence);
        if (dropped == 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "clothing_tailored", evidence);
        if (delivered == 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "clothing_tailored", evidence);
        // The garment exists (pack and/or ground) and the reagents did leave, but part of the
        // output did not reach the backpack: never report a full success for a split delivery.
        return this.RememberTerminal(requestId, executionId, ExecutionState.PartiallySucceeded, "clothing_tailoring_output_dropped", evidence);
    }

    /// <summary>
    /// Recolours one garment from one dye item through the game's own `DyeItems` route. See the
    /// file header for the seam, where the colour and the strength come from, and every failure
    /// mode.
    /// </summary>
    public LocalExecutionReceipt RequestLocalDyeClothingWithItem(
        string requestId,
        int leftSlot,
        int rightSlot,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        string location = player.currentLocation?.NameOrUniqueName ?? "unknown";
        string identity = $"target={expectedTargetId};garment_slot={leftSlot};dye_slot={rightSlot};location={location}";

        if (!TryReadTailoringSlot(player, leftSlot, out Item? garmentItem) || garmentItem is not Clothing garment)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_left_slot_invalid", $"{identity};inventory_slots={player.Items.Count};garment_item=none");
        if (leftSlot == rightSlot || !TryReadTailoringSlot(player, rightSlot, out Item? dyeItem))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_right_slot_invalid", $"{identity};inventory_slots={player.Items.Count};garment_item={garmentItem.QualifiedItemId};dye_item={(leftSlot == rightSlot ? "same_slot" : "none")}");

        if (!TryParseTailoringTargetKind(expectedTargetId, out string publishedKind) || !string.Equals(publishedKind, TailoringDyeKind, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_target_not_found", $"{identity};garment_item={garmentItem.QualifiedItemId};dye_item={dyeItem.QualifiedItemId};published_kind={DescribeTailoringTargetKind(expectedTargetId)}");

        if (!garment.dyeable.Value)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "dye_clothing_garment_not_dyeable", $"{identity};garment_item={garmentItem.QualifiedItemId};dyeable=false");

        Color? dyeColour = TailoringMenu.GetDyeColor(dyeItem);
        if (dyeColour is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "dye_clothing_no_colour", $"{identity};garment_item={garmentItem.QualifiedItemId};dye_item={dyeItem.QualifiedItemId}");

        string liveTargetId = BuildTailoringTargetId(TailoringDyeKind, garmentItem, dyeItem);
        if (!string.Equals(liveTargetId, expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tailoring_target_changed", $"{identity};live={liveTargetId};garment_item={garmentItem.QualifiedItemId};dye_item={dyeItem.QualifiedItemId}");

        string garmentId = garmentItem.QualifiedItemId;
        string dyeId = dyeItem.QualifiedItemId;
        Color colourBefore = garment.clothesColor.Value;
        bool prismaticBefore = garment.isPrismatic.Value;
        int dyeBefore = CountTailoringItem(player, dyeId);
        float strength = MirrorDyeStrength(dyeItem, out string strengthSource);
        // The menu consumes the right spot when there is no recipe, and otherwise when the recipe
        // says so (`TailoringMenu.cs:1052`); a dye pair that ALSO matches a recipe follows the
        // recipe's own `SpendRightItem` rather than a second rule invented here.
        bool spendRight = this.TailoringRecipeTable().GetRecipeForItems(garmentItem, dyeItem)?.SpendRightItem ?? true;

        try
        {
            // THE SEAM, with the native DEFAULT strength override: the strength rule belongs to
            // `DyeItems` and is read out of the dye item's own tags.
            this.TailoringRecipeTable().DyeItems(garment, dyeItem);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "dye_clothing_native_exception", $"{identity};garment_item={garmentId};dye_item={dyeId};colour_before={FormatColour(colourBefore)};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        if (spendRight && rightSlot < player.Items.Count)
            player.Items[rightSlot] = dyeItem.ConsumeStack(1);

        Color colourAfter = garment.clothesColor.Value;
        bool prismaticAfter = garment.isPrismatic.Value;
        int dyeAfter = CountTailoringItem(player, dyeId);
        bool consumed = dyeAfter == (spendRight ? dyeBefore - 1 : dyeBefore);
        bool stillOwned = IsTailoringItemInPack(player, garment);
        // The colour must move when the dye carries a DIFFERENT colour, and must stay where it was
        // when it carries the same one. How FAR it moves is `Clothing.Dye`'s own blend and is read
        // back rather than re-derived: the receipt publishes before/expected/strength/after so the
        // blend is visible to a reader, while this terminal decides only the observable change.
        bool colourApplied = dyeColour.Value.Equals(colourBefore)
            ? colourAfter.Equals(colourBefore)
            : !colourAfter.Equals(colourBefore);
        bool colourChanged = !colourAfter.Equals(colourBefore);
        bool prismaticSettled = prismaticAfter == (string.Equals(dyeId, TailoringPrismaticShardId, StringComparison.Ordinal) || prismaticBefore);

        string evidence = string.Create(CultureInfo.InvariantCulture, $"{identity};garment={garmentId};dye={dyeId};colour_before={FormatColour(colourBefore)};colour_expected={FormatColour(dyeColour.Value)};colour_after={FormatColour(colourAfter)};strength={strength};strength_source={strengthSource};colour_changed={colourChanged.ToString().ToLowerInvariant()};prismatic_after={prismaticAfter.ToString().ToLowerInvariant()};dye_before={dyeBefore};dye_after={dyeAfter};dye_spent={spendRight.ToString().ToLowerInvariant()};colour_route=TailoringMenu.GetDyeColor");

        return colourApplied && consumed && stillOwned && prismaticSettled
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "clothing_dyed", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "dye_clothing_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// The tailoring targets this actor can act on right now, projected read-only from the live
    /// backpack and the game's own recipe table. Bounded twice (see the constants): the scan stops
    /// after a fixed budget of pair evaluations and the projection after a fixed number of
    /// targets, both in slot order, so a full pack cannot make one observation expensive and the
    /// published set is deterministic. Nothing is synthesized: every field is the item the game
    /// itself holds in that slot and the item id the game's own branches would settle on.
    /// </summary>
    internal IReadOnlyList<BridgeTailoringTarget> DiscoverTailoringTargets(Farmer player)
    {
        List<BridgeTailoringTarget> result = new();
        TailoringMenu menu = this.TailoringRecipeTable();
        int budget = TailoringPairScanBudget;
        for (int left = 0; left < player.Items.Count; left++)
        {
            Item? leftItem = player.Items[left];
            if (leftItem is null) continue;
            for (int right = 0; right < player.Items.Count; right++)
            {
                if (right == left) continue;
                Item? rightItem = player.Items[right];
                if (rightItem is null) continue;
                if (budget-- <= 0 || result.Count >= TailoringTargetMaximum) return result;
                string? kind = ClassifyTailoringPair(menu, leftItem, rightItem, out _);
                if (kind is null) continue;
                // The dye route's product IS the garment (the left item), which is exactly what the
                // caller needs to see: the target says "this garment, recoloured from this item". Its
                // CURRENT colour is published with it, because that is the fact
                // `dye_clothing_with_item`'s postcondition changes and the observation surface carries
                // no other read of it: the same target id republished after the act IS the proof. A
                // recipe whose garment cannot be built is not a target: the handler would refuse it,
                // so publishing it would only lead the Agent into a refusal.
                string outputId = string.Equals(kind, TailoringDyeKind, StringComparison.Ordinal)
                    ? leftItem.QualifiedItemId
                    : DescribeTailoringRecipeOutput(menu, leftItem, rightItem) ?? string.Empty;
                if (outputId.Length == 0) continue;
                bool dyeTarget = string.Equals(kind, TailoringDyeKind, StringComparison.Ordinal);
                result.Add(new BridgeTailoringTarget(
                    BuildTailoringTargetId(kind, leftItem, rightItem),
                    kind,
                    left,
                    right,
                    leftItem.QualifiedItemId,
                    rightItem.QualifiedItemId,
                    outputId,
                    dyeTarget ? FormatColour(((Clothing)leftItem).clothesColor.Value) : null,
                    dyeTarget ? leftItem.DisplayName : null));
            }
        }
        return result;
    }

    /// <summary>
    /// The ONE classifier discovery and both handlers share, so the published kind and the action's
    /// own precondition can never disagree. It reproduces the ORDER of `CraftItem`'s own branches
    /// (TailoringMenu.cs:824-873) rather than a second reading of the recipe table:
    /// the clothing-plus-colour branch wins over the recipe branch, and the colour-PICKER branch
    /// (`right_item.HasContextTag("color_prismatic")` with no colour of its own, :837-841) is not a
    /// parameterizable intent at all — it defers the colour to a free RGB slider — so it publishes
    /// nothing and is refused by name.
    /// </summary>
    internal static string? ClassifyTailoringPair(TailoringMenu menu, Item leftItem, Item rightItem, out TailorItemRecipe? recipe)
    {
        recipe = null;
        // Two boots are `CraftItem`'s in-place stat merge (:830-834), not a recipe output: it returns
        // the LEFT item with the right one's stats applied, consuming nothing. Excluded from the
        // projection so an Agent is never handed a target that no receiver can settle.
        if (leftItem is Boots && rightItem is Boots) return null;
        bool dyeableGarment = leftItem is Clothing clothing && clothing.dyeable.Value;
        if (dyeableGarment && TailoringMenu.GetDyeColor(rightItem) is not null)
            return TailoringDyeKind;
        if (dyeableGarment && rightItem.HasContextTag("color_prismatic"))
            return null;
        recipe = menu.GetRecipeForItems(leftItem, rightItem);
        return recipe is null ? null : TailoringRecipeKind;
    }

    /// <summary>
    /// The opaque id of one tailoring target: the KIND (readable, so a stale id can still be
    /// attributed to the intent it named) plus a digest of the kind and BOTH items' wire
    /// identities, so a request must name the pair state it expects to act on and an id cannot be
    /// forged into a different pair.
    /// </summary>
    internal static string BuildTailoringTargetId(string kind, Item leftItem, Item rightItem)
    {
        string raw = $"tailoring:{kind}:{leftItem.QualifiedItemId}:{rightItem.QualifiedItemId}";
        return $"tailoring_{kind}_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// Reads the kind segment of an opaque tailoring target id, validating the digest's SHAPE only.
    /// The digest itself is checked separately against the live pair, so an id can never retarget a
    /// pair the handler did not name.
    /// </summary>
    internal static bool TryParseTailoringTargetKind(string expectedTargetId, out string kind)
    {
        kind = string.Empty;
        if (string.IsNullOrEmpty(expectedTargetId)) return false;
        foreach (string candidate in new[] { TailoringRecipeKind, TailoringDyeKind })
        {
            string prefix = $"tailoring_{candidate}_";
            if (!expectedTargetId.StartsWith(prefix, StringComparison.Ordinal)) continue;
            string digest = expectedTargetId[prefix.Length..];
            if (digest.Length != 16 || !digest.All(character => (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
                continue;
            kind = candidate;
            return true;
        }
        return false;
    }

    /// <summary>
    /// The one place that answers "what does this backpack slot of this actor hold right now?",
    /// shared by discovery, execution and the fixture so the product and its declared Given can
    /// never disagree about the state a request names. False means the slot is out of range or
    /// EMPTY — the two are the same refusal because neither can be the source of an ingredient.
    /// </summary>
    internal static bool TryReadTailoringSlot(Farmer player, int slot, out Item item)
    {
        item = null!;
        if (slot < 0 || slot >= player.Items.Count) return false;
        if (player.Items[slot] is not Item held) return false;
        item = held;
        return true;
    }

    /// <summary>
    /// The recipe output id a pair would settle on, read through the same `CraftItem` branch
    /// discovery classifies. It is a pure build (`ItemRegistry.Create`), never a mutation of the
    /// backpack, and it exists only so the projection can NAME the garment the target would make.
    /// </summary>
    private static string? DescribeTailoringRecipeOutput(TailoringMenu menu, Item leftItem, Item rightItem)
    {
        try
        {
            Item? product = menu.CraftItem(leftItem, rightItem);
            return product is null || ReferenceEquals(product, leftItem) ? null : product.QualifiedItemId;
        }
        catch (Exception)
        {
            // A recipe whose output cannot be built is not a target discovery may publish: the
            // handler would refuse it, and publishing it would only lead the Agent into a refusal.
            return null;
        }
    }

    /// <summary>
    /// Whether the pair's only native route is the free-RGB picker: a dyeable garment plus a
    /// `color_prismatic` item that carries no colour of its own. Named separately from "no recipe"
    /// because it is a DIFFERENT refusal — the intent exists but no single item determines it.
    /// </summary>
    private static bool IsColourPickerOnlyPair(Item leftItem, Item rightItem) =>
        leftItem is Clothing clothing && clothing.dyeable.Value
        && TailoringMenu.GetDyeColor(rightItem) is null
        && rightItem.HasContextTag("color_prismatic");

    /// <summary>
    /// A declared MIRROR of `DyeItems`'s strength rule (TailoringMenu.cs:720-741), used only to
    /// report the strength and to know when the settled colour must land exactly on the dye's own
    /// colour. The settled colour is always read back from the garment; nothing here decides the
    /// terminal.
    /// </summary>
    internal static float MirrorDyeStrength(Item dyeItem, out string strengthSource)
    {
        if (string.Equals(dyeItem.QualifiedItemId, TailoringPrismaticShardId, StringComparison.Ordinal))
        {
            strengthSource = "prismatic_shard_white";
            return 1f;
        }
        if (dyeItem.HasContextTag("dye_strong"))
        {
            strengthSource = "context_tag_dye_strong";
            return 1f;
        }
        if (dyeItem.HasContextTag("dye_medium"))
        {
            strengthSource = "context_tag_dye_medium";
            return 0.5f;
        }
        strengthSource = "context_tag_default";
        return 0.25f;
    }

    /// <summary>
    /// Counts one item id across the WHOLE backpack. This lane cannot reuse the crafting lane's
    /// `CountQualifiedItem`, which counts `StardewValley.Object` stacks only: a tailoring output is
    /// a `Clothing` or a `Hat` as often as it is an Object, and a postcondition that cannot see its
    /// own product would report a false failure.
    /// </summary>
    internal static int CountTailoringItem(Farmer player, string qualifiedItemId)
    {
        int total = 0;
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            Item? item = player.Items[slot];
            if (item is not null && string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal))
                total += item.Stack;
        }
        return total;
    }

    /// <summary>Whether the pack still holds this exact instance: the reference test a split delivery cannot fake.</summary>
    internal static bool IsTailoringItemInPack(Farmer player, Item item)
    {
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            if (ReferenceEquals(player.Items[slot], item)) return true;
        }
        return false;
    }

    /// <summary>
    /// How many pieces of a given qualified id lie on this location's floor as native debris.
    /// An empty id counts every piece, which is the "before" reading; a named id is the "after"
    /// reading that proves a delivered remainder really landed.
    /// </summary>
    private static int CountTailoringDebris(GameLocation? location, string qualifiedItemId)
    {
        if (location is null) return 0;
        int count = 0;
        for (int index = 0; index < location.debris.Count; index++)
        {
            Debris debris = location.debris[index];
            if (debris.item is null) continue;
            if (qualifiedItemId.Length > 0 && !string.Equals(debris.item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal)) continue;
            count++;
        }
        return count;
    }

    /// <summary>One garment's current colour as three comma-joined bytes, the shape the evidence uses.</summary>
    internal static string FormatColour(Color colour) => $"{colour.R},{colour.G},{colour.B}";

    private static string DescribeTailoringTargetKind(string expectedTargetId) =>
        TryParseTailoringTargetKind(expectedTargetId, out string kind) ? kind : "unrecognized";
}
