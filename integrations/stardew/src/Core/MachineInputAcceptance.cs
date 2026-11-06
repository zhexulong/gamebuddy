using System;
using System.Collections.Generic;
using System.Globalization;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// One <c>ItemPlacedInMachine</c> trigger row of <c>Data/Machines</c>, as the engine's admission matcher reads it.
///
/// <para>
/// The field set is not this type's invention: <c>MachineDataUtility.CanApplyOutput</c> (decompiled game source,
/// <c>StardewValley/MachineDataUtility.cs:65-102</c>) consults exactly these four facts for one trigger - the
/// <c>Trigger</c> flag (already filtered to <c>ItemPlacedInMachine</c> by the caller), <c>RequiredItemId</c>,
/// <c>RequiredTags</c>, <c>RequiredCount</c>, plus the row's <c>Condition</c> game-state query. The Mod fills one of
/// these per row from the live <c>MachineOutputTriggerRule</c>; nothing is decided here.
/// </para>
/// </summary>
/// <param name="RequiredItemId">The single item this trigger takes, or null when it selects by tag or by nothing.</param>
/// <param name="RequiredTags">The context tags an input must ALL carry, or null when the row selects by id or by nothing.</param>
/// <param name="RequiredCount">How many of the input the row consumes, and the stack below which it does not match.</param>
/// <param name="Conditioned">Whether the row is gated on a <c>GameStateQuery</c> the engine evaluates at load time.</param>
public readonly record struct MachineInputTriggerRule(
    string? RequiredItemId,
    IReadOnlyList<string>? RequiredTags,
    int RequiredCount,
    bool Conditioned);

/// <summary>
/// What one machine's own rows say it takes, as the snapshot publishes it on the machine's target row.
///
/// <para>
/// WHY THIS IS A PUBLISHED FACT. `machine_load` was made data-driven: it asks the machine itself
/// (<c>performObjectDropInAction(probe: true)</c>) and refuses an unaccepted input with
/// <c>machine_load_unsupported_input</c>, naming the inputs the machine's rows declare. Discovery, meanwhile, published
/// every object with machine data as a loadable target and said nothing about what it takes, so a furnace arrived in
/// front of the model as a load target with no statement of inputs - measured 2026-10-31, the model loaded coffee beans
/// into a furnace and the refusal blamed the player's inventory. The refusing layer named the truth; the row that
/// PROMISED did not. This type is that promise, derived from the same trigger rows the refusal reads.
/// </para>
/// <para>
/// THREE STATES, AND THEY ARE DIFFERENT FACTS: <c>null</c> acceptance = the engine data cannot answer (unknown),
/// <see cref="Inputs"/> empty = the machine declares no load input at all (nothing), and a non-empty bounded list with
/// <see cref="Omitted"/> = the rows, capped. Collapsing unknown into nothing, or into an empty list, is the defect this
/// exists to prevent.
/// </para>
/// <para>
/// BOUNDED AND DETERMINISTIC: entries keep the rows' own order and are deduplicated, the list is capped at
/// <see cref="InputLimit"/>, and everything past the cap is counted in <see cref="Omitted"/> rather than silently
/// dropped - so the same machine publishes the same list on every frame and a reader can tell how much it is not
/// seeing.
/// </para>
/// </summary>
public sealed record MachineInputAcceptance(IReadOnlyList<string> Inputs, int Omitted)
{
    /// <summary>How many entries one machine row may carry; the rest is counted in <see cref="Omitted"/>.</summary>
    public const int InputLimit = 8;

    /// <summary>The selector of a row that names neither an item id nor a tag: the engine admits any input there.</summary>
    public const string AnyItemSelector = "any";

    /// <summary>Prefix of a selector that names context tags rather than an item id.</summary>
    public const string TagSelectorPrefix = "tag:";

    /// <summary>Suffix of an entry whose row is gated on a game-state query, so the entry is conditional.</summary>
    public const char ConditionedSuffix = '?';

    /// <summary>
    /// The acceptance these trigger rows declare, or null when the engine data cannot answer.
    ///
    /// <paramref name="rules"/> null means UNKNOWN - the machine data itself could not be read. An empty sequence is
    /// NOT unknown: it means the machine data was read and it declares no item-placed trigger, which the engine's matcher
    /// (<c>CanApplyOutput</c>) can never match, so the machine takes no load.
    /// </summary>
    public static MachineInputAcceptance? Derive(IReadOnlyList<MachineInputTriggerRule>? rules)
    {
        if (rules is null) return null;
        List<string> entries = new();
        foreach (MachineInputTriggerRule rule in rules)
        {
            string entry = Describe(rule);
            if (!entries.Contains(entry)) entries.Add(entry);
        }

        int shown = Math.Min(entries.Count, InputLimit);
        string[] inputs = new string[shown];
        for (int index = 0; index < shown; index += 1) inputs[index] = entries[index];
        return new MachineInputAcceptance(inputs, entries.Count - shown);
    }

    /// <summary>One row's entry: its selector, the count it takes, and the marker when the row is conditional.</summary>
    private static string Describe(MachineInputTriggerRule rule)
    {
        string selector = rule.RequiredItemId is { Length: > 0 } requiredItemId
            ? requiredItemId
            : rule.RequiredTags is { Count: > 0 } requiredTags
                ? $"{TagSelectorPrefix}{string.Join("+", requiredTags)}"
                : AnyItemSelector;
        string count = $"x{rule.RequiredCount.ToString(CultureInfo.InvariantCulture)}";
        return rule.Conditioned ? $"{selector} {count}{ConditionedSuffix}" : $"{selector} {count}";
    }
}
