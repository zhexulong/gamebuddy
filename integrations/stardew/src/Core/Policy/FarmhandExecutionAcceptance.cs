using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// Registry-owned execution-acceptance facts for one registered Farmhand
/// action. Wire value bounds and product facts (for example the exact (O)433
/// coffee-bean input of machine_load) are declared here, on the registration
/// descriptor, so execution acceptance always derives from the single registry
/// instead of a parallel consumer-side chain.
/// </summary>
public sealed record FarmhandExecutionAcceptanceFacts(
    int MaximumTileCoordinate = 1000,
    int MaximumInventorySlot = 36,
    int MaximumQualifiedItemIdLength = 128,
    string? ExactExpectedQualifiedItemId = null);

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
        if (descriptor.SceneTarget is not null && !IsValidSceneBinding(args.SceneTarget))
        { reasonCode = "observation_binding_malformed"; return false; }
        if (!HasExactArgumentShape(descriptor, args))
        { reasonCode = "invalid_execution_request"; return false; }
        FarmhandExecutionAcceptanceFacts facts = descriptor.Acceptance ?? Default;
        foreach (FarmhandActionArgument argument in descriptor.Arguments)
        {
            if (!IsValidArgumentValue(argument, facts, args, destinationValidator))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        reasonCode = "accepted";
        return true;
    }

    /// <summary>
    /// The request must carry exactly the arguments declared by the registered
    /// descriptor (plus the scene binding when the descriptor declares one) and
    /// nothing else. A declared argument missing, or an undeclared argument
    /// present, fails closed.
    /// </summary>
    private static bool HasExactArgumentShape(FarmhandActionDescriptor descriptor, BridgeExecutionArgs args)
    {
        bool x = args.X.HasValue;
    bool y = args.Y.HasValue;
    bool slot = args.Slot.HasValue;
    bool chestId = args.ChestId is not null;
        bool qualifiedItem = args.ExpectedQualifiedItemId is not null;
        bool target = args.ExpectedTargetId is not null;
        bool sceneTarget = args.SceneTarget is not null;
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
        return x == HasArgument(descriptor, "x")
            && y == HasArgument(descriptor, "y")
            && slot == HasArgument(descriptor, "slot")
            && chestId == HasArgument(descriptor, "chestId")
            && qualifiedItem == HasArgument(descriptor, "expectedQualifiedItemId")
            && target == HasArgument(descriptor, "expectedTargetId")
            && sceneTarget == (descriptor.SceneTarget is not null)
            && destination == HasArgument(descriptor, "destination")
            && emote == HasArgument(descriptor, "emote")
            && direction == HasArgument(descriptor, "direction")
            && tool == HasArgument(descriptor, "tool")
            && responseKey == HasArgument(descriptor, "responseKey")
            && quantity == HasArgument(descriptor, "quantity")
            && text == HasArgument(descriptor, "text")
            && buildingType == HasArgument(descriptor, "buildingType")
            && leftSlot == HasArgument(descriptor, "leftSlot")
            && rightSlot == HasArgument(descriptor, "rightSlot")
            && colorSelection == HasArgument(descriptor, "colorSelection")
        && choice == HasArgument(descriptor, "choice")
        && expectedSkill == HasArgument(descriptor, "expectedSkill")
        && expectedLevel == HasArgument(descriptor, "expectedLevel");
    }

    private static bool HasArgument(FarmhandActionDescriptor descriptor, string name) =>
        descriptor.Arguments.Any(argument => string.Equals(argument.Name, name, StringComparison.Ordinal));

    private static bool IsValidArgumentValue(
        FarmhandActionArgument argument,
        FarmhandExecutionAcceptanceFacts facts,
        BridgeExecutionArgs args,
        Func<BridgeNavigationDestinationSelector?, bool>? destinationValidator) => argument.Name switch
    {
        "x" => IsBoundedIntegerCoordinate(args.X, facts.MaximumTileCoordinate),
        "y" => IsBoundedIntegerCoordinate(args.Y, facts.MaximumTileCoordinate),
        "slot" => args.Slot is { } slot && slot >= 0 && slot <= facts.MaximumInventorySlot,
        // A container id is the published opaque identity `BuildContainerTargetId` mints. It is checked
        // with the same grammar as every other opaque id: a caller cannot address a container by naming a
        // tile instead, and the live re-resolution is what decides whether that id still names one.
        "chestId" => BridgeProtocol.IsOpaqueId(args.ChestId),
        "expectedQualifiedItemId" => facts.ExactExpectedQualifiedItemId is { } exact
            ? string.Equals(args.ExpectedQualifiedItemId, exact, StringComparison.Ordinal)
            : args.ExpectedQualifiedItemId is { Length: > 0 } qualifiedItem
                && qualifiedItem.Length <= facts.MaximumQualifiedItemIdLength,
        "expectedTargetId" => BridgeProtocol.IsOpaqueId(args.ExpectedTargetId),
        // One chat line: non-blank, and no longer than the native ingress can carry. The bound is the Mod's own
        // constant (the one the handler enforces), so the two cannot disagree about what a chat line is.
        "buildingType" => args.BuildingType is { Length: > 0 } buildingTypeId
            && buildingTypeId.Length <= 128, // mirrors the Host wire validator (>128 is rejected the same way)
        "leftSlot" => args.LeftSlot is int leftSlotValue && leftSlotValue >= 0 && leftSlotValue <= facts.MaximumInventorySlot,
        "rightSlot" => args.RightSlot is int rightSlotValue && rightSlotValue >= 0 && rightSlotValue <= facts.MaximumInventorySlot,
        // The palette SIZE is the game's own (`DiscreteColorPicker.totalColors`), which lives in the game
        // assembly and not in this policy layer, so this arm refuses a negative index only and the handler
        // names `invalid_color_selection` for anything past the palette.
        "colorSelection" => args.ColorSelection is int colorSelectionValue && colorSelectionValue >= 0,
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
        // same shape emote/direction/tool use); the pair is the BINDING, so both halves are bounded to the values
        // the engine can actually put in `Farmer.newLevels` - skills 0..5 (luck included: its level can be lost and
        // regained) and levels 1..10. A pair outside those bounds is refused here rather than reaching the handler,
        // where it could only be rejected after admitting the request.
        "choice" => !string.IsNullOrWhiteSpace(args.Choice) && argument.Enum is { } choiceEnum
            && choiceEnum.Any(value => string.Equals(value, args.Choice, StringComparison.Ordinal)),
        "expectedSkill" => args.ExpectedSkill is int expectedSkillValue && expectedSkillValue >= 0 && expectedSkillValue <= 5,
        "expectedLevel" => args.ExpectedLevel is int expectedLevelValue && expectedLevelValue >= 1 && expectedLevelValue <= 10,
        // A declared quantity is a positive count. The descriptor decides whether an action
        // takes one; this only bounds it. Mirroring Object.cs: no action may ask for zero or
        // a negative amount, and the ceiling keeps a single request from being absurd.
        "quantity" => args.Quantity is { } quantity && quantity >= 1 && quantity <= 9999,
        _ => false,
    };

    private static bool IsBoundedIntegerCoordinate(float? value, int maximum) =>
        value is { } coordinate
        && float.IsFinite(coordinate)
        && coordinate == MathF.Floor(coordinate)
        && coordinate >= 0f
        && coordinate <= maximum;

    private static bool IsValidSceneBinding(ObservationBindingV1? target) => target is not null
        && BridgeProtocol.IsOpaqueId(target.ObservationId)
        && BridgeProtocol.IsOpaqueId(target.Ref);
}