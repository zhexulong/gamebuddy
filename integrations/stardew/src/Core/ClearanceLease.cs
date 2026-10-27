using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// One blocker a clearance lease authorises: where it stands and WHICH object it is.
///
/// The tile alone is not an identity. A rock cleared at (53,14) and the weed that grew back there
/// afterwards occupy the same coordinate, and a lease that named only the coordinate would authorise
/// clearing whatever happens to be standing there when the actor finally swings. The target id is the
/// same opaque identity the action families bind their own receipts to, so a re-identified blocker
/// fails <see cref="ClearanceLease.TryAuthorize"/> as a blocker outside the lease rather than being
/// silently paid for.
/// </summary>
public sealed record ClearBlockerTile(int X, int Y, string Kind, string TargetId)
{
    /// <summary>`rock@53,14` - the same shape the clearing evidence uses.</summary>
    public string Describe() => $"{this.Kind}@{this.X},{this.Y}";
}

/// <summary>
/// The lease's answer to "may this clear start": allowed, or refused with the reason and the numbers.
///
/// Refused carries evidence rather than only a code for the same reason every other verdict in this
/// namespace does: "I am not allowed to clear this" is a behaviour, and one that cannot say why is
/// indistinguishable from one that is stuck.
/// </summary>
public readonly record struct ClearanceDecision(bool Allowed, string ReasonCode, string Evidence)
{
    public static ClearanceDecision Permitted { get; } = new(true, "clearance_available", "");

    public static ClearanceDecision Refused(string reasonCode, string evidence) => new(false, reasonCode, evidence);
}

/// <summary>
/// The budget one clearing INTENT spends, and the three ways it ends.
///
/// A companion that clears its way across the farm to reach one tile is spending the player's day, so
/// the plan is bounded by something the player would recognise: a deadline, and the stamina floor every
/// tool action already respects (<see cref="ToolStaminaGuard"/>). Deliberately NOT a count of tiles -
/// a count says "three rocks are fine" whether they are three steps away or forty, which is the wrong
/// question. The deadline and the stamina are the two facts that decide whether the excursion is
/// affordable.
///
/// <para>
/// The lease is per intent and is fixed at issue: the blockers it authorises are the ones the caller
/// decided on. A blocker discovered later - the plan's next head after the first clear, a rock that
/// appeared while the actor walked - is NOT added to the lease by anything in this file. It comes back
/// as <see cref="BlockerOutsideLeaseReasonCode"/> with the step attached, and the caller decides
/// whether the intent is worth extending. That is the whole rule: the Mod may not talk itself into a
/// longer excursion.
/// </para>
///
/// <para>
/// MOD-INTERNAL. This is not a cross-process contract and must not be projected onto the Host wire:
/// there is no lease field in the bridge protocol, no lease in a snapshot or a receipt payload. It is
/// decided and spent inside one Mod process, by one intent at a time.
/// </para>
///
/// <para>
/// Every clear is charged at its REAL stamina cost (<see cref="Charge"/>), not at its estimate: the
/// estimate decides whether the clear may start, the charge decides what the NEXT one may start on.
/// </para>
/// </summary>
public sealed class ClearanceLease
{
    /// <summary>The lease's deadline has passed; no clear starts on it any more.</summary>
    public const string ExpiredReasonCode = "clearance_lease_expired";

    /// <summary>STOP, a policy change or a location change ended the lease before its deadline.</summary>
    public const string InvalidatedReasonCode = "clearance_lease_invalidated";

    /// <summary>The blocker is not one this intent declared: the caller decides, the lease does not broaden.</summary>
    public const string BlockerOutsideLeaseReasonCode = "blocker_outside_lease";

    private readonly HashSet<ClearBlockerTile> authorized;
    private float remainingStamina;
    private string? invalidReasonCode;

    private ClearanceLease(string intentId, float staminaAtIssue, long deadlineMs, IEnumerable<ClearBlockerTile> authorized)
    {
        this.IntentId = intentId;
        this.DeadlineMs = deadlineMs;
        this.remainingStamina = staminaAtIssue;
        this.authorized = new HashSet<ClearBlockerTile>(authorized);
    }

    /// <summary>The intent this lease belongs to, so a refusal and a receipt can name it.</summary>
    public string IntentId { get; }

    /// <summary>The absolute wall-clock deadline, in Unix milliseconds, the same unit the ledger already uses.</summary>
    public long DeadlineMs { get; }

