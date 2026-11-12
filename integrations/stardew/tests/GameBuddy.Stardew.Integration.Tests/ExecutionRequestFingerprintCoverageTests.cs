using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Sdk;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The idempotency fingerprint must cover EVERY argument each action declares, because it is the
/// only thing standing between "the same request arrived twice" and "one idempotency key was
/// reused for a different intent".
///
/// WHY THIS EXISTS. `BridgeSession.TryExecute` answers a remembered `idempotencyKey` with the
/// stored receipt only when the fingerprint matches, and refuses with `idempotency_key_conflict`
/// otherwise. The material used to be a hand-written subset per action - requestId, action, x, y,
/// slot, two item/target ids, the scene binding and the expected revision, plus three per-action
/// special cases. Everything else an action can declare was invisible to it: `chestId` (WHICH
/// container), `text` (which chat line), `quantity` (how many), `leftSlot`/`rightSlot` (which
/// tailoring pair), `colorSelection`, `tool`, `buildingType`, `choice`/`expectedSkill`/
/// `expectedLevel`, `responseKey`. `send_multiplayer_chat` declares exactly one argument - `text` -
/// and the fingerprint could not see it, so two different chat lines under one key compared EQUAL.
///
/// The narrowing was invisible in the descriptor and on the wire: only this material decides. So
/// the population here is the registry itself - every execution action, every argument that action
/// declares - and the assertion is the PROPERTY, not today's names: change any declared argument
/// and the material must change with it. An argument added to the catalog is covered by the same
/// assertion without anyone editing this file.
/// </summary>
public sealed class ExecutionRequestFingerprintCoverageTests
{
    /// <summary>
    /// One entry per (action, declared argument). The population is the catalog's own execution
    /// registrations, so an action that gains an argument gains a case here automatically.
    /// </summary>
    public static IEnumerable<object[]> DeclaredArguments() =>
        ExecutionActions()
            .SelectMany(registration => registration.Descriptor!.Arguments
                .Select(argument => new object[] { registration.ActionId, argument.Name }));

    [Theory]
    [MemberData(nameof(DeclaredArguments))]
    public void ChangingAnyDeclaredArgumentChangesTheFingerprint(string actionId, string argumentName)
    {
        FarmhandActionDescriptor descriptor = Descriptor(actionId);
        BridgeExecutionRequest baseline = RequestFor(actionId, descriptor);
        BridgeExecutionRequest changed = baseline with { Args = Perturb(argumentName, baseline.Args) };

        ExecutionRequestFingerprint.Of(changed).Should().NotBe(
            ExecutionRequestFingerprint.Of(baseline),
            $"{actionId} declares '{argumentName}', so a request that differs in it is a DIFFERENT request. Two "
            + "requests sharing a fingerprint are answered as one: the second is handed the first's receipt "
            + "(idempotent_replay / request_id_conflict) and its own intent is never dispatched. The material must be "
            + "derived from the request's declared argument set, not from a hand-written subset of it.");
    }

    /// <summary>
    /// The OTHER direction, and the reason the material must not grow a field the request does not
    /// declare: a byte-identical retry - the only resend a caller may make - must keep the SAME
    /// fingerprint, or an honest retry is refused as a conflict instead of being answered with the
    /// receipt it is owed.
    /// </summary>
    [Fact]
    public void AnIdenticalRequestKeepsItsFingerprint()
    {
        foreach (FarmhandActionRegistration registration in ExecutionActions())
        {
            BridgeExecutionRequest request = RequestFor(registration.ActionId, registration.Descriptor!);
            // A fresh instance carrying the same values, exactly as a re-deserialized retry arrives.
            BridgeExecutionRequest rebuilt = request with { Args = Copy(request.Args) };

            ExecutionRequestFingerprint.Of(rebuilt).Should().Be(
                ExecutionRequestFingerprint.Of(request),
                $"{registration.ActionId} must fingerprint an identical retry identically. A material derived from "
                + "something outside the request - a clock, a deadline, a counter, a live game fact - turns an honest "
                + "retry into a conflict and the action can never be completed.");
        }
    }

