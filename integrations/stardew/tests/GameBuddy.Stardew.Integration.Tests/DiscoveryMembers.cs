using System;
using System.Reflection;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Where a `Discover*` member is declared, resolved from the name instead of written down per test.
///
/// <para>
/// The family used to live on <see cref="ExecutionManager"/>; a source-shape test that reached it by name on that type
/// turned the move into a red gate rather than reading nothing. So the receiver is resolved from the DECLARATIONS: the
/// discovery type first, then the controller (its `SummarizeChests` and the four postcondition echoes still live there),
/// and a member found in neither THROWS naming itself instead of returning null to a `!`.
/// </para>
/// </summary>
internal static class DiscoveryMembers
{
    private const BindingFlags Any =
        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;

    /// <summary>The one member declared under <paramref name="name"/>, or a throw naming the member that is gone.</summary>
    internal static MethodInfo Method(string name) =>
        typeof(FarmhandTargetDiscovery).GetMethod(name, Any)
        ?? typeof(ExecutionManager).GetMethod(name, Any)
        ?? throw new InvalidOperationException($"discovery_member_missing:{name}");

    /// <summary>The receiver a member needs: null when it is static, the manager's own discovery instance otherwise.</summary>
    internal static object? Target(MethodInfo method, ExecutionManager manager) =>
        method.IsStatic ? null : manager.TargetDiscovery;
}