    /// <summary>What the intent has left to spend on clears, after every clear charged so far.</summary>
    public float RemainingStamina => this.remainingStamina;

    /// <summary>How many clears this lease has actually paid for.</summary>
    public int ClearsExecuted { get; private set; }

    /// <summary>The reason the lease was invalidated, or null while it is still live.</summary>
    public string? InvalidReasonCode => this.invalidReasonCode;

    public bool IsValid => this.invalidReasonCode is null;

    /// <summary>
    /// Issue the lease for one intent: the actor's stamina at the moment the intent is accepted, the
    /// intent's own deadline, and the exact blockers the caller decided the intent is worth.
    /// </summary>
    public static ClearanceLease Issue(
        string intentId,
        float staminaAtIssue,
        long deadlineMs,
        IEnumerable<ClearBlockerTile> authorized)
    {
        ArgumentNullException.ThrowIfNull(intentId);
        if (intentId.Length == 0) throw new ArgumentException("an intent id names the lease", nameof(intentId));
        ArgumentNullException.ThrowIfNull(authorized);
        return new ClearanceLease(intentId, staminaAtIssue, deadlineMs, authorized);
    }

    /// <summary>
    /// Whether this clear may start now.
    ///
    /// Four refusals, in the order that makes the reason honest: an ended lease says so before it says
    /// anything about the blocker; an expired one likewise; a blocker the intent never declared is
    /// refused by scope; and the stamina floor is asked LAST, through the same
    /// <see cref="ToolStaminaGuard"/> the action families already gate on, so a lease can never permit a
    /// swing the guard would refuse.
    /// </summary>
    public ClearanceDecision TryAuthorize(ClearBlockerTile blocker, float expectedCost, long nowMs)
    {
        ArgumentNullException.ThrowIfNull(blocker);

        if (this.invalidReasonCode is { } invalid)
            return ClearanceDecision.Refused(
                InvalidatedReasonCode,
                $"{this.Describe()};invalid_reason={invalid}");

        if (nowMs >= this.DeadlineMs)
            return ClearanceDecision.Refused(
                ExpiredReasonCode,
                $"{this.Describe()};now_ms={nowMs.ToString(CultureInfo.InvariantCulture)}");

        if (!this.authorized.Contains(blocker))
            return ClearanceDecision.Refused(
                BlockerOutsideLeaseReasonCode,
                $"{this.Describe()};discovered={blocker.Describe()};authorized={string.Join(",", this.authorized.Select(entry => entry.Describe()).OrderBy(entry => entry, StringComparer.Ordinal))}");

        ToolStaminaVerdict stamina = ToolStaminaGuard.Check(this.remainingStamina, expectedCost);
        if (!stamina.Allowed)
            return ClearanceDecision.Refused(stamina.ReasonCode, $"{stamina.Evidence};{this.Describe()}");

        return ClearanceDecision.Permitted;
    }

    /// <summary>
    /// Charge one completed clear at its real stamina cost. The estimate authorised it; the delta the
    /// engine actually took is what the next clear has to live with.
    /// </summary>
    public void Charge(ClearBlockerTile blocker, float actualCost)
    {
        ArgumentNullException.ThrowIfNull(blocker);
        this.remainingStamina -= Math.Max(0f, actualCost);
        this.ClearsExecuted += 1;
    }

    /// <summary>
    /// End the lease now: STOP, a policy change, or a location change. The first reason wins, because
    /// the first is the one that actually ended it - a later one describes a lease that was already gone.
    /// </summary>
    public void Invalidate(string reasonCode)
    {
        ArgumentNullException.ThrowIfNull(reasonCode);
        if (reasonCode.Length == 0) throw new ArgumentException("an invalidation names its cause", nameof(reasonCode));
        this.invalidReasonCode ??= reasonCode;
    }

    /// <summary>The lease as `key=value` pairs, for a receipt or a refusal.</summary>
    public string Describe()
    {
        string state = this.invalidReasonCode is { } invalid ? $"invalidated:{invalid}" : "active";
        return $"lease_intent={this.IntentId};lease_deadline_ms={this.DeadlineMs.ToString(CultureInfo.InvariantCulture)};lease_stamina_remaining={this.remainingStamina.ToString("0.####", CultureInfo.InvariantCulture)};lease_clears={this.ClearsExecuted.ToString(CultureInfo.InvariantCulture)};lease_state={state}";
    }
}
