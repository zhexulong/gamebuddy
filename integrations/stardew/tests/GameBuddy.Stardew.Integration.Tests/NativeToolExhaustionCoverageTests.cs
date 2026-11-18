using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The engine's exhaustion consequence reaches EVERY native tool dispatch this Mod performs, and the Mod never
/// fabricates that state itself.
///
/// <para>
/// THE CLAIM THIS GATE EXISTS FOR: "calling <c>Tool.DoFunction</c> directly bypasses <c>Farmer.useTool</c>'s
/// <c>who.checkForExhaustion</c> - the only place in the game that sets <c>exhausted.Value = true</c> - so the
/// companion can drain stamina to zero and never pass out from overwork; she just wakes up full." Read off the
/// target-version assembly: <c>exhausted.Value = true</c> has exactly one writer, <c>Farmer.checkForExhaustion</c>
/// (<c>Farmer.cs:6874</c>), and <c>checkForExhaustion</c> has exactly two engine callers - <c>Farmer.useTool</c>
/// (<c>Farmer.cs:6812</c>), which brackets the swing, and <c>FishingRod.DoFunction</c> (<c>FishingRod.cs:409</c>),
/// which is inside the deduction that needs it. So the claim is TRUE OF THE ENGINE for the four tool families the Mod
/// swings directly (<c>Hoe.cs:58</c>, <c>Axe.cs:68</c>, <c>Pickaxe.cs:88</c>, <c>WateringCan.cs:169</c> all spend
/// stamina inside their own <c>DoFunction</c> and never call it), and the Mod therefore has to apply it.
/// </para>
///
/// <para>
/// WHAT IS DECIDED HERE, AND WHY IT IS NOT A LIST. Two handler tests (<c>PetBowlWateringActionTests</c>,
/// <c>SlimeHutchTroughActionTests</c>) pin the shape for the two handlers that were fixed; a NEW handler that
/// dispatches <c>DoFunction</c> itself - which is how every one of the 13 seam call sites came to exist - is outside
/// their population and would ship with the consequence missing. So the population here is derived twice, from
/// authorities neither of which is written down in this file:
/// </para>
/// <list type="bullet">
/// <item>the CALL SITES are every <c>X.DoFunction(</c> in the Mod's own C# sources, walked as text (a new partial is
/// inside the population without an edit);</item>
/// <item>the ENGINE FACTS are read from the decompiled tree for the receiver's declared type, so a tool family added
/// later is judged by its own body rather than by a table here.</item>
/// </list>
///
/// <para>
/// AND IT FAILS CLOSED. A call site whose enclosing member cannot be read, or whose receiver's type cannot be resolved
/// to exactly one engine source, is a RED gate naming the site - "not measured" is never reported as "nothing to do".
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class NativeToolExhaustionCoverageTests
{
    private readonly ITestOutputHelper output;

    public NativeToolExhaustionCoverageTests(ITestOutputHelper output) => this.output = output;

    private const string ModRoot = "integrations/stardew";
    private const string DecompiledRoot = "ref/external/StardewValleyDecompiled/Stardew Valley";
    private const string FarmerSource = "StardewValley/Farmer.cs";

    /// <summary>`try`, `catch` and friends open a block but declare no member.</summary>
    private static readonly HashSet<string> BlockKeywords = new(StringComparer.Ordinal)
    {
        "try", "catch", "if", "else", "for", "foreach", "while", "switch", "using", "lock", "fixed", "do",
    };

    /// <summary>
    /// Every native tool dispatch in the Mod either sits in a member that applies the engine's closing steps, or names
    /// a tool whose OWN <c>DoFunction</c> spends no stamina or already runs <c>checkForExhaustion</c>.
    /// </summary>
    [Fact]
    public void EveryNativeToolDispatchAppliesTheEnginesExhaustionConsequence()
    {
        List<string> examined = new();
        List<string> excusedByTheEngine = new();
        List<string> failures = new();

        foreach ((string path, string code) in ModCode())
        {
            foreach (int site in OccurrenceOffsets(code, ".DoFunction("))
            {
                string where = $"{Relative(path)}:{LineOf(code, site)}";
                string receiver = ReceiverOf(code, site);
                MemberDecl? member = EnclosingMember(code, site);
                if (member is null)
                {
                    failures.Add($"tool_dispatch_member_unreadable:{where}: `{receiver}.DoFunction` has no enclosing "
                        + "member this gate can read, so whether it applies the exhaustion consequence is not measured");
                    continue;
                }

                if (receiver.Length == 0)
                {
                    failures.Add($"tool_dispatch_receiver_unreadable:{where}: `{member.Name}` dispatches `DoFunction` "
                        + "on an expression this gate cannot name, so the tool it swings is not measured");
                    continue;
                }

                examined.Add($"{where} {member.Name} -> {receiver}.DoFunction");

                // First answer: the member itself runs the engine's closing steps. This is the shared seam's shape.
                if (member.Body.Contains("checkForExhaustion(", StringComparison.Ordinal))
                    continue;

                string? type = ResolveReceiverType(member.Body, receiver);
                if (type is null)
                {
                    failures.Add($"tool_dispatch_type_unresolved:{where}: `{receiver}` in `{member.Name}` has no "
                        + "single engine type this gate can find, and the member does not call "
                        + "`checkForExhaustion` itself, so the consequence it owes is not established");
                    continue;
                }

                string? file = EngineTypeSource(type);
                if (file is null)
                {
                    failures.Add($"tool_dispatch_type_not_found:{where}: `{receiver}` resolves to `{type}`, which has "
                        + $"no source under `{DecompiledRoot}` at `StardewValley.Tools/{type}.cs` or "
                        + $"`StardewValley/{type}.cs`; the engine fact this gate needs is absent, not zero");
                    continue;
                }

                string[] lines = File.ReadAllLines(file);
                IReadOnlyList<string> body = MethodBody(lines, " DoFunction(");
                if (body.Count == 0)
                {
                    failures.Add($"tool_dispatch_body_unreadable:{where}: `{type}.DoFunction` was not found in "
                        + $"`{Relative(file)}`; a dispatch into a type whose swing cannot be read is not measured");
                    continue;
                }

                bool spendsStamina = body.Any(line => line.Contains("Stamina -=", StringComparison.Ordinal));
                bool engineAppliesIt = body.Any(line => line.Contains("checkForExhaustion(", StringComparison.Ordinal));

                if (!spendsStamina)
                {
                    // Nothing was deducted, so nothing is owed. This is the honest exemption for Pan, Lantern and Raft,
                    // and it is a MEASUREMENT of the engine rather than a list of tool names.
                    excusedByTheEngine.Add($"{where} {type}: DoFunction deducts no stamina");
                    continue;
                }

                if (engineAppliesIt)
                {
                    // FishingRod.cs:407-410 deducts and then calls checkForExhaustion on the very value it read, so the
                    // engine owns both halves of that swing.
                    excusedByTheEngine.Add($"{where} {type}: its own DoFunction calls checkForExhaustion");
                    continue;
                }

                failures.Add($"native_tool_dispatch_skips_exhaustion:{where}: `{member.Name}` calls "
                    + $"`{receiver}.DoFunction` where `{type}.DoFunction` spends stamina and never calls "
                    + "`checkForExhaustion`, and the member does not apply it either. Route the swing through "
                    + "`UseNativeToolOnTile`, which is where the engine's closing steps live, or call "
                    + "`who.checkForExhaustion(<stamina before the swing>)` after it");
            }
        }

        examined.Should().NotBeEmpty(
            "a population of zero agrees with itself: the walk found no `.DoFunction` call site at all, which means the "
            + $"sources under `{ModRoot}` were not read (repository root: {RepositoryRoot()})");

        // The population is PRINTED, not merely counted: a reader has to be able to see that every dispatch was
        // measured and which engine fact excused it. "0 problems" without "examined 6" says nothing.
        this.output.WriteLine($"examined {examined.Count} native tool dispatch(es) over the Mod's own sources");
        foreach (string entry in examined) this.output.WriteLine("  dispatched " + entry);
        foreach (string entry in excusedByTheEngine) this.output.WriteLine("  excused    " + entry);
        foreach (string entry in failures) this.output.WriteLine("  REFUSED    " + entry);

        failures.Should().BeEmpty(
            "the engine sets `exhausted.Value = true` in exactly one place (Farmer.cs:6874, inside checkForExhaustion), "
            + "and its next-day consequence is that the actor wakes at `MaxStamina / 2 + 1` (Farmer.cs:3573-3577). A "
            + "dispatch that skips it makes a swing that never tires the actor out. Examined "
            + $"{examined.Count} call site(s), of which {excusedByTheEngine.Count} are excused by the engine's own body:\n"
            + string.Join("\n", excusedByTheEngine.Select(entry => "  excused " + entry)));
    }

    /// <summary>
    /// <c>exhausted</c> is the ENGINE's state, and the Mod only ever reaches it through <c>checkForExhaustion</c>.
    ///
    /// <para>
    /// One authority per fact: if the Mod wrote <c>exhausted.Value</c> itself it would be asserting a consequence it
    /// did not measure (an actor at 120 stamina reported as exhausted), and if it wrote <c>false</c> it would be
    /// erasing the engine's own record. Neither is anywhere in the tree today, and this is what keeps it that way.
    /// </para>
    /// </summary>
    [Fact]
    public void TheModNeverWritesTheEnginesExhaustionState()
    {
        List<string> writers = new();

        foreach ((string path, string code) in ModCode())
        {
            foreach (int site in OccurrenceOffsets(code, "exhausted.Value"))
            {
                int after = site + "exhausted.Value".Length;
                string tail = after < code.Length ? code[after..].TrimStart() : string.Empty;
                if (tail.StartsWith("=", StringComparison.Ordinal) || tail.StartsWith("+=", StringComparison.Ordinal))
                    writers.Add($"{Relative(path)}:{LineOf(code, site)}");
            }
        }

        writers.Should().BeEmpty(
            "`Farmer.exhausted` is written by the engine's own `checkForExhaustion` (Farmer.cs:6874) and cleared by its "
            + "day rollover (Farmer.cs:3576) and by a spouse's kiss (NPC.cs:2622); a Mod write would be a consequence "
            + "claimed rather than measured. Found: " + (writers.Count == 0 ? "none" : string.Join(", ", writers)));
    }

    /// <summary>
    /// The measurement that settles the review's second half, read off the engine rather than restated here: what
    /// `exhausted` costs tomorrow, and that `checkForExhaustion` is its only writer.
    /// </summary>
    [Fact]
    public void TheEnginesExhaustionStateIsTheOwnersOfTheNextDayPenalty()
    {
        string[] farmer = File.ReadAllLines(Path.Combine(
            RepositoryRoot(), DecompiledRoot, FarmerSource.Replace('/', Path.DirectorySeparatorChar)));

        // One writer, and it is checkForExhaustion.
        List<int> writers = new();
        for (int index = 0; index < farmer.Length; index++)
        {
            if (farmer[index].Contains("exhausted.Value = true", StringComparison.Ordinal))
                writers.Add(index + 1);
        }

        writers.Should().HaveCount(1, "`exhausted.Value = true` is one write site in the target version, and every "
            + "tool dispatch depends on the engine's own method being it");
        int enclosing = EnclosingDeclarationLine(farmer, writers[0] - 1);
        farmer[enclosing - 1].Should().Contain("checkForExhaustion(",
            $"the only write of `exhausted.Value = true` is at Farmer.cs:{writers[0]} and it must sit inside "
            + "checkForExhaustion, which is the method the Mod calls from its seam");

        // And the consequence, in the day rollover the actor's stamina crosses between two days.
        IReadOnlyList<string> dayupdate = MethodBody(farmer, "public void dayupdate(");
        dayupdate.Should().NotBeEmpty("`Farmer.dayupdate` is the rollover that reads the state");
        string body = string.Join("\n", dayupdate);
        body.Should().Contain("bool value = exhausted.Value;",
            "the rollover reads the state the swing set before it refills stamina");
        body.Should().Contain("exhausted.Value = false;", "the rollover clears the state it acted on");
        body.Should().Contain("Stamina = MaxStamina / 2 + 1;",
            "the engine's own next-day penalty for exhaustion: the actor wakes at half stamina plus one");
        body.IndexOf("Stamina = MaxStamina / 2 + 1;", StringComparison.Ordinal).Should().BeGreaterThan(
            body.IndexOf("bool value = exhausted.Value;", StringComparison.Ordinal),
            "the halving is the branch taken BECAUSE the state was set, never a refill that happens first");
    }

    // ---- the Mod's own sources ----------------------------------------------

    /// <summary>
    /// Every C# file of the Mod with its `//` comments removed, so a sentence ABOUT a call is never read as the call.
    /// Comments are stripped for the reason documented on `DecompiledSource.Code`: a commented-out
    /// `tool.DoFunction(...)` still contains the text a naive scan looks for.
    /// </summary>
    private static IEnumerable<(string Path, string Code)> ModCode()
    {
        string root = RepositorySourcePath(ModRoot);
        foreach (string path in Directory.GetFiles(root, "*.cs", SearchOption.AllDirectories).OrderBy(p => p, StringComparer.Ordinal))
        {
            string separator = Path.DirectorySeparatorChar.ToString();
            if (path.Contains($"{separator}tests{separator}", StringComparison.Ordinal)
                || path.Contains($"{separator}obj{separator}", StringComparison.Ordinal)
                || path.Contains($"{separator}bin{separator}", StringComparison.Ordinal)
                || path.Contains($"{separator}action-development{separator}", StringComparison.Ordinal))
                continue;
            yield return (path, WithoutComments(File.ReadAllText(path)));
        }
    }

    private static string WithoutComments(string source)
    {
        string[] lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        for (int index = 0; index < lines.Length; index++)
        {
            int at = lines[index].IndexOf("//", StringComparison.Ordinal);
            if (at >= 0)
                lines[index] = lines[index][..at];
        }
        return string.Join("\n", lines);
    }

    // ---- the site: which member, which receiver, which type -----------------

    /// <summary>A member and the body its call site executes inside.</summary>
    private sealed record MemberDecl(string Name, string Body);

    /// <summary>
    /// The innermost member declaration whose brace block contains <paramref name="offset"/>, or null when no
    /// enclosing block is declared as a member. The blocks are walked outward from the site, so a `try` or `catch`
    /// between the call and its method is skipped rather than mistaken for it, and a signature split over several
    /// lines answers the same as a one-line one.
    /// </summary>
    private static MemberDecl? EnclosingMember(string code, int offset)
    {
        var enclosing = new Stack<int>();
        for (int at = 0; at < offset && at < code.Length; at++)
        {
            if (code[at] == '{') enclosing.Push(at);
            else if (code[at] == '}' && enclosing.Count > 0) enclosing.Pop();
        }

        foreach (int opening in enclosing)
        {
            int closing = BlockEnd(code, opening);
            if (closing < 0)
                continue;
            string header = HeaderBefore(code, opening);
            if (header.Length == 0 || !header.Contains('(', StringComparison.Ordinal))
                continue;
            string first = header.TrimStart().Split(' ', '\t', '\n', '(')[0];
            if (BlockKeywords.Contains(first) || first == "new" || first == "return")
                continue;
            return new MemberDecl(MemberName(header), code[opening..(closing + 1)]);
        }
        return null;
    }

    /// <summary>The text between the previous statement boundary and <paramref name="opening"/>: a block's header.</summary>
    private static string HeaderBefore(string code, int opening)
    {
        int start = 0;
        for (int at = opening - 1; at >= 0; at--)
        {
            if (code[at] == ';' || code[at] == '{' || code[at] == '}')
            {
                start = at + 1;
                break;
            }
        }
        return code[start..opening];
    }

    /// <summary>The identifier a signature declares: the name immediately before its parameter list.</summary>
    private static string MemberName(string signature)
    {
        int paren = signature.IndexOf('(', StringComparison.Ordinal);
        int end = paren < 0 ? signature.Length : paren;
        int start = end;
        while (start > 0 && (char.IsLetterOrDigit(signature[start - 1]) || signature[start - 1] == '_')) start--;
        return signature[start..end];
    }

    /// <summary>The receiver identifier of a `<c>x.DoFunction(</c>` site, or empty when it is not a plain name.</summary>
    private static string ReceiverOf(string code, int site)
    {
        int end = site;                                  // `site` is the `.` itself
        if (end == 0) return string.Empty;
        int start = end;
        while (start > 0 && (char.IsLetterOrDigit(code[start - 1]) || code[start - 1] == '_')) start--;
        string name = code[start..end];
        return name.Length > 0 && char.IsLetter(name[0]) ? name : string.Empty;
    }

    /// <summary>
    /// The engine type <paramref name="receiver"/> is declared as inside <paramref name="body"/>, or null when the
    /// member offers no single answer. C# `is`/`is not` patterns are the Mod's own idiom for narrowing a held tool, so
    /// they are read first; a plain declaration (`Hoe direct = hoe;`) is read after them.
    /// </summary>
    private static string? ResolveReceiverType(string body, string receiver)
    {
        string escaped = Regex.Escape(receiver);
        string[] patterns =
        {
            $@"\bis\s+not\s+([A-Za-z_][\w.]*)\s+{escaped}\b",
            $@"\bis\s+([A-Za-z_][\w.]*)\s+{escaped}\b",
            $@"\b([A-Z][\w.]*)\s+{escaped}\s*=",
            $@"\b([A-Z][\w.]*)\s+{escaped}\s*[;,]",
        };

        List<string> candidates = new();
        foreach (string pattern in patterns)
        {
            foreach (Match match in Regex.Matches(body, pattern))
            {
                string name = match.Groups[1].Value;
                int dot = name.LastIndexOf('.');
                name = dot >= 0 ? name[(dot + 1)..] : name;
                if (!candidates.Contains(name, StringComparer.Ordinal))
                    candidates.Add(name);
            }
            if (candidates.Count > 0)
                break;
        }

        List<string> measurable = candidates.Where(name => EngineTypeSource(name) is not null).ToList();
        return measurable.Count == 1 ? measurable[0] : null;
    }

    /// <summary>The engine source that declares <paramref name="typeName"/>, or null when there is no such file.</summary>
    private static string? EngineTypeSource(string typeName)
    {
        foreach (string relative in new[] { $"StardewValley.Tools/{typeName}.cs", $"StardewValley/{typeName}.cs" })
        {
            string candidate = Path.Combine(RepositoryRoot(), DecompiledRoot, relative.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(candidate))
                return candidate;
        }
        return null;
    }

    // ---- the engine's own text ----------------------------------------------

    /// <summary>
    /// The <c>DoFunction</c> body in <paramref name="lines"/>, or no lines when the type declares none. The bound is
    /// the declaration's own brace block, and a declaration that is not followed by one (`abstract`, an interface
    /// member) answers empty rather than borrowing the next method's body.
    /// </summary>
    private static IReadOnlyList<string> MethodBody(IReadOnlyList<string> lines, string signature)
    {
        for (int index = 0; index < lines.Count; index++)
        {
            if (!lines[index].Contains(signature, StringComparison.Ordinal))
                continue;
            if (lines[index].TrimEnd().EndsWith(";", StringComparison.Ordinal))
                return Array.Empty<string>();
            int end = index;
            while (end < lines.Count && !lines[end].TrimEnd().EndsWith("{", StringComparison.Ordinal))
            {
                if (lines[end].Contains('{'))
                    break;
                end++;
            }
            if (end >= lines.Count)
                return Array.Empty<string>();
            int depth = 0;
            for (int at = end; at < lines.Count; at++)
            {
                foreach (char character in lines[at])
                {
                    if (character == '{') depth++;
                    else if (character == '}' && --depth == 0)
                        return lines.Skip(index).Take(at - index + 1).ToList();
                }
            }
        }
        return Array.Empty<string>();
    }

    /// <summary>The 1-based line of the declaration whose body contains <paramref name="lineIndex"/> (0-based).</summary>
    private static int EnclosingDeclarationLine(IReadOnlyList<string> lines, int lineIndex)
    {
        for (int index = lineIndex; index >= 0; index--)
        {
            string trimmed = lines[index].TrimStart();
            if (!trimmed.StartsWith("public ", StringComparison.Ordinal)
                && !trimmed.StartsWith("private ", StringComparison.Ordinal)
                && !trimmed.StartsWith("protected ", StringComparison.Ordinal)
                && !trimmed.StartsWith("internal ", StringComparison.Ordinal))
                continue;
            if (trimmed.EndsWith(";", StringComparison.Ordinal))
                continue;
            return index + 1;
        }
        return -1;
    }

    // ---- small text helpers -------------------------------------------------

    private static IEnumerable<int> OccurrenceOffsets(string source, string needle)
    {
        int at = source.IndexOf(needle, StringComparison.Ordinal);
        while (at >= 0)
        {
            yield return at;
            at = source.IndexOf(needle, at + needle.Length, StringComparison.Ordinal);
        }
    }

    private static int BlockEnd(string source, int opening)
    {
        int depth = 0;
        for (int at = opening; at < source.Length; at++)
        {
            if (source[at] == '{') depth++;
            else if (source[at] == '}' && --depth == 0) return at;
        }
        return -1;
    }

    private static int LineOf(string source, int offset) => source[..offset].Count(character => character == '\n') + 1;

    private static string Relative(string path)
    {
        string root = RepositoryRoot();
        return path.StartsWith(root, StringComparison.Ordinal) ? path[(root.Length + 1)..].Replace('\\', '/') : path;
    }

    private static string RepositorySourcePath(string relative) => Path.Combine(RepositoryRoot(), relative);

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return directory.FullName;
    }
}
