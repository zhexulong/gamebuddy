using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The Host player's script channel is the fixture telling the HOST PLAYER what to do, and it exists because the Player
/// Host topology has no bridge: the Mod builds a <c>LocalPipeBridge</c> only on the AI-Farmhand instance
/// (<c>ModEntry.cs</c> returns early when <c>hostRoleConfigured</c>) and that one bridge admits a single consumer. So a
/// paired run's second farmer can only be moved by a file arm, exactly as the cross-day lifecycle moves her to bed.
///
/// These assertions cover the three halves that must fail closed without a live game: the document's cross-process
/// protocol (the harness writes it, this Mod performs it), the ADOPTION rule that keeps one document from being performed
/// twice, and the opt-in configuration gate. The moves themselves need a running world and belong to the live lane.
///
/// The adoption rule is the one S2 proved necessary: the first shape read one file once and finished forever, so the
/// steps S2 appended to the same path were never read at all. The document is a sequence now - each step carries its own
/// 1-based <c>seq</c>, the channel keeps a cursor over what it adopted, and a step is new exactly when its position is
/// past that cursor.
/// </summary>
public sealed class HostPlayerScriptChannelTests
{
    private static string ScratchPath(string name) => Path.Combine(Path.GetTempPath(), $"gamebuddy-host-player-script-{name}.json");

    private static string Script(params string[] steps) => ScriptDocument(false, steps);

    private static string ScriptDocument(bool sealedDocument, params string[] steps) =>
        "{\"schema\":\"" + HostPlayerScriptChannel.Schema + "\",\"sealed\":" + (sealedDocument ? "true" : "false")
        + ",\"steps\":[" + string.Join(",", steps) + "]}";

    private static HostPlayerScriptChannel Armed(string scriptPath, string recordsPath) =>
        new(new DummyMonitor(), new HostPlayerScriptConfig
        {
            Enable = true,
            ScriptPath = scriptPath,
            RecordsPath = recordsPath,
        });

    [Fact]
    public void Schema_IsTheOneTheHarnessWrites() =>
        // The run's own constant is asserted against the same literal, so a drift on either side fails its own test
        // instead of producing a script the other side refuses at run time. It is v2 because the consumption model
        // changed: one file read once (v1) could never carry S2's steps, and a v1 document has no `seq` to order them by.
        HostPlayerScriptChannel.Schema.Should().Be("gamebuddy-host-player-script/v2");

    [Fact]
    public void TryParseScript_ReadsAllFiveStepsTheChannelCanPerform()
    {
        bool parsed = HostPlayerScriptChannel.TryParseScript(
            Script(
                "{\"seq\":1,\"stepId\":\"walk\",\"action\":\"walk_to_tile\",\"location\":\"Farm\",\"x\":39,\"y\":17,\"nearby\":true}",
                "{\"seq\":2,\"stepId\":\"emote\",\"action\":\"emote\",\"emote\":\"exclamation\"}",
                "{\"seq\":3,\"stepId\":\"say\",\"action\":\"say\",\"text\":\"东边那棵树先留着。\"}",
                "{\"seq\":4,\"stepId\":\"chest\",\"action\":\"chest_take\",\"targetRef\":\"chest_Farm_30_20\",\"expectedQualifiedItemId\":\"(O)24\"}",
                "{\"seq\":5,\"stepId\":\"sleep\",\"action\":\"sleep\"}"),
            out HostPlayerScriptDocument document,
            out string reasonCode,
            out string detail);

        parsed.Should().BeTrue(detail);
        reasonCode.Should().BeEmpty();
        document.Steps.Should().HaveCount(5);
        document.Steps.Select(step => step.Seq).Should().Equal(
            new[] { 1, 2, 3, 4, 5 },
            "a step's position IS its identity, and it is 1-based");
        document.Steps[0].Kind.Should().Be(HostPlayerScriptStepKind.WalkToTile);
        document.Steps[0].Location.Should().Be("Farm");
        (document.Steps[0].X, document.Steps[0].Y).Should().Be((39, 17));
        document.Steps[0].Nearby.Should().BeTrue("a crop occupies the tile a person stands beside, so the step asks for a neighbour");
        document.Steps[1].Kind.Should().Be(HostPlayerScriptStepKind.Emote);
        document.Steps[1].Argument.Should().Be("exclamation");
        document.Steps[2].Kind.Should().Be(HostPlayerScriptStepKind.Say);
        document.Steps[2].Argument.Should().Be("东边那棵树先留着。");
        document.Steps[3].Kind.Should().Be(HostPlayerScriptStepKind.ChestTake);
        document.Steps[3].Argument.Should().Be("chest_Farm_30_20|(O)24", "one payload per step, and the container is an address plus the item it holds");
        // WHICH BED IS THE ENGINE'S ANSWER, so the one step that starts a night carries no payload at all: a tile here
        // would be a second spelling of `FarmHouse.GetPlayerBedSpot()` that the fixture would have to keep in step with a
        // save it does not own.
        document.Steps[4].Kind.Should().Be(HostPlayerScriptStepKind.Sleep);
        document.Steps[4].Argument.Should().BeEmpty();
        document.Sealed.Should().BeFalse("a writer that has not finished appending is a channel that may still be given steps");
    }

