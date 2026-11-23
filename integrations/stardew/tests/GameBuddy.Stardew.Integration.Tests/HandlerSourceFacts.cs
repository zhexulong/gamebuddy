using System.Text.RegularExpressions;
using FluentAssertions;

/// <summary>
/// The one reading of "which handler body serves this action": the action-id-to-method mapping from the
/// <c>Handlers/</c> switch arms, and the body of that method out of the controller partial that declares it.
///
/// <para>
/// Two gates ask this question about the same text - <c>ApproachDeclarationCoverageTests</c> asks whether a handler that
/// walks SAYS it walks, and <c>RefusalNamesWhereReachIsTests</c> asks whether a handler that refuses for a pixel reach
/// says where reach is - and a second copy of the parser is a disagreement scheduled for the day a handler moves between
/// partials. The same reason <see cref="HandlerApproachFacts"/> exists for the marker spellings.
/// </para>
///
/// <para>
/// What it deliberately does not read: read-only registrations (they answer an observation and have no request path) and
/// handler arms with no registration. Both are content questions for the caller, which knows which it wants; this class
/// only answers "where is the body".
/// </para>
/// </summary>
internal static class HandlerSourceFacts
{
    private const string HandlersDirectory = "integrations/stardew/Handlers";
    private const string ModDirectory = "integrations/stardew";

    /// <summary>The action id to handler method mapping, from the one place the Mod binds them.</summary>
    internal static IReadOnlyDictionary<string, string> HandlerMethods()
    {
        var methods = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string file in Directory.GetFiles(RepositorySourcePath(HandlersDirectory), "*.cs"))
        {
            string source = File.ReadAllText(file);

            // `this.executions.X(` is the execution controller, `this.X(` a method on the handler itself
            // (`navigate_to_destination` hands its request to `Navigate`, which is not a controller request path).
            foreach (Match match in Regex.Matches(
                source,
                "\"([a-z0-9_]+)\"\\s*=>\\s*(?:this\\.(?:executions\\.)?)?([A-Za-z0-9_]+)\\("))
            {
                methods[match.Groups[1].Value] = match.Groups[2].Value;
            }
        }

