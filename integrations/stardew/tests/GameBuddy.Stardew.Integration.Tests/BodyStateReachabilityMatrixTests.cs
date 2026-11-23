using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Menus;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

// source-invariant: no compiler can require the reason vocabulary a private eligibility method assigns to be the table this
//   matrix walks - the assignments are string literals and the table is a field, so only a reading of both holds them equal.
// source-expiry: when the eligibility gate's reasons become a type (an enum or a result the wait switches on), which the
//   compiler would then check and this reading would be a second copy of.

/// <summary>
/// THE MOD'S EXECUTION STATE MACHINES AS ONE REACHABILITY MATRIX: every state in which the body cannot act either
/// leaves on a declared bound, or names the holder that ends it - and no state's first exit is the ten-minute stale
/// sweep.
///
/// <para>
/// WHY THIS EXISTS. `round93` (2026-11-22) produced four hangs of one shape: a holder that cannot act, is not told to
/// stop, and whose only exit is a stale sweep. (a) <c>sleep()</c> from Town waited on <c>not_home</c> for 308 s; (b) a
/// <c>navigate_to_destination</c> re-entry left <c>open_status=RecoveryRequired</c> for 627-829 s until
/// <c>journal_open_stale_dispatch</c>; (c) a hanging node refused <c>dismiss_modal</c> while she was about to pass out;
/// (d) two navigations submitted at once. The repository already had the answer for the frontend half
/// (<c>tools/check-fail-closed-forward-path.mjs</c>: every session phase offers a forward action). The Mod's own state
/// machines never got it, so each round fixed one instance and the class stayed alive.
/// </para>
///
/// <para>
/// THE POPULATION IS THE PRODUCT'S DECLARATIONS, not a list here: <see
/// cref="SleepAndAdvanceDayLifecycle.EligibilityReasons"/> (every way the night can refuse to begin, each with who
/// clears it), the two program states the journal can hold the body or the write path in
/// (<see cref="BodyProgramState.Active"/>, <see cref="BodyProgramState.RecoveryRequired"/>), and every mounted
/// <see cref="BodyProgramModalKind"/>. A reason, a kind or a state added to those declarations joins this matrix without
/// an edit here; one that loses its exit fails by name. <c>S = 0</c> is blocked rather than green.
/// </para>
///
/// <para>
/// THE THREE PROPERTIES, each DRIVEN through the product's own decision rather than restated:
/// </para>
/// <list type="number">
/// <item><b>No unbounded hold.</b> A reason nobody can clear must leave the night within
/// <see cref="MicroStepBound"/> step (<see cref="SleepAndAdvanceDayLifecycle.DecideEligibilityWait"/>), not inside a
/// frame budget. A frame budget is legitimate only for a reason a declared step clears.</item>
/// <item><b>Every hold reaches a clean terminal, and never through the stale sweep.</b> A program in
/// <see cref="BodyProgramState.Active"/> and one in <see cref="BodyProgramState.RecoveryRequired"/> are both driven to a
/// terminal by <c>program_stop</c> - the request seam the bridge calls - with the clock FROZEN, so a reading that only
/// passes through <c>RecoveryAbandonAgeMs</c> cannot pass at all.</item>
/// <item><b>A non-irreversible terminal is escapable.</b> For every mounted modal kind the dispatch gate must release a
/// published action and must NAME it; and a menu the night declares is answered by an action
/// (<see cref="SleepAndAdvanceDayLifecycle.OvernightMenus"/>) must be a kind whose hold names that action; and a
/// `DialogueBox` nobody owns that asks nothing - the shape `round95` measured - must be released, closed by the modal
/// family's own decision, and closed with a receipt that names the modal AND its owner.</item>
/// </list>
///
/// <para>
/// WHAT IT DOES NOT ASSERT, stated so a green run is not read as more than it is. (i) The warp interleaving: a native
/// warp's replan window is bounded by <c>NavigationWarpReplanGraceTicks</c> and pinned by
/// <c>ActiveBodySlots.DeferWarpReplan</c>'s own test, which needs the body controller; this matrix reads the journal,
/// the night and the screen. (ii) That the Host schedules the actions this gate releases: `round93`'s (c) was a
/// <c>plan_action_not_composable_ahead</c> refusal from the Host's plan lookahead, and (d)'s double navigation is one
/// body owned by one program node, which <c>ProgramHoldingTheBodyGateTests</c> drives. (iii) That a dismissal reaches
/// the native menu: the handler's own refusal (the shop counter, a question box) is `ModalFamily`'s and is unchanged
/// here.
/// </para>
///
/// <para>
/// RED ON HEAD, one falsifier per property, each running THIS reading over the shape the pre-fix tree had and naming
/// the round93 case in the failure: <c>sleep_not_home_exceeded_its_bound:frames=36000</c>,
/// <c>body_program_recovery_required_has_no_request_exit:first_exit=journal_open_stale_dispatch:age_ms=610000</c>,
/// <c>modal_kind_names_no_step:LevelUpMenu:kind=Menu;declared_answer=respond_level_up</c>. The escape's OWN receipt has
/// its falsifier in <c>ThePreFixReceiptCannotSayWhoseModalTheEscapeClosed</c>, over the `round95` vocabulary.
/// </para>
public sealed class BodyStateReachabilityMatrixTests
{
    private const string Gate = "every_body_state_has_a_bounded_forward_path";

