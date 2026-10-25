using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew;
using StardewModdingAPI;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// SMAPI's <c>Helper.WriteConfig</c> replaces config.json whole, so every write the Mod
/// performs is a whole-record replacement. Two writes exist: the verified-scope persist in
/// <see cref="ModEntry"/> and the fixture bootstrap completion
/// (<see cref="NativeLocalPlayerFixtureConfig.WithObservedBootstrapCompletion"/>). Both were
/// field-by-field rebuilds, which is a shape that silently resets every field the rebuild
/// forgets - the bootstrap one really did drop the navigation fixture's private target
/// label, and the smoke runner's habit of clearing that label before each run is what hid
/// the loss. Both are now copies with the changed fields overridden.
///
/// Every guard below derives both its population and its values from the types, so a
/// property added to either config later is armed with a non-default value automatically and
/// fails if a hand-written rebuild comes back. A hand-maintained field list would have to be
/// updated by the same person who forgot the field.
/// </summary>
public sealed class ConfigScopePersistTests
{
    [Fact]
    public void VerifiedScopePersistWritesEveryFieldBack_AndOnlyTheScopeChanges()
    {
        ModConfig loaded = (ModConfig)NonDefaultInstance(typeof(ModConfig));

        ModConfig written = PersistVerifiedFarmhandScope(loaded, "save_live", "world_live", "player_live");

        AssertPreserved(loaded, written, "SaveId", "WorldId", "PlayerId", "NativeLocalPlayerFixture");
        written.SaveId.Should().Be("save_live");
        written.WorldId.Should().Be("world_live");
        written.PlayerId.Should().Be("player_live");
    }

    [Fact]
    public void VerifiedScopePersist_KeepsTheLoadedPolicyListsRatherThanRebindingThem()
    {
        // The old rebuild copied the three policy lists into new lists. A copy keeps the
        // loaded lists themselves, so a scope write cannot rebind or lose a policy edit it
        // does not own.
        ModConfig loaded = (ModConfig)NonDefaultInstance(typeof(ModConfig));

        ModConfig written = PersistVerifiedFarmhandScope(loaded, "save_live", "world_live", "player_live");

        written.DeniedActions.Should().BeSameAs(loaded.DeniedActions);
        written.DeniedActionFamilies.Should().BeSameAs(loaded.DeniedActionFamilies);
        written.ExperimentalActions.Should().BeSameAs(loaded.ExperimentalActions);
    }

    [Fact]
    public void BootstrapCompletionPersistKeepsEveryFixtureField_AndOnlyDisarmsTheBootstrap()
    {
        NativeLocalPlayerFixtureConfig loaded = (NativeLocalPlayerFixtureConfig)NonDefaultInstance(typeof(NativeLocalPlayerFixtureConfig));
        string expectedLabel = loaded.NavigationMutationTargetLabel;
        string expectedBootstrapName = loaded.Bootstrap!.PlayerName;

        NativeLocalPlayerFixtureConfig persisted = loaded.WithObservedBootstrapCompletion(
            "GameBuddyFixtureBoot",
            "GameBuddyFixtureBoot_445094166",
            loaded.Bootstrap!.PlayerName);

        AssertPreserved(loaded, persisted, "LogicalSaveName", "ObservedSaveSlot", "Bootstrap");

        // The field a field-by-field rebuild actually dropped, named outright so the
        // regression stays legible even if the loop above is ever narrowed.
        persisted.NavigationMutationTargetLabel.Should().Be(expectedLabel);
        persisted.LogicalSaveName.Should().Be("GameBuddyFixtureBoot");
        persisted.ObservedSaveSlot.Should().Be("GameBuddyFixtureBoot_445094166");
        persisted.Bootstrap!.Enable.Should().BeFalse();
        persisted.Bootstrap.PlayerName.Should().Be(expectedBootstrapName);
    }

    [Fact]
    public void ConfigSurvivesTheJsonTripTheModActuallyPerforms()
    {
        // The record conversion must not change what config.json round-trips. SMAPI reads
        // and writes with a case-insensitive System.Text.Json configuration.
        ModConfig loaded = (ModConfig)NonDefaultInstance(typeof(ModConfig));
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

        ModConfig restored = JsonSerializer.Deserialize<ModConfig>(JsonSerializer.Serialize(loaded), options)!;

        AssertPreserved(loaded, restored);
    }

