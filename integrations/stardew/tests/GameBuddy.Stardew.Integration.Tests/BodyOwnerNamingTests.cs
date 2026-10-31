using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Pins the named body-owner vocabulary behind every body-exclusivity refusal. A second execution that bounces off
/// a busy body must say WHICH in-flight execution holds it and whether it is interruptible, so the Agent can
/// recover (wait, or re-issue a directive that supersedes a local move) instead of reading a bare <c>body_owned</c>.
///
/// One case per named code, plus the multi-owner precedence that names the first table entry and lists the rest in
/// <c>also_owned</c>. The occupants are seeded onto the manager's private slots through reflection — the same
/// technique <see cref="ModalAdmissionTests"/> uses for <c>active</c> — because those slots are otherwise only
/// populated by live gameplay. The refusal is read from the shared admission path, which is the single guard that
/// covers the whole ownership set.
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class BodyOwnerNamingTests
{
    private const string ScopePlayerId = "1001";
    private const long DeadlineMs = 1_700_000_000_000;

    [Fact]
    public void NavigationOwner_IsNamed()
    {
        // The slot is seeded with an UNINITIALIZED spec, and an uninitialized enum field is its first member -
        // `LocalNavigatePhase.Approaching` (ExecutionModels.cs:309) - so this is the WALKING phase: releasable.
        LocalExecutionReceipt receipt = Refuse(("activeNavigate", null));

        receipt.ReasonCode.Should().Be("body_owned_by_navigation");
        receipt.Evidence.Should().Be(
            "owner_execution_id=unknown;owner_action=navigate_to_destination;interruptible=false;phase=approaching;cancel_safe=true");
    }

    [Fact]
    public void NavigationOwner_PastItsApproach_IsNotCancellable()
    {
        // THE BOUNDARY, and the reason cancel safety is a PHASE rather than an action property: once the walk is
        // released the action is committed, so its only exit is the terminal receipt.
        LocalExecutionReceipt receipt = Refuse(("activeNavigate", new LocalNavigateSpec(
            "exec_nav", "req_nav", default!, "Farm:64,15", "Farm", default!, new Vector2(64f, 15f), DeadlineMs, LocalNavigatePhase.ApproachReleased)));

        receipt.ReasonCode.Should().Be("body_owned_by_navigation");
        receipt.Evidence.Should().Be(
            "owner_execution_id=exec_nav;owner_action=navigate_to_destination;interruptible=false;phase=committed;cancel_safe=false");
    }

    [Fact]
    public void TravelOwner_IsNamed()
    {
        LocalExecutionReceipt receipt = Refuse(("activeTravel", new LocalTravelSpec(
            "exec_travel", "req_travel", "enter_exit", "Farm", 3, 9, "FarmHouse", 5, 5, 1, DeadlineMs)));

        receipt.ReasonCode.Should().Be("body_owned_by_travel");
        receipt.Evidence.Should().Be("owner_execution_id=exec_travel;owner_action=enter_exit;interruptible=false;phase=committed;cancel_safe=false");
    }

    [Fact]
    public void MovementOwner_IsNamedAndInterruptible()
    {
        LocalExecutionReceipt receipt = Refuse(("active", new LocalMoveSpec(
            "exec_move", "req_move", new Vector2(3f, 9f), AllowAdjacentArrival: false, RouteRevision: 1, DeadlineTick: 100, DeadlineMs: DeadlineMs)));

        receipt.ReasonCode.Should().Be("body_owned_by_movement");
        // The local move is the one owner a newer directive supersedes, so the Agent is told it may re-issue.
        receipt.Evidence.Should().Be("owner_execution_id=exec_move;owner_action=move_to_tile;interruptible=true;phase=approaching;cancel_safe=true");
    }

    [Fact]
    public void ApproachOwner_IsNamed()
    {
        LocalExecutionReceipt receipt = Refuse(("activeToolApproach", new LocalApproachSpec(
            "exec_approach", "req_approach", "water_crop", "Farm", 3, 9, "target_1", (_, _) => null!, RouteRevision: 1, DeadlineMs: DeadlineMs)));

        receipt.ReasonCode.Should().Be("body_owned_by_approach");
        receipt.Evidence.Should().Be("owner_execution_id=exec_approach;owner_action=water_crop;interruptible=false;phase=approaching;cancel_safe=true");
    }

    [Fact]
    public void RideOwner_IsNamed()
    {
        LocalExecutionReceipt receipt = Refuse(("activeMountTransport", new LocalMountTransportSpec(
            "exec_ride", "req_ride", "Farm", 3, 9, "horse_1", Guid.NewGuid(), DeadlineMs)));

        receipt.ReasonCode.Should().Be("body_owned_by_ride");
        receipt.Evidence.Should().Be("owner_execution_id=exec_ride;owner_action=mount_transport;interruptible=false;phase=committed;cancel_safe=false");
    }

    [Fact]
    public void DayAdvanceOwner_IsNamed()
    {
        // ActiveDayAdvance is manager-private, so the slot is seeded uninitialized and only the KIND is knowable.
        LocalExecutionReceipt receipt = Refuse(("activeDayAdvance", null));

        receipt.ReasonCode.Should().Be("body_owned_by_day_advance");
        receipt.Evidence.Should().Be("owner_execution_id=unknown;owner_action=advance_day;interruptible=false;phase=committed;cancel_safe=false");
    }

    [Fact]
    public void DayAdvanceOwner_IsApproachableWhileTheNightWaitsToBegin()
    {
        // The night does not own the body until it can start. Measured 2026-10-20 (run 01-44-58): an outdoor
        // `advance_day` claimed the body as committed and uninterruptible, the lifecycle then reported `not_home`,
        // and the `enter_exit` that would have walked the actor home was refused as body_owned_by_day_advance - so
        // nothing could make progress until the engine passed the farmer out at 2:00 AM. While the lifecycle is
        // still AwaitingEligibility the hold is a walk-up the companion may interrupt; the falsifier is the test
        // above, which pins that an UNKNOWN lifecycle stays committed (releasing the body on a guess would be worse
        // than the deadlock it fixes).
        // A REAL lifecycle, started the way the controller starts one, so the phase under test is the phase the game
        // produces rather than a fabricated one.
        SleepAndAdvanceDayLifecycle lifecycle = SleepAndAdvanceDayLifecycle.TryStart(new DummyMonitor(), new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = string.Empty,
            MinimumOnlineFarmers = 1,
            TimeoutSeconds = 540,
            ReadyBarrierFrameBudget = 18000,
        })!;
        // `ActiveDayAdvance` is private, so it is built the way this file already builds private slots: an
        // uninitialised instance of the real nested type, with its Lifecycle backing field pointed at the real
        // lifecycle above.
        Type advanceType = typeof(ExecutionManager).GetNestedType("ActiveDayAdvance", BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("ExecutionManager.ActiveDayAdvance unavailable.");
        object advance = RuntimeHelpers.GetUninitializedObject(advanceType);
        advanceType.GetField("<Lifecycle>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(advance, lifecycle);
        LocalExecutionReceipt receipt = Refuse(("activeDayAdvance", advance));

        receipt.ReasonCode.Should().Be("body_owned_by_day_advance");
        receipt.Evidence.Should().Contain("interruptible=true").And.Contain("phase=approaching").And.Contain("cancel_safe=true");
    }

    [Fact]
    public void ActivityOwner_IsNamed()
    {
        LocalExecutionReceipt receipt = Refuse(("activePet", new LocalPettingSpec(
            "exec_pet", "req_pet", "Farm", 3, 9, "pet_1", "pet_identity", 0, 1, 1, 1, DeadlineMs)));

        receipt.ReasonCode.Should().Be("body_owned_by_activity");
        receipt.Evidence.Should().Be("owner_execution_id=exec_pet;owner_action=pet_animal;interruptible=false;phase=committed;cancel_safe=false");
    }

    [Fact]
    public void MultipleOwners_NameTheFirstInTableOrder_AndListTheRest()
    {
        // Travel outranks the activity family in the frozen table, so the code names travel and the pet is reported
        // as an additional owner rather than being silently dropped.
        LocalExecutionReceipt receipt = Refuse(
            ("activeTravel", new LocalTravelSpec("exec_travel", "req_travel", "enter_exit", "Farm", 3, 9, "FarmHouse", 5, 5, 1, DeadlineMs)),
            ("activePet", new LocalPettingSpec("exec_pet", "req_pet", "Farm", 3, 9, "pet_1", "pet_identity", 0, 1, 1, 1, DeadlineMs)));

        receipt.ReasonCode.Should().Be("body_owned_by_travel");
        receipt.Evidence.Should().Be("owner_execution_id=exec_travel;owner_action=enter_exit;interruptible=false;phase=committed;cancel_safe=false;also_owned=body_owned_by_activity");
    }

    [Fact]
    public void Snapshot_OccupantProjection_ReadsTheSameOwnerTable()
    {
        // CreateBridgeSnapshot needs a live Game1.player, so the observation seam is pinned at the source the way the
        // approach suite pins its own: the occupant fields come from the single describer - now through the shared
        // projection the events read too - and the world-not-ready construction keeps ActiveExecution null.
        string source = Read("integrations/stardew/farmhandexecutioncontroller.cs");
        string body = MethodBody(source, "public BridgeActiveExecution? DescribeActiveExecution(");
        body.Should().Contain("this.DescribeBodyOwner()",
            "the projection must not re-derive ownership; it reads the same table the refusals do");
        body.Should().Contain("OwnerKind = owner.ReasonCode");
        body.Should().Contain("Interruptible = owner.Interruptible");
        MethodBody(source, "public BridgeSnapshot CreateBridgeSnapshot(")
            .Should().Contain("this.DescribeActiveExecution()",
                "the snapshot publishes the same projection rather than a second spelling of it");

        MethodBody(source, "private BridgeSnapshot CreateWorldNotReadyBridgeSnapshot(")
            .Should().Contain("ActiveExecution: null", "the world-not-ready snapshot keeps no occupant");
    }

    // ---- helpers -------------------------------------------------------------

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    private static string RepositorySourcePath(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return Path.Combine(directory.FullName, relative);
    }

    private static string BalancedBody(string source, int start)
    {
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
            else if (character == '}' && started)
            {
                depth--;
                if (depth == 0)
                    return source.Substring(start, index - start + 1);
            }
        }

        return source.Substring(start);
    }

    private static string MethodBody(string source, string signature, int occurrence = 1)
    {
        int index = -1;
        for (int seen = 0; seen < occurrence; seen++)
            index = source.IndexOf(signature, index + 1, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");
        return BalancedBody(source, opening);
    }

    /// <summary>
    /// Seeds the navigation slot at a chosen phase and cancels with a chosen reason code, so a test can tell a
    /// MODEL stop (refusable) from the player STOP and the worker teardown (not).
    /// </summary>
    private static LocalExecutionReceipt CancelSeededSlot(LocalNavigatePhase phase, string reasonCode)
    {
        LocalExecutionReceipt? receipt = null;
        RunWithGameState(() =>
        {
            ExecutionManager manager = CreateManager();
            var spec = new LocalNavigateSpec(
                "exec_nav", "req_nav", default!, "Farm:64,15", "Farm", default!, new Vector2(64f, 15f), DeadlineMs, phase);
            OccupySlot(manager, "activeNavigate", spec);
            receipt = manager.Cancel("req_nav", "exec_nav", reasonCode);
        });
        receipt.Should().NotBeNull("a cancel always produces a receipt");
        return receipt!;
    }

    [Fact]
    public void ModelStop_PastTheCancelPoint_IsRefusedByName()
    {
        // Step 2 of the ruling. A stop is a REQUEST, so it fails closed by NAME when the holder is committed,
        // and the evidence says which phase made it unsafe - no vague failure, and nothing to undo.
        LocalExecutionReceipt receipt = CancelSeededSlot(
            LocalNavigatePhase.ApproachReleased,
            ExecutionManager.ModelStopReasonCode);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(ExecutionManager.ActionPastCancelPoint);
        receipt.Evidence.Should().Be("phase=committed;cancel_safe=false;owner=body_owned_by_navigation");
    }

    [Fact]
    public void ModelStop_DuringTheApproach_StillCancels()
    {
        // The other side of the boundary: while the actor is walking, a stop is honoured.
        LocalExecutionReceipt receipt = CancelSeededSlot(LocalNavigatePhase.Approaching, ExecutionManager.ModelStopReasonCode);

        receipt.State.Should().Be(ExecutionState.Cancelled);
    }

    [Fact]
    public void PlayerStop_IsNotGatedByTheCancelPoint()
    {
        // THE DELIBERATE ASYMMETRY, recorded as a test because it would otherwise look like an oversight: the
        // PLAYER's STOP keeps its own semantics. The phase gate exists for a stop the Agent REQUESTED; the
        // player's authority, and the worker's teardown, are not requests and must not be refused by a phase.
        LocalExecutionReceipt receipt = CancelSeededSlot(LocalNavigatePhase.ApproachReleased, "player_stop_all");

        receipt.State.Should().NotBe(ExecutionState.Rejected, "the player STOP must still stop");
    }
    private static LocalExecutionReceipt Refuse(params (string Field, object? Owner)[] slots)
    {
        LocalExecutionReceipt? receipt = null;
        RunWithGameState(() =>
        {
            ExecutionManager manager = CreateManager();
            foreach ((string field, object? owner) in slots)
                OccupySlot(manager, field, owner);
            receipt = AdmitForBodyCheck(manager);
        });
        receipt.Should().NotBeNull("a body that is already owned must refuse the second execution");
        return receipt!;
    }

    private static void OccupySlot(ExecutionManager manager, string fieldName, object? owner)
    {
        FieldInfo field = typeof(ExecutionManager).GetField(fieldName, BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException($"ExecutionManager.{fieldName} field unavailable.");
        field.SetValue(manager, owner ?? RuntimeHelpers.GetUninitializedObject(field.FieldType));
    }

    private static LocalExecutionReceipt? AdmitForBodyCheck(ExecutionManager manager)
    {
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // AdmitExecution is deliberately private (ToolApproachContractTests pins the `private` form); the test drives
        // it through reflection, the same pattern the modal suite uses for the same entry point.
        object? result = typeof(ExecutionManager)
            .GetMethod("AdmitExecution", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(manager, new object?[]
            {
                $"req_{Guid.NewGuid():N}",
                $"exec_{Guid.NewGuid():N}",
                nowMs + 30_000,
                nowMs,
                ExecutionManager.AdmissionActionabilityProfile.Physical,
                // Reflection does NOT honour a C# optional parameter: the ceiling must be passed explicitly.
                FarmhandActionCatalog.OrdinaryActionCeilingMs,
            });
        return (LocalExecutionReceipt?)result;
    }

    private static ExecutionManager CreateManager()
    {
        var scope = new BridgeScope("stardew", "save_probe", "world_probe", ScopePlayerId, "companion_probe");
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "answer_dialogue" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(new ProbePersistence()),
            executionScope: scope);
        executions.SetTestActorResolver(() => CreateActor(1001));
        return executions;
    }

    /// <summary>
    /// A FormatterServices-created probe farmer, the shared test pattern: SkipNetFields are null until seeded, so
    /// every field the disposition projection reads is replaced with a live NetField or plain value.
    /// </summary>
    private static Farmer CreateActor(long id)
    {
        Farmer actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        typeof(Farmer)
            .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLong(id));
        actor.CanMove = true;
        actor.freezePause = 0;
        typeof(Farmer)
            .GetField("usingTool", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetBool(false));
        typeof(Farmer)
            .GetField("netStamina", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetFloat(270f));
        typeof(Farmer)
            .GetField("toolPower", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetInt(0));
        return actor;
    }

    /// <summary>
    /// The admission reads Game1 statics (activeClickableMenu / eventUp / timeOfDay); save and restore them around
    /// each probe, matching the ScopeBoundActorAdmissionTests convention.
    /// </summary>
    private static void RunWithGameState(Action action)
    {
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool eventUpBefore = Game1.eventUp;
        int timeOfDayBefore = Game1.timeOfDay;
        try
        {
            menuField.SetValue(null, null);
            Game1.eventUp = false;
            Game1.timeOfDay = 600;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
        }
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