    [Fact]
    public void TryParseScript_ReadsTheSealTheFixtureEndsTheDocumentWith()
    {
        HostPlayerScriptChannel.TryParseScript(
            ScriptDocument(true, "{\"seq\":1,\"stepId\":\"emote\",\"action\":\"emote\",\"emote\":\"heart\"}"),
            out HostPlayerScriptDocument document,
            out _,
            out string detail).Should().BeTrue(detail);

        document.Sealed.Should().BeTrue("`sealed` is the fixture saying it will append no more, which is the only quiet end");

        // A `sealed` that is not a boolean is a writer bug, and reading it as `false` would leave the channel waiting
        // for steps nobody will write.
        HostPlayerScriptChannel.TryParseScript(
            "{\"schema\":\"" + HostPlayerScriptChannel.Schema + "\",\"sealed\":\"yes\",\"steps\":[]}",
            out _,
            out string reasonCode,
            out string sealedDetail).Should().BeFalse();
        reasonCode.Should().Be("script_sealed_invalid");
        sealedDetail.Should().Contain("field=sealed");
    }

    [Fact]
    public void TryParseScript_RefusesAnActionItCannotPerformInsteadOfSkippingIt()
    {
        HostPlayerScriptChannel.TryParseScript(
            Script("{\"seq\":1,\"stepId\":\"harvest\",\"action\":\"harvest_crop\",\"targetRef\":\"sr1_A\"}"),
            out HostPlayerScriptDocument document,
            out string reasonCode,
            out string detail).Should().BeFalse();

        reasonCode.Should().Be("script_step_invalid");
        detail.Should().Contain("action=harvest_crop", "the refusal names the step AND the action a reader must change");
        detail.Should().Contain("step=harvest");
        document.Steps.Should().BeEmpty("a script with one unusable step is not half-performed");
    }

    /// <summary>
    /// A STEP WITH NO POSITION OF ITS OWN IS REFUSED BY NAME. The cursor advances by position, so every position has to
    /// exist exactly once: a duplicate would make one position performable twice (the same defect as re-reading a
    /// document), and a gap would leave a number nothing can settle.
    /// </summary>
    [Fact]
    public void TryParseScript_RefusesAStepWithoutItsOwnPosition()
    {
        HostPlayerScriptChannel.TryParseScript(
            Script("{\"stepId\":\"walk\",\"action\":\"walk_to_tile\",\"location\":\"Farm\",\"x\":39,\"y\":17}"),
            out _,
            out string missingCode,
            out string missingDetail).Should().BeFalse();
        missingCode.Should().Be("script_step_not_sequenced");
        missingDetail.Should().Contain("field=seq", "the field a reader must write is named");
        missingDetail.Should().Contain("expected=1");

        HostPlayerScriptChannel.TryParseScript(
            Script(
                "{\"seq\":1,\"stepId\":\"walk\",\"action\":\"walk_to_tile\",\"location\":\"Farm\",\"x\":39,\"y\":17}",
                "{\"seq\":1,\"stepId\":\"emote\",\"action\":\"emote\",\"emote\":\"heart\"}"),
            out _,
            out string duplicateCode,
            out string duplicateDetail).Should().BeFalse();
        duplicateCode.Should().Be("script_step_not_sequenced");
        duplicateDetail.Should().Contain("expected=2", "the duplicate is caught where a reader can see the number to write");
        duplicateDetail.Should().Contain("actual=1");

        HostPlayerScriptChannel.TryParseScript(
            Script(
                "{\"seq\":1,\"stepId\":\"walk\",\"action\":\"walk_to_tile\",\"location\":\"Farm\",\"x\":39,\"y\":17}",
                "{\"seq\":3,\"stepId\":\"emote\",\"action\":\"emote\",\"emote\":\"heart\"}"),
            out _,
            out string gapCode,
            out string gapDetail).Should().BeFalse();
        gapCode.Should().Be("script_step_not_sequenced");
        gapDetail.Should().Contain("expected=2");
        gapDetail.Should().Contain("actual=3");
    }