    /// <summary>
    /// Every writable property the persist did not deliberately replace must still hold the
    /// value the loaded config carried. The loaded value is asserted non-default first, so a
    /// property the fixture builder could not arm fails loudly instead of passing vacuously.
    /// </summary>
    private static void AssertPreserved(object loaded, object written, params string[] replaced)
    {
        var replacedNames = new HashSet<string>(replaced, StringComparer.Ordinal);
        object defaults = Activator.CreateInstance(loaded.GetType())!;
        PropertyInfo[] properties = WritableProperties(loaded.GetType());
        properties.Should().NotBeEmpty($"{loaded.GetType().Name} must expose writable properties for this guard to mean anything");

        foreach (PropertyInfo property in properties)
        {
            if (replacedNames.Contains(property.Name))
                continue;

            string loadedJson = Serialize(property.GetValue(loaded));
            string defaultJson = Serialize(property.GetValue(defaults));
            loadedJson.Should().NotBe(
                defaultJson,
                $"{loaded.GetType().Name}.{property.Name} must be armed with a non-default value, otherwise this guard cannot see it being reset");

            Serialize(property.GetValue(written)).Should().Be(
                loadedJson,
                $"{loaded.GetType().Name}.{property.Name} is not part of the persist, so the whole-record write must not reset it");
        }
    }

    private static string Serialize(object? value) => JsonSerializer.Serialize(value, value?.GetType() ?? typeof(object));

    /// <summary>Every public instance property with a setter, which is exactly what a whole-record write can drop.</summary>
    private static PropertyInfo[] WritableProperties(Type type) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(property => property.SetMethod is not null)
            .ToArray();

    /// <summary>
    /// Drive the Mod's real persist entry point. ModEntry is created uninitialized because
    /// the scope persist touches only the loaded config, the helper it writes through and
    /// the monitor it reports to.
    /// </summary>
    private static ModConfig PersistVerifiedFarmhandScope(ModConfig loaded, string saveId, string worldId, string playerId)
    {
        var helper = DispatchProxy.Create<IModHelper, WritingConfigHelper>();
        var modEntry = (ModEntry)RuntimeHelpers.GetUninitializedObject(typeof(ModEntry));
        SetModField(modEntry, "<Helper>k__BackingField", helper);
        SetModField(modEntry, "<Monitor>k__BackingField", new DummyMonitor());
        typeof(ModEntry).GetField("config", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(modEntry, loaded);

        typeof(ModEntry)
            .GetMethod("PersistVerifiedFarmhandScope", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(modEntry, new object[] { new FarmhandVerifiedScope(saveId, worldId, playerId) });

        return (ModConfig)typeof(ModEntry).GetField("config", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(modEntry)!;
    }

    private static void SetModField(object modEntry, string name, object value) =>
        typeof(Mod).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(modEntry, value);

    /// <summary>
    /// An instance of <paramref name="type"/> whose every writable property differs from the
    /// type's own initializer default.
    /// </summary>
    private static object NonDefaultInstance(Type type)
    {
        object defaults = Activator.CreateInstance(type)!;
        object instance = Activator.CreateInstance(type)!;
        foreach (PropertyInfo property in WritableProperties(type))
            property.SetValue(instance, NonDefaultValue(property.PropertyType, property.GetValue(defaults)));
        return instance;
    }

    private static object NonDefaultValue(Type type, object? current)
    {
        if (type == typeof(string))
            return "nondefault:" + (string?)current;
        if (type == typeof(bool))
            return !(bool)(current ?? false);
        if (type == typeof(int))
            return (int)(current ?? 0) + 1;
        if (typeof(IEnumerable).IsAssignableFrom(type))
        {
            object list = Activator.CreateInstance(type)!;
            ((IList)list).Add("nondefault_item");
            return list;
        }
        // A nested config type carries no initializer default, so any instance is a
        // non-default value; fill it the same way so its own fields are armed too.
        return NonDefaultInstance(type);
    }

    private class WritingConfigHelper : DispatchProxy
    {
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod?.Name == "WriteConfig")
                return null;
            throw new NotSupportedException(targetMethod?.Name);
        }
    }
}
