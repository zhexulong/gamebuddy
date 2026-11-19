using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE GATE FOR "A PARAMETER THE AGENT MUST SUPPLY HAS A PRODUCER": every argument of every mounted action must be
/// answerable from something the product PUBLISHES, and the three ways it can fail are counted separately because
/// they have three different owners.
///
/// <para>
/// THE POPULATION IS THE CATALOG. <see cref="FarmhandActionCatalog.Registrations"/> is the same authority the Agent's
/// action surface is built from, so an action added tomorrow is examined without anybody remembering to add it here.
/// Zero examined arguments is a blocked reading, not a pass.
/// </para>
///
/// <para>
/// THE FOUR OUTCOMES, and why they are not one number:
/// </para>
/// <list type="bullet">
/// <item><b>supplied by the catalog</b> - the argument carries a declared enum (<see cref="FarmhandActionCatalog.DirectionEnum"/>
/// and its siblings). A closed vocabulary is a producer: the Agent picks a member of a published set.</item>
/// <item><b>supplied by a published row</b> - the action names a <c>TargetFamily</c> and the argument is a field of that
/// family's row, matched by NAME against the row record the snapshot actually serializes. The match is the invariant:
/// one spelling for one concept, so a row that renames a field fails here instead of leaving the Agent to guess.</item>
/// <item><b>dropped by a renderer</b> - the value leaves the Mod and a reader on the far side discards it, so the debt is
/// in the RENDERER and its owner is the file named beside it.</item>
/// <item><b>unpublished</b> - nothing outside prose states it. This is the only one that is a missing producer.</item>
/// </list>
///
/// <para>
/// WHY THE DROPPED ENTRIES EXPIRE. <c>responseKey</c>'s value is published by the Mod and discarded by the Host's
/// <c>worldFactLine</c>: it maps each <c>choices[]</c> entry to its <c>text</c> and never reads its <c>key</c>. That is
/// recorded here as a DEBT with the exact site, and each debt is re-read from the renderer's own source on every run -
/// the day that site starts reading the key, this gate goes red naming the entry that must be deleted. An exemption
/// nobody re-checks is how a gate stops being one.
/// </para>
///
/// <para>
/// MEASURED, round80 (<c>.live-runs/game-ladder/2026-11-19T21-44-19-653Z-multiday_routine</c>): 24
/// <c>npc_dialogue_presented</c> facts, every one of them <c>question=false</c>, so <c>answer_dialogue</c> was never
/// offered a box to answer; a <c>LevelUpMenu</c> stood for a night while <c>pendingLevelUps</c> read <c>[]</c>. The
/// rate (zero answers) and the population (zero answerable dialogues) are two different facts, and the gate is what
/// separates them.
/// </para>
/// </summary>
public sealed class AParameterTheAgentSuppliesHasAProducerGateTests
{
    /// <summary>Which debt an argument carries, and therefore which owner fixes it.</summary>
    private enum Production
    {
        /// <summary>A published field or a declared enum states every value the argument can take.</summary>
        Supplied,

        /// <summary>The value leaves the Mod and a named reader throws it away. The RENDERER is the debt.</summary>
        DroppedByRenderer,

        /// <summary>Nothing but prose states it. The producer is missing.</summary>
        Unpublished,
    }

    /// <summary>
    /// One argument's producer, where the default rules cannot answer: a declared enum, or a row field of the action's
    /// own <c>TargetFamily</c> whose NAME is the argument's name.
    /// <see cref="Site"/> is what supplies it (a member, verified to exist) or what drops it (a repository file).
    /// </summary>
    private sealed record DeclaredProducer(
        string ActionId,
        string Argument,
        Production Production,
        string Site,
        string? Reader = null,
        string? DroppedField = null);

    /// <summary>
    /// The producer of an argument NAME, in the order the gate asks: a declared enum, a target family's row field, or a
    /// value the Agent composes itself. The table is keyed by the argument's NAME because one spelling is one concept:
    /// an action that calls its target `expectedTargetId` and one that calls it `targetId` are naming the SAME published
    /// field, and a new action reusing either name is answered without an entry of its own.
    /// </summary>
    /// <param name="RowField">For a row field: the field on the action's target-family record that carries it.</param>
    /// <param name="Reason">For a composed value: why no producer is needed.</param>
    private sealed record ArgumentProducer(string RowField = "", string Reason = "");

