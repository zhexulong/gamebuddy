using System.Text.Json;

namespace GameBuddy.WindowsStardewBootstrapGuardian;

internal static class Program
{
    private const int ProtocolVersion = 1;
    private const int MaxInputBytes = 64 * 1024;
    private const int MaxGuardianEpoch = int.MaxValue;

    public static int Main()
    {
        try
        {
            using var input = new MemoryStream();
            var buffer = new byte[4096];
            int read;
            while ((read = Console.OpenStandardInput().Read(buffer, 0, buffer.Length)) > 0)
            {
                if (input.Length + read > MaxInputBytes) return Fail();
                input.Write(buffer, 0, read);
            }

            var request = input.ToArray();
            if (request.Length == 0 || request[^1] != (byte)'\n') return Fail();
            // The protocol is one JSON record per invocation: reject embedded
            // line breaks and carriage returns rather than accepting JSON
            // whitespace that would make framing ambiguous.
            if (request[..^1].Contains((byte)'\n') || request[..^1].Contains((byte)'\r')) return Fail();
            using var document = JsonDocument.Parse(request.AsMemory(0, request.Length - 1), new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 8,
            });
            if (!IsSupportedRequest(document.RootElement)) return Fail();

            // Task 1 freezes only the redacted wire grammar. Job creation, role
            // launch, and lease/recovery behavior are deliberately added in Task 2.
            Console.Out.Write("{\"schemaVersion\":1,\"result\":\"kept_unavailable\"}\n");
            return 0;
        }
        catch
        {
            return Fail();
        }
    }

    private static bool IsSupportedRequest(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return false;
        var properties = root.EnumerateObject().ToArray();
        if (properties.Any(property => property.Name is not ("schemaVersion" or "operation" or "guardianInstanceId" or "guardianEpoch" or "attemptId" or "role" or "recoveryInstanceId"))) return false;
        if (properties.Length < 5) return false;
        if (!TryGetUnique(root, "schemaVersion", out var schema) || schema.ValueKind != JsonValueKind.Number || schema.GetInt32() != ProtocolVersion) return false;
        if (!TryGetUnique(root, "operation", out var operation) || operation.ValueKind != JsonValueKind.String) return false;
        if (!TryGetUnique(root, "guardianInstanceId", out var instance) || !IsOpaque(instance)) return false;
        if (!TryGetUnique(root, "guardianEpoch", out var epoch) || epoch.ValueKind != JsonValueKind.Number || !epoch.TryGetInt32(out var epochValue) || epochValue < 1 || epochValue > MaxGuardianEpoch) return false;
        if (!TryGetUnique(root, "attemptId", out var attempt) || !IsOpaque(attempt)) return false;

        var operationValue = operation.GetString();
        var expected = operationValue switch
        {
            "arm_attempt" or "recover_attempt" => 5,
            "launch_role" or "contain_role" => 6,
            "begin_recovery" => 6,
            _ => -1,
        };
        if (expected < 0 || properties.Length != expected) return false;
        if (operationValue is "launch_role" or "contain_role")
        {
            if (!TryGetUnique(root, "role", out var role) || role.ValueKind != JsonValueKind.String || role.GetString() is not ("player_host" or "ai_client")) return false;
        }
        else if (operationValue == "begin_recovery")
        {
            if (!TryGetUnique(root, "recoveryInstanceId", out var recovery) || !IsOpaque(recovery)) return false;
        }
        return true;
    }

    private static bool TryGetUnique(JsonElement root, string name, out JsonElement value)
    {
        value = default;
        var found = false;
        foreach (var property in root.EnumerateObject())
        {
            if (property.Name != name) continue;
            if (found) return false;
            found = true;
            value = property.Value;
        }
        return found;
    }

    private static bool IsOpaque(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String) return false;
        var text = value.GetString();
        return text is not null && System.Text.RegularExpressions.Regex.IsMatch(text, "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    }

    private static int Fail()
    {
        Console.Error.Write("windows_stardew_bootstrap_guardian_invalid_request\n");
        return 1;
    }
}
