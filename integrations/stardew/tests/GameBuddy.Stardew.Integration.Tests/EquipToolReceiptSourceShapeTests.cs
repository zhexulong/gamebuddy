using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE EQUIP THAT CHANGED NOTHING SAYS SO, THE ONE THAT MOVED THE HAND SAYS THAT, AND NEITHER IS NEWS OF THE WORLD.
///
/// <para>
/// <c>equip_tool</c> has two success outcomes, and only one of them moved the hand. The words the two branches mint are
/// the ones the Host's own completion rule distinguishes - it accepts <c>tool_equipped</c> only when
/// <c>before != expected</c> and <c>already_equipped</c> only when <c>before == expected</c>
/// (<c>host/src/stardew-completion-contracts.ts</c>, the <c>equip_tool</c> row) - so a receipt whose code and evidence
/// disagree is a success the Host refuses, and the DIVISION OF LABOUR between the two branches is the whole contract this
/// file pins: which word each branch mints, and that its evidence states the relation that word claims.
/// </para>
///
/// <para>
/// <b>Why neither is published.</b> An equip is a STEP of the plan, not an event of the world:
/// <c>design/fact-authority.md</c> §1 files 「工具被装上了」 in its NOT-A-FACT column, 「属于结算的证据」, so the switch
/// has always been minted with <c>publish: false</c>. The no-op published, which made the funnel say "something happened"
/// in exactly the case where nothing did and stay silent for the case that moved the hand - the visibility of an equip
/// lives in the receipt's own <c>before</c>/<c>expected</c>/<c>after</c> fields, not in the fact stream. Both halves are
/// withheld now, and the third case below holds that for the whole handler rather than for the two branches it names.
/// </para>
///
/// <para>
/// <b>Instrument.</b> <c>RequestLocalEquipTool</c> admits the request before it can reach either branch, so no headless
/// case can mint one of these receipts; the branches are read at the source, as this suite's other handler pins are.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class EquipToolReceiptSourceShapeTests
{
    [Fact]
    public void TheEquipThatChangedNothingNamesOneToolAndIsWithheldFromTheFactStream()
    {
        string noOp = WithoutComments(NoOpBranch());

        noOp.Should().Contain("ExecutionState.Succeeded", "the request's outcome IS that the tool is in hand");
        noOp.Should().Contain(
            "\"already_equipped\"",
            "the code says the equip was already true, which is the word the Host accepts for `before == expected`");
        noOp.Should().NotContain("\"tool_equipped\"", "only the branch that moves the hand may say the switch happened");
        FarmhandActionDevelopmentContract.DeriveContract("equip_tool").Terminal.SuccessReasonCodes.Should().Contain(
            "already_equipped", "the code this branch mints is one the action's own contract declares");

        // ONE TOOL, NAMED THREE TIMES: this is what makes the receipt readable as "no change". A receipt that reached for
        // the selected tool in `expected` would be claiming a switch it never made.
        Match fields = Fields(noOp);
        fields.Groups["before"].Value.Should().Be(
            fields.Groups["expected"].Value, "a receipt whose `expected` is a different tool claims the switch this branch did not make");
        fields.Groups["after"].Value.Should().Be(
            fields.Groups["before"].Value, "and `after` is the same hand it measured before, so nothing moved");
        fields.Groups["after"].Value.Should().Be(
            fields.Groups["expected"].Value, "the Host accepts a success only where `after == expected`");

        noOp.Should().Contain(
            "publish: false",
            "an equip that did not happen is not an event of the world either - the seam must not report it as news");
    }

    [Fact]
    public void TheSwitchIsTheOnlyBranchThatClaimsAChangeAndItIsAlsoWithheld()
    {
        string switched = WithoutComments(SwitchBranch());

        switched.Should().Contain("\"tool_equipped\"", "this is the branch that moved the hand");
        switched.Should().NotContain(
            "\"already_equipped\"", "and it must not borrow the no-op's word: the Host refuses a switch that denies itself");

        Match fields = Fields(switched);
        fields.Groups["before"].Value.Should().NotBe(
            fields.Groups["expected"].Value, "`before` is the tool the hand held and `expected` the one it took - the Host accepts `tool_equipped` on that inequality alone");
        fields.Groups["after"].Value.Should().NotBe(
            fields.Groups["before"].Value, "and `after` is the hand read back once the switch landed, so this receipt states a change");

        switched.Should().Contain("publish: false", "the switch is a step of the plan, not an event of the world");
    }

    /// <summary>
    /// THE TWO OUTCOMES ARE DISTINGUISHED BY THEIR OWN RECEIPTS, AND NO SUCCESS OF THIS ACTION IS NEWS.
    ///
    /// <para>
    /// The distinction is the Host's, not this file's: one relation between two evidence fields decides which word is
    /// accepted, so the pair is read here the way the Host reads it - <c>before == expected</c> for the no-op,
    /// <c>before != expected</c> for the switch. A change that made the two branches mint the same relation would make
    /// one of them a success the Host refuses, whichever word it carried.
    /// </para>
    ///
    /// <para>
    /// The withholding is held for the WHOLE HANDLER rather than for the two branches above, because the defect this file
    /// answers was a branch that did not state its own decision and inherited <c>publish: true</c> from the sink's
    /// default. The population is every success terminal the method writes, so a third branch added tomorrow either
    /// states <c>publish: false</c> or fails here by name.
    /// </para>
    /// </summary>
    [Fact]
    public void TheTwoOutcomesAreDistinguishableByTheirOwnReceiptAndNoSuccessIsPublished()
    {
        SameTool(WithoutComments(NoOpBranch())).Should().BeTrue(
            "`already_equipped` is accepted only where the receipt's `before` and `expected` name one tool");
        SameTool(WithoutComments(SwitchBranch())).Should().BeFalse(
            "`tool_equipped` is accepted only where the receipt's `before` and `expected` name two");

        IReadOnlyList<string> successes = Terminals(
                MethodBody(Source(), "public LocalExecutionReceipt RequestLocalEquipTool("))
            .Where(call => call.Contains("ExecutionState.Succeeded", StringComparison.Ordinal))
            .ToArray();

        successes.Should().NotBeEmpty(
            "RequestLocalEquipTool must mint success outcomes, or this check is reading nothing");
        successes.Should().OnlyContain(
            call => call.Contains("publish: false", StringComparison.Ordinal),
            "a successful equip belongs to the settlement's evidence and never to the fact stream "
                + "(design/fact-authority.md §1 files 「工具被装上了」 under 不是事实)");
    }

    // ---- helpers ------------------------------------------------------------------------

    /// <summary>The branch that answers the hand already holding the best tool of the requested category.</summary>
    private static string NoOpBranch() =>
        Branch("if (ReferenceEquals(Game1.player.CurrentTool, selectedTool))", "string? expectedTool = DescribeTool(selectedTool);");

    /// <summary>The branch that reads the hand back after moving it, up to the prose that explains the withholding.</summary>
    private static string SwitchBranch() =>
        Branch("string? expectedTool = DescribeTool(selectedTool);", "// `publish: false` above is `design/fact-authority.md`");

    /// <summary>Whether one branch's `before` and `expected` name the same tool - the relation the Host's rule reads.</summary>
    private static bool SameTool(string branch)
    {
        Match fields = Fields(branch);
        return fields.Groups["before"].Value == fields.Groups["expected"].Value;
    }

    /// <summary>One receipt's three comparison fields, each asserted to exist so a missing one is not a silent match.</summary>
    private static Match Fields(string branch)
    {
        Match fields = Regex.Match(
            branch,
            @"before=\{(?<before>[^}]+)\};expected=\{(?<expected>[^}]+)\};after=\{(?<after>[^}]+)\}");
        fields.Success.Should().BeTrue($"the branch states before/expected/after: {branch}");
        return fields;
    }

    /// <summary>The text between two markers inside <c>RequestLocalEquipTool</c>, each marker asserted to exist.</summary>
    private static string Branch(string start, string end)
    {
        string body = MethodBody(Source(), "public LocalExecutionReceipt RequestLocalEquipTool(");
        int from = body.IndexOf(start, StringComparison.Ordinal);
        from.Should().BeGreaterThanOrEqualTo(0, $"`{start}` must still be how this handler states that case");
        int to = body.IndexOf(end, from, StringComparison.Ordinal);
        to.Should().BeGreaterThan(from, $"`{end}` must still follow it");
        return body[from..to];
    }

    /// <summary>
    /// Every <c>RememberTerminal</c> call inside one method, in source order, as the text between its parentheses.
    ///
    /// A paren matcher rather than a regex: the arguments are themselves calls and interpolations, so only the call's own
    /// closing parenthesis ends the split. An unbalanced body throws instead of returning a short list, because a silently
    /// narrowed population is what a gate may never be.
    /// </summary>
    private static IReadOnlyList<string> Terminals(string methodBody)
    {
        const string sink = "this.RememberTerminal(";
        List<string> calls = new();
        int from = 0;
        while (true)
        {
            int start = methodBody.IndexOf(sink, from, StringComparison.Ordinal);
            if (start < 0) return calls;
            int open = start + sink.Length - 1;
            int close = -1;
            int depth = 0;
            for (int position = open; position < methodBody.Length; position++)
            {
                if (methodBody[position] == '(') depth++;
                else if (methodBody[position] == ')' && --depth == 0)
                {
                    close = position;
                    break;
                }
            }
            if (close < 0)
                throw new InvalidOperationException(
                    "a RememberTerminal call in this method is not closed by a balanced parenthesis, so the population read here is truncated");
            calls.Add(methodBody[(open + 1)..close]);
            from = close + 1;
        }
    }

    /// <summary>
    /// Code without `//` line comments. A prose line explaining <c>publish: false</c> is not the argument: both branches
    /// are read through the same stripper every structural pin in this suite uses, so a comment cannot satisfy the
    /// assertion that describes it.
    /// </summary>
    private static string WithoutComments(string text) => string.Join(
        "\n",
        text.Split('\n').Select(line =>
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            return comment == -1 ? line : line[..comment];
        }));

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");

        int depth = 0;
        for (int position = opening; position < source.Length; position++)
        {
            if (source[position] == '{') depth++;
            else if (source[position] == '}' && --depth == 0)
                return source.Substring(opening, position - opening + 1);
        }

        throw new InvalidOperationException($"{signature} body is not balanced");
    }

    private static string Source() => File.ReadAllText(
        RepositorySourcePath("integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs"));

    private static string RepositorySourcePath(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return Path.Combine(directory.FullName, relative);
    }
}
