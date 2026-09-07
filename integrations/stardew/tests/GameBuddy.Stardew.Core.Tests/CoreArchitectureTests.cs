using ReflectionAssembly = System.Reflection.Assembly;
using ArchUnitNET.Domain;
using ArchUnitNET.Fluent;
using ArchUnitNET.Loader;
using ArchUnitNET.xUnit;
using Xunit;
using static ArchUnitNET.Fluent.ArchRuleDefinition;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class CoreArchitectureTests
{
    private static readonly Architecture Architecture = new ArchLoader()
        .LoadAssemblies(ReflectionAssembly.Load("GameBuddy.Stardew.Core"))
        .Build();

    [Fact]
    public void DeclarativeCoreSurfaces_DoNotDependOnRoutingCoordinator()
    {
        IObjectProvider<IType> declarativeCoreSurfaces = Types()
            .That()
            .ResideInNamespace("GameBuddy.Stardew.Core.Models")
            .Or()
            .ResideInNamespace("GameBuddy.Stardew.Core.Protocol")
            .Or()
            .ResideInNamespace("GameBuddy.Stardew.Core.Policy")
            .As("Core models, protocol, and policy");
        IObjectProvider<IType> routingCoordinator = Types()
            .That()
            .ResideInNamespace("GameBuddy.Stardew.Core.Routing")
            .As("the routing coordinator");

        IArchRule rule = Types()
            .That()
            .Are(declarativeCoreSurfaces)
            .Should()
            .NotDependOnAny(routingCoordinator)
            .Because("Routing coordinates execution; models, protocol, and policy remain reusable declarative Core surfaces.");
        AssertArchitectureHasNoViolations(rule);
    }

    [Fact]
    public void CoreTypes_DoNotDependOnSMAPIOrNativeGameRuntime()
    {
        IArchRule rule = Types()
            .That()
            .ResideInNamespace("GameBuddy.Stardew.Core")
            .Should()
            .NotDependOnAny(
                Types().That().ResideInNamespaceMatching("StardewModdingAPI.*")
                .Or().ResideInNamespaceMatching("StardewValley.*")
                .Or().ResideInNamespace("GameBuddy.Stardew")
            )
            .Because("GameBuddy.Stardew.Core must remain a pure domain library with zero dependency on SMAPI, the native game runtime, or the outer Mod host.")
            .WithoutRequiringPositiveResults();
        AssertArchitectureHasNoViolations(rule);
    }

    [Fact]
    public void CoreAssembly_HasNoBinaryReferenceToSMAPIOrNativeGame()
    {
        var coreAssembly = ReflectionAssembly.Load("GameBuddy.Stardew.Core");
        var referencedAssemblyNames = coreAssembly.GetReferencedAssemblies();

        Assert.DoesNotContain(referencedAssemblyNames, a => a.Name != null && a.Name.Contains("StardewModdingAPI"));
        Assert.DoesNotContain(referencedAssemblyNames, a => a.Name != null && a.Name.Contains("Stardew Valley"));
        Assert.DoesNotContain(referencedAssemblyNames, a => a.Name != null && a.Name.Equals("GameBuddy.Stardew", System.StringComparison.OrdinalIgnoreCase));
    }

    private static void AssertArchitectureHasNoViolations(IArchRule rule)
    {
        rule.Check(Architecture);
    }
}