    /// <summary>
    /// How many in-memory steps a state that cannot act may take to leave. One: a reason nobody can clear is answered
    /// in the frame it is read, not after a page of the wait. 18 000 frames is 308 s, which is what `round93` spent.
    /// </summary>
    private const int MicroStepBound = 1;

    private readonly ITestOutputHelper output;

    public BodyStateReachabilityMatrixTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryBodyStateHasABoundedForwardPathToATerminal()
    {
        Matrix matrix = Build();

        this.output.WriteLine(matrix.Line);
        this.output.WriteLine(matrix.Declarations);
        foreach (string row in matrix.Rows) this.output.WriteLine(row);

        matrix.States.Should().BeGreaterThan(
            0, $"{Gate}: examined no state at all, so this matrix agreed with itself. {matrix.Line}");
        matrix.Violations.Should().BeEmpty(
            $"{Gate}: a state in which the body cannot act has no bounded exit - {string.Join(" | ", matrix.Violations)}. "
            + matrix.Line);
    }

    /// <summary>
    /// THE NIGHT'S HALF. `round93` (a): `sleep()` submitted from Town reported `not_home` for 308 s and the engine's
    /// 2:00 AM pass-out ended the run, because the only bound on that wait was `EligibilityFrameBudget` frames of a
    /// reason nothing could clear. The injection is that shape - every reason waits - and the reading must name it with
    /// the budget it would have spent.
    /// </summary>
    [Fact]
    public void AReasonNobodyClearsIsBoundedByItsFramesInThePreFixTree()
    {
        SleepAndAdvanceDayLifecycle.CannotBecomeEligibleByWaiting(SleepAndAdvanceDayLifecycle.NotHomeReason)
            .Should().BeTrue(
                "the pre-fix tree was the one where `not_home` was waited on; while the product answers that it releases on "
                + "the reason, this falsifier has no shape left to inject");

        Matrix matrix = Build(releasesOnItsReason: _ => false);

        this.output.WriteLine(matrix.Line);
        matrix.Violations.Should().Contain(
            $"sleep_{SleepAndAdvanceDayLifecycle.NotHomeReason}_exceeded_its_bound:frames={SleepAndAdvanceDayLifecycle.EligibilityFrameBudget}",
            $"{Gate}: a reason no wait can clear must be bounded by the reason, not by the eligibility frame budget. "
            + string.Join(" | ", matrix.Violations));
    }

    /// <summary>
    /// THE JOURNAL'S HALF. `round93` (b): a `navigate_to_destination` re-entry left `open_status=RecoveryRequired` for
    /// 627-829 s. The program's own `program_stop` answered `NotFound` (the program was not `Active`), so the first exit
    /// from that state was the journal-open stale sweep one lifecycle watchdog later. The injection is that stop
    /// answering `NotFound`.
    /// </summary>
    [Fact]
    public void AProgrammeHoldingAnUnknownDispatchHasOnlyTheStaleSweepInThePreFixTree()
    {
        Matrix matrix = Build(stop: (_, _, _) => BodyProgramControllerResult.Failure<BodyProgramStatusSnapshot>(
            BodyProgramControllerResultCode.NotFound));

        this.output.WriteLine(matrix.Line);
        matrix.Violations.Should().Contain(
            $"body_program_recovery_required_has_no_request_exit:first_exit={OpenBodyProgramJournalAuthority.RecoveryAbandonReasonCode}"
            + $":age_ms={OpenBodyProgramJournalAuthority.RecoveryAbandonAgeMs}",
            $"{Gate}: a program whose dispatch is unknown must be stoppable by the request that names it, or its first "
            + $"exit is the stale sweep. {string.Join(" | ", matrix.Violations)}");
    }

    /// <summary>
    /// THE SCREEN'S HALF. `round93` (c): a `LevelUpMenu` stood while she was about to pass out, the planner's
    /// `dismiss_modal` was refused, and the hold named `next_step=observe_again` - nothing to dispatch - although the
    /// product publishes `respond_level_up` for exactly that menu. The injection is the pre-fix classification, in which
    /// a level-up menu was the unaudited kind.
    /// </summary>
    [Fact]
    public void ALevelUpMenuIsTheUnauditedKindInThePreFixClassification()
    {
        SleepAndAdvanceDayLifecycle.OvernightMenu? levelUp =
            SleepAndAdvanceDayLifecycle.OvernightMenuFor(typeof(StardewValley.Menus.LevelUpMenu));
        levelUp.Should().NotBeNull("the engine raises it for every pending level (Game1.cs:9130-9134)");

        Matrix matrix = Build(kindOfMenuType: _ => BodyProgramModalKind.Menu);

        this.output.WriteLine(matrix.Line);
        matrix.Violations.Should().Contain(
            $"modal_kind_names_no_step:{levelUp!.MenuType.Name}:kind={BodyProgramModalKind.Menu}"
            + $";declared_answer={levelUp.ActionId}",
            $"{Gate}: a menu the product declares an answer for must be a kind whose hold names that answer. "
            + string.Join(" | ", matrix.Violations));
    }

