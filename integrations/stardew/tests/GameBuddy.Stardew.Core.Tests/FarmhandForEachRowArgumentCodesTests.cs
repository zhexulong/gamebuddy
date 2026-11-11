using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// `row_argument_missing` and `row_argument_unknown` are two answers about ONE question - is this name declared by THIS
/// action - so no name may produce both.
///
/// <para>
/// MEASURED 2026-11-11 (`round45`): the same field name `slot` appeared as <c>row_argument_missing:slot</c> on seven
/// `cut_weeds` rows and as <c>row_argument_unknown:slot</c> on a `till_soil` row, and the reader of that run could only
/// conclude that the argument vocabulary was inconsistent. It is not: `slot` is declared by `cut_weeds` and by nothing
/// `till_soil` declares, so BOTH codes were true for their own action - what the run actually taught was that a caller may
/// not generalise one action's argument list onto another's. That is a fact about the catalogue, and this gate holds every
/// published action to it rather than the two that were measured.
/// </para>
/// <para>
/// POPULATION: every action <see cref="FarmhandActionCatalog.Registrations"/> publishes, derived rather than listed, and
/// every argument name the catalogue declares anywhere - so an action added tomorrow is examined without anyone
/// remembering to add it, and an action that stops declaring a name is examined in the other direction.
/// </para>
/// </summary>
public sealed class FarmhandForEachRowArgumentCodesTests
{
    /// <summary>
    /// THE GATE. For every published action and every name the catalogue uses: withholding a DECLARED name answers
    /// <c>row_argument_missing:&lt;name&gt;</c> and never <c>unknown</c>; carrying an UNDECLARED name answers
    /// <c>row_argument_unknown:&lt;name&gt;</c> and never <c>missing</c>. One question, one answer, per action.
    /// </summary>
    [Fact]
    public void NoArgumentNameIsEverBothMissingAndUnknownForOneAction()
    {
        string[] everyName = FarmhandActionCatalog.Registrations
            .SelectMany(registration => registration.Descriptor?.Arguments ?? Array.Empty<FarmhandActionArgument>())
            .Select(argument => argument.Name)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        var failures = new List<string>();
        var passedOver = new List<string>();
        int examined = 0;
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            FarmhandActionDescriptor? descriptor = registration.Descriptor;
            if (descriptor is null) continue;
            examined += 1;
            string[] declared = descriptor.Arguments.Select(argument => argument.Name).ToArray();
            // The three names the PASS supplies: the row's tile and the identity it mints. A `do` that also writes one is
            // refused as `row_argument_reserved`, which is a third answer about a third question.
            Dictionary<string, string> supplied = new(StringComparer.Ordinal);
            foreach (FarmhandActionArgument argument in descriptor.Arguments)
            {
                if (argument.Name is "x" or "y" or FarmhandForEachArguments.ExpectedTargetIdArgument) continue;
                if (CanonicalValueFor(argument) is { } value)
                {
                    supplied[argument.Name] = value;
                    continue;
                }
                // AN ARGUMENT THIS PASS CANNOT LIFT HAS NO PROBE. `navigate_to_destination` declares a destination selector,
                // which is not a canonical scalar, so every row over it is answered `row_argument_invalid` before either
                // code is reached - a different question, and naming it here is better than bending the gate around it.
                passedOver.Add(string.Create(
                    CultureInfo.InvariantCulture,
                    $"{registration.ActionId}:{argument.Name}:{argument.Type}"));
                supplied.Clear();
                break;
            }
            if (supplied.Count == 0) continue;

            foreach (string name in declared.Where(name => supplied.ContainsKey(name)))
            {
                var withheld = new FarmhandForEachTarget(
                    registration.ActionId,
                    60,
                    18,
                    supplied.Where(entry => !string.Equals(entry.Key, name, StringComparison.Ordinal))
                        .ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal));
                string code = Refusal(withheld);
                if (code == $"row_argument_missing:{name}") continue;
                failures.Add(string.Create(
                    CultureInfo.InvariantCulture,
                    $"row_argument_codes_overlap:{registration.ActionId}:{name} "
                    + $"(a declared argument withheld answered `{code}`, not row_argument_missing:{name})"));
            }

            foreach (string name in everyName.Where(name =>
                         Array.IndexOf(declared, name) < 0
                         && name is not ("x" or "y" or FarmhandForEachArguments.ExpectedTargetIdArgument)))
            {
                var carried = new FarmhandForEachTarget(
                    registration.ActionId,
                    60,
                    18,
                    new Dictionary<string, string>(supplied, StringComparer.Ordinal) { [name] = "0" });
                string code = Refusal(carried);
                if (code == $"row_argument_unknown:{name}") continue;
                failures.Add(string.Create(
                    CultureInfo.InvariantCulture,
                    $"row_argument_codes_overlap:{registration.ActionId}:{name} "
                    + $"(an undeclared argument carried answered `{code}`, not row_argument_unknown:{name})"));
            }
        }

        everyName.Should().NotBeEmpty("the catalogue declares argument names, so the population is never empty");
        examined.Should().BeGreaterThan(0, "the catalogue publishes actions, so the population is never empty");
        failures.Should().BeEmpty(
            $"one name answers one question per action; examined {examined} actions over {everyName.Length} argument names"
            + $", passed over {passedOver.Count} names this pass cannot lift: {string.Join(", ", passedOver)}");
    }

    private static string Refusal(FarmhandForEachTarget target)
    {
        bool lifted = RouteReenteringBodyProgramExecutor.TryBuildRowArguments(
            new NamingWorld(),
            target,
            target.ActionId,
            out _,
            out _,
            out string reasonCode);
        return lifted ? "accepted" : reasonCode;
    }

    /// <summary>
    /// The value a row would write for this argument, or null when the pass cannot lift it at all.
    ///
    /// ASKED OF THE CANONICALIZER THE PASS ITSELF CALLS, so a type added to the catalogue is examined here the moment it
    /// can be lifted - and a type that cannot be is named as passed over rather than guessed at.
    /// </summary>
    private static string? CanonicalValueFor(FarmhandActionArgument argument) =>
        new[] { "0", "x", "true" }.FirstOrDefault(candidate =>
            RouteReenteringBodyProgramExecutor.TryCanonicalizeArgument(argument.Type, candidate, out _));

    /// <summary>
    /// The farm as far as argument lifting is concerned: it can name every family, so the only refusals these probes meet
    /// are the two about the caller's OWN names.
    /// </summary>
    private sealed class NamingWorld : IFarmhandForEachWorld
    {
        public FarmhandForEachRow? ReadRow(int x, int y, int localColumn, int localRow) => null;

        public string? ActionForKind(string kind) => null;

        public string? TargetIdFor(string family, int x, int y, IReadOnlyDictionary<string, string>? declaredArguments) =>
            string.Create(CultureInfo.InvariantCulture, $"{family}_{x}_{y}");

        public bool CanNameFamily(string family) => true;

        public string? RowIdentityRefusalFor(string family) => null;

        public bool IsActionEnabled(string actionId) => true;

        public bool StopRequested => false;
    }
}
