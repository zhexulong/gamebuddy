using System.Text.Json;
using System.Text.Json.Serialization;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.Protocol;

/// <summary>
/// Transport-neutral wire serialization and framing protocol.
/// Matches host protocol and schema in protocol/bridge-v1.schema.json.
/// </summary>
public static class BridgeProtocol
{
    public const int Version = 1;
    public const int MaximumMessageBytes = 16 * 1024;

    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static bool TrySerialize<T>(T value, out string json, out string reasonCode)
    {
        if (value is BridgeNavigationReadResult navigationResult && !IsValidNavigationReadResult(navigationResult))
        {
            json = string.Empty;
            reasonCode = "invalid_navigation_read_result";
            return false;
        }
        try
        {
            json = JsonSerializer.Serialize(value, JsonOptions);
            if (System.Text.Encoding.UTF8.GetByteCount(json) > MaximumMessageBytes)
            {
                json = string.Empty;
                reasonCode = "message_too_large";
                return false;
            }

            reasonCode = "accepted";
            return true;
        }
        catch (JsonException)
        {
            json = string.Empty;
            reasonCode = "message_not_serializable";
            return false;
        }
    }

    public static bool IsOpaqueId(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or '-');

    public static bool IsReasonCode(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or ':' or '-');

    private static bool IsValidNavigationReadResult(BridgeNavigationReadResult result)
    {
        if (result.Status == "succeeded")
        {
            return result.Reason == "world_map_observed"
                && result.Entries is not null
                && result.Entries.Count <= 20
                && result.Entries.All(IsValidWorldMapEntry)
                && (result.NextCursor is null || IsNavigationHandle(result.NextCursor, "wc1_"));
        }
        return result.Entries is null
            && result.NextCursor is null
            && result.Status == "blocked"
            && result.Reason is "world_map_node_invalid"
                or "world_map_node_stale"
                or "world_map_node_not_found"
                or "world_map_unavailable"
                or "world_map_cursor_invalid"
                or "world_map_cursor_stale"
                or "world_map_projection_too_large"
                or "world_map_disclosure_budget_exhausted";
    }

    private static bool IsValidWorldMapEntry(BridgeWorldMapEntry entry)
    {
        if (entry.Label.Length is < 1 or > 128
            || entry.ContextLabel is { Length: < 1 or > 128 }
            || (entry.NodeRef is not null && !IsNavigationHandle(entry.NodeRef, "nr1_")))
            return false;
        return entry.Destination is null || IsValidNavigationDestinationSelector(entry.Destination);
    }

    private static bool IsValidNavigationDestinationSelector(BridgeNavigationDestinationSelector selector) =>
        (selector.Kind == "label" && selector.Label is { Length: >= 1 and <= 128 } && selector.Ref is null)
        || (selector.Kind == "ref" && selector.Label is null && IsNavigationHandle(selector.Ref, "dr1_"));

    private static bool IsExactNavigationDestinationSelector(JsonElement destination)
    {
        if (destination.ValueKind != JsonValueKind.Object
            || !destination.TryGetProperty("kind", out JsonElement kind)
            || kind.ValueKind != JsonValueKind.String)
            return false;

        return kind.GetString() switch
        {
            "label" => HasExactProperties(destination, "kind", "label")
                && destination.TryGetProperty("label", out JsonElement label)
                && label.ValueKind == JsonValueKind.String
                && label.GetString() is { Length: >= 1 and <= 128 },
            "ref" => HasExactProperties(destination, "kind", "ref")
                && destination.TryGetProperty("ref", out JsonElement reference)
                && reference.ValueKind == JsonValueKind.String
                && IsNavigationHandle(reference.GetString(), "dr1_"),
            _ => false,
        };
    }

    private static bool IsNavigationHandle(string? value, string prefix)
    {
        if (value is null || !value.StartsWith(prefix, StringComparison.Ordinal) || value.Length != prefix.Length + 22)
            return false;

        string encoded = value[prefix.Length..];
        if (encoded.Any(character => !((character >= 'A' && character <= 'Z')
            || (character >= 'a' && character <= 'z')
            || (character >= '0' && character <= '9')
            || character is '-' or '_')))
            return false;

        Span<byte> bytes = stackalloc byte[16];
        return Convert.TryFromBase64String(encoded.Replace('-', '+').Replace('_', '/') + "==", bytes, out int bytesWritten)
            && bytesWritten == bytes.Length;
    }

