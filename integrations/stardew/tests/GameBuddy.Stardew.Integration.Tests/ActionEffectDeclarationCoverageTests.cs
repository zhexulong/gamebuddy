using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// AN EFFECT IS ONLY DECLARED WHEN THE MOD CAN OBSERVE IT: `moves_actor` names the state the executor writes,
/// `requires_place` the predicate the handler already refuses with, `consumes` the refusal it already answers when the
/// resource is absent, and `produces` a fact a receipt already proves.
///
/// <para>
/// WHY. A Body Program's dependency edges are "the same (x, y) tile" and nothing more
/// (<c>host/src/body-program-script.ts</c>), so a step on a different tile consumes nothing of an earlier one. Four
/// patches live in that compiler for the one blindness - <c>planWalkToRefusedExit</c>, <c>planSeedCounts</c>,
/// <c>planWaterBudget</c> and the orphan refusal - and every one of them is a pair of action ids written where nothing
/// could check it against this catalogue. <see cref="FarmhandActionEffects"/> is the declaration that replaces them;
/// this gate is what keeps a declaration from being prose.
/// </para>
///
/// <para>
/// THE POPULATION IS THE CATALOGUE, and it prints its own size: <c>descriptors D · with effects E · effects E_total ·
/// classes used ...</c>. Every registration is examined, including the ones the Agent surface has not admitted - the
/// declaration lives on the ROW, so the row is what this reads - and a row that states neither an effect nor a reason for
/// having none fails by name rather than passing as an empty list.
/// </para>
///
/// <para>
/// THE SEAM IS READ FROM ITS OWN AUTHORITY, never from a table here: the handler body for the three classes that are
/// answered by a refusing site or a write, the descriptor's own postcondition and output facts for the class a receipt
/// proves. A handler that hands its whole decision to one controller method is read one hop further
/// (<c>RequestLocalTravel</c> is one line that delegates to <c>RequestLocalDoorTransition</c>), because the seam is where
/// the decision is made and not where the arm happens to be written.
/// </para>
///
/// <para>
/// WHAT THIS GATE CANNOT SEE, said out loud: an effect the catalogue does NOT declare. A row that hides a real resource
/// movement behind `resource_unproven_by_the_receipt:&lt;resource&gt;` is telling the truth about the receipt - the fact
/// that the receipt does not name WHICH resource - and no reading of the handler can decide what a receipt ought to have
/// proved. That is the gap the reason exists to name, and closing it is a receipt change rather than a declaration change.
/// What the marker may not do is leave the resource out: `TheGapMarkerNamesTheResourceItsReceiptCannotProve` refuses a bare
/// marker, so every row of that population names a fact a receipt change would have to publish.
/// </para>
/// </summary>
public sealed class ActionEffectDeclarationCoverageTests
{
    /// <summary>The generic postcondition: it proves the native call resolved, never WHICH resource appeared.</summary>
    private const string GenericPostcondition = "native_action_postcondition";

    /// <summary>The one seam value admitted for <see cref="FarmhandActionEffectClass.Produces"/> instead of an output fact.</summary>
    private const string PostconditionSeam = "postcondition";

    /// <summary>One reading of the repository per test run: the handler arms and every source a body can live in.</summary>
    private static readonly Lazy<Handlers> HandlerReading = new(Handlers.Read);

    private readonly ITestOutputHelper output;

    public ActionEffectDeclarationCoverageTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryRegistrationStatesItsEffectsOrWhyItHasNone()
    {
        var findings = new List<string>();
        var declaredRows = 0;
        var effectsTotal = 0;
        var reasonCounts = new SortedDictionary<string, int>(StringComparer.Ordinal);
        var classCounts = new SortedDictionary<string, int>(StringComparer.Ordinal);
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            FarmhandActionDescriptor descriptor = registration.Descriptor
                ?? throw new InvalidOperationException($"the registration {registration.ActionId} has no descriptor");
            if (descriptor.Effects is not { } effects)
            {
                findings.Add($"{registration.ActionId}: declares no effects and no reason it has none");
                continue;
            }

            if (effects.Declared.Count > 0 && effects.None is not null)
                findings.Add($"{registration.ActionId}: declares {effects.Declared.Count} effect(s) AND says why it has none ('{effects.None}')");
            if (effects.Declared.Count == 0 && effects.None is null)
                findings.Add($"{registration.ActionId}: declares no effect and no reason - the empty list that says nothing");
            if (effects.None is { } reason)
            {
                if (!FarmhandActionEffects.IsAdmitted(reason))
                    findings.Add($"{registration.ActionId}: '{reason}' is not an admitted reason");
                reasonCounts[reason] = reasonCounts.TryGetValue(reason, out int seen) ? seen + 1 : 1;
            }

            // `observation_only` is a claim about the SURFACE (`effect: read`), so it cannot be made by an action that
            // writes; and a `read_only` registration returns a reading and has no request path at all, so it cannot
            // declare an effect either. Both directions are asserted because either one alone leaves the other silent.
            if (string.Equals(effects.None, FarmhandActionEffects.ObservationOnly, StringComparison.Ordinal)
                && !string.Equals(descriptor.Effect, "read", StringComparison.Ordinal))
                findings.Add($"{registration.ActionId}: says it only reads, and its own effect is '{descriptor.Effect}'");
            if (registration.Kind == FarmhandOperationKind.ReadOnly && effects.Declared.Count > 0)
                findings.Add($"{registration.ActionId}: is a read_only registration declaring {effects.Declared.Count} effect(s)");

            if (effects.Declared.Count == 0) continue;
            declaredRows += 1;
            effectsTotal += effects.Declared.Count;
            foreach (FarmhandActionEffect effect in effects.Declared)
            {
                string name = effect.Class.ToWireValue();
                classCounts[name] = classCounts.TryGetValue(name, out int seen) ? seen + 1 : 1;
            }
        }

        string report =
            $"descriptors {FarmhandActionCatalog.Registrations.Count} · with effects {declaredRows} · effects {effectsTotal} · "
            + $"classes used {Describe(classCounts)} · none {string.Join(", ", reasonCounts.Select(pair => $"{pair.Key}={pair.Value}"))}";

