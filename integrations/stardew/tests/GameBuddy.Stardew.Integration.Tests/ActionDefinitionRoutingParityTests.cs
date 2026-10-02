using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The registration catalog and the production dispatch handlers must stay in
/// exact two-way correspondence: every executable registration has a handler
/// branch, and no handler claims an action the catalog assigns to another group.
///
/// <para>
/// The production router itself is private to ModEntry, so this contract is
/// asserted against the two public/visible halves it joins: the closed
/// registration catalog (<see cref="FarmhandActionCatalog"/>) and the handler
/// implementations' own dispatch tables. Each handler's action identity comes
/// from the string literals in its <c>Execute</c> switch, read from IL - the
/// same technique the type-identity guard uses, and the only way to observe a
/// closed switch without widening the production surface.
/// </para>
/// </summary>
public sealed class ActionDefinitionRoutingParityTests
{
    /// <summary>The group-to-handler mapping ModEntry's router switch implements.</summary>
    private static readonly IReadOnlyDictionary<FarmhandActionHandlerGroup, Type> HandlerByGroup =
        new Dictionary<FarmhandActionHandlerGroup, Type>
        {
            [FarmhandActionHandlerGroup.Movement] = typeof(MovementActionHandler),
            [FarmhandActionHandlerGroup.Farming] = typeof(FarmingActionHandler),
            [FarmhandActionHandlerGroup.Gathering] = typeof(GatheringActionHandler),
            [FarmhandActionHandlerGroup.MachinesAndAnimals] = typeof(MachineAndAnimalActionHandler),
            [FarmhandActionHandlerGroup.ResourceTools] = typeof(ResourceToolActionHandler),
            [FarmhandActionHandlerGroup.Expression] = typeof(ExpressionActionHandler),
            [FarmhandActionHandlerGroup.WorldLifecycle] = typeof(WorldLifecycleActionHandler),
        };

    private static IReadOnlyList<FarmhandActionRegistration> Executions =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Kind == FarmhandOperationKind.Execution)
            .ToArray();

    [Fact]
    public void EveryHandlerGroup_HasExactlyOneHandlerImplementation()
    {
        Enum.GetValues<FarmhandActionHandlerGroup>()
            .Should().BeEquivalentTo(HandlerByGroup.Keys,
                "every dispatch group must map to a handler, and no handler may be orphaned");
    }

    [Fact]
    public void EveryExecutionRegistration_IsClaimedByItsOwnGroupHandler()
    {
        var offenders = new List<string>();
        foreach (FarmhandActionRegistration registration in Executions)
        {
            registration.HandlerGroup.Should().NotBeNull(
                $"executable registration {registration.ActionId} must declare a handler group");
            Type handler = HandlerByGroup[registration.HandlerGroup!.Value];
            if (!ActionIdsInHandler(handler).Contains(registration.ActionId))
            {
                offenders.Add($"{registration.ActionId} (group {registration.HandlerGroup}) has no branch in {handler.Name}");
            }
        }

        offenders.Should().BeEmpty(
            "a registration without a handler branch would fail closed with unsupported_action at runtime");
    }

    [Fact]
    public void NoHandler_ClaimsAnActionRegisteredToAnotherGroup()
    {
        var registered = Executions
            .Where(registration => registration.HandlerGroup is not null)
            .ToDictionary(registration => registration.ActionId, registration => registration.HandlerGroup!.Value);

        var offenders = new List<string>();
        foreach ((FarmhandActionHandlerGroup group, Type handler) in HandlerByGroup)
        {
            foreach (string actionId in ActionIdsInHandler(handler).Where(registered.ContainsKey))
            {
                if (registered[actionId] != group)
                {
                    offenders.Add($"{handler.Name} claims {actionId}, but the catalog assigns it to {registered[actionId]}");
                }
            }
        }

        offenders.Should().BeEmpty("a handler must not accept another group's action id");
    }

    [Fact]
    public void EveryHandler_FailsClosedForAnUnknownAction()
    {
        foreach ((FarmhandActionHandlerGroup group, Type handler) in HandlerByGroup)
        {
            ActionIdsInHandler(handler).Should().Contain("unsupported_action",
                $"{handler.Name} must keep its fail-closed default branch for group {group}");
        }
    }

    [Fact]
    public void CatalogExecutionIds_AreUniqueAndMatchTheHandlerBranchesExactly()
    {
        // The catalog's own static constructor already rejects duplicate ids;
        // this pins the total so a silent drop cannot shrink the surface.
        IReadOnlyList<FarmhandActionRegistration> executions = Executions;
        executions.Select(registration => registration.ActionId).Distinct(StringComparer.Ordinal)
            .Should().HaveCount(executions.Count);

        int handlerBranches = HandlerByGroup.Values
            .SelectMany(ActionIdsInHandler)
            .Distinct(StringComparer.Ordinal)
            .Count();

        handlerBranches.Should().BeGreaterThanOrEqualTo(executions.Count,
            "handlers may add fail-closed sentinels, but must cover every executable registration");
    }

    /// <summary>
    /// The string literals in a handler's <c>Execute</c> switch, read from IL.
    /// A closed switch compiles to <c>ldstr</c> + comparison, so every action id
    /// the handler dispatches appears as a string operand of that method.
    /// </summary>
    private static HashSet<string> ActionIdsInHandler(Type handler)
    {
        MethodInfo execute = handler.GetMethod(nameof(IFarmhandActionHandler.Execute))
            ?? throw new InvalidOperationException($"{handler.Name} does not implement Execute");
        MethodBody body = execute.GetMethodBody()
            ?? throw new InvalidOperationException($"{handler.Name}.Execute has no IL body");
        byte[] il = body.GetILAsByteArray()!;
        Module module = execute.Module;

        var literals = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < il.Length - 4; index++)
        {
            if (il[index] != 0x72) // ldstr
                continue;
            int token = BitConverter.ToInt32(il, index + 1);
            try
            {
                literals.Add(module.ResolveString(token));
            }
            catch (ArgumentException)
            {
                // Not an ldstr token; keep scanning.
            }
        }
        return literals;
    }
}