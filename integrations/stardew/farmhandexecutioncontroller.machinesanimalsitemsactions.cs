using System.Globalization;
using GameBuddy.Stardew.Core;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.GameData.Machines;
using StardewValley.Tools;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

// Native handler bodies remain action/family-owned. All parts share the one
// FarmhandExecutionController game-thread ledger, receipt store, snapshot, and cancel state.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalLoadMachineInput(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.Physical, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (ResolveLoadInput(slot, expectedQualifiedItemId) is not StardewValley.Object input)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_load_input_not_in_slot", $"slot={slot};expected={expectedQualifiedItemId}");
        if (MachineLoadRefusal(targetX, targetY, expectedTargetId, input) is { } machineRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, machineRefusal.ReasonCode, machineRefusal.Detail);

        // 5.2: out of the native radius, walk in rather than refuse. The input stack and the
        // machine are validated above; both are re-checked after the walk inside the closure,
        // because `location.checkAction` is a real player input path whose outcome depends on
        // the world at the moment it runs.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "machine_load",
                Game1.player.currentLocation,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteLoadMachineInput(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteLoadMachineInput(executionId, requestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId);
    }

    /// <summary>What the machine's OWN data declares for one input: how many items it consumes, and the processing
    /// window when the rows state one. Discovery and the load postcondition read this one derivation, so the stack the
    /// snapshot publishes and the stack the action consumes cannot disagree.</summary>
    private readonly record struct MachineLoadRequirement(int ConsumedCount, int? ProcessingMinutes);

    /// <summary>
    /// Why this machine cannot take this item as a load right now, or null when it can.
    ///
    /// <para>
    /// THE ADMISSION IS THE MACHINE'S OWN. <c>Object.performObjectDropInAction(probe: true)</c> is the exact call
    /// <c>GameLocation.checkAction</c> makes before it performs a drop-in (GameLocation.cs:7768-7772), so it walks the
    /// machine's live <c>Data/Machines</c> rules through <c>MachineDataUtility.CanApplyOutput</c>
    /// (MachineDataUtility.cs:65-102) instead of a copy of those rules kept in this source. <c>probe: true</c> returns
    /// before <c>OutputMachine</c> (Object.cs:2472-2475), so nothing is consumed and no output is rolled.
    /// </para>
    /// <para>
    /// What this method decides is only what the machine's data cannot: whether the object on the tile is a machine this
    /// interaction path reaches at all, whether it is idle, and whether it names the tile the caller addressed. A refusal
    /// for the INPUT comes from the probe, and it names the inputs the machine's data does accept.
    /// </para>
    /// </summary>
    private static (string ReasonCode, string Detail)? MachineLoadRefusal(int targetX, int targetY, string expectedTargetId, StardewValley.Object input)
    {
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? machine)
            || !string.Equals(BuildMachineTargetId(location, targetX, targetY, machine.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return ("machine_load_target_changed", $"target={targetX},{targetY}");
        if (machine.GetMachineData() is null || !IsMachineInteractionObject(machine))
            return ("machine_load_unsupported_machine", $"machine={machine.QualifiedItemId};accepts={UnavailableAcceptedInputs}");
        if (machine.heldObject.Value is not null || machine.readyForHarvest.Value || machine.MinutesUntilReady > 0)
            return ("machine_load_target_changed", $"machine={machine.QualifiedItemId};held={(machine.heldObject.Value?.QualifiedItemId ?? "none")};ready_for_harvest={machine.readyForHarvest.Value.ToString().ToLowerInvariant()};minutes_until_ready={machine.MinutesUntilReady};tile={targetX},{targetY}");
        if (!machine.performObjectDropInAction(input, probe: true, Game1.player))
            return ("machine_load_unsupported_input", $"machine={machine.QualifiedItemId};expected={input.QualifiedItemId};accepts={DescribeAcceptedMachineInputs(machine)}");
        return null;
    }

    /// <summary>
    /// Whether the native player interaction path reaches this object as a machine at all: <c>GameLocation.checkAction</c>
    /// performs <c>checkForAction</c>/drop-in only on an object whose <c>Type</c> is <c>Crafting</c> or <c>interactive</c>
    /// (GameLocation.cs:7758), which is the one entry both machine actions use. A machine whose data accepts an item but
    /// which that branch never reaches is refused by name rather than reported as an uncertain postcondition after a
    /// native no-op.
    /// </summary>
    private static bool IsMachineInteractionObject(StardewValley.Object machine) => machine.Type is "Crafting" or "interactive";

    /// <summary>The refusal token used when the machine's own data cannot state which inputs it takes.</summary>
    private const string UnavailableAcceptedInputs = "unavailable_in_machine_data";

    /// <summary>The refusal token used when the machine's data was read and declares no item-placed input at all.</summary>
    private const string NoAcceptedMachineInputs = "none_in_machine_data";

    /// <summary>
    /// The machine's own <c>ItemPlacedInMachine</c> trigger rows, enumerated ONCE for both readers: the refusal prose
    /// below and the acceptance the machine's target row publishes (<see cref="BridgeMachineTarget.Accepts"/>).
    ///
    /// <para>
    /// This is the trigger set the engine's admission matcher walks (<c>MachineDataUtility.CanApplyOutput</c>, decompiled
    /// <c>MachineDataUtility.cs:65-102</c>), and the fields copied here are exactly the ones it consults per row:
    /// <c>RequiredItemId</c>, <c>RequiredTags</c>, <c>RequiredCount</c> and the row's <c>Condition</c>. Nothing is decided
    /// at this layer - the admission is the machine's own <c>performObjectDropInAction(probe: true)</c>.
    /// </para>
    /// <para>
    /// null means the engine data cannot answer (the object has no machine data). An empty list is a DIFFERENT fact: the
    /// data was read and declares no item-placed rule, which the matcher can never match, so the machine takes no load.
    /// </para>
    /// </summary>
    private static IReadOnlyList<MachineInputTriggerRule>? ReadMachineInputTriggerRules(StardewValley.Object machine)
    {
        if (machine.GetMachineData() is not MachineData machineData) return null;
        List<MachineInputTriggerRule> rules = new();
        if (machineData.OutputRules is null) return rules;
        foreach (MachineOutputRule rule in machineData.OutputRules)
        {
            if (rule.Triggers is null) continue;
            foreach (MachineOutputTriggerRule trigger in rule.Triggers)
            {
                if (!trigger.Trigger.HasFlag(MachineOutputTrigger.ItemPlacedInMachine)) continue;
                rules.Add(new MachineInputTriggerRule(trigger.RequiredItemId, trigger.RequiredTags, trigger.RequiredCount, trigger.Condition is not null));
            }
        }
        return rules;
    }

    /// <summary>
    /// What this machine declares it takes, bounded and derived - the fact <c>machine_load</c>'s target row publishes so a
    /// caller does not have to guess what a furnace takes. null is "the machine's data cannot answer", never "it takes
    /// nothing".
    /// </summary>
    private static MachineInputAcceptance? ReadMachineInputAcceptance(StardewValley.Object machine)
    {
        return MachineInputAcceptance.Derive(ReadMachineInputTriggerRules(machine));
    }

    /// <summary>
    /// The same acceptance, spelled for a refusal: a caller refused for its INPUT is told the inputs the machine's data
    /// declares, from the one derivation the published row uses, so the refusal can never name a set the row does not.
    /// </summary>
    private static string DescribeAcceptedMachineInputs(StardewValley.Object machine)
    {
        MachineInputAcceptance? acceptance = ReadMachineInputAcceptance(machine);
        if (acceptance is null) return UnavailableAcceptedInputs;
        return acceptance.Inputs.Count == 0 ? NoAcceptedMachineInputs : string.Join(",", acceptance.Inputs);
    }

    /// <summary>
    /// The carried stack this load names, or null when the slot does not hold an object whose id is the one the caller
    /// copied from the machine row. Shared by the entry point and the post-approach body, because the walk can take
    /// several ticks and a stack can be moved in that time.
    /// </summary>
    private static StardewValley.Object? ResolveLoadInput(int slot, string expectedQualifiedItemId) =>
        slot >= 0 && slot < Game1.player.Items.Count
        && Game1.player.Items[slot] is StardewValley.Object input
        && string.Equals(input.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
            ? input
            : null;

    /// <summary>
    /// Executes machine_load against the current world, re-validating the input stack, the machine and the machine's own
    /// admission because an approach leg may have taken several ticks. Shared by the in-range path and the
    /// post-approach path.
    /// </summary>
    private LocalExecutionReceipt ExecuteLoadMachineInput(string executionId, string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId)
    {
        if (ResolveLoadInput(slot, expectedQualifiedItemId) is not StardewValley.Object input)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_load_input_not_in_slot", $"slot={slot};expected={expectedQualifiedItemId}");
        if (MachineLoadRefusal(targetX, targetY, expectedTargetId, input) is { } machineRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, machineRefusal.ReasonCode, machineRefusal.Detail);

        GameLocation location = Game1.player.currentLocation;
        if (!location.objects.TryGetValue(new Vector2(targetX, targetY), out StardewValley.Object? machine))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_load_target_changed", $"target={targetX},{targetY}");
        // The machine's own rows state what this load consumes and how long it takes; the native call below is the one
        // that decides whether it happens. When the rows cannot state the consumption, the probe should not have
        // accepted the item either - refuse instead of running a native load whose size this action cannot check.
        if (!TryReadMachineLoadRequirement(machine, input, Game1.player, location, out MachineLoadRequirement requirement))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_load_unsupported_input", $"machine={machine.QualifiedItemId};expected={expectedQualifiedItemId};accepts={DescribeAcceptedMachineInputs(machine)}");

        int stackBefore = input.Stack;
        int previousSlot = Game1.player.CurrentToolIndex;
        bool nativeHandled;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            nativeHandled = location.checkAction(new xTile.Dimensions.Location(targetX, targetY), Game1.viewport, Game1.player);
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        int stackAfter = Game1.player.Items[slot] is StardewValley.Object remainingStack ? remainingStack.Stack : 0;
        string? lastInput = machine.lastInputItem.Value?.QualifiedItemId;
        string? held = machine.heldObject.Value?.QualifiedItemId;
        bool consumedTheDeclaredCount = stackBefore - stackAfter == requirement.ConsumedCount;
        bool machineRecordedTheInput = string.Equals(lastInput, expectedQualifiedItemId, StringComparison.Ordinal);
        // Object.OutputMachine sets `readyForHarvest` exactly when the computed window is zero (Object.cs:2581-2585),
        // so readiness and the window are one fact; a receipt that disagrees is not describing a native load.
        bool windowAgrees = requirement.ProcessingMinutes is int expectedMinutes
            ? machine.MinutesUntilReady == expectedMinutes
            : machine.MinutesUntilReady >= 0;
        bool readinessAgrees = machine.readyForHarvest.Value == (machine.MinutesUntilReady == 0);
        bool succeeded = nativeHandled && consumedTheDeclaredCount && machineRecordedTheInput && held is not null && windowAgrees && readinessAgrees;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};machine={machine.QualifiedItemId};slot={slot};input={expectedQualifiedItemId};input_stack_before={stackBefore};input_consumed={requirement.ConsumedCount};input_stack_after={stackAfter};last_input={lastInput ?? "none"};held={held ?? "none"};ready_for_harvest={machine.readyForHarvest.Value.ToString().ToLowerInvariant()};minutes_until_ready={machine.MinutesUntilReady};expected_minutes_until_ready={(requirement.ProcessingMinutes is int derivedMinutes ? derivedMinutes.ToString(CultureInfo.InvariantCulture) : "unavailable")};native_check_action={nativeHandled.ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain, succeeded ? "machine_coffee_loaded" : "machine_coffee_load_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// The load which one input of this machine IS, read through the same lookup the engine's own admission performs
    /// (<c>MachineDataUtility.TryGetMachineOutputRule</c>, the call Object.cs:2450 makes when it places an item in a
    /// machine): which output rule and trigger rule match, how many items that trigger consumes, and the processing
    /// window.
    /// </summary>
    private static bool TryReadMachineLoadRequirement(StardewValley.Object machine, StardewValley.Object input, Farmer who, GameLocation location, out MachineLoadRequirement requirement)
    {
        requirement = default;
        MachineData? machineData = machine.GetMachineData();
        if (machineData?.OutputRules is null)
            return false;
        if (!MachineDataUtility.TryGetMachineOutputRule(machine, machineData, MachineOutputTrigger.ItemPlacedInMachine, input, who, location,
                out MachineOutputRule outputRule, out MachineOutputTriggerRule triggerRule, out _, out _))
            return false;
        requirement = new MachineLoadRequirement(triggerRule.RequiredCount, TryDeriveProcessingMinutes(machineData, outputRule, machine, input, who, location));
        return true;
    }

    /// <summary>
    /// The processing window the matched rule declares, mirroring Object.OutputMachine's own derivation
    /// (Object.cs:2571-2581), or null when the duration is code-owned: an <c>OutputMethod</c> supplies its own minutes
    /// through <c>overrideMinutesUntilReady</c> (MachineDataUtility.GetOutputItem), and this derivation must not run it.
    /// </summary>
    private static int? TryDeriveProcessingMinutes(MachineData machineData, MachineOutputRule outputRule, StardewValley.Object machine, StardewValley.Object input, Farmer who, GameLocation location)
    {
        if (outputRule.OutputItem is not null
            && outputRule.OutputItem.Any(output => !string.IsNullOrEmpty(output.OutputMethod)))
            return null;
        int minutes = 0;
        if (outputRule.MinutesUntilReady >= 0 || outputRule.DaysUntilReady >= 0)
            minutes = outputRule.DaysUntilReady >= 0
                ? Utility.CalculateMinutesUntilMorning(Game1.timeOfDay, outputRule.DaysUntilReady)
                : outputRule.MinutesUntilReady;
        return (int)Utility.ApplyQuantityModifiers(minutes, machineData.ReadyTimeModifiers, machineData.ReadyTimeModifierMode, location, who, machine.heldObject.Value, input);
    }

    /// <summary>
    /// Collect a ready machine's output, when the native machine time lifecycle has already made it ready. Like loading,
    /// this enters through GameLocation.checkAction; it never clears held output or adds to the inventory itself.
    /// </summary>
    public LocalExecutionReceipt RequestLocalCollectMachineOutput(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.Physical, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (MachineCollectRefusal(targetX, targetY, expectedTargetId) is { } refusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, refusal.ReasonCode, refusal.Detail);
        // 5.2: out of the native radius, walk in rather than refuse. The ready machine is
        // validated above; it is re-checked after the walk inside the closure, because a
        // harvest can be claimed by the world while the actor is still walking.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "machine_collect_output",
                Game1.player.currentLocation,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteCollectMachineOutput(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteCollectMachineOutput(executionId, requestId, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Why this machine's output cannot be collected right now, or null when it can. The ready state is the machine's own
    /// (<c>readyForHarvest</c> is set only when the processing window reaches zero, Object.cs:2581-2585), and the identity
    /// check is the same one loading uses, so both actions address the machine the same way.
    /// </summary>
    private static (string ReasonCode, string Detail)? MachineCollectRefusal(int targetX, int targetY, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? machine)
            || !string.Equals(BuildMachineTargetId(location, targetX, targetY, machine.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return ("machine_collect_target_changed", $"target={targetX},{targetY}");
        if (machine.GetMachineData() is not MachineData machineData || !IsMachineInteractionObject(machine))
            return ("machine_collect_unsupported_machine", $"machine={machine.QualifiedItemId}");
        if (machine.heldObject.Value is not StardewValley.Object heldObject || !machine.readyForHarvest.Value || machine.MinutesUntilReady != 0)
            return ("machine_collect_target_not_ready", $"machine={machine.QualifiedItemId};held={(machine.heldObject.Value?.QualifiedItemId ?? "none")};ready_for_harvest={machine.readyForHarvest.Value.ToString().ToLowerInvariant()};minutes_until_ready={machine.MinutesUntilReady};tile={targetX},{targetY}");
        // A machine that accepts a load while full takes the ACTOR'S held item through the drop-in branch before the
        // collect branch can run (GameLocation.cs:7766-7787), so the hands must be free for exactly those machines.
        if (machineData.AllowLoadWhenFull && Game1.player.ActiveObject is not null)
            return ("machine_collect_hands_not_free", $"machine={machine.QualifiedItemId};carried={Game1.player.ActiveObject.QualifiedItemId};output={heldObject.QualifiedItemId}");
        return null;
    }

    /// <summary>
    /// Executes machine_collect_output against the current world, re-validating the ready machine because an approach leg
    /// may have taken several ticks. Shared by the in-range path and the post-approach path.
    /// </summary>
    private LocalExecutionReceipt ExecuteCollectMachineOutput(string executionId, string requestId, int targetX, int targetY, string expectedTargetId)
    {
        if (MachineCollectRefusal(targetX, targetY, expectedTargetId) is { } refusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, refusal.ReasonCode, refusal.Detail);

        GameLocation location = Game1.player.currentLocation;
        if (!location.objects.TryGetValue(new Vector2(targetX, targetY), out StardewValley.Object? machine))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_collect_target_changed", $"target={targetX},{targetY}");
        StardewValley.Object output = machine.heldObject.Value;
        if (!Game1.player.couldInventoryAcceptThisItem(output))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_output_inventory_full", $"target={expectedTargetId};output={output.QualifiedItemId}");
        int outputBefore = CountCarried(Game1.player, output.QualifiedItemId);
        bool nativeHandled = location.checkAction(new xTile.Dimensions.Location(targetX, targetY), Game1.viewport, Game1.player);

        int outputAfter = CountCarried(Game1.player, output.QualifiedItemId);
        bool succeeded = nativeHandled
            && machine.heldObject.Value is null
            && !machine.readyForHarvest.Value
            && machine.MinutesUntilReady <= 0
            && outputAfter == outputBefore + output.Stack;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};machine={machine.QualifiedItemId};output={output.QualifiedItemId};output_stack={output.Stack};input={(machine.lastInputItem.Value?.QualifiedItemId ?? "none")};ready_before=true;minutes_until_ready_before=0;inventory_output_before={outputBefore};inventory_output_after={outputAfter};held_after={(machine.heldObject.Value?.QualifiedItemId ?? "none")};ready_after={machine.readyForHarvest.Value.ToString().ToLowerInvariant()};native_check_action={nativeHandled.ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain, succeeded ? "machine_coffee_collected" : "machine_coffee_collect_postcondition_unavailable", evidence);
    }

    /// <summary>How many of one qualified item id the actor carries, across every stack: the native collection adds to an
    /// existing stack when it can, so counting stacks would misreport a merge as a lost output.</summary>
    private static int CountCarried(Farmer who, string qualifiedItemId) =>
        who.Items.OfType<StardewValley.Object>().Where(item => string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal)).Sum(item => item.Stack);

    /// <summary>Published read-only machine inspection. It reads only the live machine object and never invokes the interaction menu or mutates machine state.</summary>
    public LocalExecutionReceipt RequestLocalInspectMachine(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay) return replay;
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity). The single authority names the hold it refuses on;
        // geometry, target identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is { } admissionRefusal)
            return admissionRefusal;
        if (!IsMachineTargetInRange(Game1.player, targetX, targetY))
        {
            // Out of the native interaction radius: walk in and then inspect, like `harvest_crop` in
            // `farmhandexecutioncontroller.farmingconstructionactions.cs`. Refusing gave the Agent
            // `target=x,y` as its only evidence.
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "machine_inspect",
                Game1.player.currentLocation,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteInspectMachine(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId, requestedDeadlineMs),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteInspectMachine(executionId, requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs);
    }

    private LocalExecutionReceipt ExecuteInspectMachine(string executionId, string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? machine)
            || machine.GetMachineData() is null
            || !string.Equals(BuildMachineTargetId(location, targetX, targetY, machine.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_target_changed", $"target={targetX},{targetY}");

        LocalMachineInspectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, this.revision, requestedDeadlineMs);
        string? held = machine.heldObject.Value?.QualifiedItemId;
        string? input = machine.lastInputItem.Value?.QualifiedItemId;
        string evidence = $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};machine={machine.QualifiedItemId};ready_for_harvest={machine.readyForHarvest.Value.ToString().ToLowerInvariant()};minutes_until_ready={machine.MinutesUntilReady};held={held ?? "none"};last_input={input ?? "none"}";
        return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "machine_inspected", evidence);
    }


    /// <summary>Experimental native item consumption. The Farmer owns animation, stat/buff changes, and inventory decrement.</summary>
    public LocalExecutionReceipt RequestLocalUseItem(string requestId, int slot, string expectedQualifiedItemId, long requestedDeadlineMs)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay) return replay;
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity). The single authority names the hold it refuses on;
        // geometry, slot identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is { } admissionRefusal)
            return admissionRefusal;
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object food)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(food.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_slot_changed", $"slot={slot}");
        bool isDrink = Game1.objectData.TryGetValue(food.ItemId, out var objectData) && objectData.IsDrink;
        if (food.QualifiedItemId == "(O)434" || (!isDrink && food.Edibility == -300))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_consumable", $"slot={slot};item={expectedQualifiedItemId}");

        int stackBefore = food.Stack;
        LocalItemUseSpec specification = new(executionId, requestId, slot, expectedQualifiedItemId, stackBefore, food.Edibility, isDrink, Game1.player.Stamina, Game1.player.health, this.revision, requestedDeadlineMs);
        int previousSlot = Game1.player.CurrentToolIndex;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            Game1.player.mostRecentlyGrabbedItem = food;
            Game1.player.eatHeldObject();
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        StardewValley.Object? remaining = slot < Game1.player.Items.Count ? Game1.player.Items[slot] as StardewValley.Object : null;
        bool started = Game1.player.isEating;
        bool consumed = remaining is null || (string.Equals(remaining.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal) && remaining.Stack == stackBefore - 1);
        if (!started)
        {
            ExecutionState state = consumed ? ExecutionState.Uncertain : ExecutionState.Rejected;
            return this.RememberTerminal(requestId, executionId, state, consumed ? "item_use_started_without_animation" : "item_use_not_started", $"slot={slot};started=false;consumed={consumed.ToString().ToLowerInvariant()}");
        }

        this.slots.ItemUse.Assign(specification);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "accepted",
            $"slot={slot};item={expectedQualifiedItemId};stack_before={stackBefore};edibility={food.Edibility};drink={isDrink.ToString().ToLowerInvariant()}");
    }

    /// <summary>
    /// Experimental native feeding action, strictly limited to placing one owned Hay item into a live empty AnimalHouse Trough.
    /// This deliberately proves placement only: native AnimalHouse day update owns later animal fullness.
    /// </summary>
    public LocalExecutionReceipt RequestLocalFeedAnimal(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay) return replay;
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player?.currentLocation is not AnimalHouse location)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_house_not_available",
                $"location={Game1.player?.currentLocation?.NameOrUniqueName ?? "none"}");
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity). The single authority names the hold it refuses on;
        // geometry, trough identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is { } admissionRefusal)
            return admissionRefusal;
        if (!IsFeedTroughTargetInRange(Game1.player, targetX, targetY))
        {
            // Out of the native interaction radius: walk in and then feed, like `harvest_crop` in
            // `farmhandexecutioncontroller.farmingconstructionactions.cs`.
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "feed_animal",
                Game1.player.currentLocation,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteFeedAnimal(location, arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId, requestedDeadlineMs),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteFeedAnimal(location, executionId, requestId, slot, targetX, targetY, expectedTargetId, requestedDeadlineMs);
    }

    private LocalExecutionReceipt ExecuteFeedAnimal(AnimalHouse location, string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object hay
            || !string.Equals(hay.QualifiedItemId, "(O)178", StringComparison.Ordinal) || hay.Stack < 1)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hay_not_owned_in_slot", $"slot={slot}");

        Vector2 tile = new(targetX, targetY);
        if (location.doesTileHaveProperty(targetX, targetY, "Trough", "Back") is null || location.objects.ContainsKey(tile)
            || !string.Equals(BuildFeedTroughTargetId(location, slot, targetX, targetY, hay.Stack), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "feed_trough_target_changed", $"target={targetX},{targetY}");

        int hayBefore = CountQualifiedItem(Game1.player, "(O)178");
        int previousSlot = Game1.player.CurrentToolIndex;
        bool nativeHandled;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            nativeHandled = location.checkAction(new xTile.Dimensions.Location(targetX, targetY), Game1.viewport, Game1.player);
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }
        int hayAfter = CountQualifiedItem(Game1.player, "(O)178");
        bool troughFilled = location.objects.TryGetValue(tile, out StardewValley.Object? placed)
            && string.Equals(placed.QualifiedItemId, "(O)178", StringComparison.Ordinal);
        bool hayConsumed = hayAfter == hayBefore - 1;
        bool succeeded = nativeHandled && troughFilled && hayConsumed;
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain,
            succeeded ? "hay_placed_in_trough" : "feed_trough_postcondition_unavailable",
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};slot={slot};native_handled={nativeHandled.ToString().ToLowerInvariant()};trough_filled={troughFilled.ToString().ToLowerInvariant()};hay_before={hayBefore};hay_after={hayAfter};hay_consumed={hayConsumed.ToString().ToLowerInvariant()}");
    }

    /// <summary>Experimental native animal-product collection. Only MilkPail/Shears can start their version-locked animation and completion lifecycle.</summary>
    public LocalExecutionReceipt RequestLocalCollectAnimalProduct(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        // Physical: this seam drives a real MilkPail/Shears tool through the native BeginUsingTool lifecycle. The slot,
        // the animal and its produce are the gate's business; the tool lifecycle and its postcondition are the body's.
        return this.RequestLocalTileTarget("collect_animal_product", requestId, expectedTargetId, requestedDeadlineMs, AdmissionActionabilityProfile.Physical,
            location =>
            {
                if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not Tool tool || tool is not MilkPail and not Shears)
                    return TileTargetGate.Refused(new TileTargetRefusal("animal_product_tool_not_owned", $"slot={slot}"));
                // Identity-bound admission, same reasoning as RequestLocalPetAnimal: a FarmAnimal wanders inside its
                // building, so matching its live tile to the coordinate captured at snapshot time makes the request a race.
                // BuildAnimalProductTargetId hashes location + myID + slot + tool + produce and takes no coordinate at
                // all, so the coordinate comparison was an extra binding that could only ever reject a legitimate request.
                FarmAnimal? animal = ResolveAnimalProductTarget(location, slot, tool, expectedTargetId);
                if (animal is null)
                    return TileTargetGate.Refused(new TileTargetRefusal("animal_product_target_gone", $"target={expectedTargetId}"));
                // Every position-independent precondition is validated before the seam decides whether to walk, so the
                // actor is not sent walking for an animal it could not milk on arrival. The execution body re-validates
                // all of it, because the animal can lose its produce, grow, or be claimed while the actor walks.
                if (animal.currentProduce.Value is null || !animal.isAdult() || !animal.CanGetProduceWithTool(tool))
                    return TileTargetGate.Refused(new TileTargetRefusal("animal_product_target_changed", $"target={expectedTargetId}"));
                StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
                int produceStack = animal.hasEatenAnimalCracker.Value ? 2 : 1;
                if (!Game1.player.couldInventoryAcceptThisItem(produce.QualifiedItemId, produceStack))
                    return TileTargetGate.Refused(new TileTargetRefusal("inventory_full", $"item={produce.QualifiedItemId};stack={produceStack};space=none"));
                return TileTargetGate.Resolved((int)animal.Tile.X, (int)animal.Tile.Y);
            },
            (executionId, admittedRequestId) => this.ExecuteCollectAnimalProduct(executionId, admittedRequestId, slot, expectedTargetId, requestedDeadlineMs));
    }

    /// <summary>
    /// Executes collect_animal_product against the current world. An approach leg can
    /// take several ticks while the animal wanders, so the animal is re-resolved from
    /// its opaque id and its LIVE tile drives the range gate, the facing and the click
    /// aim: aiming at the coordinate the snapshot published would hand the tool a tile
    /// the animal has already left, and the native binding guard would then refuse the
    /// exact animal this body just validated.
    /// </summary>
    private LocalExecutionReceipt ExecuteCollectAnimalProduct(string executionId, string requestId, int slot, string expectedTargetId, long requestedDeadlineMs)
    {
        GameLocation location = Game1.player.currentLocation;
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not Tool tool || tool is not MilkPail and not Shears)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_tool_not_owned", $"slot={slot}");
        FarmAnimal? animal = ResolveAnimalProductTarget(location, slot, tool, expectedTargetId);
        if (animal is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_target_gone", $"target={expectedTargetId}");
        // Range against the animal's current tile -- what the interaction needs. A
        // walk that ends out of reach is the shared approach vocabulary, not an
        // out-of-range planner refusal, and both tiles are reported so the moved
        // target is visible rather than inferred.
        int animalTileX = (int)animal.Tile.X;
        int animalTileY = (int)animal.Tile.Y;
        if (!IsAnimalProductTargetInRange(Game1.player, animalTileX, animalTileY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_reach",
                $"target={expectedTargetId};animal={animalTileX},{animalTileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=target_moved");
        if (animal.currentProduce.Value is null || !animal.isAdult() || !animal.CanGetProduceWithTool(tool))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_target_changed", $"target={expectedTargetId}");
        int produceStack = animal.hasEatenAnimalCracker.Value ? 2 : 1;
        StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
        if (!Game1.player.couldInventoryAcceptThisItem(produce.QualifiedItemId, produceStack))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full",
                $"item={produce.QualifiedItemId};stack={produceStack};space=none");

        int inventoryBefore = CountQualifiedItem(Game1.player, produce.QualifiedItemId);
        int previousSlot = Game1.player.CurrentToolIndex;
        int previousFacingDirection = Game1.player.FacingDirection;
        string toolKind = tool is MilkPail ? "milk_pail" : "shears";
        float staminaBefore = Game1.player.Stamina;
        LocalAnimalProductCollectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, slot, animalTileX, animalTileY, expectedTargetId,
            animal.myID.Value, animal.type.Value, produce.QualifiedItemId, toolKind, produceStack, inventoryBefore, previousSlot, staminaBefore, this.revision, requestedDeadlineMs);
        Game1.player.CurrentToolIndex = slot;
        // Follow the target-version input path, rather than calling Tool.beginUsing
        // directly: the Farmer-owned event schedules performBeginUsingTool, which
        // starts the tool animation and later invokes Farmer.useTool/Tool.DoFunction.
        // MilkPail/Shears select from GetToolLocation, so orient the Farmhand at the
        // already-revalidated exact animal before beginning that native lifecycle.
        Game1.player.FacingDirection = GetCardinalFacingDirectionToTile(Game1.player, animalTileX, animalTileY);
        Game1.player.lastClick = new Vector2(animalTileX * 64f + 32f, animalTileY * 64f + 32f);
        Game1.player.BeginUsingTool();
        FarmAnimal? boundAnimal = tool switch
        {
            Shears shears => shears.animal,
            MilkPail milkPail => milkPail.animal,
            _ => null,
        };
        Vector2 nativeToolLocation = Game1.player.GetToolLocation();
        if (!Game1.player.UsingTool || boundAnimal is null || boundAnimal.myID.Value != animal.myID.Value)
        {
            Game1.player.CurrentToolIndex = previousSlot;
            Game1.player.FacingDirection = previousFacingDirection;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_native_target_not_bound",
                $"tool={toolKind};expected_animal={animal.myID.Value};bound_animal={boundAnimal?.myID.Value.ToString() ?? "none"};tool_tile={(int)(nativeToolLocation.X / 64f)},{(int)(nativeToolLocation.Y / 64f)}");
        }
        this.slots.AnimalProduct.Assign(specification);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "accepted",
            $"location={specification.Location};target={expectedTargetId};animal={animal.myID.Value};bound_animal={boundAnimal.myID.Value};tool={toolKind};tool_tile={(int)(nativeToolLocation.X / 64f)},{(int)(nativeToolLocation.Y / 64f)};produce={produce.QualifiedItemId};produce_stack={produceStack}");
    }

    /// <summary>
    /// Re-derives the farm animal a published opaque id names, from the actor's
    /// CURRENT location. BuildAnimalProductTargetId is location + animal id + slot +
    /// tool + produce, so an animal that walked between the snapshot and this read
    /// resolves to the same subject.
    /// </summary>
    private static FarmAnimal? ResolveAnimalProductTarget(StardewValley.GameLocation location, int slot, Tool tool, string expectedTargetId) =>
        location.animals.Values.FirstOrDefault(candidate =>
            string.Equals(BuildAnimalProductTargetId(location, slot, candidate, tool), expectedTargetId, StringComparison.Ordinal));

    /// <summary>
    /// The held-item branches of `Pet.checkAction` (Pet.cs:619-664) whose effect is NOT the pet the caller asked
    /// for, as ONE predicate so the request path and the execution body cannot disagree about when `checkAction`
    /// really pets.
    ///
    /// <para>
    /// There used to be a blanket `if (Game1.player.CurrentItem is not null) hands_not_empty` here, and it was
    /// FALSE: `Pet.checkAction` refuses nothing. It reads `Items[CurrentToolIndex]` for exactly two branches - a
    /// `Hat` is taken out of the pack and moved onto the pet (Pet.cs:621-641) and `(O)ButterflyPowder` opens a
    /// question dialogue (:642-645) - and then falls through to the petting body (:646-664) either way. Measured
    /// 2026-11-08 with a `(O)72` in hand: the native seam petted the cat and returned true, while the Mod refused
    /// `hands_not_empty` with no evidence at all - telling the caller to empty a hand the game never required it to
    /// empty, and costing the companion a turn to comply.
    /// </para>
    /// <para>
    /// So the refusal names the two branches that DO exist, each for its own reason: a pet must never consume an
    /// item the caller did not name (the same ruling `farm_animal_cracker_would_be_consumed` follows one action
    /// over), and it must never open a modal it would then have to own and settle.
    /// </para>
    /// </summary>
    private static (string Code, string Detail)? PetHeldItemRefusal(Farmer who, string expectedTargetId)
    {
        string detail = $"target={expectedTargetId};hand_item={who.CurrentItem?.QualifiedItemId ?? "none"}";
        if (who.CurrentItem is StardewValley.Objects.Hat) return ("pet_held_hat_would_be_taken", detail);
        if (who.CurrentItem?.QualifiedItemId == "(O)ButterflyPowder") return ("pet_held_butterfly_powder_opens_dialogue", detail);
        return null;
    }

    /// <summary>Experimental native pet interaction. The native Pet.checkAction path owns daily petting and friendship mutation.</summary>
    public LocalExecutionReceipt RequestLocalPetAnimal(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        return this.RequestLocalTileTarget("pet_animal", requestId, expectedTargetId, requestedDeadlineMs, AdmissionActionabilityProfile.General,
            location =>
            {
                // Admission is identity-bound, not coordinate-bound. A Pet walks on its own -- Data/Pets gives 'Walk'
                // WalkInDirection=true with RandomizeDirection=true, and Pet.RunState re-rolls the facing each tick -- so
                // binding the request to the tile it occupied when the snapshot was taken makes every attempt a race. The
                // caller means "that pet", not "whatever is standing on 26,33": BuildPetTargetId hashes only location +
                // petId, and the tile the seam walks to is the one the pet stands on NOW.
                if (ResolvePetTarget(location, expectedTargetId) is not Pet pet)
                    return TileTargetGate.Refused(new TileTargetRefusal("pet_target_gone", $"target={expectedTargetId}"));
                if (PetHeldItemRefusal(Game1.player, expectedTargetId) is { } heldRefusal)
                    return TileTargetGate.Refused(new TileTargetRefusal(heldRefusal.Code, heldRefusal.Detail));
                return TileTargetGate.Resolved((int)pet.Tile.X, (int)pet.Tile.Y);
            },
            (executionId, admittedRequestId) => this.ExecutePetAnimal(executionId, admittedRequestId, expectedTargetId, requestedDeadlineMs));
    }

    /// <summary>
    /// Executes pet_animal against the current world. An approach leg can take several
    /// ticks and a Pet walks on its own, so the pet is re-resolved from its opaque id
    /// and reach is measured against its LIVE tile. A pet that walked out of the radius
    /// while the actor walked to where it had been is refused with the shared approach
    /// vocabulary, never petted through a stale coordinate.
    /// </summary>
    private LocalExecutionReceipt ExecutePetAnimal(string executionId, string requestId, string expectedTargetId, long requestedDeadlineMs)
    {
        GameLocation location = Game1.player.currentLocation;
        Pet? pet = ResolvePetTarget(location, expectedTargetId);
        if (pet is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pet_target_gone", $"target={expectedTargetId}");
        if (PetHeldItemRefusal(Game1.player, expectedTargetId) is { } heldRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, heldRefusal.Code, heldRefusal.Detail);
        // Range is measured against the pet's current tile, which is what
        // interaction actually requires. Checking the requested coordinate would
        // accept a stale position and reject a pet that had walked into reach.
        int petTileX = (int)pet.Tile.X;
        int petTileY = (int)pet.Tile.Y;
        if (!IsTileWithinChebyshevRadius(Game1.player, petTileX, petTileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_reach",
                $"target={expectedTargetId};pet={petTileX},{petTileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=target_moved");

        int friendshipBefore = pet.friendshipTowardFarmer.Value;
        LocalPettingSpec specification = new(executionId, requestId, location.NameOrUniqueName, petTileX, petTileY, expectedTargetId, pet.petId.Value.ToString("N"), friendshipBefore, Math.Min(1000, friendshipBefore + 12), Game1.Date.TotalDays, this.revision, requestedDeadlineMs);
        this.slots.Pet.Assign(specification);
        bool handled = pet.checkAction(Game1.player, location);
        if (!handled)
        {
            this.slots.Pet.Clear();
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pet_action_not_handled", $"target={expectedTargetId}");
        }

        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "accepted", $"target={expectedTargetId};pet_day={specification.PetDay};friendship_before={friendshipBefore};expected_friendship_after={specification.ExpectedFriendshipAfter}");
    }

    /// <summary>
    /// Re-derives the pet a published opaque id names, from the actor's CURRENT
    /// location, on the game thread. BuildPetTargetId is location + petId only, so a
    /// Pet that walked between the snapshot and this read resolves to the same subject;
    /// the day filter is the same one discovery applies.
    /// </summary>
    private static Pet? ResolvePetTarget(StardewValley.GameLocation location, string expectedTargetId) =>
        location.characters.OfType<Pet>().FirstOrDefault(candidate =>
            string.Equals(BuildPetTargetId(location, (int)candidate.Tile.X, (int)candidate.Tile.Y, candidate), expectedTargetId, StringComparison.Ordinal)
            && (!candidate.lastPetDay.TryGetValue(Game1.player.UniqueMultiplayerID, out int lastDay) || lastDay != Game1.Date.TotalDays));

    /// <summary>
    /// Pets one FARM animal (barn/coop stock, `location.animals`) through `FarmAnimal.pet(who)` (FarmAnimal.cs:693) —
    /// the same native call the player's own click route makes, not a re-implementation of its effects.
    ///
    /// <para>
    /// This is `pet_farm_animal`, and it is NOT `pet_animal`: that action pets the household `Pet` (cat/dog) through
    /// `Pet.checkAction` and reads `lastPetDay` / `grantedFriendshipForPet`. The two are different subject classes with
    /// different native seams, different day markers and a different friendship amount, so they are two actions.
    /// </para>
    ///
    /// <para>
    /// Every no-op branch of the seam is refused BY NAME before it is called, because the seam itself reports nothing:
    /// it returns calmly after showing a dialogue, after consuming a held Golden Animal Cracker, or after opening
    /// `AnimalQueryMenu`, and a caller holding only a receipt would believe the animal had been petted. Branches read
    /// at FarmAnimal.cs:695-795 and carried by <see cref="FarmAnimalPetRefusal"/>.
    /// </para>
    ///
    /// <para>
    /// Everything the seam DOES apply is synchronous (friendship, happiness, `wasPet`), so unlike `pet_animal` / 
    /// `collect_animal_product` this action needs no pending activity slot: the postcondition is read in the same call
    /// that caused it.
    /// </para>
    /// </summary>
    public LocalExecutionReceipt RequestLocalPetFarmAnimal(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        // A farmer paused mid animation, eating, in a menu or in a cutscene is refused or parked by the seam's admission,
        // which is also what closes the seam's own `who.FarmerSprite.PauseForSingleAnimation` early return (:697): that
        // branch is reached only by an actor admission has already let through as Idle.
        return this.RequestLocalTileTarget("pet_farm_animal", requestId, expectedTargetId, requestedDeadlineMs, AdmissionActionabilityProfile.General,
            location =>
            {
                if (ResolveFarmAnimalPetTarget(location, expectedTargetId) is not FarmAnimal animal)
                    return TileTargetGate.Refused(new TileTargetRefusal("farm_animal_target_gone", $"target={expectedTargetId}"));
                // Every position-INDEPENDENT refusal is decided before the seam decides whether to walk, so the actor is not
                // sent walking to an animal it could not pet on arrival, and re-decided again in the execution body
                // because the walk takes ticks.
                if (FarmAnimalPetRefusal(Game1.player, animal) is { } refusal)
                    return TileTargetGate.Refused(new TileTargetRefusal(refusal, $"target={expectedTargetId};animal={animal.myID.Value};time_of_day={Game1.timeOfDay}"));
                return TileTargetGate.Resolved((int)animal.Tile.X, (int)animal.Tile.Y);
            },
            (executionId, admittedRequestId) => this.ExecutePetFarmAnimal(executionId, admittedRequestId, expectedTargetId));
    }

    /// <summary>
    /// The farm-animal pet's position-independent refusals as ONE predicate, so the admission path and the execution
    /// body cannot disagree about when `pet` will really pet. Each code names the branch of `FarmAnimal.pet` whose
    /// effect is not a pet.
    /// </summary>
    private static string? FarmAnimalPetRefusal(Farmer who, FarmAnimal animal)
    {
        // :745 `if (!wasPet.Value)` guards the entire mutation. When it is false the manual call runs :791-:794
        // instead, which mounts `AnimalQueryMenu` and changes no friendship at all. Refusing is deliberate rather than
        // taking the modal route: a modal this action opened would then be its to close, and the postcondition would
        // have to read the menu's outcome instead of the animal's.
        if (animal.wasPet.Value) return "farm_animal_already_petted_today";
        // :726 `if (!hasEatenAnimalCracker.Value && who.ActiveObject?.QualifiedItemId == "(O)GoldenAnimalCracker")`.
        // The seam spends the held cracker, returns BEFORE any friendship, and mutates the inventory instead of the
        // animal. A pet must never consume an item the caller did not name.
        if (!animal.hasEatenAnimalCracker.Value
            && who.ActiveObject?.QualifiedItemId == "(O)GoldenAnimalCracker"
            && animal.GetAnimalData()?.CanEatGoldenCrackers == true)
            return "farm_animal_cracker_would_be_consumed";
        // :703 `if (Game1.timeOfDay >= 1900 && !isMoving())` -- after 19:00 a STATIONARY animal only answers with the
        // `TryingToSleep` dialogue. A moving one is still petted, which is why this reads `isMoving()` and not the
        // clock alone.
        if (Game1.timeOfDay >= 1900 && !animal.isMoving()) return "farm_animal_pet_requires_movement_after_1900";
        return null;
    }

    /// <summary>
    /// The one petting body, reached both in range and on arrival. It re-resolves the animal from its opaque id and
    /// measures reach against the animal's LIVE tile: a barn animal wanders while the actor walks, so the coordinate
    /// the snapshot published is only where it used to be.
    /// </summary>
    private LocalExecutionReceipt ExecutePetFarmAnimal(string executionId, string requestId, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        FarmAnimal? animal = ResolveFarmAnimalPetTarget(location, expectedTargetId);
        if (animal is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "farm_animal_target_gone", $"target={expectedTargetId}");
        if (FarmAnimalPetRefusal(Game1.player, animal) is { } refusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, refusal, $"target={expectedTargetId};animal={animal.myID.Value};time_of_day={Game1.timeOfDay};after_approach=true");
        int animalTileX = (int)animal.Tile.X;
        int animalTileY = (int)animal.Tile.Y;
        if (!IsTileWithinChebyshevRadius(Game1.player, animalTileX, animalTileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_reach",
                $"target={expectedTargetId};animal={animalTileX},{animalTileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=target_moved");

        long animalId = animal.myID.Value;
        string animalType = animal.type.Value;
        int friendshipBefore = animal.friendshipTowardFarmer.Value;
        int happinessBefore = animal.happiness.Value;
        bool autoPettedBefore = animal.wasAutoPet.Value;
        // The MINIMUM friendship this pet must apply, taken from the seam's own branches (:751-:763): a manual pet adds
        // 15, and 7 when the animal was already auto-petted that morning. The friendship-boost profession (:772-:775)
        // only ever ADDS 15 more, so the branch's base gain is the honest floor, capped exactly where the seam caps it.
        int friendshipFloor = Math.Min(1000, friendshipBefore + (autoPettedBefore ? 7 : 15));

        animal.pet(Game1.player);

        // The postcondition is the ENGINE'S OWN mutation, not a re-derivation: `wasPet` is the marker `pet` sets at
        // :749, and the friendship floor is the branch the seam took. A seam that took one of its early returns changed
        // neither, and is reported Uncertain rather than as a pet that never happened.
        int friendshipAfter = animal.friendshipTowardFarmer.Value;
        bool marked = animal.wasPet.Value;
        bool friendshipApplied = friendshipAfter >= friendshipFloor;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};animal={animalId};type={animalType};tile={animalTileX},{animalTileY};friendship_before={friendshipBefore};friendship_after={friendshipAfter};friendship_floor={friendshipFloor};happiness_before={happinessBefore};happiness_after={animal.happiness.Value};was_auto_pet_before={autoPettedBefore.ToString().ToLowerInvariant()};was_pet={marked.ToString().ToLowerInvariant()};time_of_day={Game1.timeOfDay}";
        if (!marked || !friendshipApplied)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "farm_animal_pet_postcondition_not_observed", evidence);
        }

        return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "farm_animal_petted", evidence);
    }

    /// <summary>
    /// Re-derives the farm animal a published opaque id names, from the actor's CURRENT location, WITHOUT the day
    /// filter: an animal this farmer petted after the snapshot was taken must still RESOLVE, so the refusal can name
    /// `farm_animal_already_petted_today` instead of claiming the animal is gone. BuildFarmAnimalPetTargetId is
    /// location + animal id only, so a wandering animal resolves to the same subject.
    /// </summary>
    private static FarmAnimal? ResolveFarmAnimalPetTarget(StardewValley.GameLocation location, string expectedTargetId) =>
        location.animals.Values.FirstOrDefault(candidate =>
            string.Equals(BuildFarmAnimalPetTargetId(location, candidate), expectedTargetId, StringComparison.Ordinal));

    /// <summary>Experimental read-only NPC relationship inspection. It never invokes NPC interaction or creates missing friendship records.</summary>
    public LocalExecutionReceipt RequestLocalInspectNpcRelationship(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        return this.RequestLocalTileTarget("inspect_npc_relationship", requestId, expectedTargetId, requestedDeadlineMs, AdmissionActionabilityProfile.General,
            location =>
            {
                // Identity-bound admission (see BuildNpcRelationshipTargetId). A villager follows a daily schedule, so
                // binding the request to the tile it occupied at snapshot time made every attempt a race; the tile the
                // seam walks to is the one the villager stands on now.
                if (FindVillagerByTargetId(location, expectedTargetId) is not StardewValley.NPC npc)
                    return TileTargetGate.Refused(new TileTargetRefusal("npc_relationship_target_gone", $"target={expectedTargetId}"));
                return TileTargetGate.Resolved((int)npc.Tile.X, (int)npc.Tile.Y);
            },
            (executionId, admittedRequestId) => this.ExecuteInspectNpcRelationship(executionId, admittedRequestId, expectedTargetId, requestedDeadlineMs));
    }

    /// <summary>
    /// The one inspection body, reached both in range and on arrival. It re-resolves the villager by
    /// name-binding rather than reusing the NPC object captured before the walk: a villager moves, and an
    /// object captured two seconds ago can be in another room.
    /// </summary>
    private LocalExecutionReceipt ExecuteInspectNpcRelationship(string executionId, string requestId, string expectedTargetId, long requestedDeadlineMs)
    {
        StardewValley.GameLocation location = Game1.player.currentLocation;
        StardewValley.NPC? npc = FindVillagerByTargetId(location, expectedTargetId);
        if (npc is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "npc_relationship_target_gone", $"target={expectedTargetId}");
        if (!IsTileWithinChebyshevRadius(Game1.player, (int)npc.Tile.X, (int)npc.Tile.Y, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "npc_relationship_out_of_reach_after_approach", $"target={expectedTargetId};npc={(int)npc.Tile.X},{(int)npc.Tile.Y}");
        // A villager the player has never met has no record yet, and the discovery projection publishes that villager
        // with the zeroed relationship the engine's own first conversation creates (`NPC.checkAction`,
        // `friendshipData.Add(name, new Friendship(0))`). Refusing here would advertise a target the family's own
        // inspection cannot read, so the absent record is read as the zero it is rather than as missing data.
        Friendship friendship = Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? record)
            ? record
            : new Friendship();

        int npcTileX = (int)npc.Tile.X;
        int npcTileY = (int)npc.Tile.Y;
        LocalNpcRelationshipInspectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, npcTileX, npcTileY, expectedTargetId, npc.Name, this.revision, requestedDeadlineMs);
        string evidence = $"location={specification.Location};target={expectedTargetId};tile={npcTileX},{npcTileY};npc={specification.NpcName};points={friendship.Points};status={friendship.Status};talked_to_today={friendship.TalkedToToday.ToString().ToLowerInvariant()};gifts_today={friendship.GiftsToday};gifts_this_week={friendship.GiftsThisWeek}";
        return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "npc_relationship_inspected", evidence);
    }


    /// <summary>
    /// Experimental native NPC gift interaction (seam decision (a), recorded in
    /// design/tasks/active/cards/loop-lane-a-gift.md). The Mod reproduces the
    /// tryToReceiveActiveObject gift gates (NPC.cs:1943/2209/2282/2297-2298/
    /// 2300-2310/2313/2315-2322/2323/2327-2329/2331-2336/2337-2341/2358-2364)
    /// and then calls NPC.receiveGift(..., showResponse: false) directly
    /// (NPC.cs:4766; response gated at :4844), so no DialogueBox or
    /// activeClickableMenu is ever mounted. Native-faithful reproductions:
    /// friendshipData dictionary protection (:2327-2329), farmer.completeQuest
    /// ("25") (:2313), and the spouse-jealousy branch (:2346-2356) with its
    /// content-driven SpouseGiftJealousyFriendshipChange and
    /// GameStateQuery.CheckConditions gate. A matching unsatisfied native
    /// ItemDeliveryQuest is delivered first, exactly where the native ingress
    /// runs its quest hook (before any gift handling); only an offer that no
    /// pending delivery quest claims reaches the gift path below.
    ///
    /// Task-delivery seam: NPC.tryToReceiveActiveObject (NPC.cs:1776) runs
    /// `who.NotifyQuests(quest => quest.OnItemOfferedToNpc(this, activeObj,
    /// probe), onlyOneQuest: true)` before its special-item switch (:1788) and
    /// before every gift gate, and NotifyQuests walks the quest log last-to-
    /// first (Farmer.decompiled.cs:8968). Only ItemDeliveryQuest overrides
    /// OnItemOfferedToNpc in the target version, so quest selection here
    /// reproduces the predicate at ItemDeliveryQuest.cs:497 in that order, then
    /// lets the native hook itself make the accept/decline decision through
    /// `probe: true` (:499/:517, side-effect free). The delivery mutations are
    /// the non-probe body (:503/:504/:507-515) minus its two UI-mounting lines:
    /// the NPC dialogue push at :505 and the dialogue-box draw at :506 are
    /// omitted, so the headless body never mounts a modal and never runs
    /// dialogue parsing/content loading.
    /// A pending delivery quest for the offered item therefore preempts the
    /// gift path exactly as it does natively, with `quest_item_delivered`
    /// proving `quest.completed.Value` plus the exact `number.Value`
    /// consumption.
    /// </summary>
    public LocalExecutionReceipt RequestLocalInteractNpcWithItem(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        return this.RequestLocalTileTarget("interact_npc_with_item", requestId, expectedTargetId, requestedDeadlineMs, AdmissionActionabilityProfile.General,
            location =>
            {
                if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object offered || offered.Stack < 1)
                    return TileTargetGate.Refused(new TileTargetRefusal("item_not_owned_in_slot", $"slot={slot}"));
                if (!string.Equals(offered.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
                    return TileTargetGate.Refused(new TileTargetRefusal("item_slot_changed", $"slot={slot}"));
                // Identity-bound admission (see BuildNpcRelationshipTargetId): a villager follows a daily schedule, so a
                // request bound to the tile it occupied at snapshot time would be refused as soon as it walked, even
                // though the caller meant that villager.
                if (FindVillagerByTargetId(location, expectedTargetId) is not StardewValley.NPC npc)
                    return TileTargetGate.Refused(new TileTargetRefusal("npc_interaction_target_gone", $"target={expectedTargetId}"));
                return TileTargetGate.Resolved((int)npc.Tile.X, (int)npc.Tile.Y);
            },
            (executionId, admittedRequestId) => this.ExecuteInteractNpcWithItem(executionId, admittedRequestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId, requestedDeadlineMs));
    }

    /// <summary>
    /// The one interaction body, reached both in range and on arrival. It re-resolves the villager by
    /// name-binding rather than reusing the NPC captured before the walk, and re-checks the item the
    /// request named, because both can change while the actor walks.
    /// </summary>
    private LocalExecutionReceipt ExecuteInteractNpcWithItem(string executionId, string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        StardewValley.GameLocation location = Game1.player.currentLocation;
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object offered || offered.Stack < 1)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(offered.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_slot_changed", $"slot={slot}");
        StardewValley.NPC? npc = FindVillagerByTargetId(location, expectedTargetId);
        if (npc is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "npc_interaction_target_gone", $"target={expectedTargetId}");
        if (!IsTileWithinChebyshevRadius(Game1.player, (int)npc.Tile.X, (int)npc.Tile.Y, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "npc_interaction_out_of_reach_after_approach", $"target={expectedTargetId};npc={(int)npc.Tile.X},{(int)npc.Tile.Y}");

        Farmer player = Game1.player;
        // Mirrors NPC.tryToReceiveActiveObject `if (!probe) { who.Halt();
        // who.faceGeneralDirection(this.getStandingPosition(), 0, opposite:
        // false, useTileCalculations: false); }` (NPC.cs:1725-1728).
        player.Halt();
        player.faceGeneralDirection(npc.getStandingPosition(), 0, opposite: false, useTileCalculations: false);

        Friendship? friendship = player.friendshipData.TryGetValue(npc.Name, out Friendship? existingFriendship) ? existingFriendship : null;
        int pointsBefore = friendship?.Points ?? 0;
        int giftsTodayBefore = friendship?.GiftsToday ?? 0;
        int giftsThisWeekBefore = friendship?.GiftsThisWeek ?? 0;
        bool quest25CompletedBefore = player.questLog.Any(quest => quest.id.Value == "25" && quest.completed.Value);
        int stackBefore = offered.Stack;
        int completedQuestsBefore = player.questLog.Count(quest => quest.completed.Value);

        // Task delivery owns the offer exactly where the native ingress runs its
        // quest hook (NPC.cs:1776), i.e. before the special-item switch and
        // before every gift gate. Selection reproduces
        // `Farmer.NotifyQuests(quest => quest.OnItemOfferedToNpc(this,
        // activeObj, probe), onlyOneQuest: true)` walking the log last-to-first
        // (Farmer.decompiled.cs:8968-8984) and asks the target version's own
        // hook - ItemDeliveryQuest.OnItemOfferedToNpc, the only override in
        // 1.6.15 - whether it claims this offer through its side-effect-free
        // `probe: true` path (ItemDeliveryQuest.cs:499/:517). The hook decides;
        // this body never reimplements its predicate. A quest that matched the
        // villager/item but failed the hook's own stack gate is remembered only
        // so that offer settles as an explicit quantity refusal instead of
        // silently sliding into the gift path.
        StardewValley.Quests.ItemDeliveryQuest? deliveryQuest = null;
        StardewValley.Quests.ItemDeliveryQuest? undersuppliedQuest = null;
        for (int index = player.questLog.Count - 1; index >= 0; index--)
        {
            if (player.questLog[index] is not StardewValley.Quests.ItemDeliveryQuest candidate || candidate.completed.Value)
                continue;
            if (candidate.OnItemOfferedToNpc(npc, offered, probe: true))
            {
                deliveryQuest = candidate;
                break;
            }
            if (npc.IsVillager
                && string.Equals(npc.Name, candidate.target.Value, StringComparison.Ordinal)
                && string.Equals(offered.QualifiedItemId, candidate.ItemId.Value, StringComparison.Ordinal))
                undersuppliedQuest ??= candidate;
        }

        if (deliveryQuest is null && undersuppliedQuest is not null)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "quest_quantity_mismatch",
                GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore)
                + $";quest_id={undersuppliedQuest.id.Value};quest_target={undersuppliedQuest.target.Value};quest_item={undersuppliedQuest.ItemId.Value};quest_number={undersuppliedQuest.number.Value};quest_required_stack={undersuppliedQuest.number.Value};stack_after={stackBefore};completed_quests_before={completedQuestsBefore};completed_quests_after={completedQuestsBefore};quest_completed_after=false");
        }

        if (deliveryQuest is not null)
        {
            int requiredNumber = deliveryQuest.number.Value;
            int friendshipAmount = deliveryQuest.dailyQuest.Value ? 150 : 255;
            bool questCompletedBefore = deliveryQuest.completed.Value;
            bool deliveryCompleted = false;
            int previousToolIndex = player.CurrentToolIndex;
            try
            {
                // Native non-probe delivery body (ItemDeliveryQuest.cs:503-515)
                // minus its two UI-mounting lines (:505 dialogue push and :506
                // dialogue-box draw), which would mount a modal the headless
                // companion has no one to dismiss; the RNG-gated NPC emote the
                // caller adds for this branch (NPC.cs:1781-1784) is a cosmetic
                // animation with no observable product effect.
                player.CurrentToolIndex = slot;
                player.Items.Reduce(offered, requiredNumber);
                deliveryQuest.reloadDescription();
                player.changeFriendship(friendshipAmount, npc);
                deliveryQuest.questComplete();
                player.completelyStopAnimatingOrDoingAction();
                deliveryCompleted = deliveryQuest.completed.Value;
            }
            catch (Exception)
            {
                return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "quest_delivery_postcondition_unavailable",
                    GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore)
                    + $";quest_id={deliveryQuest.id.Value};quest_target={deliveryQuest.target.Value};quest_item={deliveryQuest.ItemId.Value};quest_number={requiredNumber};completed_quests_before={completedQuestsBefore}");
            }
            finally
            {
                player.CurrentToolIndex = previousToolIndex;
            }

            int deliveryStackAfter = slot < player.Items.Count
                && player.Items[slot] is StardewValley.Object remainingDelivery
                && string.Equals(remainingDelivery.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
                ? remainingDelivery.Stack
                : 0;
            bool consumedRequiredNumber = deliveryStackAfter == stackBefore - requiredNumber;
            int pointsAfter = player.friendshipData.TryGetValue(npc.Name, out Friendship? deliveredFriendship) ? deliveredFriendship.Points : -1;
            int completedQuestsAfter = player.questLog.Count(quest => quest.completed.Value);
            // questComplete keeps a rewarded quest in the log and only flips its
            // completed flag (Quest.decompiled.cs:622-629), so the receipt proves
            // completion from the quest object itself, not from log membership.
            bool questStaysInLog = deliveryQuest.moneyReward.Value > 0
                || (deliveryQuest.rewardDescription.Value is not null && deliveryQuest.rewardDescription.Value.Length > 2);
            // This branch reproduces the native non-probe delivery body without
            // the two lines that mount UI, so a modal that is nonetheless up
            // after the mutation means the delivery did not run through this body
            // and the outcome is not attributable.
            bool noModalMounted = Game1.activeClickableMenu is null && !Game1.dialogueUp;
            string deliveryEvidence = GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore)
                + $";quest_id={deliveryQuest.id.Value};quest_target={deliveryQuest.target.Value};quest_item={deliveryQuest.ItemId.Value};quest_number={requiredNumber};quest_daily={deliveryQuest.dailyQuest.Value.ToString().ToLowerInvariant()};quest_completed_before={questCompletedBefore.ToString().ToLowerInvariant()};quest_completed_after={deliveryCompleted.ToString().ToLowerInvariant()};quest_stays_in_log={questStaysInLog.ToString().ToLowerInvariant()};completed_quests_before={completedQuestsBefore};completed_quests_after={completedQuestsAfter};stack_after={deliveryStackAfter};points_after={pointsAfter};friendship_amount={friendshipAmount};quest_25_completed_after={player.questLog.Any(quest => quest.id.Value == "25" && quest.completed.Value).ToString().ToLowerInvariant()};showed_response=false;dialogue_open_after={Game1.dialogueUp.ToString().ToLowerInvariant()};menu_open_after={(Game1.activeClickableMenu is not null).ToString().ToLowerInvariant()}";

            if (deliveryCompleted && consumedRequiredNumber && noModalMounted)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "quest_item_delivered", deliveryEvidence);
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "quest_delivery_postcondition_unavailable", deliveryEvidence);
        }

        // Gate 0: proposal items never enter the gift path. Mirrors the native
        // mermaid-pendant case (NPC.cs:2209) and the propose_roommate context tag
        // (NPC.cs:2282); both would mount dialogue/romance flows.
        if (string.Equals(offered.QualifiedItemId, "(O)460", StringComparison.Ordinal)
            || (npc.CanReceiveGifts() && offered.HasContextTag(ItemContextTagManager.SanitizeContextTag("propose_roommate_" + npc.Name))))
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_proposal_item", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore));
        }

        // Gates 1-3 (NPC.cs:1943/2297-2298): can-receive, can-be-given, not_giftable.
        if (!npc.CanReceiveGifts())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_cannot_receive", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore));
        if (!offered.canBeGivenAsGift() || ItemContextTagManager.HasBaseTag(offered.QualifiedItemId, "not_giftable"))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_not_giftable", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore));

        // Dumped refusal (NPC.cs:2300-2310): native refuses with an emote and
        // never reaches the gift path; the Mod settles the same refusal as a
        // receipt without the emote.
        if (player.activeDialogueEvents.Keys.Any(activeKey => activeKey.Contains("dumped") && npc.Dialogue.ContainsKey(activeKey)))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_dumped", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore));

        // Introduction quest (NPC.cs:2313): completed for any giftable offer,
        // before the limit gates -- exactly the native position.
        player.completeQuest("25");
        bool quest25CompletedAfter = player.questLog.Any(quest => quest.id.Value == "25" && quest.completed.Value);

        // Green-rain refusal (NPC.cs:2315-2322): native returns unhandled with a
        // red message; the Mod settles the same refusal without the message.
        if (Game1.IsGreenRainingHere() && Game1.year == 1 && !npc.isMarried())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "npc_interaction_not_handled", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore) + $";quest_25_completed_after={quest25CompletedAfter.ToString().ToLowerInvariant()}");

        // Weekly allowance gate (NPC.cs:2323).
        bool limitAllowsGift = (friendship != null && friendship.GiftsThisWeek < 2)
            || player.spouse == npc.Name
            || npc is Child
            || npc.isBirthday()
            || offered.QualifiedItemId == "(O)StardropTea";
        if (!limitAllowsGift)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_weekly_limit", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore) + $";quest_25_completed_after={quest25CompletedAfter.ToString().ToLowerInvariant()}");

        // Dictionary protection (NPC.cs:2327-2329) exactly before any friendship
        // mutation: without it receiveGift's `giver.friendshipData[base.Name].
        // GiftsToday++` (NPC.cs:4796) throws KeyNotFoundException when the
        // companion never interacted with this NPC before.
        if (friendship is null)
            friendship = player.friendshipData[npc.Name] = new Friendship();
        if (friendship.IsDivorced())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_divorced", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore) + $";quest_25_completed_after={quest25CompletedAfter.ToString().ToLowerInvariant()}");
        if (friendship.GiftsToday == 1 && offered.QualifiedItemId != "(O)StardropTea")
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_daily_limit", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore) + $";quest_25_completed_after={quest25CompletedAfter.ToString().ToLowerInvariant()}");

        // Native accept sequence (NPC.cs:2342-2345), showResponse: false so no
        // dialogue is mounted (NPC.cs:4766 signature, :4844 gate).
        bool updateGiftLimitInfo = offered.QualifiedItemId != "(O)StardropTea";
        bool giftGiven = false;
        bool spouseJealousy = false;
        int spousePointsBefore = -1;
        int spousePointsAfter = -1;
        int previousSlot = player.CurrentToolIndex;
        try
        {
            player.CurrentToolIndex = slot;
            npc.receiveGift(offered, player, updateGiftLimitInfo, 1f, showResponse: false);
            player.reduceActiveItemByOne();
            player.completelyStopAnimatingOrDoingAction();
            npc.faceTowardFarmerForPeriod(4000, 3, faceAway: false, player);
            // Spouse jealousy (NPC.cs:2346-2356), reproduced verbatim: gated by
            // GameStateQuery.CheckConditions and content-driven
            // SpouseGiftJealousyFriendshipChange (no hardcoded value beyond the
            // native `?? -30` fallback); the native branch queues dialogue on the
            // spouse only, so no modal is mounted.
            if (npc.datable.Value
                && player.spouse != null && player.spouse != npc.Name
                && !player.hasCurrentOrPendingRoommate()
                && Utility.isMale(player.spouse) == Utility.isMale(npc.Name)
                && Game1.random.NextDouble() < 0.3 - (double)((float)player.LuckLevel / 100f) - player.DailyLuck
                && !npc.isBirthday()
                && friendship.IsDating())
            {
                StardewValley.NPC? spouse = Game1.getCharacterFromName(player.spouse);
                var spouseData = spouse?.GetData();
                if (spouse is not null && GameStateQuery.CheckConditions(spouseData?.SpouseGiftJealousy, null, player, offered))
                {
                    spousePointsBefore = player.friendshipData.TryGetValue(spouse.Name, out Friendship? spouseFriendshipBefore) ? spouseFriendshipBefore.Points : -1;
                    player.changeFriendship(spouseData?.SpouseGiftJealousyFriendshipChange ?? -30, spouse);
                    spousePointsAfter = player.friendshipData.TryGetValue(spouse.Name, out Friendship? spouseFriendshipAfter) ? spouseFriendshipAfter.Points : -1;
                    spouse.CurrentDialogue.Clear();
                    spouse.CurrentDialogue.Push(spouse.TryGetDialogue("SpouseGiftJealous", npc.displayName, offered.DisplayName) ?? Dialogue.FromTranslation(spouse, "Strings\\StringsFromCSFiles:NPC.cs.3985", npc.displayName));
                    spouseJealousy = true;
                }
            }
            giftGiven = true;
        }
        catch (Exception)
        {
            // Never fabricate success: an exception after a partial native
            // mutation settles as Uncertain so recovery stays receipt-driven
            // (no blind re-execution of an unknown native side effect).
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "gift_postcondition_unavailable", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore));
        }
        finally
        {
            player.CurrentToolIndex = previousSlot;
        }

        int stackAfter = slot < player.Items.Count && player.Items[slot] is StardewValley.Object remaining && string.Equals(remaining.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
            ? remaining.Stack
            : 0;
        bool consumedExactlyOne = stackAfter == stackBefore - 1;
        Friendship friendshipAfter = player.friendshipData.TryGetValue(npc.Name, out Friendship? afterFriendship) ? afterFriendship : friendship;
        bool giftRecorded = friendshipAfter.GiftsToday > giftsTodayBefore || friendshipAfter.GiftsThisWeek > giftsThisWeekBefore;
        bool pointsChanged = friendshipAfter.Points != pointsBefore;
        string evidence = GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore)
            + $";stack_after={stackAfter};points_after={friendshipAfter.Points};gifts_today_after={friendshipAfter.GiftsToday};gifts_this_week_after={friendshipAfter.GiftsThisWeek};quest_25_completed_after={quest25CompletedAfter.ToString().ToLowerInvariant()};update_gift_limit={updateGiftLimitInfo.ToString().ToLowerInvariant()};showed_response=false;gift_recorded={giftRecorded.ToString().ToLowerInvariant()};points_changed={pointsChanged.ToString().ToLowerInvariant()};spouse_jealousy={spouseJealousy.ToString().ToLowerInvariant()};spouse_points_before={spousePointsBefore};spouse_points_after={spousePointsAfter};menu_open_after={(Game1.activeClickableMenu is not null).ToString().ToLowerInvariant()};dialogue_open_after={Game1.dialogueUp.ToString().ToLowerInvariant()}";

        if (giftGiven && consumedExactlyOne && (giftRecorded || pointsChanged))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "gift_given", evidence);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "gift_postcondition_unavailable", evidence);
    }

    private static string GiftEvidencePrefix(StardewValley.GameLocation location, string expectedTargetId, int targetX, int targetY, StardewValley.NPC npc, string expectedQualifiedItemId, int slot, int stackBefore, int pointsBefore, int giftsTodayBefore, int giftsThisWeekBefore, bool quest25CompletedBefore)
        => $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};npc={npc.Name};item={expectedQualifiedItemId};slot={slot};stack_before={stackBefore};points_before={pointsBefore};gifts_today_before={giftsTodayBefore};gifts_this_week_before={giftsThisWeekBefore};quest_25_completed_before={quest25CompletedBefore.ToString().ToLowerInvariant()}";

    /// <summary>One native Axe strike which fells the exact mature health-one tree into its native stump state; drops remain separate pickup targets.</summary>
}
