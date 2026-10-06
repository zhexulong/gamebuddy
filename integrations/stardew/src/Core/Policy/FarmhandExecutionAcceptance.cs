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
        bool qualifiedItem = args.ExpectedQualifiedItemId is not null;
        bool target = args.ExpectedTargetId is not null;
        bool sceneTarget = args.SceneTarget is not null;
        bool destination = args.Destination is not null;
        bool emote = args.Emote is not null;
        bool direction = args.Direction is not null;
        bool tool = args.Tool is not null;
        bool responseKey = args.ResponseKey is not null;
        bool quantity = args.Quantity.HasValue;
        return x == HasArgument(descriptor, "x")
            && y == HasArgument(descriptor, "y")
            && slot == HasArgument(descriptor, "slot")
            && qualifiedItem == HasArgument(descriptor, "expectedQualifiedItemId")
            && target == HasArgument(descriptor, "expectedTargetId")
            && sceneTarget == (descriptor.SceneTarget is not null)
            && destination == HasArgument(descriptor, "destination")
            && emote == HasArgument(descriptor, "emote")
            && direction == HasArgument(descriptor, "direction")
            && tool == HasArgument(descriptor, "tool")
            && responseKey == HasArgument(descriptor, "responseKey")
            && quantity == HasArgument(descriptor, "quantity");
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
        "expectedQualifiedItemId" => facts.ExactExpectedQualifiedItemId is { } exact
            ? string.Equals(args.ExpectedQualifiedItemId, exact, StringComparison.Ordinal)
            : args.ExpectedQualifiedItemId is { Length: > 0 } qualifiedItem
                && qualifiedItem.Length <= facts.MaximumQualifiedItemIdLength,
        "expectedTargetId" => BridgeProtocol.IsOpaqueId(args.ExpectedTargetId),
        "destination" => destinationValidator is { } validator && validator(args.Destination),
        "emote" => !string.IsNullOrWhiteSpace(args.Emote) && argument.Enum is { } emoteEnum
            && emoteEnum.Any(value => string.Equals(value, args.Emote, StringComparison.Ordinal)),
        "direction" => !string.IsNullOrWhiteSpace(args.Direction) && argument.Enum is { } directionEnum
            && directionEnum.Any(value => string.Equals(value, args.Direction, StringComparison.Ordinal)),
        "tool" => !string.IsNullOrWhiteSpace(args.Tool) && argument.Enum is { } toolEnum
            && toolEnum.Any(value => string.Equals(value, args.Tool, StringComparison.Ordinal)),
        "responseKey" => !string.IsNullOrWhiteSpace(args.ResponseKey) && args.ResponseKey.Length <= 128,
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