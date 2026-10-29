using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The milestone half of `respond_level_up`: what the companion is SHOWN, and what still refuses.
///
/// <para>
/// Two halves, because they need different instruments.
/// </para>
///
/// <para>
/// <b>Shown.</b> `DescribePendingLevelUpChoices`/`DescribeProfessions` are invoked for real on a synthetic `Farmer`
/// for every case their logic can decide WITHOUT the engine's content: the entries the projection must skip, and the
/// profession set's bound and order. The two ENGINE-TITLED shapes - a level-5 pair, and a level-10 pair continuing a
/// chosen level-5 branch - are source-pinned instead, because `LevelUpMenu.getProfessionTitleFromNumber` goes through
/// `Game1.content.LoadString` (`LevelUpMenu.cs:314-317`) and a headless test process has no loaded content. Pinning
/// the derivation is the honest half there: the VALUES it derives are covered for real by
/// <see cref="LevelUpProfessionPairTests"/>, and the projection is pinned to consume the same helper rather than a
/// second copy of the rule.
/// </para>
///
/// <para>
/// <b>Refuses.</b> The refusals are driven through the real handler with a real mounted `LevelUpMenu` and a real
/// bound actor, so a refusal is proven by the code that emits it rather than by its source text. The menu is an
/// uninitialized instance whose private pair is seeded through the same fields the handler reads
/// (`LevelUpMenu.cs:30/32`), which is exactly what the handler's own reflection does.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class LevelUpMilestoneChoiceTests
{
    private const string ScopePlayerId = "1001";

    // ------------------------------------------------------------------------------------------------
    // Shown: the projection's real shapes
    // ------------------------------------------------------------------------------------------------

    [Fact]
    public void TheProjectionSkipsWhatTheEngineNeverOffersAsAChoice()
    {
        // Luck (skill 5) never branches, and only levels 5 and 10 are milestones, so neither can appear as a
        // candidate pair. These three cases reach the projection's own filter and RETURN before any engine title is
        // read, which is what makes them exercisable here at all.
        Farmer actor = CreateActor(1001);
        SeedPendingLevelUps(actor, new Point(5, 5));
        DescribeChoices(actor).Should().BeEmpty("luck has no profession branches");

        SeedPendingLevelUps(actor, new Point(4, 6), new Point(0, 2));
        DescribeChoices(actor).Should().BeEmpty("an ordinary level is settled with `confirm`, never chosen between");

        SeedPendingLevelUps(actor);
        DescribeChoices(actor).Should().BeEmpty("nothing pending means nothing to show");
    }

    [Fact]
    public void TheProjectionDerivesBothCandidatesThroughTheEnginesOwnRule()
    {
        string body = StripLineComments(MethodBody(
            ReadStardewText("farmhandexecutioncontroller.cs"),
            "private static IReadOnlyList<BridgeLevelUpChoice> DescribePendingLevelUpChoices(Farmer player)"));

        // ONE derivation of the candidate pair, shared with the action that writes it. A second copy here is how the
        // companion would come to choose from one pair and the write land on another (LevelUpProfessionPairTests pins
        // the rule itself; this pins that both sides consume it).
        body.Should().Contain("if (skill == 5 || (level != 5 && level != 10))");
        body.Should().Contain("bool levelFiveBranchChosen = player.professions.Contains(skill * 6);");
        body.Should().Contain("(int left, int right) = LevelUpProfessionPair(skill, level, levelFiveBranchChosen);");

        // The candidates are the ENGINE's own cards, titles and descriptions - never a table of our own, which could
        // name a profession the game does not.
        body.Should().Contain("LevelUpMenu.getProfessionTitleFromNumber(left)");
        body.Should().Contain("LevelUpMenu.getProfessionDescription(left)");
        body.Should().Contain("LevelUpMenu.getProfessionTitleFromNumber(right)");
        body.Should().Contain("LevelUpMenu.getProfessionDescription(right)");
        body.Should().NotContain("getProfessionForSkill",
            "the pair is the engine's own rule, not `getProfessionForSkill`, which reads the ALREADY-chosen profession");
    }

    [Fact]
    public void TheLevel5ConstraintIsCarriedOnlyWhenItDecidesThePair()
    {
        string body = StripLineComments(MethodBody(
            ReadStardewText("farmhandexecutioncontroller.cs"),
            "private static IReadOnlyList<BridgeLevelUpChoice> DescribePendingLevelUpChoices(Farmer player)"));

        // A level-5 pair does not depend on an earlier choice, so the projection must leave the constraint unset
        // there. A level-10 pair does: `+2/+3` continues the left level-5 card, `+4/+5` continues the right one
        // (LevelUpMenu.cs:428-436), so the id that decided the pair is what the companion is shown.
        body.Should().Contain("if (level == 10)");
        body.Should().Contain("previousProfession = levelFiveBranchChosen");
        body.Should().Contain("? skill * 6");
        body.Should().Contain(": player.professions.Contains(skill * 6 + 1) ? skill * 6 + 1 : null;");
    }

    [Fact]
    public void TheProjectionsAreBounded()
    {
        string code = StripLineComments(ReadStardewText("farmhandexecutioncontroller.cs"));

        code.Should().Contain("choices.Count == 0 ? Array.Empty<BridgeLevelUpChoice>() : choices.Take(8).ToArray()");
        code.Should().Contain("ids.Count == 0 ? Array.Empty<int>() : ids.Take(16).ToArray()");
    }

    [Fact]
    public void TheProfessionSetIsPublishedSortedAndBounded()
    {
        // The bound alone would be a nondeterministic read: NetIntHashSet enumerates in its own hash order, so which
        // sixteen ids a caller saw would vary run to run. Sorting before the take is what makes the fact stable, and
        // this asserts that on the real output, not on the source.
        Farmer actor = CreateActor(1001);
        SeedProfessions(actor, 24, 7, 0, 19, 13, 1, 25, 6, 12, 2, 3, 4, 5, 8, 9, 10, 11, 14, 15, 16, 17);

        IReadOnlyList<int> published = DescribeProfessions(actor);

        published.Should().HaveCount(16, "the projection is bounded below the schema's own cap");
        published.Should().BeInAscendingOrder("a hash-ordered read is not a fact a caller can compare across runs");
        published.Should().Equal(Enumerable.Range(0, 16), "the lowest ids are the stable half of a bounded read");

        SeedProfessions(actor);
        DescribeProfessions(actor).Should().BeEmpty("a farmer with no professions publishes an empty set, not a gap");
    }

    [Fact]
    public void BothFactsArePublishedOnTheSnapshot_AndNeitherSurvivesAWorldThatIsNotReady()
    {
        string code = StripLineComments(ReadStardewText("farmhandexecutioncontroller.cs"));

        code.Should().Contain("PendingLevelUpChoices: DescribePendingLevelUpChoices(player),");
        code.Should().Contain("Professions: DescribeProfessions(player),");
        // The not-ready snapshot must not hand a caller a stale choice: it publishes the empty pair for both.
        code.Should().Contain("PendingLevelUps: null, PendingLevelUpChoices: null, Professions: null)");
    }

    // ------------------------------------------------------------------------------------------------
    // Refuses: the action's own named refusals, driven through the handler
    // ------------------------------------------------------------------------------------------------

    [Fact]
    public void Milestone_RefusesConfirm_BecauseTheChoiceIsTheCompanions()
    {
        RunWithMenu(CreateLevelUpMenu(skill: 4, level: 5, isProfessionChooser: true), () =>
        {
            ExecutionManager manager = CreateManager(CreateActor(1001, new Point(4, 5)));

            InvokeRespondLevelUp(manager, "req_milestone_confirm", 4, 5, "confirm")
                .ReasonCode.Should().Be("profession_choice_required",
                    "a milestone has no single legal value, so `confirm` would be the Mod choosing for the companion");
        });
    }

    [Fact]
    public void OrdinaryLevel_RefusesABranchChoice()
    {
        RunWithMenu(CreateLevelUpMenu(skill: 4, level: 6, isProfessionChooser: false), () =>
        {
            ExecutionManager manager = CreateManager(CreateActor(1001, new Point(4, 6)));

            InvokeRespondLevelUp(manager, "req_ordinary_branch", 4, 6, "branch_a")
                .ReasonCode.Should().Be("invalid_choice_for_ordinary_level",
                    "`confirm` is the only value an ordinary level has, and a branch would claim a profession it never offered");
        });
    }

    [Fact]
    public void TheNamedPairIsABinding_AResponseToAnotherPairRefuses()
    {
        // The menu is about the combat milestone; the request names an ordinary combat level. Without this the pair
        // would be decoration and a persistent, save-affecting write could land on a level-up the caller never meant.
        RunWithMenu(CreateLevelUpMenu(skill: 4, level: 5, isProfessionChooser: true), () =>
        {
            ExecutionManager manager = CreateManager(CreateActor(1001, new Point(4, 5)));

            InvokeRespondLevelUp(manager, "req_pair_binding", 4, 6, "branch_a")
                .ReasonCode.Should().Be("level_up_expected_pair_mismatch");
        });
    }

    [Fact]
    public void TheTwoPairReadings_MustAgree()
    {
        // Reading 1 is the menu's own private pair; reading 2 is `newLevels[0]`, the entry the engine pushed it from.
        // A disagreement means one of them is not this menu's level-up, and the action refuses rather than picking.
        RunWithMenu(CreateLevelUpMenu(skill: 4, level: 5, isProfessionChooser: true), () =>
        {
            ExecutionManager manager = CreateManager(CreateActor(1001, new Point(3, 5)));

            InvokeRespondLevelUp(manager, "req_readings_disagree", 4, 5, "branch_a")
                .ReasonCode.Should().Be("level_up_pair_readings_disagree");
        });
    }

    [Fact]
    public void ReadingTwo_IsAbsentWhenNothingIsPending()
    {
        RunWithMenu(CreateLevelUpMenu(skill: 4, level: 5, isProfessionChooser: true), () =>
        {
            ExecutionManager manager = CreateManager(CreateActor(1001));

            InvokeRespondLevelUp(manager, "req_nothing_pending", 4, 5, "branch_a")
                .ReasonCode.Should().Be("level_up_pair_readings_disagree",
                    "an empty `newLevels` cannot confirm the menu's pair, so the cross-check fails closed");
        });
    }

    [Fact]
    public void AMenuThatIsNotALevelUpMenu_IsRefusedByName()
    {
        RunWithMenu(new NonLevelUpMenuStub(), () =>
        {
            ExecutionManager manager = CreateManager(CreateActor(1001, new Point(4, 5)));

            InvokeRespondLevelUp(manager, "req_not_level_up", 4, 5, "branch_a")
                .ReasonCode.Should().Be("modal_not_level_up");
        });
    }

    // ------------------------------------------------------------------------------------------------
    // The three candidate shapes the card names, as the projection and the action must agree on them
    // ------------------------------------------------------------------------------------------------

    [Theory]
    [InlineData(4, 5, false, 24, 25, null)]
    [InlineData(4, 10, true, 26, 27, 24)]
    [InlineData(4, 10, false, 28, 29, 25)]
    public void TheShownPairIsThePairTheActionWrites(
        int skill,
        int level,
        bool levelFiveBranchChosen,
        int expectedLeft,
        int expectedRight,
        int? expectedConstraint)
    {
        // The projection and the write share this call, so naming it here is what makes "the companion chose what it
        // was shown" a fact rather than a coincidence. `expectedConstraint` is the id the card's `previous_profession`
        // must name for a level-10 pair (-1 meaning the pair does not depend on an earlier choice).
        (int left, int right) = global::GameBuddy.Stardew.ExecutionManager.LevelUpProfessionPair(
            skill,
            level,
            levelFiveBranchChosen);

        left.Should().Be(expectedLeft);
        right.Should().Be(expectedRight);

        int? constraint = level == 10 ? (levelFiveBranchChosen ? skill * 6 : skill * 6 + 1) : null;
        constraint.Should().Be(expectedConstraint);

        string body = StripLineComments(MethodBody(
            ReadStardewText("farmhandexecutioncontroller.modalactions.cs"),
            "public LocalExecutionReceipt RequestLocalRespondLevelUp("));
        body.Should().Contain("actor.professions.Contains(menuPair.Skill * 6)");
        body.Should().Contain("chosenProfession = choice == \"branch_a\" ? left : right;",
            "`branch_a` is the left card the projection published, and `branch_b` the right");
        body.Should().Contain("otherProfession = choice == \"branch_a\" ? right : left;");
    }

    // ------------------------------------------------------------------------------------------------

    private static IReadOnlyList<BridgeLevelUpChoice> DescribeChoices(Farmer actor) =>
        (IReadOnlyList<BridgeLevelUpChoice>)typeof(ExecutionManager)
            .GetMethod("DescribePendingLevelUpChoices", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object[] { actor })!;

    private static IReadOnlyList<int> DescribeProfessions(Farmer actor) =>
        (IReadOnlyList<int>)typeof(ExecutionManager)
            .GetMethod("DescribeProfessions", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object[] { actor })!;

    private static LocalExecutionReceipt InvokeRespondLevelUp(
        ExecutionManager manager,
        string requestId,
        int? expectedSkill,
        int? expectedLevel,
        string? choice)
    {
        var request = new BridgeExecutionRequest(
            requestId,
            $"{requestId}_idem",
            "respond_level_up",
            new BridgeExecutionArgs { ExpectedSkill = expectedSkill, ExpectedLevel = expectedLevel, Choice = choice },
            1,
            // A live deadline: the modal family validates it through the shared admission, so an epoch-zero one would
            // be refused with `invalid_deadline` before any level-up refusal could be reached.
            DateTimeOffset.UtcNow.AddSeconds(5).ToUnixTimeMilliseconds());
        return manager.RequestLocalRespondLevelUp(request, manager);
    }

    private static ExecutionManager CreateManager(Farmer? actor)
    {
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "respond_level_up" });
        var manager = new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
        if (actor is not null) manager.SetTestActorResolver(() => actor);
        return manager;
    }

    /// <summary>
    /// A `Farmer` with only the members the modal admission and this action read. The shape is the one the sibling
    /// modal probes already use: an uninitialized instance, because a real constructor loads a save.
    /// </summary>
    private static Farmer CreateActor(long id, params Point[] pendingLevelUps)
    {
        Farmer actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        SetFarmerField(actor, "uniqueMultiplayerID", new NetLong(id));
        actor.CanMove = true;
        SetFarmerField(actor, "usingTool", new NetBool(false));
        SetFarmerField(actor, "netStamina", new NetFloat(270f));
        SetFarmerField(actor, "toolPower", new NetInt(0));
        // Character.currentLocation dereferences currentLocationRef; a bare ref keeps the trace publisher from
        // NRE-ing headless.
        SetFarmerField(actor, "currentLocationRef", new NetLocationRef());
        SeedPendingLevelUps(actor, pendingLevelUps);
        SeedProfessions(actor);
        return actor;
    }

    /// <summary>
    /// `newLevels` and `professions` are `readonly` inline-initialized Netcode collections, so an uninitialized
    /// Farmer has them NULL. Entries go in through the engine's own public `Add`, so the collection type stays the
    /// game's rather than a stand-in that could accept what the game would not.
    /// </summary>
    private static void SeedPendingLevelUps(Farmer actor, params Point[] pending)
    {
        object levels = NewNetCollection(actor, "newLevels");
        MethodInfo add = levels.GetType().GetMethod("Add", new[] { typeof(Point) })!;
        foreach (Point point in pending) add.Invoke(levels, new object[] { point });
        SetFarmerField(actor, "newLevels", levels);
    }

    private static void SeedProfessions(Farmer actor, params int[] ids)
    {
        object professions = NewNetCollection(actor, "professions");
        MethodInfo add = professions.GetType().GetMethod("Add", new[] { typeof(int) })!;
        foreach (int id in ids) add.Invoke(professions, new object[] { id });
        SetFarmerField(actor, "professions", professions);
    }

    private static object NewNetCollection(Farmer actor, string fieldName) =>
        Activator.CreateInstance(FarmerField(fieldName).FieldType)!;

    private static FieldInfo FarmerField(string name) =>
        typeof(Farmer).GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!;

    private static void SetFarmerField(Farmer actor, string name, object value) =>
        FarmerField(name).SetValue(actor, value);

    /// <summary>
    /// The menu the action reads: its `(skill, level)` pair is PRIVATE (`LevelUpMenu.cs:30/32`), so it is seeded
    /// through those exact fields, which is what the handler's own reflection reads back.
    /// </summary>
    private static LevelUpMenu CreateLevelUpMenu(int skill, int level, bool isProfessionChooser)
    {
        var menu = (LevelUpMenu)FormatterServices.GetUninitializedObject(typeof(LevelUpMenu));
        typeof(LevelUpMenu)
            .GetField("currentSkill", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(menu, skill);
        typeof(LevelUpMenu)
            .GetField("currentLevel", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(menu, level);
        menu.isProfessionChooser = isProfessionChooser;
        return menu;
    }

    private static void RunWithMenu(IClickableMenu menu, Action action)
    {
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool dialogueUpBefore = Game1.dialogueUp;
        bool eventUpBefore = Game1.eventUp;
        try
        {
            menuField.SetValue(null, menu);
            Game1.dialogueUp = false;
            Game1.eventUp = false;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.dialogueUp = dialogueUpBefore;
            Game1.eventUp = eventUpBefore;
        }
    }

    private sealed class NonLevelUpMenuStub : IClickableMenu
    {
        public NonLevelUpMenuStub()
            : base(0, 0, 100, 100)
        {
        }
    }

    private static string ReadStardewText(string fileName) =>
        File.ReadAllText(RepositoryPath("integrations", "stardew", fileName));

    private static string RepositoryPath(params string[] parts)
    {
        string relative = Path.Combine(parts);
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }

    /// <summary>Drop <c>//</c>/<c>///</c> comments so the pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }
}