        this.output.WriteLine(report);
        Assert.True(FarmhandActionCatalog.Registrations.Count > 0, $"{report} - an empty population agrees with itself");
        Assert.True(
            findings.Count == 0,
            $"{report}\nthese registrations do not say what they require and change, so nothing downstream can depend on "
                + $"them:\n  {string.Join("\n  ", findings)}");
        Assert.True(declaredRows > 0, $"{report} - no action declares an effect, so the four classes are unreachable");
        Assert.True(
            reasonCounts.Keys.Any(reason => reason.StartsWith(FarmhandActionEffects.ResourceUnprovenByTheReceiptPrefix + ":", StringComparison.Ordinal)),
            $"{report} - no row names the receipt gap, so either the receipts grew the facts this reason reports missing "
                + "or the declaration stopped telling the truth about them");
    }

    /// <summary>
    /// EVERY ROW THAT NAMES THE RECEIPT GAP NAMES THE RESOURCE IT CANNOT PROVE, because a bare
    /// `resource_unproven_by_the_receipt` is the same hole wearing a word: it tells the next reader that something is
    /// unproven and not what, which is exactly the silence <see cref="FarmhandActionEffects"/> exists to replace.
    ///
    /// <para>
    /// THE RULE IS THE DECLARATION'S, not this file's: `FarmhandActionEffects.IsAdmitted` refuses the bare marker, so a
    /// row written without a resource fails `EveryRegistrationStatesItsEffectsOrWhyItHasNone` too. What this fact adds is
    /// the two directions a reader needs - the population is printed, the bare marker is refused HERE on a real value, and
    /// the resource is the same lower-snake word an effect's `subject` uses, so the day the receipt names it the word is
    /// already in the vocabulary the row will declare with.
    /// </para>
    /// </summary>
    [Fact]
    public void TheGapMarkerNamesTheResourceItsReceiptCannotProve()
    {
        const string prefix = FarmhandActionEffects.ResourceUnprovenByTheReceiptPrefix + ":";
        var resources = new SortedDictionary<string, List<string>>(StringComparer.Ordinal);
        var findings = new List<string>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Descriptor?.Effects?.None is not { } reason) continue;
            if (!reason.StartsWith(prefix, StringComparison.Ordinal))
            {
                if (string.Equals(reason, FarmhandActionEffects.ResourceUnprovenByTheReceiptPrefix, StringComparison.Ordinal))
                    findings.Add($"{registration.ActionId}: carries the bare marker, which names no resource");
                continue;
            }

            string resource = reason[prefix.Length..];
            resources.TryGetValue(resource, out List<string>? actions);
            resources[resource] = actions ?? new List<string>();
            resources[resource].Add(registration.ActionId);
            if (!FarmhandActionEffects.IsAdmitted(reason))
                findings.Add($"{registration.ActionId}: '{reason}' is not a resource word");
        }

        string report = $"gap rows {resources.Values.Sum(actions => actions.Count)} · resources {resources.Count} · "
            + string.Join(", ", resources.Select(pair => $"{pair.Key}={pair.Value.Count}"));
        this.output.WriteLine(report);
        Assert.True(
            resources.Count > 0,
            $"{report} - no row names a resource its receipt cannot prove, so either every receipt was closed or the "
                + "declaration stopped saying which");
        findings.Should().BeEmpty(
            "a gap row has to name the resource it cannot prove, because 'unproven' on its own is the same hole wearing "
                + "a word:\n  " + string.Join("\n  ", findings));
        FarmhandActionEffects.IsAdmitted(FarmhandActionEffects.ResourceUnprovenByTheReceiptPrefix).Should().BeFalse(
            "the bare marker is the one spelling this rule excludes, so it cannot be admitted by accident");
    }

    [Fact]
    public void EveryDeclaredEffectIsBackedByTheSeamItsClassNames()
    {
        List<Finding> findings = Measure(FarmhandActionCatalog.Registrations, HandlerReading.Value);
        int declared = FarmhandActionCatalog.Registrations
            .Sum(registration => registration.Descriptor!.Effects?.Declared.Count ?? 0);

        string report =
            $"effects examined {declared} · unbacked {findings.Count}";
        this.output.WriteLine(report);
        foreach (Finding finding in findings) this.output.WriteLine($"  {finding.Site}");

        Assert.True(declared > 0, $"{report} - the catalogue declares no effect, so this gate examined nothing");
        findings.Select(finding => finding.Site).Should().BeEmpty(
            "effect_without_a_seam: a declared effect is only a fact if the Mod can observe it - the state the executor "
                + "writes for `moves_actor`, the predicate the handler refuses with for `requires_place`, the refusal it "
                + "answers when the resource is absent for `consumes`, and the receipt fact that proves it for `produces`. "
                + "These name the action, the class and the seam the handler or the receipt does not carry:\n  "
                + string.Join("\n  ", findings.Select(finding => finding.Site)));
    }

    /// <summary>
    /// The falsifier: the shipped tree is green first, then ONE declaration is replaced by a seam no handler contains, and
    /// the gate must name that action and that class.
    ///
    /// <para>
    /// The replacement is the shape this gate exists for - a `requires_place` whose predicate nothing enforces is exactly
    /// the invented precondition a planner would then plan a walk around - and it is spliced into the descriptor the
    /// catalogue actually declares, so a gate that only counted declarations would stay green.
    /// </para>
    /// </summary>
    [Fact]
    public void FALSIFIER_TheGateNamesAnEffectWhoseHandlerDoesNotEnforceIt()
    {
        Handlers handlers = HandlerReading.Value;
        Measure(FarmhandActionCatalog.Registrations, handlers).Should().BeEmpty(
            "the shipped tree has to be green first, or this replay proves nothing about the gate");

        const string actionId = "sleep";
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => string.Equals(candidate.ActionId, actionId, StringComparison.Ordinal));
        FarmhandActionDescriptor descriptor = registration.Descriptor! with
        {
            Effects = new FarmhandActionEffects(
                Array.AsReadOnly(new[]
                {
                    new FarmhandActionEffect(FarmhandActionEffectClass.RequiresPlace, "home_indoors", "ThisPredicateIsInNoHandler"),
                }),
                null),
        };
        var replayed = FarmhandActionCatalog.Registrations
            .Select(candidate => string.Equals(candidate.ActionId, actionId, StringComparison.Ordinal)
                ? candidate with { Descriptor = descriptor }
                : candidate)
            .ToArray();

        List<Finding> findings = Measure(replayed, handlers);

        findings.Should().ContainSingle(
            $"{actionId} is the only row the replay touches, so it can only name one action - and a seam no handler "
                + "carries has to be named rather than absorbed");
        findings[0].ActionId.Should().Be(actionId);
        findings[0].Code.Should().Be("effect_without_a_seam");
    }

    /// <summary>
    /// Every declaration, read against the authority its class names. A finding is the action, the class and the seam.
    /// </summary>
    private static List<Finding> Measure(
        IReadOnlyList<FarmhandActionRegistration> registrations,
        Handlers handlers)
    {
        var findings = new List<Finding>();
        foreach (FarmhandActionRegistration registration in registrations)
        {
            FarmhandActionDescriptor descriptor = registration.Descriptor!;
            if (descriptor.Effects is not { } effects) continue;
            foreach (FarmhandActionEffect effect in effects.Declared)
            {
                if (effect.Class == FarmhandActionEffectClass.Produces)
                {
                    string? refusal = ReceiptDoesNotProve(descriptor, effect.ObservedBy);
                    if (refusal is not null) findings.Add(new Finding(registration.ActionId, effect, refusal));
                    continue;
                }

                if (!handlers.Carries(registration.ActionId, effect.Class, effect.ObservedBy, out string searched))
                    findings.Add(new Finding(registration.ActionId, effect, searched));
            }
        }

        return findings;
    }

    /// <summary>
    /// Why this receipt does not prove the produced resource, or null when it does: the row's own postcondition must NAME
    /// the resource (`item_purchased`, `silo_hay_taken`), and the generic one is never admitted - it proves the native call
    /// resolved and not which resource appeared.
    /// </summary>
    private static string? ReceiptDoesNotProve(FarmhandActionDescriptor descriptor, string provedBy)
    {
        if (string.Equals(provedBy, PostconditionSeam, StringComparison.Ordinal))
            return string.Equals(descriptor.Postcondition, GenericPostcondition, StringComparison.Ordinal)
                ? $"postcondition={GenericPostcondition}:proves_the_native_call_not_the_resource"
                : null;
        return descriptor.OutputFacts.ContainsKey(provedBy)
            ? null
            : $"output_fact_not_declared:{provedBy}:declared=none";
    }

    private static string Describe(IReadOnlyDictionary<string, int> counts) =>
        counts.Count == 0 ? "none" : string.Join(", ", counts.Select(pair => $"{pair.Key}={pair.Value}"));

    /// <summary>One unbacked declaration: which action, which class, which seam, and what the reading searched.</summary>
    private sealed record Finding(string ActionId, FarmhandActionEffect Effect, string Detail)
    {
        public string Code => "effect_without_a_seam";

        public string Site => $"{this.ActionId}: {this.Effect.Class.ToWireValue()}({this.Effect.Subject}) observedBy='{this.Effect.ObservedBy}' - {this.Detail}";
    }

    /// <summary>
    /// The handler population: the action-to-method mapping from the <c>Handlers/</c> switch arms, and every method body a
    /// controller partial declares.
    ///
    /// <para>
    /// WHY THIS READS MORE THAN A HANDLER BODY. A request half hands its decision to a helper - the seed's slot resolution,
    /// the slot-item refusal, the minecart's own ride - and the helper is often `static` and returns something other than a
    /// receipt (<c>DescribeFertilizeTileRefusal</c> is a `TileTargetRefusal?` handed on as a METHOD GROUP, so it appears in
    /// the body without parentheses). A reader that only followed `<c>this.X(</c> calls into receipt-returning methods found
    /// thirteen seams it had simply not looked for, and reported them as declarations nothing enforces.
    /// </para>
    /// <para>
    /// The reading is therefore name-based and BOUNDED: every identifier in a body that a controller partial DECLARES as a
    /// method is another body this action can reach, four links deep, and the braces are still matched by
    /// <see cref="HandlerSourceFacts.MemberBody"/> - one brace matcher for the whole suite, so a seam cannot be found here
    /// and lost there.
    /// </para>
    /// </summary>
    private sealed record Handlers(
        IReadOnlyDictionary<string, string> Methods,
        IReadOnlyDictionary<string, string> Sources)
    {
        /// <summary>How far the reading follows the handler's own references, so a seam stays attributable to one action.</summary>
        private const int MaximumCallDepth = 4;

        /// <summary>A method declaration in a controller partial: its modifier, its return type, and the name before `(`.</summary>
        private static readonly Regex MethodDeclaration = new(
            "(?m)^ {4,}(?:\\[[^\\]\\n]*\\]\\s*)?(?:public|private|internal|protected)\\s[^=;{]*?\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\(",
            RegexOptions.CultureInvariant);

        internal static Handlers Read() => new(HandlerSourceFacts.HandlerMethods(), HandlerSourceFacts.HandlerSources());

        /// <summary>
        /// Whether the body that decides this action carries the seam its class names, and what the reading searched when
        /// it did not. `consumes` is read as a QUOTED reason code, so `item_not_owned` cannot be satisfied by
        /// `item_not_owned_in_slot`: the two are different refusals and a substring match would call both of them proved.
        /// </summary>
        internal bool Carries(string actionId, FarmhandActionEffectClass effectClass, string seam, out string searched)
        {
            searched = string.Empty;
            if (!this.Methods.TryGetValue(actionId, out string? method))
            {
                searched = "no handler arm resolves to a method for this action";
                return false;
            }

            string needle = effectClass == FarmhandActionEffectClass.Consumes ? $"\"{seam}\"" : seam;
            IReadOnlyList<string> bodies = this.BodiesOf(method);
            if (bodies.Count == 0)
            {
                searched = $"handler {method} has no body this reader can find";
                return false;
            }

            if (bodies.Any(body => body.Contains(needle, StringComparison.Ordinal))) return true;
            searched = $"handler {method} (and the {Math.Max(0, bodies.Count - 1)} body/bodies it reaches, depth {MaximumCallDepth}) never carries `{needle}`";
            return false;
        }

        /// <summary>The handler's own body, then every declared method body its identifiers reference, outward to the bound.</summary>
        private IReadOnlyList<string> BodiesOf(string method)
        {
            IReadOnlyDictionary<string, string> declared = this.DeclaredBodies();
            var bodies = new List<string>();
            var visited = new HashSet<string>(StringComparer.Ordinal);
            var frontier = new Queue<(string Method, int Depth)>();
            frontier.Enqueue((method, 0));
            while (frontier.Count > 0)
            {
                (string current, int depth) = frontier.Dequeue();
                if (!visited.Add(current)) continue;
                if (!declared.TryGetValue(current, out string? body)) continue;
                bodies.Add(body);
                if (depth >= MaximumCallDepth) continue;
                foreach (Match reference in Regex.Matches(body, "[A-Za-z_][A-Za-z0-9_]*"))
                    if (!visited.Contains(reference.Value) && declared.ContainsKey(reference.Value))
                        frontier.Enqueue((reference.Value, depth + 1));
            }

            return bodies;
        }

        /// <summary>
        /// Every method a controller partial declares, by name, with its body and its line comments dropped: a gate is about
        /// what the handler DOES, and a request path whose comment explains the predicate it used to ask would otherwise
        /// satisfy the marker it describes.
        /// </summary>
        private IReadOnlyDictionary<string, string> DeclaredBodies()
        {
            if (this.declaredBodies is not null) return this.declaredBodies;
            var bodies = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string source in this.Sources.Values)
            {
                foreach (Match declaration in MethodDeclaration.Matches(source))
                {
                    string name = declaration.Groups[1].Value;
                    if (bodies.ContainsKey(name)) continue;
                    if (HandlerSourceFacts.MemberBody(source, declaration.Index) is not { } body) continue;
                    bodies[name] = HandlerSourceFacts.StripLineComments(body);
                }
            }

            bodies.Should().NotBeEmpty("the controller partials declare the request paths, or this gate reads nothing");
            this.declaredBodies = bodies;
            return bodies;
        }

        private IReadOnlyDictionary<string, string>? declaredBodies;
    }
}
