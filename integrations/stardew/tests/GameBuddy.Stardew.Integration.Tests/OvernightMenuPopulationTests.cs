using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// WHAT THE NIGHT CAN PUT ON SCREEN IS BIGGER THAN WHAT THE DECLARATION KNOWS.
///
/// <para>
/// `showEndOfNightStuff` (Game1.cs:9112-9161) is one of the night's two menu sources. The other is the day-start farm
/// event - `Utility.pickFarmEvent` (Utility.cs:4559-4687) and `pickPersonalFarmEvent` (Utility.cs:4739-4788) - which can
/// mount a `NamingMenu` (<c>QuestionEvent.cs:123</c>, <c>BirthingEvent.cs:92</c>,
/// <c>PlayerCoupleBirthingEvent.cs:173</c>) or a `DialogueBox` (<c>QuestionEvent.cs:42/61/79/83</c>,
/// <c>BirthingEvent.cs:84</c>, <c>PlayerCoupleBirthingEvent.cs:141/160</c>, <c>SoundInTheNightEvent.cs:180</c>). The new
/// day does not begin until <c>activeClickableMenu</c> is null (Game1.cs:4292-4305), and neither of those drains itself:
/// a headless companion sat behind one until the lifecycle's wall clock ran out, and the receipt said
/// <c>lifecycle_deadline_exceeded</c> about a night that never crossed.
/// </para>
/// <para>
/// THE POPULATION IS READ FROM THE ENGINE, not restated here: the type names come out of the decompiled methods that
/// mount them, so a version that starts pushing a fourth end-of-night menu, or a farm event that starts naming a baby
/// through a different type, changes the population this gate examines and fails by name on the member that has no
/// step and no release. A hand-written list could only have found the members its author remembered - which is exactly
/// how the two farm-event menus were missed.
/// </para>
/// </summary>
public sealed class OvernightMenuPopulationTests
{
    private static readonly Regex EndOfNightPush = new(
        @"endOfNightMenus\.Push\(new\s+(\w+)\(",
        RegexOptions.CultureInvariant);

    private static readonly Regex ActiveMenuAssignment = new(
        @"Game1\.activeClickableMenu\s*=\s*new\s+(\w+)\(",
        RegexOptions.CultureInvariant);

    private static readonly Regex FarmEventConstruction = new(
        @"new\s+(\w+Event)\(",
        RegexOptions.CultureInvariant);

    private static readonly Regex ObjectDialogue = new(
        @"Game1\.drawObjectDialogue\(",
        RegexOptions.CultureInvariant);

    private static readonly Regex QuestionDialogue = new(
        @"createQuestionDialogue\(",
        RegexOptions.CultureInvariant);

    [Fact]
    public void TheDeclarationIsTheEnginesOwnEndOfNightStack()
    {
        IReadOnlyList<string> stack = EndOfNightStack();

        stack.Should().NotBeEmpty(
            "`showEndOfNightStuff` pushes the night's menus onto `endOfNightMenus` (Game1.cs:9112-9161)");

        IReadOnlyList<Type> declared = SleepAndAdvanceDayLifecycle.OvernightMenus
            .Select(menu => menu.MenuType)
            .ToArray();

        // Both directions: a member the engine no longer pushes is a rule about nothing, and a push with no member is a
        // night that stands still.
        declared.Select(type => type.Name).Should().BeEquivalentTo(
            stack,
            $"the declaration must be the engine's stack ({string.Join(",", stack)}), member for member");
    }

