// Tests for the two halves of the create-then-enter loop: the decision that reads a
// staged world request as create/enter/refuse, and the bounded ownership of the
// native LAN host option for a GameBuddy-launched companion session.
//
// Scope, stated honestly: neither the native save load nor the engine's own server
// start can be driven from a unit test - both need the live game. What is covered
// here is the rule that chooses between them, every branch that must refuse rather
// than adopt or overwrite, and the enable/restore/idempotence of the host option,
// which is plain engine state. The live consequences (a second session entering the
// world it created, and the advertisement the engine's server makes possible) stay
// unverified by this file.
using System;
using FluentAssertions;
using GameBuddy.Stardew;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class WorldCreationDecisionTests
{
    private static WorldCreationConfig StagedForm(string farmName = "GameBuddy Farm") => new()
    {
        Enable = true,
        FarmName = farmName,
        PlayerName = "GameBuddy",
        FavoriteThing = "Companion",
        CreateOnce = true,
    };

    private static WorldSaveIdentity Save(
        string slotName,
        string farmName = "GameBuddy Farm",
        string playerName = "GameBuddy",
        string favoriteThing = "Companion") =>
        new(slotName, farmName, playerName, favoriteThing);

    // ---- the native slot shape, pinned against the game's own naming --------------

    [Fact]
    public void TheNativeSlotShapeIsTheFilteredFarmNameAndTheGamesOwnId()
    {
        // SaveGame.cs:448 writes `FilterFileName(farmName) + "_" + uniqueIDForThisGame`,
        // and FilterFileName keeps letters and digits only - which is why the world
        // this lane created on real hardware landed in `GameBuddyFarm_451146820`.
        WorldCreationDecision.FilterSaveName("GameBuddy Farm").Should().Be("GameBuddyFarm");
        WorldCreationDecision.IsNativeSaveSlotFor("GameBuddyFarm_451146820", "GameBuddyFarm").Should().BeTrue();
    }

    [Theory]
    [InlineData("GameBuddyFarm")]          // no id at all
    [InlineData("GameBuddyFarm_")]         // empty id
    [InlineData("GameBuddyFarm_abc")]      // id is not the game's numeric id
    [InlineData("GameBuddyFarm2_4511")]    // a different farm name that merely starts the same
    [InlineData("OtherFarm_451146820")]    // another farm entirely
    public void AFolderThatIsNotThisFarmNamesOwnNativeSlotIsNotACandidate(string slotName)
    {
        WorldCreationDecision.IsNativeSaveSlotFor(slotName, "GameBuddyFarm").Should().BeFalse();
    }

    // ---- the three outcomes -------------------------------------------------------

    [Fact]
    public void WithNoSaveOfThisRequestTheAnswerIsToCreateExactlyOne()
    {
        WorldCreationPlan plan = WorldCreationDecision.Decide(StagedForm(), new[] { Save("SomeoneElsesFarm_7", farmName: "Someone Else") });
        plan.Outcome.Should().Be(WorldCreationOutcome.CreateWorld);
        plan.Refusal.Should().Be(WorldCreationRefusal.None);
    }

    [Fact]
    public void AnEmptySaveListIsStillCreate()
    {
        WorldCreationDecision.Decide(StagedForm(), Array.Empty<WorldSaveIdentity>())
            .Outcome.Should().Be(WorldCreationOutcome.CreateWorld);
    }

    [Fact]
    public void ThisRequestsOwnWorldIsEnteredByItsExactPhysicalSlot()
    {
        // The point of the whole change: a later session of the same companion world
        // finds the world the first session created and goes back into that exact
        // save instead of refusing, or creating a second one.
        WorldCreationPlan plan = WorldCreationDecision.Decide(StagedForm(), new[]
        {
            Save("SomeOtherFarm_11", farmName: "Unrelated"),
            Save("GameBuddyFarm_451146820"),
        });

        plan.Outcome.Should().Be(WorldCreationOutcome.EnterExistingWorld);
        plan.SlotName.Should().Be("GameBuddyFarm_451146820");
        plan.Refusal.Should().Be(WorldCreationRefusal.None);
    }

    [Fact]
    public void ASaveNamedForThisFarmThatIsNotIdentityEqualIsNeverAdopted()
    {
        // A collision that is not this request's own world must not be entered: it
        // belongs to someone else (a different player name here).
        WorldCreationPlan plan = WorldCreationDecision.Decide(StagedForm(), new[]
        {
            Save("GameBuddyFarm_451146820", playerName: "Somebody Else"),
        });

        plan.Outcome.Should().Be(WorldCreationOutcome.Refuse);
        plan.Reason.Should().Contain("not this request's own world");
        plan.Refusal.Should().Be(WorldCreationRefusal.ForeignSlotCollision);
    }

    [Fact]
    public void OneDifferentIdentityFieldIsEnoughToRefuse()
    {
        WorldCreationDecision.Decide(StagedForm(), new[]
        {
            Save("GameBuddyFarm_451146820", favoriteThing: "Coffee"),
        }).Outcome.Should().Be(WorldCreationOutcome.Refuse);

        WorldCreationDecision.Decide(StagedForm(), new[]
        {
            Save("GameBuddyFarm_451146820", farmName: "GameBuddy Farm "),
        }).Outcome.Should().Be(WorldCreationOutcome.Refuse);
    }

    [Fact]
    public void TwoIdentityEqualSavesAreAmbiguousAndRefused()
    {
        // This is the case a player has to answer, and the bounded code is what the
        // product branches on to say so: more than one companion world exists, so the
        // product can ask the player which one instead of failing opaquely.
        WorldCreationPlan plan = WorldCreationDecision.Decide(StagedForm(), new[]
        {
            Save("GameBuddyFarm_451146820"),
            Save("GameBuddyFarm_999999999"),
        });

        plan.Outcome.Should().Be(WorldCreationOutcome.Refuse);
        plan.Reason.Should().Contain("ambiguous");
        plan.Refusal.Should().Be(WorldCreationRefusal.MultipleOwnWorlds);
    }

    [Fact]
    public void AnUnreadableSaveListRefusesRatherThanGuessingThatNothingExists()
    {
        // A save folder the Mod cannot read is not evidence that no world exists, so
        // the answer must not be "create" - that is how a duplicate world is made.
        WorldCreationPlan plan = WorldCreationDecision.Decide(StagedForm(), null);

        plan.Outcome.Should().Be(WorldCreationOutcome.Refuse);
        plan.Reason.Should().Contain("could not be read");
        plan.Refusal.Should().Be(WorldCreationRefusal.SavesUnreadable);
    }

    [Fact]
    public void AFarmNameWithNoNativeSaveIdentityRefuses()
    {
        WorldCreationPlan plan = WorldCreationDecision.Decide(StagedForm("/**/"), Array.Empty<WorldSaveIdentity>());
        plan.Outcome.Should().Be(WorldCreationOutcome.Refuse);
        plan.Refusal.Should().Be(WorldCreationRefusal.FarmNameHasNoSaveIdentity);
    }
}

