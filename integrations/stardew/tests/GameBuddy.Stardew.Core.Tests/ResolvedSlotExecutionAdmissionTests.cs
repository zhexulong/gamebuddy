using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A DECLARED-TOOL ACTION'S `slot` IS A VALUE THE BODY DERIVES, SO ITS ABSENCE IS LEGAL AT BOTH DOORS AND ITS PRESENCE IS
/// STILL JUDGED.
///
/// <para>
/// WHY TWO DOORS AND ONE FILE. A <c>slot</c> may be absent only if each layer that can refuse a request agrees, and they
/// are written in different places: the catalogue says WHICH argument on WHICH action the body answers for
/// (<see cref="FarmhandActionArgument.ResolvedAtExecution"/>); the acceptance layer
/// (<see cref="FarmhandExecutionAcceptance"/>) decides whether the request carries exactly what the row asks; the wire
/// parser (<see cref="BridgeProtocol.TryDeserializeExecutionRequest"/>) decides whether the frame is shaped like a request
/// at all. Any one of them left requiring the number makes the declaration a promise the caller cannot use, and the
/// failure is invisible: the frame is refused with <c>invalid_envelope</c> or <c>invalid_execution_request</c> - codes that
/// name neither the argument nor the action.
/// </para>
///
/// <para>
/// THE OTHER DIRECTION IS THE ONE THAT MATTERS MORE. A row that KEEPS its slot required must refuse an absent one at both
/// layers, or the omission would quietly widen to actions whose handler reads the caller's index: <c>fertilize_tile</c>
/// names which fertilizer is meant, <c>clear_debris</c> takes the tool from the named slot, <c>remove_fence</c> requires
/// the named slot to be the held one, <c>open_geode</c> names the geode by the slot's live item.
/// </para>
///
/// <para>
/// WHAT IS DRIVEN, NOT READ. Every case builds a real <see cref="BridgeExecutionArgs"/> or a real wire frame and calls the
/// production entry point, so a requirement nobody can satisfy fails as a REFUSAL of a frame this test sends rather than as
/// a missing substring in somebody's source.
/// </para>
/// </summary>
public sealed class ResolvedSlotExecutionAdmissionTests
{
    /// <summary>The catalogue's word for "the body answers for this argument", spelled once.</summary>
    private const string SlotArgument = "slot";

