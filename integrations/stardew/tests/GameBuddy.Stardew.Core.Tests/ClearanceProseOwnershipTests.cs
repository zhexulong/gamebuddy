using System.Collections;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The gate for `a_mod_decides_something_the_conversation_owns`: a refusal or a hint the Mod publishes is a CODE AND ITS
/// FACTS, and the sentence a reader sees is composed on the Host, which owns the prompt and the locale.
///
/// <para>
/// THE DEFECT CLASS. A sentence in this assembly is a sentence the Host cannot re-word: it shipped in English inside a
/// Chinese run, and changing one word of it was a Mod release. The sentence that existed said what a withheld scythe swing
/// would cost the crop, and reaching the model at all cost four records
/// (declaration -> offer -> clearance -> row -> the aggregate's free-text field) - every one of them a place the Mod
/// decided something the conversation owns.
/// </para>
/// <para>
/// POPULATION, and nothing here is a hand-written list of producers:
/// <list type="bullet">
/// <item>every `Clears` declaration the action catalogue carries, read from
/// <see cref="FarmhandActionCatalog.Registrations"/>;</item>
/// <item>every occupant/requested-action/policy answer the healing join can give for those declarations
/// (<see cref="FarmhandForEachHealing.ClearanceFor"/>), including its policy-disabled branch and the branch where the
/// requested action is itself the clearer;</item>
/// <item>the pass a refused row settles in, driven through <see cref="FarmhandForEachExpansion.Expand"/> so the row record
/// and its receipt are examined as the Mod produces them.</item>
/// </list>
/// Each produced value is walked REFLECTIVELY, so a prose field re-added under any name is examined without an edit here.
/// The property is one rule: no produced string may read as a sentence, because a reason code is a token.
/// </para>
/// <para>
/// It prints `producers examined P · codes-only C · composes-words W`, and W&gt;0 FAILS naming the producer and the words it
/// composed. The falsifier is <see cref="TheJudgementIsRedForAProducerThatComposesWords"/>: the same judging code, given one
/// record that carries a sentence, reports W=1 and names it - so a green reading here means the producers were read and
/// were silent, not that the judge cannot speak.
/// </para>
/// </summary>
public sealed class ClearanceProseOwnershipTests
{
    [Fact]
    public void AModDecidesNothingTheConversationOwns()
    {
        Verdict verdict = Judge(Producers());

        verdict.Examined.Should().BeGreaterThan(0, "the population comes from the catalogue and the join, so zero means the derivation stopped matching");
        verdict.StringsExamined.Should().BeGreaterThan(0, "a run that read no string at all has not judged anything");
        verdict.Composes.Should().BeEmpty(
            "producers examined {0} · codes-only {1} · composes-words {2}: a refusal or a hint the Mod publishes is a code "
            + "and its facts, and the sentence a reader sees belongs to the Host (`host/src/stardew-action-remedy.ts`). "
            + "Members: {3}",
            verdict.Examined,
            verdict.CodesOnly,
            verdict.Composes.Count,
            string.Join(" | ", verdict.Composes));

        Console.WriteLine($"producers examined {verdict.Examined} · codes-only {verdict.CodesOnly} · composes-words {verdict.Composes.Count}");
    }

    /// <summary>
    /// The FALSIFIER: the judging code, handed one producer that carries a sentence, must name it.
    ///
    /// The record below is the DEFUNCT SHAPE - a declaration that says what its swing would cost, in words - so this replays
    /// the defect against the real judge rather than writing a second judge that agrees with the first.
    /// </summary>
    [Fact]
    public void TheJudgementIsRedForAProducerThatComposesWords()
    {
        const string sentence =
            "The crop on this tile is one you planted: scythe_crop levels it and loses the harvest.";
        Verdict verdict = Judge(new List<(string Producer, object? Produced)>
        {
            ("prose_again", new ProseCarryingDeclaration("crop", true, sentence)),
        });

        verdict.Examined.Should().Be(1);
        verdict.Composes.Should().ContainSingle("one producer composed one sentence");
        verdict.Composes[0].Producer.Should().Be("prose_again");
        verdict.Composes[0].Words.Should().Contain(sentence);
    }

    [Fact]
    public void AJudgeThatExaminedNothingSaysSo()
    {
        // Zero population is BLOCKED, never green: an empty list agrees with itself.
        Verdict verdict = Judge(new List<(string Producer, object? Produced)>());

        verdict.Examined.Should().Be(0);
        verdict.StringsExamined.Should().Be(0);
        verdict.CodesOnly.Should().Be(0);
    }

    /// <summary>The defunct shape, kept only so the falsifier injects the defect this gate exists for.</summary>
    private sealed record ProseCarryingDeclaration(string Occupant, bool Destructive, string RefusalDetail);

    /// <summary>Every producer the clearing refusal path can answer with, read from the catalogue and driven.</summary>
    private static List<(string Producer, object? Produced)> Producers()
    {
        var producers = new List<(string Producer, object? Produced)>();
        FarmhandForEachSource strip = new(60, 18, 1, 1);

        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Descriptor?.Clears is not { } clears)
                continue;
            producers.Add(($"clears:{registration.ActionId}", clears));