    [Fact]
    public void TryParseScript_RefusesAnotherSchemaAndAMalformedWalk()
    {
        HostPlayerScriptChannel.TryParseScript(
            "{\"schema\":\"gamebuddy-host-player-script/v1\",\"steps\":[]}",
            out _,
            out string schemaCode,
            out string schemaDetail).Should().BeFalse();
        schemaCode.Should().Be("script_schema_unknown");
        schemaDetail.Should().Contain("gamebuddy-host-player-script/v2", "the version that changed the consumption model is the one named");

        HostPlayerScriptChannel.TryParseScript(
            Script("{\"seq\":1,\"stepId\":\"walk\",\"action\":\"walk_to_tile\",\"location\":\"Farm\",\"x\":39}"),
            out _,
            out string stepCode,
            out string stepDetail).Should().BeFalse();
        stepCode.Should().Be("script_step_invalid");
        stepDetail.Should().Contain("field=y", "the refusal names the coordinate a reader must fix");

        // A tile is a map coordinate: the engine's maps start at (0,0), so a negative one is a script error and not a
        // place to walk to. It fails by the FIELD that carries it, the way a missing one does.
        HostPlayerScriptChannel.TryParseScript(
            Script("{\"seq\":1,\"stepId\":\"walk\",\"action\":\"walk_to_tile\",\"location\":\"Farm\",\"x\":-3,\"y\":17}"),
            out _,
            out string negativeCode,
            out string negativeDetail).Should().BeFalse();
        negativeCode.Should().Be("script_step_invalid");
        negativeDetail.Should().Contain("field=x", "the coordinate a reader must fix is the one named");

        HostPlayerScriptChannel.TryParseScript("{not json", out _, out string jsonCode, out _).Should().BeFalse();
        jsonCode.Should().Be("script_unreadable");

        HostPlayerScriptChannel.TryParseScript(
            "{\"schema\":\"gamebuddy-host-player-script/v2\"}",
            out _,
            out string stepsCode,
            out _).Should().BeFalse();
        stepsCode.Should().Be("script_steps_missing");
    }

    /// <summary>
    /// THE DOCUMENT IS ADOPTED ONCE AND A STEP IS NEVER RE-ADOPTED - the same rule that keeps a night from being crossed
    /// twice, and the reason the cursor exists at all. The harness writes the document after the world is live and
    /// APPENDS the next slice's steps to it, so a re-read must hand over only what follows the cursor: re-adopting what
    /// is already there would append the same steps behind the ones already performed and every one of them would run
    /// again.
    /// </summary>
    [Fact]
    public void TheAdoptedSequenceIsNeverReAdoptedAndOnlyWhatFollowsTheCursorIsNew()
    {
        string scriptPath = ScratchPath("adopted-script");
        string recordsPath = ScratchPath("adopted-records");
        try
        {
            File.Delete(scriptPath);
            HostPlayerScriptChannel channel = Armed(scriptPath, recordsPath);

            channel.TryAdoptNewSteps().Should().BeTrue("a document the harness has not written yet is a wait, not a refusal");
            channel.LoadedSteps.Should().BeEmpty();

            File.WriteAllText(scriptPath, Script(
                "{\"seq\":1,\"stepId\":\"walk\",\"action\":\"walk_to_tile\",\"location\":\"Farm\",\"x\":39,\"y\":17,\"nearby\":true}",
                "{\"seq\":2,\"stepId\":\"say\",\"action\":\"say\",\"text\":\"东边那棵树先留着。\"}"));
            channel.TryAdoptNewSteps().Should().BeTrue();
            channel.LoadedSteps.Select(step => step.StepId).Should().Equal("walk", "say");

            // The SAME document, read again: nothing is new, because nothing is past the cursor.
            channel.TryAdoptNewSteps().Should().BeTrue();
            channel.LoadedSteps.Select(step => step.Seq).Should().Equal(new[] { 1, 2 }, "a second read of the same document adopts nothing");
            channel.StopReason.Should().BeNull();

            // S2 appends its steps behind S1's: the document is a sequence, so 3 and 4 are the new ones.
            File.WriteAllText(scriptPath, Script(
                "{\"seq\":1,\"stepId\":\"walk\",\"action\":\"walk_to_tile\",\"location\":\"Farm\",\"x\":39,\"y\":17,\"nearby\":true}",
                "{\"seq\":2,\"stepId\":\"say\",\"action\":\"say\",\"text\":\"东边那棵树先留着。\"}",
                "{\"seq\":3,\"stepId\":\"walk\",\"action\":\"walk_to_tile\",\"location\":\"Farm\",\"x\":30,\"y\":20,\"nearby\":true}",
                "{\"seq\":4,\"stepId\":\"chest\",\"action\":\"chest_take\",\"targetRef\":\"chest_Farm_30_20\",\"expectedQualifiedItemId\":\"(O)24\"}"));
            channel.TryAdoptNewSteps().Should().BeTrue();
            channel.LoadedSteps.Select(step => step.Seq).Should().Equal(1, 2, 3, 4);
            channel.LoadedSteps.Select(step => step.StepId).Should().Equal(
                new[] { "walk", "say", "walk", "chest" },
                "a repeated step id is two steps because two positions carried it");
        }
        finally
        {
            File.Delete(scriptPath);
            File.Delete(recordsPath);
        }
    }