        methods.Should().NotBeEmpty("the handler switch arms are how an action id reaches its method");
        return methods;
    }

    /// <summary>
    /// Every C# file a handler arm can reach its method body through: the execution controller's partials, and the
    /// handler files themselves for the few arms that route through a method of their own rather than a controller
    /// request path. Keyed by a display name, so a failure names the file a reader can open.
    /// </summary>
    internal static IReadOnlyDictionary<string, string> HandlerSources()
    {
        var sources = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string file in Directory.GetFiles(RepositorySourcePath(ModDirectory), "farmhandexecutioncontroller*.cs")
            .Concat(Directory.GetFiles(RepositorySourcePath(ModDirectory), "farmhandtargetdiscovery*.cs")))
        {
            sources[Path.GetFileName(file)] = File.ReadAllText(file);
        }

        foreach (string file in Directory.GetFiles(RepositorySourcePath(HandlersDirectory), "*.cs"))
        {
            sources[$"{HandlersDirectory}/{Path.GetFileName(file)}"] = File.ReadAllText(file);
        }

        sources.Should().NotBeEmpty("the controller partials hold the request paths the approach legs live in");
        return sources;
    }

    /// <summary>
    /// The file, line and body of the first <c>LocalExecutionReceipt &lt;name&gt;(</c> in any source, whole: a statement
    /// body is a brace-balanced block and an EXPRESSION body runs to its own semicolon. The parameter list is skipped by
    /// its own parentheses first, because an expression-bodied request half has no brace of its own while the lambdas it
    /// hands the seam do - reading from the first <c>{</c> would return a lambda's block instead of the handler.
    ///
    /// <para>
    /// TWO DECLARATION SHAPES, ONE READER. A request half hands its gate a predicate returning
    /// <see cref="TileTargetRefusal"/> and asks the same one from its body, so the action's target decision lives in
    /// that predicate now and a path reader that stopped at <c>LocalExecutionReceipt</c> would stop exactly where the
    /// decision starts - which is how the live-pack re-resolution left the path the day it moved.
    /// </para>
    /// </summary>
    internal static (string File, int Line, int BodyLine, string Body)? MethodSite(
        IReadOnlyDictionary<string, string> sources,
        string method)
    {
        foreach ((string file, string source) in sources)
        {
            int declaration = source.IndexOf($"LocalExecutionReceipt {method}(", StringComparison.Ordinal);
            if (declaration < 0)
                declaration = source.IndexOf($"TileTargetRefusal? {method}(", StringComparison.Ordinal);
            if (declaration < 0)
                continue;

            (int Start, string Body)? body = BodyOf(source, declaration);
            if (body is null)
                return null;

            int line = LineOf(source, declaration);
            return (file, line, LineOf(source, body.Value.Start), body.Value.Body);
        }

        return null;
    }

    /// <summary>
    /// The body of the member whose declaration begins at <paramref name="declarationStart"/>: the brace-balanced block,
    /// or an expression body up to its own semicolon. The same reader as <see cref="MethodSite"/>, for a caller whose
    /// subject is a member that returns a list rather than a receipt (the discovery layer), so that gate does not carry
    /// a second brace matcher that can disagree with this one.
    /// </summary>
    internal static string? MemberBody(string source, int declarationStart) => BodyOf(source, declarationStart)?.Body;

    /// <summary>The 1-based line an index sits on.</summary>
    internal static int LineOf(string source, int index) =>
        source.Take(index).Count(character => character == '\n') + 1;

    private static (int Start, string Body)? BodyOf(string source, int declaration)
    {
        int opening = source.IndexOf('(', declaration);
        int cursor = AfterBalanced(source, opening);
        while (cursor < source.Length && source[cursor] is ' ' or '\n' or '\r' or '\t') cursor++;
        if (cursor >= source.Length) return null;
        string? body = source[cursor] == '{'
            ? source[cursor..AfterBraced(source, cursor)]
            : ExpressionBody(source, cursor);
        return body is null ? null : (cursor, body);
    }

    /// <summary>The index just past the construct whose opening parenthesis is at <paramref name="open"/>.</summary>
    private static int AfterBalanced(string source, int open)
    {
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '(') depth++;
            else if (source[index] == ')' && --depth == 0) return index + 1;
        }

        return source.Length;
    }

    /// <summary>The index just past the block whose opening brace is at <paramref name="open"/>.</summary>
    private static int AfterBraced(string source, int open)
    {
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}' && --depth == 0) return index + 1;
        }

        return source.Length;
    }

    private static string? ExpressionBody(string source, int start)
    {
        int parentheses = 0;
        int braces = 0;
        for (int index = start; index < source.Length; index++)
        {
            switch (source[index])
            {
                case '(': parentheses++; break;
                case ')': parentheses--; break;
                case '{': braces++; break;
                case '}': braces--; break;
                case ';' when parentheses == 0 && braces == 0: return source[start..(index + 1)];
            }
        }

        return null;
    }

    /// <summary>
    /// Drops line comments, because a gate is about what the handler DOES: a request path whose comment explains the
    /// walk it used to make would otherwise satisfy the marker it describes.
    /// </summary>
    internal static string StripLineComments(string source)
    {
        var lines = source.Split('\n');
        for (int index = 0; index < lines.Length; index++)
        {
            int comment = lines[index].IndexOf("//", StringComparison.Ordinal);
            if (comment >= 0)
                lines[index] = lines[index][..comment];
        }

        return string.Join('\n', lines);
    }

    internal static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (Directory.Exists(candidate))
                    return candidate;
            }
        }

        throw new DirectoryNotFoundException($"repository path not found: {relative}");
    }
}
