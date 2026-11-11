using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Netcode;
using StardewValley.Network;
using StardewValley;
using StardewValley.Audio;
using StardewValley.Menus;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The WIA §4.2 modal-handling family's first real member: `dismiss_modal`
/// closes an informational native dialogue (a DialogueBox with no pending
/// question) through the native closeDialogue path, and is the ONE action that
/// may run while the world holds a modal (admission grants it the Modal
/// profile; this body just performs the dismissal). Question dialogues are
/// refused with modal_not_dismissible — answering is answer_dialogue's future
/// seam (design 7.4.2). The receipt names the clearance it performed
/// (`cleared_modal=`), and this action is the ONLY clearance on the action path:
/// the shared admission refuses a held body rather than evicting the modal, so
/// both properties are pinned here.
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class ModalDismissActionTests
{
    private const string ScopePlayerId = "1001";

    private readonly ITestOutputHelper output;

    public ModalDismissActionTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    // ---- success -------------------------------------------------------------

    /// <summary>
    /// The receipt of a clearance NAMES the clearance, and states what the close ITSELF changed, because the honest
    /// answer differs by type: a whitelisted operation menu is a pure cancel, while closeDialogue advances native
    /// dialogue state (DialogueBox.cs:198-216, :243-248). A blanket "no side effects" flag would be false for exactly
    /// the case this action exists for.
    ///
    /// <para>
    /// ONE TERMINAL NOW. The old postcondition read "the menu is gone and no dialogue is up", which made a close that
    /// the engine's own `Game1.afterDialogues` continuation followed look like a failure (`postcondition_failed`) -
    /// the failure terminal is gone with it, and what stands is named instead (`has_more_pages`, `next_modal_type`).
    /// `EveryShapeTheCloseLeavesBehind_IsASuccess_AndTheEvidenceNamesIt` covers that reading over every shape.
    /// </para>
    /// <para>
    /// A source probe, like the sibling native-seam pins: the success terminal cannot be produced headless,
    /// because closeDialogue restores Farmer.CanMove through Game1.player (DialogueBox.cs:226) and a probe
    /// process has no live player - and seeding one drags in the whole net world state that `NetPosition.Get` reads
    /// (`Game1.HostPaused` -> `netWorldState`). The live claim belongs to the native-local modal chain gate.
    /// </para>
    /// </summary>
    [Fact]
    public void Dismiss_Receipt_NamesTheModalItCleared_AndWhatTheCloseChanged()
    {
        string code = StripLineComments(ReadRepositoryText("integrations", "stardew", "farmhandexecutioncontroller.modalactions.cs"));

        code.Should().Contain(
            "modal_type={modalType};dismissed=true;cleared_modal={modalType};close_effect={closeEffect}{continuation}",
            "the receipt states the clearance next to the modal it dismissed, and what the close left behind");
        code.Should().Contain(
            ";has_more_pages=true;next_modal_type=",
            "a continuation is named rather than reported as a failure");
        code.Should().Contain(
            "string closeEffect = modal is DialogueBox ? \"native_dialogue_close\" : \"pure_cancel\";",
            "the close's own effect is stated per native type, not as one blanket claim");
        code.Should().NotContain(
            "side_effects=none",
            "a DialogueBox close does advance native dialogue state, so that blanket claim is false here");
    }

    /// <summary>
    /// The clearance goes through the ONE audited native exit and nothing else. The body must never settle the
    /// modal by writing the fields closeDialogue owns (Game1.dialogueUp, Game1.activeClickableMenu): a field
    /// write leaves Farmer.CanMove false (DialogueBox.cs:226 runs only inside closeDialogue) and the speaker's
    /// dialogue stack untouched — the closed-looking-but-still-holding state the audited close exists to avoid.
    /// </summary>
    [Fact]
    public void Dismiss_ClearsOnlyThroughTheAuditedNativeClose_NeverAFieldWrite()
    {
        string code = StripLineComments(MethodBody(
            ReadRepositoryText("integrations", "stardew", "farmhandexecutioncontroller.modalactions.cs"),
            "public LocalExecutionReceipt RequestLocalDismissModal("));

        code.Should().Contain("dialogueBox.closeDialogue()",
            "a DialogueBox is cleared by the public native exit the native input paths use");
        code.Should().Contain("Game1.exitActiveMenu()",
            "the audited operation menus override no exitThisMenu, so their exit is that same generic step");
        code.Should().NotContain("dialogueUp =");
        code.Should().NotContain("activeClickableMenu =");
    }

    /// <summary>
    /// The lane's decision, pinned: the shared admission does NOT evict a mounted modal. A request arriving while
    /// an informational box holds the actor is refused with the named hold (actor_held_by_modal plus the modal
    /// facts; ModalAdmissionTests pins that for the Physical and General profiles), and the way out is the
    /// explicit action above. Clearing a dialogue is itself world-affecting — closeDialogue pops the speaker's
    /// CurrentDialogue and can re-open a queued box (DialogueBox.cs:198-216) — so an automatic one would change
    /// the world on behalf of a request that never asked for it, and no receipt of that request would say so.
    /// </summary>
    [Fact]
    public void SharedAdmission_NeverEvictsTheModal_TheNamedRefusalIsTheOnlyPath()
    {
        string code = StripLineComments(ReadRepositoryText("integrations", "stardew", "farmhandexecutioncontroller.cs"));

        code.Should().NotContain("closeDialogue");
        code.Should().NotContain("exitActiveMenu");
        code.Should().Contain(
            "WorldModel.DescribeCurrentBodyHold(admissionDisposition, admissionFacts, boundActor.CanMove)",
            "the refusal names the hold and carries the modal facts the remedy needs; an eviction here would delete that fact");
    }

    /// <summary>
    /// Drift anchors for what the decision rests on. DialogueBox.closeDialogue is the ONE exit a DialogueBox
    /// clearance uses (:192) and it restores Farmer.CanMove (:226), so the actor really is free afterwards. The
    /// pager closes the box ITSELF once the last page is clicked (:407-410).
    ///
    /// A box that is still up when an action arrives is therefore one of three things - and this list is an
    /// OBSERVATION, not an argument that the pager prevents the hold: a question (the pager hard-stops on it), a
    /// box the Mod deliberately left to the player (NpcDialoguePager.cs:82-83, which is exactly the case where the
    /// box DOES hold the actor, because the pager declines to page what it cannot report), or a box the Agent
    /// clears by asking (this action). An earlier version of this paragraph claimed the pager is why an
    /// informational dialogue does not sit there holding the actor; those two facts are both true but do not
    /// support each other, and the pager-versus-dismiss ordering is instead asserted where it belongs.
    /// </summary>
    [Fact]
    public void DriftAnchors_TheNativeCloseIsTheSettlement_AndThePagerClosesAtExhaustion()
    {
        string[] dialogueBox = File.ReadAllLines(RepositoryPath(
            "ref", "external", "StardewValleyDecompiled", "Stardew Valley", "StardewValley.Menus", "DialogueBox.cs"));

        dialogueBox[192 - 1].Should().Contain("public void closeDialogue()");
        dialogueBox[196 - 1].Should().Contain("Game1.exitActiveMenu();");
        dialogueBox[197 - 1].Should().Contain("Game1.dialogueUp = false;");
        dialogueBox[226 - 1].Should().Contain("Game1.player.CanMove = true;");
        dialogueBox[407 - 1].Should().Contain("dialogues.RemoveAt(0);");
        dialogueBox[408 - 1].Should().Contain("if (dialogues.Count == 0)");
        dialogueBox[410 - 1].Should().Contain("closeDialogue();");
    }

    // ---- the settlement commit is entered once ---------------------------------

    /// <summary>
    /// A SECOND dismiss inside the shipping outro must not drive the engine a second time.
    ///
    /// <para>
    /// `ShippingMenu.okClicked` (ShippingMenu.cs:690-696) is not idempotent: it sets `outro = true` and
    /// `outroFadeTimer = 800`, and `update` fades by DECREMENTING that timer (:380-397) while `draw`
    /// paints the black overlay as `1 - outroFadeTimer / 800` (:920). So a second call re-arms the
    /// 800 ms fade from the top: the overlay snaps back to transparent and the outro restarts. The engine's
    /// own guards (`!outro` at :677, `(outro && !savedYet)` at :701) cannot help, because this handler
    /// reaches the private method through reflection rather than through an input path.
    /// </para>
    /// <para>
    /// The receipt clears `clearing=true` (:343) and the menu then survives several frames of outro, so a
    /// second `dismiss_modal` arriving in that window is a REAL shape, not a hypothetical one. The reading
    /// here is the engine's own timer - brought down to 100 ms as `update` would have brought it - rather
    /// than a call count, because the timer IS the consequence the guard exists to prevent.
    /// </para>
    /// </summary>
    [Fact]
    public void ShippingCommit_IsEnteredOnce_AndASecondDismissInsideTheFadeDoesNotReDriveTheEngine()
    {
        ShippingMenu shipping = CreateShipping();
        RunWithGameState(menu: shipping, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            LocalExecutionReceipt first = InvokeDismiss(manager, "req_shipping_first");
            this.output.WriteLine($"first: {first.State}/{first.ReasonCode};evidence={first.Evidence}");
            // `okClicked` sets both fields BEFORE it plays its sound and changes the music track, and
            // `Game1.changeMusicTrack` dereferences `Game1.currentLocation` (:920), which a probe process does not
            // have - so the first terminal is `Uncertain` here for a reason that lives in the audio/location boundary
            // this test does not own. The two engine fields below are the reading that matters: they are the commit.
            ReadPrivate(shipping, "outro").Should().Be(true, "okClicked is what starts the outro");
            ReadPrivate(shipping, "outroFadeTimer").Should().Be(800, "okClicked arms the 800 ms fade (ShippingMenu.cs:693)");

            // Mid-outro: this is where the engine's own update leaves the timer after ~700 ms of fade.
            typeof(ShippingMenu)
                .GetField("outroFadeTimer", BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(shipping, 100);

            LocalExecutionReceipt second = InvokeDismiss(manager, "req_shipping_second");
            this.output.WriteLine($"second: {second.State}/{second.ReasonCode};evidence={second.Evidence};outroFadeTimer={ReadPrivate(shipping, "outroFadeTimer")}");

            second.State.Should().Be(ExecutionState.Succeeded,
                "the settlement the caller asked for is already under way, so the second request is a no-op rather than a failure");
            second.ReasonCode.Should().Be("settlement_commit_in_progress");
            ReadPrivate(shipping, "outroFadeTimer").Should().Be(100,
                "a second dismiss must not re-arm the fade: the engine's commit is entered exactly once");
        });
    }

    // ---- a dismissal the world continues is still a success ---------------------

    /// <summary>
    /// GATE, not a test: after the native close has RUN, every shape the world can be left in is a SUCCESS, and the
    /// evidence says which shape it is. A dismissal cannot report a failure once its close went through.
    ///
    /// <para>
    /// THE AUDIT'S STORY IS WRONG AND ITS SYMPTOM IS RIGHT, so this file records what the engine does.
    /// `DialogueBox.closeDialogue` (DialogueBox.cs:192-249) mounts nothing: it exits the menu (:196, which is
    /// `activeClickableMenu = null`, Game1.cs:6128-6131), clears `dialogueUp` (:197) and pops the speaker's
    /// `CurrentDialogue` only when `dialogueFinished` (:198-201) - a whole `Dialogue`, not one page. A multi-page box
    /// pages INSIDE one menu (`Dialogue.dialogues` / `characterDialoguesBrokenUp`, DialogueBox.cs:405-450), and the
    /// object-dialogue branch that could re-raise `dialogueUp` (:206-216) is unreachable in this version because
    /// `Game1.currentObjectDialogue` is never enqueued anywhere in the decompiled tree.
    /// </para>
    /// <para>
    /// The continuation that DOES exist is `Game1.afterDialogues`, which the close invokes synchronously as its last
    /// act (:243-248): the engine's own content chains the next box there (`TV.selectChannel` draws each screen and
    /// re-registers `Game1.afterDialogues = proceedToNextScene`, TV.cs:92-140; `NPC.cs:2691` chains a question), so a
    /// box is mounted before the close returns. The old postcondition ("the menu is gone and no dialogue is up")
    /// therefore failed with `Failed/postcondition_failed` exactly when the close SUCCEEDED and the world continued -
    /// which stops a programme while the next dialogue holds the body.
    /// </para>
    /// <para>
    /// The population is what the close can leave standing, which is also what the pager reports: nothing (the
    /// dialogue ended), a mounted box (the engine's continuation took over), or the bare `dialogueUp` flag. The count
    /// is printed, and the reading is the production function rather than a copy of it.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryShapeTheCloseLeavesBehind_IsASuccess_AndTheEvidenceNamesIt()
    {
        DialogueBox nextPage = CreateDialogue(isQuestion: false);
        (string Shape, IClickableMenu? Standing, bool DialogueUp, string ExpectedNext)[] shapes =
        {
            ("dialogue_closed", null, false, "none"),
            ("next_box_mounted", nextPage, true, "DialogueBox"),
            ("dialogue_up_flag", null, true, "dialogue_up"),
        };

        var rows = new List<(string Shape, ExecutionState State, string ReasonCode, string Evidence, string ExpectedNext)>();
        foreach ((string shape, IClickableMenu? standing, bool dialogueUp, string expectedNext) in shapes)
        {
            (ExecutionState state, string reasonCode, string evidence) = ExecutionManager.DescribeDismissalOutcome(
                "DialogueBox",
                "native_dialogue_close",
                ";text=hello",
                standing,
                dialogueUp);
            rows.Add((shape, state, reasonCode, evidence, expectedNext));
        }

        foreach ((string shape, ExecutionState state, string reasonCode, string evidence, string expectedNext) in rows)
            this.output.WriteLine($"{shape}: {state}/{reasonCode};next_modal_type={expectedNext};evidence={evidence}");
        this.output.WriteLine($"examined {rows.Count} of {shapes.Length} shapes a dismissal can leave behind");

        rows.Should().HaveCount(shapes.Length, "a shape that was not examined is a shape nobody decided");
        foreach ((string shape, ExecutionState state, string reasonCode, string evidence, string expectedNext) in rows)
        {
            state.Should().Be(ExecutionState.Succeeded,
                $"dialogue_close_is_a_failure:{shape}:{state}/{reasonCode} - the close ran, and the world's shape afterwards is not an effect it failed to produce");
            reasonCode.Should().Be("modal_dismissed", "the published postcondition name is the action's, in both terminals");
            evidence.Should().Contain("cleared_modal=DialogueBox");
            evidence.Should().Contain("close_effect=native_dialogue_close");
            evidence.Should().Contain(";text=hello", "what the box said is read before the close and stays on the receipt");
            string expectedPages = expectedNext == "none" ? "has_more_pages=false" : "has_more_pages=true";
            evidence.Should().Contain(expectedPages,
                $"the caller's next step depends on whether the presentation continued ({shape})");
            evidence.Should().Contain($"next_modal_type={expectedNext}",
                $"a continuation must name WHAT stands, or the caller cannot choose between answer_dialogue and dismiss_modal ({shape})");
        }
    }

    /// <summary>
    /// The failing terminal is gone rather than merely narrowed: a native close that ran has no failure outcome left,
    /// so the body may not report one. Same treatment `answer_dialogue` got for the same reason
    /// (AnswerDialogueNpcQuestionDispatchSourceShapeTests).
    /// </summary>
    [Fact]
    public void Dismiss_KeepsNoFailureTerminal_AfterTheNativeCloseRan()
    {
        string code = StripLineComments(MethodBody(
            ReadRepositoryText("integrations", "stardew", "farmhandexecutioncontroller.modalactions.cs"),
            "public LocalExecutionReceipt RequestLocalDismissModal("));

        code.Should().NotContain("\"postcondition_failed\"",
            "the close going through is the fact; what stands afterwards is the world's shape, and that is a success with evidence");
        code.Should().Contain("DescribeDismissalOutcome(",
            "the postcondition is the production reading, so the shape gate above covers the terminal the handler really answers");
    }

    // ---- rejections ----------------------------------------------------------

    /// <summary>
    /// THE COMPILER-INSERTED NODE'S DISPATCH: after a body-yielding step, `body-program-script.ts` writes a
    /// `dismiss_modal` node (`auto_dismiss_*`) because the dialogue a `talk_to_npc` raises holds the body. By the time that
    /// node runs, the engine or the night lifecycle may already have closed the box - and a node neither the author nor the
    /// world asked for must not arrive as a FAILURE the companion has to read and answer with a turn.
    ///
    /// <para>
    /// RED PROOF, replayed as the plan the compiler writes: `talk_to_npc` then `chop_tree` compiles to
    /// `talk_to_npc` -> `auto_dismiss_N` -> `chop_tree`, and dispatching that middle node into a world with NO modal is
    /// this test. Before this pin it answered `Rejected` / `no_modal_present` (measured `round44`: two author-written
    /// `dismiss_modal` nodes, `plan_648_0442da48ca242b09` `n01` and its sibling, each one a turn spent on a request whose
    /// intent already held). It now answers the no-op that lets the following node run.
    /// </para>
    /// </summary>
    [Fact]
    public void Dismiss_WithoutAModal_IsTheNoOp_TheInsertedNodeNeeds()
    {
        RunWithGameState(dialogue: null, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            LocalExecutionReceipt receipt = InvokeModalFamily(manager, "req_dismiss_none", "dismiss_modal");

            receipt.State.Should().Be(ExecutionState.Succeeded,
                "nothing to dismiss is the end state the caller asked for, so it is not a failure to report");
            receipt.ReasonCode.Should().Be("nothing_to_dismiss");
            receipt.Evidence.Should().Be("modal=none",
                "a success owes the evidence ADR-006 requires, and the only true claim is that no modal was there");
        });
    }

    /// <summary>
    /// GATE, not a test: EVERY member of the modal family, dispatched into a world where its precondition is absent, is
    /// either a no-op or a refusal that names its own fact - never a failure.
    ///
    /// <para>
    /// The population is the Mod's own declaration (`FarmhandActionCatalog.ModalResolvingActionIds`, derived from the
    /// registration handler group), so a fourth modal action joins this gate in the change that registers it. The
    /// property is derived too: the Host's compiler can only WRITE a member that declares no argument
    /// (`body-program-script.ts` `MODAL_CLEARING_PLAN_ACTION_IDS[0]`), so every argument-free member must answer the
    /// no-op - an argument-free member that refuses is a node the compiler writes and the world refuses, which is the
    /// defect this gate exists for. A member that declares arguments may refuse, because those arguments are an
    /// assertion the caller made (`answer_dialogue`'s `responseKey`, `respond_level_up`'s pair), and the refusal must
    /// name its own fact rather than borrow another's code.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryModalFamilyMember_WithoutItsPrecondition_IsANoOpOrANamedRefusal_NeverAFailure()
    {
        string[] population = FarmhandActionCatalog.ModalResolvingActionIds
            .OrderBy(actionId => actionId, StringComparer.Ordinal)
            .ToArray();
        population.Should().NotBeEmpty(
            "the family is declared by the catalog; an empty population means this gate read nothing and agrees with itself");

        var rows = new List<(string ActionId, bool ArgumentFree, ExecutionState State, string ReasonCode)>();
        RunWithGameState(dialogue: null, action: () =>
        {
            ExecutionManager manager = CreateManager(1001, FarmhandActionCatalog.ModalResolvingActionIds);
            foreach (string actionId in population)
            {
                FarmhandActionDescriptor? descriptor = FarmhandActionCatalog.Registrations
                    .Single(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal))
                    .Descriptor;
                descriptor.Should().NotBeNull(
                    $"modal_member_without_descriptor:{actionId} - the gate cannot tell whether the compiler may write this "
                    + "member without its argument contract");
                int declared = descriptor!.Arguments.Count;
                LocalExecutionReceipt receipt = InvokeModalFamily(
                    manager,
                    $"req_family_without_modal_{actionId}",
                    actionId);
                rows.Add((actionId, declared == 0, receipt.State, receipt.ReasonCode));
            }
        });

        int noOpAnswers = rows.Count(row => row.State == ExecutionState.Succeeded);
        int namedRefusals = rows.Count(row => row.State == ExecutionState.Rejected);
        this.output.WriteLine($"examined {rows.Count} of {population.Length}: {string.Join("; ", rows.Select(row => $"{row.ActionId}={row.State}/{row.ReasonCode}"))}");
        this.output.WriteLine($"dismiss_without_modal_answers: {noOpAnswers}");
        this.output.WriteLine($"answer_without_dialogue_refusals: {namedRefusals}");

        foreach ((string actionId, bool argumentFree, ExecutionState state, string reasonCode) in rows)
        {
            state.Should().BeOneOf(
                new[] { ExecutionState.Succeeded, ExecutionState.Rejected },
                $"modal_family_without_precondition_is_a_failure:{actionId}:{state}/{reasonCode} - the precondition being "
                + "absent is a fact about the world, not an effect the action failed to produce");
            if (argumentFree)
                state.Should().Be(
                    ExecutionState.Succeeded,
                    $"inserted_node_refused:{actionId}:{state}/{reasonCode} - the compiler may only write a member that "
                    + "declares no argument, so such a member must resolve as the no-op rather than a refusal");
            else
                reasonCode.Should().NotBe(
                    "nothing_to_dismiss",
                    $"one_code_per_fact:{actionId} declares arguments, so its absence refusal must name its own fact "
                    + "instead of borrowing the no-op's reason");
        }

        noOpAnswers.Should().BeGreaterThan(0, "no argument-free member answered the no-op, so nothing covers the inserted node");
        rows.Where(row => row.ArgumentFree).Should().OnlyContain(row => row.State == ExecutionState.Succeeded);
        rows.Select(row => row.ReasonCode).Distinct(StringComparer.Ordinal).Should().HaveCount(
            rows.Count,
            "one_code_per_fact: two members answering the same absent-precondition code would read as one world fact "
            + "(" + string.Join("; ", rows.Select(row => $"{row.ActionId}={row.ReasonCode}")) + ")");
        // THE RETIRED CODE STILL HAS ONE HOME: `dismiss_modal` no longer refuses on a missing modal, and
        // `answer_dialogue` - a caller that asked to ANSWER a question - still does.
        rows.Single(row => row.ActionId == "dismiss_modal").ReasonCode.Should().Be("nothing_to_dismiss");
        rows.Single(row => row.ActionId == "answer_dialogue").ReasonCode.Should().Be(
            "no_modal_present",
            "retiring the code from dismiss_modal must not delete the fact: a caller that asked to answer a question is "
            + "entitled to hear that no question was there");
    }

    [Fact]
    public void Dismiss_IsRejected_ForAQuestionDialogue()
    {
        RunWithGameState(dialogue: CreateDialogue(isQuestion: true), action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            LocalExecutionReceipt receipt = InvokeDismiss(manager, "req_dismiss_question");
            receipt.ReasonCode.Should().Be("modal_not_dismissible",
                "a question dialogue needs the answer_dialogue seam (design 7.4.2), never a blind closeDialogue");
            receipt.Evidence.Should().Contain("answer_it=answer_dialogue",
                "the refusal names the action that answers the box - refusing without naming it leaves the caller guessing at keys");
        });
    }

    /// <summary>
    /// THE INSERTED DISMISS NEVER CLOSES A SHOP.
    ///
    /// <para>
    /// The compiler writes `dismiss_modal` after a body-yielding step (`body-program-script.ts`
    /// `MODAL_CLEARING_PLAN_ACTION_IDS[0]`), and a dialogue can leave a `ShopMenu` mounted. `ShopMenu` is in the audited
    /// whitelist - its CLOSE path is a pure cancel, which is the criterion that list states - so this handler used to
    /// close it with `Game1.exitActiveMenu()`. That is not a dismissal: `shop_purchase` opens the counter with
    /// `Utility.TryOpenShopMenu` and stops clicking the moment the mounted menu is no longer the exact object it opened
    /// (`farmhandexecutioncontroller.shopactions.cs` `ReferenceEquals(stillOpen, menu)`), and it closes whatever is still
    /// mounted on its way out. A close from here cancels the transaction standing in the counter and reports
    /// `modal_dismissed`, which is the plan's own state reported as a stranger's modal.
    /// </para>
    /// <para>
    /// The refusal IS the remedy: it names the menu kind and the action that owns the counter, and the counter is still
    /// mounted afterwards.
    /// </para>
    /// </summary>
    [Fact]
    public void Dismiss_OfAShop_IsRefused_AndTheCounterStaysMounted()
    {
        ShopMenu shop = CreateShop();
        RunWithGameState(menu: shop, action: () =>
        {
            LocalExecutionReceipt receipt = InvokeDismiss(CreateManager(1001), "req_dismiss_shop");

            receipt.State.Should().Be(ExecutionState.Rejected);
            receipt.ReasonCode.Should().Be("modal_not_dismissible");
            receipt.Evidence.Should().Contain("modal_type=ShopMenu");
            receipt.Evidence.Should().Contain("menu_is_a_shop=true");
            receipt.Evidence.Should().Contain("shop_purchase_opens_its_own=true",
                "the refusal names the action that owns the counter; a refusal that names nothing is a request to retry");
            receipt.Hint.Should().Be("menu_is_a_shop:shop_purchase_opens_its_own",
                "the evidence never reaches the companion for a failed node - the hint is the only field that does");
            ReferenceEquals(Game1.activeClickableMenu, shop).Should().BeTrue(
                "the counter the plan is standing in is still mounted: nothing on this path closed it");
        });
    }

    /// <summary>
    /// GATE, not a test: over EVERY modal kind the engine can present, the family's compiler-writable member either
    /// resolves as a no-op or refuses naming the SAME remedy the pump's own hold names - and no kind is closed by
    /// surprise.
    ///
    /// <para>
    /// The population is the catalog's family crossed with the kinds the live classifier returns, so a fourth modal
    /// action or a new kind of modal joins this gate in the change that introduces it. The property is what the three
    /// faces of this defect have in common: whether a node is stopped at the pump's start gate or at this handler, the
    /// caller must be told which ACTION clears the world - one fact, one spelling. The kinds are read through the
    /// product's own classifier (`WorldModel.MountedModal`) and the remedies through the pump's own gate
    /// (`BodyProgramDispatchGate.HoldOf`), so neither side can drift without this failing by kind.
    /// </para>
    /// <para>
    /// THE PLAIN BOX IS DECIDED HERE AND EXECUTED AT SOURCE. `DialogueBox.closeDialogue` ends by restoring
    /// `Game1.player.CanMove` and clearing its `movementDirections` (`DialogueBox.cs:222-228`) - the native close owns the
    /// actor's release, which is why it is the audited path - so its success terminal cannot be produced in a probe
    /// process that has no player. The pins in this file that read the handler's source cover that close; the row below
    /// covers the ANSWER: which modal the pump allows, and which action it names as the way through.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryModalKind_MeetsANoOpOrANamedRefusal_AndNoShopIsEverClosed()
    {
        (string Kind, Func<(DialogueBox? Dialogue, IClickableMenu? Menu, bool DialogueUp)> Mount, bool Dispatch)[] kinds =
        {
            ("none", static () => (null, null, false), true),
            ("question", static () => (CreateDialogue(isQuestion: true), null, false), true),
            ("plain", static () => (CreateDialogue(isQuestion: false), null, false), false),
            ("shop", static () => (null, CreateShop(), false), true),
        };
        string compilerWritableMember = FarmhandActionCatalog.ModalResolvingActionIds
            .Where(actionId => FarmhandActionCatalog.Registrations.Single(registration => registration.ActionId == actionId).Descriptor!.Arguments.Count == 0)
            .OrderBy(actionId => actionId, StringComparer.Ordinal)
            .First();

        // The action whose body a modal holds: any registered action that is not in the family. Its own hold is the
        // pump's answer for the same screen, and the remedy tokens this handler must agree with come from there.
        string bodyOwningAction = FarmhandActionCatalog.Registrations
            .Select(registration => registration.ActionId)
            .First(actionId => !FarmhandActionCatalog.IsModalResolving(actionId));

        var rows = new List<(string Kind, ExecutionState? State, string ReasonCode, string Evidence, string Hint, bool ShopStillMounted, string? Remedy)>();
        foreach ((string kind, Func<(DialogueBox? Dialogue, IClickableMenu? Menu, bool DialogueUp)> mount, bool dispatch) in kinds)
        {
            (DialogueBox? dialogue, IClickableMenu? menu, bool dialogueUp) = mount();
            BodyProgramHold? hold = BodyProgramDispatchGate.HoldOf(
                bodyOwningAction,
                cutsceneUp: false,
                modal: WorldModel.MountedModal(menu ?? dialogue, dialogueUp),
                actorCanMove: false);
            string? remedy = hold is null ? null : RemedyToken(hold.Value.Evidence);
            if (!dispatch)
            {
                rows.Add((kind, null, string.Empty, string.Empty, string.Empty, false, remedy));
                continue;
            }

            RunWithGameState(dialogue: dialogue, menu: menu, dialogueUp: dialogueUp, action: () =>
            {
                LocalExecutionReceipt receipt = InvokeModalFamily(CreateManager(1001, FarmhandActionCatalog.ModalResolvingActionIds), $"req_kind_{kind}", compilerWritableMember);
                bool mounted = menu is not null && ReferenceEquals(Game1.activeClickableMenu, menu);
                rows.Add((kind, receipt.State, receipt.ReasonCode, receipt.Evidence ?? string.Empty, receipt.Hint ?? string.Empty, mounted, remedy));
            });
        }

        foreach ((string kind, ExecutionState? state, string reasonCode, string evidence, string hint, bool shopStillMounted, string? remedy) in rows)
            this.output.WriteLine($"{kind}: {compilerWritableMember}={state?.ToString() ?? "decided_at_source"}/{reasonCode};remedy={remedy ?? "none"};evidence={evidence};hint={hint}");

        rows.Select(row => row.Kind).Should().BeEquivalentTo(
            new[] { "none", "question", "plain", "shop" },
            "a kind that is not examined is a kind nobody decided");

        foreach ((string kind, ExecutionState? state, string reasonCode, string evidence, string hint, bool shopStillMounted, string? remedy) in rows)
        {
            if (state is null)
            {
                remedy.Should().Be(
                    "dismiss_it=dismiss_modal",
                    "a plain box is closed by dismiss_modal, and that is the only way through: a hold naming anything else would leave the caller stuck on an informational line");
                FarmhandActionCatalog.ModalResolvingActionIds.Should().Contain("dismiss_modal");
                continue;
            }

            state.Value.Should().BeOneOf(
                new[] { ExecutionState.Succeeded, ExecutionState.Rejected },
                $"modal_kind_is_a_failure:{kind}:{state}/{reasonCode} - the world's shape is not an effect the action failed to produce");
            if (kind == "shop")
                shopStillMounted.Should().BeTrue(
                    "a dismissal must never close a counter: shop_purchase opens it and closes it itself, and its click loop "
                    + "stops the moment the mounted menu is not the object it opened");
            if (state == ExecutionState.Succeeded)
            {
                // A no-op and a real dismissal are both successes, and the evidence says which: `modal=none` when nothing
                // was there, `cleared_modal=` when something was closed.
                (evidence.Contains("modal=none", StringComparison.Ordinal) || evidence.Contains("cleared_modal=", StringComparison.Ordinal))
                    .Should().BeTrue($"a success owes the evidence ADR-006 requires, and for {kind} it must say what it did: {evidence}");
                continue;
            }
            remedy.Should().NotBeNull(
                $"the pump reports a hold for a {kind} modal, so the same world cannot leave this handler with no remedy to name");
            (evidence + ";" + hint).Should().Contain(
                remedy!,
                $"one fact one spelling: the pump names '{remedy}' for a {kind} modal, so the refusal must name the same action rather than a second word for it");
        }
    }

    /// <summary>
    /// A question refusal hands the caller the KEYS and the PROMPT, in the field that actually reaches it.
    ///
    /// <para>
    /// Measured 2026-11-09 (`round41`): the Mod's own timeline carried
    /// `modal_not_dismissible ... response_keys=Yes,No;text=今晚要睡了吗？` while the companion received
    /// `{"failureCode":"modal_not_dismissible","actionId":"dismiss_modal"}` - no keys, no question - because the
    /// evidence is withheld for a failed node and no hint was set. It then guessed at `answer_dialogue` four times.
    /// </para>
    /// </summary>
    [Fact]
    public void Dismiss_OfAQuestion_PublishesTheOfferedKeysAndThePrompt()
    {
        DialogueBox question = CreateDialogue(isQuestion: true);
        question.responses = new[] { new Response("Yes", "Yes"), new Response("No", "No") };
        RunWithGameState(dialogue: question, action: () =>
        {
            LocalExecutionReceipt receipt = InvokeDismiss(CreateManager(1001), "req_dismiss_question_keys");

            receipt.ReasonCode.Should().Be("modal_not_dismissible");
            receipt.Evidence.Should().Contain("response_keys=Yes,No");
            receipt.Hint.Should().Be(
                "offered_keys=Yes,No",
                "the hint is the only field a failed node can carry, so the keys the caller must choose from ride it");
        });
    }

    [Fact]
    public void Dismiss_IsRejected_ForAMenuOutsideTheAuditedWhitelist()
    {
        RunWithGameState(menu: new GameMenuStub(), dialogueUp: true, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            InvokeDismiss(manager, "req_dismiss_menu")
                .ReasonCode.Should().Be("modal_not_dismissible",
                    "an unaudited menu type is refused rather than guessed at; only the whitelisted operation menus may be closed");
        });
    }

    [Fact]
    public void Dismiss_WhitelistsOnlyAuditedOperationMenus()
    {
        // The whitelist is a source-audited claim: every member closes through the
        // generic teardown (no exitThisMenu or cleanupBeforeExit override) with its
        // side effects on the commit paths rather than the close path. Narrative
        // modals already applied their effect when they opened, so finishing them is
        // not this action's call, and the world-affecting morning menu (LevelUpMenu)
        // fails the same criterion.
        foreach (string audited in new[] { "ShopMenu", "ItemGrabMenu", "GameMenu", "MineElevatorMenu", "CraftingPage", "ForgeMenu", "MuseumMenu", "TailoringMenu", "ShippingMenu" })
            ExecutionManager.IsDismissibleOperationModalType(audited).Should().BeTrue($"{audited} is an audited operation menu");

        foreach (string refused in new[] { "LetterViewerMenu", "Billboard", "DialogueBox", "SomeFutureMenu", "LevelUpMenu" })
            ExecutionManager.IsDismissibleOperationModalType(refused).Should().BeFalse($"{refused} must not be dismissed blindly");
    }

    /// <summary>
    /// The whitelist's criterion is about the CLOSE path alone, and the two menus a
    /// day rollover can push onto Game1.endOfNightMenus (Game1.cs:9121/:9132) are
    /// pinned against the native source in BOTH directions, so the negative case
    /// cannot be flipped later without a red test:
    ///
    ///  - ShippingMenu closes through the generic teardown. It overrides neither
    ///    exitThisMenu nor cleanupBeforeExit and sets no exit hook, and its only
    ///    click/hotkey action okClicked (ShippingMenu.cs:690-696) sets display flags;
    ///    the day-end save it owns runs in update (:361-428), never on the close path.
    ///    So it belongs in the set.
    ///  - LevelUpMenu must never join it: its close hook cleanupBeforeExit
    ///    (LevelUpMenu.cs:629-635) runs okButtonClicked -> getLevelPerk and
    ///    RemoveLevelFromLevelList, so closing it writes saved state (a level perk)
    ///    and drops the pending level. The profession choice is NOT silently picked
    ///    (it is added only by the in-menu choice, :487/:500), but that does not make
    ///    the close a pure cancel.
    /// </summary>
    [Fact]
    public void MorningMenus_AreDecidedByTheirClosePath_InTheNativeSource()
    {
        string[] shipping = File.ReadAllLines(RepositoryPath(
            "ref", "external", "StardewValleyDecompiled", "Stardew Valley", "StardewValley.Menus", "ShippingMenu.cs"));
        shipping[690 - 1].Should().Contain("private void okClicked()");
        shipping[415 - 1].Should().Contain("saveGameMenu = new SaveGameMenu();");
        shipping[365 - 1].Should().Contain("exitThisMenu(playSound: false);");
        string shippingText = string.Join('\n', shipping);
        shippingText.Should().NotContain(
            "override void exitThisMenu",
            "ShippingMenu leaves the generic close intact, which is the whole reason it is dismissible");
        shippingText.Should().NotContain(
            "override void cleanupBeforeExit",
            "no close hook means the close owns no world write");
        shippingText.Should().NotContain("exitFunction", "the close path carries no deferred side effect");

        string[] levelUp = File.ReadAllLines(RepositoryPath(
            "ref", "external", "StardewValleyDecompiled", "Stardew Valley", "StardewValley.Menus", "LevelUpMenu.cs"));
        levelUp[629 - 1].Should().Contain("protected override void cleanupBeforeExit()");
        levelUp[631 - 1].Should().Contain("if (isActive)");
        levelUp[633 - 1].Should().Contain("okButtonClicked();");
        levelUp[639 - 1].Should().Contain("getLevelPerk(currentSkill, currentLevel);");
        levelUp[640 - 1].Should().Contain("RemoveLevelFromLevelList();");
        levelUp[645 - 1].Should().Contain("public virtual void RemoveLevelFromLevelList()");
        levelUp[487 - 1].Should().Contain("Game1.player.professions.Add(professionsToChoose[0]);");

        ExecutionManager.IsDismissibleOperationModalType("ShippingMenu").Should().BeTrue("its close path is a pure cancel");
        ExecutionManager.IsDismissibleOperationModalType("LevelUpMenu").Should().BeFalse(
            "its close writes saved state, so a dismiss channel would be a silent world change");
    }

    [Fact]
    public void Dismiss_FailsClosed_WithAnAbsentActor()
    {
        RunWithGameState(dialogue: CreateDialogue(isQuestion: false), action: () =>
        {
            ExecutionManager manager = CreateManager(actorId: null);
            manager.SetTestActorResolver(() => null);

            InvokeDismiss(manager, "req_dismiss_absent")
                // Same as the answer path: admission owns identity, and its code names the state.
                .ReasonCode.Should().Be("world_not_ready",
                    "admission resolves the bound actor and names that state; the handler no longer hardcodes player_not_actionable for identity failures");
        });
    }

    /// <summary>
    /// A FormatterServices dialogue: only `isQuestion` matters to the body, and
    /// closeDialogue's only game read is Game1.activeClickableMenu.Equals(this)
    /// (true for the seeded identity), then Game1.exitActiveMenu() which just
    /// nulls the menu — safe headless.
    /// </summary>
    private static DialogueBox CreateDialogue(bool isQuestion)
    {
        DialogueBox dialogue = (DialogueBox)FormatterServices.GetUninitializedObject(typeof(DialogueBox));
        dialogue.isQuestion = isQuestion;
        return dialogue;
    }

    /// <summary>
    /// A FormatterServices shop counter. The one member the close path reads on the menu itself is `readyToClose`, which
    /// reads `heldItem` (null here) and `animations` (`ShopMenu.cs:1255`); the empty list is what makes the PRE-fix path
    /// runnable headless, so the reading it produces is "this channel closed the counter" rather than an exception about a
    /// field a probe never set.
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
    /// The action a hold names as its remedy, in the field the hold uses for it - or null when the hold names none (a
    /// cutscene, a transient body lock, an unaudited menu).
    /// </summary>
    private static string? RemedyToken(string evidence)
    {
        foreach (string field in evidence.Split(';'))
        {
            int equals = field.IndexOf('=', StringComparison.Ordinal);
            if (equals < 0) continue;
            string key = field[..equals];
            string value = field[(equals + 1)..];
            if (key is "answer_it" or "dismiss_it") return key + "=" + value;
            if (key == "shop_purchase_opens_its_own") return key;
        }
        return null;
    }

    private static LocalExecutionReceipt InvokeDismiss(ExecutionManager manager, string requestId) =>
        InvokeModalFamily(manager, requestId, "dismiss_modal");

    /// <summary>
    /// One dispatch through the REAL modal handler, so the family gate exercises the same switch a routed request
    /// reaches instead of a second copy of the action-to-handler mapping.
    /// </summary>
    private static LocalExecutionReceipt InvokeModalFamily(ExecutionManager manager, string requestId, string actionId)
    {
        var request = new BridgeExecutionRequest(
            requestId,
            $"{requestId}_idem",
            actionId,
            new BridgeExecutionArgs(),
            1,
            // A LIVE deadline: the modal family now validates it through the shared admission, and an
            // expired one is refused with `invalid_deadline` instead of being executed. Epoch-zero + 5s is in
            // 1970, which is what these tests used to pass because the handlers ignored the field.
            DateTimeOffset.UtcNow.AddSeconds(5).ToUnixTimeMilliseconds());
        return new ModalActionHandler(manager).Execute(request, manager);
    }

    private static ExecutionManager CreateManager(long? actorId, IReadOnlySet<string>? enabledActions = null)
    {
        var scope = new BridgeScope("stardew", "save_probe", "world_probe", ScopePlayerId, "companion_probe");
        var publication = FarmhandCapabilityPublication.Initial(
            enabledActions ?? new HashSet<string>(StringComparer.Ordinal) { "dismiss_modal" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionScope: null);

        if (actorId is not null)
            executions.SetTestActorResolver(() => CreateActor(actorId.Value));
        return executions;
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
        // Character.currentLocation getter dereferences currentLocationRef; a
        // bare NetLocationRef keeps the trace publisher (AddPublicTrace) from
        // NRE-ing headless, exactly like the admission probe fixtures.
        typeof(Farmer)
            .GetField("currentLocationRef", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLocationRef());
        return actor;
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
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

    private static string ReadRepositoryText(params string[] parts) => File.ReadAllText(RepositoryPath(parts));

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

    /// <summary>
    /// A FormatterServices shipping menu. Every field the commit path itself touches is a plain value set by
    /// <c>okClicked</c> (`outro`, `outroFadeTimer`), and the handler's own precondition (<c>readyToClose</c>) is the
    /// base implementation, so an unset graph is enough to observe the commit being entered twice.
    /// </summary>
    private static ShippingMenu CreateShipping() =>
        (ShippingMenu)FormatterServices.GetUninitializedObject(typeof(ShippingMenu));

    /// <summary>The engine field a claim in this file rests on, read where the engine keeps it.</summary>
    private static object? ReadPrivate(object instance, string field) =>
        instance.GetType().GetField(field, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(instance);

    private static void RunWithGameState(DialogueBox? dialogue = null, IClickableMenu? menu = null, bool dialogueUp = false, Action action = null!)
    {
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool dialogueUpBefore = Game1.dialogueUp;
        int timeOfDayBefore = Game1.timeOfDay;
        // `Game1.exitActiveMenu` assigns through the `activeClickableMenu` SETTER, which drains `nextClickableMenu` after
        // it has already cleared the menu - and that queue is null in a probe process, so a native close throws with the
        // menu already gone. An empty queue is what lets a close complete here, which is what makes "the counter was
        // closed" an observable reading instead of an exception about a field no test set.
        List<IClickableMenu>? nextMenusBefore = Game1.nextClickableMenu;
        Game1? gameBefore = Game1.game1;
        GameLocation? locationBefore = gameBefore?.instanceGameLocation;
        ISoundsHelper? soundsBefore = Game1.sounds;
        Queue<string>? objectDialogueBefore = Game1.currentObjectDialogue;
        List<Response>? questionChoicesBefore = Game1.questionChoices;
        Game1.afterFadeFunction? afterDialoguesBefore = Game1.afterDialogues;
        try
        {
            // The setter reads `Game1.game1` for the text-entry handle, and that instance is null in a probe process.
            if (Game1.game1 is null) Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            Game1.nextClickableMenu = new List<IClickableMenu>();
            // `ShippingMenu.okClicked` changes the music track (ShippingMenu.cs:695), and `Game1.changeMusicTrack`
            // dereferences the current location (:920) - so the commit needs a location and a sound device that is
            // not a real one.
            Game1.game1.instanceGameLocation ??= new GameLocation();
            Game1.sounds = new SilentSoundsHelper();
            menuField.SetValue(null, (object?)dialogue ?? menu);
            Game1.dialogueUp = dialogueUp;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.dialogueUp = dialogueUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
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

    /// <summary>
    /// A sound device that plays nothing, so a native path that plays a cue can run in a probe process
    /// (`Game1.playSound` -> `Game1.sounds`, Game1.cs:3179-3183).
    /// </summary>
    private sealed class SilentSoundsHelper : SoundsHelper
    {
        public override bool PlayLocal(string cueName, GameLocation location, Microsoft.Xna.Framework.Vector2? position, int? pitch, SoundContext context, out ICue cue)
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
