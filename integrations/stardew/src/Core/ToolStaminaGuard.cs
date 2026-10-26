using System;
using System.Globalization;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// Whether the actor can afford a tool loop before the engine's pass-out floor.
///
/// This exists because nothing in the Mod gated on stamina before it. `WorldModel.Classify` reports
/// `PassOut` at or below -15 (`Game1.cs:6452`), which is the state AFTER the actor has already fainted -
/// correct as a disposition, useless as a precondition. The engine itself does not refuse a swing for lack
/// of stamina: it lets stamina run negative and then faints the actor, and a faint halves next day's
/// stamina. For a companion running a multi-day routine that is not a local defeat, it is the end of the
/// routine.
///
/// Two shapes need it, and they need the SAME floor:
///
/// <list type="bullet">
/// <item>a workload of known size (a clump of known health, a crop that needs one swing);</item>
/// <item>a bounded swing LOOP whose length is not known until it finishes - a stump that falls after some
/// number of hits, a container that may open on the first. For those the caller can only supply the worst
/// case it is willing to spend, which is exactly the loop's own cap.</item>
/// </list>
///
/// The rule is deliberately a MARGIN rather than an exact cost comparison. Tool charges are floats scaled
/// by skill level and enchantments (`2 - level * 0.1`, `IsEfficient` -> 0), and a loop that lands the actor
/// exactly on the floor with no room to walk home has not been afforded - it has been survived once.
/// </summary>
public static class ToolStaminaGuard
{
    /// <summary>
    /// The floor a tool workload must leave the actor above.
    ///
    /// `WorldModel.PassOutStaminaFloor` is -15; this sits well above it so a completed workload still leaves
    /// the actor able to walk, open a door and reach a bed. It is a product red line, not a gameplay budget:
    /// the point is that the companion never spends the player's day into a faint it cannot recover from.
    /// </summary>
    public const float MinimumStaminaAfterWorkload = 5f;

    /// <summary>
    /// Whether <paramref name="currentStamina"/> can absorb <paramref name="expectedCost"/> and still leave
    /// the actor strictly ABOVE the floor.
    ///
    /// "Strictly above" is the whole point: landing exactly on the floor is one the actor survived, not one
    /// the actor had room to do.
    ///
    /// Returns a named reason rather than a bare bool, because the caller has to report WHY it stopped: a
    /// companion that says "I am too tired to break this" is behaving well, and one that silently does
    /// nothing is indistinguishable from one that is stuck.
    /// </summary>
    public static ToolStaminaVerdict Check(float currentStamina, float expectedCost)
    {
        // Already at or below the floor: any further charge faints the actor, and even a free workload leaves
        // it there. Refuse before touching the world.
        if (currentStamina <= MinimumStaminaAfterWorkload)
            return ToolStaminaVerdict.Refused(
                "insufficient_stamina",
                $"stamina={Format(currentStamina)};required_after={Format(MinimumStaminaAfterWorkload)};expected_cost=0");

        float after = currentStamina - expectedCost;
        if (after <= MinimumStaminaAfterWorkload)
            return ToolStaminaVerdict.Refused(
                "insufficient_stamina",
                $"stamina={Format(currentStamina)};required_after={Format(MinimumStaminaAfterWorkload)};expected_cost={Format(expectedCost)}");

        return ToolStaminaVerdict.Permitted;
    }

    /// <summary>
    /// The per-swing charge for one tool family, as the engine computes it.
    ///
    /// One function so the pre-flight estimate and the receipt's `expected_stamina_cost` cannot drift: both
    /// name the same formula. `IsEfficient` (the efficient enchantment) charges nothing.
    /// </summary>
    public static float PerSwingCharge(int skillLevel, bool efficient) =>
        efficient ? 0f : Math.Max(0f, 2f - (skillLevel * 0.1f));

    private static string Format(float value) =>
        value.ToString("0.####", CultureInfo.InvariantCulture);
}

/// <summary>
/// The guard's answer: allowed, or refused with the reason and the numbers that decided it.
/// </summary>
public readonly record struct ToolStaminaVerdict(
    bool Allowed,
    string ReasonCode,
    string Evidence)
{
    public static ToolStaminaVerdict Permitted { get; } = new(true, "stamina_available", "");

    public static ToolStaminaVerdict Refused(string reasonCode, string evidence) => new(false, reasonCode, evidence);
}
