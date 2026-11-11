using System.Collections.Generic;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Sensory;
using StardewValley;
using StardewValley.Menus;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE MODAL STREAM: one <c>modal_presented</c> fact per mount, one <c>modal_dismissed</c> fact per unmount, whatever
/// the menu.
///
/// The defect this covers is a GAP rather than a wrong answer: the companion called <c>stardew_observe</c> four times in
/// 44 minutes of the last live run, so a <c>ShippingMenu</c>, a <c>LevelUpMenu</c>, a letter or a shop counter reached her
/// only if she happened to ask. The engine's <c>activeClickableMenu</c> is the single slot that answers "is a menu up", so
/// one observer over that slot covers the whole population - which
/// <see cref="ModalTransitionFactCoverageTests"/> derives from the decompiled tree rather than trusting this file.
///
/// The tests drive the real <see cref="ModalTransitionObserver"/> against the real <c>Game1</c> statics through
/// <see cref="ModalFactProbe"/>; only the engine's time-pass verdict is supplied through the observer's own seam.
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the observer is called for real against real Game1 statics; only the time-pass verdict,
// which reads the live world, is supplied through a seam.
public sealed class ModalTransitionObserverTests
{
    // ---- one fact per transition -------------------------------------------------

    [Fact]
    public void OneMountedMenuIsOneFactHoweverLongItStands()
    {
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        var observer = new ModalTransitionObserver(new DummyMonitor(), static () => true);
        game.SetActiveMenu(ModalFactProbe.Menu<ShippingMenu>());

        for (int tick = 0; tick < 30; tick += 1)
        {
            Game1.ticks = ModalFactProbe.FakeTick + tick;
            observer.Observe(session);
        }

        sink.Emissions.Should().Be(1, "a settlement sheet that stands for half an hour is still one mount");
        BridgeWorldFact fact = sink.FactAt(0);
        fact.Kind.Should().Be(ModalPresentedPayload.Kind);
        fact.EventId.Should().Be(fact.DeduplicationKey);
        fact.EventId.Should().Be(fact.SourceEventId);
        fact.EventId.Should().StartWith($"modal_shown_{ModalFactProbe.FakeTick}_", "the tick is still part of the identity");
        JsonElement payload = ModalFactProbe.PayloadOf(fact);
        payload.GetProperty("modalType").GetString().Should().Be(nameof(ShippingMenu));
        payload.GetProperty("isQuestion").GetBoolean().Should().BeFalse();
        payload.GetProperty("responseKeys").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public void AnUnmountIsItsOwnFactAndIsPublishedOnce()
    {
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        var observer = new ModalTransitionObserver(new DummyMonitor(), static () => true);
        game.SetActiveMenu(ModalFactProbe.Menu<LevelUpMenu>());

        observer.Observe(session);
        game.SetActiveMenu(null);
        observer.Observe(session);
        observer.Observe(session);

        sink.Emissions.Should().Be(2, "a mount and its unmount, and nothing after either");
        sink.FactAt(1).Kind.Should().Be(ModalDismissedPayload.Kind);
        ModalFactProbe.PayloadOf(sink.FactAt(1)).GetProperty("modalType").GetString().Should().Be(nameof(LevelUpMenu),
            "an unmount that names nothing is how a stale snapshot looks like a living menu");
    }

    [Fact]
    public void AReplacementNamesTheMenuThatGoneBeforeTheOneThatArrived()
    {
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        var observer = new ModalTransitionObserver(new DummyMonitor(), static () => true);
        game.SetActiveMenu(ModalFactProbe.Menu<ShippingMenu>());
        observer.Observe(session);
        game.SetActiveMenu(ModalFactProbe.Menu<GameMenu>());
        observer.Observe(session);

        sink.Emissions.Should().Be(3);
        sink.FactAt(1).Kind.Should().Be(ModalDismissedPayload.Kind);
        ModalFactProbe.PayloadOf(sink.FactAt(1)).GetProperty("modalType").GetString().Should().Be(nameof(ShippingMenu));
        sink.FactAt(2).Kind.Should().Be(ModalPresentedPayload.Kind);
        ModalFactProbe.PayloadOf(sink.FactAt(2)).GetProperty("modalType").GetString().Should().Be(nameof(GameMenu));
    }

    [Fact]
    public void AMenuTheEngineRemountsBetweenTwoTicksIsStillOneFact()
    {
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        var observer = new ModalTransitionObserver(new DummyMonitor(), static () => true);
        ShippingMenu menu = ModalFactProbe.Menu<ShippingMenu>();
        game.SetActiveMenu(menu);
        observer.Observe(session);

        // The engine empties and refills the slot inside ONE frame; this observer reads it once per tick, after the
        // engine's own update, so the frame is one transition rather than two.
        game.SetActiveMenu(null);
        game.SetActiveMenu(menu);
        observer.Observe(session);

        sink.Emissions.Should().Be(1);
    }

    // ---- what the fact says about the menu ---------------------------------------

    [Fact]
    public void AQuestionNamesTheKeysTheGameOffers()
    {
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        var observer = new ModalTransitionObserver(new DummyMonitor(), static () => true);
        DialogueBox box = ModalFactProbe.Menu<DialogueBox>();
        box.isQuestion = true;
        box.responses = new[] { new Response("Yes", "Yes, it's lovely"), new Response("No", "Not really") };
        game.SetActiveMenu(box);

        observer.Observe(session);

        JsonElement payload = ModalFactProbe.PayloadOf(sink.FactAt(0));
        payload.GetProperty("isQuestion").GetBoolean().Should().BeTrue();
        // The exact tokens `answer_dialogue` takes back, in the order the game shows them.
        payload.GetProperty("responseKeys").EnumerateArray().Select(key => key.GetString()).Should().Equal("Yes", "No");
    }

    [Fact]
    public void ADialogueBoxPublishesNoWordsBecauseTheDialogueFactOwnsThem()
    {
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        var observer = new ModalTransitionObserver(new DummyMonitor(), static () => true);
        DialogueBox box = ModalFactProbe.Menu<DialogueBox>();
        box.dialogues = new List<string> { "Tomorrow's forecast: heavy rain." };
        game.SetActiveMenu(box);

        observer.Observe(session);

        // The one owner of a dialogue box's prose is `npc_dialogue_presented`, which pages the box and reports what the
        // game really showed. A second copy here is the duplicate path this fact must not grow.
        ModalFactProbe.PayloadOf(sink.FactAt(0)).GetProperty("text").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public void ALetterPublishesItsWordsBoundedToTheCeiling()
    {
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        var observer = new ModalTransitionObserver(new DummyMonitor(), static () => true);
        LetterViewerMenu letter = ModalFactProbe.Menu<LetterViewerMenu>();
        letter.mailMessage = new List<string> { new string('x', ModalTransitionObserver.MaximumTextChars + 60) };
        game.SetActiveMenu(letter);

        observer.Observe(session);

        // A letter is the one menu whose whole content is prose no other reader can reach, and its words are gone the
        // moment it is closed - so it is the one menu whose text this fact carries, and it carries a bounded excerpt.
        ModalFactProbe.PayloadOf(sink.FactAt(0)).GetProperty("text").GetString()
            .Should().HaveLength(ModalTransitionObserver.MaximumTextChars);
    }

    [Fact]
    public void TheEnginesTimePassVerdictIsPublishedInverted()
    {
        // `Game1.shouldTimePass()` is the engine's own answer to "does the clock advance now" (`Game1.cs:9295-9306`),
        // and the menu clause inside it is what separates a `ShippingMenu` from the `BobberBar` it exempts. Read it,
        // never re-derive it: a hand-written copy of that clause would agree today and disagree the day it moves.
        using var game = new ModalFactProbe.GameStateScope();
        IClickableMenu menu = ModalFactProbe.Menu<ShippingMenu>();
        ModalTransitionObserver.Describe(menu, blocksTimePass: true).BlocksTimePass.Should().BeTrue();
        ModalTransitionObserver.Describe(menu, blocksTimePass: false).BlocksTimePass.Should().BeFalse();

        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        var frozen = new ModalTransitionObserver(new DummyMonitor(), static () => false);
        game.SetActiveMenu(menu);
        frozen.Observe(session);

        ModalFactProbe.PayloadOf(sink.FactAt(0)).GetProperty("blocksTimePass").GetBoolean().Should().BeTrue(
            "the seam answers 'the clock advances', so a frozen world inverts to blocking");
    }
}