    /// <summary>
    /// THE SCREEN'S RED PROOF FOR THE ESCAPE'S OWN RECEIPT. `round95`'s vocabulary could say a dismissal happened but not
    /// whose modal it was: the pre-fix spelling carried `cleared_modal=<type>` and nothing about the lease the hold had
    /// published as `action_owned=false`, so the one fact that made the dismissal safe to ask for never came back. This
    /// runs the row's OWN reading over that shape, so the falsifier cannot hold a rule the green run does not exercise.
    /// </summary>
    [Fact]
    public void ThePreFixReceiptCannotSayWhoseModalTheEscapeClosed()
    {
        const string PreFix =
            "modal_type=DialogueBox;dismissed=true;cleared_modal=DialogueBox;close_effect=native_dialogue_close";

        ReceiptNamesWhatItClosed(PreFix).Should().BeFalse(
            "the pre-fix receipt never names the owner, so a caller told `action_owned=false` could not read the close back");
        ReceiptNamesWhatItClosed(ModalFamily.ClosedModalField("DialogueBox", ModalFamily.NoOwner)).Should().BeTrue(
            "the escape's own receipt says what it closed and that nobody owned it");
        ReceiptNamesWhatItClosed(ModalFamily.ClosedModalField("DialogueBox", ModalFamily.OwnedByFact(true, "execution_1")))
            .Should().BeTrue("a modal an execution DID own is named by that lease rather than reported as nobody's");
        ReceiptNamesWhatItClosed("closed_modal_type=DialogueBox;owned_by=").Should().BeFalse(
            "an empty owner names nobody, which is the absence being used as its own evidence");
    }

