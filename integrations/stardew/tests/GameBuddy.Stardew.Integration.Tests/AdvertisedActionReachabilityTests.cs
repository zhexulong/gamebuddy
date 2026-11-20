using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// AN ADVERTISED ACTION IS ONE A FRAME CAN REACH: <c>an_advertised_action_is_one_a_frame_can_reach:&lt;actionId&gt;</c>.
///
/// <para>
/// WHY THIS EXISTS. `hello_ack` carries the Mod's action registrations, and the Host reads that list as the registration
/// authority - it mounts what the list names and refuses what it does not. So an id in it is a claim that a request
/// frame can name it. Measured 2026-11-22: `FarmhandPlanFormCatalog.ForEachActionId` was concatenated into that list as
/// <see cref="FarmhandActionLifecycle.Published"/> while the Host had long since stopped declaring a plan form -
/// <c>host/src/body-program-script.ts</c> `PLAN_FORM_ACTION_IDS` is empty, and <c>host/src/body-program-preflight.ts</c>
/// refuses any node carrying the form's one argument by name (<c>plan_form_not_declared</c>). The only producer of a
/// <c>for_each</c> node was the Host's plan compiler, which refuses it. So the Mod advertised a capability nothing could
/// invoke - and that is the one thing an advertisement may not be, because the Host may only NARROW what the Mod
/// publishes, never correct it.
/// </para>
/// <para>
/// THE POPULATION IS NOT A LIST HERE. Every id the Mod registers is examinable, in both catalogs
/// (<see cref="FarmhandActionCatalog.Registrations"/> and <see cref="FarmhandPlanFormCatalog.Registrations"/>); what is
/// ADVERTISED is the real <c>hello_ack</c> this Mod produces - the session is authenticated as a Host authenticates it
/// and the registrations are read off the wire record - so the gate cannot agree with a copy of itself. The Host's half
/// is its own declaration, `PLAN_FORM_ACTION_IDS`, read from the file that declares it; an unreadable declaration is
/// blocked by name, never green.
/// </para>
/// <para>
/// WHAT "A FRAME CAN REACH IT" MEANS, for each kind of id. An ACTION is reachable: a flat request names it and the
/// router serves it. A FORM is reachable only where a Host declares it, because a form is written by the Host's plan and
/// by nothing else. A form the Host does not declare has neither frame - no flat request (nothing registers it with the
/// router) and no node (the compiler writes none and the preflight refuses one it is handed).
/// </para>
/// <para>
/// The verdict is printed on every run - `advertised A · reachable R · orphaned O` - because a green run that does not
/// say what it examined cannot be told from a reading that stopped working. `O &gt; 0` fails naming the action.
/// </para>
/// </summary>
public sealed class AdvertisedActionReachabilityTests
{
    private const string Gate = "an_advertised_action_is_one_a_frame_can_reach";
    private const string HostCompilerPath = "host/src/body-program-script.ts";
    private const string Token = "advertisement_token_0123456789abcdef";

    /// <summary>How many registrations the action catalog holds when it is read at all.</summary>
    private const int MinimumAdvertisedRegistrations = 50;

    private readonly ITestOutputHelper output;

    public AdvertisedActionReachabilityTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryAdvertisedRegistrationIsOneAFrameCanReach()
    {
        IReadOnlyList<string> registered = RegisteredActionIds();
        IReadOnlySet<string> actions = FarmhandActionCatalog.Registrations
            .Select(registration => registration.ActionId)
            .ToHashSet(StringComparer.Ordinal);
        IReadOnlyList<string> advertised = AdvertisedActionIds();

        advertised.Should().HaveCountGreaterThan(
            MinimumAdvertisedRegistrations,
            "the whole action catalog is advertised, and a reading that found fewer has stopped reading the hello");
        registered.Should().OnlyHaveUniqueItems(
            "an id in both catalogs would be two registrations of one action, and this reading would count it twice");
        registered.Should().HaveCountGreaterThan(
            actions.Count,
            "the plan forms are part of the population; a gate that examined only the actions could not have caught the "
            + "form this gate exists for");

        Reachability verdict = Reach(advertised, actions, HostDeclaredPlanFormActionIds());
        this.output.WriteLine(verdict.Line);
        verdict.Orphaned.Should().BeEmpty(
            $"{Gate}: an id is advertised on hello_ack and no frame can name it, so the Mod is offering a capability the "
            + $"world cannot honour - {verdict.Orphans()}. {verdict.Line}");
    }

