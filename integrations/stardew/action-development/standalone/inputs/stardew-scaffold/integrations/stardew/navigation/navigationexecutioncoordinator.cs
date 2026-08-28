namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// Compatibility-free private coordinator facade for the direct Navigation
/// admission path. ExecutionManager owns receipts and native commits; this type
/// only performs one game-thread planning decision.
/// </summary>
internal sealed class NavigationExecutionCoordinator
{
    private readonly AcceptedNavigationExecution execution;

    internal NavigationExecutionCoordinator(NavigationRuntimeSnapshot runtime)
    {
        this.execution = new AcceptedNavigationExecution(runtime);
    }

    internal NavigationPlan Plan(NavigationDestinationSelector selector) =>
        this.execution.PlanDirectTransition(selector);
}
