using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley.Network;
using StardewValley;
using StardewValley.Menus;
using Xunit;

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
public sealed class ModalDismissActionTests
{
    private const string ScopePlayerId = "1001";

    // ---- success -------------------------------------------------------------

    /// <summary>
    /// The receipt of a clearance NAMES the clearance, in both terminals of the call that performed the native
    /// close: the succeeded outcome and the postcondition failure. The two differ only in the world outcome they
    /// report, so a reader can tell "the box is gone" apart from "the close ran and the world was still not
    /// clean" without inferring it from `dismissed` alone. It also states what the close ITSELF changed, because
    /// the honest answer differs by type: a whitelisted operation menu is a pure cancel, while closeDialogue
    /// advances native dialogue state (DialogueBox.cs:198-216, :243-248). A blanket "no side effects" flag would
    /// be false for exactly the case this action exists for.
    ///
    /// A source probe, like the sibling native-seam pins: the success terminal cannot be produced headless,
    /// because closeDialogue restores Farmer.CanMove through Game1.player (DialogueBox.cs:226) and a probe
    /// process has no live player. The live claim belongs to the native-local modal chain gate.
    /// </summary>
    [Fact]
    public void Dismiss_Receipt_NamesTheModalItCleared_InBothTerminals()
    {
        string code = StripLineComments(ReadRepositoryText("integrations", "stardew", "farmhandexecutioncontroller.modalactions.cs"));

        code.Should().Contain(
            "modal_type={modalType};dismissed=true;cleared_modal={modalType};close_effect={closeEffect}",
            "the succeeded receipt must state the clearance next to the modal it dismissed");
        code.Should().Contain(
            "dialogue_up={Game1.dialogueUp};cleared_modal={modalType};close_effect={closeEffect}",
            "the postcondition-failed receipt performed the same native close, so it must state it too");
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

    // ---- rejections ----------------------------------------------------------

    [Fact]
    public void Dismiss_IsRejected_WhenNoModalIsPresent()
    {
        RunWithGameState(dialogue: null, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            InvokeDismiss(manager, "req_dismiss_none")
                .ReasonCode.Should().Be("no_modal_present");
        });
    }

    [Fact]
    public void Dismiss_IsRejected_ForAQuestionDialogue()
    {
        RunWithGameState(dialogue: CreateDialogue(isQuestion: true), action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            InvokeDismiss(manager, "req_dismiss_question")
                .ReasonCode.Should().Be("modal_not_dismissible",
                    "a question dialogue needs the answer_dialogue seam (design 7.4.2), never a blind closeDialogue");
        });
    }

    [Fact]
    public void Dismiss_IsRejected_WhileAnEventHoldsTheActor()
    {
        RunWithGameState(dialogue: CreateDialogue(isQuestion: false), eventUp: true, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            InvokeDismiss(manager, "req_dismiss_event")
                // An absorbed cutscene outranks the modal (WIA 4.1/4.2) - and the code now says WHICH hold
                // that is. The Agent needs the distinction: a cutscene cannot be dismissed by any tool,
                // while a mounted dialogue can.
                .ReasonCode.Should().Be("cutscene_active");
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
        // generic exitActiveMenu (no exitThisMenu override) with its side effects on
        // the commit paths rather than the close path. Narrative modals already
        // applied their effect when they opened, so finishing them is not this
        // action's call.
        foreach (string audited in new[] { "ShopMenu", "ItemGrabMenu", "GameMenu", "MineElevatorMenu", "CraftingPage", "ForgeMenu", "MuseumMenu", "TailoringMenu" })
            ExecutionManager.IsDismissibleOperationModalType(audited).Should().BeTrue($"{audited} is an audited operation menu");

        foreach (string narrative in new[] { "LetterViewerMenu", "Billboard", "DialogueBox", "SomeFutureMenu" })
            ExecutionManager.IsDismissibleOperationModalType(narrative).Should().BeFalse($"{narrative} must not be dismissed blindly");
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

    private static LocalExecutionReceipt InvokeDismiss(ExecutionManager manager, string requestId)
    {
        var request = new BridgeExecutionRequest(
            requestId,
            $"{requestId}_idem",
            "dismiss_modal",
            new BridgeExecutionArgs(),
            1,
            // A LIVE deadline: the modal family now validates it through the shared admission, and an
            // expired one is refused with `invalid_deadline` instead of being executed. Epoch-zero + 5s is in
            // 1970, which is what these tests used to pass because the handlers ignored the field.
            DateTimeOffset.UtcNow.AddSeconds(5).ToUnixTimeMilliseconds());
        return manager.RequestLocalDismissModal(request, manager);
    }

    private static ExecutionManager CreateManager(long? actorId)
    {
        var scope = new BridgeScope("stardew", "save_probe", "world_probe", ScopePlayerId, "companion_probe");
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "dismiss_modal" });
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

    private static void RunWithGameState(DialogueBox? dialogue = null, IClickableMenu? menu = null, bool dialogueUp = false, bool eventUp = false, Action action = null!)
    {
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool dialogueUpBefore = Game1.dialogueUp;
        bool eventUpBefore = Game1.eventUp;
        int timeOfDayBefore = Game1.timeOfDay;
        try
        {
            menuField.SetValue(null, (object?)dialogue ?? menu);
            Game1.dialogueUp = dialogueUp;
            Game1.eventUp = eventUp;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.dialogueUp = dialogueUpBefore;
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
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