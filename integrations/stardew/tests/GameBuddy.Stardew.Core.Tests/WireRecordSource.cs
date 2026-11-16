using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// One attribute application on a wire-record member, read from the declaration's own text.
///
/// <para>
/// <see cref="Name"/> is the attribute as the reader would say it, qualified by its target when it has one
/// (<c>property:JsonIgnore</c>); <see cref="ArgumentTokens"/> is every identifier and number INSIDE the argument list -
/// the tokens a reader that splits the declaration on structure can mistake for a member; <see cref="Text"/> is the
/// bracketed expression verbatim, so a finding can quote what was applied.
/// </para>
/// </summary>
internal sealed record AppliedAttribute(string Name, IReadOnlyList<string> ArgumentTokens, string Text);

/// <summary>
/// One member a wire record declares: its name, the attributes on it, and the declaration segment those were read from.
/// </summary>
internal sealed record DeclaredMember(string Name, IReadOnlyList<AppliedAttribute> Attributes, string Declaration);

/// <summary>One wire record and the members its parameter list declares, in declaration order.</summary>
internal sealed record DeclaredRecord(string Name, IReadOnlyList<DeclaredMember> Members);

/// <summary>
/// Reads the members a wire record declares, and the attributes on them, from the record's own source text.
///
/// <para>
/// <b>Why the attributes come off before anything else.</b> This reader used to split each declaration on <c>=</c> and
/// take the identifier that ended the left half. That is correct only while every attribute it meets has no argument:
/// <c>251b0da0</c> added the first one -
/// <c>[property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? SleepAdmitsHere = null</c> -
/// and the split cut inside the argument list, so <see cref="DeclaredMember.Name"/> was read as <c>Condition</c>, the
/// attribute's own argument, and <c>SleepAdmitsHere</c> disappeared from the record's declared fields entirely. Two
/// schema crossings then reported one ghost field and one missing field, and neither named the attribute.
/// </para>
/// <para>
/// So the attribute expression is removed FIRST, as a whole, and only then is the default value dropped. The shapes
/// this reader accepts, each asserted in <see cref="WireRecordSourceTests"/>:
/// </para>
/// <list type="bullet">
///   <item>a bare attribute: <c>[JsonIgnore] bool? X = null</c>;</item>
///   <item>a positional argument: <c>[Obsolete("gone")] string X</c>;</item>
///   <item>a named argument, which is the shipped case above;</item>
///   <item>a nested argument: <c>[Foo(Bar(1), Baz = Qux(2))] int X</c>;</item>
///   <item>several attributes on one member: <c>[A][B(x = 1)] string X</c>.</item>
/// </list>
/// <para>
/// A comma inside a TYPE ARGUMENT is not a member boundary either (<c>IReadOnlyDictionary&lt;string, int&gt;</c> is one
/// member), which is why the declaration splitter counts <c>&lt;</c> where the call splitter does not: an argument list
/// carries lambdas, and <c>=&gt;</c> would close a type argument that never opened.
/// </para>
/// <para>
/// <b>What is outside this reading.</b> A token inside a string literal in an argument list is not an argument token,
/// because a quoted word cannot be read as a member name; the attribute is still removed whole, so the member is still
/// found. A member whose name cannot be read throws rather than being dropped - a silent drop is exactly how
/// <c>SleepAdmitsHere</c> vanished.
/// </para>
/// </summary>
internal static class WireRecordSource
{
    /// <summary>The Mod's wire model file: the declaration every field this reader reads is written in.</summary>
    public const string ModelsPath = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";

    private const string MemberName = "([A-Za-z_][A-Za-z0-9_]*)\\s*$";

    private static readonly Regex RecordDeclaration = new(
        "^[ \t]*public (?:sealed )?record (?:struct |class )?(\\w+)\\s*\\(",
        RegexOptions.Multiline | RegexOptions.CultureInvariant);

    /// <summary>The wire model file's own text, found from the test assembly's own location.</summary>
    public static string ModelSource() => File.ReadAllText(RepositoryFile(ModelsPath));

