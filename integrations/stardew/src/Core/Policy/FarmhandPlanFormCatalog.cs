using System;
using System.Collections.Generic;
using System.Linq;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// The Mod's plan FORMS: node action ids the Host's plan vocabulary may write that are not published actions.
///
/// <para>
/// A form is not an action. Nothing registers it with <c>FarmhandActionRouter</c>, so it cannot be dispatched as a single
/// request and no flat tool exists for it; it has no handler group, and it never appears in the Mod's action surface
/// artifact. What it does have is a Body Program descriptor, because a program node must be admitted, verified and
/// journaled exactly like any other node before the game thread expands it.
/// </para>
/// <para>
/// WHY IT IS REGISTERED AT ALL. A form node is admitted, verified and journaled exactly like an action node, so the id
/// has to be a member of the Body Program catalog
/// (<see cref="GameBuddy.Stardew.Core.BodyPrograms.FarmhandBodyProgramCatalogProjection"/>) or the verifier refuses the
/// node as <c>unknown_action</c> before the game thread ever sees it. Registering it here makes the id RUNNABLE. That is
/// the whole of the registration, and <see cref="FarmhandActionLifecycle.Published"/> states the same thing: it is what
/// that projection admits (`FarmhandBodyProgramCatalogProjection` takes Published and LiveVerified only), not a claim
/// that a Host is offered the form.
/// </para>
/// <para>
/// WHY IT IS NOT ADVERTISED. <c>hello_ack</c> is the Mod's advertisement, and the Host reads it as the registration
/// authority, so an id in that list is a claim that a request frame can name it. Nothing can name a form the Host does
/// not declare. Measured 2026-11-22: this registration was concatenated into the hello, and the Host had long since
/// stopped declaring a plan form - <c>host/src/body-program-script.ts</c> `PLAN_FORM_ACTION_IDS` is empty and
/// <c>body-program-preflight.ts</c> refuses any node carrying the form's one argument (`plan_form_not_declared`), so the
/// only producer of a <c>for_each</c> node, the Host's plan compiler, refused it. The advertisement was a capability no
/// frame could reach, and an advertisement is the one thing the Host may only NARROW, never correct. So
/// <c>BridgeSession.TryAuthenticate</c> projects <see cref="FarmhandActionCatalog.Registrations"/> alone, and
/// `AdvertisedActionReachabilityTests` fails naming every advertised id a frame cannot reach. The registration stays
/// because it is still true that this Mod can RUN the form: the day a Host declares one, re-advertising it is one edit
/// in the bridge and one in that test's reachability rule, and nothing in this catalog moves.
/// </para>
/// <para>
/// THE WIRE SHAPE OF THE LOOP is one declared argument, <see cref="FarmhandForEachArguments.LoopArgument"/>, typed
/// `string`. That is the one canonical value the frozen wire carries for a document of this kind
/// (<c>host/src/protocol.ts</c> `isBodyCanonicalValue`), and <see cref="FarmhandForEachArguments"/> is its only reader.
/// </para>
/// </summary>
public static class FarmhandPlanFormCatalog
{
    /// <summary>The node action id of the loop form. One spelling, shared with the Host's compiler.</summary>
    public const string ForEachActionId = "for_each";

    /// <summary>The family the plan vocabulary prints forms under, so a form is never mistaken for a game family.</summary>
    public const string FamilyId = "plan_forms";

    /// <summary>
    /// How long one loop may hold the actor.
    ///
    /// A per-intent budget, not an ETA: one pass addresses up to <see cref="FarmhandForEachSource.MaximumRows"/> native
    /// effects, each of which costs a walk and a swing, so the 60 s an ordinary action carries would expire mid-patch and
    /// fail a loop that was doing exactly what it was asked. Ten minutes is the same order as the lifecycle actions.
    /// </summary>
    public const long WatchdogMs = 600_000;

    public static IReadOnlyList<FarmhandActionRegistration> Registrations { get; } = Array.AsReadOnly(new[]
    {
        new FarmhandActionRegistration(
            ForEachActionId,
            FamilyId,
            IdentityVersion: 1,
            FarmhandActionLifecycle.Published,
            FarmhandOperationKind.Execution,
            // NO handler group: a form is expanded by the Body Program executor, never dispatched by the router. The
            // null is the statement, and `FarmhandPlanFormCatalogTests` asserts the router has no handler for it.
            null,
            new FarmhandActionDescriptor(
                new[]
                {
                    new FarmhandActionArgument(
                        FarmhandForEachArguments.LoopArgument,
                        "string",
                        null,
                        "The loop document: { source: { area: { x, y, w, h } }, where: [...], do: { action, ... } | [{ action, ... }, ...] | null, then: [...] }. A `do` array is one tile's ordered chain of at most 4 steps; the single object is the chain of length 1. Written by builder.for_each; read by the Mod's own FarmhandForEachArguments."),
                },
                new Dictionary<string, string>(StringComparer.Ordinal),
                new[] { new FarmhandActionResourceTemplateClaim("embodied_actor", FarmhandResourceTemplateValue.ScopePlayer) },
                "write",
                "for_each_pass_settled",
                NativeBinding: null,
                WatchdogMs: WatchdogMs)),
    });

    /// <summary>Whether an action id is a plan form this Mod expands instead of dispatching.</summary>
    public static bool IsPlanForm(string? actionId) =>
        actionId is not null && Registrations.Any(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal));
}
