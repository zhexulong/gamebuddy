using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>Goal-agnostic world/body fact for the embodied actor, computed once
/// per tick by <see cref="WorldModel.ComputeDisposition"/>. Every member is a
/// HOLDING state: something that currently owns or locks the actor and that an
/// action must be told about. Deliberately absent:
/// <list type="bullet">
/// <item><c>Stuck</c> — specification-relative (needs a target to compute), so
/// it belongs to the L2 executor watchdog
/// (world-interruption-arbitration.md §1.2 注, §4.1 注).</item>
/// <item><c>Warped</c> — event-relative, not a holding state: a location change
/// does not lock the actor, and the warp lifecycle already belongs to
/// navigation/travel (which observe the native Warped event). Reporting it here
/// would make the normal walking/lifecycle traffic look like an interruption
/// and force position reads (Game1.netWorldState) the arbitration does not
/// need.</item>
/// </list></summary>
public enum ActorDispositionKind
{
    Idle,
    Modal,
    Event,
    PassOut,
    Transient,
}

/// <summary>
/// The raw, already-read world/body facts the disposition is a pure function of.
/// Reading them off a live <see cref="Farmer"/> is the thin adapter
/// (<see cref="WorldModel.ReadFacts"/>); classifying them is the pure core
/// (<see cref="WorldModel.Classify"/>). The split exists so the ruling order —
/// the part that must never drift — is testable without a live game thread,
/// while the raw reads stay pinned by source probes.
/// </summary>
internal readonly record struct ActorWorldFacts(
    bool EventUp,
    string? MenuType,
    bool DialogueUp,
    int TimeOfDay,
    float Stamina,
    bool FreezePaused,
    bool Eating,
    bool UsingTool,
    bool ToolCharged);

/// <summary>
/// Read-only per-tick disposition payload (readonly record struct on the game
/// thread). Consumed by admission (AdmitExecution), the body loop
/// (StardewBodyController.Update) and handlers; nobody re-checks CanMove /
/// activeClickableMenu / eventUp themselves
/// (world-interruption-arbitration.md §1.2, §4.1).
/// </summary>
public readonly record struct ActorDisposition(
    ActorDispositionKind Kind,
    string? ModalType,        // "DialogueBox" | "LetterViewer" | "ReadyCheck" | "GameMenu" | ...
    bool ModalActionOwned,    // L0 binary: actionOwned(newestExecutionId) vs worldOwned
    string? TransientKind)    // "freezePause" | "eating" | "toolAnimation"
{
    public static readonly ActorDisposition Idle = new(ActorDispositionKind.Idle, null, false, null);
}

/// <summary>Single-authority per-tick world/body projection. Mod-side
/// single-main-thread component (world-interruption-arbitration.md §7-6): the
/// game loop calls <see cref="ComputeDisposition"/> once at the start of each
/// tick, on the game thread, before admission and the body loop read it.
/// Consumers never re-derive body facts themselves.</summary>
internal static class WorldModel
{
    /// <summary>Game1.cs:6452 day-end/pass-out semantics (stamina floor / end
    /// of day).</summary>
    internal const float PassOutStaminaFloor = -15f;

    /// <summary>Game1.cs:6452 — from this clock time onward the pass-out night
    /// transition owns the day.</summary>
    internal const int PassOutDayEndTime = 2600;

    /// <summary>
    /// Injectable L0 modal-owner arbitration: answers "is the current modal the
    /// current action's own modal" — actionOwned(newestExecutionId) vs
    /// worldOwned. Production wires this to the execution ledger's owner lease
    /// (farmhandexecutioncontroller.cs ActiveModalOwnerExecutionId); a null
    /// fence means worldOwned, the safe default.
    /// </summary>
    internal static Func<bool>? ModalActionOwnedCheck;

    /// <summary>
    /// The pure ruling: given already-read facts, which disposition holds?
    /// Priority order, with the native reason each step outranks the next
    /// (world-interruption-arbitration.md §4.1 review ruling 2026-10-02):
    /// <list type="number">
    /// <item>Event — a cutscene absorbs the actor. Native startToPassOut checks
    /// <c>!eventUp</c> (Game1.cs:6458), so the night cannot claim the actor
    /// mid-cutscene; reporting pass_out there would invent a world fact.</item>
    /// <item>Modal — a menu sets CanMove=false, which startToPassOut also
    /// requires, so the engine does not pass out behind an open modal.</item>
    /// <item>PassOut — day end / stamina collapse. Above Transient because
    /// startToPassOut arms freezePause=7000 (Game1.cs:6462): counting the faint
    /// as a transient freeze would hide the terminal behind its own
    /// animation.</item>
    /// <item>Transient — bounded self-healing body locks.</item>
    /// <item>Idle.</item>
    /// </list>
    /// </summary>
    internal static ActorDisposition Classify(in ActorWorldFacts facts)
    {
        if (facts.EventUp)
        {
            return new ActorDisposition(ActorDispositionKind.Event, null, false, null);
        }

        if (facts.MenuType is { } menuType)
        {
            return new ActorDisposition(ActorDispositionKind.Modal, menuType, OwnedByAction(), null);
        }

        if (facts.DialogueUp)
        {
            // A dialogue can briefly outlive its menu (page turns / SMAPI
            // micro-timing) with activeClickableMenu already null; the dialogue
            // is still modal. Same defense as
            // machinesanimalsitemsactions.cs:730.
            return new ActorDisposition(ActorDispositionKind.Modal, "DialogueBox", OwnedByAction(), null);
        }

        if (facts.Stamina <= PassOutStaminaFloor || facts.TimeOfDay >= PassOutDayEndTime)
        {
            return new ActorDisposition(ActorDispositionKind.PassOut, null, false, null);
        }

        if (facts.FreezePaused)
        {
            return new ActorDisposition(ActorDispositionKind.Transient, null, false, "freezePause");
        }

        if (facts.Eating)
        {
            return new ActorDisposition(ActorDispositionKind.Transient, null, false, "eating");
        }

        if (facts.UsingTool || facts.ToolCharged)
        {
            return new ActorDisposition(ActorDispositionKind.Transient, null, false, "toolAnimation");
        }

        return ActorDisposition.Idle;
    }

    /// <summary>Computes the actor's disposition ONCE per tick on the game
    /// thread. The common (Idle) path allocates nothing.</summary>
    public static ActorDisposition ComputeDisposition(Farmer? player)
        => Classify(ReadFacts(player));

    /// <summary>The thin adapter: reads the raw facts off the live game thread
    /// object. The Game1 statics are always safe to read. The actor-derived
    /// facts read the real Farmer; a test harness that builds a probe Farmer
    /// must supply the NetFields these reads touch (the same completeness the
    /// pre-WIA UsingTool read already required).</summary>
    internal static ActorWorldFacts ReadFacts(Farmer? player)
    {
        bool eventUp = Game1.eventUp;
        string? menuType = Game1.activeClickableMenu?.GetType().Name;
        bool dialogueUp = Game1.dialogueUp;
        int timeOfDay = Game1.timeOfDay;

        if (player is null)
            return new ActorWorldFacts(eventUp, menuType, dialogueUp, timeOfDay, 0f, false, false, false, false);

        return new ActorWorldFacts(
            eventUp,
            menuType,
            dialogueUp,
            timeOfDay,
            player.Stamina,
            player.freezePause > 0,
            player.isEating,
            player.UsingTool,
            player.toolPower is { Value: not 0 });
    }

    private static bool OwnedByAction() => ModalActionOwnedCheck?.Invoke() ?? false;
}
