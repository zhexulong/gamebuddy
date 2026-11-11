using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Sensory;
using StardewValley;
using StardewValley.Menus;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE GATE FOR THE MODAL-FACT FAMILY: every <see cref="IClickableMenu"/> subtype the engine can mount leaves a
/// published fact when it is mounted, and a new subtype cannot slip in unobserved.
///
/// <para>
/// THE POPULATION COMES FROM THE AUTHORITY. The set is the transitive closure of <c>IClickableMenu</c> over the
/// decompiled tree (<c>ref/external/StardewValleyDecompiled</c>) - not a list anybody maintains. A hand-written list
/// would only ever cover the menus its author remembered, which is the defect this exists for: the companion called
/// <c>stardew_observe</c> four times in 44 minutes of the last live run, so a <c>ShippingMenu</c> or a
/// <c>LevelUpMenu</c> that nothing published was a menu she never learned about.
/// </para>
///
/// <para>
/// THE PROPERTY IS EXERCISED THROUGH THE REAL PATH. Each type is mounted into the engine's own slot and pushed through
/// <see cref="ModalTransitionObserver.Observe"/> with an authenticated bridge session behind it, so what is asserted is
/// the fact that actually leaves - not what <see cref="ModalTransitionObserver.Describe"/> would say if the observer
/// asked it. A type skipped anywhere on that path fails with its own name.
/// </para>
///
/// <para>
/// WHY NO TYPE IS EXEMPT. The observer reads the engine's one menu slot and never branches on the type, so there is no
/// menu it skips; the second bucket (<c>menu_not_observed:&lt;type&gt;:&lt;reason&gt;</c>) is therefore empty rather
/// than filled with categories somebody guessed at. A dialogue box is covered by the same fact as every other menu -
/// what it is not covered for is its WORDS, which belong to <c>npc_dialogue_presented</c>
/// (<see cref="ModalTransitionObserverTests.ADialogueBoxPublishesNoWordsBecauseTheDialogueFactOwnsThem"/>).
/// </para>
/// </summary>
public sealed class ModalTransitionFactCoverageTests
{
    private const string DecompiledRelativePath = "ref/external/StardewValleyDecompiled";
    private const string MenuBaseTypeName = "IClickableMenu";

    /// <summary>Every class declaration and the base list it names, whatever its access modifiers and modifiers.</summary>
    private static readonly Regex Declaration = new(
        @"^\s*(?:public|internal|protected|private)?\s*(?:sealed\s+|abstract\s+|static\s+|partial\s+|unsafe\s+)*class\s+(?<name>[A-Za-z_]\w*)\s*(?:<[^>{]*>)?\s*:\s*(?<bases>[^{/\r\n]+)",
        RegexOptions.Multiline | RegexOptions.Compiled);

    private readonly ITestOutputHelper output;

    public ModalTransitionFactCoverageTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryEngineMenuSubtypeLeavesAPublishedFactWhenItIsMounted()
    {
        IReadOnlyList<Type> population = EngineMenuPopulation();
        population.Should().NotBeEmpty("an empty population means the tree was not read, which is a blocked reading, not a pass");

        this.output.WriteLine($"modal_fact_population:{population.Count}:{string.Join(",", population.Select(type => type.Name))}");
        this.output.WriteLine("modal_fact_not_observed:0:the_observer_reads_the_engines_one_menu_slot_and_never_branches_on_type");

        var uncovered = new List<string>();
        using var game = new ModalFactProbe.GameStateScope();
        BridgeSession session = ModalFactProbe.CreateAuthenticatedSession(out ModalFactProbe.RecordingSink sink);
        foreach (Type type in population)
        {
            int before = sink.Emissions;
            game.SetActiveMenu(ModalFactProbe.Menu(type));
            // A fresh observer per type: it starts with an empty slot, so this is one MOUNT and the menu the previous
            // type left behind is not also reported as dismissed.
            new ModalTransitionObserver(new DummyMonitor(), static () => true).Observe(session);

            if (sink.Emissions != before + 1
                || sink.FactAt(before).Kind != ModalPresentedPayload.Kind
                || ModalFactProbe.PayloadOf(sink.FactAt(before)).GetProperty("modalType").GetString() != type.Name)
            {
                uncovered.Add($"modal_without_a_fact:{type.Name}");
            }
        }

        uncovered.Should().BeEmpty(
            "every engine menu subtype must leave one modal_presented fact naming its own type; uncovered: "
            + string.Join(", ", uncovered));
    }