    public static bool TryDeserializeInbound<TPayload>(
        string json,
        string expectedType,
        out BridgeEnvelope<TPayload>? envelope,
        out string reasonCode,
        params string[] payloadProperties)
    {
        envelope = null;
        if (!TryReadInboundPayload(json, expectedType, out JsonDocument? document, out JsonElement payload, out reasonCode))
            return false;

        JsonDocument parsedDocument = document ?? throw new InvalidOperationException("Inbound payload parser returned no document.");
        using (parsedDocument)
        {
            if (!HasExactProperties(payload, payloadProperties))
            {
                reasonCode = "invalid_envelope";
                return false;
            }
            try
            {
                envelope = JsonSerializer.Deserialize<BridgeEnvelope<TPayload>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (envelope is null)
                {
                    reasonCode = "invalid_envelope";
                    return false;
                }
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = "invalid_json";
                return false;
            }
        }
    }

    public static bool TryDeserializeExecutionRequest(
        string json,
        out BridgeEnvelope<BridgeExecutionRequest>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryReadInboundPayload(json, "execution_request", out JsonDocument? document, out JsonElement payload, out reasonCode))
            return false;

        JsonDocument parsedDocument = document ?? throw new InvalidOperationException("Inbound execution parser returned no document.");
        using (parsedDocument)
        {
            if (!HasExactProperties(payload, "requestId", "idempotencyKey", "action", "args", "expectedRevision", "deadlineMs")
                || !payload.TryGetProperty("action", out JsonElement action)
                || action.ValueKind != JsonValueKind.String
                || !payload.TryGetProperty("args", out JsonElement args)
                || ExecutionArgumentProperties(action.GetString()) is not { } argumentProperties
                || !HasExactProperties(args, argumentProperties)
                || (action.GetString() == "navigate_to_destination"
                    && (!args.TryGetProperty("destination", out JsonElement destination)
                        || !IsExactNavigationDestinationSelector(destination))))
            {
                reasonCode = "invalid_envelope";
                return false;
            }
            try
            {
                envelope = JsonSerializer.Deserialize<BridgeEnvelope<BridgeExecutionRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (envelope is null)
                {
                    reasonCode = "invalid_envelope";
                    return false;
                }
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = "invalid_json";
                return false;
            }
        }
    }

    public static bool TryDeserializeNavigationReadRequest(
        string json,
        out BridgeEnvelope<BridgeNavigationReadRequest>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryReadInboundPayload(json, "navigation_read_request", out JsonDocument? document, out JsonElement payload, out reasonCode))
            return false;

        JsonDocument parsedDocument = document ?? throw new InvalidOperationException("Inbound navigation-read parser returned no document.");
        using (parsedDocument)
        {
            if (!HasExactProperties(payload, "operation", "args")
                || !payload.TryGetProperty("operation", out JsonElement operation)
                || operation.ValueKind != JsonValueKind.String
                || operation.GetString() != "inspect_world_map"
                || !payload.TryGetProperty("args", out JsonElement args)
                || !IsExactInspectWorldMapArgs(args))
            {
                reasonCode = "invalid_navigation_read_request";
                return false;
            }
            try
            {
                envelope = JsonSerializer.Deserialize<BridgeEnvelope<BridgeNavigationReadRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (envelope is null || envelope.Payload.Args is null)
                {
                    reasonCode = "invalid_navigation_read_request";
                    return false;
                }
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = "invalid_json";
                return false;
            }
        }
    }

    private static bool IsExactInspectWorldMapArgs(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object)
            return false;
        if (HasExactProperties(args))
            return true;
        return (HasExactProperties(args, "nodeRef")
                && args.TryGetProperty("nodeRef", out JsonElement nodeRef)
                && nodeRef.ValueKind == JsonValueKind.String
                && IsOpaqueId(nodeRef.GetString()))
            || (HasExactProperties(args, "cursor")
                && args.TryGetProperty("cursor", out JsonElement cursor)
                && cursor.ValueKind == JsonValueKind.String
                && IsOpaqueId(cursor.GetString()));
    }

    public static bool TryDeserializeExecutionReceiptQuery(
        string json,
        out BridgeEnvelope<BridgeExecutionReceiptQuery>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryReadInboundPayload(json, "execution_receipt_query", out JsonDocument? document, out JsonElement payload, out reasonCode))
            return false;

        JsonDocument parsedDocument = document ?? throw new InvalidOperationException("Inbound execution query parser returned no document.");
        using (parsedDocument)
        {
            if (!HasExactProperties(payload, "requestId", "idempotencyKey")
                || !payload.TryGetProperty("requestId", out JsonElement requestId)
                || requestId.ValueKind != JsonValueKind.String
                || !IsOpaqueId(requestId.GetString())
                || !payload.TryGetProperty("idempotencyKey", out JsonElement idempotencyKey)
                || idempotencyKey.ValueKind != JsonValueKind.String
                || !IsOpaqueId(idempotencyKey.GetString()))
            {
                reasonCode = "invalid_execution_receipt_query";
                return false;
            }
            try
            {
                envelope = JsonSerializer.Deserialize<BridgeEnvelope<BridgeExecutionReceiptQuery>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (envelope is null)
                {
                    reasonCode = "invalid_envelope";
                    return false;
                }
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = "invalid_json";
                return false;
            }
        }
    }

    private static bool TryReadInboundPayload(
        string json,
        string expectedType,
        out JsonDocument? document,
        out JsonElement payload,
        out string reasonCode)
    {
        document = null;
        payload = default;
        try
        {
            document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !HasExactProperties(root, "protocolVersion", "messageId", "correlationId", "timestampMs", "scope", "type", "payload")
                || root.GetProperty("protocolVersion").ValueKind != JsonValueKind.Number
                || !root.GetProperty("protocolVersion").TryGetInt32(out int version)
                || version != Version
                || root.GetProperty("messageId").ValueKind != JsonValueKind.String
                || !IsOpaqueId(root.GetProperty("messageId").GetString())
                || root.GetProperty("correlationId").ValueKind != JsonValueKind.String
                || !IsOpaqueId(root.GetProperty("correlationId").GetString())
                || root.GetProperty("timestampMs").ValueKind != JsonValueKind.Number
                || !root.GetProperty("timestampMs").TryGetInt64(out _)
                || root.GetProperty("type").ValueKind != JsonValueKind.String
                || root.GetProperty("type").GetString() != expectedType
                || !TryReadScope(root.GetProperty("scope"), out _))
            {
                document.Dispose();
                document = null;
                reasonCode = "invalid_envelope";
                return false;
            }
            payload = root.GetProperty("payload");
            reasonCode = "accepted";
            return true;
        }
        catch (JsonException)
        {
            document?.Dispose();
            document = null;
            reasonCode = "invalid_json";
            return false;
        }
        catch (InvalidOperationException)
        {
            document?.Dispose();
            document = null;
            reasonCode = "invalid_envelope";
            return false;
        }
    }

    private static bool TryReadScope(JsonElement value, out BridgeScope? scope)
    {
        scope = null;
        if (!HasExactProperties(value, "integrationId", "saveId", "worldId", "playerId", "companionId")
            || !value.TryGetProperty("integrationId", out JsonElement integrationId)
            || !value.TryGetProperty("saveId", out JsonElement saveId)
            || !value.TryGetProperty("worldId", out JsonElement worldId)
            || !value.TryGetProperty("playerId", out JsonElement playerId)
            || !value.TryGetProperty("companionId", out JsonElement companionId)
            || integrationId.ValueKind != JsonValueKind.String
            || saveId.ValueKind != JsonValueKind.String
            || worldId.ValueKind != JsonValueKind.String
            || playerId.ValueKind != JsonValueKind.String
            || companionId.ValueKind != JsonValueKind.String)
            return false;

        var parsed = new BridgeScope(
            integrationId.GetString()!,
            saveId.GetString()!,
            worldId.GetString()!,
            playerId.GetString()!,
            companionId.GetString()!);
        if (!parsed.IsValid) return false;
        scope = parsed;
        return true;
    }

    private static bool HasExactProperties(JsonElement value, params string[] names)
    {
        if (value.ValueKind != JsonValueKind.Object)
            return false;
        HashSet<string> expected = new(names, StringComparer.Ordinal);
        HashSet<string> actual = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!expected.Contains(property.Name) || !actual.Add(property.Name))
                return false;
        }
        return actual.SetEquals(expected);
    }

    public static string[]? ExecutionArgumentProperties(string? action) => action switch
    {
        "move_to_tile" or "enter_exit" or "travel" or "till_soil" => new[] { "x", "y" },
        "equip_tool" => new[] { "slot" },
        "pickup_forage" or "pickup_item" or "harvest_crop" => new[] { "x", "y", "expectedQualifiedItemId", "expectedTargetId" },
        "water_crop" or "machine_inspect" or "machine_collect_output" or "npc_relationship" or "pet_animal" => new[] { "x", "y", "expectedTargetId" },
        "refill_watering_can" => new[] { "x", "y", "slot", "expectedTargetId" },
        "plant_seed" or "fertilize_tile" or "place_wood_fence" or "place_crab_pot" or "bait_crab_pot" or "machine_load" => new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" },
        "clear_debris" or "collect_animal_product" or "feed_animal" or "chop_tree_source" or "break_rock_source" or "clear_hoedirt" or "dig_artifact_spot" => new[] { "x", "y", "slot", "expectedTargetId" },
        "use_item" => new[] { "slot", "expectedQualifiedItemId" },
        "navigate_to_destination" => new[] { "destination" },
        _ => null,
    };
}
