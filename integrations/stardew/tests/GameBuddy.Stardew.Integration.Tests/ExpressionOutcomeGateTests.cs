using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using StardewValley;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `an_expression_says_which_of_three_it_is:&lt;case&gt;`.
///
/// <para>
/// MEASURED `1795103939574` and `1795103955314`, day 2 06:20: Clint's furnace-blueprint cutscene was up and two flat
/// `express_emote` requests (`note`, then `question`) came back <c>Uncertain / emote_postcondition_unavailable</c>.
/// <see cref="Farmer.doEmote"/> is <c>if (!Game1.eventUp &amp;&amp; !isEmoting)</c> (Farmer.cs:9046), so the emote had
/// certainly NOT happened - and "we cannot tell" is the one answer a postcondition must not fake. For an expression it
/// is also the worst answer available: nothing in the world changed, so there is nothing to be unsure about, and
/// <c>Uncertain</c> buys the caller no next step at all.
/// </para>
///
/// <para>
/// THE THREE ANSWERS, and the fourth that is not a gap. Every terminal an expression can mint is one of: it HAPPENED
/// (<c>emote_started</c>), it CANNOT HAPPEN YET and the receipt names the fact to wait for (<c>cutscene_active</c>,
/// <c>emote_busy</c>), or it CANNOT BE TOLD (<c>Uncertain</c>). A refusal that is decided and names no wait - an emote
/// the catalogue does not have, a session with no bound body - is counted apart as REFUSED, because it is certain:
/// nothing happened, and no wait would change that.
/// </para>
///
/// <para>
/// THE POPULATION IS DERIVED TWICE AND LISTED NOWHERE. The actions are the catalogue rows whose own native binding is
/// <see cref="EmoteNativeBinding"/> - a row bound to the emote tomorrow is driven without editing this file - and the
/// cases are the engine's own preconditions plus the two request-shape facts, driven through the real router
/// composition (<see cref="ModEntry.CreateFarmhandActionRouter"/>) against a real <see cref="Farmer"/> whose
/// <c>doEmote</c> is the engine's own method, so each receipt judged here is one the product mints. The states are
/// classified by a function this file requires to answer EVERY <see cref="ExecutionState"/> member, so a new state
/// lands in one of the answers or fails by name.
/// </para>
/// </summary>
public sealed class ExpressionOutcomeGateTests
{
    private const string Gate = "an_expression_says_which_of_three_it_is";

    /// <summary>The native call that makes a catalogue row an expression, read from the row's own descriptor.</summary>
    private const string EmoteNativeBinding = "Farmer.doEmote";

    private readonly ITestOutputHelper output;

    public ExpressionOutcomeGateTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// THE GATE. Every expression action is driven through every case; no case may answer "we cannot tell", and each
    /// case must answer what it is.
    /// </summary>
    [Fact]
    public void EveryExpressionOutcomeIsAppliedOrWaitsWithAName()
    {
        IReadOnlyList<string> actions = ExpressionActions();
        actions.Should().NotBeEmpty($"a gate whose population is empty agrees with itself; no catalogue row binds {EmoteNativeBinding}");

        var driven = new List<DrivenOutcome>();
        foreach (string actionId in actions)
        {
            foreach (ExpressionCase expressionCase in ExpressionCase.All)
                driven.Add(Drive(actionId, expressionCase));
        }

        ExpressionCensus census = Judge(driven);
        this.output.WriteLine(census.Line);
        foreach (DrivenOutcome outcome in driven)
            this.output.WriteLine($"  {outcome.ActionId}/{outcome.Case.Name} → {outcome.State}/{outcome.ReasonCode} · {outcome.Evidence}");

        census.Examined.Should().Be(
            actions.Count * ExpressionCase.All.Length,
            "the population is the expression actions crossed with every case, driven whole");
        census.CannotTell.Should().Be(
            0,
            $"{census.Line}: {string.Join(" ", census.Findings)} - a certainty gap about an expression is a named wait, never an uncertainty");
        (census.Happened + census.NamedWait + census.CannotTell + census.Refused).Should().Be(
            census.Examined,
            "every outcome lands in exactly one answer, so none is silently outside the count");
        census.Happened.Should().BeGreaterThan(0, "the clear world is not a hold, so at least one emote is delivered");

        foreach (DrivenOutcome outcome in driven)
        {
            outcome.Answer.Should().Be(
                outcome.Case.Expected,
                $"{census.Line}: {outcome.ActionId}/{outcome.Case.Name} is {outcome.Case.Expected}; a receipt that answers something else says the wrong thing about a visible gesture");
        }
    }

