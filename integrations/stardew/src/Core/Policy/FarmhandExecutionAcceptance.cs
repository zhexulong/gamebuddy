using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// The tool charge ladder's own ends, stated once.
///
/// <para>
/// <c>Tool.tilesAffected</c> increments the argument and then compares it against 1..6, its last case being
/// <c>power &gt;= 6</c> (<c>Tool.cs:915,1062</c>), so the integer a caller may ask for is 0..5. The ceiling that
/// applies to one act is lower than this on most packs: <c>Game1</c> raises <c>toolPower</c> only up to the held
/// tool's <c>upgradeLevel</c> plus the Reaching enchantment (<c>Game1.cs:13032-13051</c>), which lives in the game
/// assembly and is refused by name on the game thread.
/// </para>
/// </summary>
public static class ToolCharge
{
    public const int Minimum = 0;
    public const int Maximum = 5;
}

/// <summary>
/// Registry-owned execution-acceptance facts for one registered Farmhand
/// action. Wire value bounds and product facts (for example the exact (O)322
/// wood fence of place_wood_fence) are declared here, on the registration
/// descriptor, so execution acceptance always derives from the single registry
/// instead of a parallel consumer-side chain.
/// </summary>
public sealed record FarmhandExecutionAcceptanceFacts(
    int MinimumTileCoordinate = 0,
    int MaximumTileCoordinate = 1000,
    int MinimumInventorySlot = 0,
    int MaximumInventorySlot = 36,
    int MaximumQualifiedItemIdLength = 128,
    string? ExactExpectedQualifiedItemId = null,
    // The tool charge ladder's own ends, shared with the wire bound below rather than restated per action.
    int MinimumToolCharge = ToolCharge.Minimum,
    int MaximumToolCharge = ToolCharge.Maximum);

/// <summary>
/// One whole-number argument's declared range. <see cref="Maximum"/> is null for an argument whose ceiling is not the
/// Mod's to state (`colorSelection` indexes a palette the game sizes).
/// </summary>
public readonly record struct FarmhandIntegerArgumentBound(int Minimum, int? Maximum);

/// <summary>One string argument's declared length range, on the same terms as the whole-number bound.</summary>
public readonly record struct FarmhandStringArgumentBound(int Minimum, int Maximum);

/// <summary>
/// WHICH value an argument admits, declared once - the numbers `FarmhandExecutionAcceptance` refuses on and the range the
/// published descriptor carries.
///
/// <para>
/// WHY THIS EXISTS. The bounds already lived here, in the validator's own switch, and the descriptor published none of
/// them: `{type: "integer"}` was the whole of what a consumer outside the game could read for `x`, `y`, `slot` and
/// `charge`. The Host therefore GUESSED - `host/src/game-tools.ts` read its own wire predicates by probing them
/// (`largestAcceptedWholeNumber` doubling and bisecting `isTileCoordinate`), which is a second authority for a number
/// this record already decides, and a wrong one wherever the two disagreed: `travel`/`enter_exit` take a warp SOURCE
/// tile, whose floor is `FarmhandWarpCoordinateRange.MinimumSourceCoordinate` (-1) and not the walk-target 0, so the
/// tool schema refused the one tile an edge exit names while the Mod and the Host's own `warpSourceRow` both accepted it.
/// </para>
///
/// <para>
/// ONE SPELLING. The switch in <see cref="FarmhandExecutionAcceptance.IsValidArgumentValue"/> reads these bounds rather
/// than writing the comparisons again, and both published argument shapes are projected through
/// <see cref="FarmhandActionArgumentPublication"/>, so a number that moves moves in one edit and the refusal, the wire
/// and the artifact cannot disagree.
/// </para>
/// </summary>
public static class FarmhandArgumentBounds
{
    /// <summary>Which skills `Farmer.newLevels` can name: 0..5, luck included (its level can be lost and regained).</summary>
    private const int MinimumExpectedSkill = 0;
    private const int MaximumExpectedSkill = 5;