    private static FarmhandActionDescriptor DescriptorOf(string actionId)
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Should().ContainSingle(entry => entry.ActionId == actionId).Subject;
        registration.Descriptor.Should().NotBeNull($"{actionId} is an execution action");
        return registration.Descriptor!;
    }

    /// <summary>
    /// Whether <paramref name="actionId"/>'s own row declares its tool slot resolved at execution - read from the
    /// catalogue, so the assertions below never restate which action is which.
    /// </summary>
    private static bool ResolvesItsSlot(string actionId) => DescriptorOf(actionId).Arguments
        .Single(argument => argument.Name == SlotArgument).ResolvedAtExecution;

    /// <summary>
    /// A request carrying exactly <paramref name="actionId"/>'s declared arguments, with <c>slot</c> left out when
    /// <paramref name="withSlot"/> is false - the shape the plan compiler emits once the row grants the omission.
    /// </summary>
    private static BridgeExecutionArgs Request(string actionId, bool withSlot)
    {
        var values = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (FarmhandActionArgument argument in DescriptorOf(actionId).Arguments)
        {
            if (argument.Name == SlotArgument && !withSlot) continue;
            values[argument.Name] = argument.Name switch
            {
                "x" or "y" => 3,
                SlotArgument => 3,
                "expectedTargetId" => "target_0000000000000000",
                "expectedQualifiedItemId" => "(O)472",
                "charge" => 0,
                _ => throw new InvalidOperationException(
                    $"{actionId} declares '{argument.Name}', which this test cannot build; add its value rather than "
                        + "skipping the action, because an argument this test cannot build is one it cannot prove is admitted"),
            };
        }

        return new BridgeExecutionArgs
        {
            X = values.TryGetValue("x", out object? x) ? Convert.ToSingle(x) : null,
            Y = values.TryGetValue("y", out object? y) ? Convert.ToSingle(y) : null,
            Slot = values.TryGetValue(SlotArgument, out object? slot) ? Convert.ToInt32(slot) : null,
            ExpectedQualifiedItemId = values.TryGetValue("expectedQualifiedItemId", out object? item) ? (string?)item : null,
            ExpectedTargetId = values.TryGetValue("expectedTargetId", out object? target) ? (string?)target : null,
            Charge = values.TryGetValue("charge", out object? charge) ? Convert.ToInt32(charge) : null,
        };
    }

    private static bool Accepts(string actionId, BridgeExecutionArgs args, out string reasonCode) =>
        FarmhandExecutionAcceptance.TryValidate(DescriptorOf(actionId), args, out reasonCode);

    /// <summary>
    /// THE DECLARED OMISSION: a declared-tool action accepts a request that names no slot, and the number it DOES send is
    /// still bounded.
    /// </summary>
    /// <remarks>
    /// The names are the clearing family a measured plan could not compile (<c>cut_weeds</c>, <c>break_rock</c>,
    /// <c>remove_placed_item</c>) plus three the same declaration reached in the same pass. The population is not decided
    /// here: <paramref name="actionId"/> is held against the catalogue's own flag first, so an action whose declaration is
    /// withdrawn fails instead of passing on a stale expectation.
    /// </remarks>
    [Theory]
    [InlineData("cut_weeds")]
    [InlineData("break_rock")]
    [InlineData("remove_placed_item")]
    [InlineData("chop_tree")]
    [InlineData("break_container")]
    [InlineData("use_raft")]
    public void ADeclaredToolActionAcceptsARequestThatNamesNoSlot(string actionId)
    {
        ResolvesItsSlot(actionId).Should().BeTrue($"{actionId} declares its tool slot resolved at execution");

        Accepts(actionId, Request(actionId, withSlot: false), out string reasonCode)
            .Should().BeTrue($"{actionId}'s handler takes the slot its own tool: claim selects, so an absent one is not a "
                + $"malformed request; the acceptance layer answered {reasonCode}");
        reasonCode.Should().Be("accepted");

        // AND A NUMBER THAT IS SENT IS JUDGED EXACTLY AS IT ALWAYS WAS: the omission is legal, an index past the pack is not.
        BridgeExecutionArgs tooHigh = new()
        {
            X = 3,
            Y = 4,
            Slot = 99999,
            ExpectedTargetId = "target_0000000000000000",
        };
        Accepts(actionId, tooHigh, out reasonCode).Should().BeFalse($"{actionId} still bounds a slot it is given");
        reasonCode.Should().Be("invalid_execution_request");
    }

    /// <summary>
    /// THE KEPT SLOTS, one per reason a slot cannot be derived: an item the caller chooses, a tool taken from the named
    /// slot, a slot that must be the held one, and an item named by the slot's own contents.
    /// </summary>
    [Theory]
    [InlineData("fertilize_tile", "the caller chooses which fertilizer, so the slot names the stack")]
    [InlineData("clear_debris", "the handler takes the tool from the named slot, and the clump decides whether it fits")]
    [InlineData("remove_fence", "the named slot must BE the held one (`CurrentToolIndex == slot`)")]
    [InlineData("open_geode", "the geode is named by the slot's live item")]
    public void AnActionWhoseSlotIsTheCallersChoiceRefusesAnAbsentOne(string actionId, string because)
    {
        ResolvesItsSlot(actionId).Should().BeFalse($"{actionId} keeps its slot required: {because}");

        Accepts(actionId, Request(actionId, withSlot: false), out string reasonCode)
            .Should().BeFalse($"{because}, so a request that names none must be refused; it answered {reasonCode}");
        reasonCode.Should().Be("invalid_execution_request");

        Accepts(actionId, Request(actionId, withSlot: true), out reasonCode)
            .Should().BeTrue($"{actionId} must still accept the request it always accepted; it answered {reasonCode}");
    }

    /// <summary>
    /// THE WIRE'S OWN DOOR: a frame for a declared-tool action parses without the key, and one for an action that keeps its
    /// slot is still <c>invalid_envelope</c> without it.
    ///
    /// <para>
    /// THE PARSER IS THE FIRST GATE EVERY REQUEST PASSES, and it reads a fixed name list per action
    /// (<see cref="BridgeProtocol.ExecutionArgumentProperties"/>). While it demanded <c>slot</c> there, a node that left
    /// the number out - which the Host is now allowed to emit - could not be dispatched at all, and the answer named
    /// neither the argument nor the action.
    /// </para>
    /// </summary>
    [Fact]
    public void TheWireParserAdmitsAnAbsentSlotWhereTheRowDeclaresItAndRefusesItWhereItDoesNot()
    {
        BridgeProtocol.TryDeserializeExecutionRequest(
                Frame("cut_weeds", "{\"x\":30,\"y\":4,\"expectedTargetId\":\"target_0000000000000000\"}"),
                out BridgeEnvelope<BridgeExecutionRequest>? parsed,
                out string reasonCode)
            .Should().BeTrue($"cut_weeds declares its slot resolved at execution, so the frame must parse; it answered {reasonCode}");
        parsed!.Payload.Args.Slot.Should().BeNull("the frame named no slot, and the parser must not invent one");

        // THE SAME FRAME ON A ROW THAT KEEPS THE NUMBER: `remove_fence` requires the named slot to be the held one, so an
        // absence is a malformed request rather than an omission the body could answer.
        BridgeProtocol.TryDeserializeExecutionRequest(
                Frame("remove_fence", "{\"x\":30,\"y\":4,\"expectedTargetId\":\"target_0000000000000000\"}"),
                out _,
                out reasonCode)
            .Should().BeFalse("remove_fence keeps its slot required");
        reasonCode.Should().Be("invalid_envelope");

        // AND AN UNDECLARED NAME IS STILL MALFORMED beside a legal omission: the exact set narrows on ONE axis only.
        BridgeProtocol.TryDeserializeExecutionRequest(
                Frame("cut_weeds", "{\"x\":30,\"y\":4,\"expectedTargetId\":\"target_0000000000000000\",\"weeds\":3}"),
                out _,
                out reasonCode)
            .Should().BeFalse("an argument the action does not declare rides along");
        reasonCode.Should().Be("invalid_envelope");
    }

    /// <summary>
    /// THE CATALOGUE'S OWN RULE, in the two directions that can both be read without a handler.
    ///
    /// <para>
    /// ONE: a row that carries a <c>tool:</c> claim AND a <c>slot</c> resolves that slot, because the claim is exactly the
    /// question its handler asks the pack (<c>ResolveDeclaredTool</c>). That is the direction the clearing family was
    /// missing, and the population is derived from the rows themselves rather than listed here.
    /// </para>
    /// <para>
    /// TWO: a row that declares the omission names WHAT ITS BODY DERIVES THE INDEX FROM, and there are two producers - the
    /// tool its claim selects, or the item whose stack the body finds (<c>ResolveLiveSlot</c>, the planting pair's
    /// <c>expectedQualifiedItemId</c>). A row with neither would be promising an answer nothing could give, and this is
    /// what fails by name when one is written.
    /// </para>
    /// </summary>
    [Fact]
    public void TheFlagIsOnEveryRowThatCarriesAToolClaimAndOnNoRowThatNamesNoProducer()
    {
        FarmhandActionRegistration[] resolve = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor is { } descriptor
                && descriptor.Arguments.Any(argument => argument.Name == SlotArgument && argument.ResolvedAtExecution))
            .ToArray();
        resolve.Should().NotBeEmpty("the clearing family declares this omission");

        var mismatched = new List<string>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            FarmhandActionDescriptor? descriptor = registration.Descriptor;
            if (descriptor is null) continue;
            FarmhandActionArgument? slot = descriptor.Arguments.FirstOrDefault(argument => argument.Name == SlotArgument);
            if (slot is null) continue;
            bool claimsATool = descriptor.ResourceTemplate.Any(claim => claim.Key.StartsWith("tool:", StringComparison.Ordinal));
            bool namesAnItem = descriptor.Arguments.Any(argument =>
                string.Equals(argument.Name, "expectedQualifiedItemId", StringComparison.Ordinal));
            // A tool claim is the one producer whose handler resolves the index from the row alone, so a row that has one
            // cannot leave the omission undeclared; and a row that declares the omission must name a producer.
            if (claimsATool && !slot.ResolvedAtExecution)
                mismatched.Add($"{registration.ActionId}: declares a tool: claim and leaves {SlotArgument} mandatory, so a "
                    + "plan over a tile the snapshot does not publish cannot be written");
            if (slot.ResolvedAtExecution && !claimsATool && !namesAnItem)
                mismatched.Add($"{registration.ActionId}: resolves {SlotArgument} at execution but declares neither a tool: "
                    + "claim nor the item its body would find the stack by");
        }

        mismatched.Should().BeEmpty("the two directions of one declaration: {0}", string.Join("; ", mismatched));
        resolve.Select(registration => registration.ActionId)
            .Should().Contain(
                new[] { "cut_weeds", "break_rock", "remove_placed_item", "break_container", "clear_cask", "toggle_tool_light" },
                "the actions the measured plan could not compile are the ones this declaration was written for");
    }

    /// <summary>One serialized <c>execution_request</c> frame whose <c>args</c> object is written verbatim.</summary>
    private static string Frame(string action, string args)
    {
        var request = new BridgeExecutionRequest(
            "req_" + action,
            "idem_" + action,
            action,
            new BridgeExecutionArgs { X = 30, Y = 4, ExpectedTargetId = "target_0000000000000000" },
            ExpectedRevision: 7,
            DeadlineMs: 30_000);
        var envelope = new BridgeEnvelope<BridgeExecutionRequest>(
            BridgeProtocol.Version,
            "msg_" + action,
            "corr_" + action,
            1_000L,
            new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01"),
            "execution_request",
            request);

        BridgeProtocol.TrySerialize(envelope, out string json, out string reason).Should().BeTrue(reason);
        JsonNode frame = JsonNode.Parse(json)!;
        frame["payload"]!["args"] = JsonNode.Parse(args);
        return frame.ToJsonString();
    }
}