            foreach (string occupant in clears.Occupants)
            {
                var fields = new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
                {
                    [FarmhandForEachHealing.OccupantField] = FarmhandForEachValue.Of(occupant),
                };
                // ALL THREE ANSWERS the join has, so no branch's words go unread: the requested action IS the clearer, it is
                // another action with the policy enabling a clearer, and it is another action with the policy disabling it.
                producers.Add(($"heal:{registration.ActionId}:{occupant}:as-requested",
                    FarmhandForEachHealing.ClearanceFor(fields, registration.ActionId, _ => true)));
                producers.Add(($"heal:{registration.ActionId}:{occupant}:other-action",
                    FarmhandForEachHealing.ClearanceFor(fields, "till_soil", _ => true)));
                producers.Add(($"heal:{registration.ActionId}:{occupant}:policy-off",
                    FarmhandForEachHealing.ClearanceFor(fields, "till_soil", _ => false)));
            }
        }

        // AND THE PASS the refusal settles in, for each occupant the catalogue declares: the row record, its reason code
        // and its receipt are examined as the expansion produces them.
        foreach (string occupant in FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.Clears is { Occupants.Count: > 0 })
            .SelectMany(registration => registration.Descriptor!.Clears!.Occupants)
            .Distinct(StringComparer.Ordinal))
        {
            var loop = new FarmhandForEachLoop(strip, null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));
            IReadOnlyList<FarmhandForEachRow> rows = new[]
            {
                new FarmhandForEachRow(60, 18, 0, 0, new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
                {
                    [FarmhandForEachHealing.OccupantField] = FarmhandForEachValue.Of(occupant),
                }),
            };
            producers.Add(($"pass:{occupant}", FarmhandForEachExpansion.Expand(
                loop,
                $"pass_ownership_{occupant}",
                rows,
                (FarmhandForEachTarget _, string _, string _, out LocalExecutionReceipt receipt, out string reasonCode) =>
                {
                    // The tile refuses the requested action and the pass may not swing the destructive clearer: exactly the
                    // branch that used to carry the sentence.
                    receipt = new LocalExecutionReceipt("exec", "req", ExecutionState.Rejected, "soil_not_diggable", 1, null);
                    reasonCode = "soil_not_diggable";
                    return true;
                },
                () => false,
                _ => true,
                _ => null)));
        }

        return producers;
    }

    internal static Verdict Judge(IEnumerable<(string Producer, object? Produced)> producers)
    {
        int examined = 0;
        int strings = 0;
        var composes = new List<WordComposition>();
        foreach ((string producer, object? produced) in producers)
        {
            examined += 1;
            var words = new List<string>();
            foreach (string value in Strings(produced))
            {
                strings += 1;
                if (ComposesWords(value)) words.Add(value);
            }
            if (words.Count > 0) composes.Add(new WordComposition(producer, words));
        }
        return new Verdict(examined, strings, examined - composes.Count, composes);
    }

    /// <summary>
    /// True when a produced string reads as a SENTENCE rather than as a code with its facts.
    ///
    /// Three readings, none of which a reason code can satisfy: whitespace (a token has none), a sentence terminator (a
    /// code's own vocabulary is `[A-Za-z0-9_:-]`, so a full stop or a question mark is prose), and 96 characters (the
    /// longest token this catalogue ships is a control name; a sentence is longer).
    /// </summary>
    private static bool ComposesWords(string value) =>
        value.Length > 96
        || value.Any(char.IsWhiteSpace)
        || value.IndexOfAny(new[] { '.', '!', '?' }) >= 0;

    /// <summary>
    /// Every string a produced value carries, walked by REFLECTION so a field re-added under a new name is still read.
    ///
    /// Primitives, enums and delegates carry no words, and the walk is bounded at depth so a produced record cannot drag a
    /// whole world behind it.
    /// </summary>
    private static IEnumerable<string> Strings(object? value, int depth = 0)
    {
        if (value is null || depth > 3) yield break;
        if (value is string text)
        {
            yield return text;
            yield break;
        }
        Type type = value.GetType();
        if (type.IsPrimitive || type.IsEnum || value is Delegate) yield break;
        if (value is IDictionary dictionary)
        {
            foreach (object? key in dictionary.Keys)
            {
                foreach (string nested in Strings(key, depth + 1)) yield return nested;
                foreach (string nested in Strings(dictionary[key], depth + 1)) yield return nested;
            }
            yield break;
        }
        if (value is IEnumerable items)
        {
            foreach (object? item in items) foreach (string nested in Strings(item, depth + 1)) yield return nested;
            yield break;
        }
        foreach (PropertyInfo property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (property.GetIndexParameters().Length > 0) continue;
            foreach (string nested in Strings(property.GetValue(value), depth + 1)) yield return nested;
        }
    }

    internal readonly record struct Verdict(int Examined, int StringsExamined, int CodesOnly, IReadOnlyList<WordComposition> Composes);

    internal readonly record struct WordComposition(string Producer, IReadOnlyList<string> Words)
    {
        public override string ToString() => $"{this.Producer} composed {string.Join(" + ", this.Words.Select(word => $"'{word}'"))}";
    }
}