    [Fact]
    public void ThePopulationAgreesWithTheAssemblyThatShipsThoseMenus()
    {
        // The derivation reads C# text; the assembly is the same fact spelled by the compiler. Two readings that must
        // agree, so a regex that stopped matching one declaration form cannot quietly narrow the population the gate
        // above is measured against.
        IReadOnlyList<Type> population = EngineMenuPopulation();
        string[] fromAssembly = typeof(IClickableMenu).Assembly.GetTypes()
            .Where(type => !type.IsAbstract && !type.IsGenericTypeDefinition && typeof(IClickableMenu).IsAssignableFrom(type))
            .Select(type => type.Name)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        population.Select(type => type.Name).Should().Equal(
            fromAssembly,
            "the population is read from the decompiled source, so it must name exactly the menus the game declares");

        population.Should().HaveCountGreaterThan(
            50,
            "a derivation that collapsed to a handful of types has stopped reading the tree, which is not a clean result");
    }

    /// <summary>
    /// Every concrete <see cref="IClickableMenu"/> subtype the decompiled tree declares, resolved against the game
    /// assembly. A declared name the assembly does not carry is a blocked reading, never a silent omission.
    /// </summary>
    private static IReadOnlyList<Type> EngineMenuPopulation()
    {
        string root = DecompiledRoot();
        var declarations = new Dictionary<string, string[]>(StringComparer.Ordinal);
        foreach (string file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            string source = File.ReadAllText(file);
            foreach (Match match in Declaration.Matches(source))
            {
                string name = match.Groups["name"].Value;
                // A simple-name collision cannot invent a menu: every resolved name is checked against the assembly,
                // and the decompiled tree's duplicate names are none of them menus.
                if (declarations.ContainsKey(name))
                    continue;
                declarations[name] = match.Groups["bases"].Value
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(basis => basis.Split('<')[0].Split('.')[^1].Trim())
                    .ToArray();
            }
        }

        var closure = new HashSet<string>(StringComparer.Ordinal) { MenuBaseTypeName };
        bool grew = true;
        while (grew)
        {
            grew = false;
            foreach ((string name, string[] bases) in declarations)
            {
                if (closure.Contains(name) || !bases.Any(closure.Contains))
                    continue;
                closure.Add(name);
                grew = true;
            }
        }

        closure.Remove(MenuBaseTypeName);

        Type[] gameTypes = typeof(IClickableMenu).Assembly.GetTypes();
        var population = new List<Type>(closure.Count);
        foreach (string name in closure)
        {
            Type? type = gameTypes.FirstOrDefault(candidate => candidate.Name == name);
            type.Should().NotBeNull(
                $"the decompiled tree declares {name} as an IClickableMenu subtype, so the shipped assembly must declare it too (modal_population_unreadable:{name})");
            if (type!.IsAbstract || type.IsGenericTypeDefinition)
                continue;
            population.Add(type);
        }

        return population.OrderBy(type => type.Name, StringComparer.Ordinal).ToArray();
    }

    private static string DecompiledRoot()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            string candidate = Path.Combine(directory.FullName, DecompiledRelativePath);
            if (Directory.Exists(candidate))
                return candidate;
        }

        throw new DirectoryNotFoundException($"{DecompiledRelativePath} is not reachable from {AppContext.BaseDirectory}");
    }
}
