using System.Collections.Generic;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Sensory;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE LOBBY'S WORDS, as the companion's own client receives them.
///
/// <para>
/// THE FACT THAT DID NOT EXIST. A co-op companion stood beside a human who typed into the lobby and had no fact that said
/// a word had been spoken: the snapshot carries no chat family, and the Mod's one chat hook is a postfix on the HOST's
/// <c>ChatBox.textBoxEnter</c> - the TYPING path, which fires only on the machine whose player typed. What the Host says
/// reaches her client through the engine's receive entry, and these cases drive the shipped
/// <see cref="MultiplayerChatReception"/> with the arguments the engine's own prefix hands it: the message's
/// <c>SourceFarmer</c>, its <c>recipientID</c> and its text (<c>Multiplayer.cs:1151</c>/<c>:1654</c>).
/// </para>
///
/// <para>
/// THE SEAM. The Harmony prefix that feeds this method is the one thing a headless process cannot drive (it needs a live
/// multi-machine lobby), so the prefix is proven by the live run's expectations and everything from the prefix inwards -
/// the speaker, the words, the audience, the clock, the identity and the publication - is driven here for real.
/// </para>
/// </summary>
public sealed class MultiplayerChatReceptionTests
{
    private const string SpeakerName = "Mika";

    [Fact]
    public void AReceivedLineBecomesAFactNamingTheSpeakerTheWordsAndTheClock()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        Farmer speaker = world.PlaceOtherFarmer(SpeakerName, x: 20, y: 2, id: 1002);

        MultiplayerChatReception.PublishReceived(session, speaker, Multiplayer.AllPlayers, "bees are out today", null)
            .Should().BeTrue("the session is authenticated, so the line reaches the wire");

        sink.Emissions.Should().Be(1, "one received line is one fact");
        BridgeWorldFact fact = sink.FactAt(0);
        fact.Kind.Should().Be(MultiplayerChatPayload.Kind);
        fact.GameTime.Should().Be("0900", "the clock is the world's own `Game1.timeOfDay` at receipt, as every sibling fact states it");
        fact.EventId.Should().Be(fact.DeduplicationKey, "the identity is deduplicable, so a re-send collapses instead of repeating the line");
        JsonElement payload = ModalFactProbe.PayloadOf(fact);
        payload.GetProperty("speaker").GetString().Should().Be(SpeakerName, "who said it");
        payload.GetProperty("text").GetString().Should().Be("bees are out today", "what they said, verbatim");
        payload.GetProperty("textTruncated").GetBoolean().Should().BeFalse();
        payload.GetProperty("addressedToThisPlayer").GetBoolean().Should().BeFalse("`Multiplayer.AllPlayers` is the whole lobby");
        payload.GetProperty("day").GetInt32().Should().Be(Game1.Date!.TotalDays, "`gameTime` carries the hour but not which day it belonged to");
    }

    [Fact]
    public void ALineAddressedToHerSaysSoAndALobbyLineDoesNot()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        Farmer speaker = world.PlaceOtherFarmer(SpeakerName, x: 20, y: 2, id: 1002);
        const long herId = 4242;

        MultiplayerChatReception.PublishReceived(session, speaker, herId, "come look at this", null).Should().BeTrue();

        JsonElement payload = ModalFactProbe.PayloadOf(sink.FactAt(0));
        payload.GetProperty("addressedToThisPlayer").GetBoolean().Should().BeTrue(
            "the engine forwards a non-broadcast line only to its addressee (`GameServer.cs:726`), so here it was said TO her");
    }

    [Fact]
    public void AnUnnamedSpeakerIsPublishedAsNotMeasuredRatherThanAsAnEmptyVoice()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        Farmer speaker = world.PlaceOtherFarmer(string.Empty, x: 20, y: 2, id: 1002);

        MultiplayerChatReception.PublishReceived(session, speaker, Multiplayer.AllPlayers, "hi", null).Should().BeTrue();

        ModalFactProbe.PayloadOf(sink.FactAt(0)).GetProperty("speaker").GetString()
            .Should().Be(MultiplayerChatPayload.SpeakerNotMeasured, "a name the engine answers nothing for is a measured absence, not a blank");
    }

    [Fact]
    public void ALinePastTheWireBoundIsPublishedAsItsVerbatimPrefixAndSaysItWasCut()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        Farmer speaker = world.PlaceOtherFarmer(SpeakerName, x: 20, y: 2, id: 1002);
        string longLine = new string('a', FarmhandActionCatalog.ChatMessageMaximumLength + 40);

        MultiplayerChatReception.PublishReceived(session, speaker, Multiplayer.AllPlayers, longLine, null).Should().BeTrue();

        JsonElement payload = ModalFactProbe.PayloadOf(sink.FactAt(0));
        string text = payload.GetProperty("text").GetString()!;
        text.Should().Be(longLine[..FarmhandActionCatalog.ChatMessageMaximumLength], "the bound is the one the send action argues, applied as a prefix");
        payload.GetProperty("textTruncated").GetBoolean().Should().BeTrue("a line that was cut may never read as the whole sentence");
    }

    [Fact]
    public void TwoLinesArrivingInTheSameTickAreTwoFactsWithTheirOwnIdentities()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        Farmer speaker = world.PlaceOtherFarmer(SpeakerName, x: 20, y: 2, id: 1002);

        MultiplayerChatReception.PublishReceived(session, speaker, Multiplayer.AllPlayers, "one", null).Should().BeTrue();
        MultiplayerChatReception.PublishReceived(session, speaker, Multiplayer.AllPlayers, "two", null).Should().BeTrue();

        sink.Emissions.Should().Be(2, "each line is its own fact, never one line per tick");
        sink.FactAt(0).EventId.Should().NotBe(sink.FactAt(1).EventId, "the Mod-owned sequence keeps the identity unique inside one tick");
    }

    [Fact]
    public void WithNoSessionTheLineIsNotPublishedAndNothingThrows()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        using var game = new ModalFactProbe.GameStateScope();
        Farmer speaker = world.PlaceOtherFarmer(SpeakerName, x: 20, y: 2, id: 1002);

        // The bridge may be unauthenticated, closing or absent - the same condition every sibling observer publishes
        // nothing under. A chat line must cost the fact, never the engine's own chat.
        MultiplayerChatReception.PublishReceived(null, speaker, Multiplayer.AllPlayers, "anyone there", null).Should().BeFalse();
    }
}
