using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_refusal_with_no_admissible_action_names_what_ends_it:&lt;code&gt;` - a hold that admits NOTHING has to say what
/// ends it, and a hold whose step asks for the reading that already refused her is a loop, not a step.
///
/// <para>
/// MEASURED `round83`: two `destination_locked` receipts read
/// <c>held_by=unknown_holder:CanMove;can_move=false;admissible_actions=none;next_step=observe_again</c> six seconds
/// apart, and the game clock then stood at 1530 for seven minutes. Both halves were defects: the holder named a
/// per-frame property rather than what took the body, and the step named the read that had just answered. The run did
/// exactly that - `observe -&gt; destination_locked -&gt; observe` - because nothing in the sentence ended.
/// </para>
///
/// <para>
/// THE POPULATION IS DERIVED, TWICE. The kinds are the classifier's own closed set
/// (<see cref="ActorDispositionKind"/>) driven through the production evidence builder, so a kind added to that enum
/// is in this gate the moment it exists; and the files that REPORT `admissible_actions=none` are read out of the Mod's
/// source, so a second publisher cannot hand a caller a word outside the population. Each shape's code is
/// <see cref="WorldModel.HoldReasonCode"/>'s, the one owner of that spelling.
/// </para>
///
/// <para>
/// A code counts as naming the end only if EVERY shape it publishes does: one looping shape under a code that also
/// publishes a bounded one is still the loop that keeps a run in `observe`.
/// </para>
/// </summary>
public sealed class RefusalWithNoAdmissibleActionGateTests
{
    /// <summary>
    /// `round83`, verbatim: the two receipts at `tools/_multiday_routine-round83-live-runner.log` lines 37092 and 37220
    /// (`atMs` 1795172496144 and 1795172501926). Kept as the text it was, because this gate's falsifier is that run and
    /// not one the author invented.
    /// </summary>
    private const string Round83Evidence =
        "destination=Farm;actionable=false;held_by=unknown_holder:CanMove;can_move=false;admissible_actions=none;next_step=observe_again";

    private const string ModSource = "integrations/stardew";
    private const string CountermeasureOwner = "integrations/stardew/WorldModel.cs";

    /// <summary>
    /// Directories under the Mod that hold no production source: build output, the pins that read it, and the
    /// action-development toolchain. Every other directory is scanned, so a new source directory joins the population
    /// by existing rather than by being added here.
    /// </summary>
    private static readonly string[] NotProductionSource = { "bin", "obj", "tests", "action-development" };
    /// <summary>The two facts that decide the pass-out the faint fixture needs, from <see cref="WorldModel"/> itself.</summary>
    private const float PassOutStaminaBelowFloor = -20f;

    /// <summary>200 ms, the value `express_emote` writes into `Farmer.noMovementPause` (Farmer.cs:2505).</summary>
    private const int NativeBodyPauseMs = 200;

    private readonly ITestOutputHelper output;

    public RefusalWithNoAdmissibleActionGateTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryRefusalWithNoAdmissibleActionNamesWhatEndsIt()
    {
        Report report = Scan();

        this.output.WriteLine(report.Line);
        foreach (Hold loop in report.Loops)
            this.output.WriteLine($"loop {loop.Code} step={loop.NextStep}");

        report.Codes.Should().NotBeEmpty("a gate whose population is empty agrees with itself");
        report.ForeignPublishers.Should().BeEmpty(
            $"{report.Line}; a countermeasure published outside {CountermeasureOwner} is a word this gate never classified");
        report.Loops.Should().BeEmpty($"{report.Line}; these codes answer with the read that already refused them");
    }

    /// <summary>
    /// The falsifier, on real history: `round83`'s own evidence goes through the same classification and lands in the
    /// loop column, named. The gate is not green because everything it happens to look at is classified.
    /// </summary>
    [Fact]
    public void TheGateIsRedOnTheEvidenceRound83WasActuallyRefusedWith()
    {
        Report report = Classify(new[] { ("destination_locked", Round83Evidence) });

        report.Loops.Should().ContainSingle();
        report.Loops[0].Code.Should().Be("destination_locked");
        report.Loops[0].NextStep.Should().Be("observe_again");
        report.Line.Should().Be("codes 1 · names-the-end 0 · loops 1");
    }

    /// <summary>
    /// The shape `round83` was refused in, through the production builder: a named holder instead of
    /// `unknown_holder:CanMove`, and a step that ends the attempt instead of asking for the same reading again.
    /// </summary>
    [Fact]
    public void TheShapeRound83WasRefusedInNowNamesItsHolderAndEnds()
    {
        string now = WorldModel.DescribeHeldBody(default, canMove: false, hold: BodyHoldFact.Free).Evidence;
        this.output.WriteLine($"before: {Round83Evidence}");
        this.output.WriteLine($"after:  destination=Farm;actionable=false;{now}");

        now.Should().Contain("held_by=stalled_with_no_holder:CanMove");
        now.Should().Contain($"defect={WorldModel.HoldWithoutOwnerDefect}");
        now.Should().Contain($"next_step={WorldModel.ReportTheStalledBodyStep}");
        now.Should().NotContain("unknown_holder");
        now.Should().NotContain("observe_again");
    }

    /// <summary>
    /// `admissible_actions=none` is a MEASUREMENT - "nothing at all can be done" - and only a DECLARED hold may publish
    /// it: each declared state names its holder and a step that ends it. The body the authority does not know about
    /// publishes the defect instead, so the field can never be reached from a hold nobody declared.
    /// </summary>
    [Fact]
    public void TheNoneClaimIsReachableOnlyFromADeclaredHold()
    {
        ActorDisposition idle = WorldModel.Classify(Facts());
        BodyHoldFact[] declared =
        {
            new(BodyHoldState.Held, BodyHold.EmoteHolder, BodyHold.NativeTimerReason, BodyHold.NowMs() + NativeBodyPauseMs),
            new(BodyHoldState.Held, BodyHold.EmoteHolder, BodyHold.NativeTimerReason, BodyHold.NowMs() - NativeBodyPauseMs),
            new(BodyHoldState.HeldOpen, BodyHold.HolderForSite("Farmer.animateOnce"), BodyHold.UndeclaredWriterReason, null),
        };

        this.output.WriteLine($"codes 1 · declared shapes {declared.Length} · examined {declared.Length + 1}");
        foreach (BodyHoldFact hold in declared)
        {
            string evidence = WorldModel.DescribeHeldBody(idle, Facts(), canMove: false, hold).Evidence;
            this.output.WriteLine($"declared {hold.State} -> {evidence}");
            evidence.Should().Contain($"held_by={hold.Holder}");
            evidence.Should().Contain("admissible_actions=none");
            evidence.Should().NotContain("defect=", "a declared hold is not the absence");
            WorldModel.NextStepEndsTheHold(FieldOf(evidence, "next_step") ?? string.Empty).Should().BeTrue(
                $"every declared state has to offer a step that ends it: {evidence}");
        }

        string undeclared = WorldModel.DescribeHeldBody(idle, Facts(), canMove: false, BodyHoldFact.Free).Evidence;
        this.output.WriteLine($"undeclared -> {undeclared}");
        undeclared.Should().Contain($"held_by={WorldModel.StalledHolderPrefix}{WorldModel.UnnamedHolderEngineFact}");
        undeclared.Should().Contain($"defect={WorldModel.HoldWithoutOwnerDefect}");
        undeclared.Should().NotContain(
            "admissible_actions=none",
            "the absence is named as itself; nothing measured that nothing is admissible");
    }

    /// <summary>
    /// The one closed vocabulary the words come from: every step the Mod publishes is classified as ending its hold, and
    /// the word that only asked for the same reading is not a step.
    /// </summary>
    [Fact]
    public void EveryPublishedStepIsClassifiedAndTheReReadingIsNotAStep()
    {
        string[] steps =
        {
            WorldModel.WaitForRetryWindowStep,
            WorldModel.WaitForDayToAdvanceStep,
            WorldModel.WaitForEventToAdvanceStep,
            WorldModel.ReportTheStalledBodyStep,
        };

        foreach (string step in steps)
            WorldModel.NextStepEndsTheHold(step).Should().BeTrue($"{step} names what clears the hold");

        WorldModel.NextStepEndsTheHold("observe_again").Should().BeFalse(
            "reading the frame again is what the refusal already did");
        WorldModel.NextStepEndsTheHold("a_word_nobody_classified").Should().BeFalse(
            "a word added without being classified must fail this gate by name, not pass on an assumption");
    }

    /// <summary>
    /// Every shape of every kind, as the production evidence builder publishes it. A fixture that stops producing its
    /// own kind is red rather than quietly examined as another one, and a kind with no fixture here is red rather than
    /// silently absent from the population.
    /// </summary>
    private static IReadOnlyList<(string Code, string Evidence)> Shapes()
    {
        var shapes = new List<(string, string)>();
        foreach (ActorDispositionKind kind in Enum.GetValues<ActorDispositionKind>())
        {
            foreach ((string shape, ActorWorldFacts facts, BodyHoldFact hold) in FixturesOf(kind))
            {
                WorldModel.Classify(facts).Kind.Should().Be(
                    kind,
                    $"the {shape} fixture has to be a {kind} hold, or this gate examines another kind under its name");
                shapes.Add((
                    WorldModel.HoldReasonCode(kind),
                    WorldModel.DescribeHeldBody(facts, canMove: false, hold).Evidence));
            }
        }

        return shapes;
    }

    /// <summary>
    /// The facts that produce one kind, and for <see cref="ActorDispositionKind.Idle"/> both shapes of the one flag the
    /// closed set cannot name: a declared body timer, and nothing declared at all.
    /// </summary>
    private static (string Shape, ActorWorldFacts Facts, BodyHoldFact Hold)[] FixturesOf(ActorDispositionKind kind) => kind switch
        {
            ActorDispositionKind.Event => new[] { ("cutscene", Facts(eventUp: true), BodyHoldFact.Free) },
            ActorDispositionKind.Modal => new[] { ("menu", Facts(menuType: "GameMenu"), BodyHoldFact.Free) },
            ActorDispositionKind.PassOut => new[] { ("faint", Facts(stamina: PassOutStaminaBelowFloor), BodyHoldFact.Free) },
            ActorDispositionKind.Transient => new[] { ("warp", Facts(warping: true), BodyHoldFact.Free) },
            ActorDispositionKind.Idle => new[]
            {
                ("body_pause", Facts(), DeclaredBodyPause()),
                ("undeclared", Facts(), BodyHoldFact.Free),
            },
            _ => throw new ArgumentOutOfRangeException(
                nameof(kind),
                kind,
                "a kind Classify can return has no facts here, so this gate would examine it under no shape at all"),
        };

    /// <summary>
    /// The emote's declared timer: the 200 ms window `performPlayerEmote` writes into `Farmer.noMovementPause`
    /// (Farmer.cs:2505), declared as the holder <see cref="BodyHold"/> records for it.
    /// </summary>
    private static BodyHoldFact DeclaredBodyPause() =>
        new(BodyHoldState.Held, BodyHold.EmoteHolder, BodyHold.NativeTimerReason, BodyHold.NowMs() + NativeBodyPauseMs);

    /// <summary>
    /// One <c>key=value</c> field of an evidence sentence, read the way the wire reads it: split on <c>;</c> and then on
    /// <c>=</c>, so a field is a field and never a substring of another.
    /// </summary>
    private static string? FieldOf(string evidence, string key) =>
        evidence
            .Split(';')
            .Select(field => field.Split('='))
            .Where(parts => parts.Length == 2 && parts[0] == key)
            .Select(parts => parts[1])
            .FirstOrDefault();

    private static Report Classify(IEnumerable<(string Code, string Evidence)> shapes)
    {
        var holds = new List<Hold>();
        foreach ((string code, string evidence) in shapes)
        {
            if (FieldOf(evidence, "admissible_actions") != "none")
                continue;
            // A hold that admits nothing and names no step at all is the loop column too: an empty word ends nothing.
            holds.Add(new Hold(code, FieldOf(evidence, "next_step") ?? string.Empty));
        }

        string[] codes = holds
            .Select(hold => hold.Code)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(code => code, StringComparer.Ordinal)
            .ToArray();
        Hold[] loops = holds.Where(hold => !WorldModel.NextStepEndsTheHold(hold.NextStep)).ToArray();
        string[] named = codes.Where(code => loops.All(loop => loop.Code != code)).ToArray();

        return new Report(codes, named, loops, Array.Empty<string>());
    }

    private static Report Scan()
    {
        Report classified = Classify(Shapes());
        return classified with
        {
            ForeignPublishers = CountermeasurePublishers()
                .Where(file => file != CountermeasureOwner)
                .ToArray(),
        };
    }

    /// <summary>
    /// The files that report `admissible_actions=none` at all, read from the Mod's own source with comments removed, so
    /// a sentence ABOUT that field is never read as one. The value, not the field name: a reader that asks
    /// `evidence.Contains("admissible_actions=")` decides nothing about a hold and is not a publisher.
    /// </summary>
    private static string[] CountermeasurePublishers()
    {
        const string Publication = "admissible_actions=none";
        string root = RepositoryRoot();
        var publishers = new List<string>();
        foreach (string file in Directory.EnumerateFiles(Path.Combine(root, ModSource), "*.cs", SearchOption.AllDirectories))
        {
            if (Path.GetRelativePath(root, file)
                .Split(Path.DirectorySeparatorChar)
                .Any(part => NotProductionSource.Contains(part, StringComparer.Ordinal)))
                continue;

            string code = string.Join('\n', File.ReadAllLines(file).Select(DecompiledSource.WithoutComment));
            if (code.Contains(Publication, StringComparison.Ordinal))
                publishers.Add(Path.GetRelativePath(root, file).Replace('\\', '/'));
        }

        return publishers.OrderBy(file => file, StringComparer.Ordinal).ToArray();
    }

    private static string RepositoryRoot()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, CountermeasureOwner)))
                return directory.FullName;
        }

        throw new DirectoryNotFoundException($"{CountermeasureOwner} is not reachable from {AppContext.BaseDirectory}");
    }

    private static ActorWorldFacts Facts(
        bool eventUp = false,
        string? menuType = null,
        float stamina = 200f,
        bool warping = false) =>
        new(
            EventUp: eventUp,
            MenuType: menuType,
            DialogueUp: false,
            TimeOfDay: 1200,
            Stamina: stamina,
            FreezePaused: false,
            Eating: false,
            UsingTool: false,
            ToolCharged: false,
            SelfAnimation: false,
            Warping: warping,
            DayTransition: false,
            ControlsFrozen: false,
            Minigame: false,
            ScreenFade: false);

    /// <summary>One published shape of one code: the code, and the single step it names beside `admissible_actions=none`.</summary>
    private sealed record Hold(string Code, string NextStep);

    private sealed record Report(
        IReadOnlyList<string> Codes,
        IReadOnlyList<string> Named,
        IReadOnlyList<Hold> Loops,
        IReadOnlyList<string> ForeignPublishers)
    {
        internal string Line => $"codes {this.Codes.Count} · names-the-end {this.Named.Count} · loops {this.Loops.Count}";
    }
}