    private static readonly IReadOnlyDictionary<string, ArgumentProducer> Producers =
        new Dictionary<string, ArgumentProducer>(StringComparer.Ordinal)
        {
            ["buildingType"] = new("BuildingType"),
            ["chestId"] = new("ChestId"),
            ["colorSelection"] = new("Color"),
            ["expectedLevel"] = new("Level"),
            ["expectedQualifiedItemId"] = new("QualifiedItemId"),
            ["expectedSkill"] = new("Skill"),
            ["expectedTargetId"] = new("TargetId"),
            ["leftSlot"] = new("LeftSlot"),
            ["rightSlot"] = new("RightSlot"),
            ["slot"] = new("Slot"),
            ["x"] = new("X"),
            ["y"] = new("Y"),
            // COMPOSED: the Agent writes the words. Nothing in the world states a chat line or a sign's text, and a
            // producer for either would be the product authoring the player's sentence.
            ["text"] = new(Reason: "the Agent composes the words; no world value can state them"),
            // COMPOSED: the Agent names where it is going. The rows that make a destination REAL - `warps`,
            // `doorTargets`, `mineCartTargets` - are what bound the choice, and they are published.
            ["destination"] = new(Reason: "the Agent names the destination; `warps`/`doorTargets` publish the ones that exist"),
        };

    /// <summary>
    /// The arguments the two default rules cannot place, each with the reading that places it. Everything not named
    /// here is answered by its own catalog enum or by its target family's row field of the same name, so this list
    /// carries only what somebody had to look at.
    /// </summary>
    private static readonly IReadOnlyList<DeclaredProducer> Declared = new[]
    {
        // THE DROP. `NpcDialogueChoice.Key` is `Response.responseKey` (`DialogueBox.cs:18`, filled by
        // `Dialogue.getResponseOptions()` at `:612` and by the ctor at `:122`), and the dialogue fact publishes it as
        // `choices[].key`. The Host's `worldFactLine` maps each entry to `text` only, so the one token `answer_dialogue`
        // accepts back never reaches the Agent. The debt is the renderer's; the entry expires when it reads `key`.
        new DeclaredProducer(
            "answer_dialogue",
            "responseKey",
            Production.DroppedByRenderer,
            "NpcDialogueChoice.Key",
            Reader: "host/src/fact-brief.ts",
            DroppedField: "key"),
    };

    private readonly ITestOutputHelper output;

    public AParameterTheAgentSuppliesHasAProducerGateTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryArgumentTheCatalogRequiresIsProducedBySomethingTheProductPublishes()
    {
        var examined = new List<(string Action, FarmhandActionArgument Argument)>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            // THE MODAL FAMILY, because it is the set whose arguments the run actually failed on: round80 stood a
            // `LevelUpMenu` for a whole night with nothing dispatched, and the one question-shaped modal it met was
            // the engine's bed prompt, which `answer_dialogue` refuses by design. The population is the catalog's own
            // handler group - an action moved into this family is examined without an edit here.
            if (registration.HandlerGroup != FarmhandActionHandlerGroup.Modal)
                continue;
            foreach (FarmhandActionArgument argument in registration.Descriptor?.Arguments ?? Array.Empty<FarmhandActionArgument>())
                examined.Add((registration.ActionId, argument));
        }

        examined.Should().NotBeEmpty(
            "an empty population means the catalog was not read, which is a blocked reading rather than a pass");

        var supplied = new List<string>();
        var dropped = new List<string>();
        var unpublished = new List<string>();

        foreach ((string action, FarmhandActionArgument argument) in examined)
        {
            DeclaredProducer? declared = Declared.FirstOrDefault(
                entry => string.Equals(entry.ActionId, action, StringComparison.Ordinal)
                    && string.Equals(entry.Argument, argument.Name, StringComparison.Ordinal));
            Production production;
            string site;
            string? reader;
            if (declared is null)
            {
                production = Classify(action, argument, out site, out reader);
            }
            else
            {
                production = declared.Production;
                site = declared.Site;
                reader = declared.Reader;
            }

            switch (production)
            {
                case Production.Supplied:
                    supplied.Add($"{action}.{argument.Name}<-{site}");
                    break;
                case Production.DroppedByRenderer:
                    // The debt is only still a debt if the reader still drops it. Re-read it every run.
                    ReadRepositoryText(reader!)
                        .Should().NotContain(
                            $"choice as {{ {declared!.DroppedField}:",
                            $"the renderer {reader} now reads `{declared.DroppedField}`, so {action}.{argument.Name} "
                            + "is supplied and this entry must be deleted from the gate's Declared list");
                    dropped.Add($"{action}.{argument.Name}:{reader}:drops_{declared.DroppedField}");
                    break;
                default:
                    unpublished.Add($"{action}.{argument.Name}");
                    break;
            }
        }

