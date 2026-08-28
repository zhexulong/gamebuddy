using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Serialization;
using GameBuddy.Stardew.Core.Protocol;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// One-way, machine-readable development contract export for a single action.
/// Identity is derived from the Mod-owned catalog and wire property names from
/// the bridge protocol. Terminal vocabulary is an explicit, versioned Core-owned
/// development-contract definition: it is not inferred from a native handler.
/// The game-project action-development package consumes the output; no Mod,
/// Host, bridge, router, or policy component reads it as an input.
/// </summary>
public sealed record ActionDevelopmentContract(
    string Schema,
    string GameId,
    string ActionId,
    string FamilyId,
    int IdentityVersion,
    string Lifecycle,
    string Kind,
    ActionDevelopmentContractArgs Args,
    ActionDevelopmentContractTerminal Terminal
);

public sealed record ActionDevelopmentContractArgs(
    string[] RequiredProperties,
    int? SlotMinimum,
    int? SlotMaximum
);

public sealed record ActionDevelopmentContractTerminal(
    IReadOnlyList<string> AcceptableStates,
    string SuccessReasonCode,
    IReadOnlyList<string> EvidenceFields,
    string EvidenceRelation
);

/// <summary>
/// Derives a one-way development contract from game-owned catalog and protocol
/// facts plus the explicit Core-owned development-contract definition. No
/// production code consumes the output.
/// </summary>
public static class FarmhandActionDevelopmentContract
{
    public const string Schema = "gamebuddy-action-development-contract/v1";
    public const string GameId = "stardew";

    private static readonly ReadOnlyCollection<string> EquipToolAcceptableStates =
        Array.AsReadOnly(new[] { "succeeded", "uncertain" });
    private static readonly ReadOnlyCollection<string> EquipToolEvidenceFields =
        Array.AsReadOnly(new[] { "slot", "before", "expected", "after" });

    public static ActionDevelopmentContract DeriveContract(string actionId)
    {
        if (string.IsNullOrWhiteSpace(actionId))
            throw new ArgumentException("Action ID is required.", nameof(actionId));

        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(candidate => string.Equals(candidate.ActionId, actionId, StringComparison.Ordinal))
            ?? throw new KeyNotFoundException($"Unknown action: {actionId}");

        string[]? argsProperties = BridgeProtocol.ExecutionArgumentProperties(actionId)
            ?? throw new KeyNotFoundException($"Action {actionId} has no wire args.");

        ActionDevelopmentContractArgs args = DeriveArgs(actionId, argsProperties);
        ActionDevelopmentContractTerminal terminal = DeriveTerminal(actionId);

        return new ActionDevelopmentContract(
            Schema,
            GameId,
            actionId,
            registration.FamilyId,
            registration.IdentityVersion,
            registration.Lifecycle.ToWireValue(),
            registration.Kind.ToWireValue(),
            args,
            terminal
        );
    }

    private static ActionDevelopmentContractArgs DeriveArgs(string actionId, string[] requiredProperties)
    {
        if (actionId == "equip_tool")
        {
            if (requiredProperties.Length != 1 || requiredProperties[0] != "slot")
                throw new InvalidOperationException("equip_tool wire args contract changed.");
            return new ActionDevelopmentContractArgs(requiredProperties, 0, 36);
        }

        // Generic fallback for known actions: no slot bounds.
        return new ActionDevelopmentContractArgs(requiredProperties, null, null);
    }

    private static ActionDevelopmentContractTerminal DeriveTerminal(string actionId) => actionId switch
    {
        // This is deliberately an explicit Core-owned development-contract
        // definition. It describes the deterministic check boundary; it does
        // not assert that a native handler has produced live evidence.
        "equip_tool" => new ActionDevelopmentContractTerminal(
            EquipToolAcceptableStates,
            "tool_selected",
            EquipToolEvidenceFields,
            "after_equals_expected"),
        _ => throw new KeyNotFoundException($"Action {actionId} has no terminal evidence contract."),
    };

    private static readonly JsonSerializerOptions ExportOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    /// <summary>
    /// Serializes the contract to JSON for the action-development package.
    /// </summary>
    public static string SerializeToJson(ActionDevelopmentContract contract)
    {
        return JsonSerializer.Serialize(contract, ExportOptions).Replace("\r\n", "\n", StringComparison.Ordinal);
    }
}