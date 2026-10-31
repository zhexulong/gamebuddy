using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A semantic event carries the active execution, and it used to obtain that ONE field by building the whole
/// snapshot: roughly seventy `Discover*` radar sources, each walking map objects and minting a SHA-256 target id,
/// plus warps, capabilities and dispositions - on the game thread, once per event, while `route_progress` is
/// published per tile. The projection is now a named accessor, and the snapshot reads it too, so the two can
/// never describe the occupant differently.
///
/// <para>
/// `CreateBridgeSnapshot` needs a live `Game1.player`, so these invariants are pinned at the source - the same
/// seam `BodyOwnerNamingTests` and `HeldToolProjectionTests` use for the same reason.
/// </para>
/// </summary>
public class ActiveExecutionProjectionTests
{
    [Fact]
    public void NoSemanticEventBuilder_BuildsTheWholeSnapshot()
    {
        // The population is DERIVED from the source: every method that mints a `BridgeSemanticEvent`. A new event
        // builder that reaches for the snapshot is caught here, and the failure names it.
        //
        // COMMENTS ARE STRIPPED FIRST. The first draft of this gate read the raw text and went red on
        // `TryCreateSemanticEvent` because the comment explaining WHY the snapshot is wrong names it - a gate that
        // reads prose rather than code reports a defect that is not there, and the next agent "fixes" the comment.
        string source = WithoutComments(Read("integrations/stardew/BridgeSession.cs"));
        MatchCollection builders = Regex.Matches(source, @"new BridgeSemanticEvent\(");
        builders.Count.Should().BeGreaterThanOrEqualTo(3, "the event builders must be found");

        var offenders = new List<string>();
        foreach (Match builder in builders)
        {
            string body = EnclosingMethodBody(source, builder.Index, out string name);
            if (body.Contains("CreateBridgeSnapshot", StringComparison.Ordinal))
                offenders.Add(name);
        }

        offenders.Should().BeEmpty(
            "a semantic event needs the active execution projection, not the whole world snapshot; offending builders: "
                + string.Join(", ", offenders));

        // And the cheap projection is what those builders actually read.
        foreach (Match builder in builders)
        {
            string body = EnclosingMethodBody(source, builder.Index, out string name);
            body.Should().Contain("DescribeActiveExecution", $"{name} must read the named projection");
        }
    }

    [Fact]
    public void TheSnapshotAndTheEvents_ReadOneActiveExecutionProjection()
    {
        string source = WithoutComments(Read("integrations/stardew/farmhandexecutioncontroller.cs"));
        string accessor = MethodBody(source, "public BridgeActiveExecution? DescribeActiveExecution(");

        // The projection itself must stay cheap: no radar source, and therefore no per-target digest. This is the
        // assertion that would have gone red for the defect - the cost was in the path, not in the field.
        accessor.Should().NotContain("Discover", "the active execution needs no radar source");
        accessor.Should().NotContain("SHA256", "no radar source means no target-id digest");
        accessor.Should().Contain("this.DescribeBodyOwner()", "the occupant comes from the one owner table");
        accessor.Should().Contain("this.receiptsByRequestId.TryGetValue", "the phase comes from the execution's receipt");

        // One spelling: the snapshot reads the same accessor the events do.
        MethodBody(source, "public BridgeSnapshot CreateBridgeSnapshot(")
            .Should().Contain("this.DescribeActiveExecution()", "the snapshot must not re-derive the occupant");
    }

    // ---- helpers -------------------------------------------------------------

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    /// <summary>
    /// The source with its comments removed, preserving line structure and string literals.
    ///
    /// A source-shape assertion must read the CODE: a comment that names a forbidden call is not a call, and a gate
    /// that cannot tell them apart fails on the explanation of its own rule.
    /// </summary>
    private static string WithoutComments(string source)
    {
        var result = new System.Text.StringBuilder(source.Length);
        bool inLine = false;
        bool inBlock = false;
        bool inString = false;
        bool inCharacter = false;
        for (int position = 0; position < source.Length; position++)
        {
            char current = source[position];
            char next = position + 1 < source.Length ? source[position + 1] : '\0';
            if (inLine)
            {
                if (current == '\n')
                {
                    inLine = false;
                    result.Append(current);
                }

                continue;
            }

            if (inBlock)
            {
                if (current == '*' && next == '/')
                {
                    inBlock = false;
                    position++;
                }
                else if (current == '\n')
                {
                    result.Append(current);
                }

                continue;
            }

            if (inString || inCharacter)
            {
                result.Append(current);
                if (current == '\\')
                {
                    if (next != '\0') result.Append(next);
                    position++;
                }
                else if (inString && current == '"')
                {
                    inString = false;
                }
                else if (inCharacter && current == '\'')
                {
                    inCharacter = false;
                }

                continue;
            }

            if (current == '/' && next == '/')
            {
                inLine = true;
                continue;
            }

            if (current == '/' && next == '*')
            {
                inBlock = true;
                position++;
                continue;
            }

            if (current == '"')
            {
                inString = true;
            }
            else if (current == '\'')
            {
                inCharacter = true;
            }

            result.Append(current);
        }

        return result.ToString();
    }

    private static string RepositorySourcePath(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return Path.Combine(directory.FullName, relative);
    }

    /// <summary>The body of the member declaration the character at <paramref name="index"/> sits inside.</summary>
    private static string EnclosingMethodBody(string source, int index, out string name)
    {
        Match declaration = Regex.Matches(source.Substring(0, index),
                @"\n[ \t]*(?:public|private|internal|protected)[^\n=;]*\([^;{]*\)[ \t]*\r?\n[ \t]*\{")
            .Cast<Match>()
            .LastOrDefault()
            ?? throw new InvalidOperationException("no enclosing member declaration was found");
        name = Regex.Match(declaration.Value, @"([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(").Groups[1].Value;
        int opening = source.IndexOf('{', declaration.Index);
        opening.Should().BeGreaterThanOrEqualTo(0);
        return BalancedBody(source, opening);
    }

    private static string BalancedBody(string source, int start)
    {
        int depth = 0;
        bool started = false;
        for (int position = start; position < source.Length; position++)
        {
            char character = source[position];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}' && started)
            {
                depth--;
                if (depth == 0) return source.Substring(start, position - start + 1);
            }
        }

        return source.Substring(start);
    }

    private static string MethodBody(string source, string signature, int occurrence = 1)
    {
        int index = -1;
        for (int seen = 0; seen < occurrence; seen++)
            index = source.IndexOf(signature, index + 1, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");
        return BalancedBody(source, opening);
    }
}
