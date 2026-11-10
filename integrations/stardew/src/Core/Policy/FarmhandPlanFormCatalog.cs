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
/// WHY IT IS PUBLISHED AT ALL. The Host decides whether a plan is executable from the Mod's own registrations
/// (<c>continuity-semantic-game-runtime-materializer.ts</c> `planFormNodesOutsideCatalogue`): a form the attached Mod
/// does not publish is answered <c>for_each_execution_unavailable</c> and never sent. Publishing the form here is what
/// makes that gate answer "this Mod can run it" - from the Mod, never from a Host-side list.
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
