using System;
using System.Reflection;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Seeds and reads one body slot on a headless manager exactly as a live dispatch would: through the slot's own
/// <c>Assign</c>/<c>Clear</c>.
///
/// <para>
/// The slots live in <see cref="ActiveBodySlots"/>, which is the only writer of them, and these tests cannot dispatch a
/// real body. They reach the slots through the manager's <c>slots</c> field and name each one by the field name the
/// product's own read projections use (<c>activeFishing</c> -&gt; <c>Fishing</c>), so a renamed slot fails here naming
/// the field instead of silently seeding nothing.
/// </para>
/// </summary>
internal static class BodySlotSeeding
{
    /// <summary>The slot property that holds the named field's spec (<c>activeFishing</c> -&gt; <c>Fishing</c>).</summary>
    internal static string SlotName(string field) => field == "active" ? "Active" : field["active".Length..];

    /// <summary>The spec type the named slot holds, for the tests that seed an uninitialised instance.</summary>
    internal static Type SlotType(ExecutionManager manager, string field) => Slot(manager, field).GetType().GetGenericArguments()[0];

    internal static void Seed(ExecutionManager manager, string field, object? spec)
    {
        object slot = Slot(manager, field);
        if (spec is null)
        {
            slot.GetType().GetMethod("Clear", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(slot, null);
            return;
        }

        slot.GetType().GetMethod("Assign", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(slot, new[] { spec });
    }

    internal static object? Peek(ExecutionManager manager, string field)
    {
        object slot = Slot(manager, field);
        return slot.GetType().GetMethod("Peek", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(slot, null);
    }

    private static object Slot(ExecutionManager manager, string field)
    {
        object slots = typeof(ExecutionManager).GetField("slots", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(manager)
            ?? throw new InvalidOperationException("ExecutionManager.slots field unavailable.");
        string name = SlotName(field);
        PropertyInfo property = slots.GetType().GetProperty(name, BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException($"ActiveBodySlots.{name} slot unavailable for field {field}.");
        return property.GetValue(slots)!;
    }
}