        this.output.WriteLine(
            $"a_parameter_the_agent_supplies_has_a_producer: examined {examined.Count} arguments · supplied "
            + $"{supplied.Count} · dropped {dropped.Count} · unpublished {unpublished.Count}");
        foreach (string entry in dropped)
            this.output.WriteLine($"  dropped_by_renderer {entry}");
        foreach (string entry in unpublished)
            this.output.WriteLine($"  unpublished {entry}");

        unpublished.Should().BeEmpty(
            "a required argument no published field states is a parameter the Agent can only guess: "
            + string.Join(", ", unpublished));

        dropped.Should().HaveCount(
            Declared.Count(entry => entry.Production == Production.DroppedByRenderer),
            "every dropped argument is a registered debt with a named reader and an expiring entry: "
            + string.Join(", ", dropped));

        supplied.Should().HaveCount(
            examined.Count - dropped.Count,
            "every remaining argument must have a published producer, naming it: " + string.Join(", ", supplied));
    }

    /// <summary>
    /// The three default rules, in the order they are asked: a declared enum states the argument's whole domain; a
    /// declared producer names the row field or the reason it is composed; a target family whose row carries the
    /// argument's own name states its values.
    /// </summary>
    private static Production Classify(string actionId, FarmhandActionArgument argument, out string site, out string? reader)
    {
        reader = null;
        if (argument.Enum is { Count: > 0 })
        {
            site = $"{actionId}.{argument.Name}::catalog_enum({string.Join("|", argument.Enum)})";
            return Production.Supplied;
        }

        FarmhandActionDescriptor? descriptor = FarmhandActionCatalog.Registrations
            .FirstOrDefault(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal))
            ?.Descriptor;
        string family = descriptor?.TargetFamily ?? string.Empty;

        if (Producers.TryGetValue(argument.Name, out ArgumentProducer? producer))
        {
            if (producer.RowField.Length == 0)
            {
                site = $"{actionId}.{argument.Name}::composed({producer.Reason})";
                return Production.Supplied;
            }

            if (RowFieldOf(family, producer.RowField) is string declaredField)
            {
                site = declaredField;
                return Production.Supplied;
            }

            site = $"{actionId}.{argument.Name}::{family}:no_field:{producer.RowField}";
            return Production.Unpublished;
        }

        if (family.Length > 0 && RowFieldOf(family, argument.Name) is string field)
        {
            site = field;
            return Production.Supplied;
        }

        site = $"{actionId}.{argument.Name}::{family}:no_declared_producer";
        return Production.Unpublished;
    }

    /// <summary>
    /// The published row field that carries <paramref name="argument"/>, found by NAME over the record the snapshot
    /// serializes for <paramref name="family"/> - the same <see cref="BridgeSnapshot"/> property the projection fills,
    /// so a family that stops being published, or a row that renames the field, fails here rather than at runtime.
    /// </summary>
    private static string? RowFieldOf(string family, string argument)
    {
        PropertyInfo? rows = typeof(BridgeSnapshot).GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(property => string.Equals(property.Name, family, StringComparison.OrdinalIgnoreCase));
        if (rows is null)
            return null;

        Type? element = ElementTypeOf(rows.PropertyType);
        if (element is null)
            return null;

        PropertyInfo? field = element.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(property => string.Equals(property.Name, argument, StringComparison.OrdinalIgnoreCase));
        return field is null ? null : $"{element.Name}.{field.Name}";
    }

    private static Type? ElementTypeOf(Type type)
    {
        if (type.IsArray)
            return type.GetElementType();
        foreach (Type candidate in type.GetInterfaces().Append(type))
        {
            if (!candidate.IsGenericType)
                continue;
            if (candidate.GetGenericTypeDefinition() != typeof(IEnumerable<>))
                continue;
            return candidate.GetGenericArguments()[0];
        }

        return null;
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string ReadRepositoryText(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException(
            $"repository path not found: {relative} (a debt whose reader cannot be read is a blocked reading)");
    }
}