    /// <summary>
    /// THE DECLARATION'S COMPLETENESS. The night's reason vocabulary is assigned in one method, so the table this matrix
    /// walks is only complete if every literal that method assigns is a member of it. A refusal added there tomorrow
    /// fails by name here instead of becoming a waiting state with no end - which is exactly the `not_home` 308 s, one
    /// layer up.
    /// </summary>
    [Fact]
    public void EveryReasonTheLiveEligibilityGateAssignsIsDeclared()
    {
        string body = MethodBody(
            StripComments(ReadSource("integrations/stardew/SleepAndAdvanceDayLifecycle.cs")),
            "private bool TryEnterEligibility(out string reason)");

        IReadOnlyList<string> assigned = Regex
            .Matches(body, "reason = \\$?\"([a-z_]+):?")
            .Select(match => match.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        assigned.Should().NotBeEmpty("the gate assigns its reasons as literals; a reading that found none has stopped reading");
        this.output.WriteLine($"eligibility reasons assigned by the live gate: {string.Join(",", assigned)}");

        IReadOnlyList<string> declared = SleepAndAdvanceDayLifecycle.EligibilityReasons.Select(row => row.Code).ToArray();
        foreach (string reason in assigned)
            declared.Should().Contain(
                code => string.Equals(code.TrimEnd(':'), reason, StringComparison.Ordinal),
                $"{Gate}: the live gate answers `{reason}`, and a reason outside the declaration is a state this matrix "
                + "does not walk - so no bound is asserted for it");
    }

    // -----------------------------------------------------------------------------------------------------------------
    // The matrix
    // -----------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Build one matrix. Every argument is a seam the falsifiers above inject: the production run passes the product's
    /// own declarations, and a pre-fix shape is one delegate. The same reading runs both times, so a falsifier cannot
    /// hold a rule the green run does not exercise.
    /// </summary>
    private static Matrix Build(
        Func<string, bool>? releasesOnItsReason = null,
        Func<OpenBodyProgramJournalAuthority, string, long, BodyProgramControllerResult<BodyProgramStatusSnapshot>>? stop = null,
        Func<string, BodyProgramModalKind>? kindOfMenuType = null)
    {
        Func<string, bool> releases = releasesOnItsReason ?? SleepAndAdvanceDayLifecycle.CannotBecomeEligibleByWaiting;
        Func<OpenBodyProgramJournalAuthority, string, long, BodyProgramControllerResult<BodyProgramStatusSnapshot>> stopProgram =
            stop ?? ((authority, programId, stopEpoch) => authority.TryStop(programId, stopEpoch));
        Func<string, BodyProgramModalKind> kindOf = kindOfMenuType ?? WorldModel.KindForMenuType;

        var rows = new List<string>();
        var violations = new List<string>();
        int states = 0;
        int transitions = 0;
        int interleavings = 0;

        // ① THE NIGHT: every reason the eligibility gate can refuse for.
        foreach (SleepAndAdvanceDayLifecycle.EligibilityReason reason in SleepAndAdvanceDayLifecycle.EligibilityReasons)
        {
            // `ok` is the gate's own success value: the night is in, so it is not a state in which the body cannot act.
            if (string.Equals(reason.Code, SleepAndAdvanceDayLifecycle.EligibilityEntered, StringComparison.Ordinal)) continue;
            states += 1;
            if (reason.ClearedBy.Length > 0)
            {
                // A frame wait is bounded because a declared step clears the reason. The bound is the declaration's.
                bool waits = SleepAndAdvanceDayLifecycle.DecideEligibilityWait(
                    reason.Code, MicroStepBound, SleepAndAdvanceDayLifecycle.EligibilityFrameBudget) == SleepAndAdvanceDayLifecycle.EligibilityWaitOutcome.Waiting;
                if (!waits)
                {
                    violations.Add($"sleep_{reason.Code}_declared_clearable_but_ends:cleared_by={reason.ClearedBy}");
                    continue;
                }

                transitions += 1;
                interleavings += 1;
                rows.Add($"night reason={reason.Code} exit=step worth waiting for, cleared by: {reason.ClearedBy}");
                continue;
            }

            SleepAndAdvanceDayLifecycle.EligibilityWaitOutcome outcome = SleepAndAdvanceDayLifecycle.DecideEligibilityWait(
                reason.Code, MicroStepBound, SleepAndAdvanceDayLifecycle.EligibilityFrameBudget);
            bool released = releases(reason.Code) && outcome == SleepAndAdvanceDayLifecycle.EligibilityWaitOutcome.TerminalOnReason;
            if (!released)
            {
                violations.Add($"sleep_{reason.Code}_exceeded_its_bound:frames={SleepAndAdvanceDayLifecycle.EligibilityFrameBudget}");
                continue;
            }

            transitions += 1;
            interleavings += 1;
            rows.Add($"night reason={reason.Code} exit=terminal_on_reason within {MicroStepBound} step");
        }

        // ② THE JOURNAL: the two program states that hold something, driven to a terminal by the request seam.
        foreach (BodyProgramState held in HoldingProgramStates)
        {
            states += 1;
            ProgramExit exit = DriveProgramExit(held, stopProgram);
            if (!exit.Reached)
            {
                violations.Add(exit.PremiseFailed
                    ? $"body_program_{held.ToString().ToLowerInvariant()}_premise_not_reached:{exit.Evidence}"
                    : held == BodyProgramState.RecoveryRequired
                        ? $"body_program_recovery_required_has_no_request_exit:first_exit={OpenBodyProgramJournalAuthority.RecoveryAbandonReasonCode}"
                          + $":age_ms={OpenBodyProgramJournalAuthority.RecoveryAbandonAgeMs}"
                        : $"body_program_{held.ToString().ToLowerInvariant()}_has_no_request_exit:steps={exit.Steps}");
                continue;
            }

            transitions += 1;
            interleavings += exit.Interleavings;
            rows.Add($"program state={held} exit={exit.Evidence} steps={exit.Steps}");
        }

        // ③ THE SCREEN: every mounted modal kind, then every menu the night declares an answer for.
        string[] catalogActions = FarmhandActionCatalog.Registrations.Select(registration => registration.ActionId).ToArray();
        catalogActions.Should().NotBeEmpty("the catalog declares the action population; an empty one agrees with itself");
        string bodyOwning = catalogActions.First(actionId => !FarmhandActionCatalog.IsModalResolving(actionId));

        foreach (BodyProgramModalKind kind in MountedModalKinds())
        {
            states += 1;
            var modal = new BodyProgramModalFact(kind, kind + "Menu");
            BodyProgramHold? hold = BodyProgramDispatchGate.HoldOf(bodyOwning, cutsceneUp: false, modal: modal, actorCanMove: false);
            string[] admitted = catalogActions
                .Where(actionId => BodyProgramDispatchGate.IsDispatchable(actionId, cutsceneUp: false, modal: modal, actorCanMove: false))
                .ToArray();
            interleavings += admitted.Length;

            if (hold is null)
            {
                transitions += 1;
                rows.Add($"modal kind={kind} exit=the kind holds no body-owning action");
                continue;
            }

            string evidence = hold.Value.Evidence;
            if (admitted.Length == 0 && !evidence.Contains("_opens_its_own=", StringComparison.Ordinal))
            {
                violations.Add($"modal_kind_admits_no_action:kind={kind};{evidence}");
                continue;
            }

            if (admitted.Length == 0 || NamedActions(evidence).Any(admitted.Contains) || evidence.Contains("_opens_its_own=", StringComparison.Ordinal)
                || evidence.Contains("next_step=", StringComparison.Ordinal))
            {
                transitions += 1;
                rows.Add($"modal kind={kind} exit={evidence}");
                continue;
            }

            violations.Add($"modal_kind_names_no_step:kind={kind};{evidence}");
        }

        // ③b THE MEASURED SHAPE: a `DialogueBox` NOBODY OWNS that asks nothing.
        //
        // The kind loop above proves the GATE releases an action. That is not escapability: the action the gate names
        // must also be one the family's own decision ACCEPTS, and its receipt must state what it closed and who held
        // it. MEASURED `round95` (2026-11-23, day 6 08:30): `cut_weeds` was refused
        // `actor_held_by_modal;modal_type=DialogueBox;action_owned=false;is_question=false` and the hold named
        // `dismiss_it=dismiss_modal` - and no receipt in the vocabulary could say the dismissal it asked for was of a
        // modal nobody owned. The case is driven through the product's own classifier, its own decision and its own
        // receipt vocabulary, so the box is a real `DialogueBox` and not a kind constant.
        {
            states += 1;
            DialogueBox plainBox = PlainDialogueBox();
            BodyProgramModalFact plain = WorldModel.MountedModal(plainBox, dialogueUp: true);
            BodyProgramHold? plainHold = BodyProgramDispatchGate.HoldOf(bodyOwning, cutsceneUp: false, modal: plain, actorCanMove: false);
            bool released = BodyProgramDispatchGate.IsDispatchable("dismiss_modal", cutsceneUp: false, modal: plain, actorCanMove: false);
            // The actor is the level-up arm's only input (its `newLevels`); a plain box's arm reads no actor fact.
            ModalFamily.Dismissal verdict = ModalFamily.DecideDismissal(
                plainBox,
                (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer)),
                actionOwned: false,
                ownerExecutionId: null);
            string closedField = verdict is ModalFamily.Dismissal.Closeable close
                ? ModalFamily.ClosedModalField(close.ModalType, close.OwnedBy)
                : "refused:" + ((ModalFamily.Dismissal.Unavailable)verdict).ReasonCode;

            rows.Add($"modal plain_box kind={plain.Kind} released={released};hold={plainHold?.Evidence ?? "none"};receipt={closedField}");

            if (plain.Kind is not BodyProgramModalKind.PlainDialogue)
                violations.Add($"modal_plain_box_classified_as:kind={plain.Kind};type={plain.TypeName ?? "none"}");
            else if (plainHold is not { } owned || !string.Equals(owned.Evidence, "held_by=dialogue_box;" + BodyProgramDispatchGate.DismissModalRemedy, StringComparison.Ordinal))
                violations.Add($"modal_plain_box_hold_names_no_dismissal:kind={plain.Kind};evidence={plainHold?.Evidence ?? "none"}");
            else if (!released)
                violations.Add($"modal_plain_box_admits_no_dismissal:kind={plain.Kind}");
            else if (!ReceiptNamesWhatItClosed(closedField))
                violations.Add($"modal_plain_box_receipt_names_no_close:kind={plain.Kind};receipt={closedField}");
            else
                transitions += 1;
        }

        // ③c THE LEVEL-UP ARM: a menu the snapshot NAMES must carry the pair it is asking about.
        //
        // The declared-answerable loop below proves the gate names `respond_level_up` for the kind. It cannot prove the
        // caller has an ARGUMENT: MEASURED 2026-11-23 (`multiday`, `dayRecords[0]`), a `LevelUpMenu` stood for a whole
        // night while `pendingLevelUps` read `[]`, because the modal was named from `Game1.activeClickableMenu` and the
        // pair from `Farmer.newLevels` - two reads of two engine objects, and `respond_level_up` itself empties the second
        // (`LevelUpMenu.cs:637-648`) one update before the first lets go of the menu (`:414-419`). The population is the
        // declaration's own level-up member, in its two engine states: the menu still asking, and the menu that has
        // settled and is on its way off the screen.
        SleepAndAdvanceDayLifecycle.OvernightMenu levelUpMenu = SleepAndAdvanceDayLifecycle.OvernightMenus.Single(
            menu => menu.Forward == SleepAndAdvanceDayLifecycle.OvernightMenuForwardAction.CompanionAnswers
                && menu.MenuType == typeof(LevelUpMenu));
        // The actor's queue is EMPTY, which is the measured state (`newLevels` loses the pair the moment the answer
        // lands): whatever the asking arm publishes below it must have read off the menu itself.
        Farmer levelUpActor = LevelUpActor();
        foreach (bool asking in new[] { true, false })
        {
            states += 1;
            LevelUpMenu mounted = MountedLevelUpMenu(4, 5, asking);
            string named = WorldModel.MountedMenuName(mounted) ?? "none";
            BodyProgramModalKind mountedKind = WorldModel.MountedModal(mounted, dialogueUp: false).Kind;
            int pairs = ExecutionManager.PendingLevelUpPairs(levelUpActor, WorldModel.AskingLevelUpMenu(mounted)).Count;
            rows.Add($"modal menu={levelUpMenu.MenuType.Name} asking={asking.ToString().ToLowerInvariant()};named={named};kind={mountedKind};pairs={pairs}");

            if (asking)
            {
                if (named != levelUpMenu.MenuType.Name)
                    violations.Add($"level_up_menu_not_named_while_asking:menu={levelUpMenu.MenuType.Name};named={named}");
                else if (pairs == 0)
                    violations.Add($"level_up_menu_named_with_no_pair:menu={levelUpMenu.MenuType.Name};declared_answer={levelUpMenu.ActionId}");
                else
                {
                    transitions += 1;
                    interleavings += 1;
                }
            }
            else if (named != "none" || mountedKind != BodyProgramModalKind.None || pairs != 0)
            {
                violations.Add($"level_up_menu_reported_after_it_settled:named={named};kind={mountedKind};pairs={pairs}");
            }
            else
            {
                transitions += 1;
            }
        }

        foreach (SleepAndAdvanceDayLifecycle.OvernightMenu menu in SleepAndAdvanceDayLifecycle.OvernightMenus
                     .Where(menu => menu.Forward == SleepAndAdvanceDayLifecycle.OvernightMenuForwardAction.CompanionAnswers))
        {
            states += 1;
            BodyProgramModalKind kind = kindOf(menu.MenuType.Name);
            var modal = new BodyProgramModalFact(kind, menu.MenuType.Name);
            BodyProgramHold? hold = BodyProgramDispatchGate.HoldOf(bodyOwning, cutsceneUp: false, modal: modal, actorCanMove: false);
            bool admits = menu.ActionId is not null
                && BodyProgramDispatchGate.IsDispatchable(menu.ActionId, cutsceneUp: false, modal: modal, actorCanMove: false);
            bool names = hold is { } named && menu.ActionId is not null && NamedActions(named.Evidence).Contains(menu.ActionId);
            interleavings += admits ? 1 : 0;
            if (admits && names)
            {
                transitions += 1;
                rows.Add($"modal menu={menu.MenuType.Name} kind={kind} exit={hold!.Value.Evidence}");
                continue;
            }

            violations.Add($"modal_kind_names_no_step:{menu.MenuType.Name}:kind={kind};declared_answer={menu.ActionId}");
        }

        if (states == 0)
            violations.Add("body_state_matrix_population_empty: no declared state was read, so no bound was asserted");

        return new Matrix(
            states,
            transitions,
            interleavings,
            violations,
            rows,
            $"declarations: eligibility reasons {SleepAndAdvanceDayLifecycle.EligibilityReasons.Count} · "
            + $"holding program states {HoldingProgramStates.Length} · mounted modal kinds {MountedModalKinds().Length} · "
            + $"declared answerable menus {SleepAndAdvanceDayLifecycle.OvernightMenus.Count(menu => menu.Forward == SleepAndAdvanceDayLifecycle.OvernightMenuForwardAction.CompanionAnswers)}");
    }

