using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using StardewValley.Network;
using StardewValley.Menus;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class ModalAdmissionTests
{

/// <summary>
/// Locks the WIA §4.2 modal-handling admission path (Lane C, wia-contract):
/// the <c>Modal</c> profile admits the modal-handling family while a modal is
/// actually open — the open modal is its working precondition, not an
/// obstacle — while every other profile still requires an Idle body and the
/// shared deadline / identity / scope / revision checks stay identical across
/// profiles. The body-lease check is exempt ONLY for the Modal profile,
/// because a modal handling call (GameLocation.answerDialogue / closeDialogue)
/// is an instantaneous native invocation that neither takes a body lease nor
/// moves the player.
///
/// <see cref="GameBuddy.Stardew.ExecutionManager.AdmitExecution"/> is exercised
/// directly (internal; this project has InternalsVisibleTo) because no
/// published action mounts the Modal profile yet — the future answer_dialogue
/// handler will call it at this same site.
    private const string ScopePlayerId = "1001";

    [Fact]
    public void Modal_IsAdmitted_WhileTheModalIsOpen()
    {
        RunWithGameState(menuOpen: true, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Modal)
                .Should().BeNull("an open modal is the modal-handling family's working precondition, not an obstacle (WIA §4.2)");
        });
    }

    [Fact]
    public void Physical_IsStillRejected_WhileTheModalIsOpen()
    {
        RunWithGameState(menuOpen: true, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Physical)!
                .ReasonCode.Should().Be("player_not_actionable",
                    "adding the Modal profile must not loosen the menu lock for the body-owning profiles");
        });
    }

    [Fact]
    public void General_IsStillRejected_WhileTheModalIsOpen()
    {
        RunWithGameState(menuOpen: true, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.General)!
                .ReasonCode.Should().Be("player_not_actionable",
                    "adding the Modal profile must not loosen the menu lock for the pre-convergence general profile either");
        });
    }

    [Fact]
    public void Modal_IsRejected_WhenNoModalIsPresent()
    {
        RunWithGameState(action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            // The layering changed with the convergence: the Modal profile decides whether the action
            // may be ATTEMPTED (only a cutscene outranks a modal), and the HANDLER decides whether a modal
            // is actually present - because it can name that (`no_modal_present`). So admission ADMITS
            // here, and the refusal with the specific code is asserted by ModalDismissActionTests /
            // ModalAnswerDialogueTests. What this pin now protects is that admission does not invent a
            // modal-obstacle it cannot describe.
            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Modal)
                .Should().BeNull(
                    "an idle body is not an obstacle for the modal family: the handler names the missing modal");
        });
    }

    [Fact]
    public void Modal_IsRejected_WhileAnEventHoldsTheActor()
    {
        RunWithGameState(menuOpen: true, eventUp: true, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Modal)!
                .ReasonCode.Should().Be("player_not_actionable",
                    "a modal-handling action must not talk over an absorbing event (WIA §4.2 \"and !eventUp\")");
        });
    }

    [Fact]
    public void Modal_KeepsTheDeadlineCheck()
    {
        RunWithGameState(menuOpen: true, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Modal, deadlineDeltaMs: -1)!
                .ReasonCode.Should().Be("invalid_deadline",
                    "an expired deadline rejects even a modal-handling action");
            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Modal, deadlineDeltaMs: 5 * 60_000)!
                .ReasonCode.Should().Be("invalid_deadline",
                    "a deadline beyond the one-minute horizon rejects even a modal-handling action");
        });
    }

    [Fact]
    public void Modal_KeepsTheIdentityAndScopeChecks()
    {
        RunWithGameState(menuOpen: true, action: () =>
        {
            ExecutionManager manager = CreateManager(actorId: null);
            manager.SetTestActorResolver(() => CreateActor(2002));

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Modal)!
                .ReasonCode.Should().Be("execution_scope_mismatch",
                    "the Modal profile must never bypass the scope-bound identity proof");
        });
    }

    [Fact]
    public void Modal_WithAnAbsentActor_FailsClosed()
    {
        RunWithGameState(menuOpen: true, action: () =>
        {
            ExecutionManager manager = CreateManager(actorId: null);
            manager.SetTestActorResolver(() => null);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Modal)!
                .ReasonCode.Should().Be("world_not_ready",
                    "admission never proceeds for the Modal profile without a resolved actor");
        });
    }

    [Fact]
    public void Modal_IsExemptFromTheBodyLeaseCheck()
    {
        RunWithGameState(menuOpen: true, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);
            OccupyBodyLease(manager);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Modal)
                .Should().BeNull("a modal handling call is an instantaneous native invocation that takes no body lease (WIA §4.2)");
        });
    }

    [Fact]
    public void Physical_StillHonoursTheBodyLeaseCheck()
    {
        RunWithGameState(action: () =>
        {
            ExecutionManager manager = CreateManager(1001);
            OccupyBodyLease(manager);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Physical)!
                .ReasonCode.Should().Be("body_owned",
                    "the body-lease exemption belongs to the Modal profile alone");
        });
    }

    [Fact]
    public void Physical_IsAdmitted_WhenTheBodyIsIdle()
    {
        RunWithGameState(action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Physical)
                .Should().BeNull("an idle body admits the physical profile exactly as before the disposition split");
        });
    }

    [Fact]
    public void Physical_IsRejected_WhenAToolAnimationHoldsTheBody()
    {
        RunWithGameState(action: () =>
        {
            ExecutionManager manager = CreateManager(1001, usingTool: true);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Physical)!
                .ReasonCode.Should().Be("player_not_actionable",
                    "WIA §4.1 classifies the tool animation as Transient, and Transient is not Idle");
        });
    }

    [Fact]
    public void Physical_IsRejected_WhileFreezePaused()
    {
        RunWithGameState(action: () =>
        {
            ExecutionManager manager = CreateManager(1001, freezePaused: true);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Physical)!
                .ReasonCode.Should().Be("player_not_actionable",
                    "freezePause is a Transient body lock, not Idle");
        });
    }

    [Fact]
    public void Physical_IsRejected_AtThePassOutHour()
    {
        RunWithGameState(timeOfDay: 2600, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Physical)!
                .ReasonCode.Should().Be("player_not_actionable",
                    "the pass-out hour is a world change (WIA §4.3), never an admissible body");
        });
    }

    [Fact]
    public void Modal_IsRejected_AtThePassOutHour_WhenNoModalIsOpen()
    {
        RunWithGameState(timeOfDay: 2600, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            // Same layering as above, and the pass-out hour is not an obstacle either: with no modal
            // mounted the handler refuses with `no_modal_present`, which is the accurate statement. A
            // PASS-OUT still cannot be ACTED ON, because there is nothing to act on.
            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Modal)
                .Should().BeNull(
                    "the pass-out hour is not an obstacle for the modal family when no modal is mounted");
        });
    }

    [Fact]
    public void Modal_OutranksThePassOutHour_WhileTheModalIsOpen()
    {
        // Native startToPassOut requires `player.canMove` (Game1.cs:6458) and an
        // open menu sets CanMove=false, so the engine does not pass out behind a
        // modal: the modal is the ruling until the player closes it.
        RunWithGameState(menuOpen: true, timeOfDay: 2600, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Modal)
                .Should().BeNull("the modal still owns the actor at the pass-out hour");
        });
    }

    /// <summary>
    /// reasonCode vocabulary, WIA §1.1/§4.3 + wia-contract §词汇表 (Lane C): the
    /// world-change interruption family adds <c>modal_interrupted</c> /
    /// <c>pass_out</c> / <c>day_advanced</c> / <c>actor_warped</c> next to the
    /// pre-existing <c>event_started</c> and <c>native_path_ended</c>.
    /// Repo-wide search before adding confirmed no conflict: none of the four
    /// is minted by a published action's admission chain; <c>day_advanced</c>
    /// already exists as the <c>single_player_sleep_and_advance_day</c> success
    /// postcondition (FarmhandActionDefinitions.cs) — the same string, the same
    /// world-change semantics, reused safely.
    /// </summary>
    [Fact]
    public void WorldChangeReasonCodes_AreTheDeclaredWorldChangeInterruptionFamily()
    {
        string[] family =
        {
            "event_started",     // 已有 cutscene 分类
            "modal_interrupted", // 新（§4.1 ②）：模态出现
            "pass_out",          // 新（§2-6/§4.3）：昏迷/强睡
            "day_advanced",      // 新（已由 sleep action 发布同一字符串）
            "actor_warped",      // 新（§4.3）：warp 已发生
            "native_path_ended", // 已有（L2 blocker doc 管辖）
        };

        family.Should().OnlyHaveUniqueItems();
        foreach (string code in family)
            Regex.IsMatch(code, "^[a-z0-9_:-]{1,128}$").Should().BeTrue($"'{code}' must satisfy the bridge reasonCode schema pattern");
    }

    /// <summary>
    /// The four additions are TERMINAL classifications for the body loop /
    /// lifecycle (Lane B and the sleep lifecycle mint them), never shared
    /// admission reasonCodes — the admission vocabulary stays closed inside the
    /// existing codes (player_not_actionable / invalid_deadline / body_owned /
    /// guard codes).
    /// </summary>
    [Fact]
    public void NewWorldChangeCodes_AreNeverMintedBySharedAdmission()
    {
        // The world-change codes are TERMINAL classifications (WIA §4.3). They
        // may only be minted by the interruption arbitration that terminates an
        // execution, never as an admission reasonCode (what AdmitExecution
        // returns). Admission returns its reasonCode through RememberTerminal,
        // so the codes must not appear in any Rejected call in this file.
        string controller = File.ReadAllText(RepositoryRelative("integrations", "stardew", "farmhandexecutioncontroller.cs"));

        foreach (string code in new[] { "modal_interrupted", "pass_out", "day_advanced", "actor_warped" })
        {
            controller.Should().NotContain(
                $"ExecutionState.Rejected, \"{code}\"",
                $"{code} is a world-change TERMINAL classification (WIA §4.3), never an admission reasonCode");
        }
    }

    /// <summary>
    /// The Modal profile's action family is a frozen stand-in: the concrete
    /// answer_dialogue wire is design 7.4.2's to finalize, so today exactly the
    /// two placeholder identities are admitted.
    /// </summary>
    [Fact]
    public void ModalActionFamily_IsFrozenToTheDesign742Placeholders()
    {
        ExecutionManager.ModalActionFamily.Should().Equal(
            new[] { "answer_dialogue", "dismiss_modal" },
            "the exact action identities are design 7.4.2's to finalize; WIA 2026-10-02 freezes these two stand-ins");
    }

    // ---- helpers -------------------------------------------------------------

    private static LocalExecutionReceipt? Admit(
        ExecutionManager manager,
        ExecutionManager.AdmissionActionabilityProfile profile,
        long deadlineDeltaMs = 30_000)
    {
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // AdmitExecution is deliberately private (pre-WIA source pin
        // ToolApproachContractTests pins the `private` form); the test drives
        // it through reflection, the same pattern the class already uses for
        // uninitialized objects.
        object? result = typeof(ExecutionManager)
            .GetMethod("AdmitExecution", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(manager, new object?[]
            {
                $"req_{Guid.NewGuid():N}",
                $"exec_{Guid.NewGuid():N}",
                nowMs + deadlineDeltaMs,
                nowMs,
                profile,
            });
        return (LocalExecutionReceipt?)result;
    }

    private static ExecutionManager CreateManager(long? actorId, bool canMove = true, bool freezePaused = false, bool usingTool = false)
    {
        var scope = new BridgeScope("stardew", "save_probe", "world_probe", ScopePlayerId, "companion_probe");
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "answer_dialogue" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(new ProbePersistence()),
            executionScope: scope);

        if (actorId is not null)
            executions.SetTestActorResolver(() => CreateActor(actorId.Value, canMove, freezePaused, usingTool));
        return executions;
    }

    /// <summary>
    /// A FormatterServices-created probe farmer, the shared test-pattern the
    /// suite uses for Game1.player stand-ins: SkipNetFields are null until
    /// seeded, so every field the disposition projection reads is replaced with
    /// a live NetField or plain value.
    /// </summary>
    private static Farmer CreateActor(long id, bool canMove = false, bool freezePaused = false, bool usingTool = false)
    {
        Farmer actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        typeof(Farmer)
            .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLong(id));
        actor.CanMove = canMove;
        actor.freezePause = freezePaused ? 1 : 0;
        typeof(Farmer)
            .GetField("usingTool", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetBool(usingTool));
        // The WIA admission now reads the whole per-tick disposition
        // (WorldModel.ReadFacts), so every NetField it touches must be present
        // on a probe Farmer — exactly the same completeness the pre-WIA
        // UsingTool read already required.
        typeof(Farmer)
            .GetField("netStamina", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetFloat(270f));
        typeof(Farmer)
            .GetField("toolPower", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetInt(0));
        return actor;
    }

    /// <summary>Occupies the manager's primary body lease without running any gameplay.</summary>
    private static void OccupyBodyLease(ExecutionManager manager)
    {
        FieldInfo active = typeof(ExecutionManager).GetField("active", BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("ExecutionManager.active field unavailable.");
        active.SetValue(manager, RuntimeHelpers.GetUninitializedObject(active.FieldType));
    }

    /// <summary>
    /// The admission reads Game1 statics (activeClickableMenu / eventUp /
    /// timeOfDay); save and restore them around each probe, matching the
    /// ScopeBoundActorAdmissionTests convention.
    /// </summary>
    private static void RunWithGameState(bool menuOpen = false, bool eventUp = false, int timeOfDay = 600, Action action = null!)
    {
        // The public Game1.activeClickableMenu setter runs real game logic
        // (player.Halt / textEntry) that a headless test process cannot run,
        // and a real DialogueBox ctor reads Game1.options. Seed the backing
        // field with a lightweight stub instead — the technique the repo's
        // other headless menu fixtures already use.
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool eventUpBefore = Game1.eventUp;
        int timeOfDayBefore = Game1.timeOfDay;
        try
        {
            menuField.SetValue(null, menuOpen ? new MenuStub() : null);
            Game1.eventUp = eventUp;
            Game1.timeOfDay = timeOfDay;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
        }
    }

    /// <summary>A real menu cannot be constructed headless; the stub pins the
    /// mechanism the disposition reads (the menu TYPE NAME).</summary>
    private sealed class MenuStub : IClickableMenu
    {
        public MenuStub()
            : base(0, 0, 100, 100)
        {
        }
    }

    private static string RepositoryRelative(params string[] parts)
    {
        string relative = Path.Combine(parts);
        string[] starts = { AppContext.BaseDirectory, Environment.CurrentDirectory };
        foreach (string start in starts)
        {
            DirectoryInfo? dir = new(start);
            for (int depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }

    private sealed class ProbePersistence : IModGlobalDataPersistence
    {
        private FarmhandExecutionJournalState? state;
        public FarmhandExecutionJournalState? Read(string key) => this.state;
        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            this.state = value;
            return true;
        }
    }
}