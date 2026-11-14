using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    /// <summary>
    /// ONE OBSERVATION, ONE VERDICT. A body that read back the outcome it asked the world for has observed it or it
    /// has not, and that one boolean decides BOTH halves of the receipt: the state, and the reason code the Host
    /// maps.
    ///
    /// <para>
    /// Spelled at a call site as two ternaries - or as a <c>state</c> local beside a <c>reasonCode</c> local - the
    /// two halves are two statements that can be edited apart, and nothing in the build notices when they disagree:
    /// a receipt that says <c>Succeeded</c> while carrying a <c>..._postcondition_unavailable</c> code is a success
    /// the Host cannot reconcile with the code it reads. Measured before this seam existed, 24 sites across eight
    /// partials derived the pair separately. <c>VerdictConstructionTests</c> holds the population of hand-derived
    /// pairs at the five that answer a DIFFERENT question, and names those rather than pretending they are this one.
    /// </para>
    /// </summary>
    /// <param name="observed">The body's own read-back: did the world show the outcome it asked for?</param>
    /// <param name="observedCode">The code the receipt carries when it did.</param>
    /// <param name="unobservedCode">The code it carries when it did not.</param>
    private static (ExecutionState State, string ReasonCode) PostconditionVerdict(
        bool observed,
        string observedCode,
        string unobservedCode) =>
        observed
            ? (ExecutionState.Succeeded, observedCode)
            : (ExecutionState.Uncertain, unobservedCode);

    /// <summary>
    /// The same verdict, minted: the shape every handler uses when the observation and the receipt are in one place.
    /// A handler whose native window closes (a <c>try</c>/<c>finally</c> that restores the tool selection) before its
    /// receipt is built keeps the two statements apart and takes <see cref="PostconditionVerdict"/> directly, so the
    /// pair still has one derivation.
    ///
    /// <para>
    /// What this does NOT express, deliberately: a pair whose two states are not Succeeded/Uncertain (the
    /// native-call-ran-against-it-refused pairs in <c>facilityactions.cs</c> and <c>transportactions.cs</c>, and the
    /// deadline pair in <c>frameloop.cs</c>), and evidence that differs per branch. Taking both states as arguments
    /// would be longer at every call site than the two ternaries it replaced, and evidence that differs per branch is
    /// the action's own account of what it saw, not a fact this constructor knows.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt SettlePostcondition(
        string requestId,
        string executionId,
        bool observed,
        string observedCode,
        string unobservedCode,
        string? evidence)
    {
        (ExecutionState state, string reasonCode) = PostconditionVerdict(observed, observedCode, unobservedCode);
        return this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);
    }
}