    /// <summary>
    /// Drive one holding program state to a terminal through the real journal and the real pump, with the clock frozen:
    /// a reading that needed the stale sweep has to advance that clock by `RecoveryAbandonAgeMs`, and nothing here does.
    /// </summary>
    private static ProgramExit DriveProgramExit(
        BodyProgramState held,
        Func<OpenBodyProgramJournalAuthority, string, long, BodyProgramControllerResult<BodyProgramStatusSnapshot>> stopProgram)
    {
        const long now = 10;
        OpenBodyProgramJournalAuthority authority = OpenAuthority(() => now);
        string programId = held == BodyProgramState.Active ? "plan_active" : "plan_recovery";
        if (authority.Submit(SingleNodeProgram(programId, "water_crop")).Code != BodyProgramSubmitCode.Accepted)
            return ProgramExit.Premise("the drive could not submit the program it must hold");

        if (held == BodyProgramState.Active)
        {
            BodyProgramControllerResult<BodyProgramStatusSnapshot> stopped = stopProgram(authority, programId, 1);
            bool reached = stopped.IsSuccess
                && authority.Status(programId).Snapshot!.State == BodyProgramState.Cancelled
                && authority.IsMutable;
            return new ProgramExit(reached, "program_stop=cancel", 1, 0);
        }

        // The measured shape: a dispatched node whose outcome is unknown, settled `RecoveryRequired`.
        var controller = new FarmhandBodyProgramController(authority, new GrantingAdmissionTransport(), new UncertainOnSecondVisitExecutor())
        {
            NowMs = () => now,
        };
        controller.Update();
        controller.Update();
        if (authority.Status(programId).Snapshot!.State != BodyProgramState.RecoveryRequired)
            return ProgramExit.Premise("the drive never reached the unknown dispatch the stop has to be able to end");
        if (authority.OpenStatus != BodyProgramJournalOpenStatus.RecoveryRequired)
            return ProgramExit.Premise("the drive's unknown dispatch did not close the journal's write path");

        // THE INTERLEAVINGS: the re-entry is admitted beside it, and the stop ends it - both without the sweep.
        BodyProgramSubmitCode reentry = authority.Submit(SingleNodeProgram("plan_reentry", "water_crop")).Code;
        BodyProgramControllerResult<BodyProgramStatusSnapshot> stop = stopProgram(authority, programId, 1);
        bool reachedOnStop = reentry == BodyProgramSubmitCode.Accepted
            && stop.IsSuccess
            && authority.Status(programId).Snapshot!.State == BodyProgramState.Failed
            && authority.OpenStatus == BodyProgramJournalOpenStatus.Opened
            && authority.IsMutable;
        return new ProgramExit(reachedOnStop, "program_stop=abandon", 1, 1);
    }