    /// <summary>
    /// THE FALSIFIER, on the measured shape: the exact receipt the cutscene minted (`1795103939574`) is judged by the
    /// same function the gate uses, and is reported by name as the cannot-tell it was.
    /// </summary>
    [Fact]
    public void TheMeasuredCutsceneEmoteIsReportedAsACannotTell()
    {
        ExpressionCensus census = Judge(new[]
        {
            new DrivenOutcome("express_emote", ExpressionCase.CutsceneUp, ExecutionState.Uncertain,
                "emote_postcondition_unavailable", "emote=note;native_dispatched=true"),
        });

        census.Examined.Should().Be(1);
        census.CannotTell.Should().Be(1);
        census.Findings.Should().Equal($"{Gate}:express_emote:{ExpressionCase.CutsceneUp.Name}");
    }

    /// <summary>
    /// CASE 1, REPLAYED: the cutscene emote is a named wait, and the wait is truthful - the engine refused the call, so
    /// nothing was armed and the caller is told which fact clears it.
    /// </summary>
    [Fact]
    public void ACutsceneEmoteIsANamedWaitAndNothingIsArmed()
    {
        var actor = FreshActor();
        DrivenOutcome outcome = Drive("express_emote", ExpressionCase.CutsceneUp, actor);

        outcome.State.Should().Be(ExecutionState.Rejected);
        outcome.ReasonCode.Should().Be(
            WorldModel.HoldReasonCode(ActorDispositionKind.Event),
            "the hold's own vocabulary names a cutscene, and this file does not spell a second word for it");
        outcome.Evidence.Should().Contain("next_step=", "a wait that names no step is a refusal the caller can only retry");
        outcome.Evidence.Should().Contain("native_dispatched=false", "nothing reached the engine, and the receipt says so");
        actor.IsEmoting.Should().BeFalse("`Farmer.doEmote` refuses under an event, so the wait is a fact and not a claim");
    }

    /// <summary>AND DELIVERED ONCE THE EVENT ENDS: the same request against the same body, with the cutscene gone.</summary>
    [Fact]
    public void TheEmoteIsDeliveredOnceTheEventEnds()
    {
        var actor = FreshActor();
        DrivenOutcome outcome = Drive("express_emote", ExpressionCase.ClearWorld, actor);

        outcome.State.Should().Be(ExecutionState.Succeeded);
        outcome.ReasonCode.Should().Be("emote_started");
        actor.IsEmoting.Should().BeTrue("the postcondition is the arm the receipt claims");
        actor.CurrentEmote.Should().Be(
            EmoteIndexFor(ExpressionCase.ClearWorld.Emote),
            "the balloon showing is the one the request asked for, not merely some balloon");
    }

    /// <summary>
    /// CASE 2's second refusal: an emote asked while one is still playing is a wait with the body loop's own retry
    /// window, not a dead refusal - the engine's guard is <c>!isEmoting</c>, so the fact clears by itself.
    /// </summary>
    [Fact]
    public void AnEmoteAskedWhileOnePlaysNamesTheRetryWindow()
    {
        DrivenOutcome outcome = Drive("express_emote", ExpressionCase.EmotePlaying);

        outcome.State.Should().Be(ExecutionState.Rejected);
        outcome.ReasonCode.Should().Be("emote_busy");
        outcome.Evidence.Should().Contain($"retry_window_ms={WorldModel.TransientRetryWindowMs}", "the window is the body loop's own number, not a second one");
        outcome.Evidence.Should().Contain("next_step=");
        outcome.Answer.Should().Be(ExpressionAnswer.NamedWait);
    }

