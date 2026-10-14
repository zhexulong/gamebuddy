using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Every registered action must accept a request built from ITS OWN declared arguments, and
/// must refuse a value outside each argument's own rule.
///
/// WHY THIS EXISTS. The acceptance contract enumerates arguments in two separate places:
/// <c>HasExactArgumentShape</c> compares one boolean per argument name, and
/// <c>IsValidArgumentValue</c> is a switch whose default is <c>false</c>. A newly declared
/// argument added to NEITHER is treated as an ILLEGAL argument, so every request using it is
/// rejected with <c>invalid_execution_request</c> — while the descriptor, the wire shape and the
/// schema all look complete. That is exactly what happened to shop_purchase's <c>quantity</c>,
/// and it cost live rounds because the failure surfaced as a misleading rejection rather than as
/// a missing registration.
///
/// The promotion gate cannot catch it: it verifies that registration SITES exist, not that the
/// declared arguments are accepted.
///
/// The two halves are deliberately paired. Acceptance alone would still pass if a rule were
/// widened to accept anything — measured: mutating the emote closed-set check and the quantity
/// bound to permissive each left the acceptance half green. So each argument must also refuse a
/// value outside its rule.
///
/// Every value is derived from what the ACTION declares about itself. Where an action's facts
/// narrow an argument in a way its declared TYPE cannot express — machine_load wants exactly
/// (O)433, place_wood_fence (O)322, and a closed set lives on the argument's Enum — the value
/// comes from the descriptor. Choosing without reading it produces a value the action correctly
/// refuses, which is how seven of these cases failed the first time this test ran.
/// </summary>
public sealed class DeclaredArgumentAcceptanceTests
{
    /// <summary>The product's bound on `build_farm_building`'s `buildingType`
    /// (farmhandexecutionacceptance.cs: `Length is > 0 and &lt;= 128`), mirrored here so the
    /// perturbation can go one past it.</summary>
    private const int BuildingTypeMaximumLength = 128;

    // ---------------------------------------------------------------------------------------
    // Value derivation
    // ---------------------------------------------------------------------------------------

    /// <summary>A value this action will accept, derived from what the action declares.</summary>
    private static string RepresentativeValueFor(FarmhandActionDescriptor descriptor, FarmhandActionArgument argument)
    {
        // A closed set is authoritative when present: "wave" is not an emote and is refused.
        if (argument.Enum is { Count: > 0 } allowed)
        {
            return allowed[0];
        }

        return argument.Type switch
        {
            "integer" => argument.Name == "slot" ? "0" : "1",
            "string" => argument.Name switch
            {
                // The EXACT pin, when the action declares one. Invisible in the declared type.
                "expectedQualifiedItemId" => descriptor.Acceptance?.ExactExpectedQualifiedItemId ?? "(O)472",
                // Opaque ids are [A-Za-z0-9_-]{1,128}; a 16-hex suffix matches production shape.
                "expectedTargetId" => "test_0000000000000000",
                "responseKey" => "yes",
                // A Data/Buildings type id: non-blank, within the 1..128 bound.
                "buildingType" => "Coop",
                // One native chat line. Any non-blank text within the bound is valid; the bound itself is what
                // the invalid case below perturbs.
                "text" => "hello farm",                _ => "value",
            },
            // A structured selector, not a scalar; BuildArgs constructs the real value.
            "destination_selector" => "label",
            _ => throw new Xunit.Sdk.XunitException(
                $"{descriptor.Postcondition}: argument '{argument.Name}' has type '{argument.Type}', which this test cannot build. "
                + "Add a case here rather than skipping the action: an argument this test cannot build is an argument it cannot prove is accepted."),
        };
    }

    /// <summary>
    /// The values that must be REFUSED for this argument, empty when no single-argument
    /// perturbation expresses the rule. A TWO-SIDED bound needs both halves violated, so this is a
    /// list rather than one value; the coverage test below reports what is unperturbable rather
    /// than pretending to cover it.
    /// </summary>
    private static IReadOnlyList<string> InvalidValuesFor(FarmhandActionArgument argument)
    {
        if (argument.Enum is { Count: > 0 })
        {
            return new[] { "not_a_declared_member" };
        }
        return argument.Type switch
        {
            "integer" => argument.Name switch
            {
                "quantity" => new[] { "0" },    // nothing may ask for zero units
                "slot" => new[] { "99999" },    // far outside MaximumInventorySlot
                _ => new[] { "-1" },            // below the coordinate floor
            },
            "string" => argument.Name switch
            {
                // An opaque id forbids characters outside [A-Za-z0-9_-] and forbids emptiness.
                "expectedTargetId" => new[] { "not a valid id!" },
                // The rule is `Length is > 0 && Length <= 128`, so BOTH halves are perturbed: a
                // blank type id is refused because a building type cannot be empty, and one past
                // the bound is refused because a longer id is too long.
                "buildingType" => new[] { string.Empty, new string('x', BuildingTypeMaximumLength + 1) },
                // One character past the bound the wire and the handler both read. Emptiness is the rule's other
                // half and is covered where it belongs: the action's own test suite has
                // Refusal_EmptyOrBlankText_IsChatMessageInvalid, so this perturbation spends itself on the bound.
                "text" => new[] { new string('x', GameBuddy.Stardew.Core.Policy.FarmhandActionCatalog.ChatMessageMaximumLength + 1) },
                _ => new[] { string.Empty },
            },
            // kind "label" tolerates neither a null label nor a non-null ref.
            "destination_selector" => new[] { "label-with-ref" },
            _ => Array.Empty<string>(),
        };
    }