    /// <summary>Every action id an evidence string names as its remedy, in whichever field it names one.</summary>
    private static IEnumerable<string> NamedActions(string evidence)
    {
        foreach (string field in evidence.Split(';'))
        {
            int equals = field.IndexOf('=', StringComparison.Ordinal);
            if (equals < 0) continue;
            string key = field[..equals];
            string value = field[(equals + 1)..];
            if (key is "answer_it" or "dismiss_it") yield return value;
            // `shop_purchase_opens_its_own` states the remedy's own fact: the action id is the field before `_opens_its_own`.
            if (key.EndsWith("_opens_its_own", StringComparison.Ordinal)) yield return key[..^"_opens_its_own".Length];
        }
    }

    /// <summary>Every kind a live menu can be. `None` is the absence of one, so it is not a state.</summary>
    private static BodyProgramModalKind[] MountedModalKinds() => Enum.GetValues<BodyProgramModalKind>()
        .Where(kind => kind != BodyProgramModalKind.None)
        .ToArray();

    /// <summary>
    /// A real `LevelUpMenu` as the engine mounts one: its pair is PRIVATE (`LevelUpMenu.cs:30/32`), so it is seeded
    /// through those exact fields - the two the action's own reflection reads back - and `isActive` is the engine's own
    /// "still asking" flag (`:414-419` exits it, `:637-648` clears it when the answer lands).
    /// </summary>
    private static LevelUpMenu MountedLevelUpMenu(int skill, int level, bool asking)
    {
        var menu = (LevelUpMenu)FormatterServices.GetUninitializedObject(typeof(LevelUpMenu));
        typeof(LevelUpMenu).GetField("currentSkill", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(menu, skill);
        typeof(LevelUpMenu).GetField("currentLevel", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(menu, level);
        menu.isProfessionChooser = level is 5 or 10;
        menu.isActive = asking;
        return menu;
    }

    /// <summary>
    /// The actor a level-up arm reads: `newLevels`, the queue `Game1.showEndOfNightStuff` pops those menus from
    /// (`Game1.cs:9130-9134`). `NetList` is inline-initialised on a REAL `Farmer`, so an uninitialized probe has it null
    /// and this seeds the engine's own collection type rather than a stand-in that could accept what the game would not.
    /// </summary>
    private static Farmer LevelUpActor(params Point[] pending)
    {
        var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        FieldInfo levelsField = typeof(Farmer).GetField("newLevels", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!;
        object levels = Activator.CreateInstance(levelsField.FieldType)!;
        MethodInfo add = levels.GetType().GetMethod("Add", new[] { typeof(Point) })!;
        foreach (Point point in pending)
            add.Invoke(levels, new object[] { point });
        levelsField.SetValue(actor, levels);
        return actor;
    }

    /// <summary>
    /// A `DialogueBox` with no question and no pages: the mount `round95` measured. Uninitialized the way the sibling
    /// modal suites mint one - `isQuestion` is the only field the family's decision reads for a plain box's arm.
    /// </summary>
    private static DialogueBox PlainDialogueBox()
    {
        DialogueBox box = (DialogueBox)FormatterServices.GetUninitializedObject(typeof(DialogueBox));
        box.isQuestion = false;
        return box;
    }

    /// <summary>
    /// Whether a receipt's own fields say WHAT it closed and WHO held it: the two facts `round95`'s hold published
    /// (`modal_type=`, `action_owned=`) and its receipt vocabulary could not answer back.
    /// </summary>
    private static bool ReceiptNamesWhatItClosed(string fields)
    {
        var seen = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string field in fields.Split(';'))
        {
            int equals = field.IndexOf('=', StringComparison.Ordinal);
            if (equals <= 0) continue;
            seen[field[..equals]] = field[(equals + 1)..];
        }

        return seen.TryGetValue("closed_modal_type", out string? closed) && closed.Length > 0
            && seen.TryGetValue("owned_by", out string? owner)
            && (string.Equals(owner, ModalFamily.NoOwner, StringComparison.Ordinal)
                || (owner.StartsWith("execution:", StringComparison.Ordinal) && owner.Length > "execution:".Length));
    }

    /// <summary>
    /// The two program states that hold something. <see cref="BodyProgramState.Active"/> holds the body - it is the only
    /// state a node may start from (<c>SelectStartCandidate</c> refuses the rest) - and
    /// <see cref="BodyProgramState.RecoveryRequired"/> holds the journal's write path until its unknown dispatch is
    /// settled. The terminals hold nothing, and <see cref="BodyProgramState.Quarantined"/> is a wire value this build
    /// never writes, so no operation may be asked to leave it.
    /// </summary>
    private static readonly BodyProgramState[] HoldingProgramStates =
        { BodyProgramState.Active, BodyProgramState.RecoveryRequired };

    // -----------------------------------------------------------------------------------------------------------------
    // The harness: the real journal authority and the real pump, in memory
    // -----------------------------------------------------------------------------------------------------------------

    private static OpenBodyProgramJournalAuthority OpenAuthority(Func<long> nowMs) =>
        OpenBodyProgramJournalAuthority.Open(new MemoryStore(), Catalog(), Scope(), static () => Policy(), nowMs);

    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("water_crop", 1,
            new[] { new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer) },
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 1000),
    });

    private static ActionProgramCandidate SingleNodeProgram(string programId, string actionId) => new(programId, new[]
    {
        new ActionProgramCandidateNode(
            "n01",
            actionId,
            new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(
                new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal)
                {
                    ["x"] = new("integer", "43"),
                    ["y"] = new("integer", "44"),
                }),
            Array.Empty<string>(),
            new ReadOnlyDictionary<string, ActionProgramBinding>(
                new Dictionary<string, ActionProgramBinding>(StringComparer.Ordinal))),
    });

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);

    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");

    private static HostAdmissionGrant GrantFor(NodeAdmissionChallenge challenge) => new(
        challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt, challenge.StopEpoch,
        challenge.CatalogRevision, challenge.PolicyIdentity, challenge.ActionId, challenge.CanonicalArguments,
        challenge.DerivedResourceClaims, challenge.DeadlineMs, $"grant_{challenge.NodeId}_{challenge.NodeAttempt}", "attachment_01", "policy-a");

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        private string? value;

        public BodyProgramJournalReadResult Read() => this.value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.value);

        public bool TryWrite(string encodedState, string? replacedSiblingFileName = null)
        {
            this.value = encodedState;
            return true;
        }
    }

    private sealed class GrantingAdmissionTransport : IBodyProgramAdmissionTransport
    {
        private readonly List<NodeAdmissionChallenge> sent = new();

        public long AttachmentGeneration => 1;

        public string? Send(NodeAdmissionChallenge challenge)
        {
            this.sent.Add(challenge);
            return null;
        }

        public BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt) =>
            this.sent.SingleOrDefault(asked => asked.ProgramId == programId && asked.NodeId == nodeId
                && asked.NodeAttempt == nodeAttempt && asked.AdmissionAttempt == admissionAttempt) is { } challenge
                ? new BodyNodeAdmissionGrantedResult(GrantFor(challenge))
                : null;
    }

    /// <summary>One visit keeps the node bound-Running, the next answers `Uncertain` - the unknown dispatch itself.</summary>
    private sealed class UncertainOnSecondVisitExecutor : IBodyProgramNodeExecutor
    {
        private readonly HashSet<string> visited = new(StringComparer.Ordinal);

        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            if (this.visited.Add(execution.ExecutionId))
                return null;
            return new BodyProgramTerminalResult(
                execution,
                BodyProgramNodeOutcome.Uncertain,
                Array.Empty<RuntimeFact>(),
                null,
                null,
                null);
        }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // The reading's own shapes
    // -----------------------------------------------------------------------------------------------------------------

    private sealed record ProgramExit(bool Reached, string Evidence, int Steps, int Interleavings)
    {
        /// <summary>The drive never reached the state under test, so it asserted nothing about it.</summary>
        internal static ProgramExit Premise(string why) => new(false, "premise: " + why, 0, 0);

        internal bool PremiseFailed => !this.Reached && this.Steps == 0;
    }

    private sealed record Matrix(
        int States,
        int Transitions,
        int Interleavings,
        IReadOnlyList<string> Violations,
        IReadOnlyList<string> Rows,
        string Declarations)
    {
        internal string Line => $"states {this.States} · transitions {this.Transitions} · interleavings {this.Interleavings} · violations {this.Violations.Count}";
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Source reading, for the declaration only
    // -----------------------------------------------------------------------------------------------------------------

    private static string RepositoryRoot()
    {
        string? directory = AppContext.BaseDirectory;
        while (directory is not null && !Directory.Exists(Path.Combine(directory, "integrations")))
            directory = Path.GetDirectoryName(directory);
        return directory ?? throw new InvalidOperationException("repository_root_not_found");
    }

    private static string ReadSource(string relativePath) =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), relativePath.Replace('/', Path.DirectorySeparatorChar)));

    private static string StripComments(string source) => Regex.Replace(source, "//[^\n]*", string.Empty);

    /// <summary>The body of one method, from its declaration to the line before the next member at the same indent.</summary>
    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{signature} must still be declared: a reading that finds no method asserts nothing");
        int end = source.IndexOf("\n    private ", start + signature.Length, StringComparison.Ordinal);
        return end < 0 ? source[start..] : source[start..end];
    }
}
