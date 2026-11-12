using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Audio;
using StardewValley.Menus;
using StardewValley.Network;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE MODAL FAMILY'S TERMINALS, COMPARED FIELD BY FIELD ACROSS THE EXTRACTION.
///
/// <para>
/// The modal family's decisions (which menu this channel may close, and whether a request may be attempted while a
/// menu holds the body) left <c>ExecutionManager</c> for <see cref="ModalFamily"/>. A refactor owes proof rather than
/// assertion: every terminal the family can reach is driven through the REAL handler
/// (<see cref="ModalActionHandler"/>) here, and the receipt it publishes is compared FIELD BY FIELD against the
/// table below.
/// </para>
/// <para>
/// WHERE THE TABLE COMES FROM. It is not a re-reading of the new code: every row was captured by running this file
/// against the tree BEFORE the extraction, where the modal family was one partial of <c>ExecutionManager</c>. So
/// each side of the comparison is its own revision's output, and a row that only matched afterwards would be a
/// behaviour change rather than a refactor.
/// </para>
/// <para>
/// WHAT IS NOT COMPARED, and why. <c>ExecutionId</c> is a fresh <c>Guid</c> per dispatch
/// (<c>ExecutionReceiptStore.NewExecutionId</c>), so it has no cross-revision identity to compare; it is asserted
/// to be present instead. The observation is compared by PRESENCE, not content: its payload is a live scene
/// projection whose producer is not this family.
/// </para>
/// <para>
/// THE COMPARISON IS FALSIFIED ONCE, in <see cref="TheFieldComparisonDetectsASingleFieldChange"/>, because a
/// comparator that cannot fail agrees with itself. The arms that CANNOT be driven headless are named with the reason
/// in <see cref="TheArmsThatCannotBeDrivenHeadless_AreNamed"/>, so an arm that quietly stopped being driven fails
/// instead of shrinking the population.
/// </para>
/// </summary>
public sealed class ModalFamilyReceiptEquivalenceTests
{
    private const long ScopePlayerId = 1001;

    /// <summary>
    /// One terminal of the modal family, as the caller reads it. A named record rather than a tuple so the
    /// comparison below can name the field that differs.
    /// </summary>
    private sealed record Published(
        string State,
        string ReasonCode,
        string Evidence,
        string Hint,
        string ActionId,
        long Revision,
        bool CarriesObservation)
    {
        internal static Published Of(LocalExecutionReceipt receipt) => new(
            receipt.State.ToString(),
            receipt.ReasonCode,
            receipt.Evidence ?? "<null>",
            receipt.Hint ?? "<null>",
            receipt.ActionId ?? "<null>",
            receipt.Revision,
            receipt.Observation is not null);
    }