    [Fact]
    public void EveryMenuTheNightCanMountEitherHasAStepOrIsReleasedByANamedReading()
    {
        IReadOnlyList<string> population = OvernightPopulation();
        population.Should().NotBeEmpty(
            "a population of zero agrees with itself; the night always has at least the end-of-night stack");

        List<string> violations = new();
        List<string> released = new();
        List<string> declared = new();
        foreach (string name in population)
        {
            Type menuType = ResolveEngineType(name);
            SleepAndAdvanceDayLifecycle.OvernightMenuStep step = SleepAndAdvanceDayLifecycle.DecideOvernightMenuStep(
                menuType,
                ownSleepPrompt: false,
                readyBarrier: false);
            bool hasStep = SleepAndAdvanceDayLifecycle.OvernightMenuFor(menuType) is not null;
            if (hasStep)
            {
                declared.Add(name);
                if (step != SleepAndAdvanceDayLifecycle.OvernightMenuStep.Declared)
                    violations.Add($"declared_member_takes_the_wrong_step:{name}:step={step}");
                continue;
            }

            released.Add(name);
            if (step != SleepAndAdvanceDayLifecycle.OvernightMenuStep.NotRecognised)
                violations.Add($"undeclared_member_is_not_named:{name}:step={step}");
        }

        violations.Should().BeEmpty(
            $"examined {population.Count} menu types the night can mount ({string.Join(",", population)}); "
                + $"declared={string.Join(",", declared)}; released={string.Join(",", released)}");
    }

    [Fact]
    public void TheTwoSurfacesTheLifecycleAlreadyOwnsAreNotReleased()
    {
        // The exemptions are the two things this lifecycle really does own, and they must stay exemptions: a release
        // that swallowed the bed prompt would end a night nobody answered, and one that swallowed the ready barrier
        // would roll a co-op day alone.
        SleepAndAdvanceDayLifecycle.DecideOvernightMenuStep(
                ResolveEngineType("DialogueBox"),
                ownSleepPrompt: true,
                readyBarrier: false)
            .Should().Be(SleepAndAdvanceDayLifecycle.OvernightMenuStep.OwnSleepPrompt);

        SleepAndAdvanceDayLifecycle.DecideOvernightMenuStep(
                ResolveEngineType("ReadyCheckDialog"),
                ownSleepPrompt: false,
                readyBarrier: true)
            .Should().Be(SleepAndAdvanceDayLifecycle.OvernightMenuStep.ReadyBarrier);

        // And the same two types, when they are NOT the lifecycle's own, are the ordinary case: the fairy's and the
        // meteor's message box, and a barrier whose owner is another player's screen.
        SleepAndAdvanceDayLifecycle.DecideOvernightMenuStep(
                ResolveEngineType("DialogueBox"),
                ownSleepPrompt: false,
                readyBarrier: false)
            .Should().Be(SleepAndAdvanceDayLifecycle.OvernightMenuStep.NotRecognised);
        SleepAndAdvanceDayLifecycle.DecideOvernightMenuStep(
                ResolveEngineType("ReadyCheckDialog"),
                ownSleepPrompt: false,
                readyBarrier: false)
            .Should().Be(SleepAndAdvanceDayLifecycle.OvernightMenuStep.NotRecognised);

        SleepAndAdvanceDayLifecycle.DecideOvernightMenuStep(null, ownSleepPrompt: false, readyBarrier: false)
            .Should().Be(SleepAndAdvanceDayLifecycle.OvernightMenuStep.NothingStanding);
    }

    [Fact]
    public void TheReadingNamesTheMenuTheDayAndWhatWasDoneAboutIt()
    {
        string reading = SleepAndAdvanceDayLifecycle.DescribeOvernightMenuNotRecognised(
            ResolveEngineType("NamingMenu"),
            day: 7,
            phase: "AwaitingDayStart",
            SleepAndAdvanceDayLifecycle.OvernightMenuRelease.Released);

        reading.Should().StartWith(
            "overnight_menu_not_recognised:NamingMenu",
            "the type is what an operator greps for, and what a gate can name");
        reading.Should().Contain("day=7", "the reading has to say which night it happened on");
        reading.Should().Contain("phase=AwaitingDayStart", "and which step of the night it interrupted");
        reading.Should().Contain("action=released", "never a silent success: what was done about it is part of the name");

        // Every outcome of the attempt is named, and no two share a word - read off the enum itself so a fourth outcome
        // cannot be added and quietly report the wrong one.
        string[] actions = Enum.GetValues<SleepAndAdvanceDayLifecycle.OvernightMenuRelease>()
            .Select(outcome => SleepAndAdvanceDayLifecycle.DescribeOvernightMenuRelease(outcome))
            .ToArray();
        actions.Should().OnlyHaveUniqueItems();
        actions.Should().NotContain(action => string.IsNullOrWhiteSpace(action));
    }