    /// <summary>
    /// The reading the case above and the falsifier below both ask, so the gate cannot hold a rule its own failure proof
    /// does not exercise.
    ///
    /// An id with no frame is named, never counted: `for_each` is a name an operator can act on and "one orphan" is not.
    /// </summary>
    private static Reachability Reach(
        IReadOnlyList<string> advertised,
        IReadOnlySet<string> actions,
        IReadOnlySet<string> hostForms)
    {
        bool ReachableByAFrame(string actionId) => actions.Contains(actionId) || hostForms.Contains(actionId);
        string[] orphaned = advertised
            .Where(actionId => !ReachableByAFrame(actionId))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return new(advertised.Count, advertised.Count - orphaned.Length, orphaned);
    }

    /// <summary>
    /// The falsifier: the same reading over the state the tree was in before this unit - the form advertised while the
    /// Host declares none.
    ///
    /// Its premise is asserted rather than assumed. The day a Host declares `for_each` again, the reachability rule
    /// above already reaches it, advertising it is the fix, and this case must move with it rather than silently passing
    /// over an injection that no longer injects anything.
    /// </summary>
    [Fact]
    public void TheReadingFailsNamingAPlanFormTheHostDoesNotDeclare()
    {
        IReadOnlySet<string> hostForms = HostDeclaredPlanFormActionIds();
        hostForms.Should().NotContain(
            FarmhandPlanFormCatalog.ForEachActionId,
            "this falsifier injects a form the Host does not declare; the day it declares one, re-advertisement is the "
            + "answer and this case has no premise left");

        IReadOnlySet<string> actions = FarmhandActionCatalog.Registrations
            .Select(registration => registration.ActionId)
            .ToHashSet(StringComparer.Ordinal);
        IReadOnlyList<string> advertised = AdvertisedActionIds()
            .Concat(new[] { FarmhandPlanFormCatalog.ForEachActionId })
            .ToArray();

        Reachability verdict = Reach(advertised, actions, hostForms);

        this.output.WriteLine(verdict.Line);
        verdict.Orphaned.Should().ContainSingle(
            $"{Gate}: the form is advertised and no frame can name it, so the reading must fail on it by name. "
            + verdict.Line)
            .Which.Should().Be(FarmhandPlanFormCatalog.ForEachActionId);
    }

    /// <summary>
    /// The registrations the real <c>hello_ack</c> carries, read off the session the Host talks to.
    /// </summary>
    private static IReadOnlyList<string> AdvertisedActionIds()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        var session = new BridgeSession(
            new ExecutionManager(new DummyMonitor(), () => publication),
            new FarmhandActionRouter(),
            scope,
            Token,
            () => publication,
            () => "en-US");
        var hello = new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "hello_advertisement_01",
            "hello_advertisement_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(Token));

        session.TryAuthenticate(1, hello, out BridgeEnvelope<BridgeHelloAck>? acknowledgement, out string reasonCode)
            .Should().BeTrue(reasonCode);
        return acknowledgement!.Payload.Registrations.Select(registration => registration.ActionId).ToArray();
    }

    /// <summary>Every id the Mod registers, from the two catalogs that register: actions, then forms.</summary>
    private static IReadOnlyList<string> RegisteredActionIds() => FarmhandActionCatalog.Registrations
        .Select(registration => registration.ActionId)
        .Concat(FarmhandPlanFormCatalog.Registrations.Select(registration => registration.ActionId))
        .ToArray();

    /// <summary>
    /// The plan forms the Host's own compiler declares - the ids it can write into a program node that are not
    /// published actions.
    ///
    /// Blocked by name when the declaration is gone, because a vocabulary read from a file that no longer holds it
    /// agrees with every advertisement.
    /// </summary>
    private static IReadOnlySet<string> HostDeclaredPlanFormActionIds()
    {
        string source = File.ReadAllText(Path.Combine(
            TargetFamilyRoundTripTests.RepositoryRoot(), HostCompilerPath.Replace('/', Path.DirectorySeparatorChar)));
        Match declaration = Regex.Match(
            source,
            "PLAN_FORM_ACTION_IDS\\s*:\\s*readonly string\\[\\]\\s*=\\s*Object\\.freeze\\(\\[(?<ids>[^\\]]*)\\]",
            RegexOptions.CultureInvariant);
        declaration.Success.Should().BeTrue(
            $"{HostCompilerPath} must still declare PLAN_FORM_ACTION_IDS; an unreadable declaration is a blocked "
            + "reading, not an empty one");
        return Regex.Matches(declaration.Groups["ids"].Value, "\"([^\"]*)\"")
            .Select(match => match.Groups[1].Value)
            .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>The three counts the gate prints, and the ids behind the third.</summary>
    private sealed record Reachability(int Advertised, int Reachable, IReadOnlyList<string> Orphaned)
    {
        internal string Line => $"advertised {this.Advertised} · reachable {this.Reachable} · orphaned {this.Orphaned.Count}";

        internal string Orphans() => this.Orphaned.Count == 0
            ? "no orphan"
            : string.Join(",", this.Orphaned.Select(actionId => $"{Gate}:{actionId}"));
    }
}