    /// <summary>
    /// Build the wire args. The properties are init-only, so the values are gathered first and
    /// the object is built once. The switch is explicit so a NEW argument name fails loudly
    /// here — the same place shop_purchase's quantity was silently missing from the product.
    /// </summary>
    private static BridgeExecutionArgs BuildArgs(
        FarmhandActionDescriptor descriptor,
        IReadOnlyList<(string Name, string Value)> declared,
        string? overrideName = null,
        string? overrideValue = null)
    {
        float? x = null;
        float? y = null;
        int? slot = null;
        int? quantity = null;
        int? leftSlot = null;
        int? colorSelection = null;
        int? rightSlot = null;
        string? expectedQualifiedItemId = null;
        string? expectedTargetId = null;
        string? tool = null;
        string? emote = null;
        string? direction = null;
        string? responseKey = null;
        string? text = null;
        string? buildingType = null;
        BridgeNavigationDestinationSelector? destination = null;

        foreach ((string name, string value) in declared)
        {
            string effective = overrideName is not null && name == overrideName ? overrideValue! : value;
            switch (name)
            {
                case "x": x = int.Parse(effective); break;
                case "y": y = int.Parse(effective); break;
                case "slot": slot = int.Parse(effective); break;
                case "leftSlot": leftSlot = int.Parse(effective); break;
                case "colorSelection": colorSelection = int.Parse(effective); break;
                case "rightSlot": rightSlot = int.Parse(effective); break;
                case "quantity": quantity = int.Parse(effective); break;
                case "expectedQualifiedItemId": expectedQualifiedItemId = effective; break;
                case "expectedTargetId": expectedTargetId = effective; break;
                case "tool": tool = effective; break;
                case "emote": emote = effective; break;
                case "direction": direction = effective; break;
                case "responseKey": responseKey = effective; break;
                case "text": text = effective; break;
                case "buildingType": buildingType = effective; break;
                case "destination":
                    // The only label-shaped combination the converter accepts carries the label
                    // and no ref; the invalid case sends both.
                    destination = effective == "label-with-ref"
                        ? new BridgeNavigationDestinationSelector("label", "Farm", "dr1_0000000000000000")
                        : new BridgeNavigationDestinationSelector("label", "Farm", null);
                    break;
                default:
                    throw new Xunit.Sdk.XunitException(
                        $"argument '{name}' exists in the registry but this test does not know it. Add it here AND to "
                        + "FarmhandExecutionAcceptance's HasExactArgumentShape and IsValidArgumentValue. An argument the acceptance "
                        + "layer does not know is rejected as illegal rather than ignored, which is how shop_purchase's quantity "
                        + "was rejected with invalid_execution_request after looking fully declared.");
            }
        }

        return new BridgeExecutionArgs
        {
            X = x,
            Y = y,
            Slot = slot,
            LeftSlot = leftSlot,
            ColorSelection = colorSelection,
            RightSlot = rightSlot,
            Quantity = quantity,
            ExpectedQualifiedItemId = expectedQualifiedItemId,
            ExpectedTargetId = expectedTargetId,
            Tool = tool,
            Emote = emote,
            Direction = direction,
            ResponseKey = responseKey,
            Text = text,
            BuildingType = buildingType,
            Destination = destination,
            // A descriptor declaring a scene binding must receive a well-formed one: the
            // acceptance layer validates it as its own contract member, so omitting it fails
            // with observation_binding_malformed rather than a missing-argument error.
            SceneTarget = descriptor.SceneTarget is null
                ? null
                : new ObservationBindingV1("obs_0000000000000000", "ref_0000000000000000"),
        };
    }

    private static bool Accept(FarmhandActionDescriptor descriptor, BridgeExecutionArgs args, out string reasonCode) =>
        FarmhandExecutionAcceptance.TryValidate(
            descriptor,
            args,
            out reasonCode,
            destinationValidator: destination => NavigationDestinationSelector.TryCreateFromWire(destination, out _));

    // ---------------------------------------------------------------------------------------
    // Acceptance: each declared argument is understood
    // ---------------------------------------------------------------------------------------

