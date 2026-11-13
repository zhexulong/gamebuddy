using System.Text.Json;
using System.IO;
using System.Text.RegularExpressions;

namespace GameBuddy.WindowsBootstrapGuardian;

internal static class GuardianProtocol
{
    internal const int SchemaVersion = 1;
    private static readonly Regex Opaque = new("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);

    internal static Request Parse(ReadOnlySpan<byte> bytes)
    {
        using var document = JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 8 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw Invalid();
        var operation = RequiredString(root, "operation");
        if (!root.TryGetProperty("schemaVersion", out var schema) || schema.GetInt32() != SchemaVersion) throw Invalid();
        var common = new Correlation(RequiredOpaque(root, "guardianInstanceId"), RequiredPositiveInt(root, "guardianEpoch"), RequiredOpaque(root, "attemptId"));
        var expected = operation switch { "arm_attempt" => new[] { "schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId" }, "launch_role" or "contain_role" => new[] { "schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId", "role" }, "recover_attempt" => new[] { "schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId" }, _ => throw Invalid() };
        RequireExactKeys(root, expected);
        return operation switch
        {
            "launch_role" or "contain_role" => new Request(operation, common, RequiredRole(root, "role"), null),
            "arm_attempt" => new Request(operation, common, null, null),
            "recover_attempt" => new Request(operation, common, null, RequiredOpaque(root, "recoveryInstanceId")),
            _ => throw Invalid(),
        };
    }

    private static string RequiredString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { } text ? text : throw Invalid();

    private static string RequiredOpaque(JsonElement root, string name)
    {
        var value = RequiredString(root, name);
        return Opaque.IsMatch(value) ? value : throw Invalid();
    }

    private static int RequiredPositiveInt(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var value) || !value.TryGetInt32(out var result) || result < 1) throw Invalid();
        return result;
    }

    private static Role RequiredRole(JsonElement root, string name)
    {
        var value = RequiredString(root, name);
        foreach (var pair in RoleNames) if (pair.Value == value) return pair.Key;
        throw Invalid();
    }

    /// <summary>
    /// The one spelling of each role's wire name. Parsing and publishing read it,
    /// so a role cannot be named one way in a command and another in an event.
    /// </summary>
    private static readonly IReadOnlyDictionary<Role, string> RoleNames = new Dictionary<Role, string>
    {
        [Role.PlayerHost] = "player_host",
        [Role.AiClient] = "ai_client",
    };

    internal static string RoleName(Role role) => RoleNames.TryGetValue(role, out var name) ? name : throw Invalid();

    internal static void RequireExactKeys(JsonElement root, params string[] expected)
    {
        var names = root.EnumerateObject().Select(p => p.Name).ToArray();
        if (names.Length != expected.Length || expected.Any(name => !names.Contains(name, StringComparer.Ordinal))) throw Invalid();
    }

    internal static Exception Invalid() => new InvalidDataException("windows_bootstrap_guardian_invalid_request");
    internal static string Response(string result) => $"{{\"schemaVersion\":1,\"result\":\"{result}\"}}\n";

    /// <summary>
    /// The one unsolicited frame this channel carries: a role that ended on its
    /// own, with the native exit code the OS reported for it.
    /// </summary>
    internal static string RoleExit(Role role, uint exitCode) =>
        $"{{\"operation\":\"role_exited\",\"role\":\"{RoleName(role)}\",\"exitCode\":{exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture)}}}\n";

    internal enum Role { PlayerHost, AiClient }
    internal readonly record struct Correlation(string InstanceId, int Epoch, string AttemptId);
    internal sealed record Request(string Operation, Correlation Correlation, Role? Role, string? RecoveryInstanceId);
}