    /// <summary>The engine's level range for the menu `respond_level_up` is holding.</summary>
    private const int MinimumExpectedLevel = 1;
    private const int MaximumExpectedLevel = 10;

    /// <summary>A declared quantity is a positive count. Mirroring Object.cs: no action may ask for zero or a negative
    /// amount, and the ceiling keeps a single request from being absurd.</summary>
    private const int MinimumQuantity = 1;
    private const int MaximumQuantity = 9999;

    /// <summary>The palette's floor. Its SIZE is the game's own (`DiscreteColorPicker.totalColors`), which lives in the
    /// game assembly and not in this policy layer, so the handler names `invalid_color_selection` for anything past it.
    /// </summary>
    private const int MinimumColorSelection = 0;

    /// <summary>The whole-number range this argument accepts, or null when it is not a bounded whole number.</summary>
    public static FarmhandIntegerArgumentBound? IntegerBound(
        FarmhandActionArgument argument,
        FarmhandExecutionAcceptanceFacts facts) => argument.Name switch
    {
        // A transition's x/y is the warp SOURCE tile and may lie one tile outside the map (`enter_exit` declares the
        // producer's own floor), which is why this range is the descriptor's and not a constant of the argument name.
        "x" or "y" => new(facts.MinimumTileCoordinate, facts.MaximumTileCoordinate),
        "slot" or "leftSlot" or "rightSlot" => new(facts.MinimumInventorySlot, facts.MaximumInventorySlot),
        "charge" => new(facts.MinimumToolCharge, facts.MaximumToolCharge),
        "quantity" => new(MinimumQuantity, MaximumQuantity),
        "expectedSkill" => new(MinimumExpectedSkill, MaximumExpectedSkill),
        "expectedLevel" => new(MinimumExpectedLevel, MaximumExpectedLevel),
        "colorSelection" => new(MinimumColorSelection, null),
        _ => null,
    };

    /// <summary>The length range this argument accepts, or null when its value is not bounded by length.</summary>
    public static FarmhandStringArgumentBound? LengthBound(
        FarmhandActionArgument argument,
        FarmhandExecutionAcceptanceFacts facts) => argument.Name switch
    {
        // The opacity grammar is a length AND a character set; the descriptor states the length half and
        // `BridgeProtocol.IsOpaqueId` stays the whole rule.
        "chestId" or "expectedTargetId" => new(BridgeProtocol.OpaqueIdMinimumLength, BridgeProtocol.OpaqueIdMaximumLength),
        // An exact id is one value, not a range: there is no length to state, and the validator compares the id itself.
        "expectedQualifiedItemId" when facts.ExactExpectedQualifiedItemId is null
            => new(1, facts.MaximumQualifiedItemIdLength),
        _ => null,
    };
}

/// <summary>
/// Registry-derived execution-acceptance projection for Farmhand execution
/// requests. It validates a request against the registered descriptor: exact
/// argument presence, argument value bounds and product facts, enum membership,
/// scene binding shape, and wire destination shape. It fails closed for
/// unknown arguments, unknown shapes, and any value that violates the
/// registry-declared facts, and it precedes (never replaces) the native
/// world/local-player, deadline, ownership, range, and target gates.
/// </summary>
public static class FarmhandExecutionAcceptance
{
    /// <summary>Default bounds for an action that does not declare its own facts.</summary>
    public static FarmhandExecutionAcceptanceFacts Default { get; } = new();

