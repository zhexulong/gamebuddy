using System.Text;
using System.Text.Json;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;

namespace GameBuddy.Stardew.WireParityContract;

internal static class Program
{
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2)
                return Fail("invalid_arguments");

            byte[] input = ReadInput(args[1]);
            return args[0] switch
            {
                "--decode-execution-request" => DecodeExecutionRequest(input),
                "--decode-execution-receipt-query" => DecodeExecutionReceiptQuery(input),
                "--decode-cancel-request" => DecodeCancelRequest(input),
                "--decode-error" => DecodeError(input),
                "--encode-execution-receipt" => EncodeExecutionReceipt(input),
                "--encode-execution-receipt-query" => EncodeExecutionReceiptQuery(input),
                "--encode-cancel-request" => EncodeCancelRequest(input),
                "--encode-error" => EncodeError(input),
                _ => Fail("invalid_arguments"),
            };
        }
        catch (WireContractException exception)
        {
            return Fail(exception.Message);
        }
        catch
        {
            return Fail("wire_contract_failed");
        }
    }

    private static int DecodeExecutionRequest(byte[] input)
    {
        string json = DecodeUtf8(input);
        if (!BridgeProtocol.TryDeserializeExecutionRequest(json, out BridgeEnvelope<BridgeExecutionRequest>? envelope, out string reasonCode)
            || envelope is null)
            return Fail(reasonCode);

        BridgeExecutionRequest request = envelope.Payload;
        Console.WriteLine($"accepted|execution_request|{request.RequestId}|{request.IdempotencyKey}|{request.Action}|{request.Args.Slot?.ToString() ?? "null"}|{request.ExpectedRevision}|{request.DeadlineMs}");
        return 0;
    }

    private static int DecodeExecutionReceiptQuery(byte[] input)
    {
        string json = DecodeUtf8(input);
        if (!BridgeProtocol.TryDeserializeExecutionReceiptQuery(json, out BridgeEnvelope<BridgeExecutionReceiptQuery>? envelope, out string reasonCode)
            || envelope is null)
            return Fail(reasonCode);

        BridgeExecutionReceiptQuery query = envelope.Payload;
        Console.WriteLine($"accepted|execution_receipt_query|{query.RequestId}|{query.IdempotencyKey}");
        return 0;
    }

    private static int DecodeCancelRequest(byte[] input)
    {
        string json = DecodeUtf8(input);
        if (!BridgeProtocol.TryDeserializeInbound(json, "cancel_request", out BridgeEnvelope<BridgeCancelRequest>? envelope, out string reasonCode,
                "requestId", "executionId", "cancelId", "cancelEpoch", "reasonCode")
            || envelope is null)
            return Fail(reasonCode);

        BridgeCancelRequest request = envelope.Payload;
        if (!BridgeProtocol.IsOpaqueId(request.RequestId)
            || !BridgeProtocol.IsOpaqueId(request.ExecutionId)
            || !BridgeProtocol.IsOpaqueId(request.CancelId)
            || request.CancelEpoch < 1
            || !BridgeProtocol.IsReasonCode(request.ReasonCode))
            return Fail("invalid_cancel_request");

        Console.WriteLine($"accepted|cancel_request|{request.RequestId}|{request.ExecutionId}|{request.CancelId}|{request.CancelEpoch}|{request.ReasonCode}");
        return 0;
    }

    private static int DecodeError(byte[] input)
    {
        string json = DecodeUtf8(input);
        if (!BridgeProtocol.TryDeserializeInbound(json, "error", out BridgeEnvelope<BridgeError>? envelope, out string reasonCode, "reasonCode")
            || envelope is null)
            return Fail(reasonCode);

        if (!BridgeProtocol.IsReasonCode(envelope.Payload.ReasonCode))
            return Fail("invalid_error");

        Console.WriteLine($"accepted|error|{envelope.Payload.ReasonCode}");
        return 0;
    }

    private static int EncodeExecutionReceipt(byte[] input)
    {
        ReceiptInput receipt = ParseReceiptInput(DecodeUtf8(input));
        var payload = new
        {
            executionId = receipt.ExecutionId,
            requestId = receipt.RequestId,
            state = receipt.State,
            reasonCode = receipt.ReasonCode,
            revision = receipt.Revision,
            evidence = receipt.Evidence,
        };
        var envelope = new BridgeEnvelope<object>(
            BridgeProtocol.Version,
            receipt.MessageId,
            receipt.CorrelationId,
            receipt.TimestampMs,
            receipt.Scope,
            "execution_receipt",
            payload);
        return WriteEnvelope(envelope);
    }

    private static int EncodeExecutionReceiptQuery(byte[] input)
    {
        ReceiptQueryInput query = ParseReceiptQueryInput(DecodeUtf8(input));
        var envelope = new BridgeEnvelope<BridgeExecutionReceiptQuery>(
            BridgeProtocol.Version,
            query.MessageId,
            query.CorrelationId,
            query.TimestampMs,
            query.Scope,
            "execution_receipt_query",
            new BridgeExecutionReceiptQuery(query.RequestId, query.IdempotencyKey));
        return WriteEnvelope(envelope);
    }

    private static int EncodeCancelRequest(byte[] input)
    {
        CancelInput cancel = ParseCancelInput(DecodeUtf8(input));
        var envelope = new BridgeEnvelope<BridgeCancelRequest>(
            BridgeProtocol.Version,
            cancel.MessageId,
            cancel.CorrelationId,
            cancel.TimestampMs,
            cancel.Scope,
            "cancel_request",
            new BridgeCancelRequest(cancel.RequestId, cancel.ExecutionId, cancel.CancelId, cancel.CancelEpoch, cancel.ReasonCode));
        return WriteEnvelope(envelope);
    }

    private static int EncodeError(byte[] input)
    {
        ErrorInput error = ParseErrorInput(DecodeUtf8(input));
        var envelope = new BridgeEnvelope<BridgeError>(
            BridgeProtocol.Version,
            error.MessageId,
            error.CorrelationId,
            error.TimestampMs,
            error.Scope,
            "error",
            new BridgeError(error.ReasonCode));
        return WriteEnvelope(envelope);
    }

    private static int WriteEnvelope<T>(BridgeEnvelope<T> envelope)
    {
        if (!BridgeProtocol.TrySerialize(envelope, out string output, out string reasonCode))
            return Fail(reasonCode);

        using Stream stdout = Console.OpenStandardOutput();
        stdout.Write(Encoding.UTF8.GetBytes(output));
        return 0;
    }

    private static ReceiptInput ParseReceiptInput(string json)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !HasExactProperties(root, "messageId", "correlationId", "timestampMs", "scope", "executionId", "requestId", "state", "reasonCode", "revision", "evidence"))
                throw new WireContractException("invalid_receipt_input");

            ReceiptInput? input = JsonSerializer.Deserialize<ReceiptInput>(root.GetRawText(), BridgeProtocol.JsonOptions);
            if (input is null
                || !BridgeProtocol.IsOpaqueId(input.MessageId)
                || !BridgeProtocol.IsOpaqueId(input.CorrelationId)
                || !input.Scope.IsValid
                || !BridgeProtocol.IsOpaqueId(input.ExecutionId)
                || !BridgeProtocol.IsOpaqueId(input.RequestId)
                || !IsExecutionState(input.State)
                || !BridgeProtocol.IsReasonCode(input.ReasonCode)
                || input.Revision < 0
                || input.Evidence is null)
                throw new WireContractException("invalid_receipt_input");
            return input;
        }
        catch (JsonException)
        {
            throw new WireContractException("invalid_receipt_input");
        }
    }

    private static ReceiptQueryInput ParseReceiptQueryInput(string json) => ParseInput<ReceiptQueryInput>(
        json,
        new[] { "messageId", "correlationId", "timestampMs", "scope", "requestId", "idempotencyKey" },
        input => BridgeProtocol.IsOpaqueId(input.MessageId)
            && BridgeProtocol.IsOpaqueId(input.CorrelationId)
            && input.Scope.IsValid
            && BridgeProtocol.IsOpaqueId(input.RequestId)
            && BridgeProtocol.IsOpaqueId(input.IdempotencyKey));

    private static CancelInput ParseCancelInput(string json) => ParseInput<CancelInput>(
        json,
        new[] { "messageId", "correlationId", "timestampMs", "scope", "requestId", "executionId", "cancelId", "cancelEpoch", "reasonCode" },
        input => BridgeProtocol.IsOpaqueId(input.MessageId)
            && BridgeProtocol.IsOpaqueId(input.CorrelationId)
            && input.Scope.IsValid
            && BridgeProtocol.IsOpaqueId(input.RequestId)
            && BridgeProtocol.IsOpaqueId(input.ExecutionId)
            && BridgeProtocol.IsOpaqueId(input.CancelId)
            && input.CancelEpoch >= 1
            && BridgeProtocol.IsReasonCode(input.ReasonCode));

    private static ErrorInput ParseErrorInput(string json) => ParseInput<ErrorInput>(
        json,
        new[] { "messageId", "correlationId", "timestampMs", "scope", "reasonCode" },
        input => BridgeProtocol.IsOpaqueId(input.MessageId)
            && BridgeProtocol.IsOpaqueId(input.CorrelationId)
            && input.Scope.IsValid
            && BridgeProtocol.IsReasonCode(input.ReasonCode));

    private static T ParseInput<T>(string json, string[] expectedProperties, Func<T, bool> isValid)
        where T : class
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            if (!HasExactProperties(root, expectedProperties))
                throw new WireContractException("invalid_input");

            T? input = JsonSerializer.Deserialize<T>(root.GetRawText(), BridgeProtocol.JsonOptions);
            if (input is null || !isValid(input))
                throw new WireContractException("invalid_input");
            return input;
        }
        catch (JsonException)
        {
            throw new WireContractException("invalid_input");
        }
    }

    private static bool IsExecutionState(string value) => value switch
    {
        "accepted" or "running" or "meaningful_progress" or "blocked" or "invalidated" or "succeeded"
            or "partially_succeeded" or "failed" or "cancelled" or "expired" or "rejected" or "uncertain" => true,
        _ => false,
    };

    private static bool HasExactProperties(JsonElement value, params string[] expected)
    {
        if (value.ValueKind != JsonValueKind.Object) return false;
        HashSet<string> actual = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!actual.Add(property.Name)) return false;
        }
        return actual.Count == expected.Length && expected.All(actual.Contains);
    }

    private static byte[] ReadInput(string source)
    {
        byte[] bytes;
        try
        {
            if (source == "-")
            {
                using Stream stdin = Console.OpenStandardInput();
                bytes = ReadAll(stdin);
            }
            else
            {
                bytes = Convert.FromBase64String(source);
            }
        }
        catch (FormatException)
        {
            throw new WireContractException("invalid_base64");
        }
        if (bytes.Length > BridgeProtocol.MaximumMessageBytes) throw new WireContractException("message_too_large");
        return bytes;
    }

    private static byte[] ReadAll(Stream stream)
    {
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }

    private static string DecodeUtf8(byte[] bytes)
    {
        try { return new UTF8Encoding(false, true).GetString(bytes); }
        catch (DecoderFallbackException) { throw new WireContractException("invalid_utf8"); }
    }

    private static int Fail(string reasonCode)
    {
        Console.Error.WriteLine(reasonCode);
        return 1;
    }

    private sealed record ReceiptInput(
        string MessageId,
        string CorrelationId,
        long TimestampMs,
        BridgeScope Scope,
        string ExecutionId,
        string RequestId,
        string State,
        string ReasonCode,
        long Revision,
        IReadOnlyDictionary<string, string>? Evidence);

    private sealed record BridgeCancelRequest(
        string RequestId,
        string ExecutionId,
        string CancelId,
        long CancelEpoch,
        string ReasonCode);

    private sealed record ReceiptQueryInput(
        string MessageId,
        string CorrelationId,
        long TimestampMs,
        BridgeScope Scope,
        string RequestId,
        string IdempotencyKey);

    private sealed record CancelInput(
        string MessageId,
        string CorrelationId,
        long TimestampMs,
        BridgeScope Scope,
        string RequestId,
        string ExecutionId,
        string CancelId,
        long CancelEpoch,
        string ReasonCode);

    private sealed record ErrorInput(
        string MessageId,
        string CorrelationId,
        long TimestampMs,
        BridgeScope Scope,
        string ReasonCode);

    private sealed class WireContractException : Exception
    {
        internal WireContractException(string message) : base(message) { }
    }
}
