using System.Text.Json;
using System.Text.Json.Serialization;
using GameBuddy.Stardew.Core.BodyPrograms;
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
        BridgeNavigationReadResult? navigationResult = value switch
        {
            BridgeNavigationReadResult result => result,
            BridgeEnvelope<BridgeNavigationReadResult> envelope => envelope.Payload,
            _ => null,
        };
        if (navigationResult is not null && !IsValidNavigationReadResult(navigationResult))
        {
            json = string.Empty;
            reasonCode = "invalid_navigation_read_result";
            return false;
        }
        if (!IsValidBodyProgramOutboundResult(value))
        {
            json = string.Empty;
            reasonCode = "invalid_body_program_result";
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
        bool noMap = result.Entries is null && result.NextCursor is null;
        bool noSearch = result.Candidates is null && result.Destination is null && result.UnlockState is null;

        return result.Status switch
        {
            "succeeded" => result.Reason == "world_map_observed"
                && result.Entries is { Count: <= 20 }
                && result.Entries.All(IsValidWorldMapEntry)
                && (result.NextCursor is null || IsNavigationHandle(result.NextCursor, "wc1_"))
                && noSearch,
            "resolved" => noMap
                && result.Reason is "exact_current_locale" or "exact_fallback_locale" or "exact_alias"
                && result.Candidates is null
                && result.Destination is not null
                && IsValidNavigationDestinationSelector(result.Destination)
                && result.UnlockState == "unknown",
            "candidates" => noMap
                && result.Reason is "ambiguous_exact" or "fuzzy_match"
                && result.Candidates is { Count: >= 1 and <= 3 }
                && result.Candidates.All(IsValidDestinationSearchCandidate)
                && result.Destination is null
                && result.UnlockState is null,
            "not_found" => noMap && noSearch && result.Reason == "destination_not_found",
            "invalid" => noMap && noSearch && result.Reason == "destination_search_invalid",
            "blocked" => noMap && noSearch && result.Reason is
                "world_map_node_invalid"
                or "world_map_node_stale"
                or "world_map_node_not_found"
                or "world_map_unavailable"
                or "world_map_cursor_invalid"
                or "world_map_cursor_stale"
                or "world_map_projection_too_large"
                or "world_map_disclosure_budget_exhausted"
                or "destination_search_unavailable",
            _ => false,
        };
    }

    private static bool IsValidDestinationSearchCandidate(BridgeDestinationSearchCandidate candidate) =>
        candidate.Label.Length is >= 1 and <= 128
        && candidate.ContextLabel is null or { Length: >= 1 and <= 128 }
        && candidate.UnlockState == "unknown"
        && candidate.Destination.Kind == "ref"
        && candidate.Destination.Label is null
        && candidate.Destination.Ref is null;

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
        || (selector.Kind == "ref" && selector.Label is null
            && (selector.Ref is null || IsNavigationHandle(selector.Ref, "dr1_")));

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
            || character is '-' or '_'))
            || encoded[^1] is not ('A' or 'Q' or 'g' or 'w'))
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

    /// <summary>Decodes the program_verify/program_submit wire candidate and maps binding.nodeId to Core ProducerNodeId.</summary>
    public static bool TryDeserializeBodyProgramCandidateRequest(
        string json,
        string expectedType,
        out BridgeEnvelope<ActionProgramCandidate>? envelope,
        out string reasonCode)
    {
        envelope = null;
        reasonCode = "invalid_body_program_request";
        if (expectedType is not ("program_verify" or "program_submit")
            || !TryReadInboundPayload(json, expectedType, out JsonDocument? document, out JsonElement payload, out reasonCode))
            return false;

        JsonDocument parsedDocument = document ?? throw new InvalidOperationException("Inbound body program parser returned no document.");
        using (parsedDocument)
        {
            if (!TryReadBodyProgramCandidate(payload, out ActionProgramCandidate? candidate) || candidate is null)
            {
                reasonCode = "invalid_body_program_request";
                return false;
            }
            JsonElement root = parsedDocument.RootElement;
            if (!TryReadScope(root.GetProperty("scope"), out BridgeScope? scope) || scope is null)
            {
                reasonCode = "invalid_envelope";
                return false;
            }
            envelope = new BridgeEnvelope<ActionProgramCandidate>(
                Version,
                root.GetProperty("messageId").GetString()!,
                root.GetProperty("correlationId").GetString()!,
                root.GetProperty("timestampMs").GetInt64(),
                scope,
                expectedType,
                candidate);
            reasonCode = "accepted";
            return true;
        }
    }

    public static bool TryDeserializeBodyProgramVerifyRequest(string json, out BridgeEnvelope<ActionProgramCandidate>? envelope, out string reasonCode) =>
        TryDeserializeBodyProgramCandidateRequest(json, "program_verify", out envelope, out reasonCode);

    public static bool TryDeserializeBodyProgramSubmitRequest(string json, out BridgeEnvelope<ActionProgramCandidate>? envelope, out string reasonCode) =>
        TryDeserializeBodyProgramCandidateRequest(json, "program_submit", out envelope, out reasonCode);

    public static bool TryDeserializeBodyProgramVerificationResult(
        string json,
        out BridgeEnvelope<BridgeBodyProgramVerification>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryReadBodyProgramResultEnvelope(json, "program_verify_result", out JsonDocument? document, out JsonElement payload, out reasonCode)
            || !HasExactProperties(payload, "accepted", "catalogRevision", "diagnostics")
            || !TryReadBodyProgramVerification(payload, out BridgeBodyProgramVerification? verification)
            || !IsValidBodyProgramVerification(verification))
        {
            reasonCode = "invalid_body_program_result";
            document?.Dispose();
            return false;
        }
        using (document!)
        {
            JsonElement root = document!.RootElement;
            envelope = new BridgeEnvelope<BridgeBodyProgramVerification>(Version, root.GetProperty("messageId").GetString()!, root.GetProperty("correlationId").GetString()!,
                root.GetProperty("timestampMs").GetInt64(), ReadScope(root.GetProperty("scope")), "program_verify_result", verification!);
            reasonCode = "accepted";
            return true;
        }
    }

    public static bool TryDeserializeBodyProgramSubmitResult(
        string json,
        out BridgeEnvelope<BridgeBodyProgramSubmitResult>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryReadBodyProgramResultEnvelope(json, "program_submit_result", out JsonDocument? document, out JsonElement payload, out reasonCode)
            || !HasExactProperties(payload, "code", "verification", "snapshot")
            || !IsBodyProgramSubmitCode(payload.GetProperty("code"))
            || !TryReadBodyProgramVerification(payload.GetProperty("verification"), out BridgeBodyProgramVerification? verification)
            || !TryReadNullableBodyProgramSnapshot(payload.GetProperty("snapshot"), out BridgeBodyProgramStatusSnapshot? snapshot)
            || !IsValidBodyProgramSubmitResult(new BridgeBodyProgramSubmitResult(payload.GetProperty("code").GetString()!, verification!, snapshot)))
        {
            reasonCode = "invalid_body_program_result";
            document?.Dispose();
            return false;
        }
        using (document!)
        {
            JsonElement root = document!.RootElement;
            envelope = new BridgeEnvelope<BridgeBodyProgramSubmitResult>(Version, root.GetProperty("messageId").GetString()!, root.GetProperty("correlationId").GetString()!,
                root.GetProperty("timestampMs").GetInt64(), ReadScope(root.GetProperty("scope")), "program_submit_result",
                new BridgeBodyProgramSubmitResult(payload.GetProperty("code").GetString()!, verification!, snapshot));
            reasonCode = "accepted";
            return true;
        }
    }

    public static bool TryDeserializeBodyProgramStatusResult(
        string json,
        out BridgeEnvelope<BridgeBodyProgramStatusResult>? envelope,
        out string reasonCode) => TryDeserializeBodyProgramStatusResultCore(json, "program_status_result", out envelope, out reasonCode);

    private static bool TryDeserializeBodyProgramStatusResultCore(string json, string expectedType, out BridgeEnvelope<BridgeBodyProgramStatusResult>? envelope, out string reasonCode)
    {
        envelope = null;
        if (!TryReadBodyProgramResultEnvelope(json, expectedType, out JsonDocument? document, out JsonElement payload, out reasonCode)
            || !HasExactProperties(payload, "code", "snapshot")
            || !IsBodyProgramQueryCode(payload.GetProperty("code"))
            || !TryReadNullableBodyProgramSnapshot(payload.GetProperty("snapshot"), out BridgeBodyProgramStatusSnapshot? snapshot)
            || !IsValidBodyProgramStatusResult(new BridgeBodyProgramStatusResult(payload.GetProperty("code").GetString()!, snapshot)))
        {
            reasonCode = "invalid_body_program_result";
            document?.Dispose();
            return false;
        }
        using (document!)
        {
            JsonElement root = document!.RootElement;
            envelope = new BridgeEnvelope<BridgeBodyProgramStatusResult>(Version, root.GetProperty("messageId").GetString()!, root.GetProperty("correlationId").GetString()!,
                root.GetProperty("timestampMs").GetInt64(), ReadScope(root.GetProperty("scope")), expectedType,
                new BridgeBodyProgramStatusResult(payload.GetProperty("code").GetString()!, snapshot));
            reasonCode = "accepted";
            return true;
        }
    }

    public static bool TryDeserializeBodyProgramEventsResult(string json, out BridgeEnvelope<BridgeBodyProgramEventsResult>? envelope, out string reasonCode)
    {
        envelope = null;
        if (!TryReadBodyProgramResultEnvelope(json, "program_events_result", out JsonDocument? document, out JsonElement payload, out reasonCode)
            || !HasExactProperties(payload, "programId", "code", "events", "nextCursor", "highWater")
            || !ReadOpaqueString(payload.GetProperty("programId"), out string? programId)
            || !IsBodyProgramQueryCode(payload.GetProperty("code"))
            || payload.GetProperty("events").ValueKind != JsonValueKind.Array
            || !payload.GetProperty("events").EnumerateArray().All(IsValidBodyProgramEvent)
            || !payload.GetProperty("nextCursor").TryGetInt64(out long nextCursor)
            || !payload.GetProperty("highWater").TryGetInt64(out long highWater)
            || !IsValidBodyProgramEventsResult(new BridgeBodyProgramEventsResult(programId!, payload.GetProperty("code").GetString()!,
                JsonSerializer.Deserialize<IReadOnlyList<BridgeBodyProgramEvent>>(payload.GetProperty("events"), JsonOptions)!, nextCursor, highWater)))
        {
            reasonCode = "invalid_body_program_result";
            document?.Dispose();
            return false;
        }
        using (document!)
        {
            JsonElement root = document!.RootElement;
            envelope = new BridgeEnvelope<BridgeBodyProgramEventsResult>(Version, root.GetProperty("messageId").GetString()!, root.GetProperty("correlationId").GetString()!,
                root.GetProperty("timestampMs").GetInt64(), ReadScope(root.GetProperty("scope")), "program_events_result",
                new BridgeBodyProgramEventsResult(programId!, payload.GetProperty("code").GetString()!,
                    JsonSerializer.Deserialize<IReadOnlyList<BridgeBodyProgramEvent>>(payload.GetProperty("events"), JsonOptions)!, nextCursor, highWater));
            reasonCode = "accepted";
            return true;
        }
    }

    private static bool TryReadBodyProgramResultEnvelope(string json, string expectedType, out JsonDocument? document, out JsonElement payload, out string reasonCode) =>
        TryReadInboundPayload(json, expectedType, out document, out payload, out reasonCode);

    private static bool TryReadBodyProgramVerification(JsonElement value, out BridgeBodyProgramVerification? verification)
    {
        verification = null;
        if (!HasExactProperties(value, "accepted", "catalogRevision", "diagnostics") || value.GetProperty("accepted").ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || !value.GetProperty("catalogRevision").TryGetInt64(out long revision) || !IsJavaScriptSafeInteger(revision) || value.GetProperty("diagnostics").ValueKind != JsonValueKind.Array
            || !value.GetProperty("diagnostics").EnumerateArray().All(IsValidBodyProgramDiagnostic)) return false;
        verification = JsonSerializer.Deserialize<BridgeBodyProgramVerification>(value.GetRawText(), JsonOptions);
        return verification is not null;
    }

    private static bool TryReadNullableBodyProgramSnapshot(JsonElement value, out BridgeBodyProgramStatusSnapshot? snapshot)
    {
        snapshot = null;
        if (value.ValueKind == JsonValueKind.Null) return true;
        if (!HasExactProperties(value, "programId", "state", "catalogRevision", "stopEpoch", "eventHighWater", "nodes")
            || !ReadOpaqueString(value.GetProperty("programId"), out _)
            || !IsBodyProgramState(value.GetProperty("state"))
|| !value.GetProperty("catalogRevision").TryGetInt64(out long revision) || !IsJavaScriptSafeInteger(revision)
             || !value.GetProperty("stopEpoch").TryGetInt64(out long stopEpoch) || !IsJavaScriptSafeInteger(stopEpoch)
             || !value.GetProperty("eventHighWater").TryGetInt64(out long highWater) || !IsJavaScriptSafeInteger(highWater)
            || value.GetProperty("nodes").ValueKind != JsonValueKind.Array
            || !value.GetProperty("nodes").EnumerateArray().All(IsValidBodyProgramNodeStatus)) return false;
        snapshot = JsonSerializer.Deserialize<BridgeBodyProgramStatusSnapshot>(value.GetRawText(), JsonOptions);
        return snapshot is not null;
    }

    private static bool IsValidBodyProgramOutboundResult<T>(T value) => value switch
    {
        BridgeBodyProgramCandidate result => IsValidBodyProgramCandidate(result),
        BridgeEnvelope<BridgeBodyProgramCandidate> envelope => IsValidBodyProgramCandidateEnvelope(envelope),
        BridgeBodyProgramVerification result => IsValidBodyProgramVerification(result),
        BridgeEnvelope<BridgeBodyProgramVerification> envelope => IsValidBodyProgramOutboundEnvelope(envelope, "program_verify_result", IsValidBodyProgramVerification),
        BridgeBodyProgramSubmitResult result => IsValidBodyProgramSubmitResult(result),
        BridgeEnvelope<BridgeBodyProgramSubmitResult> envelope => IsValidBodyProgramOutboundEnvelope(envelope, "program_submit_result", IsValidBodyProgramSubmitResult),
        BridgeBodyProgramStatusResult result => IsValidBodyProgramStatusResult(result),
        BridgeEnvelope<BridgeBodyProgramStatusResult> envelope => IsValidBodyProgramOutboundEnvelope(envelope, "program_status_result", IsValidBodyProgramStatusResult),
        BridgeBodyProgramEventsResult result => IsValidBodyProgramEventsResult(result),
        BridgeEnvelope<BridgeBodyProgramEventsResult> envelope => IsValidBodyProgramOutboundEnvelope(envelope, "program_events_result", IsValidBodyProgramEventsResult),
        _ => true,
    };

    private static bool IsValidBodyProgramOutboundEnvelope<TPayload>(BridgeEnvelope<TPayload>? envelope, string expectedType, Func<TPayload, bool> isValidPayload) => envelope is not null
        && IsValidEnvelope(envelope.ProtocolVersion, envelope.MessageId, envelope.CorrelationId, envelope.TimestampMs, envelope.Scope, envelope.Type, expectedType)
        && isValidPayload(envelope.Payload);

    private static bool IsValidBodyProgramCandidateEnvelope(BridgeEnvelope<BridgeBodyProgramCandidate>? envelope) => envelope is not null
        && IsValidEnvelope(envelope.ProtocolVersion, envelope.MessageId, envelope.CorrelationId, envelope.TimestampMs, envelope.Scope, envelope.Type, envelope.Type is "program_verify" or "program_submit" ? envelope.Type : "")
        && IsValidBodyProgramCandidate(envelope.Payload);

    private static bool IsValidBodyProgramCandidate(BridgeBodyProgramCandidate? candidate) => candidate is not null
        && BodyProgramValidation.IsIdentifier(candidate.ProgramId)
        && candidate.Nodes is { Count: >= 1 and <= BodyProgramValidation.MaximumNodes }
        && candidate.Nodes.All(node => node is not null
            && BodyProgramValidation.IsIdentifier(node.NodeId)
            && BodyProgramValidation.IsIdentifier(node.ActionId)
            && BodyProgramValidation.IsValidDeadlineMs(node.DeadlineMs)
            && node.Arguments is not null && node.Arguments.Count <= 32
            && node.Arguments.All(argument => IsValidBodyProgramRuntimeArgument(argument.Key, argument.Value))
            && node.DependsOn is not null && node.DependsOn.Count <= 8 && node.DependsOn.All(BodyProgramValidation.IsIdentifier)
            && node.Bindings is not null && node.Bindings.Count <= 4
            && node.Bindings.All(binding => BodyProgramValidation.IsIdentifier(binding.Key)
                && binding.Value is not null && BodyProgramValidation.IsIdentifier(binding.Value.NodeId) && BodyProgramValidation.IsIdentifier(binding.Value.FactName)));

    private static bool IsValidBodyProgramRuntimeArgument(string key, BodyProgramRuntimeValue? value)
    {
        if (!BodyProgramValidation.IsIdentifier(key) || value is null) return false;
        return value.Type switch
        {
            "integer" => BodyProgramValidation.TryDecodeRuntimeValue(value, BodyProgramArgumentKind.Integer, out _),
            "string" => BodyProgramValidation.TryDecodeRuntimeValue(value, BodyProgramArgumentKind.String, out _),
            "boolean" => BodyProgramValidation.TryDecodeRuntimeValue(value, BodyProgramArgumentKind.Boolean, out _),
            "destination_selector" => IsValidBodyProgramSelector(value),
            _ => false,
        };
    }

    private static bool IsValidBodyProgramSelector(BodyProgramRuntimeValue value)
    {
        if (!BodyProgramValidation.TryDecodeRuntimeValue(value, BodyProgramArgumentKind.DestinationSelector, out BodyProgramCanonicalValue? canonical)
            || canonical?.Destination is not { } destination)
            return false;
        return destination.Kind switch
        {
            "label" => destination.Label is { Length: > 0 } label && label == label.TrimStart() && label == label.TrimEnd(),
            "ref" => true,
            _ => false,
        };
    }

    private static bool IsValidBodyProgramVerification(BridgeBodyProgramVerification? result) => result is not null
        && IsJavaScriptSafeInteger(result.CatalogRevision)
        && result.Diagnostics is not null
        && result.Diagnostics.Count <= 64
        && result.Diagnostics.All(diagnostic => IsValidBodyProgramDiagnostic(diagnostic));

    private static bool IsValidBodyProgramSubmitResult(BridgeBodyProgramSubmitResult? result) => result is not null
        && IsBodyProgramSubmitCode(result.Code)
        && IsValidBodyProgramVerification(result.Verification)
        && (result.Code switch
        {
            "accepted" or "idempotent" or "conflict" => result.Verification.Accepted && IsValidBodyProgramStatusSnapshot(result.Snapshot),
            "rejected" or "quarantined" => !result.Verification.Accepted && result.Snapshot is null,
            "persistence_failure" => result.Verification.Accepted && result.Snapshot is null,
            _ => false,
        });

    private static bool IsValidBodyProgramStatusResult(BridgeBodyProgramStatusResult? result) => result is not null
        && IsBodyProgramQueryCode(result.Code)
        && (result.Code == "found" ? IsValidBodyProgramStatusSnapshot(result.Snapshot) : result.Snapshot is null);

    private static bool IsValidBodyProgramEventsResult(BridgeBodyProgramEventsResult? result) => result is not null
        && IsOpaqueId(result.ProgramId)
        && IsBodyProgramQueryCode(result.Code)
        && result.Events is not null
        && result.Events.Count <= 32
        && result.NextCursor >= 0 && result.NextCursor <= BodyProgramValidation.MaximumJavaScriptSafeInteger
        && result.HighWater >= 0 && result.HighWater <= BodyProgramValidation.MaximumJavaScriptSafeInteger
        && result.Events.All(@event => IsValidBodyProgramEvent(@event)
            && @event.ProgramId == result.ProgramId
            && @event.Cursor <= result.HighWater)
        && IsValidBodyProgramEventPage(result.Events, result.NextCursor)
        && (result.Code == "found" || result.Events.Count == 0);

    private static bool IsValidBodyProgramEventPage(IReadOnlyList<BridgeBodyProgramEvent> events, long nextCursor)
    {
        if (events.Count == 0)
            return true;

        long priorCursor = -1;
        foreach (BridgeBodyProgramEvent @event in events)
        {
            if (@event.Cursor <= priorCursor)
                return false;
            priorCursor = @event.Cursor;
        }

        return nextCursor == priorCursor;
    }


    private static bool IsValidBodyProgramStatusSnapshot(BridgeBodyProgramStatusSnapshot? snapshot) => snapshot is not null
        && IsOpaqueId(snapshot.ProgramId)
        && IsBodyProgramState(snapshot.State)
        && IsJavaScriptSafeInteger(snapshot.CatalogRevision)
        && IsJavaScriptSafeInteger(snapshot.StopEpoch)
        && IsJavaScriptSafeInteger(snapshot.EventHighWater)
        && snapshot.Nodes is not null
        && snapshot.Nodes.All(IsValidBodyProgramNodeStatus);

    private static bool IsValidBodyProgramDiagnostic(BridgeBodyProgramDiagnostic? diagnostic) => diagnostic is not null
        && diagnostic.Severity == "error"
        && IsReasonCode(diagnostic.Code)
        && (diagnostic.NodeId is null || IsOpaqueId(diagnostic.NodeId))
        && diagnostic.Path is not null
        && diagnostic.Message is not null;

    private static bool IsValidBodyProgramNodeStatus(BridgeBodyProgramNodeStatus? node) => node is not null
        && IsOpaqueId(node.NodeId)
        && IsBodyProgramNodeState(node.State)
