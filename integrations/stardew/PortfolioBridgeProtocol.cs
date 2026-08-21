using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

/// <summary>
/// Independent observe-only wire namespace for the single-player Portfolio
/// topology. It intentionally shares only the byte-framed transport with the
/// Farmhand bridge; no Farmhand DTO, capability, receipt, or session is reused.
/// </summary>
internal static class PortfolioBridgeProtocol
{
    internal const int Version = 1;
    internal const string IntegrationId = "stardew_portfolio";
    internal const string Topology = "single_player_native_companion";
    internal const string TargetGameVersion = "1.6.15";
    internal const int TargetGameBuildNumber = 24356;
    internal const int MaximumMessageBytes = 16 * 1024;
    internal const string PipeNamePrefix = "gamebuddy-stardew-portfolio";

    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    internal static bool TrySerialize<T>(T value, out string json, out string reasonCode)
    {
        try
        {
            json = JsonSerializer.Serialize(value, JsonOptions);
            if (Encoding.UTF8.GetByteCount(json) > MaximumMessageBytes)
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

    internal static bool IsOpaqueId(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or '-');

    internal static bool IsToken(string? value) => value is not null && value.Length is >= 16 and <= 256 && IsOpaqueId(value);

    private static readonly HashSet<string> ReasonCodes = new(StringComparer.Ordinal)
    {
        "accepted", "observed", "fresh_observed", "native_sleep_started", "saving", "saved", "day_started",
        "close_requested", "reopened", "terminal", "cancelled", "single_player_sleep_and_advance_day_completed",
        "revision_mismatch", "deadline_expired", "execution_already_active", "adapter_unavailable", "not_armed",
        "execution_not_active", "cancellation_token_mismatch", "cancellation_already_requested", "irreversible_phase_reached", "reopen_observation_invalid",
        "execution_armed", "native_operation_failed", "idempotency_key_reused_with_different_request",
        "portfolio_configuration_invalid", "portfolio_world_not_ready", "portfolio_single_player_required",
        "portfolio_scope_mismatch", "portfolio_binding_invalid", "portfolio_binding_generation_invalid",
        "portfolio_bridge_disconnected", "portfolio_saving", "message_too_large", "message_not_serializable",
        "invalid_portfolio_sleep_day_request", "invalid_portfolio_sleep_day_cancel_request",
        "invalid_portfolio_mine_elevator_request", "invalid_portfolio_mine_elevator_probe_request", "invalid_portfolio_mine_elevator_fresh_floor_request", "invalid_portfolio_mine_elevator_fresh_floor", "invalid_portfolio_mine_elevator_cancel_request",
        "invalid_mine_elevator_request", "invalid_mine_elevator_observation", "mine_observation_invalid",
        "mine_elevator_target_invalid", "mine_elevator_transition_started", "postcondition_observed",
        "postcondition_observation_invalid", "mine_elevator_floor_selected", "native_operation_uncertain",
        "stale_callback_revision", "portfolio_action_not_allowed", "portfolio_mine_elevator_not_armed",
        "invalid_envelope",
        "invalid_json", "stale_or_invalid_timestamp", "authentication_failed", "already_authenticated",
        "unauthenticated", "portfolio_message_type_rejected", "invalid_request", "response_serialization_failed",
        "portfolio_sleep_day_not_armed", "invalid_portfolio_mine_ladder_request", "invalid_portfolio_enter_mine_request", "invalid_portfolio_enter_mine_probe_request", "invalid_portfolio_enter_mine_fresh_floor_request", "invalid_portfolio_enter_mine_cancel_request", "invalid_portfolio_enter_mine_fresh_floor", "invalid_portfolio_enter_mine_receipt", "invalid_portfolio_enter_mine_phase", "invalid_portfolio_enter_mine_probe", "invalid_enter_mine_request", "invalid_enter_mine_observation", "enter_mine_target_invalid", "enter_mine_transition_started", "enter_mine_floor_used", "portfolio_enter_mine_not_armed", "invalid_portfolio_bootstrap_hello", "invalid_portfolio_bootstrap_hello_ack", "portfolio_bootstrap_scope_mismatch", "portfolio_bootstrap_not_allowed", "invalid_portfolio_mine_ladder_probe_request", "invalid_portfolio_mine_ladder_fresh_floor_request", "invalid_portfolio_mine_ladder_cancel_request", "invalid_portfolio_mine_ladder_fresh_floor", "invalid_portfolio_mine_ladder_receipt", "invalid_portfolio_mine_ladder_phase", "invalid_portfolio_mine_ladder_probe", "invalid_mine_ladder_request", "invalid_mine_ladder_observation", "mine_ladder_target_invalid", "mine_ladder_transition_started", "mine_ladder_floor_used", "portfolio_mine_ladder_not_armed",
        "invalid_portfolio_skip_event_request", "invalid_portfolio_skip_event_probe_request", "invalid_portfolio_skip_event_cancel_request", "invalid_portfolio_skip_event_receipt", "invalid_portfolio_skip_event_phase", "invalid_skip_event_request", "invalid_skip_event_observation", "invalid_skip_event_cancel_request", "skip_event_no_active_event", "skip_event_target_invalid", "skip_event_native_skip", "skip_event_completed", "portfolio_skip_event_not_armed"
    };

    internal static bool IsReasonCode(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or ':' or '-')
        && ReasonCodes.Contains(value);

    internal static bool IsSha256(string? value) => value is not null && value.Length == 64 && value.All(character =>
        (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'));

    internal const string SleepDayAction = "single_player_sleep_and_advance_day";
    internal const string MineElevatorAction = "select_mine_elevator_floor";
    internal const string MineLadderAction = "use_mine_ladder";
    internal const string MineEntryAction = "enter_mine";
    internal const string SkipEventAction = "skip_event";
    internal static readonly string[] SkipEventPhases =
    {
        "fresh_observed", "accepted", "native_skip", "postcondition", "terminal",
    };
    internal static bool IsSkipEventPhase(string? value) => value is not null && Array.IndexOf(SkipEventPhases, value) >= 0;
    internal const int MineEntryMinimumFloor = 1;
    internal const int MineEntryMaximumFloor = 1;
    internal const int MineLadderMinimumFloor = 1;
    internal const int MineLadderMaximumFloor = 120;
    internal const int MineElevatorMinimumCheckpoint = 5;
    internal const int MineElevatorMaximumCheckpoint = 120;
    internal static readonly string[] MineElevatorPhases =
    {
        "fresh_observed", "accepted", "transition_started", "postcondition", "terminal",
    };
    internal static readonly string[] SleepDayPhases =
    {
        "fresh_observed", "accepted", "native_sleep_started", "saving", "saved",
        "day_started", "close_requested", "reopened", "terminal",
    };

    internal static bool FixedEquals(string? left, string right) => CryptographicOperations.FixedTimeEquals(
        Encoding.UTF8.GetBytes(left ?? string.Empty),
        Encoding.UTF8.GetBytes(right));

    internal static bool IsSleepDayPhase(string? value) => value is not null && Array.IndexOf(SleepDayPhases, value) >= 0;

    internal static string ComputeBindingHash(string saveId, string worldId, string localPlayerId, string companionId, long generation)
    {
        string canonical = $"{Topology}\n{saveId}\n{worldId}\n{localPlayerId}\n{companionId}\n{TargetGameVersion}\n{TargetGameBuildNumber}\n{generation}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }
    internal static bool IsMineElevatorPhase(string? value) => value is not null && Array.IndexOf(MineElevatorPhases, value) >= 0;
    internal static bool IsMineElevatorPhaseTransition(string? value) => value is not null && Array.IndexOf(MineElevatorPhases, value) >= 0;
    private static readonly HashSet<string> MineElevatorUncertainReasons = new(StringComparer.Ordinal)
    {
        "native_operation_uncertain", "postcondition_observation_invalid", "stale_callback_revision", "portfolio_bridge_disconnected",
    };
    private static readonly HashSet<string> MineElevatorRejectedReasons = new(StringComparer.Ordinal)
    {
        "invalid_mine_elevator_request", "invalid_mine_elevator_observation", "invalid_portfolio_mine_elevator_cancel_request", "invalid_envelope", "revision_mismatch",
        "deadline_expired", "mine_observation_invalid", "mine_elevator_target_invalid", "idempotency_key_reused_with_different_request",
        "execution_not_active", "cancellation_token_mismatch",
    };
    private static readonly HashSet<string> MineElevatorBlockedReasons = new(StringComparer.Ordinal)
    {
        "portfolio_binding_invalid", "portfolio_binding_generation_invalid", "execution_already_active", "adapter_unavailable",
        "irreversible_phase_reached", "portfolio_action_not_allowed", "portfolio_world_not_ready", "portfolio_single_player_required",
        "portfolio_scope_mismatch", "portfolio_mine_elevator_not_armed",
    };

    internal static bool IsMineLadderCheckpoint(int value) => value >= MineLadderMinimumFloor && value <= MineLadderMaximumFloor;
    internal static bool IsMineEntryCheckpoint(int value) => value == MineEntryMinimumFloor;

    internal static bool IsMineEntryTerminalReason(string state, string reason) => state switch
    {
        "succeeded" => reason == "enter_mine_floor_used",
        "cancelled" => reason == "cancelled",
        "expired" => reason == "deadline_expired",
        "failed" => reason == "native_operation_failed",
        "uncertain" => reason is "native_operation_uncertain" or "postcondition_observation_invalid" or "stale_callback_revision" or "portfolio_bridge_disconnected",
        "rejected" => reason.StartsWith("invalid_", StringComparison.Ordinal) || reason is "revision_mismatch" or "deadline_expired" or "mine_observation_invalid" or "enter_mine_target_invalid" or "idempotency_key_reused_with_different_request" or "execution_not_active" or "cancellation_token_mismatch",
        "blocked" => reason.StartsWith("portfolio_", StringComparison.Ordinal) || reason is "execution_already_active" or "adapter_unavailable" or "irreversible_phase_reached",
        _ => false,
    };

    internal static bool IsSkipEventTerminalReason(string state, string reason) => state switch
    {
        "succeeded" => reason == "skip_event_completed",
        "cancelled" => reason == "cancelled",
        "expired" => reason == "deadline_expired",
        "failed" => reason == "native_operation_failed",
        "uncertain" => reason is "native_operation_uncertain" or "postcondition_observation_invalid" or "stale_callback_revision" or "portfolio_bridge_disconnected",
        "rejected" => reason.StartsWith("invalid_", StringComparison.Ordinal) || reason is "revision_mismatch" or "deadline_expired" or "skip_event_no_active_event" or "skip_event_target_invalid" or "idempotency_key_reused_with_different_request" or "execution_not_active" or "cancellation_token_mismatch",
        "blocked" => reason.StartsWith("portfolio_", StringComparison.Ordinal) || reason is "execution_already_active" or "adapter_unavailable" or "irreversible_phase_reached",
        _ => false,
    };

    internal static bool IsMineLadderTerminalReason(string state, string reason) => state switch
    {
        "succeeded" => reason == "mine_ladder_floor_used",
        "cancelled" => reason == "cancelled",
        "expired" => reason == "deadline_expired",
        "failed" => reason == "native_operation_failed",
        "uncertain" => reason is "native_operation_uncertain" or "postcondition_observation_invalid" or "stale_callback_revision" or "portfolio_bridge_disconnected",
        "rejected" => reason.StartsWith("invalid_", StringComparison.Ordinal) || reason is "revision_mismatch" or "deadline_expired" or "mine_observation_invalid" or "mine_ladder_target_invalid" or "idempotency_key_reused_with_different_request" or "execution_not_active" or "cancellation_token_mismatch",
        "blocked" => reason.StartsWith("portfolio_", StringComparison.Ordinal) || reason is "execution_already_active" or "adapter_unavailable" or "irreversible_phase_reached",
        _ => false,
    };

    internal static bool IsMineElevatorCheckpoint(int value) => value >= MineElevatorMinimumCheckpoint
        && value <= MineElevatorMaximumCheckpoint && value % 5 == 0;

    internal static bool IsMineElevatorTerminalReason(string state, string reason) => state switch
    {
        "succeeded" => reason == "mine_elevator_floor_selected",
        "cancelled" => reason == "cancelled",
        "expired" => reason == "deadline_expired",
        "failed" => reason == "native_operation_failed",
        "uncertain" => MineElevatorUncertainReasons.Contains(reason),
        "rejected" => MineElevatorRejectedReasons.Contains(reason),
        "blocked" => MineElevatorBlockedReasons.Contains(reason),
        _ => false,
    };

    internal static bool TryDeserializeMineElevatorRequest(
        string json,
        PortfolioScope expectedScope,
        out PortfolioEnvelope<PortfolioMineElevatorActionRequest>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "mine_elevator_request", out JsonDocument? document, out reasonCode))
            return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "idempotencyKey", "selectedCheckpoint", "expectedRevision", "deadlineMs", "cancellationToken", "scope"))
            {
                reasonCode = "invalid_portfolio_mine_elevator_request";
                return false;
            }
            try
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                PortfolioEnvelope<PortfolioMineElevatorActionRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineElevatorActionRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (parsed?.Payload is null || !parsed.Payload.IsValid
                    || !IsMineElevatorCheckpoint(parsed.Payload.SelectedCheckpoint)
                    || parsed.Payload.DeadlineMs <= now
                    || parsed.Payload.DeadlineMs > now + (long)TimeSpan.FromMinutes(30).TotalMilliseconds
                    || !parsed.Payload.Scope.Equals(expectedScope))
                {
                    reasonCode = "invalid_portfolio_mine_elevator_request";
                    return false;
                }
                envelope = parsed;
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = "invalid_portfolio_mine_elevator_request";
                return false;
            }
        }
    }

    internal static bool TryDeserializeMineElevatorProbeRequest(
        string json,
        PortfolioScope expectedScope,
        out PortfolioEnvelope<PortfolioMineElevatorActionRequest>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "mine_elevator_probe_request", out JsonDocument? document, out reasonCode))
            return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "idempotencyKey", "selectedCheckpoint", "expectedRevision", "deadlineMs", "cancellationToken", "scope"))
            {
                reasonCode = "invalid_portfolio_mine_elevator_probe_request";
                return false;
            }
            try
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                PortfolioEnvelope<PortfolioMineElevatorActionRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineElevatorActionRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (parsed?.Payload is null || !parsed.Payload.IsValid
                    || !IsMineElevatorCheckpoint(parsed.Payload.SelectedCheckpoint)
                    || parsed.Payload.DeadlineMs <= now
                    || parsed.Payload.DeadlineMs > now + (long)TimeSpan.FromMinutes(30).TotalMilliseconds
                    || !parsed.Payload.Scope.Equals(expectedScope))
                {
                    reasonCode = "invalid_portfolio_mine_elevator_probe_request";
                    return false;
                }
                envelope = parsed;
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = "invalid_portfolio_mine_elevator_probe_request";
                return false;
            }
        }
    }

    internal static bool TryDeserializeMineElevatorFreshFloorRequest(
        string json,
        PortfolioScope expectedScope,
        out PortfolioEnvelope<PortfolioMineElevatorFreshFloorRequest>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "mine_elevator_fresh_floor_request", out JsonDocument? document, out reasonCode))
            return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "executionId", "expectedRevision", "deadlineMs", "cancellationToken", "scope"))
            {
                reasonCode = "invalid_portfolio_mine_elevator_fresh_floor_request";
                return false;
            }
            try
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                PortfolioEnvelope<PortfolioMineElevatorFreshFloorRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineElevatorFreshFloorRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (parsed?.Payload is null || !parsed.Payload.IsValid || parsed.Payload.DeadlineMs <= now
                    || parsed.Payload.DeadlineMs > now + (long)TimeSpan.FromMinutes(30).TotalMilliseconds
                    || !parsed.Payload.Scope.Equals(expectedScope))
                {
                    reasonCode = "invalid_portfolio_mine_elevator_fresh_floor_request";
                    return false;
                }
                envelope = parsed;
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = "invalid_portfolio_mine_elevator_fresh_floor_request";
                return false;
            }
        }
    }

    internal static bool TryDeserializeMineElevatorCancelRequest(
        string json,
        PortfolioScope expectedScope,
        out PortfolioEnvelope<PortfolioMineElevatorActionCancelRequest>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "mine_elevator_cancel_request", out JsonDocument? document, out reasonCode))
            return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "executionId", "cancellationToken", "scope"))
            {
                reasonCode = "invalid_portfolio_mine_elevator_cancel_request";
                return false;
            }
            try
            {
                PortfolioEnvelope<PortfolioMineElevatorActionCancelRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineElevatorActionCancelRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (parsed?.Payload is null || !parsed.Payload.IsValid || !parsed.Payload.Scope.Equals(expectedScope))
                {
                    reasonCode = "invalid_portfolio_mine_elevator_cancel_request";
                    return false;
                }
                envelope = parsed;
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = "invalid_portfolio_mine_elevator_cancel_request";
                return false;
            }
        }
    }

    internal static bool TryDeserializeMineLadderRequest(
        string json,
        PortfolioScope expectedScope,
        out PortfolioEnvelope<PortfolioMineLadderActionRequest>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "mine_ladder_request", out JsonDocument? document, out reasonCode)) return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "idempotencyKey", "expectedRevision", "deadlineMs", "cancellationToken", "scope")) { reasonCode = "invalid_portfolio_mine_ladder_request"; return false; }
            try
            {
                PortfolioEnvelope<PortfolioMineLadderActionRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineLadderActionRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (parsed?.Payload is null || !parsed.Payload.IsValid || parsed.Payload.DeadlineMs <= now || parsed.Payload.DeadlineMs > now + (long)TimeSpan.FromMinutes(30).TotalMilliseconds || !parsed.Payload.Scope.Equals(expectedScope)) { reasonCode = "invalid_portfolio_mine_ladder_request"; return false; }
                envelope = parsed; reasonCode = "accepted"; return true;
            }
            catch (JsonException) { reasonCode = "invalid_portfolio_mine_ladder_request"; return false; }
        }
    }

    internal static bool TryDeserializeMineLadderProbeRequest(string json, PortfolioScope expectedScope, out PortfolioEnvelope<PortfolioMineLadderActionRequest>? envelope, out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "mine_ladder_probe_request", out JsonDocument? document, out reasonCode)) return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "idempotencyKey", "expectedRevision", "deadlineMs", "cancellationToken", "scope")) { reasonCode = "invalid_portfolio_mine_ladder_probe_request"; return false; }
            try { PortfolioEnvelope<PortfolioMineLadderActionRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineLadderActionRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions); long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); if (parsed?.Payload is null || !parsed.Payload.IsValid || parsed.Payload.DeadlineMs <= now || parsed.Payload.DeadlineMs > now + (long)TimeSpan.FromMinutes(30).TotalMilliseconds || !parsed.Payload.Scope.Equals(expectedScope)) { reasonCode = "invalid_portfolio_mine_ladder_probe_request"; return false; } envelope = parsed; reasonCode = "accepted"; return true; } catch (JsonException) { reasonCode = "invalid_portfolio_mine_ladder_probe_request"; return false; }
        }
    }

    internal static bool TryDeserializeMineLadderFreshFloorRequest(string json, PortfolioScope expectedScope, out PortfolioEnvelope<PortfolioMineLadderFreshFloorRequest>? envelope, out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "mine_ladder_fresh_floor_request", out JsonDocument? document, out reasonCode)) return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "executionId", "expectedRevision", "deadlineMs", "cancellationToken", "scope")) { reasonCode = "invalid_portfolio_mine_ladder_fresh_floor_request"; return false; }
            try { PortfolioEnvelope<PortfolioMineLadderFreshFloorRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineLadderFreshFloorRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions); long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); if (parsed?.Payload is null || !parsed.Payload.IsValid || parsed.Payload.DeadlineMs <= now || parsed.Payload.DeadlineMs > now + (long)TimeSpan.FromMinutes(30).TotalMilliseconds || !parsed.Payload.Scope.Equals(expectedScope)) { reasonCode = "invalid_portfolio_mine_ladder_fresh_floor_request"; return false; } envelope = parsed; reasonCode = "accepted"; return true; } catch (JsonException) { reasonCode = "invalid_portfolio_mine_ladder_fresh_floor_request"; return false; }
        }
    }

    internal static bool TryDeserializeMineLadderCancelRequest(string json, PortfolioScope expectedScope, out PortfolioEnvelope<PortfolioMineLadderActionCancelRequest>? envelope, out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "mine_ladder_cancel_request", out JsonDocument? document, out reasonCode)) return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "executionId", "cancellationToken", "scope")) { reasonCode = "invalid_portfolio_mine_ladder_cancel_request"; return false; }
            try { PortfolioEnvelope<PortfolioMineLadderActionCancelRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineLadderActionCancelRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions); if (parsed?.Payload is null || !parsed.Payload.IsValid || !parsed.Payload.Scope.Equals(expectedScope)) { reasonCode = "invalid_portfolio_mine_ladder_cancel_request"; return false; } envelope = parsed; reasonCode = "accepted"; return true; } catch (JsonException) { reasonCode = "invalid_portfolio_mine_ladder_cancel_request"; return false; }
        }
    }

    internal static bool TryDeserializeMineEntryFreshFloorRequest(string json, PortfolioScope expectedScope, out PortfolioEnvelope<PortfolioMineEntryFreshFloorRequest>? envelope, out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "enter_mine_fresh_floor_request", out JsonDocument? document, out reasonCode)) return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "executionId", "expectedRevision", "deadlineMs", "cancellationToken", "scope")) { reasonCode = "invalid_portfolio_enter_mine_fresh_floor_request"; return false; }
            try { PortfolioEnvelope<PortfolioMineEntryFreshFloorRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineEntryFreshFloorRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions); long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); if (parsed?.Payload is null || !parsed.Payload.IsValid || parsed.Payload.DeadlineMs <= now || parsed.Payload.DeadlineMs > now + (long)TimeSpan.FromMinutes(30).TotalMilliseconds || !parsed.Payload.Scope.Equals(expectedScope)) { reasonCode = "invalid_portfolio_enter_mine_fresh_floor_request"; return false; } envelope = parsed; reasonCode = "accepted"; return true; } catch (JsonException) { reasonCode = "invalid_portfolio_enter_mine_fresh_floor_request"; return false; }
        }
    }

    internal static bool TryDeserializeMineEntryCancelRequest(string json, PortfolioScope expectedScope, out PortfolioEnvelope<PortfolioMineEntryActionCancelRequest>? envelope, out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "enter_mine_cancel_request", out JsonDocument? document, out reasonCode)) return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "executionId", "cancellationToken", "scope")) { reasonCode = "invalid_portfolio_enter_mine_cancel_request"; return false; }
            try { PortfolioEnvelope<PortfolioMineEntryActionCancelRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineEntryActionCancelRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions); if (parsed?.Payload is null || !parsed.Payload.IsValid || !parsed.Payload.Scope.Equals(expectedScope)) { reasonCode = "invalid_portfolio_enter_mine_cancel_request"; return false; } envelope = parsed; reasonCode = "accepted"; return true; } catch (JsonException) { reasonCode = "invalid_portfolio_enter_mine_cancel_request"; return false; }
        }
    }

    internal static bool TryDeserializeMineEntryRequest(string json, PortfolioScope expectedScope, out PortfolioEnvelope<PortfolioMineEntryActionRequest>? envelope, out string reasonCode) => TryDeserializeMineEntry(json, expectedScope, "enter_mine_request", "invalid_portfolio_enter_mine_request", out envelope, out reasonCode);
    internal static bool TryDeserializeMineEntryProbeRequest(string json, PortfolioScope expectedScope, out PortfolioEnvelope<PortfolioMineEntryActionRequest>? envelope, out string reasonCode) => TryDeserializeMineEntry(json, expectedScope, "enter_mine_probe_request", "invalid_portfolio_enter_mine_probe_request", out envelope, out reasonCode);
    private static bool TryDeserializeMineEntry(string json, PortfolioScope scope, string type, string invalid, out PortfolioEnvelope<PortfolioMineEntryActionRequest>? envelope, out string reasonCode) { envelope=null; if(!TryParseStrictEnvelope(json,scope,type,out JsonDocument? d,out reasonCode)) return false; using(d!) { var p=d!.RootElement.GetProperty("payload"); if(!HasExactProperties(p,"action","requestId","traceId","idempotencyKey","expectedRevision","deadlineMs","cancellationToken","scope")){reasonCode=invalid;return false;} try { var x=JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineEntryActionRequest>>(d.RootElement.GetRawText(),JsonOptions); var now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); if(x?.Payload is null||!x.Payload.IsValid||x.Payload.DeadlineMs<=now||x.Payload.DeadlineMs>now+1800000||!x.Payload.Scope.Equals(scope)){reasonCode=invalid;return false;} envelope=x;reasonCode="accepted";return true;}catch(JsonException){reasonCode=invalid;return false;} } }

    internal static bool TryDeserializeSkipEventRequest(
        string json,
        PortfolioScope expectedScope,
        out PortfolioEnvelope<PortfolioSkipEventActionRequest>? envelope,
        out string reasonCode)
        => TryDeserializeSkipEvent(json, expectedScope, "skip_event_request", "invalid_portfolio_skip_event_request", out envelope, out reasonCode);

    internal static bool TryDeserializeSkipEventProbeRequest(
        string json,
        PortfolioScope expectedScope,
        out PortfolioEnvelope<PortfolioSkipEventActionRequest>? envelope,
        out string reasonCode)
        => TryDeserializeSkipEvent(json, expectedScope, "skip_event_probe_request", "invalid_portfolio_skip_event_probe_request", out envelope, out reasonCode);

    private static bool TryDeserializeSkipEvent(
        string json,
        PortfolioScope expectedScope,
        string expectedType,
        string invalidReason,
        out PortfolioEnvelope<PortfolioSkipEventActionRequest>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, expectedType, out JsonDocument? document, out reasonCode))
            return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "idempotencyKey", "expectedRevision", "deadlineMs", "cancellationToken", "scope"))
            {
                reasonCode = invalidReason;
                return false;
            }
            try
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                PortfolioEnvelope<PortfolioSkipEventActionRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioSkipEventActionRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (parsed?.Payload is null || !parsed.Payload.IsValid || parsed.Payload.DeadlineMs <= now
                    || parsed.Payload.DeadlineMs > now + (long)TimeSpan.FromMinutes(30).TotalMilliseconds
                    || !parsed.Payload.Scope.Equals(expectedScope))
                {
                    reasonCode = invalidReason;
                    return false;
                }
                envelope = parsed;
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = invalidReason;
                return false;
            }
        }
    }

    internal static bool TryDeserializeSkipEventCancelRequest(
        string json,
        PortfolioScope expectedScope,
        out PortfolioEnvelope<PortfolioSkipEventActionCancelRequest>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "skip_event_cancel_request", out JsonDocument? document, out reasonCode))
            return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "executionId", "cancellationToken", "scope"))
            {
                reasonCode = "invalid_portfolio_skip_event_cancel_request";
                return false;
            }
            try
            {
                PortfolioEnvelope<PortfolioSkipEventActionCancelRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioSkipEventActionCancelRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (parsed?.Payload is null || !parsed.Payload.IsValid || !parsed.Payload.Scope.Equals(expectedScope))
                {
                    reasonCode = "invalid_portfolio_skip_event_cancel_request";
                    return false;
                }
                envelope = parsed;
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = "invalid_portfolio_skip_event_cancel_request";
                return false;
            }
        }
    }

    internal static bool TryDeserializeBootstrapHello(
        string json,
        PortfolioLocalPlayerBinding expectedBinding,
        string expectedToken,
        out PortfolioEnvelope<PortfolioBootstrapHello>? envelope,
        out string reasonCode)
    {
        envelope = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !HasExactProperties(root, "protocolVersion", "messageId", "correlationId", "timestampMs", "scope", "type", "payload")
                || root.GetProperty("protocolVersion").GetInt32() != Version
                || root.GetProperty("type").GetString() != "bootstrap_hello"
                || !IsOpaqueId(root.GetProperty("messageId").GetString())
                || !IsOpaqueId(root.GetProperty("correlationId").GetString())
                || !IsValidTimestamp(root.GetProperty("timestampMs"))
                || !TryReadBootstrapScope(root.GetProperty("scope"), expectedBinding)
                || !HasExactProperties(root.GetProperty("payload"), "token"))
            { reasonCode = "invalid_portfolio_bootstrap_hello"; return false; }
            PortfolioEnvelope<PortfolioBootstrapHello>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioBootstrapHello>>(root.GetRawText(), JsonOptions);
            if (parsed?.Payload is null || parsed.Payload.ExtensionData is { Count: > 0 } || !IsToken(parsed.Payload.Token) || !FixedEquals(parsed.Payload.Token, expectedToken))
            { reasonCode = "authentication_failed"; return false; }
            envelope = parsed; reasonCode = "accepted"; return true;
        }
        catch (JsonException) { envelope = null; reasonCode = "invalid_json"; return false; }
        catch (InvalidOperationException) { envelope = null; reasonCode = "invalid_portfolio_bootstrap_hello"; return false; }
    }

    private static bool TryReadBootstrapScope(JsonElement value, PortfolioLocalPlayerBinding expected)
    {
        if (value.ValueKind != JsonValueKind.Object || !HasExactProperties(value, "integrationId", "topology", "saveId", "worldId", "localPlayerId", "companionId", "bindingGeneration", "bindingHash")) return false;
        try
        {
            PortfolioBootstrapScope? scope = JsonSerializer.Deserialize<PortfolioBootstrapScope>(value.GetRawText(), JsonOptions);
            return scope is not null && scope.IsValid && scope.IntegrationId == IntegrationId && scope.Topology == expected.Topology
                && scope.SaveId == expected.SaveId && scope.WorldId == expected.WorldId && scope.LocalPlayerId == expected.LocalPlayerId
                && scope.CompanionId == expected.CompanionId && scope.BindingGeneration == 0
                && FixedEquals(scope.BindingHash, ComputeBindingHash(scope.SaveId, scope.WorldId, scope.LocalPlayerId, scope.CompanionId, 0));
        }
        catch (JsonException) { return false; }
    }

    internal static bool TryDeserializeSleepDayRequest(
        string json,
        PortfolioScope expectedScope,
        out PortfolioEnvelope<PortfolioSleepDayRequest>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "sleep_day_request", out JsonDocument? document, out reasonCode))
            return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "idempotencyKey", "expectedRevision", "deadlineMs", "cancellationToken"))
            {
                reasonCode = "invalid_portfolio_sleep_day_request";
                return false;
            }
            try
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                PortfolioEnvelope<PortfolioSleepDayRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioSleepDayRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (parsed?.Payload is null || parsed.Payload.Action != SleepDayAction
                    || !IsOpaqueId(parsed.Payload.RequestId) || !IsOpaqueId(parsed.Payload.TraceId) || !IsOpaqueId(parsed.Payload.IdempotencyKey)
                    || parsed.Payload.ExpectedRevision < 0
                    || parsed.Payload.DeadlineMs <= now
                    || parsed.Payload.DeadlineMs > now + (long)TimeSpan.FromMinutes(30).TotalMilliseconds
                    || !IsOpaqueId(parsed.Payload.CancellationToken))
                {
                    reasonCode = "invalid_portfolio_sleep_day_request";
                    return false;
                }
                envelope = parsed;
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = "invalid_portfolio_sleep_day_request";
                return false;
            }
        }
    }

    internal static bool TryDeserializeSleepDayCancelRequest(
        string json,
        PortfolioScope expectedScope,
        out PortfolioEnvelope<PortfolioSleepDayCancelRequest>? envelope,
        out string reasonCode)
    {
        envelope = null;
        if (!TryParseStrictEnvelope(json, expectedScope, "sleep_day_cancel_request", out JsonDocument? document, out reasonCode))
            return false;
        using (JsonDocument parsedDocument = document!)
        {
            JsonElement payload = parsedDocument.RootElement.GetProperty("payload");
            if (!HasExactProperties(payload, "action", "requestId", "traceId", "executionId", "cancellationToken"))
            {
                reasonCode = "invalid_portfolio_sleep_day_cancel_request";
                return false;
            }
            try
            {
                PortfolioEnvelope<PortfolioSleepDayCancelRequest>? parsed = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioSleepDayCancelRequest>>(parsedDocument.RootElement.GetRawText(), JsonOptions);
                if (parsed?.Payload is null || parsed.Payload.Action != SleepDayAction
                    || !IsOpaqueId(parsed.Payload.RequestId) || !IsOpaqueId(parsed.Payload.TraceId) || !IsOpaqueId(parsed.Payload.ExecutionId)
                    || !IsOpaqueId(parsed.Payload.CancellationToken))
                {
                    reasonCode = "invalid_portfolio_sleep_day_cancel_request";
                    return false;
                }
                envelope = parsed;
                reasonCode = "accepted";
                return true;
            }
            catch (JsonException)
            {
                reasonCode = "invalid_portfolio_sleep_day_cancel_request";
                return false;
            }
        }
    }

    private static bool TryParseStrictEnvelope(
        string json,
        PortfolioScope expectedScope,
        string expectedType,
        out JsonDocument? document,
        out string reasonCode)
    {
        document = null;
        try
        {
            document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !HasExactProperties(root,
                    "protocolVersion", "messageId", "correlationId", "timestampMs", "scope", "type", "payload")
                || root.GetProperty("protocolVersion").GetInt32() != Version
                || !IsOpaqueId(root.GetProperty("messageId").GetString())
                || !IsOpaqueId(root.GetProperty("correlationId").GetString())
                || root.GetProperty("type").GetString() != expectedType
                || !IsValidTimestamp(root.GetProperty("timestampMs"))
                || !TryReadScope(root.GetProperty("scope"), expectedScope))
            {
                document.Dispose();
                document = null;
                reasonCode = "invalid_envelope";
                return false;
            }
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

    private static bool IsValidTimestamp(JsonElement value) => value.ValueKind == JsonValueKind.Number
        && value.TryGetInt64(out long timestamp)
        && Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - timestamp) <= TimeSpan.FromMinutes(5).TotalMilliseconds;

    private static bool TryReadScope(JsonElement value, PortfolioScope expected)
    {
        if (value.ValueKind != JsonValueKind.Object || !HasExactProperties(value,
                "integrationId", "topology", "saveId", "worldId", "localPlayerId", "companionId", "bindingGeneration", "bindingHash"))
            return false;
        try
        {
            PortfolioScope? actual = JsonSerializer.Deserialize<PortfolioScope>(value.GetRawText(), JsonOptions);
            return actual is not null && actual.IsValid && actual.Equals(expected);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool HasExactProperties(JsonElement value, params string[] names)
    {
        if (value.ValueKind != JsonValueKind.Object)
            return false;
        HashSet<string> expected = new(names, StringComparer.Ordinal);
        return value.EnumerateObject().Count() == expected.Count
            && value.EnumerateObject().All(property => expected.Contains(property.Name));
    }
}

internal sealed record PortfolioBootstrapScope(
    string IntegrationId,
    string Topology,
    string SaveId,
    string WorldId,
    string LocalPlayerId,
    string CompanionId,
    long BindingGeneration,
    string BindingHash)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
    internal bool IsValid => IntegrationId == PortfolioBridgeProtocol.IntegrationId && Topology == PortfolioBridgeProtocol.Topology
        && PortfolioBridgeProtocol.IsOpaqueId(SaveId) && PortfolioBridgeProtocol.IsOpaqueId(WorldId)
        && PortfolioBridgeProtocol.IsOpaqueId(LocalPlayerId) && PortfolioBridgeProtocol.IsOpaqueId(CompanionId)
        && BindingGeneration == 0 && PortfolioBridgeProtocol.IsSha256(BindingHash) && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioScope(
    string IntegrationId,
    string Topology,
    string SaveId,
    string WorldId,
    string LocalPlayerId,
    string CompanionId,
    long BindingGeneration,
    string BindingHash)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => IntegrationId == PortfolioBridgeProtocol.IntegrationId
        && Topology == PortfolioBridgeProtocol.Topology
        && PortfolioBridgeProtocol.IsOpaqueId(SaveId)
        && PortfolioBridgeProtocol.IsOpaqueId(WorldId)
        && PortfolioBridgeProtocol.IsOpaqueId(LocalPlayerId)
        && PortfolioBridgeProtocol.IsOpaqueId(CompanionId)
        && BindingGeneration > 0
        && PortfolioBridgeProtocol.IsSha256(BindingHash)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioEnvelope<TPayload>(
    int ProtocolVersion,
    string MessageId,
    string CorrelationId,
    long TimestampMs,
    PortfolioScope Scope,
    string Type,
    TPayload Payload)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioBootstrapHello(string Token)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioBootstrapHelloAck(string SessionId)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioHello(string Token)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioHelloAck(string SessionId, long BindingGeneration, string BindingHash)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioObserveRequest()
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

/// <summary>
/// Observe-only state. It deliberately has no capabilities, active execution,
/// request, receipt, DSM, checkpoint, or Farmhand identity fields.
/// </summary>
internal sealed record PortfolioSnapshot(
    int ProtocolVersion,
    string IntegrationId,
    string Topology,
    string SaveId,
    string WorldId,
    string LocalPlayerId,
    string CompanionId,
    long BindingGeneration,
    string BindingHash,
    long Revision,
    bool WorldReady,
    bool SinglePlayer,
    bool CurrentLocalPlayerMatches,
    string State,
    string ReasonCode);

internal sealed record PortfolioError(string ReasonCode);
