namespace GameBuddy.Stardew.Core;

/// <summary>
/// Whether an actor can afford to finish a clear before the engine's pass-out floor.
///
/// Why this exists: nothing in the Mod gated on stamina before this. `WorldModel.Classify` reports `PassOut`
/// once stamina is at or below -15, which is the state AFTER the actor has already fainted - correct as a
/// disposition, useless as a precondition. The engine itself does not refuse a swing for lack of stamina; it
/// lets stamina run negative and then faints the actor, which halves next day's stamina. For a companion
/// running a multi-day routine that is not a local defeat, it is the end of the routine.
///
/// The rule is deliberately a MARGIN rather than an exact cost comparison. Tool stamina charges are floats
/// scaled by skill level and enchantments (`2 - level * 0.1`, `IsEfficient` -> 0), and a clear that lands the
/// actor exactly on the floor with no room to walk home has not been afforded - it has been survived once.
/// </summary>
public static class ClearStaminaGuard
{
    /// <summary>
    /// The floor a clear must leave the actor above.
    ///
    /// `WorldModel.PassOutStaminaFloor` is -15; this sits well above it so a completed clear still leaves the
    /// actor able to walk, open a door and reach a bed. It is a product red line, not a gameplay budget: the
    /// point is that the companion never spends the player's day into a faint it cannot recover from.
    /// </summary>
    public const float MinimumStaminaAfterClear = 5f;

    /// <summary>
    /// Whether <paramref name="currentStamina"/> can absorb <paramref name="expectedClearCost"/> and still
    /// leave the actor strictly ABOVE the floor.
    ///
    /// "Strictly above" is the whole point: a clear that lands exactly on the floor is one the actor survived, not
    /// one the actor had room to do. The floor is chosen so a completed clear leaves enough left to walk, open a
    /// door and reach a bed.
    ///
    /// Returns a named reason rather than a bare bool, because the caller has to report WHY it stopped: a
    /// companion that says "I am too tired to break this" is behaving well, and one that silently does nothing
    /// is indistinguishable from one that is stuck.
    /// </summary>
    public static ClearStaminaVerdict Check(float currentStamina, float expectedClearCost)
    {
        // Already at or below the floor: any further charge faints the actor, and even a free clear leaves it
        // there. Refuse before touching the world.
        if (currentStamina <= MinimumStaminaAfterClear)
            return ClearStaminaVerdict.Refused(
                "insufficient_stamina",
                $"stamina={currentStamina:0.##};required_after={MinimumStaminaAfterClear:0.##};expected_cost=0");

        float after = currentStamina - expectedClearCost;
        if (after <= MinimumStaminaAfterClear)
            return ClearStaminaVerdict.Refused(
                "insufficient_stamina",
                $"stamina={currentStamina:0.##};required_after={MinimumStaminaAfterClear:0.##};expected_cost={expectedClearCost.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture)}");

        return ClearStaminaVerdict.Permitted;
    }
}

/// <summary>
/// The guard's answer: allowed, or refused with the reason and the numbers that decided it.
/// </summary>
public readonly record struct ClearStaminaVerdict(
    bool Allowed,
    string ReasonCode,
    string Evidence)
{
    public static ClearStaminaVerdict Permitted { get; } = new(true, "stamina_available", "");

    public static ClearStaminaVerdict Refused(string reasonCode, string evidence) => new(false, reasonCode, evidence);
}