&& IsJavaScriptSafeInteger(node.NodeAttempt)
         && IsJavaScriptSafeInteger(node.AdmissionAttempt);

private static bool IsValidBodyProgramEvent(BridgeBodyProgramEvent? @event) => @event is not null
         && IsJavaScriptSafeInteger(@event.Cursor)
        && IsOpaqueId(@event.ProgramId)
        && IsReasonCode(@event.Kind)
        && IsJavaScriptSafeInteger(@event.CatalogRevision)
        && (@event.NodeId is null || IsOpaqueId(@event.NodeId))
        && (@event.NodeAttempt is null || IsJavaScriptSafeInteger(@event.NodeAttempt.Value));

    private static bool IsJavaScriptSafeInteger(long value) => value is >= 0 and <= BodyProgramValidation.MaximumJavaScriptSafeInteger;

    private static bool IsBodyProgramSubmitCode(string? value) => value is "accepted" or "rejected" or "idempotent" or "conflict" or "persistence_failure" or "quarantined";
    private static bool IsBodyProgramQueryCode(string? value) => value is "found" or "not_found" or "invalid_input";
    private static bool IsBodyProgramState(string? value) => value is "active" or "succeeded" or "failed" or "cancelled" or "recovery_required" or "quarantined";
    private static bool IsBodyProgramNodeState(string? value) => value is "pending" or "awaiting_host_admission" or "host_admitted" or "running" or "succeeded" or "failed" or "cancelled" or "recovery_required" or "rejected";

    private static bool IsValidBodyProgramDiagnostic(JsonElement value) => HasExactProperties(value, "severity", "code", "nodeId", "path", "message")
        && value.GetProperty("severity").ValueKind == JsonValueKind.String && value.GetProperty("severity").GetString() == "error"
        && value.GetProperty("code").ValueKind == JsonValueKind.String && IsReasonCode(value.GetProperty("code").GetString())
        && (value.GetProperty("nodeId").ValueKind == JsonValueKind.Null || ReadOpaqueString(value.GetProperty("nodeId"), out _))
        && value.GetProperty("path").ValueKind == JsonValueKind.String && value.GetProperty("message").ValueKind == JsonValueKind.String;

    private static bool IsValidBodyProgramNodeStatus(JsonElement value) => HasExactProperties(value, "nodeId", "state", "nodeAttempt", "admissionAttempt")
         && ReadOpaqueString(value.GetProperty("nodeId"), out _) && IsBodyProgramNodeState(value.GetProperty("state"))
         && value.GetProperty("nodeAttempt").TryGetInt32(out int attempt) && attempt >= 0 && value.GetProperty("admissionAttempt").TryGetInt32(out int admission) && admission >= 0;

    private static bool IsValidBodyProgramEvent(JsonElement value) => HasExactProperties(value, "cursor", "programId", "kind", "catalogRevision", "nodeId", "nodeAttempt")
        && value.GetProperty("cursor").TryGetInt64(out long cursor) && cursor >= 0 && cursor <= BodyProgramValidation.MaximumJavaScriptSafeInteger && ReadOpaqueString(value.GetProperty("programId"), out _)
        && value.GetProperty("kind").ValueKind == JsonValueKind.String && IsReasonCode(value.GetProperty("kind").GetString())
        && value.GetProperty("catalogRevision").TryGetInt64(out long revision) && IsJavaScriptSafeInteger(revision)
        && (value.GetProperty("nodeId").ValueKind == JsonValueKind.Null || ReadOpaqueString(value.GetProperty("nodeId"), out _))
         && (value.GetProperty("nodeAttempt").ValueKind == JsonValueKind.Null || (value.GetProperty("nodeAttempt").TryGetInt32(out int attempt) && attempt >= 0));

    private static BridgeScope ReadScope(JsonElement value)
    {
        return TryReadScope(value, out BridgeScope? scope) && scope is not null ? scope : throw new InvalidOperationException("Invalid bridge scope.");
    }

    public static BridgeBodyProgramCandidate ProjectBodyProgramCandidate(ActionProgramCandidate candidate) =>
        new(candidate.ProgramId, candidate.Nodes.Select(node => new BridgeBodyProgramCandidateNode(
            node.NodeId, node.ActionId, node.Arguments, node.DependsOn,
            node.Bindings.ToDictionary(pair => pair.Key, pair => new BridgeBodyProgramBinding(pair.Value.ProducerNodeId, pair.Value.FactName), StringComparer.Ordinal),
            node.DeadlineMs)).ToArray());

    public static BridgeBodyProgramVerification ProjectBodyProgramVerification(BodyProgramVerificationReport report) =>
        new(report.Accepted, report.CatalogRevision, report.Diagnostics.Select(ProjectDiagnostic).ToArray());

    private static string ToWireValue(this BodyProgramSubmitCode code) => code switch
    {
        BodyProgramSubmitCode.Accepted => "accepted",
        BodyProgramSubmitCode.Rejected => "rejected",
        BodyProgramSubmitCode.Idempotent => "idempotent",
        BodyProgramSubmitCode.Conflict => "conflict",
        BodyProgramSubmitCode.PersistenceFailure => "persistence_failure",
        BodyProgramSubmitCode.Quarantined => "quarantined",
        _ => throw new ArgumentOutOfRangeException(nameof(code), code, "Unknown Body Program submit code."),
    };

    private static string ToWireValue(this BodyProgramQueryCode code) => code switch
    {
        BodyProgramQueryCode.Found => "found",
        BodyProgramQueryCode.NotFound => "not_found",
        BodyProgramQueryCode.InvalidInput => "invalid_input",
        _ => throw new ArgumentOutOfRangeException(nameof(code), code, "Unknown Body Program query code."),
    };

    private static bool IsBodyProgramSubmitCode(JsonElement value) => value.ValueKind == JsonValueKind.String && IsBodyProgramSubmitCode(value.GetString());

    private static bool IsBodyProgramQueryCode(JsonElement value) => value.ValueKind == JsonValueKind.String && IsBodyProgramQueryCode(value.GetString());

    private static bool IsBodyProgramState(JsonElement value) => value.ValueKind == JsonValueKind.String && IsBodyProgramState(value.GetString());

    private static bool IsBodyProgramNodeState(JsonElement value) => value.ValueKind == JsonValueKind.String && IsBodyProgramNodeState(value.GetString());

    private static string ToWireValue(this BodyProgramState state) => state switch
    {
        BodyProgramState.Active => "active",
        BodyProgramState.Succeeded => "succeeded",
        BodyProgramState.Failed => "failed",
        BodyProgramState.Cancelled => "cancelled",
        BodyProgramState.RecoveryRequired => "recovery_required",
        BodyProgramState.Quarantined => "quarantined",
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, "Unknown Body Program state."),
    };

    private static string ToWireValue(this BodyProgramNodeState state) => state switch
    {
        BodyProgramNodeState.Pending => "pending",
        BodyProgramNodeState.AwaitingHostAdmission => "awaiting_host_admission",
        BodyProgramNodeState.HostAdmitted => "host_admitted",
        BodyProgramNodeState.Running => "running",
        BodyProgramNodeState.Succeeded => "succeeded",
        BodyProgramNodeState.Failed => "failed",
        BodyProgramNodeState.Cancelled => "cancelled",
        BodyProgramNodeState.RecoveryRequired => "recovery_required",
        BodyProgramNodeState.Rejected => "rejected",
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, "Unknown Body Program node state."),
    };

    public static BridgeBodyProgramSubmitResult ProjectBodyProgramSubmitResult(BodyProgramSubmitResult result) =>
        new(result.Code.ToWireValue(), ProjectBodyProgramVerification(result.Verification), result.Snapshot is null ? null : ProjectBodyProgramStatusSnapshot(result.Snapshot));

    public static BridgeBodyProgramStatusResult ProjectBodyProgramStatusResult(BodyProgramStatusResult result) =>
        new(result.Code.ToWireValue(), result.Snapshot is null ? null : ProjectBodyProgramStatusSnapshot(result.Snapshot));

    public static BridgeBodyProgramEventsResult ProjectBodyProgramEventsResult(BodyProgramEventsResult result) =>
        new(result.ProgramId, result.Code.ToWireValue(), result.Events.Select(@event => new BridgeBodyProgramEvent(
            @event.Cursor, @event.ProgramId, @event.Kind, @event.CatalogRevision, @event.NodeId, @event.NodeAttempt)).ToArray(), result.NextCursor, result.HighWater);

    private static BridgeBodyProgramDiagnostic ProjectDiagnostic(BodyProgramDiagnostic diagnostic) =>
        new(diagnostic.Severity == BodyProgramDiagnosticSeverity.Error ? "error" : throw new ArgumentOutOfRangeException(nameof(diagnostic)),
            diagnostic.Code, diagnostic.NodeId, diagnostic.Path, diagnostic.Message);

    private static BridgeBodyProgramStatusSnapshot ProjectBodyProgramStatusSnapshot(BodyProgramStatusSnapshot snapshot) =>
        new(snapshot.ProgramId, snapshot.State.ToWireValue(), snapshot.CatalogRevision, snapshot.StopEpoch, snapshot.EventHighWater,
            snapshot.Nodes.Select(node => new BridgeBodyProgramNodeStatus(node.NodeId, node.State.ToWireValue(), node.NodeAttempt, node.AdmissionAttempt)).ToArray());

    private static bool TryReadBodyProgramCandidate(JsonElement value, out ActionProgramCandidate? candidate)
    {
        candidate = null;
        if (value.ValueKind != JsonValueKind.Object || !HasExactProperties(value, "programId", "nodes")
            || value.GetProperty("programId").ValueKind != JsonValueKind.String
            || !IsOpaqueId(value.GetProperty("programId").GetString())
            || value.GetProperty("nodes").ValueKind != JsonValueKind.Array
            || value.GetProperty("nodes").GetArrayLength() is < 1 or > BodyProgramValidation.MaximumNodes)
            return false;

        List<ActionProgramCandidateNode> nodes = new();
        foreach (JsonElement node in value.GetProperty("nodes").EnumerateArray())
        {
            if (node.ValueKind != JsonValueKind.Object || !HasExactProperties(node, "nodeId", "actionId", "arguments", "dependsOn", "bindings", "deadlineMs")
                || !ReadOpaqueString(node.GetProperty("nodeId"), out string? nodeId)
                || !ReadOpaqueString(node.GetProperty("actionId"), out string? actionId)
                || !node.GetProperty("deadlineMs").TryGetInt64(out long deadlineMs)
                || !BodyProgramValidation.IsValidDeadlineMs(deadlineMs)
                || !TryReadRuntimeArguments(node.GetProperty("arguments"), out IReadOnlyDictionary<string, BodyProgramRuntimeValue>? arguments)
                || !TryReadIdentifierList(node.GetProperty("dependsOn"), 8, out IReadOnlyList<string>? dependsOn)
                || !TryReadBodyProgramBindings(node.GetProperty("bindings"), out IReadOnlyDictionary<string, ActionProgramBinding>? bindings))
                return false;
            nodes.Add(new ActionProgramCandidateNode(nodeId!, actionId!, arguments!, dependsOn!, bindings!, deadlineMs));
        }
        candidate = new ActionProgramCandidate(value.GetProperty("programId").GetString()!, Array.AsReadOnly(nodes.ToArray()));
        return true;
    }

    private static bool TryReadRuntimeArguments(JsonElement value, out IReadOnlyDictionary<string, BodyProgramRuntimeValue>? arguments)
    {
        arguments = null;
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 32) return false;
        Dictionary<string, BodyProgramRuntimeValue> result = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!IsOpaqueId(property.Name) || property.Value.ValueKind != JsonValueKind.Object
                || !property.Value.TryGetProperty("type", out JsonElement type)
                || type.ValueKind != JsonValueKind.String || !IsBoundedString(type.GetString(), 64)) return false;
            string typeValue = type.GetString()!;
            if (typeValue is not ("integer" or "string" or "boolean" or "destination_selector")) return false;
            if (typeValue == "destination_selector")
            {
                if (!HasExactProperties(property.Value, "type", "destination")
                    || !TryReadBodyProgramSelector(property.Value.GetProperty("destination"), out BodyProgramDestinationSelector? selector)) return false;
                if (!result.TryAdd(property.Name, new BodyProgramRuntimeValue(typeValue, null, selector))) return false;
            }
            else
            {
                if (!HasExactProperties(property.Value, "type", "canonicalValue")
                    || property.Value.GetProperty("canonicalValue").ValueKind != JsonValueKind.String
                    || !IsBoundedString(property.Value.GetProperty("canonicalValue").GetString(), 512)) return false;
                string canonicalValue = property.Value.GetProperty("canonicalValue").GetString()!;
                if (typeValue == "integer"
                    && !BodyProgramValidation.TryDecodeRuntimeValue(new BodyProgramRuntimeValue(typeValue, canonicalValue), BodyProgramArgumentKind.Integer, out _)) return false;
                if (!result.TryAdd(property.Name, new BodyProgramRuntimeValue(typeValue, canonicalValue))) return false;
            }
        }
        arguments = new System.Collections.ObjectModel.ReadOnlyDictionary<string, BodyProgramRuntimeValue>(result);
        return true;
    }

    private static bool TryReadBodyProgramSelector(JsonElement value, out BodyProgramDestinationSelector? selector)
    {
        selector = null;
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("kind", out JsonElement kind) || kind.ValueKind != JsonValueKind.String) return false;
        if (kind.GetString() == "label" && HasExactProperties(value, "kind", "label") && ReadPlayerText(value.GetProperty("label"), out string? label))
            selector = new BodyProgramDestinationSelector("label", label, null);
        else if (kind.GetString() == "ref" && HasExactProperties(value, "kind", "ref") && ReadNavigationRef(value.GetProperty("ref"), out string? reference))
            selector = new BodyProgramDestinationSelector("ref", null, reference);
        if (selector is not null && !BodyProgramValidation.IsValidSelector(selector)) selector = null;
        return selector is not null;
    }

    private static bool TryReadIdentifierList(JsonElement value, int maximum, out IReadOnlyList<string>? values)
    {
        values = null;
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() > maximum) return false;
        List<string> result = new();
        foreach (JsonElement item in value.EnumerateArray()) if (!ReadOpaqueString(item, out string? id)) return false; else result.Add(id!);
        values = Array.AsReadOnly(result.ToArray()); return true;
    }

    private static bool TryReadBodyProgramBindings(JsonElement value, out IReadOnlyDictionary<string, ActionProgramBinding>? bindings)
    {
        bindings = null;
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 32) return false;
        Dictionary<string, ActionProgramBinding> result = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!IsOpaqueId(property.Name) || !HasExactProperties(property.Value, "nodeId", "factName")
                || !ReadOpaqueString(property.Value.GetProperty("nodeId"), out string? producerNodeId)
                || !ReadOpaqueString(property.Value.GetProperty("factName"), out string? factName)) return false;
            if (!result.TryAdd(property.Name, new ActionProgramBinding(producerNodeId!, factName!))) return false;
        }
        bindings = new System.Collections.ObjectModel.ReadOnlyDictionary<string, ActionProgramBinding>(result); return true;
    }

    private static bool ReadOpaqueString(JsonElement value, out string? result) { result = value.ValueKind == JsonValueKind.String ? value.GetString() : null; return IsOpaqueId(result); }
    private static bool ReadPlayerText(JsonElement value, out string? result) { result = value.ValueKind == JsonValueKind.String ? value.GetString() : null; return result is { Length: >= 1 and <= 128 } && result.Trim().Length > 0 && result == result.TrimStart() && result == result.TrimEnd() && result.Normalize(System.Text.NormalizationForm.FormC) == result; }
    private static bool ReadNavigationRef(JsonElement value, out string? result) { result = value.ValueKind == JsonValueKind.String ? value.GetString() : null; return result is not null && result.StartsWith("dr1_", StringComparison.Ordinal) && result.Length == 26; }
    private static bool IsBoundedString(string? value, int maximum) => value is not null && value.Length <= maximum;
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
                || !payload.TryGetProperty("args", out JsonElement args)
                || !IsExactNavigationReadArgs(operation.GetString(), args))
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

    private static bool IsExactNavigationReadArgs(string? operation, JsonElement args) => operation switch
    {
        "inspect_world_map" => IsExactInspectWorldMapArgs(args),
        "find_destination" => IsExactFindDestinationArgs(args),
        _ => false,
    };

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

    private static bool IsExactFindDestinationArgs(JsonElement args)
    {
        if (!HasExactProperties(args, "query")
            || !args.TryGetProperty("query", out JsonElement query)
            || query.ValueKind != JsonValueKind.String)
            return false;

        string? value = query.GetString();
        return value is { Length: >= 1 and <= 128 };
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
                || root.GetProperty("messageId").ValueKind != JsonValueKind.String
                || root.GetProperty("correlationId").ValueKind != JsonValueKind.String
                || root.GetProperty("timestampMs").ValueKind != JsonValueKind.Number
                || !root.GetProperty("timestampMs").TryGetInt64(out long timestampMs)
                || root.GetProperty("type").ValueKind != JsonValueKind.String
                || !TryReadScope(root.GetProperty("scope"), out BridgeScope? scope)
                || scope is null
                || !IsValidEnvelope(version, root.GetProperty("messageId").GetString(), root.GetProperty("correlationId").GetString(), timestampMs, scope, root.GetProperty("type").GetString(), expectedType))
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

    private static bool IsValidEnvelope(int protocolVersion, string? messageId, string? correlationId, long timestampMs, BridgeScope? scope, string? type, string expectedType) =>
        protocolVersion == Version
        && IsOpaqueId(messageId)
        && IsOpaqueId(correlationId)
        && IsValidTimestamp(timestampMs)
        && scope is { IsValid: true }
        && type == expectedType;

    // The inbound wire contract accepts every JSON Int64 timestamp; the typed envelope can only hold that same domain.
    private static bool IsValidTimestamp(long timestampMs) => IsJavaScriptSafeInteger(timestampMs);

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