    [Fact]
    public void TheOvernightStepDecidesWhatItDoesNotKnowBeforeItSpendsAFrameOnIt()
    {
        // Headless, the live path is out of reach (the engine's menus cannot be constructed without a game), so the
        // reach is pinned where it lives: the step decides the stranger first, and the save wait releases it BEFORE it
        // charges the frame to its budget. A release added after `saveBoundaryFrames++` would be a release that runs
        // three hundred frames too late, on the night that already reports `save_boundary_not_observed`.
        string source = WithoutComments(File.ReadAllText(LifecyclePath()));

        string advance = Body(source, "private bool AdvanceEngineCrossingMenu(");
        advance.Should().Contain("ReleaseUnrecognisedOvernightMenu()");
        advance.IndexOf("ReleaseUnrecognisedOvernightMenu()", StringComparison.Ordinal).Should().BeLessThan(
            advance.IndexOf("OvernightMenuFor(", StringComparison.Ordinal),
            "the menu the declaration does not claim is decided before the declaration is asked");

        string save = Body(source, "private bool ObserveSaveBoundary(");
        save.Should().Contain("ReleaseUnrecognisedOvernightMenu()");
        save.IndexOf("ReleaseUnrecognisedOvernightMenu()", StringComparison.Ordinal).Should().BeLessThan(
            save.IndexOf("this.saveBoundaryFrames++;", StringComparison.Ordinal),
            "a menu nobody owns may not be charged to the wait for a save it is blocking");

        // The day-start wait reaches it through the same call, which is the phase the hang was measured in.
        Body(source, "private bool EvaluateDayStart(").Should().Contain("AdvanceEngineCrossingMenu");

        // And the release goes through the engine's own cancels rather than nulling the slot.
        string release = Body(source, "private OvernightMenuRelease ReleaseOvernightMenu(");
        release.Should().Contain(".exitThisMenu()", "the menu's own close path runs its `cleanupBeforeExit` and exit function");
        release.Should().Contain(".closeDialogue()", "`exitThisMenu` alone leaves `Game1.dialogueUp` true for a box");
        release.Should().NotContain("Game1.exitActiveMenu()", "that writes the field and skips everything the type put on the close path");

        // The receipt is what a run is judged by, so the reading has to survive into it.
        Body(source, "private string BuildReceiptEvidence(").Should().Contain("overnight_menu_not_recognised");
    }

    /// <summary>
    /// The fact that made this worth fixing, kept as an assertion so the next reader sees why the release exists: no
    /// wait can turn a night whose rollover is blocked by a menu nothing owns into a day. With the counter at zero the
    /// day-start wait answers <see cref="SleepAndAdvanceDayLifecycle.DayStartOutcome.Waiting"/> however long it runs,
    /// so the only terminal behind it is the lifecycle's wall clock.
    /// </summary>
    [Fact]
    public void AWaitCannotBeTheAnswerToAMenuNothingOwns()
    {
        int budget = SleepAndAdvanceDayLifecycle.SaveBoundaryFrameBudget;
        foreach (int frames in new[] { 0, 1, budget / 2, budget, budget * 4, int.MaxValue })
        {
            SleepAndAdvanceDayLifecycle.DecideDayStart(
                    delta: 0,
                    dayStartedObserved: false,
                    dayStartWaitFrames: frames,
                    budget,
                    engineCrossingMenuStanding: false)
                .Should().Be(SleepAndAdvanceDayLifecycle.DayStartOutcome.Waiting);
        }
    }

