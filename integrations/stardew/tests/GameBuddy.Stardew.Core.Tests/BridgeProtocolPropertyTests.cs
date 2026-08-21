using FsCheck;
using FsCheck.Xunit;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class BridgeProtocolPropertyTests
{
    private static readonly BridgeScope SampleScope = new("stardew", "save_1", "world_1", "player_1", "companion_1");

    [Property(MaxTest = 100)]
    public Property ExecutionRequest_RoundTripSerialization_IsLossless(NonNull<string> reqId, NonNull<string> idempKey, int x, int y)
    {
        string safeReqId = BridgeProtocol.IsOpaqueId(reqId.Get) ? reqId.Get : "valid_req_id";
        string safeIdempKey = BridgeProtocol.IsOpaqueId(idempKey.Get) ? idempKey.Get : "valid_idemp_key";

        var request = new BridgeExecutionRequest(safeReqId, safeIdempKey, "move_to_tile", new BridgeExecutionArgs { X = x, Y = y }, 1, 5000);
        var envelope = new BridgeEnvelope<BridgeExecutionRequest>(1, "msg_1", "corr_1", 1000L, SampleScope, "execution_request", request);

        if (!BridgeProtocol.TrySerialize(envelope, out string json, out _))
            return false.ToProperty();

        if (!BridgeProtocol.TryDeserializeExecutionRequest(json, out var roundTrip, out string reason))
            return false.ToProperty();

        bool matched = roundTrip != null &&
                       roundTrip.Payload.RequestId == safeReqId &&
                       roundTrip.Payload.IdempotencyKey == safeIdempKey &&
                       roundTrip.Payload.Action == "move_to_tile" &&
                       (int)(roundTrip.Payload.Args.X ?? 0) == x &&
                       (int)(roundTrip.Payload.Args.Y ?? 0) == y;

        return matched.ToProperty();
    }
}