public sealed class CompanionSessionHostingTests
{
    [Fact]
    public void ACompanionSessionHostsAndThenPutsThePlayersOwnValuesBack()
    {
        // The engine starts its own server from these two facts and only these two
        // (Multiplayer.cs:1777-1811), so the session has to present them, and it has
        // to hand the player's own values back once it is over.
        Options options = new() { enableServer = false };
        byte modeBefore = Game1.multiplayerMode;
        try
        {
            Game1.options = options;
            Game1.multiplayerMode = 0;
            CompanionSessionHosting hosting = new(new DummyMonitor());

            hosting.Observe();
            options.enableServer.Should().BeTrue();
            Game1.multiplayerMode.Should().Be(CompanionSessionHosting.ServerMultiplayerMode);

            hosting.End();
            options.enableServer.Should().BeFalse();
            Game1.multiplayerMode.Should().Be(0);
        }
        finally
        {
            Game1.multiplayerMode = modeBefore;
        }
    }

    [Fact]
    public void HostingIsIdempotentAndRestoresExactlyOnce()
    {
        Options options = new() { enableServer = false };
        byte modeBefore = Game1.multiplayerMode;
        try
        {
            Game1.options = options;
            Game1.multiplayerMode = 0;
            CompanionSessionHosting hosting = new(new DummyMonitor());

            hosting.Observe();
            hosting.Observe();
            hosting.Observe();
            options.enableServer.Should().BeTrue();

            hosting.End();
            hosting.End();
            options.enableServer.Should().BeFalse();
            Game1.multiplayerMode.Should().Be(0);
        }
        finally
        {
            Game1.multiplayerMode = modeBefore;
        }
    }

    [Fact]
    public void APlayerWhoTakesTheOptionOverIsLeftAlone()
    {
        // The Mod must not fight the player: once they turn the LAN option off
        // themselves during a session, that value is theirs and stays.
        Options options = new() { enableServer = false };
        byte modeBefore = Game1.multiplayerMode;
        try
        {
            Game1.options = options;
            Game1.multiplayerMode = 0;
            CompanionSessionHosting hosting = new(new DummyMonitor());

            hosting.Observe();
            options.enableServer = false;   // the player turns it off mid-session
            hosting.Observe();
            hosting.Observe();
            options.enableServer.Should().BeFalse();

            hosting.End();
            options.enableServer.Should().BeFalse();
        }
        finally
        {
            Game1.multiplayerMode = modeBefore;
        }
    }

    [Fact]
    public void ASessionThatNeverHostedWritesNothingAtTheEnd()
    {
        Options options = new() { enableServer = true };
        byte modeBefore = Game1.multiplayerMode;
        try
        {
            Game1.options = options;
            Game1.multiplayerMode = 7;
            CompanionSessionHosting hosting = new(new DummyMonitor());

            hosting.End();
            options.enableServer.Should().BeTrue();
            Game1.multiplayerMode.Should().Be(7);
        }
        finally
        {
            Game1.multiplayerMode = modeBefore;
        }
    }
}