    /// <summary>The types `showEndOfNightStuff` pushes, as the engine's own source writes them.</summary>
    private static IReadOnlyList<string> EndOfNightStack() =>
        EndOfNightPush
            .Matches(string.Join('\n', DecompiledSource.MethodBody(
                DecompiledSource.Lines("StardewValley/Game1.cs"),
                "public static void showEndOfNightStuff(")))
            .Select(match => match.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

    /// <summary>
    /// Everything the night can mount: the end-of-night stack plus whatever the day-start farm events put on screen,
    /// both read out of the methods that mount them.
    /// </summary>
    private static IReadOnlyList<string> OvernightPopulation()
    {
        SortedSet<string> population = new(EndOfNightStack(), StringComparer.Ordinal);
        foreach (string farmEvent in FarmEventsTheNightCanPick())
        {
            foreach (string menu in MenusInFarmEvent(farmEvent))
                population.Add(menu);
        }

        return population.ToList();
    }

    /// <summary>The farm events `pickFarmEvent` / `pickPersonalFarmEvent` can return, from their own bodies.</summary>
    private static IReadOnlyList<string> FarmEventsTheNightCanPick()
    {
        IReadOnlyList<string> utility = DecompiledSource.Lines("StardewValley/Utility.cs");
        List<string> events = new();
        foreach (string declaration in new[] { "public static FarmEvent pickFarmEvent(", "public static FarmEvent pickPersonalFarmEvent(" })
        {
            string body = string.Join('\n', DecompiledSource.MethodBody(utility, declaration));
            events.AddRange(FarmEventConstruction.Matches(body).Select(match => match.Groups[1].Value));
        }

        return events.Distinct(StringComparer.Ordinal).OrderBy(name => name, StringComparer.Ordinal).ToList();
    }

    /// <summary>The menus one farm event's own source mounts, and the dialogue box it raises as <c>DialogueBox</c>.</summary>
    private static IReadOnlyList<string> MenusInFarmEvent(string farmEvent)
    {
        IReadOnlyList<string> lines = DecompiledSource.Code(
            DecompiledSource.Lines($"StardewValley.Events/{farmEvent}.cs"));
        string source = string.Join('\n', lines);

        List<string> menus = ActiveMenuAssignment.Matches(source)
            .Select(match => match.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        // `drawObjectDialogue` and `createQuestionDialogue` both mount a `DialogueBox` (Game1.cs:9648-9676,
        // GameLocation.cs:4431-4457), and that is the type the lifecycle has to recognise.
        if (ObjectDialogue.IsMatch(source) || QuestionDialogue.IsMatch(source))
            menus.Add("DialogueBox");

        return menus;
    }

    /// <summary>One menu type by the name the engine's source uses, or a failure that names it.</summary>
    private static Type ResolveEngineType(string name)
    {
        Type? type = typeof(Game1).Assembly.GetTypes().FirstOrDefault(candidate => candidate.Name == name);
        return type
            ?? throw new InvalidOperationException(
                $"engine_type_not_in_this_build:{name} (named by the decompiled source this gate reads)");
    }

    private static string LifecyclePath()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        (directory ?? throw new InvalidOperationException("repository_root_not_found")).FullName.Should().NotBeNull();
        return Path.Combine(directory!.FullName, "integrations", "stardew", "SleepAndAdvanceDayLifecycle.cs");
    }

    private static string WithoutComments(string source) =>
        Regex.Replace(Regex.Replace(source, @"/\*[\s\S]*?\*/", string.Empty), @"(^|[^:])//.*$", "$1", RegexOptions.Multiline);

    /// <summary>The body of one member, from its declaration to the matching close brace.</summary>
    private static string Body(string source, string declaration)
    {
        int at = source.IndexOf(declaration, StringComparison.Ordinal);
        at.Should().BeGreaterThanOrEqualTo(0, $"`{declaration}` must exist");
        int depth = 0;
        bool started = false;
        for (int index = source.IndexOf('{', at); index < source.Length; index += 1)
        {
            if (source[index] == '{')
            {
                depth += 1;
                started = true;
            }
            else if (source[index] == '}')
            {
                depth -= 1;
                if (started && depth == 0)
                    return source[at..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced_body:{declaration}");
    }
}
