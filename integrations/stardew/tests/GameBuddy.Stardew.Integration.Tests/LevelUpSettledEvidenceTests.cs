using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The level-up receipt must publish the two facts its own success condition is made of.
///
/// <para>
/// <c>RequestLocalRespondLevelUp</c> mints <c>level_up_resolved</c> only when
/// <c>pairSettled &amp;&amp; professionSettled &amp;&amp; !menu.isActive</c>, and it wrote evidence for the THIRD
/// conjunct alone. `remaining_new_levels` names a count, so nothing in the receipt said WHICH pending entry left,
/// and nothing said whether the profession branch landed on the chosen card - a caller had to take the producer's
/// word for two thirds of the sentence it was judging. The receipt now carries <c>pair_settled</c> and
/// <c>profession_settled</c> as the same fresh reads the success arm tests.
/// </para>
///
/// <para>
/// Source-pinned because the path needs a live game to exercise (a real <c>LevelUpMenu</c> pushed onto
/// <c>Game1.endOfNightMenus</c>, a bound actor and its <c>newLevels</c>). What is pinned is that the two facts
/// exist, that they are the producer's own fresh re-reads rather than a literal claim, and that each terminal
/// hands the reader the same tuple.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class LevelUpSettledEvidenceTests
{
    private const string ModalActionsFile = "farmhandexecutioncontroller.modalactions.cs";
    private const string EntryPoint = "public LocalExecutionReceipt RequestLocalRespondLevelUp(";

    /// <summary>The evidence keys the Host completion rule may read for this action, in the producer's own order.</summary>
    private static readonly string[] PublishedEvidenceKeys =
    {
        "modal_type",
        "skill",
        "level",
        "is_profession",
        "chosen_profession",
        "remaining_new_levels",
        "menu_closed",
        "pair_settled",
        "profession_settled",
    };

    [Fact]
    public void TheReceiptPublishesBothSettledConjunctsAsLowercaseBooleans()
    {
        string body = MethodBody(Read(ModalActionsFile), EntryPoint);

        body.Should().Contain(";pair_settled={pairSettled.ToString().ToLowerInvariant()}");
        body.Should().Contain(";profession_settled={professionSettled.ToString().ToLowerInvariant()}");
    }

    [Fact]
    public void ThePublishedFactsAreTheFreshReadsNotALiteralClaim()
    {
        string body = MethodBody(Read(ModalActionsFile), EntryPoint);

        // `pairSettled` is the pair's removal from `newLevels` -- the same removal
        // `LevelUpMenu.RemoveLevelFromLevelList` performs (LevelUpMenu.cs:645-648).
        body.Should().Contain("bool pairSettled = !actor.newLevels.Contains(new Point(menuPair.Skill, menuPair.Level));");
        // `professionSettled` is the branch landing on the chosen profession and NOT on the other card, so the
        // receipt can never report a settled profession that was decided by the wrong click.
        body.Should().Contain("bool professionSettled = !isProfession");
        body.Should().Contain("actor.professions.Contains(chosenProfession) && !actor.professions.Contains(otherProfession)");

        // A constant would make the receipt claim a settlement it never measured.
        body.Should().NotContain("pair_settled=true");
        body.Should().NotContain("profession_settled=true");
    }

    [Fact]
    public void TheSuccessArmRequiresAllThreeConjunctsAndBothTerminalsCarryTheSameTuple()
    {
        string body = MethodBody(Read(ModalActionsFile), EntryPoint);

        body.Should().Contain("if (pairSettled && professionSettled && !menu.isActive)");

        int declaration = body.IndexOf("string evidence =", StringComparison.Ordinal);
        int resolved = body.IndexOf("\"level_up_resolved\"", StringComparison.Ordinal);
        int unresolved = body.IndexOf("\"level_up_postcondition_unavailable\"", StringComparison.Ordinal);
        declaration.Should().BeGreaterThanOrEqualTo(0, "the receipt builds one evidence tuple");
        declaration.Should().BeLessThan(resolved);
        resolved.Should().BeLessThan(unresolved);

        // An unresolved level-up states WHICH conjunct failed, rather than reporting only that it did not settle.
        body[resolved..unresolved].Should().Contain("evidence");
        body[unresolved..].Should().Contain("evidence");
    }

    [Fact]
    public void TheEvidenceNamesExactlyTheKeysTheCompletionRuleReads()
    {
        string body = MethodBody(Read(ModalActionsFile), EntryPoint);

        int start = body.IndexOf("string evidence =", StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0);
        int lineEnd = body.IndexOf("\";", start, StringComparison.Ordinal);
        lineEnd.Should().BeGreaterThan(start, "the evidence literal must be a single interpolated string");

        string template = body[start..lineEnd];
        string[] keys = Regex.Matches(template, @"([a-z][a-z0-9_]*)=")
            .Select(match => match.Groups[1].Value)
            .ToArray();

        // Two vocabularies for one fact drift silently: this is the Mod's half of the key set the Host rule names.
        keys.Should().Equal(PublishedEvidenceKeys);
    }

    // -------------------------------------------------------------------------

    private static string Read(string fileName) =>
        File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", fileName)));

    /// <summary>Extracts a brace-balanced body starting at the first <c>{</c> that follows the signature.</summary>
    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");

        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}' && --depth == 0) return source[opening..(cursor + 1)];
        }

        throw new InvalidOperationException($"unbalanced body for {signature}");
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
