namespace GameBuddy.Stardew.Core;

/// <summary>
/// HOW LONG a hold may be waited out on the caller's behalf: two world facts, not one number.
///
/// <para>
/// THE TWO ARE NOT A PREFERENCE, THEY ARE WHAT CLEARS THE HOLD. <see cref="RetryWindow"/> is an animation cooldown - a
/// tool swing, an eating pause, a warp fade - which the engine releases inside
/// <c>WorldModel.TransientRetryWindowMs</c>, so a request deferred for exactly that window meets a free body.
/// <see cref="RequestDeadline"/> is a condition that ends when the WORLD says so: a running event advances itself or the
/// player advances it, and no window this Mod picks is honest about when. Measured (`round56`, day 6 06:00, the furnace
/// cutscene): the event began at 19:55:53, the requests were refused from 19:55:54.61, and the world was free again at
/// 19:55:59. One window for both is the defect this type exists to state - two seconds against that event dispatched
/// into it and spent the plan.
/// </para>
///
/// <para>
/// ONE TYPE, TWO LAYERS. The body-program pump (<c>BodyProgramDispatchGate</c>) and the flat admission
/// (<c>ExecutionAdmission.Admit</c>) answer the same question about the same world, so they name the answer with this
/// one enum: the pump defers by <see cref="RequestDeadline"/> up to the node's own watchdog, and the admission parks a
/// request for the same kind up to the deadline the request itself declared. A second spelling of "how long may I wait"
/// is how the two layers came to hold opposite beliefs about a cutscene in the same sentence.
/// </para>
/// </summary>
public enum BodyHoldWait
{
    /// <summary>
    /// The flat admission's own parking window (<c>WorldModel.TransientRetryWindowMs</c>), which is the number the
    /// evidence publishes to the caller as <c>retry_window_ms</c>.
    /// </summary>
    RetryWindow,

    /// <summary>
    /// As long as the request's own deadline allows a dispatch at all - the node's
    /// <c>DerivedDeadlineMs</c> for a body-program node, the request's <c>DeadlineMs</c> for a flat dispatch. Past it no
    /// admission can be consumed, so a longer wait would be a wait for a dispatch that cannot happen.
    /// </summary>
    RequestDeadline,
}