    /// <summary>
    /// A material collapsed to `{requestId}:{action}` would still separate the two requests the test
    /// above compares; what makes the coverage assertion meaningful is that the request's own
    /// identity and revision separate them too.
    /// </summary>
    [Fact]
    public void TheRequestIdentityAndRevisionSeparateRequests()
    {
        FarmhandActionRegistration registration = ExecutionActions().First();
        BridgeExecutionRequest baseline = RequestFor(registration.ActionId, registration.Descriptor!);
        string material = ExecutionRequestFingerprint.Of(baseline);

        ExecutionRequestFingerprint.Of(baseline with { RequestId = baseline.RequestId + "_other" })
            .Should().NotBe(material, "a different request identity is a different request");
        ExecutionRequestFingerprint.Of(baseline with { ExpectedRevision = baseline.ExpectedRevision + 1 })
            .Should().NotBe(material, "a different snapshot revision is a different dispatch");
    }

    /// <summary>
    /// Guards on the test itself: the population must be the registry's whole execution surface, and
    /// every execution registration must carry the descriptor this file reads its arguments from.
    /// </summary>
    [Fact]
    public void TheCoverageIsNotEmptyAndEveryExecutionActionCarriesADescriptor()
    {
        List<FarmhandActionRegistration> executions = ExecutionActions().ToList();
        executions.Should().NotBeEmpty();
        executions.Select(registration => registration.ActionId).Should().OnlyHaveUniqueItems();

        foreach (FarmhandActionRegistration registration in executions)
        {
            registration.Descriptor.Should().NotBeNull(
                $"{registration.ActionId} is an execution action, so its declared arguments are the population this "
                + "test must cover");
            registration.Descriptor!.Arguments.Should().NotBeNull();
            DeclaredArguments().Should().NotBeEmpty();
        }
    }

    // -------------------------------------------------------------------------------------------
    // Harness
    // -------------------------------------------------------------------------------------------