    public static IEnumerable<object[]> RegisteredExecutions() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Kind == FarmhandOperationKind.Execution)
            .Select(registration => new object[] { registration.ActionId });

    [Theory]
    [MemberData(nameof(RegisteredExecutions))]
    public void DeclaredArguments_AreAcceptedByTheAcceptanceLayer(string actionId)
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(candidate => string.Equals(candidate.ActionId, actionId, StringComparison.Ordinal));
        registration.Should().NotBeNull();
        FarmhandActionDescriptor? descriptor = registration!.Descriptor;
        descriptor.Should().NotBeNull($"{actionId} is an execution action, so it must carry a descriptor");

        var declared = descriptor!.Arguments
            .Select(argument => (argument.Name, RepresentativeValueFor(descriptor, argument)))
            .ToList();
        BridgeExecutionArgs args = BuildArgs(descriptor, declared);

        bool accepted = Accept(descriptor, args, out string reasonCode);

        accepted.Should().BeTrue(
            $"{actionId} must accept a request carrying exactly its declared arguments; the acceptance layer answered '{reasonCode}'. "
            + "A newly declared argument must be added to BOTH HasExactArgumentShape and IsValidArgumentValue — the switch defaults to "
            + "false, so an unlisted name is rejected as illegal.");
    }

    // ---------------------------------------------------------------------------------------
    // Enforcement: each declared argument's rule actually refuses what it excludes
    // ---------------------------------------------------------------------------------------

    public static IEnumerable<object[]> PerturbableArguments() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Kind == FarmhandOperationKind.Execution && registration.Descriptor is not null)
            .SelectMany(registration => registration.Descriptor!.Arguments
                .SelectMany(argument => InvalidValuesFor(argument)
                    .Select(invalid => new object[] { registration.ActionId, argument.Name, invalid })));

    [Theory]
    [MemberData(nameof(PerturbableArguments))]
    public void DeclaredArguments_RefuseAValueOutsideTheirRule(string actionId, string argumentName, string invalid)
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .First(candidate => string.Equals(candidate.ActionId, actionId, StringComparison.Ordinal));
        FarmhandActionDescriptor descriptor = registration.Descriptor!;

        FarmhandActionArgument target = descriptor.Arguments.First(argument => argument.Name == argumentName);
        InvalidValuesFor(target).Should().Contain(
            invalid,
            $"'{invalid}' must be a value this test derives for {actionId}.{argumentName}");

        var declared = descriptor.Arguments
            .Select(argument => (argument.Name, RepresentativeValueFor(descriptor, argument)))
            .ToList();
        BridgeExecutionArgs args = BuildArgs(descriptor, declared, overrideName: argumentName, overrideValue: invalid);

        bool accepted = Accept(descriptor, args, out string reasonCode);

        accepted.Should().BeFalse(
            $"{actionId} must REFUSE '{argumentName}' = '{invalid}', but the acceptance layer accepted it. "
            + "An argument whose rule accepts anything is not enforcing its declared bound or closed set.");
        reasonCode.Should().Be("invalid_execution_request");
    }

    // ---------------------------------------------------------------------------------------
    // Guards on the tests themselves
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void TheTestActuallyExercisesEveryExecutionAction()
    {
        int executions = FarmhandActionCatalog.Registrations
            .Count(registration => registration.Kind == FarmhandOperationKind.Execution);
        executions.Should().BeGreaterThan(30, "the registry exposes the whole action surface");

        // An explicit loop because FluentAssertions takes this predicate as an EXPRESSION TREE,
        // which cannot contain a pattern-matching `is`.
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations
                     .Where(candidate => candidate.Kind == FarmhandOperationKind.Execution))
        {
            registration.Descriptor.Should().NotBeNull(
                $"{registration.ActionId} is an execution action, so it must carry a descriptor for this test to exercise it.");
        }
    }

    [Fact]
    public void ThePerturbationTestCoversEveryArgumentThatHasARule()
    {
        var declarations = FarmhandActionCatalog.Registrations
            .Where(r => r.Kind == FarmhandOperationKind.Execution && r.Descriptor is not null)
            .SelectMany(r => r.Descriptor!.Arguments.Select(a => (r.ActionId, Argument: a)))
            .ToList();
        declarations.Should().NotBeEmpty();

        List<string> uncovered = declarations
            .Where(d => InvalidValuesFor(d.Argument).Count == 0)
            .Select(d => d.ActionId + "." + d.Argument.Name)
            .ToList();

        // If a new argument type appears below, add its rule rather than letting it quietly drop
        // out of the perturbation half of this file.
        uncovered.Should().BeEmpty(
            "these declared arguments have no rule this test can violate, so their enforcement would be unverified: "
            + string.Join(", ", uncovered));
    }
}