    public static bool TryValidate(
        FarmhandActionDescriptor descriptor,
        BridgeExecutionArgs args,
        out string reasonCode,
        Func<BridgeNavigationDestinationSelector?, bool>? destinationValidator = null)
    {
        reasonCode = "accepted";
        if (args.AdditionalProperties is { Count: > 0 })
        { reasonCode = "invalid_execution_request"; return false; }
        if (!HasExactArgumentShape(descriptor, args))
        { reasonCode = "invalid_execution_request"; return false; }
        FarmhandExecutionAcceptanceFacts facts = descriptor.Acceptance ?? Default;
        foreach (FarmhandActionArgument argument in descriptor.Arguments)
        {
            // AN ARGUMENT THE ROW DECLARES THE BODY RESOLVES IS NOT THE CALLER'S TO SUPPLY, so an absent one is skipped
            // rather than judged: `args.Slot is { }` is false for a slot nobody sent, and the answer to that is not
            // `invalid_execution_request` but nothing at all (the handler's own `tool_not_owned:<word>` is what an
            // unsatisfiable claim answers). A value that IS present is judged exactly as it always was - the omission is
            // legal, a wrong number is not.
            if (argument.ResolvedAtExecution && !CarriesArgument(argument.Name, args))
                continue;
            if (!IsValidArgumentValue(argument, facts, args, destinationValidator))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        reasonCode = "accepted";
        return true;
    }

    /// <summary>
    /// Whether the request carries this argument AT ALL - the question an omission is answered with.
    ///
    /// <para>
    /// SEPARATE FROM <see cref="IsValidArgumentValue"/> ON PURPOSE. That switch answers "is this value legal", and a
    /// missing slot is not an illegal slot: it is an absence, which only <see cref="FarmhandActionArgument.ResolvedAtExecution"/>
    /// may excuse. Reading presence here keeps the two questions apart so a declared omission cannot widen into "any
    /// argument may be absent", and its own `false` arm is what refuses a name this map does not know.
    /// </para>
    /// </summary>
    private static bool CarriesArgument(string name, BridgeExecutionArgs args) => name switch
    {
        "x" => args.X.HasValue,
        "y" => args.Y.HasValue,
        "slot" => args.Slot.HasValue,
        "chestId" => args.ChestId is not null,
        "expectedQualifiedItemId" => args.ExpectedQualifiedItemId is not null,
        "expectedTargetId" => args.ExpectedTargetId is not null,
        "destination" => args.Destination is not null,
        "emote" => args.Emote is not null,
        "direction" => args.Direction is not null,
        "tool" => args.Tool is not null,
        "responseKey" => args.ResponseKey is not null,
        "quantity" => args.Quantity.HasValue,
        "text" => args.Text is not null,
        "buildingType" => args.BuildingType is not null,
        "leftSlot" => args.LeftSlot.HasValue,
        "rightSlot" => args.RightSlot.HasValue,
        "colorSelection" => args.ColorSelection.HasValue,
        "choice" => args.Choice is not null,
        "expectedSkill" => args.ExpectedSkill.HasValue,
        "expectedLevel" => args.ExpectedLevel.HasValue,
        "charge" => args.Charge.HasValue,
        _ => false,
    };

    /// <summary>
    /// The request must carry exactly the arguments declared by the registered
    /// descriptor and nothing else. A declared argument missing, or an undeclared
    /// argument present, fails closed - except for a declared argument the row says
    /// the BODY resolves (<see cref="FarmhandActionArgument.ResolvedAtExecution"/>): that one may be absent, and
    /// `<see langword="false"/> == <see cref="Presents"/>` would refuse exactly the omission the declaration grants.
    /// </summary>
    private static bool HasExactArgumentShape(FarmhandActionDescriptor descriptor, BridgeExecutionArgs args)
    {
        bool x = args.X.HasValue;
    bool y = args.Y.HasValue;
    bool slot = args.Slot.HasValue;
    bool chestId = args.ChestId is not null;
        bool qualifiedItem = args.ExpectedQualifiedItemId is not null;
        bool target = args.ExpectedTargetId is not null;
        bool destination = args.Destination is not null;
        bool emote = args.Emote is not null;
        bool direction = args.Direction is not null;
        bool tool = args.Tool is not null;
        bool responseKey = args.ResponseKey is not null;
        bool quantity = args.Quantity.HasValue;
        bool buildingType = args.BuildingType is not null;
        bool leftSlot = args.LeftSlot is not null;
        bool colorSelection = args.ColorSelection is not null;
        bool rightSlot = args.RightSlot is not null;
    bool text = args.Text is not null;
    bool choice = args.Choice is not null;
    bool expectedSkill = args.ExpectedSkill.HasValue;
    bool expectedLevel = args.ExpectedLevel.HasValue;
    bool charge = args.Charge.HasValue;
        return Presents(descriptor, "x", x)
            && Presents(descriptor, "y", y)
            && Presents(descriptor, "slot", slot)
            && Presents(descriptor, "chestId", chestId)
            && Presents(descriptor, "expectedQualifiedItemId", qualifiedItem)
            && Presents(descriptor, "expectedTargetId", target)
            && Presents(descriptor, "destination", destination)
            && Presents(descriptor, "emote", emote)
            && Presents(descriptor, "direction", direction)
            && Presents(descriptor, "tool", tool)
            && Presents(descriptor, "responseKey", responseKey)
            && Presents(descriptor, "quantity", quantity)
            && Presents(descriptor, "text", text)
            && Presents(descriptor, "buildingType", buildingType)
            && Presents(descriptor, "leftSlot", leftSlot)
            && Presents(descriptor, "rightSlot", rightSlot)
            && Presents(descriptor, "colorSelection", colorSelection)
        && Presents(descriptor, "choice", choice)
        && Presents(descriptor, "expectedSkill", expectedSkill)
        && Presents(descriptor, "expectedLevel", expectedLevel)
        && Presents(descriptor, "charge", charge);
    }

    /// <summary>
    /// Whether the request's presence of <paramref name="name"/> matches what the row asks of it: a declared argument is
    /// present, an undeclared one is absent, and an argument the row declares the body resolves is present ONLY if the
    /// caller sent it.
    /// </summary>
    private static bool Presents(FarmhandActionDescriptor descriptor, string name, bool present)
    {
        FarmhandActionArgument? declared = descriptor.Arguments
            .FirstOrDefault(argument => string.Equals(argument.Name, name, StringComparison.Ordinal));
        if (declared is null) return !present;
        return declared.ResolvedAtExecution || present;
    }

    private static bool IsValidArgumentValue(
        FarmhandActionArgument argument,
        FarmhandExecutionAcceptanceFacts facts,
        BridgeExecutionArgs args,
        Func<BridgeNavigationDestinationSelector?, bool>? destinationValidator) => argument.Name switch
    {
        "x" => IsIntegralInRange(args.X, Bound(argument, facts)),
        "y" => IsIntegralInRange(args.Y, Bound(argument, facts)),
        "slot" => IsWholeInRange(args.Slot, Bound(argument, facts)),
        "leftSlot" => IsWholeInRange(args.LeftSlot, Bound(argument, facts)),
        "rightSlot" => IsWholeInRange(args.RightSlot, Bound(argument, facts)),
        // The ladder's own range; the per-act ceiling (the held tool's upgrade level) is decided on the game thread,
        // where the tool exists, and refused by name there rather than clamped here.
        "charge" => IsWholeInRange(args.Charge, Bound(argument, facts)),
        "colorSelection" => IsWholeInRange(args.ColorSelection, Bound(argument, facts)),
        "expectedSkill" => IsWholeInRange(args.ExpectedSkill, Bound(argument, facts)),
        "expectedLevel" => IsWholeInRange(args.ExpectedLevel, Bound(argument, facts)),
        "quantity" => IsWholeInRange(args.Quantity, Bound(argument, facts)),
        // A container id is the published opaque identity `BuildContainerTargetId` mints. It is checked
        // with the same grammar as every other opaque id: a caller cannot address a container by naming a
        // tile instead, and the live re-resolution is what decides whether that id still names one.
        "chestId" => BridgeProtocol.IsOpaqueId(args.ChestId),
        "expectedTargetId" => BridgeProtocol.IsOpaqueId(args.ExpectedTargetId),
        "expectedQualifiedItemId" => facts.ExactExpectedQualifiedItemId is { } exact
            ? string.Equals(args.ExpectedQualifiedItemId, exact, StringComparison.Ordinal)
            : IsLengthInRange(args.ExpectedQualifiedItemId, Length(argument, facts)),
        // One chat line: non-blank, and no longer than the native ingress can carry. The bound is the Mod's own
        // constant (the one the handler enforces), so the two cannot disagree about what a chat line is.
        "buildingType" => args.BuildingType is { Length: > 0 } buildingTypeId
            && buildingTypeId.Length <= 128, // mirrors the Host wire validator (>128 is rejected the same way)
        "text" => !string.IsNullOrWhiteSpace(args.Text) && args.Text.Length <= FarmhandActionCatalog.ChatMessageMaximumLength,
        "destination" => destinationValidator is { } validator && validator(args.Destination),
        "emote" => !string.IsNullOrWhiteSpace(args.Emote) && argument.Enum is { } emoteEnum
            && emoteEnum.Any(value => string.Equals(value, args.Emote, StringComparison.Ordinal)),
        "direction" => !string.IsNullOrWhiteSpace(args.Direction) && argument.Enum is { } directionEnum
            && directionEnum.Any(value => string.Equals(value, args.Direction, StringComparison.Ordinal)),
        "tool" => !string.IsNullOrWhiteSpace(args.Tool) && argument.Enum is { } toolEnum
            && toolEnum.Any(value => string.Equals(value, args.Tool, StringComparison.Ordinal)),
        "responseKey" => !string.IsNullOrWhiteSpace(args.ResponseKey) && args.ResponseKey.Length <= 128,
        // The level-up response. `choice` is the game's own closed set (the descriptor carries it as an Enum, the
        // same shape emote/direction/tool use); the pair is the BINDING whose range `FarmhandArgumentBounds` states.
        "choice" => !string.IsNullOrWhiteSpace(args.Choice) && argument.Enum is { } choiceEnum
            && choiceEnum.Any(value => string.Equals(value, args.Choice, StringComparison.Ordinal)),
        _ => false,
    };

    /// <summary>This argument's declared whole-number range. An arm above that reads it is one the declaration bounds.</summary>
    private static FarmhandIntegerArgumentBound Bound(
        FarmhandActionArgument argument,
        FarmhandExecutionAcceptanceFacts facts) => FarmhandArgumentBounds.IntegerBound(argument, facts)
        ?? throw new InvalidOperationException($"farmhand_argument_bound_missing:{argument.Name}");

    /// <summary>This argument's declared length range, on the same terms as <see cref="Bound"/>.</summary>
    private static FarmhandStringArgumentBound Length(
        FarmhandActionArgument argument,
        FarmhandExecutionAcceptanceFacts facts) => FarmhandArgumentBounds.LengthBound(argument, facts)
        ?? throw new InvalidOperationException($"farmhand_argument_length_bound_missing:{argument.Name}");

    private static bool IsIntegralInRange(float? value, FarmhandIntegerArgumentBound bound) =>
        value is { } coordinate
        && float.IsFinite(coordinate)
        && coordinate == MathF.Floor(coordinate)
        && coordinate >= bound.Minimum
        && (bound.Maximum is not { } maximum || coordinate <= maximum);

    private static bool IsWholeInRange(int? value, FarmhandIntegerArgumentBound bound) =>
        value is { } whole
        && whole >= bound.Minimum
        && (bound.Maximum is not { } maximum || whole <= maximum);

    private static bool IsLengthInRange(string? value, FarmhandStringArgumentBound bound) =>
        value is { } text && text.Length >= bound.Minimum && text.Length <= bound.Maximum;
}