using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A FARMHAND IS NOT "NOT INITIALIZED" UNTIL SOMETHING TRIED TO INITIALIZE IT.
///
/// <para>
/// The defect this gate exists for: <c>HostFarmhandProvisioner.HandleRequest</c> refused an owned, uncustomized
/// Farmhand with <c>farmhand_not_initialized</c> BEFORE attempting anything, while the very same method initialized the
/// Farmhand it had just created. So a save whose Cabin was created by a run that did not finish initializing was
/// permanently unbindable - every later request named the identity the Cabin already owned, the refusal fired on the
/// precondition, and the only remaining route was deleting a Farmhand the save had already written. The launch ladder's
/// "ready = running + attached" row was unreachable in the product for exactly that reason.
/// </para>
/// <para>
/// WHAT THIS PINS, AND WHY IT IS A GATE RATHER THAN A TEST. The population is DERIVED: every reason-code literal in the
/// four files that answer an attachment request or an AI-client activation whose name says a Farmhand is not
/// initialized. For each such site the gate requires two things - an initialization is attempted in that method before
/// the site, and the refusal is guarded by the SAME condition that guards the attempt. A refusal guarded by
/// <c>!isCustomized</c> whose attempt is guarded by <c>farmhand is null</c> is the shipped defect: it fires on a path
/// that never attempts the repair, which is precisely the class this gate was written for, and it names the member.
/// </para>
/// <para>
/// WHAT IT CANNOT SEE. The shape check proves an attempt precedes the refusal under the same guard; it cannot prove the
/// attempt is given the chance to succeed on the far side of a throwing one. That is what the two behavioural tests in
/// <c>HostFarmhandProvisioningInitializationTests</c> drive: an owned uncustomized Farmhand is initialized and bound, and
/// an initialization that throws is refused without deleting the identity.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class FarmhandInitializationReachabilityGateTests
{
    /// <summary>
    /// The four files that can answer "this Farmhand is not initialized": the Host attachment authority, the AI client
    /// that activates the identity, the diagnostic probe of the same handshake, and the cabin provisioning decision that
    /// describes the state in prose.
    /// </summary>
    private static readonly string[] Sources =
    {
        "integrations/stardew/HostFarmhandProvisioner.cs",
        "integrations/stardew/FarmhandProvisioner.cs",
        "integrations/stardew/CompanionCabinProvisioning.cs",
        "integrations/stardew/FarmhandProvisioningProbe.cs",
    };

    /// <summary>
    /// The one code this gate holds to the attempt rule: the Host's answer to an attachment request.
    /// </summary>
    private const string HostRefusal = "farmhand_not_initialized";

    /// <summary>
    /// A REASON-CODE FAMILY, and the two members that are exempt BY AUTHORITY rather than by shape.
    ///
    /// <para>
    /// The AI client and the probe run in the OTHER process. The profile they read lives in the Host's save, so they can
    /// neither write nor repair it - the initialization they would have to attempt is not theirs to attempt. Their codes
    /// are therefore deliberately different words, and this list is the reason each one is allowed to exist without an
    /// attempt. An entry EXPIRES: the gate reports a stale entry once the site it exempts is gone, so this list cannot
    /// keep excusing a refusal nobody produces any more.
    /// </para>
    /// </summary>
    private static readonly (string File, string Code, string Reason)[] RefusalsByAnotherAuthority =
    {
        (
            "integrations/stardew/FarmhandProvisioner.cs",
            "target_farmhand_not_initialized",
            "the AI client activates a Farmhand the Host already initialized; it cannot write the Host's save, so it can only refuse to send an uncustomized copy into CharacterCustomization"),
        (
            "integrations/stardew/FarmhandProvisioningProbe.cs",
            "expected_farmhand_not_profile_initialized",
            "the probe is a read-only diagnostic of the same handshake and has no authority over the Host's save either"),
    };

    private readonly ITestOutputHelper output;

    public FarmhandInitializationReachabilityGateTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void NoRefusalOfAnUninitializedFarmhand_IsReachedWithoutAnAttemptOnThatFarmhand()
    {
        GateResult result = Evaluate(
            Sources.Select(relative => (relative, SourceLines(relative))).ToArray(),
            RefusalsByAnotherAuthority);

        this.output.WriteLine($"examined {result.Examined.Count} not-initialized site(s):");
        foreach (string site in result.Examined)
            this.output.WriteLine($"  {site}");

        result.Blocked.Should().BeNull("a reading with no sites in it agrees with itself and is not a pass");
        result.Findings.Should().BeEmpty(
            "a not-initialized refusal must be the postcondition of an initialization attempt, not a precondition on it:"
                + Environment.NewLine
                + string.Join(Environment.NewLine, result.Findings));
        result.Examined.Should().Contain(entry => entry.Contains(HostRefusal, StringComparison.Ordinal),
            "the Host's own refusal is the site this gate exists for and must be in the population");
    }

    /// <summary>
    /// The falsifier: the SHAPE THAT SHIPPED, taken from this file's own history. The refusal sits in a block guarded by
    /// `!isCustomized` while the only initialization in the method is guarded by `farmhand is null`, so a Farmhand that
    /// already exists is refused with no attempt to repair it.
    /// </summary>
    [Fact]
    public void APreconditionRefusalOfAnUninitializedFarmhand_IsReportedByName()
    {
        string[] shipped =
        {
            "    private TargetFarmhand PrepareTargetFarmhand(Cabin cabin, string expectedFarmhandId)",
            "    {",
            "        Farmer? farmhand = cabin.owner;",
            "        if (farmhand is null)",
            "        {",
            "            try",
            "            {",
            "                this.InitializeFarmhandProfile(farmhand);",
            "            }",
            "            catch (Exception exception)",
            "            {",
            "                return new(\"rejected\", \"farmhand_profile_initialization_failed\");",
            "            }",
            "        }",
            "        if (!farmhand.isCustomized.Value)",
            "        {",
            "            return new(\"rejected\", \"farmhand_not_initialized\");",
            "        }",
            "    }",
            "}",
        };

        GateResult result = Evaluate(new[] { ("synthetic.cs", shipped) }, Array.Empty<(string, string, string)>());

        result.Examined.Should().HaveCount(1);
        result.Findings.Should().ContainSingle()
            .Which.Should().Contain("synthetic.cs:17")
            .And.Contain("!farmhand.isCustomized.Value")
            .And.Contain("farmhand is null");
    }

    /// <summary>
    /// The other falsifier: the repair, written the way this repository writes it - an attempt under the guard, then the
    /// verification of what the attempt produced, under the same guard. The gate must accept this shape, or it would
    /// forbid the fix it asks for.
    /// </summary>
    [Fact]
    public void AnAttemptFollowedByAVerification_IsAccepted()
    {
        string[] repaired =
        {
            "    private TargetFarmhand PrepareTargetFarmhand(Cabin cabin, string expectedFarmhandId)",
            "    {",
            "        if (!farmhand.isCustomized.Value)",
            "        {",
            "            try",
            "            {",
            "                this.InitializeFarmhandProfile(farmhand);",
            "            }",
            "            catch (Exception exception)",
            "            {",
            "                return new(\"rejected\", \"farmhand_profile_initialization_failed\");",
            "            }",
            "            if (!farmhand.isCustomized.Value)",
            "            {",
            "                return new(\"rejected\", \"farmhand_not_initialized\");",
            "            }",
            "        }",
            "    }",
            "}",
        };

        GateResult result = Evaluate(new[] { ("repaired.cs", repaired) }, Array.Empty<(string, string, string)>());

        result.Examined.Should().HaveCount(1);
        result.Findings.Should().BeEmpty();
    }

    [Fact]
    public void AZeroPopulation_IsBlockedRatherThanGreen()
    {
        GateResult result = Evaluate(
            new[] { ("empty.cs", new[] { "        return new(\"rejected\", \"cabin_missing\");", "}" }) },
            Array.Empty<(string, string, string)>());

        result.Examined.Should().BeEmpty();
        result.Blocked.Should().NotBeNull().And.Contain("not-initialized");
        result.Findings.Should().BeEmpty();
    }

    [Fact]
    public void ADeclaredExemption_ThatNoLongerExists_IsReported()
    {
        // The client still refuses, nothing else does: the client entry is live and the probe entry has expired.
        string[] live = { "            this.Fail(\"target_farmhand_not_initialized\");", "}" };

        GateResult result = Evaluate(
            new[] { ("integrations/stardew/FarmhandProvisioner.cs", live) },
            RefusalsByAnotherAuthority);

        result.Findings.Should().ContainSingle()
            .Which.Should().Contain("integrations/stardew/FarmhandProvisioningProbe.cs")
            .And.Contain("expected_farmhand_not_profile_initialized");
    }

    [Fact]
    public void AnUndeclaredRefusalOfAnotherAuthority_IsReported()
    {
        string[] undeclared = { "            this.Fail(\"someone_else_was_not_initialized\");", "}" };

        GateResult result = Evaluate(
            new[] { ("integrations/stardew/FarmhandProvisioner.cs", undeclared) },
            RefusalsByAnotherAuthority);

        result.Findings.Should().Contain(finding => finding.Contains("someone_else_was_not_initialized"));
    }

    // ---- the gate itself -----------------------------------------------------

    /// <summary>What one evaluation of the gate found: the population it read and what it has to say about it.</summary>
    internal sealed record GateResult(IReadOnlyList<string> Examined, IReadOnlyList<string> Findings, string? Blocked);

    /// <summary>The reason-code family: any code whose own words say a Farmhand is not initialized.</summary>
    private static readonly Regex Family = new(@"[a-z0-9_]*(?:not_initialized|not_profile_initialized)", RegexOptions.Compiled);

    /// <summary>Any call to an initializer of a Farmhand profile: the one initializer, under either name it has carried.</summary>
    private static readonly Regex Initializer = new(@"Initialize\w*Farmhand\w*\(", RegexOptions.Compiled);

    /// <summary>
    /// The gate over an arbitrary corpus, so a synthetic case can turn it red on purpose and the real sources can be
    /// evaluated the same way. Comments are stripped: the prose in `CompanionCabinProvisioning` NAMES this code, and a
    /// gate that reads prose reports a site that is not there.
    /// </summary>
    internal static GateResult Evaluate(
        IReadOnlyList<(string File, string[] Lines)> sources,
        IReadOnlyList<(string File, string Code, string Reason)> exemptions)
    {
        var examined = new List<string>();
        var findings = new List<string>();
        var seen = new List<(string File, string Code)>();
        foreach ((string file, string[] lines) in sources)
        {
            for (int index = 0; index < lines.Length; index++)
            {
                Match match = Family.Match(lines[index]);
                if (!match.Success)
                    continue;
                string code = match.Value;
                string site = $"{file}:{index + 1}";
                examined.Add($"{site}:{code}");
                seen.Add((file, code));

                if (exemptions.Any(exemption => exemption.File == file && exemption.Code == code))
                    continue;
                if (code != HostRefusal)
                {
                    findings.Add($"{site} returns `{code}` and no authority is declared for it in RefusalsByAnotherAuthority");
                    continue;
                }

                int methodStart = MethodStart(lines, index);
                if (methodStart < 0)
                {
                    findings.Add($"{site} is outside any method this gate can read");
                    continue;
                }
                string method = MethodName(lines[methodStart]);
                int methodEnd = BlockEnd(lines, methodStart);
                int attempt = Attempt(lines, methodStart, methodEnd);
                if (attempt < 0 || attempt > index)
                {
                    findings.Add($"{site} (`{method}`) refuses an uninitialized Farmhand and no initialization is attempted before it");
                    continue;
                }
                string refusalGuard = Guard(lines, methodStart, index);
                string attemptGuard = Guard(lines, methodStart, attempt);
                if (!string.Equals(refusalGuard, attemptGuard, StringComparison.Ordinal))
                {
                    findings.Add(
                        $"{site} (`{method}`) refuses an uninitialized Farmhand under `{refusalGuard}` while the initialization is attempted under `{attemptGuard}`:"
                        + " the refusal runs on a path that never attempts the repair");
                }
            }
        }

        foreach ((string file, string code, string _) in exemptions)
        {
            if (!seen.Contains((file, code)))
                findings.Add($"{file} no longer returns `{code}`: the exemption in RefusalsByAnotherAuthority has expired and must be removed");
        }

        string? blocked = examined.Count == 0
            ? "zero not-initialized sites were found; the corpus this gate reads is empty, so it has measured nothing"
            : null;
        return new GateResult(examined, findings, blocked);
    }

    private static int Attempt(string[] lines, int methodStart, int methodEnd)
    {
        for (int index = methodStart + 1; index <= methodEnd; index++)
        {
            if (Initializer.IsMatch(lines[index]))
                return index;
        }
        return -1;
    }

    /// <summary>The nearest preceding `if` whose body encloses the line, as a condition string; empty at method level.</summary>
    private static string Guard(string[] lines, int methodStart, int index)
    {
        for (int candidate = index - 1; candidate > methodStart; candidate--)
        {
            string text = lines[candidate].Trim();
            if (!text.StartsWith("if (", StringComparison.Ordinal) || !text.EndsWith(")", StringComparison.Ordinal))
                continue;
            if (BlockEnd(lines, candidate) < index)
                continue;
            return Condition(text);
        }
        return string.Empty;
    }

    private static string Condition(string ifLine)
    {
        int open = ifLine.IndexOf('(');
        int close = ifLine.LastIndexOf(')');
        return close > open ? ifLine[(open + 1)..close].Trim() : ifLine;
    }

    /// <summary>
    /// The last line of the body that starts at <paramref name="start"/>: a brace block, or the single statement a
    /// brace-less `if` owns. The repository writes one declaration per line and one brace per block, which is what makes
    /// this walk exact here instead of approximate.
    /// </summary>
    private static int BlockEnd(string[] lines, int start)
    {
        int next = start + 1;
        while (next < lines.Length && lines[next].Trim().Length == 0)
            next++;
        if (next >= lines.Length || lines[next].Trim() != "{")
            return next;
        int depth = 0;
        for (int index = next; index < lines.Length; index++)
        {
            foreach (char character in lines[index])
            {
                if (character == '{')
                    depth++;
                else if (character == '}' && --depth == 0)
                    return index;
            }
        }
        return lines.Length - 1;
    }

    private static int MethodStart(string[] lines, int index)
    {
        for (int candidate = index; candidate >= 0; candidate--)
        {
            string text = lines[candidate].Trim();
            if (!text.EndsWith(")", StringComparison.Ordinal) || text.Contains(';'))
                continue;
            if (text.StartsWith("private ", StringComparison.Ordinal)
                || text.StartsWith("internal ", StringComparison.Ordinal)
                || text.StartsWith("public ", StringComparison.Ordinal)
                || text.StartsWith("protected ", StringComparison.Ordinal))
            {
                return candidate;
            }
        }
        return -1;
    }

    private static string MethodName(string declaration)
    {
        int open = declaration.IndexOf('(');
        return open < 0 ? declaration.Trim() : declaration[..open].Split(' ')[^1].Trim();
    }

    private static string[] SourceLines(string relative) =>
        DecompiledSource.Code(File.ReadAllLines(RepositorySourcePath(relative))).ToArray();

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
