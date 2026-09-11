using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// One-way, machine-readable development contract export for a single action.
/// Identity is derived from the Mod-owned catalog. Public semantic arguments and
/// terminal vocabulary are explicit, versioned Core-owned development-contract
/// definitions: they are not inferred from a native handler or execution wire.
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
    IReadOnlyList<string> ToolAllowedValues
);

public sealed record ActionDevelopmentContractTerminal(
    IReadOnlyList<string> AcceptableStates,
    IReadOnlyList<string> SuccessReasonCodes,
    IReadOnlyList<string> EvidenceFields,
    string EvidenceRelation
);

/// <summary>
/// Derives a one-way development contract from game-owned catalog facts plus the
/// explicit Core-owned development-contract definition. No production code
/// consumes the output.
/// </summary>
public static class FarmhandActionDevelopmentContract
{
    public const string Schema = "gamebuddy-action-development-contract/v2";
    public const string GameId = "stardew";

    private static readonly ReadOnlyCollection<string> EquipToolAcceptableStates =
        Array.AsReadOnly(new[] { "succeeded", "uncertain" });
    private static readonly ReadOnlyCollection<string> EquipToolAllowedValues =
        Array.AsReadOnly(new[]
        {
            "axe",
            "pickaxe",
            "hoe",
            "watering_can",
            "fishing_rod",
            "weapon",
            "scythe",
            "shears",
            "milk_pail",
            "pan",
        });
    private static readonly ReadOnlyCollection<string> EquipToolSuccessReasonCodes =
        Array.AsReadOnly(new[] { "tool_equipped", "already_equipped" });
    private static readonly ReadOnlyCollection<string> EquipToolEvidenceFields =
        Array.AsReadOnly(new[] { "tool", "before", "expected", "after" });

    public static ActionDevelopmentContract DeriveContract(string actionId)
    {
        if (string.IsNullOrWhiteSpace(actionId))
            throw new ArgumentException("Action ID is required.", nameof(actionId));

        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(candidate => string.Equals(candidate.ActionId, actionId, StringComparison.Ordinal))
            ?? throw new KeyNotFoundException($"Unknown action: {actionId}");

        ActionDevelopmentContractArgs args = DeriveArgs(actionId);
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

    private static ActionDevelopmentContractArgs DeriveArgs(string actionId) => actionId switch
    {
        "equip_tool" => new ActionDevelopmentContractArgs(new[] { "tool" }, EquipToolAllowedValues),
        _ => throw new KeyNotFoundException($"Action {actionId} has no semantic argument contract."),
    };

    private static ActionDevelopmentContractTerminal DeriveTerminal(string actionId) => actionId switch
    {
        // This is deliberately an explicit Core-owned development-contract
        // definition. It describes the deterministic check boundary; it does
        // not assert that a native handler has produced live evidence.
        "equip_tool" => new ActionDevelopmentContractTerminal(
            EquipToolAcceptableStates,
            EquipToolSuccessReasonCodes,
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