    /// <summary>
    /// THE ENGINE FACT the first answer rests on: <c>Farmer.doEmote</c> is its guard and four writes, so a refused
    /// emote is NOT queued anywhere - it cannot be deferred to the moment the event ends, and the honest answer is
    /// therefore a wait the caller re-issues rather than a hold this Mod keeps.
    /// </summary>
    [Fact]
    public void TheEngineRefusesAnEmoteUnderAnEventAndKeepsNoPendingOne()
    {
        IReadOnlyList<string> farmer = DecompiledSource.Code(DecompiledSource.Lines("StardewValley/Farmer.cs"));
        IReadOnlyList<string> emote = DecompiledSource.MethodBody(farmer, "public void doEmote(int whichEmote)");
        emote.Should().NotBeEmpty("the emote the Mod dispatches has to still be there under this name");

        string[] statements = emote
            .Select(line => line.Trim())
            .Where(line => line.Length > 0 && line != "{" && line != "}")
            .ToArray();
        statements.Should().HaveCount(
            6,
            "the method is its declaration, its guard and four field writes - a queue, a pending list or a deferred emote here would mean an emote CAN be deferred, and the Mod's answer would have to change");
        statements[1].Should().Be("if (!Game1.eventUp && !isEmoting)", "this is the guard the Mod now reads BEFORE dispatching");
        statements.Skip(2).Should().Equal("isEmoting = true;", "currentEmote = whichEmote;", "currentEmoteFrame = 0;", "emoteInterval = 0f;");

        IReadOnlyList<string> character = DecompiledSource.Code(DecompiledSource.Lines("StardewValley/Character.cs"));
        IReadOnlyList<string> update = DecompiledSource.MethodBody(character, "public void updateEmote(GameTime time)");
        update.Should().Contain(line => line.Trim() == "if (!isEmoting)", "the only emote the engine plays is the one already armed, so a refused one is never replayed");
    }

    /// <summary>
    /// THE CLASSIFIER IS TOTAL OVER THE ENUM, and it has exactly one spelling for "cannot tell". A new
    /// <see cref="ExecutionState"/> member fails here until someone decides which answer it is.
    /// </summary>
    [Fact]
    public void EveryExecutionStateLandsInOneOfTheAnswersAndOnlyUncertainCannotTell()
    {
        ExecutionState[] cannotTell = Enum.GetValues<ExecutionState>()
            .Where(state => AnswerOf(state, null) == ExpressionAnswer.CannotTell)
            .ToArray();

        cannotTell.Should().HaveCount(
            1,
            "every state is classified, and a certainty gap has ONE spelling: a second one is a second thing to keep true");
        cannotTell[0].Should().Be(ExecutionState.Uncertain);
    }

    // -------------------------------------------------------------------------
    // The drive: one real dispatch per (action, case), against a real Farmer.
    // -------------------------------------------------------------------------

    /// <summary>
    /// The catalogue rows whose native binding is the emote. Derived from the descriptor, so an expression added
    /// tomorrow is driven here without an entry in this file.
    /// </summary>
    private static IReadOnlyList<string> ExpressionActions() =>
        FarmhandActionCatalog.Registrations
            .Where(row => string.Equals(row.Descriptor?.NativeBinding, EmoteNativeBinding, StringComparison.Ordinal))
            .Select(row => row.ActionId)
            .OrderBy(actionId => actionId, StringComparer.Ordinal)
            .ToArray();

    private static DrivenOutcome Drive(string actionId, ExpressionCase expressionCase) =>
        Drive(actionId, expressionCase, FreshActor());

