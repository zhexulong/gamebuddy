using System;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// What a Navigation terminal leaves the caller to do, as one closed vocabulary.
///
/// <para>
/// MEASURED `round68`: a navigation settled `destination_locked` with
/// <c>destination=Town;phase=awaiting_warp;grace_expired=true;actionable=false;never_retry=true</c> and the run ended
/// there. Nothing in that sentence named a next action, so the only reading it left open was "there is no next move" -
/// for a destination the player had walked to before, whose hold was the game's own and temporary. <c>never_retry</c> is
/// a ledger fact (this request id will not be re-executed) published where a reader needed an instruction.
/// </para>
///
/// <para>
/// So every navigation terminal states its next step, from this table and through the one settlement seam
/// (<c>SettleNavigationTerminal</c>); a site that already published a step - a body hold's own countermeasure, which
/// names the game's condition - keeps its own, because that sentence is more specific than any word here.
/// </para>
///
/// <para>
/// THE THREE ZEROES, kept apart on purpose: a terminal either names a NEXT ACTION, or names a PERMANENT condition (the
/// game state that has to change outside this execution, e.g. the scope it ran in ended), or it is the successful end of
/// the navigation and asks nothing of anyone (<see cref="NavigationExit.Progress"/>). An entry that is none of those is
/// <c>mute</c>, and <c>NavigationNextStepNamingTests</c> fails naming it.
/// </para>
/// </summary>
internal enum NavigationExit
{
    /// <summary>The caller has something to do; <see cref="NavigationNextStep.Token"/> names it.</summary>
    NextAction,

    /// <summary>Nothing inside this execution can change it; <see cref="NavigationNextStep.Token"/> names the condition.</summary>
    PermanentCondition,

    /// <summary>The navigation is still running or finished successfully: no ejection, no step owed.</summary>
    Progress,

    /// <summary>No entry: the gate fails on this one and names the code.</summary>
    Unclassified,
}

/// <summary>One classified terminal: its kind and the single word it publishes.</summary>
internal readonly record struct NavigationNextStep(NavigationExit Exit, string? Token)
{
    internal static NavigationNextStep Action(string nextStep) => new(NavigationExit.NextAction, nextStep);

    internal static NavigationNextStep Permanent(string condition) => new(NavigationExit.PermanentCondition, condition);

    internal static NavigationNextStep Progress => new(NavigationExit.Progress, null);

    /// <summary>The entry for a code this table cannot name: mute, which is what the gate fails on.</summary>
    internal static NavigationNextStep Mute => new(NavigationExit.Unclassified, null);

    /// <summary>Whether this entry leaves a reader with nothing to do and no reason why.</summary>
    internal bool IsMute => this.Exit == NavigationExit.Unclassified;

    /// <summary>The `next_step=` / `permanent=` field this entry publishes.</summary>
    internal string Render() => this.Exit switch
    {
        NavigationExit.NextAction => $"next_step={this.Token}",
        NavigationExit.PermanentCondition => $"permanent={this.Token}",
        _ => string.Empty,
    };

    /// <summary>
    /// The classification of one navigation terminal code. Every code the navigation family can mint belongs here; the
    /// words are the actions a caller can actually take, so none of them promises a tool that refuses.
    /// </summary>
    internal static NavigationNextStep Of(string? reasonCode) => reasonCode switch
    {
        // The body is held, not the destination. The hold's own countermeasure (`held_by=…;admissible_actions=…`) says
        // the specific thing; this word covers the site that only knows the code.
        "destination_locked" => Action("wait_for_the_hold_to_clear"),

        // The game's own gate on the destination (`Game1.isLocationAccessible`), so it opens on a game condition.
        "destination_temporarily_unavailable" => Action("wait_for_the_destination_to_open"),

        // Nothing here can reach it: the caller picks a destination the published topology does reach.
        "destination_unreachable" => Action("choose_a_reachable_destination"),
        "path_not_found" => Action("choose_a_reachable_destination"),

        // A fact could not be read this frame, or a native transition may have happened and is uncorrelated. Looking
        // before acting is the only safe step in both cases.
        "destination_access_indeterminate" => Action("observe_before_acting"),
        "native_transition_uncertain" => Action("observe_before_acting"),
        "navigation_warp_postcondition_mismatch" => Action("observe_before_acting"),
        "navigation_warp_source_mismatch" => Action("observe_before_acting"),
        "navigation_commit_exception" => Action("observe_before_acting"),
        "navigation_deadline_expired_after_warp" => Action("observe_before_acting"),
        "navigation_cancelled_after_warp_child" => Action("observe_before_acting"),
        "navigation_invalidated_after_warp_child" => Action("observe_before_acting"),

        // The selector side: the published destination list is what the caller must read again.
        "destination_selector_invalid" => Action("observe_the_published_destinations"),
        "destination_selector_ambiguous" => Action("observe_the_published_destinations"),
        "destination_selector_stale" => Action("observe_the_published_destinations"),
        "navigation_admission_required" => Action("reissue_request"),

        // The scope the execution lived in is gone: no action inside it can resume the walk.
        "navigation_scope_unavailable" => Permanent("scope_ended"),

        // Nothing was mutated, or what was mutated is the world the next request re-plans from.
        "navigation_deadline_expired" => Action("reissue_request"),
        "invalid_deadline" => Action("reissue_request"),
        "navigation_source_mismatch" => Action("reissue_request"),
        "navigation_commit_revalidation_state_mismatch" => Action("reissue_request"),
        "navigation_approach_state_revalidated_mismatch" => Action("reissue_request"),
        "navigation_transition_revalidated_mismatch" => Action("reissue_request"),
        "navigation_warp_unavailable" => Action("reissue_request"),
        "navigation_multi_hop_arm_failed" => Action("reissue_request"),

        // Another execution holds the body: it settles on its own, then this request can run.
        "navigation_commit_body_still_owned" => Action("wait_for_the_body_to_settle"),

        // The next leg is a DOOR, and the action that walks through a door is `enter_exit` - not this navigation.
        "navigation_transition_family_not_materialized" => Action("use_enter_exit"),

        // No standing tile beside the leg: the target has to be freed, or a different one chosen.
        "navigation_approach_unavailable" => Action("clear_the_approach_or_choose_another_target"),

        // Not ejections: the navigation is running, or it arrived.
        "accepted" => Progress,
        "navigation_completed" => Progress,
        "navigation_multi_hop_leg_armed" => Progress,

        _ => Mute,
    };

    /// <summary>
    /// <paramref name="evidence"/> with this code's next step beside it, unless the site already published one.
    ///
    /// <para>
    /// A body hold publishes its own (`WorldModel.DescribeCurrentNavigationHold` carries `next_step=` or
    /// `admissible_actions=` from the closed hold vocabulary), and that sentence names the game's own condition, so it
    /// wins over the generic word here. Nothing else is appended twice: the scene is one frame, and a detail whose
    /// fields repeat is a detail a reader cannot parse.
    /// </para>
    /// </summary>
    internal static string? Describe(string? reasonCode, string? evidence)
    {
        if (AlreadyStatesAStep(evidence))
            return evidence;

        string rendered = Of(reasonCode).Render();
        if (rendered.Length == 0)
            return evidence;
        return string.IsNullOrEmpty(evidence) ? rendered : $"{evidence};{rendered}";
    }

    private static bool AlreadyStatesAStep(string? evidence) =>
        evidence is not null
        && (evidence.Contains("next_step=", StringComparison.Ordinal)
            || evidence.Contains("admissible_actions=", StringComparison.Ordinal)
            || evidence.Contains("permanent=", StringComparison.Ordinal));
}
