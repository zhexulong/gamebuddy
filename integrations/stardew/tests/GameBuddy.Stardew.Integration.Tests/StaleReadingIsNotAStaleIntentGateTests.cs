using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Netcode;
using StardewValley;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_stale_reading_is_not_a_stale_intent:&lt;action&gt;`.
///
/// <para>
/// MEASURED day 1, at the sleep transition: an <c>express_emote(sleep)</c> arriving as the <c>ShippingMenu</c> opened
/// was refused <c>stale_snapshot</c> and then <c>emote_busy</c> - two refusals for one race, and the first one was
/// about a fact the expression cannot act on. <c>ExpectedRevision</c> exists because a mutation dispatched against a
/// reading that has moved can write the WRONG THING: a tile another action planted, a machine another execution
/// filled. An action that changes nothing has nothing to get wrong, so refusing it on a reading spends the caller's
/// request on a fact that costs it nothing.
/// </para>
///
/// <para>
/// THE PREDICATE IS NOT NEW: <see cref="FarmhandActionCatalog.ChangesTheWorld"/> / <c>ActionsThatChangeNothing</c> is
/// the same declaration that scopes the durability alarm (<c>DurabilityAlarmScopeGateTests</c>), so one table decides
/// both what must be journalled and what must be fresh. This gate drives BOTH directions through the real
/// <see cref="BridgeSession"/>, because a relaxation tested in one direction only ships the bug in the other: every
/// side-effect-free action must be accepted against a settled link, and a world-changing action must still be refused
/// <c>stale_snapshot</c>.
/// </para>
///
/// <para>
/// THE POPULATION IS DERIVED, NOT LISTED. The side-effect-free arm is the declaration's own keys; the world-changing
/// arm is every catalogue execution that is world-changing and declares no argument, which is the set a headless
/// runner can put a structurally valid request to (the revision gate runs before any handler or target read, so the
/// world those actions would need is never touched). An action whose request could not be built is NOT silently
/// skipped: it is counted as an inconsistency with the reason it was not measured.
/// </para>
/// </summary>
public sealed class StaleReadingIsNotAStaleIntentGateTests
{
    private const string Gate = "a_stale_reading_is_not_a_stale_intent";

    private const long ActorId = 1001L;

    /// <summary>The native call whose action must say when its reading had moved: the expression family.</summary>
    private const string EmoteNativeBinding = "Farmer.doEmote";

    private readonly ITestOutputHelper output;

    public StaleReadingIsNotAStaleIntentGateTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// THE GATE. A stale reading refuses a world change and does not refuse a side-effect-free action, and an
    /// expression accepted on one says so.
    /// </summary>
    [Fact]
    public void AStaleReadingIsNotAStaleIntentForAnActionThatChangesNothing()
    {
        IReadOnlyList<string> sideEffectFree = SideEffectFreeActions();
        IReadOnlyList<string> worldChanging = WorldChangingActionsWithoutArguments();
        sideEffectFree.Should().NotBeEmpty("the declaration is the population; an empty one measures nothing");
        worldChanging.Should().NotBeEmpty("the other direction has to be driven, or the relaxation ships the bug it prevents");

        var drives = new List<StaleDrive>();
        foreach (string actionId in sideEffectFree)
            drives.Add(Drive(actionId, expectsAWorldChange: false));
        foreach (string actionId in worldChanging)
            drives.Add(Drive(actionId, expectsAWorldChange: true));

        StaleCensus census = Judge(drives);
        this.output.WriteLine(census.Line);
        foreach (StaleDrive drive in drives)
            this.output.WriteLine($"  {drive.ActionId} → stale={drive.RefusedForTheReading} · {drive.Answer} · {drive.Evidence}");

        census.Examined.Should().Be(sideEffectFree.Count + worldChanging.Count, "every member of both arms is driven");
        census.Inconsistent.Should().Be(
            0,
            $"{census.Line}: {string.Join(" ", census.Findings)} - a reading is a precondition of a world change and not of an expression");
        census.SideEffectFreeAccepted.Should().Be(sideEffectFree.Count, "each side-effect-free action reaches its own handler against a settled link");
        census.WorldChangingRefused.Should().Be(worldChanging.Count, "each world-changing action is still refused `stale_snapshot`");
    }

    /// <summary>
    /// THE FALSIFIER, in the direction that would ship a bug: with the revision comparison dropped for EVERY action,
    /// the world-changing arm goes green by accident. Driven here as the measured pair, so the gate's `inconsistent`
    /// count is shown to fire.
    /// </summary>
    [Fact]
    public void AWorldChangeAcceptedOnAStaleReadingIsNamedAsAnInconsistency()
    {
        StaleCensus census = Judge(new[]
        {
            new StaleDrive("dismiss_modal", ExpectsAWorldChange: true, RefusedForTheReading: false,
                ReachedItsHandler: true, Answer: "succeeded/modal_dismissed", Evidence: "modal=DialogueBox"),
        });

        census.Inconsistent.Should().Be(1);
        census.Findings.Should().Equal($"{Gate}:dismiss_modal:accepted_a_world_change_on_a_stale_reading");
        census.Line.Should().Contain("world-changing refused 0");
    }

    /// <summary>
    /// AND A SIDE-EFFECT-FREE ACTION REFUSED FOR THE READING IS NAMED, so the defect this gate exists for is the one
    /// its own failure message describes.
    /// </summary>
    [Fact]
    public void ASideEffectFreeRefusalForTheReadingIsNamed()
    {
        StaleCensus census = Judge(new[]
        {
            new StaleDrive("express_emote", ExpectsAWorldChange: false, RefusedForTheReading: true,
                ReachedItsHandler: false, Answer: "stale_snapshot", Evidence: null),
        });

        census.Inconsistent.Should().Be(1);
        census.Findings.Should().Equal($"{Gate}:express_emote:refused_for_a_stale_reading");
        census.Line.Should().Contain("side-effect-free accepted 0");
    }

    /// <summary>
    /// CASE 2, REPLAYED: the emote is delivered against a reading one revision old, and the receipt says so - a
    /// relaxation that leaves no trace is indistinguishable from a check that was never made.
    /// </summary>
    [Fact]
    public void AnExpressionAcceptedOnAStaleReadingSaysSoInItsReceipt()
    {
        StaleDrive drive = Drive("express_emote", expectsAWorldChange: false);

        drive.RefusedForTheReading.Should().BeFalse();
        drive.ReachedItsHandler.Should().BeTrue();
        drive.Answer.Should().Be("succeeded/emote_started");
        drive.Evidence.Should().Contain(
            "stale_reading_accepted_by=1",
            "the receipt states how far behind the caller's reading was, so the next reader does not conclude staleness was never checked");
    }

    /// <summary>
    /// AND A FRESH READING CARRIES NO TRACE: the sentence is a fact about a dispatch, not a constant that would make
    /// the trace meaningless.
    /// </summary>
    [Fact]
    public void AFreshReadingCarriesNoStaleTrace()
    {
        var probe = new SessionProbe("express_emote");
        BridgeReceipt receipt = probe.Dispatch("express_emote", probe.Revision);

        receipt.ReasonCode.Should().Be("emote_started");
        SessionProbe.Sentence(receipt).Should().NotContain("stale_reading_accepted_by=");
    }

    // -------------------------------------------------------------------------
    // The drives.
    // -------------------------------------------------------------------------

    /// <summary>
    /// One action dispatched through the real session against a reading that has MOVED. The revision is moved by one
    /// accepted dispatch first - a reading can only be stale against a world that has advanced - and the body that
    /// warm-up armed is released, because the warm-up's subject is the revision and not the actor.
    /// </summary>
    private static StaleDrive Drive(string actionId, bool expectsAWorldChange)
    {
        var probe = new SessionProbe(actionId);
        long reading = probe.Revision;
        probe.Dispatch("express_emote", reading);
        probe.ReleaseBody();

        BridgeExecutionRequest request = probe.Request($"{actionId}_on_a_stale_reading", actionId, reading);
        bool dispatched = probe.Session.TryExecute(1, probe.Envelope(request), out BridgeEnvelope<BridgeReceipt>? response, out string reasonCode);
        string answer = dispatched && response is not null
            ? $"{response.Payload.State}/{response.Payload.ReasonCode}"
            : reasonCode;
        bool refusedForTheReading = !dispatched && string.Equals(reasonCode, "stale_snapshot", StringComparison.Ordinal);
        bool reachedItsHandler = dispatched && response is not null;
        string? evidence = response?.Payload.Evidence is { } detail && detail.TryGetValue("detail", out string? sentence) ? sentence : null;
        return new StaleDrive(actionId, expectsAWorldChange, refusedForTheReading, reachedItsHandler, answer, evidence);
    }

    /// <summary>
    /// A session over the REAL bridge: one authenticated generation, a journal (the candidate actions' admission is
    /// durable), and a body whose identity is the scope's player. Everything the receipt reports is produced by the
    /// product; the probe stands in for the engine's actor only.
    /// </summary>
    private sealed class SessionProbe
    {
        private const string Token = "stale_reading_gate_token_0123456789";

        private readonly Farmer actor;

        internal SessionProbe(string actionId)
        {
            this.Scope = new BridgeScope("stardew", "save-stale-reading", "world-stale-reading", ActorId.ToString(System.Globalization.CultureInfo.InvariantCulture), "companion-stale-reading");
            this.Publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { actionId, "express_emote" });
            this.Executions = new ExecutionManager(
                new DummyMonitor(),
                () => this.Publication,
                executionJournal: new FarmhandExecutionJournal(new FakeModGlobalDataPersistence()),
                executionScope: this.Scope);
            this.actor = ProbeActor();
            this.Executions.SetTestActorResolver(() => this.actor);
            this.Session = new BridgeSession(this.Executions, ModEntry.CreateFarmhandActionRouter(this.Executions), this.Scope, Token, () => this.Publication);
            this.Session.TryAuthenticate(1, this.Hello(), out _, out string authReason).Should().BeTrue(authReason);
        }

        internal BridgeSession Session { get; }

        internal BridgeScope Scope { get; }

        internal FarmhandCapabilityPublication Publication { get; }

        internal ExecutionManager Executions { get; }

        internal long Revision => this.Executions.Revision;

        /// <summary>The balloon the warm-up armed is released: an expression is a now-gesture, not a durable hold.</summary>
        internal void ReleaseBody() => this.actor.isEmoting = false;

        internal BridgeExecutionRequest Request(string requestId, string actionId, long expectedRevision) =>
            new(requestId, $"idem_{requestId}", actionId, ArgsFor(actionId), expectedRevision, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        internal BridgeEnvelope<BridgeExecutionRequest> Envelope(BridgeExecutionRequest request) => new(
            BridgeProtocol.Version,
            $"msg_{request.RequestId}",
            $"corr_{request.RequestId}",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            this.Scope,
            "execution_request",
            request);

        /// <summary>One dispatch whose reading is current, answered with the receipt the product minted.</summary>
        internal BridgeReceipt Dispatch(string actionId, long expectedRevision)
        {
            BridgeExecutionRequest request = this.Request($"req_{actionId}_{expectedRevision}", actionId, expectedRevision);
            bool dispatched = this.Session.TryExecute(1, this.Envelope(request), out BridgeEnvelope<BridgeReceipt>? response, out string reasonCode);
            dispatched.Should().BeTrue($"{actionId}: the warm-up dispatch is refused `{reasonCode}` and the revision never moves");
            response.Should().NotBeNull();
            return response!.Payload;
        }

        /// <summary>The one evidence sentence the wire carries, or null when the receipt carried none.</summary>
        internal static string? Sentence(BridgeReceipt receipt) =>
            receipt.Evidence is { } detail && detail.TryGetValue("detail", out string? sentence) ? sentence : null;

        private BridgeEnvelope<BridgeHello> Hello() => new(
            BridgeProtocol.Version,
            "msg_hello",
            "corr_hello",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            this.Scope,
            "hello",
            new BridgeHello(Token));

        /// <summary>
        /// The arguments the action's own descriptor declares, with a legal value per declared name - the shape
        /// <c>RefusalForANonChangingActionGateTests</c> uses, so nothing here lists what an action takes.
        /// </summary>
        private static BridgeExecutionArgs ArgsFor(string actionId)
        {
            IReadOnlyList<FarmhandActionArgument> declared = FarmhandActionCatalog.Registrations
                .Single(row => string.Equals(row.ActionId, actionId, StringComparison.Ordinal))
                .Descriptor?.Arguments ?? Array.Empty<FarmhandActionArgument>();
            bool declares(string name) => declared.Any(argument => string.Equals(argument.Name, name, StringComparison.Ordinal));
            return new BridgeExecutionArgs
            {
                Emote = declares("emote") ? FarmhandActionCatalog.EmoteEnum[0] : null,
                Direction = declares("direction") ? FarmhandActionCatalog.DirectionEnum[0] : null,
                Text = declares("text") ? "hello" : null,
            };
        }

        /// <summary>
        /// A body complete enough for the shared admission to read: the NetFields <c>WorldModel.ReadFacts</c> and
        /// <c>AdmitExecution</c> dereference, and the sprite an emote is drawn on. It stands in for the engine's body
        /// state (a headless runner has no game loop, so nothing is walking) and produces nothing the receipt does not
        /// read.
        /// </summary>
        private static Farmer ProbeActor()
        {
            var actor = (ProbeBody)FormatterServices.GetUninitializedObject(typeof(ProbeBody));
            Set(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            Set(actor, "netStamina", new NetFloat(270f));
            Set(actor, "usingTool", new NetBool(value: false));
            Set(actor, "canMove", true);
            ProbeFarmerSprite.Attach(actor);
            return actor;
        }

        private static void Set(Farmer actor, string field, object value)
        {
            FieldInfo declared = typeof(Farmer).GetField(field, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                ?? throw new InvalidOperationException($"the probe body has no `{field}`, which the admission reads");
            declared.SetValue(actor, value);
        }

        /// <summary>
        /// `Farmer.isMoving` and `Character.faceDirection` reach the movement NetFields and the sprite's texture, which an
        /// uninitialised probe leaves null - the same boundary every probe body in this suite stands in for. Nothing is
        /// walking and the facing write is the field it is.
        /// </summary>
        private sealed class ProbeBody : Farmer
        {
            private int facing = 2;

            public override bool isMoving() => false;

            public override int FacingDirection { get => this.facing; set => this.facing = value; }

            public override void faceDirection(int direction) => this.facing = direction;
        }
    }

    // -------------------------------------------------------------------------
    // The population.
    // -------------------------------------------------------------------------

    /// <summary>The actions the catalogue declares change nothing, in a stable order.</summary>
    private static IReadOnlyList<string> SideEffectFreeActions() =>
        FarmhandActionCatalog.ActionsThatChangeNothing.Keys.OrderBy(actionId => actionId, StringComparer.Ordinal).ToArray();

    /// <summary>
    /// The world-changing executions whose request a probe can build without a world: no declared argument, so the
    /// request is structurally valid before the revision gate reads it. Anything the probe cannot shape is reported by
    /// <see cref="Judge"/> as not measured rather than skipped.
    /// </summary>
    private static IReadOnlyList<string> WorldChangingActionsWithoutArguments() =>
        FarmhandActionCatalog.Registrations
            .Where(row => row.Kind == FarmhandOperationKind.Execution)
            .Where(row => FarmhandActionCatalog.ChangesTheWorld(row.ActionId))
            .Where(row => row.Descriptor is { Arguments.Count: 0 })
            .Select(row => row.ActionId)
            .OrderBy(actionId => actionId, StringComparer.Ordinal)
            .ToArray();

    // -------------------------------------------------------------------------
    // The judgement.
    // -------------------------------------------------------------------------

    /// <summary>One dispatched action, as the census reads it.</summary>
    internal readonly record struct StaleDrive(
        string ActionId,
        bool ExpectsAWorldChange,
        bool RefusedForTheReading,
        bool ReachedItsHandler,
        string Answer,
        string? Evidence);

    /// <summary>The census, with its own line so every failure message carries the population it was read over.</summary>
    internal readonly record struct StaleCensus(
        int Examined,
        int SideEffectFreeAccepted,
        int WorldChangingRefused,
        int Inconsistent,
        IReadOnlyList<string> Findings)
    {
        internal string Line =>
            $"actions examined {this.Examined} · side-effect-free accepted {this.SideEffectFreeAccepted}"
            + $" · world-changing refused {this.WorldChangingRefused} · inconsistent {this.Inconsistent}";
    }

    internal static StaleCensus Judge(IReadOnlyList<StaleDrive> drives)
    {
        var findings = new List<string>();
        int accepted = 0;
        int refused = 0;
        foreach (StaleDrive drive in drives)
        {
            if (drive.RefusedForTheReading)
            {
                if (drive.ExpectsAWorldChange)
                {
                    refused += 1;
                    continue;
                }

                findings.Add($"{Gate}:{drive.ActionId}:refused_for_a_stale_reading");
                continue;
            }

            if (!drive.ReachedItsHandler)
            {
                findings.Add($"{Gate}:{drive.ActionId}:not_measured:{drive.Answer}");
                continue;
            }

            if (drive.ExpectsAWorldChange)
            {
                findings.Add($"{Gate}:{drive.ActionId}:accepted_a_world_change_on_a_stale_reading");
                continue;
            }

            if (RequiresAStaleTrace(drive.ActionId) && drive.Evidence?.Contains("stale_reading_accepted_by=", StringComparison.Ordinal) != true)
            {
                findings.Add($"{Gate}:{drive.ActionId}:no_stale_reading_trace");
                continue;
            }

            accepted += 1;
        }

        return new StaleCensus(drives.Count, accepted, refused, findings.Count, findings);
    }

    /// <summary>
    /// Whether this action's receipt has to say that its reading had moved: the expression family, whose native call is
    /// <see cref="EmoteNativeBinding"/> and whose answer is the one that used to be an uncertainty.
    /// </summary>
    private static bool RequiresAStaleTrace(string actionId) =>
        FarmhandActionCatalog.Registrations.Any(row =>
            string.Equals(row.ActionId, actionId, StringComparison.Ordinal)
            && string.Equals(row.Descriptor?.NativeBinding, EmoteNativeBinding, StringComparison.Ordinal));

    private sealed class FakeModGlobalDataPersistence : IModGlobalDataPersistence
    {
        private FarmhandExecutionJournalState? state;

        public FarmhandExecutionJournalState? Read(string key) => this.state;

        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            this.state = value;
            return true;
        }
    }
}