    /// <summary>
    /// One case dispatched through the REAL router composition. The actor is a real <see cref="Farmer"/> whose
    /// <c>doEmote</c> is the engine's own method, so what the receipt reports is what the game did.
    /// </summary>
    private static DrivenOutcome Drive(string actionId, ExpressionCase expressionCase, Farmer actor)
    {
        bool eventWasUp = Game1.eventUp;
        Game1.eventUp = expressionCase.EventUp;
        try
        {
            if (expressionCase.Emoting)
            {
                // Arm a DIFFERENT balloon the way the game does, so the busy guard reads a real animation rather
                // than a field set by the test.
                actor.doEmote(EmoteIndexDifferentFrom(expressionCase.Emote));
            }

            FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { actionId });
            var executions = new ExecutionManager(new DummyMonitor(), () => publication);
            executions.SetTestActorResolver(() => expressionCase.BoundBody ? actor : null);
            FarmhandActionRouter router = ModEntry.CreateFarmhandActionRouter(executions);
            BridgeExecutionRequest request = Request(actionId, expressionCase);

            bool routed = router.TryRoute(request, executions, out LocalExecutionReceipt receipt, out string reason);
            routed.Should().BeTrue($"{actionId}/{expressionCase.Name}: {reason}");
            return new DrivenOutcome(actionId, expressionCase, receipt.State, receipt.ReasonCode, receipt.Evidence);
        }
        finally
        {
            Game1.eventUp = eventWasUp;
        }
    }

    /// <summary>An uninitialised <see cref="Farmer"/>: the expression path reads no NetField, and its native call is a field write.</summary>
    private static Farmer FreshActor() => (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));

    /// <summary>The request shape the catalogue declares for one action, with the emote this case asks for.</summary>
    private static BridgeExecutionRequest Request(string actionId, ExpressionCase expressionCase)
    {
        IReadOnlyList<FarmhandActionArgument> declared = FarmhandActionCatalog.Registrations
            .Single(row => string.Equals(row.ActionId, actionId, StringComparison.Ordinal))
            .Descriptor?.Arguments ?? Array.Empty<FarmhandActionArgument>();
        declared.Should().Contain(
            argument => string.Equals(argument.Name, "emote", StringComparison.Ordinal),
            $"{actionId} binds {EmoteNativeBinding}, so it declares the emote it dispatches");

        return new BridgeExecutionRequest(
            $"req_expression_gate_{actionId}_{expressionCase.Name}",
            $"idem_expression_gate_{actionId}_{expressionCase.Name}",
            actionId,
            new BridgeExecutionArgs { Emote = expressionCase.Emote },
            ExpectedRevision: 0,
            DeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
    }

    /// <summary>
    /// The balloon index the Mod's own name table gives an emote. Read from the table rather than restated here, so the
    /// assertion follows the authority the handler dispatches through.
    /// </summary>
    private static int EmoteIndexFor(string emote)
    {
        FieldInfo? field = typeof(ExecutionManager).GetField("EmoteMap", BindingFlags.NonPublic | BindingFlags.Static);
        field.Should().NotBeNull("the emote name table is the authority this assertion reads; it has to still be named EmoteMap on ExecutionManager");
        var map = (Dictionary<string, int>)field!.GetValue(null)!;
        map.Should().ContainKey(emote, "the request's emote is one the Mod's own table maps to a balloon");
        return map[emote];
    }

    /// <summary>A balloon index that is NOT the one asked for, for the case that asks while one is already playing.</summary>
    private static int EmoteIndexDifferentFrom(string emote)
    {
        int asked = EmoteIndexFor(emote);
        return FarmhandActionCatalog.EmoteEnum.Select(EmoteIndexFor).First(index => index != asked);
    }

    // -------------------------------------------------------------------------
    // The judgement, fed its receipts so the honest ones and the injected ones share it.
    // -------------------------------------------------------------------------

    /// <summary>What one terminal says about the expression: it happened, it waits, it cannot be told, or it was refused.</summary>
    internal enum ExpressionAnswer
    {
        /// <summary>The balloon is up: the postcondition read back what the request asked for.</summary>
        Happened,

        /// <summary>Nothing happened yet and the receipt names the fact that clears it.</summary>
        NamedWait,

        /// <summary>Nothing here can say whether it happened - the answer no expression may give.</summary>
        CannotTell,

        /// <summary>Nothing happened, decided: the request or the session has to change, and no wait would help.</summary>
        Refused,
    }

    /// <summary>One dispatch's answer, as the census reads it.</summary>
    internal readonly record struct DrivenOutcome(
        string ActionId,
        ExpressionCase Case,
        ExecutionState State,
        string ReasonCode,
        string? Evidence)
    {
        internal ExpressionAnswer Answer => AnswerOf(this.State, this.Evidence);
    }

    /// <summary>The census, with its own line so every failure message carries the population it was read over.</summary>
    internal readonly record struct ExpressionCensus(
        int Examined,
        int Happened,
        int NamedWait,
        int CannotTell,
        int Refused,
        IReadOnlyList<string> Findings)
    {
        internal string Line =>
            $"outcomes examined {this.Examined} · happened {this.Happened} · named-wait {this.NamedWait}"
            + $" · cannot-tell {this.CannotTell} · refused {this.Refused}";
    }

    internal static ExpressionCensus Judge(IReadOnlyList<DrivenOutcome> outcomes)
    {
        var findings = new List<string>();
        int happened = 0;
        int namedWait = 0;
        int cannotTell = 0;
        int refused = 0;
        foreach (DrivenOutcome outcome in outcomes)
        {
            switch (outcome.Answer)
            {
                case ExpressionAnswer.Happened:
                    happened += 1;
                    break;
                case ExpressionAnswer.NamedWait:
                    namedWait += 1;
                    break;
                case ExpressionAnswer.CannotTell:
                    cannotTell += 1;
                    findings.Add($"{Gate}:{outcome.ActionId}:{outcome.Case.Name}");
                    break;
                default:
                    refused += 1;
                    break;
            }
        }

        return new ExpressionCensus(outcomes.Count, happened, namedWait, cannotTell, refused, findings);
    }

    /// <summary>
    /// Which answer one terminal is. A WAIT is decided before a refusal, and only by the hold vocabulary the rest of
    /// the Mod publishes (<c>next_step=</c> / <c>retry_window_ms=</c>): a refusal that names neither is a decided
    /// refusal and not a wait with the name missing.
    /// </summary>
    internal static ExpressionAnswer AnswerOf(ExecutionState state, string? evidence) => state switch
    {
        ExecutionState.Succeeded or ExecutionState.PartiallySucceeded or ExecutionState.Accepted
            or ExecutionState.Running or ExecutionState.MeaningfulProgress => ExpressionAnswer.Happened,
        ExecutionState.Uncertain => ExpressionAnswer.CannotTell,
        ExecutionState.Rejected or ExecutionState.Expired or ExecutionState.Cancelled
            or ExecutionState.Blocked or ExecutionState.Invalidated or ExecutionState.Failed =>
            NamesAWait(evidence) ? ExpressionAnswer.NamedWait : ExpressionAnswer.Refused,
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, "no expression answer is declared for this execution state"),
    };

    private static bool NamesAWait(string? evidence) =>
        evidence is not null
        && (evidence.Contains("next_step=", StringComparison.Ordinal)
            || evidence.Contains("retry_window_ms=", StringComparison.Ordinal));

    /// <summary>One world condition the expression's answer depends on, and the answer it must produce there.</summary>
    internal sealed record ExpressionCase(
        string Name,
        bool EventUp,
        bool Emoting,
        bool BoundBody,
        string Emote,
        ExpressionAnswer Expected)
    {
        /// <summary>The engine's two guards, then the two facts that refuse before any native call.</summary>
        internal static readonly ExpressionCase[] All =
        {
            new("clear_world", EventUp: false, Emoting: false, BoundBody: true, Emote: FarmhandActionCatalog.EmoteEnum[0], ExpressionAnswer.Happened),
            new("cutscene_up", EventUp: true, Emoting: false, BoundBody: true, Emote: FarmhandActionCatalog.EmoteEnum[0], ExpressionAnswer.NamedWait),
            new("emote_playing", EventUp: false, Emoting: true, BoundBody: true, Emote: FarmhandActionCatalog.EmoteEnum[0], ExpressionAnswer.NamedWait),
            new("unknown_emote", EventUp: false, Emoting: false, BoundBody: true, Emote: "jar", ExpressionAnswer.Refused),
            new("no_bound_body", EventUp: false, Emoting: false, BoundBody: false, Emote: FarmhandActionCatalog.EmoteEnum[0], ExpressionAnswer.Refused),
        };

        internal static ExpressionCase ClearWorld => All[0];

        internal static ExpressionCase CutsceneUp => All[1];

        internal static ExpressionCase EmotePlaying => All[2];
    }
}