    /// <summary>
    /// The terminals that cannot be produced in a probe process, each with the engine fact that blocks it. The
    /// population is printed and asserted, so an arm that starts or stops being driven is a visible change rather
    /// than a shrinking table.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> NotDrivenHeadless = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["dismiss/plain_dialogue_closed"] =
            "DialogueBox.closeDialogue restores Game1.player.CanMove (DialogueBox.cs:226) and this probe process has no live player",
        ["levelup/unreadable_pair"] =
            "LevelUpMenu.currentSkill/currentLevel are non-nullable ints on an uninitialized menu, so there is no headless shape where GetField returns null",
        ["levelup/profession_branch_written"] =
            "the branch write reads Farmer.professions (a NetIntHashSet) and calls LevelUpMenu.getImmediateProfessionPerk, which settles through the live player",
        ["answer/question_answered"] =
            "chooseResponse / GameLocation.answerDialogue settle on a live speaker or location; the failing shape (no location) is driven instead",
    };

    private readonly ITestOutputHelper output;

    public ModalFamilyReceiptEquivalenceTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// ONE ROW PER TERMINAL, EACH THE PRE-EXTRACTION READING. The keys are the arm names the driver below produces;
    /// the values are the five fields the modal family decides plus the two the request prologue and the terminal
    /// seam own (revision, observation presence).
    /// </summary>
    private static readonly IReadOnlyDictionary<string, Published> Before = new Dictionary<string, Published>(StringComparer.Ordinal)
    {
        ["dismiss/no_modal"] = new Published("Succeeded", "nothing_to_dismiss", "modal=none", "<null>", "<null>", 1, false),
        ["dismiss/question_with_keys"] = new Published("Rejected", "modal_not_dismissible", "modal_type=DialogueBox;question=true;answer_it=answer_dialogue;response_keys=Yes,No", "offered_keys=Yes,No", "<null>", 1, false),
        ["dismiss/question_without_keys"] = new Published("Rejected", "modal_not_dismissible", "modal_type=DialogueBox;question=true;answer_it=answer_dialogue;response_keys=", "offered_keys=none", "<null>", 1, false),
        ["dismiss/shop"] = new Published("Rejected", "modal_not_dismissible", "modal_type=ShopMenu;menu_is_a_shop=true;shop_purchase_opens_its_own=true", "menu_is_a_shop:shop_purchase_opens_its_own", "<null>", 1, false),
        ["dismiss/unaudited_menu"] = new Published("Rejected", "modal_not_dismissible", "modal_type=GameMenuStub;dismissible=false", "<null>", "<null>", 1, false),
        ["dismiss/unaudited_level_up"] = new Published("Rejected", "modal_not_dismissible", "modal_type=LevelUpMenu;dismissible=false;pending_level_ups=1;level_up=0@1", "<null>", "<null>", 1, false),
        ["dismiss/shipping_commit"] = new Published("Uncertain", "dismiss_modal_native_exception", "modal_type=ShippingMenu;native_dispatched=false;native_exception=TargetInvocationException", "<null>", "<null>", 1, false),
        ["dismiss/shipping_commit_in_progress"] = new Published("Succeeded", "settlement_commit_in_progress", "modal_type=ShippingMenu;dismissed=false;cleared_modal=ShippingMenu;clearing=true;close_effect=engine_shipping_commit;commit_already_driven=true", "<null>", "<null>", 2, false),
        ["dismiss/no_bound_actor"] = new Published("Rejected", "world_not_ready", "<null>", "<null>", "<null>", 1, false),
        ["answer/no_modal"] = new Published("Rejected", "no_modal_present", "menu=none", "<null>", "<null>", 1, false),
        ["answer/not_a_question"] = new Published("Rejected", "modal_not_answerable", "modal_type=DialogueBox;question=false", "<null>", "<null>", 1, false),
        ["answer/blank_key"] = new Published("Rejected", "invalid_response_key", "key_length=0;blank=true;max_length=128", "<null>", "<null>", 1, false),
        ["answer/key_not_offered"] = new Published("Rejected", "response_key_not_offered", "modal_type=DialogueBox;question=true;response_key=是;offered_keys=Yes,No", "offered_keys=Yes,No", "<null>", 1, false),
        ["answer/sleep_prompt"] = new Published("Rejected", "native_sleep_prompt_owned_by_advance_day", "modal_type=DialogueBox;question=true;response_key=Yes;question_key=Sleep;owning_action=sleep", "Answering Yes here ends the day. Dispatch `sleep` instead - it crosses the night with a receipt.", "<null>", 1, false),
        ["answer/actor_not_actionable"] = new Published("Rejected", "player_not_actionable", "actor=bound;location=none", "<null>", "<null>", 1, false),
        ["levelup/no_level_up_menu"] = new Published("Rejected", "modal_not_level_up", "modal_type=none", "<null>", "<null>", 1, false),
        ["levelup/expected_pair_missing"] = new Published("Rejected", "level_up_expected_pair_mismatch", "expected_pair=missing", "<null>", "<null>", 1, false),
        ["levelup/readings_disagree"] = new Published("Rejected", "level_up_pair_readings_disagree", "menu_pair=0@1;new_levels_head=none", "<null>", "<null>", 1, false),
        ["levelup/expected_pair_mismatch"] = new Published("Rejected", "level_up_expected_pair_mismatch", "menu_pair=0@1;expected_pair=7@9", "<null>", "<null>", 1, false),
        ["levelup/profession_choice_required"] = new Published("Rejected", "profession_choice_required", "skill=0;level=1", "<null>", "<null>", 1, false),
        ["levelup/invalid_choice"] = new Published("Rejected", "invalid_choice_for_ordinary_level", "skill=0;level=1;choice=branch_a", "<null>", "<null>", 1, false),
    };

    [Fact]
    public void EveryModalTerminal_PublishesTheReceiptThePreExtractionTreePublished()
    {
        (string Name, string Action, Func<LocalExecutionReceipt> Drive)[] arms = Arms();
        arms.Select(arm => arm.Name).Should().OnlyHaveUniqueItems("two arms with one name would compare one row twice");
        arms.Select(arm => arm.Action).Distinct(StringComparer.Ordinal).Should().BeEquivalentTo(
            FarmhandActionCatalog.ModalResolvingActionIds,
            "every member of the family the catalog declares needs a driven terminal, or this table covers a family smaller than the product ships");

        var actual = new Dictionary<string, Published>(StringComparer.Ordinal);
        foreach ((string name, _, Func<LocalExecutionReceipt> drive) in arms)
        {
            LocalExecutionReceipt receipt = drive();
            receipt.ExecutionId.Should().NotBeNullOrEmpty($"the terminal of {name} owes the caller an execution identity");
            actual[name] = Published.Of(receipt);
        }

        foreach ((string name, Published published) in actual)
        {
            this.output.WriteLine(
                $"[\"{name}\"] = new Published(\"{published.State}\", \"{published.ReasonCode}\", \"{published.Evidence}\", \"{published.Hint}\", \"{published.ActionId}\", {published.Revision}, {published.CarriesObservation.ToString().ToLowerInvariant()}),");
        }

        this.output.WriteLine($"examined {actual.Count} of {arms.Length} arms; table holds {Before.Count}");
        actual.Keys.Should().BeEquivalentTo(Before.Keys,
            "an arm with no recorded reading is a path this file does not cover, and a reading with no arm is a row nobody drives");

        var differences = new List<string>();
        foreach ((string name, Published expected) in Before)
            differences.AddRange(Compare(name, expected, actual[name]));
        differences.Should().BeEmpty(
            "the extraction is a refactor: " + string.Join(" | ", differences));
    }

    /// <summary>
    /// The comparator, and nothing else. Every field is compared by name so a failure says which one moved.
    /// </summary>
    private static IEnumerable<string> Compare(string arm, Published expected, Published actual)
    {
        if (!string.Equals(expected.State, actual.State, StringComparison.Ordinal))
            yield return $"{arm}:state expected={expected.State} actual={actual.State}";
        if (!string.Equals(expected.ReasonCode, actual.ReasonCode, StringComparison.Ordinal))
            yield return $"{arm}:reasonCode expected={expected.ReasonCode} actual={actual.ReasonCode}";
        if (!string.Equals(expected.Evidence, actual.Evidence, StringComparison.Ordinal))
            yield return $"{arm}:evidence expected={expected.Evidence} actual={actual.Evidence}";
        if (!string.Equals(expected.Hint, actual.Hint, StringComparison.Ordinal))
            yield return $"{arm}:hint expected={expected.Hint} actual={actual.Hint}";
        if (!string.Equals(expected.ActionId, actual.ActionId, StringComparison.Ordinal))
            yield return $"{arm}:actionId expected={expected.ActionId} actual={actual.ActionId}";
        if (expected.Revision != actual.Revision)
            yield return $"{arm}:revision expected={expected.Revision} actual={actual.Revision}";
        if (expected.CarriesObservation != actual.CarriesObservation)
            yield return $"{arm}:observation expected={expected.CarriesObservation} actual={actual.CarriesObservation}";
    }

    /// <summary>
    /// The comparison falsified once: a single changed field must be found, and an identical row must not be.
    /// Without this, a comparator that returns no differences for any pair would pass the table above while
    /// proving nothing.
    /// </summary>
    [Fact]
    public void TheFieldComparisonDetectsASingleFieldChange()
    {
        Published expected = Before.Values.First();
        Compare("arm", expected, expected).Should().BeEmpty("an unchanged row is not a difference");

        (string Field, Published Drift)[] drifts =
        {
            ("state", expected with { State = "Failed" }),
            ("reasonCode", expected with { ReasonCode = "modal_not_dismissible" }),
            ("evidence", expected with { Evidence = expected.Evidence + ";" }),
            ("hint", expected with { Hint = expected.Hint + ";" }),
            ("actionId", expected with { ActionId = "dismiss_modal" }),
            ("revision", expected with { Revision = expected.Revision + 1 }),
            ("observation", expected with { CarriesObservation = !expected.CarriesObservation }),
        };

        var reported = new List<string>();
        foreach ((string field, Published drift) in drifts)
        {
            string[] differences = Compare("arm", expected, drift).ToArray();
            differences.Should().HaveCount(1, $"a change to {field} is one difference, and it must be reported");
            differences[0].Should().StartWith($"arm:{field} ", $"the report names the field that moved ({field})");
            reported.Add(field);
        }

        reported.Should().BeEquivalentTo(
            new[] { "state", "reasonCode", "evidence", "hint", "actionId", "revision", "observation" },
            "every compared field is exercised by the falsifier, so no field is compared by a branch nothing runs");
    }

    /// <summary>
    /// GATE, not a test: every arm of the closed verdict, and every close path it can name, is reached by a mount the
    /// family actually meets. The population comes from the declarations themselves (<see cref="ModalFamily.Dismissal"/>'s
    /// nested types and <see cref="ModalFamily.ClosePath"/>'s members), so a new arm or a new close path joins this gate
    /// in the change that introduces it instead of leaving an arm nothing exercises.
    /// </summary>
    [Fact]
    public void EveryDeclaredVerdictArmAndClosePath_IsReachedByADrivenMount()
    {
        Farmer actor = CreateActor(ScopePlayerId);
        (string Mount, Func<IClickableMenu> Create)[] mounts =
        {
            ("plain_dialogue", static () => CreateDialogue(isQuestion: false)),
            ("question_dialogue", static () => Question("Yes", "No")),
            ("shop", static () => CreateShop()),
            ("unaudited_menu", static () => new GameMenuStub()),
            ("level_up", static () => CreateLevelUp(skill: 0, level: 1)),
            ("shipping", static () => CreateShipping()),
            ("audited_operation_menu", static () => CreateAuditedMenu()),
        };

        var reached = new List<(string Mount, Type Arm, ModalFamily.ClosePath? Path)>();
        foreach ((string mount, Func<IClickableMenu> create) in mounts)
        {
            ModalFamily.Dismissal verdict = ModalFamily.DecideDismissal(create(), actor);
            reached.Add((mount, verdict.GetType(), verdict is ModalFamily.Dismissal.Closeable close ? close.Path : null));
        }

        foreach ((string mount, Type arm, ModalFamily.ClosePath? path) in reached)
            this.output.WriteLine($"{mount}: {arm.Name};close_path={(path is null ? "none" : path.ToString())}");
        this.output.WriteLine($"examined {reached.Count} of {mounts.Length} mounts; arms={reached.Select(row => row.Arm.Name).Distinct().Count()}");

        reached.Select(row => row.Arm).Distinct().Should().BeEquivalentTo(
            typeof(ModalFamily.Dismissal).GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic),
            "an arm of the closed verdict that no mount reaches is a decision nothing decides");
        reached.Where(row => row.Path is not null).Select(row => row.Path!.Value).Distinct().Should().BeEquivalentTo(
            Enum.GetValues<ModalFamily.ClosePath>(),
            "a close path no mount reaches is a native close no test covers");
        reached.Should().Contain(row => row.Path == null, "at least one mount must be refused, or the refusal arm is untested");
    }
    /// <summary>
    /// The arms this file cannot drive, named with the engine fact that blocks each one. Asserted rather than
    /// listed in prose: an entry that disappears (because someone made it drivable, or because its arm was deleted)
    /// fails here instead of silently shrinking what the table above proves.
    /// </summary>
    [Fact]
    public void TheArmsThatCannotBeDrivenHeadless_AreNamed()
    {
        this.output.WriteLine($"{NotDrivenHeadless.Count} arm(s) not driven headless");
        foreach ((string arm, string blockedBy) in NotDrivenHeadless)
            this.output.WriteLine($"{arm}: {blockedBy}");

        NotDrivenHeadless.Should().HaveCount(4, "the blocked population is a reading of the tree, not a dumping ground");
        NotDrivenHeadless.Keys.Should().NotIntersectWith(Before.Keys, "an arm cannot be both driven and blocked");
        foreach ((string arm, string blockedBy) in NotDrivenHeadless)
            blockedBy.Should().NotBeNullOrWhiteSpace($"the blocked arm {arm} must name the fact that blocks it");
    }

    // ---- the arms ------------------------------------------------------------

    /// <summary>
    /// One driver per terminal: the mount the handler meets, and the request it is dispatched with. The action ids
    /// are the catalog's own, so a renamed action fails in the handler rather than here.
    /// </summary>
    private static (string Name, string Action, Func<LocalExecutionReceipt> Drive)[] Arms() => new (string, string, Func<LocalExecutionReceipt>)[]
    {
        ("dismiss/no_modal", "dismiss_modal", () => InWorld(null, null, dialogueUp: false, seedLocation: false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_dismiss_none", "dismiss_modal"))),

        ("dismiss/question_with_keys", "dismiss_modal", () => InWorld(Question("Yes", "No"), null, false, false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_dismiss_question_keys", "dismiss_modal"))),

        ("dismiss/question_without_keys", "dismiss_modal", () => InWorld(CreateDialogue(isQuestion: true), null, false, false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_dismiss_question_no_keys", "dismiss_modal"))),

        ("dismiss/shop", "dismiss_modal", () => InWorld(null, CreateShop(), false, false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_dismiss_shop", "dismiss_modal"))),

        ("dismiss/unaudited_menu", "dismiss_modal", () => InWorld(null, new GameMenuStub(), dialogueUp: true, false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_dismiss_unaudited", "dismiss_modal"))),

        ("dismiss/shipping_commit", "dismiss_modal", () => InWorld(null, CreateShipping(), false, seedLocation: true, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_shipping_first", "dismiss_modal"))),

        ("dismiss/shipping_commit_in_progress", "dismiss_modal", () => InWorld(null, CreateShipping(), false, seedLocation: true, () =>
        {
            ExecutionManager manager = CreateManager(ScopePlayerId);
            Invoke(manager, "arm_shipping_first_repeat", "dismiss_modal");
            return Invoke(manager, "arm_shipping_second", "dismiss_modal");
        })),

        ("dismiss/no_bound_actor", "dismiss_modal", () => InWorld(CreateDialogue(isQuestion: false), null, false, false, () =>
        {
            ExecutionManager manager = CreateManager(actorId: null);
            manager.SetTestActorResolver(() => null);
            return Invoke(manager, "arm_dismiss_no_actor", "dismiss_modal");
        })),

        ("answer/no_modal", "answer_dialogue", () => InWorld(null, null, false, false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_answer_no_modal", "answer_dialogue", new BridgeExecutionArgs { ResponseKey = "Yes" }))),

        ("answer/not_a_question", "answer_dialogue", () => InWorld(CreateDialogue(isQuestion: false), null, false, false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_answer_not_question", "answer_dialogue", new BridgeExecutionArgs { ResponseKey = "Yes" }))),

        ("answer/blank_key", "answer_dialogue", () => InWorld(Question("Yes", "No"), null, false, false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_answer_blank_key", "answer_dialogue", new BridgeExecutionArgs()))),

        ("answer/key_not_offered", "answer_dialogue", () => InWorld(Question("Yes", "No"), null, false, false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_answer_key_not_offered", "answer_dialogue", new BridgeExecutionArgs { ResponseKey = "是" }))),

        ("answer/sleep_prompt", "answer_dialogue", () => InWorld(Question("Yes", "No"), null, false, false, () =>
        {
            NativeSleepPrompt.QuestionKeyProvider = static () => NativeSleepPrompt.QuestionKey;
            try
            {
                return Invoke(CreateManager(ScopePlayerId), "arm_answer_sleep_prompt", "answer_dialogue", new BridgeExecutionArgs { ResponseKey = "Yes" });
            }
            finally
            {
                NativeSleepPrompt.QuestionKeyProvider = null;
            }
        })),

        ("answer/actor_not_actionable", "answer_dialogue", () => InWorld(Question("Yes", "No"), null, false, seedLocation: false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_answer_no_location", "answer_dialogue", new BridgeExecutionArgs { ResponseKey = "Yes" }))),

        ("levelup/no_level_up_menu", "respond_level_up", () => InWorld(null, null, false, false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_levelup_none", "respond_level_up", new BridgeExecutionArgs { Choice = "confirm", ExpectedSkill = 0, ExpectedLevel = 1 }))),

        ("levelup/expected_pair_missing", "respond_level_up", () => InWorld(null, CreateLevelUp(skill: 0, level: 1), false, false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_levelup_no_pair", "respond_level_up", new BridgeExecutionArgs { Choice = "confirm" }))),

        ("levelup/readings_disagree", "respond_level_up", () => InWorld(null, CreateLevelUp(skill: 0, level: 1), false, false, () =>
            Invoke(CreateManager(ScopePlayerId), "arm_levelup_disagree", "respond_level_up", new BridgeExecutionArgs { Choice = "confirm", ExpectedSkill = 0, ExpectedLevel = 1 }))),

        ("levelup/expected_pair_mismatch", "respond_level_up", () => InWorld(null, CreateLevelUp(skill: 0, level: 1), false, false, () =>
            Invoke(PendingLevels(0, 1), "arm_levelup_mismatch", "respond_level_up", new BridgeExecutionArgs { Choice = "confirm", ExpectedSkill = 7, ExpectedLevel = 9 }))),

        ("dismiss/unaudited_level_up", "dismiss_modal", () => InWorld(null, CreateLevelUp(skill: 0, level: 1), false, false, () =>
        {
            ExecutionManager manager = CreateManager(ScopePlayerId);
            manager.SetTestActorResolver(() =>
            {
                Farmer actor = CreateActor(ScopePlayerId);
                actor.newLevels.Add(new Point(0, 1));
                return actor;
            });
            return Invoke(manager, "arm_dismiss_level_up", "dismiss_modal");
        })),

        ("levelup/profession_choice_required", "respond_level_up", () => InWorld(null, CreateLevelUp(skill: 0, level: 1, professionChooser: true), false, false, () =>
            Invoke(PendingLevels(0, 1), "arm_levelup_profession", "respond_level_up", new BridgeExecutionArgs { Choice = "confirm", ExpectedSkill = 0, ExpectedLevel = 1 }))),

        ("levelup/invalid_choice", "respond_level_up", () => InWorld(null, CreateLevelUp(skill: 0, level: 1), false, false, () =>
            Invoke(PendingLevels(0, 1), "arm_levelup_invalid_choice", "respond_level_up", new BridgeExecutionArgs { Choice = "branch_a", ExpectedSkill = 0, ExpectedLevel = 1 }))),
    };

    // ---- driving one request through the real handler -------------------------

    /// <summary>
    /// One dispatch through <see cref="ModalActionHandler"/>, so every arm reaches the same switch a routed
    /// request reaches instead of a second copy of the action-to-handler mapping.
    /// </summary>
    private static LocalExecutionReceipt Invoke(
        ExecutionManager manager,
        string requestId,
        string actionId,
        BridgeExecutionArgs? args = null)
    {
        var request = new BridgeExecutionRequest(
            requestId,
            $"{requestId}_idem",
            actionId,
            args ?? new BridgeExecutionArgs(),
            1,
            // A LIVE deadline: the family validates it through the shared admission, and an expired one is
            // refused with `invalid_deadline` instead of being executed.
            DateTimeOffset.UtcNow.AddSeconds(5).ToUnixTimeMilliseconds());
        return new ModalActionHandler(manager).Execute(request, manager);
    }

    private static ExecutionManager CreateManager(long? actorId)
    {
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(FarmhandActionCatalog.ModalResolvingActionIds, StringComparer.Ordinal));
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionScope: null);

        if (actorId is not null)
            executions.SetTestActorResolver(() => CreateActor(actorId.Value));
        return executions;
    }

    /// <summary>A manager whose bound actor has the named pending level-ups, for the pair cross-check.</summary>
    private static ExecutionManager PendingLevels(int skill, int level)
    {
        ExecutionManager manager = CreateManager(ScopePlayerId);
        manager.SetTestActorResolver(() =>
        {
            Farmer actor = CreateActor(ScopePlayerId);
            actor.newLevels.Add(new Point(skill, level));
            return actor;
        });
        return manager;
    }

    private static Farmer CreateActor(long id)
    {
        Farmer actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        typeof(Farmer)
            .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLong(id));
        actor.CanMove = true;
        typeof(Farmer)
            .GetField("usingTool", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetBool(false));
        typeof(Farmer)
            .GetField("netStamina", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetFloat(270f));
        typeof(Farmer)
            .GetField("toolPower", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetInt(0));
        // The fields an uninitialized Farmer does not get: the level-up pair reads `newLevels`, and the scene
        // projection reads `currentLocationRef` (a bare ref keeps the trace publisher from NRE-ing headless).
        typeof(Farmer)
            .GetField("newLevels", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetList<Point, NetPoint>());
        typeof(Farmer)
            .GetField("currentLocationRef", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLocationRef());
        ProbeFarmerSprite.Attach(actor);
        return actor;
    }

    // ---- the worlds an arm mounts --------------------------------------------

    /// <summary>
    /// A FormatterServices dialogue: only `isQuestion` and `responses` matter to the family, and the close path's
    /// only game read is `Game1.activeClickableMenu.Equals(this)` (true for the seeded identity).
    /// </summary>
    private static DialogueBox CreateDialogue(bool isQuestion)
    {
        DialogueBox dialogue = (DialogueBox)FormatterServices.GetUninitializedObject(typeof(DialogueBox));
        dialogue.isQuestion = isQuestion;
        return dialogue;
    }

    private static DialogueBox Question(params string[] keys)
    {
        DialogueBox dialogue = CreateDialogue(isQuestion: true);
        dialogue.responses = keys.Select(key => new Response(key, key)).ToArray();
        return dialogue;
    }

    /// <summary>
    /// A FormatterServices shop counter. The one member the refusal path reads on the menu itself is
    /// `readyToClose`, which reads `heldItem` (null here) and `animations` (the empty list seeded).
    /// </summary>
    private static ShopMenu CreateShop()
    {
        ShopMenu shop = (ShopMenu)FormatterServices.GetUninitializedObject(typeof(ShopMenu));
        typeof(ShopMenu)
            .GetField("animations", BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(shop, new TemporaryAnimatedSpriteList());
        return shop;
    }

    /// <summary>
    /// An audited operation menu with nothing to read: `MineElevatorMenu` overrides neither the close path nor
    /// `readyToClose` (IClickableMenu.cs:899-902 returns true), so it is the pure-cancel shape without a live menu graph.
    /// </summary>
    private static IClickableMenu CreateAuditedMenu() =>
        (MineElevatorMenu)FormatterServices.GetUninitializedObject(typeof(MineElevatorMenu));
    /// <summary>
    /// A FormatterServices shipping menu with the pair the engine's own commit writes (`outro`, `outroFadeTimer`)
    /// and the precondition (`readyToClose`) left at their defaults, which is the shape the commit path reads.
    /// </summary>
    private static ShippingMenu CreateShipping() =>
        (ShippingMenu)FormatterServices.GetUninitializedObject(typeof(ShippingMenu));

    /// <summary>
    /// A FormatterServices level-up menu with its private `(skill, level)` pair set: the pair is what the action
    /// cross-checks against the actor's own `newLevels`, so both readings have to be seeded to be read at all.
    /// </summary>
    private static LevelUpMenu CreateLevelUp(int skill, int level, bool professionChooser = false)
    {
        LevelUpMenu menu = (LevelUpMenu)FormatterServices.GetUninitializedObject(typeof(LevelUpMenu));
        typeof(LevelUpMenu)
            .GetField("currentSkill", BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(menu, skill);
        typeof(LevelUpMenu)
            .GetField("currentLevel", BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(menu, level);
        menu.isProfessionChooser = professionChooser;
        menu.isActive = true;
        return menu;
    }

    /// <summary>
    /// Run one arm inside a world whose Game1 statics are seeded and restored. The queue and the silent sound
    /// device are what let a native close run in a probe process at all: `exitActiveMenu` drains
    /// `nextClickableMenu`, and the shipping commit changes the music track through `Game1.currentLocation`.
    /// </summary>
    private static T InWorld<T>(DialogueBox? dialogue, IClickableMenu? menu, bool dialogueUp, bool seedLocation, Func<T> body)
    {
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool dialogueUpBefore = Game1.dialogueUp;
        List<IClickableMenu>? nextMenusBefore = Game1.nextClickableMenu;
        Game1? gameBefore = Game1.game1;
        GameLocation? locationBefore = gameBefore?.instanceGameLocation;
        ISoundsHelper? soundsBefore = Game1.sounds;
        Queue<string>? objectDialogueBefore = Game1.currentObjectDialogue;
        List<Response>? questionChoicesBefore = Game1.questionChoices;
        Game1.afterFadeFunction? afterDialoguesBefore = Game1.afterDialogues;
        try
        {
            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            Game1.nextClickableMenu = new List<IClickableMenu>();
            if (seedLocation)
                Game1.game1.instanceGameLocation ??= new GameLocation();
            Game1.sounds = new SilentSoundsHelper();
            menuField.SetValue(null, (object?)dialogue ?? menu);
            Game1.dialogueUp = dialogueUp;
            return body();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.dialogueUp = dialogueUpBefore;
            Game1.nextClickableMenu = nextMenusBefore!;
            Game1.currentObjectDialogue = objectDialogueBefore!;
            Game1.questionChoices = questionChoicesBefore!;
            Game1.afterDialogues = afterDialoguesBefore;
            Game1.sounds = soundsBefore!;
            if (gameBefore is null)
                Game1.game1 = null!;
            else
            {
                Game1.game1 = gameBefore;
                gameBefore.instanceGameLocation = locationBefore!;
            }
        }
    }

    /// <summary>A sound device that plays nothing, so a native path that plays a cue can run in a probe process.</summary>
    private sealed class SilentSoundsHelper : SoundsHelper
    {
        public override bool PlayLocal(string cueName, GameLocation location, Vector2? position, int? pitch, SoundContext context, out ICue cue)
        {
            cue = null!;
            return false;
        }
    }

    private sealed class GameMenuStub : IClickableMenu
    {
        public GameMenuStub()
            : base(0, 0, 100, 100)
        {
        }
    }
}