    /// <summary>
    /// A DOCUMENT REWRITTEN UNDER THE CURSOR IS REFUSED, NOT RE-PERFORMED. The cursor makes "which steps have I
    /// performed" a position; a document that shrank, or that changed a step already behind that position, no longer
    /// answers it - so the channel stops by name and keeps exactly the steps it had adopted.
    /// </summary>
    [Fact]
    public void ADocumentRewrittenUnderTheCursorIsRefusedByNameAndNothingIsReAdopted()
    {
        string scriptPath = ScratchPath("rewritten-script");
        string recordsPath = ScratchPath("rewritten-records");
        try
        {
            const string walk = "{\"seq\":1,\"stepId\":\"walk\",\"action\":\"walk_to_tile\",\"location\":\"Farm\",\"x\":39,\"y\":17,\"nearby\":true}";
            File.WriteAllText(scriptPath, Script(walk, "{\"seq\":2,\"stepId\":\"emote\",\"action\":\"emote\",\"emote\":\"heart\"}"));
            HostPlayerScriptChannel shrunken = Armed(scriptPath, recordsPath);
            shrunken.TryAdoptNewSteps().Should().BeTrue();
            shrunken.LoadedSteps.Should().HaveCount(2);

            File.WriteAllText(scriptPath, Script(walk));
            shrunken.TryAdoptNewSteps().Should().BeFalse();
            shrunken.StopReason.Should().Be("script_rewritten_behind_the_cursor");
            shrunken.LoadedSteps.Should().HaveCount(2, "nothing is forgotten and nothing is re-adopted");

            // The same length, one step changed: the payload moved under a position already performed.
            File.WriteAllText(scriptPath, Script(walk, "{\"seq\":2,\"stepId\":\"emote\",\"action\":\"emote\",\"emote\":\"anger\"}"));
            HostPlayerScriptChannel rewritten = Armed(scriptPath, recordsPath);
            rewritten.TryAdoptNewSteps().Should().BeTrue();
            File.WriteAllText(scriptPath, Script(walk, "{\"seq\":2,\"stepId\":\"emote\",\"action\":\"emote\",\"emote\":\"heart\"}"));
            rewritten.TryAdoptNewSteps().Should().BeFalse();
            rewritten.StopReason.Should().Be("script_step_rewritten", "the refusal names the step whose payload moved");
            rewritten.LoadedSteps.Select(step => step.Argument).Should().Equal(new[] { string.Empty, "anger" });
        }
        finally
        {
            File.Delete(scriptPath);
            File.Delete(recordsPath);
        }
    }

