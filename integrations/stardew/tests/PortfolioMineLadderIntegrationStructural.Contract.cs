using System.Reflection;
using GameBuddy.Stardew;

internal static class PortfolioMineLadderIntegrationStructuralContract
{
    internal static void Run(Assembly productionAssembly)
    {
        ArgumentNullException.ThrowIfNull(productionAssembly);
        Type adapter = RequireType(productionAssembly, "GameBuddy.Stardew.PortfolioMineLadderSemanticAdapter");
        Type coordinator = RequireType(productionAssembly, "GameBuddy.Stardew.PortfolioMineLadderActionCoordinator");
        Type protocol = RequireType(productionAssembly, "GameBuddy.Stardew.PortfolioMineLadderProbe");

        RequirePublicOrNonPublicInstanceMethod(adapter, "RequestMineLadder");
        RequirePublicOrNonPublicInstanceMethod(adapter, "TryReadTerminalFreshFloor");
        RequirePublicOrNonPublicInstanceMethod(adapter, "ObserveWarped");
        RequirePublicOrNonPublicInstanceMethod(coordinator, "ArmNativeTransition");
        RequirePublicOrNonPublicInstanceMethod(coordinator, "ObserveTransitionStarted");
        RequirePublicOrNonPublicInstanceMethod(coordinator, "ObservePostcondition");

        RequireConstructorParameter(protocol, "LadderObserved", typeof(bool));
        RejectConstructorParameter(protocol, "LadderInteractionAvailable");

        RequireNoObsoleteDirectLadderTypes(productionAssembly);
        RequireNoObsoleteDirectLadderMembers(adapter);
        RequireNoObsoleteDirectLadderProtocolMembers(protocol);
    }

    private static void RequireNoObsoleteDirectLadderTypes(Assembly productionAssembly)
    {
        foreach (string forbiddenType in new[]
                 {
                     "GameBuddy.Stardew.PortfolioMineLadderApproach",
                     "GameBuddy.Stardew.PortfolioMineLadderApproachResult",
                 })
        {
            Require(productionAssembly.GetType(forbiddenType, throwOnError: false) is null,
                $"Direct ladder production assembly must not retain obsolete approach type {forbiddenType}.");
        }
    }

    private static void RequireNoObsoleteDirectLadderMembers(Type adapter)
    {
        string[] forbiddenNames =
        {
            "TryFindLadderApproach",
            "IsAccessibleLadderInteraction",
            "TryAdvancePendingApproach",
            "DiscardPendingApproach",
        };
        foreach (string forbiddenName in forbiddenNames)
        {
            Require(adapter.GetMember(forbiddenName, BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).Length == 0,
                $"Direct ladder adapter must not retain obsolete approach member {forbiddenName}.");
        }
    }

    private static void RequireNoObsoleteDirectLadderProtocolMembers(Type protocol)
    {
        Require(protocol.GetProperty("LadderInteractionAvailable", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic) is null,
            "Direct ladder probe must not retain obsolete LadderInteractionAvailable.");
    }

    private static Type RequireType(Assembly assembly, string name)
        => assembly.GetType(name, throwOnError: false)
           ?? throw new InvalidOperationException($"Production GameBuddy.Stardew assembly must contain {name}.");

    private static void RequirePublicOrNonPublicInstanceMethod(Type type, string name)
        => Require(type.GetMethod(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic) is not null,
            $"{type.FullName} must expose instance method {name}.");

    private static void RequireConstructorParameter(Type type, string parameterName, Type parameterType)
        => Require(type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .SelectMany(constructor => constructor.GetParameters())
                .Any(parameter => parameter.Name == parameterName && parameter.ParameterType == parameterType),
            $"{type.FullName} must retain constructor parameter {parameterName}.");

    private static void RejectConstructorParameter(Type type, string parameterName)
        => Require(!type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .SelectMany(constructor => constructor.GetParameters())
                .Any(parameter => parameter.Name == parameterName),
            $"{type.FullName} must not retain obsolete constructor parameter {parameterName}.");


    private static void Require(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }
}