    private static IEnumerable<FarmhandActionRegistration> ExecutionActions() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Kind == FarmhandOperationKind.Execution)
            .OrderBy(registration => registration.ActionId, StringComparer.Ordinal);

    private static FarmhandActionDescriptor Descriptor(string actionId) =>
        FarmhandActionCatalog.Registrations
            .Single(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal))
            .Descriptor!;

    private static BridgeExecutionRequest RequestFor(string actionId, FarmhandActionDescriptor descriptor) =>
        new(
            "req_fingerprint_0000000000",
            "idem_fingerprint_0000000000",
            actionId,
            BuildArgs(descriptor),
            ExpectedRevision: 7,
            DeadlineMs: 1_000);

    /// <summary>
    /// A request carrying exactly the descriptor's declared arguments, plus its scene binding. These
    /// values never reach acceptance - this file exercises the identity material alone - so each one
    /// only has to be DISTINCT and derived from what the action declares about itself. The switch
    /// throws for an unknown name so a newly declared argument cannot silently drop out of the
    /// population.
    /// </summary>
    private static BridgeExecutionArgs BuildArgs(FarmhandActionDescriptor descriptor)
    {
        float? x = null;
        float? y = null;
        int? slot = null;
        int? quantity = null;
        int? leftSlot = null;
        int? rightSlot = null;
        int? colorSelection = null;
        int? expectedSkill = null;
        int? expectedLevel = null;
        int? charge = null;
        string? chestId = null;
        string? expectedQualifiedItemId = null;
        string? expectedTargetId = null;
        string? buildingType = null;
        string? tool = null;
        string? emote = null;
        string? direction = null;
        string? responseKey = null;
        string? choice = null;
        string? text = null;
        BridgeNavigationDestinationSelector? destination = null;

        foreach (FarmhandActionArgument argument in descriptor.Arguments)
        {
            switch (argument.Name)
            {
                case "x": x = 3; break;
                case "y": y = 4; break;
                case "slot": slot = 2; break;
                case "quantity": quantity = 5; break;
                case "leftSlot": leftSlot = 6; break;
                case "rightSlot": rightSlot = 7; break;
                case "colorSelection": colorSelection = 8; break;
                case "expectedSkill": expectedSkill = 1; break;
                case "expectedLevel": expectedLevel = 9; break;
                case "charge": charge = 3; break;
                case "chestId": chestId = "chest_0000000000000000"; break;
                case "expectedQualifiedItemId": expectedQualifiedItemId = descriptor.Acceptance?.ExactExpectedQualifiedItemId ?? "(O)472"; break;
                case "expectedTargetId": expectedTargetId = "target_0000000000000000"; break;
                case "buildingType": buildingType = "Coop"; break;
                case "tool": tool = First(argument, "axe"); break;
                case "emote": emote = First(argument, "happy"); break;
                case "direction": direction = First(argument, "up"); break;
                case "responseKey": responseKey = "yes"; break;
                case "choice": choice = First(argument, "confirm"); break;
                case "text": text = "hello farm"; break;
                case "destination": destination = new BridgeNavigationDestinationSelector("label", "Farm", null); break;
                default:
                    throw new XunitException(
                        $"{descriptor.Postcondition}: argument '{argument.Name}' exists in the registry but this file "
                        + "does not know it. Teach the fingerprint coverage test to build it - an argument it cannot build "
                        + "is an argument whose participation in the identity material is unproven.");
            }
        }

        return new BridgeExecutionArgs
        {
            X = x,
            Y = y,
            Slot = slot,
            Quantity = quantity,
            LeftSlot = leftSlot,
            RightSlot = rightSlot,
            ColorSelection = colorSelection,
            ExpectedSkill = expectedSkill,
            ExpectedLevel = expectedLevel,
            Charge = charge,
            ChestId = chestId,
            ExpectedQualifiedItemId = expectedQualifiedItemId,
            ExpectedTargetId = expectedTargetId,
            BuildingType = buildingType,
            Tool = tool,
            Emote = emote,
            Direction = direction,
            ResponseKey = responseKey,
            Choice = choice,
            Text = text,
            Destination = destination,
        };
    }

    /// <summary>A closed set is authoritative when the action declares one.</summary>
    private static string First(FarmhandActionArgument argument, string fallback) =>
        argument.Enum is { Count: > 0 } allowed ? allowed[0] : fallback;

    /// <summary>
    /// The same request with exactly one declared argument carrying a different value. The value is
    /// changed through the argument's OWN wire property - named after the argument, the exact-shape
    /// contract - so a declared argument with no wire property fails loudly here instead of quietly
    /// proving nothing. Acceptance is not consulted: this asserts identity, and the value only has
    /// to be a different value of the declared type.
    /// </summary>
    private static BridgeExecutionArgs Perturb(string argumentName, BridgeExecutionArgs args)
    {
        PropertyInfo property = ArgsProperty(char.ToUpperInvariant(argumentName[0]) + argumentName[1..]);
        BridgeExecutionArgs clone = Copy(args);
        property.SetValue(clone, Different(property.PropertyType, property.GetValue(args), argumentName));
        return clone;
    }

    /// <summary>
    /// The wire property one declared argument is carried by, named after the argument itself (the
    /// exact-shape acceptance contract is what makes that true). A declared argument with no such
    /// property fails loudly here instead of quietly proving nothing.
    /// </summary>
    private static PropertyInfo ArgsProperty(string propertyName) =>
        typeof(BridgeExecutionArgs).GetProperty(propertyName, BindingFlags.Public | BindingFlags.Instance)
        ?? throw new XunitException(
            $"'{propertyName}' has no wire property on {nameof(BridgeExecutionArgs)}, so a request cannot carry it and "
            + "its identity participation cannot be exercised.");

    private static object Different(Type type, object? current, string argumentName) => type switch
    {
        _ when type == typeof(float?) => (current is float coordinate ? coordinate : 0f) + 1f,
        _ when type == typeof(int?) => (current is int number ? number : 0) + 1,
        _ when type == typeof(string) => (string?)current + "_other",
        _ when type == typeof(BridgeNavigationDestinationSelector) =>
            (BridgeNavigationDestinationSelector)current! with
            {
                Label = ((BridgeNavigationDestinationSelector)current!).Label + "_other",
            },
        _ => throw new XunitException(
            $"'{argumentName}' has wire type {type.Name}, which this test has no perturbation for. Add one rather than "
            + "skipping the argument: an argument it cannot change is an argument whose absence from the identity "
            + "material it cannot detect."),
    };

    /// <summary>
    /// A fresh args instance carrying the SAME values. Every public property is copied by
    /// reflection, so a wire property added later is copied too and the two sides of a comparison can
    /// never differ by an accident of this harness.
    /// </summary>
    private static BridgeExecutionArgs Copy(BridgeExecutionArgs source)
    {
        var clone = new BridgeExecutionArgs();
        foreach (PropertyInfo property in typeof(BridgeExecutionArgs).GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (property.Name == nameof(BridgeExecutionArgs.AdditionalProperties))
            {
                continue;
            }

            property.SetValue(clone, property.GetValue(source));
        }

        return clone;
    }
}