    /// <summary>
    /// THE EMOTE THE STUB RAISES IS THE ONE ANOTHER PLAYER'S CLIENT CAN SEE, and these are the engine facts that decide
    /// it: `isEmoting` is a plain field, so the arm `express_emote` uses on the COMPANION's own body reaches no other
    /// client, while `Farmer.netDoEmote` fires a NetEvent whose handler arms that same field on the RECEIVING client's
    /// copy of the Host's Farmer - which is the copy `DescribeOtherFarmerDoing` publishes `emoting` from. An engine that
    /// networked `isEmoting` or moved this event would make the stub's arm the wrong one, and this test is where that
    /// arrives.
    /// </summary>
    [Fact]
    public void TheEmoteTheStubRaisesIsTheOneAnotherPlayersClientCanSee()
    {
        IReadOnlyList<string> character = DecompiledSource.Code(DecompiledSource.Lines("StardewValley/Character.cs"));
        character.Should().Contain(
            line => line.Trim() == "public bool isEmoting;",
            "`isEmoting` is a plain field, so a balloon raised with the local arm is never sent to anyone");

        IReadOnlyList<string> farmer = DecompiledSource.Code(DecompiledSource.Lines("StardewValley/Farmer.cs"));
        DecompiledSource.MethodBody(farmer, "public void netDoEmote(string emote_type)")
            .Select(line => line.Trim())
            .Should().Contain("doEmoteEvent.Fire(emote_type);", "the networked entry is what broadcasts the word");
        farmer.Select(line => line.Trim()).Should().Contain(
            "doEmoteEvent.onEvent += performPlayerEmote;",
            "the receiving client's handler is what plays it on its own copy of the farmer");
        DecompiledSource.MethodBody(farmer, "public void performPlayerEmote(string emote_string)")
            .Select(line => line.Trim())
            .Should().Contain(
                "doEmote(emoteType.emoteIconIndex, nextEventCommand: false);",
                "the balloon the observation publishes as `emoting` is the one this handler arms");
    }

    [Theory]
    [InlineData("", "absolute/records.jsonl")]
    [InlineData("absolute/script.json", "")]
    [InlineData("", "")]
    public void Config_RejectsEitherPathWhenItIsNotAbsolute(string scriptPath, string recordsPath)
    {
        var config = new HostPlayerScriptConfig
        {
            Enable = true,
            ScriptPath = scriptPath,
            RecordsPath = recordsPath,
        };

        config.IsValid.Should().BeFalse();
        HostPlayerScriptChannel.TryStart(new DummyMonitor(), config).Should().BeNull();
    }

    [Theory]
    [InlineData(9)]
    [InlineData(3601)]
    public void Config_RejectsAnOutOfRangeDeadline(int timeoutSeconds)
    {
        var config = new HostPlayerScriptConfig
        {
            Enable = true,
            ScriptPath = ScratchPath("script"),
            RecordsPath = ScratchPath("records"),
            TimeoutSeconds = timeoutSeconds,
        };

        config.IsValid.Should().BeFalse();
    }

    [Fact]
    public void TryStart_StartsOnlyForAValidEnabledArm()
    {
        var valid = new HostPlayerScriptConfig
        {
            Enable = true,
            ScriptPath = ScratchPath("script"),
            RecordsPath = ScratchPath("records"),
        };

        valid.IsValid.Should().BeTrue();
        HostPlayerScriptChannel.TryStart(new DummyMonitor(), valid).Should().NotBeNull();
        HostPlayerScriptChannel.TryStart(new DummyMonitor(), null).Should().BeNull();
        HostPlayerScriptChannel.TryStart(
            new DummyMonitor(),
            new HostPlayerScriptConfig { Enable = false, ScriptPath = valid.ScriptPath, RecordsPath = valid.RecordsPath })
            .Should().BeNull("a disabled arm must not poll a file or write a record");
    }

    [Fact]
    public void TheHostAutomationFixtureGate_RejectsARelativeScriptArm()
    {
        var fixture = new HostAutomationConfig
        {
            Enable = true,
            SaveName = "GameBuddyFixture_paired",
            HostPlayerScript = new HostPlayerScriptConfig
            {
                Enable = true,
                ScriptPath = "relative/script.json",
                RecordsPath = ScratchPath("records"),
            },
        };

        fixture.IsValid.Should().BeFalse("an arm the channel cannot poll is a fixture that would silently never move the Host player");

        var armed = new HostAutomationConfig
        {
            Enable = true,
            SaveName = "GameBuddyFixture_paired",
            HostPlayerScript = new HostPlayerScriptConfig
            {
                Enable = true,
                ScriptPath = ScratchPath("script"),
                RecordsPath = ScratchPath("records"),
            },
        };

        armed.IsValid.Should().BeTrue();
        // The pre-existing gate still decides the rest: no arm at all keeps an ordinary HostAutomation profile valid.
        new HostAutomationConfig { Enable = true, SaveName = "GameBuddyFixture_paired" }.IsValid.Should().BeTrue();
    }
}
