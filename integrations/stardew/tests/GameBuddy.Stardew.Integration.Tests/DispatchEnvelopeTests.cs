using System;
using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The envelope every action request arrives with, resolved in ONE place
/// (<c>ExecutionAdmission.ResolveDispatchEnvelope</c>): a request this Mod already answered is answered again with the
/// receipt it has, and every other request is handed the execution identity its body runs under.
///
/// <para>
/// The six handlers below are the ones that used to restate that hop by hand — `ride_bus`, `express_emote`,
/// `face_direction` and the three modal actions — so this file is the executable half of that collapse. Each branch of
/// the resolver is driven through the REAL handler, and the handlers are driven headless (no bound actor, empty args), so
/// every one of them answers with the refusal its own family names — which is also the proof that the handler itself
/// still ran, rather than being answered by the envelope for the wrong reason.
/// </para>
///
/// <para>
/// One asymmetry, stated rather than hidden: `ride_bus` advances no revision before its identity guard, so its replay row
/// proves the byte-identical answer only. The five handlers that advance the revision before their own checks are the
/// ones that can also show that a replay performed none of the work.
/// </para>
/// </summary>
public sealed class DispatchEnvelopeTests
{
    /// <summary>
    /// Action id → the refusal its handler answers with when it is dispatched headless. The SECOND column pins that the
    /// body ran: an envelope that answered a first dispatch would answer `world_not_ready` for a handler whose own
    /// verdict is a named argument refusal.
    /// </summary>
    public static TheoryData<string, string> Handlers => new()
    {
        { "ride_bus", "world_not_ready" },
        { "express_emote", "invalid_emote" },
        { "face_direction", "invalid_direction" },
        { "dismiss_modal", "world_not_ready" },
        { "answer_dialogue", "world_not_ready" },
        { "respond_level_up", "world_not_ready" },
    };

    [Theory]
    [MemberData(nameof(Handlers))]
    public void AReplayIsAnsweredWithTheReceiptItAlreadyHas_AndDoesNoWork(string actionId, string headlessReason)
    {
        ExecutionManager manager = CreateManager();
        BridgeExecutionRequest request = Request($"req_replay_{actionId}", actionId);

        LocalExecutionReceipt first = Dispatch(manager, request);
        first.State.Should().Be(ExecutionState.Rejected);
        first.ReasonCode.Should().Be(headlessReason);
        long revisionAfterFirstDispatch = manager.CurrentRevision;

        LocalExecutionReceipt replay = Dispatch(manager, request);

        replay.Should().Be(
            first,
            "a request that was already answered is answered again with the receipt it has, not with a second execution");
        manager.CurrentRevision.Should().Be(
            revisionAfterFirstDispatch,
            "a replay is the same execution, so it performs none of the handler's work");
    }

    [Theory]
    [MemberData(nameof(Handlers))]
    public void TheExecutionIdTheDispatchBoundIsTheOneTheHandlerRunsUnder(string actionId, string headlessReason)
    {
        const string boundExecutionId = "execution_bound_by_the_dispatch";
        ExecutionManager manager = CreateManager();
        BridgeExecutionRequest request = Request($"req_bound_{actionId}", actionId);
        ((IDispatchExecutionLedger)manager).TryBindDispatch(request.RequestId, actionId, boundExecutionId, out string bindReason)
            .Should().BeTrue(bindReason);

        LocalExecutionReceipt receipt = Dispatch(manager, request);

        receipt.ReasonCode.Should().Be(headlessReason, "the body still runs; only its identity comes from the envelope");
        receipt.ExecutionId.Should().Be(
            boundExecutionId,
            "the dispatch lineage already minted this request's identity, and the body must not mint a second one");
    }

    [Theory]
    [MemberData(nameof(Handlers))]
    public void AnUnboundRequestIsGivenAFreshIdentityOfItsOwn(string actionId, string headlessReason)
    {
        ExecutionManager manager = CreateManager();

        LocalExecutionReceipt first = Dispatch(manager, Request($"req_fresh_a_{actionId}", actionId));
        LocalExecutionReceipt second = Dispatch(manager, Request($"req_fresh_b_{actionId}", actionId));

        first.ReasonCode.Should().Be(headlessReason);
        Guid.TryParseExact(first.ExecutionId, "N", out _).Should().BeTrue(
            $"an unbound request is given a fresh identity by the store, not one the handler invented: {first.ExecutionId}");
        first.ExecutionId.Should().NotBe(
            second.ExecutionId,
            "two requests are two executions, so one request's identity can never answer another's");
    }

    /// <summary>
    /// The six handlers the envelope was extracted from, dispatched through their real entry points. Compile-checked on
    /// purpose: a handler that is renamed must break this file rather than be silently dropped from the pins.
    /// </summary>
    private static LocalExecutionReceipt Dispatch(ExecutionManager manager, BridgeExecutionRequest request) =>
        request.Action switch
        {
            "ride_bus" => manager.RequestLocalRideBus(request, manager),
            "express_emote" => manager.RequestLocalExpressEmote(request, manager),
            "face_direction" => manager.RequestLocalFaceDirection(request, manager),
            "dismiss_modal" => manager.RequestLocalDismissModal(request, manager),
            "answer_dialogue" => manager.RequestLocalAnswerDialogue(request, manager),
            "respond_level_up" => manager.RequestLocalRespondLevelUp(request, manager),
            _ => throw new InvalidOperationException($"unmapped_action:{request.Action}"),
        };

    private static BridgeExecutionRequest Request(string requestId, string actionId) =>
        new(requestId, $"{requestId}_idem", actionId, new BridgeExecutionArgs(), 1, 600_000);

    private static ExecutionManager CreateManager()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal));
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionScope: null);
        executions.SetTestActorResolver(() => null);
        return executions;
    }
}