    /// <summary>A repository-relative path, resolved from the test assembly's own location.</summary>
    public static string RepositoryFile(string relative)
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null) throw new InvalidOperationException("repository root not found");
        return Path.Combine(directory.FullName, relative);
    }

    /// <summary>Every record the file declares, each with the members of its own parameter list.</summary>
    public static IReadOnlyList<DeclaredRecord> DeclaredRecords(string source)
    {
        string text = StripLineComments(source);
        List<DeclaredRecord> records = new();
        foreach (Match declaration in RecordDeclaration.Matches(text))
        {
            int open = declaration.Index + declaration.Length - 1;
            int close = MatchingClose(text, open, '(', ')');
            records.Add(new DeclaredRecord(
                declaration.Groups[1].Value,
                ParseParameterList(text.Substring(open + 1, close - open - 1))));
        }

        return records;
    }

    /// <summary>The members of the one named record, which must be declared in the source.</summary>
    public static IReadOnlyList<DeclaredMember> DeclaredMembers(string source, string record)
    {
        DeclaredRecord? declared = DeclaredRecords(source).FirstOrDefault(candidate => candidate.Name == record);
        if (declared is null)
            throw new InvalidOperationException($"`public sealed record {record}(` is not declared in the wire models");
        return declared.Members;
    }

    /// <summary>The arguments of one call, comment-stripped and split at its own top level.</summary>
    public static IReadOnlyList<string> TopLevelSegments(string text)
    {
        List<string> segments = new();
        int depth = 0;
        int start = 0;
        for (int index = 0; index < text.Length; index++)
        {
            char character = text[index];
            if (character is '(' or '[' or '{') depth++;
            else if (character is ')' or ']' or '}') depth--;
            else if (character == ',' && depth == 0)
            {
                segments.Add(text.Substring(start, index - start));
                start = index + 1;
            }
        }

        if (start < text.Length) segments.Add(text.Substring(start));
        return segments.Select(segment => segment.Trim()).Where(segment => segment.Length > 0).ToArray();
    }

    /// <summary>
    /// The index of the character closing the one at <paramref name="open"/>, skipping over string and character
    /// literals so a bracket or a parenthesis inside one does not close what it is written inside.
    /// </summary>
    public static int MatchingClose(string text, int open, char opening, char closing)
    {
        int depth = 0;
        for (int index = open; index < text.Length; index++)
        {
            char character = text[index];
            if (character is '"' or '\'')
            {
                index = SkipLiteral(text, index);
                continue;
            }

            if (character == opening) depth++;
            else if (character == closing && --depth == 0) return index;
        }

        throw new InvalidOperationException($"{opening} at {open} is not closed");
    }

    /// <summary>
    /// Strip `//` line comments before splitting: the record is heavily documented, and a comment carrying a paren or a
    /// comma would move both the declaration's closing paren and the member boundaries.
    /// </summary>
    public static string StripLineComments(string text) => string.Join(
        "\n",
        text.Split('\n').Select(line =>
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            return comment == -1 ? line : line.Substring(0, comment);
        }));

    /// <summary>
    /// The members of one parameter list, in declaration order.
    ///
    /// Each declaration is reduced in the order that matters: the leading attributes come off whole, then the default
    /// value, then the name.
    /// </summary>
    private static IReadOnlyList<DeclaredMember> ParseParameterList(string parameters)
    {
        List<DeclaredMember> members = new();
        foreach (string segment in DeclaredParameterSegments(parameters)) members.Add(DeclaredMemberOf(segment));
        return members;
    }

    /// <summary>
    /// Split a parameter list at its top-level commas, counting type arguments as depth.
    ///
    /// `<c>IReadOnlyDictionary&lt;string, int&gt; Facts</c>` is ONE member; without the angle depth the comma inside it
    /// splits the member in two and the halves read as a type name and a member called <c>int</c>.
    /// </summary>
    private static IReadOnlyList<string> DeclaredParameterSegments(string parameters)
    {
        List<string> segments = new();
        int depth = 0;
        int start = 0;
        for (int index = 0; index < parameters.Length; index++)
        {
            char character = parameters[index];
            if (character is '"' or '\'')
            {
                index = SkipLiteral(parameters, index);
                continue;
            }

            if (character is '(' or '[' or '{' or '<') depth++;
            else if (character is ')' or ']' or '}' or '>') depth--;
            else if (character == ',' && depth == 0)
            {
                segments.Add(parameters.Substring(start, index - start));
                start = index + 1;
            }
        }

        if (start < parameters.Length) segments.Add(parameters.Substring(start));
        return segments.Select(segment => segment.Trim()).Where(segment => segment.Length > 0).ToArray();
    }

    private static DeclaredMember DeclaredMemberOf(string segment)
    {
        string declaration = segment;
        List<AppliedAttribute> attributes = new();
        while (declaration.StartsWith("[", StringComparison.Ordinal))
        {
            int close = MatchingClose(declaration, 0, '[', ']');
            attributes.Add(AttributeOf(declaration.Substring(0, close + 1)));
            declaration = declaration.Substring(close + 1).TrimStart();
        }

        // The attributes are behind us, so the first `=` is the default-value separator and not an argument of an
        // attribute that is still in the text.
        int defaultValue = declaration.IndexOf('=');
        string typed = defaultValue < 0 ? declaration : declaration.Substring(0, defaultValue);
        Match name = Regex.Match(typed, MemberName, RegexOptions.CultureInvariant);
        if (!name.Success)
            throw new InvalidOperationException($"unreadable wire-record member declaration: `{segment}`");
        return new DeclaredMember(name.Groups[1].Value, attributes, segment);
    }

    private static AppliedAttribute AttributeOf(string bracketed)
    {
        string inner = bracketed.Substring(1, bracketed.Length - 2).Trim();
        string target = string.Empty;
        Match qualified = Regex.Match(inner, "^([A-Za-z_][A-Za-z0-9_]*)\\s*:", RegexOptions.CultureInvariant);
        if (qualified.Success)
        {
            target = qualified.Groups[1].Value + ":";
            inner = inner.Substring(qualified.Length).TrimStart();
        }

        Match name = Regex.Match(inner, "^[A-Za-z_][A-Za-z0-9_.]*", RegexOptions.CultureInvariant);
        if (!name.Success) throw new InvalidOperationException($"unreadable attribute application: `{bracketed}`");
        int open = name.Index + name.Length;
        IReadOnlyList<string> tokens = inner.Length > open && inner[open] == '('
            ? ArgumentTokens(inner.Substring(open + 1, MatchingClose(inner, open, '(', ')') - open - 1))
            : Array.Empty<string>();
        return new AppliedAttribute(target + name.Value, tokens, bracketed);
    }

    /// <summary>Every identifier and number in an argument list, with quoted text excluded.</summary>
    private static IReadOnlyList<string> ArgumentTokens(string arguments)
    {
        string unquoted = Regex.Replace(
            arguments,
            "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|@\"(?:[^\"]|\"\")*\"",
            " ",
            RegexOptions.CultureInvariant);
        return Regex.Matches(unquoted, "[A-Za-z_][A-Za-z0-9_]*|[0-9]+", RegexOptions.CultureInvariant)
            .Select(match => match.Value)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    /// <summary>The index of the quote that ends the literal starting at <paramref name="quote"/>.</summary>
    private static int SkipLiteral(string text, int quote)
    {
        char delimiter = text[quote];
        bool verbatim = quote > 0 && text[quote - 1] == '@';
        for (int index = quote + 1; index < text.Length; index++)
        {
            if (text[index] == '\\' && !verbatim)
            {
                index++;
                continue;
            }

            if (text[index] != delimiter) continue;
            // A verbatim string (`@"..."`) escapes its own quote by doubling it.
            if (delimiter == '"' && index + 1 < text.Length && text[index + 1] == '"')
            {
                index++;
                continue;
            }

            return index;
        }

        return quote;
    }
}
