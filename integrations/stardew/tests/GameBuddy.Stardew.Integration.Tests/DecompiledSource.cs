using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// One reader over the decompiled engine tree, shared by the gates that pin a body hold the ENGINE enters and the
/// engine itself releases (<c>SelfAnimationHoldTests</c>, <c>WarpingHoldTests</c>).
///
/// <para>
/// The two gates ask the same question of different facts - "is this site still an entry into the hold, and do the
/// engine's own release writes still exist" - so they share the walk rather than keeping a copy each: a second copy
/// of a brace walk and its declaration matching would be a second definition of "the method that contains this line",
/// and the two would disagree the first time one was fixed.
/// </para>
///
/// <para>
/// THE BOUND IS LEXICAL: a method is attributed by a declaration line ending in <c>)</c> whose brace block actually
/// contains the line in question, so a site that lost its method - or moved under a declaration this reader does not
/// recognise - is reported by name instead of silently attributed to the method above it. The decompiled tree keeps
/// every method declaration on one line and writes no <c>/* */</c> block, which is what makes the bound exact here
/// rather than approximate.
/// </para>
/// </summary>
internal static class DecompiledSource
{
    /// <summary>
    /// The engine's source root, relative to the repository root (the tree is gitignored, so it is found by walking
    /// up). It is the directory ABOVE <c>StardewValley/</c> because the engine's types are spread over sibling
    /// namespaces: <c>Game1</c> lives in <c>StardewValley/</c> and <c>ScreenFade</c> in
    /// <c>StardewValley.BellsAndWhistles/</c>, so one gate has to read both.
    /// </summary>
    internal const string RelativeRoot = "ref/external/StardewValleyDecompiled/Stardew Valley";

    /// <summary>The access modifiers the decompiled methods are declared with, in this tree all on one line.</summary>
    private static readonly string[] Declarations = { "public ", "private ", "protected ", "internal " };

    /// <summary>The lines of <paramref name="relativePath"/>, which is relative to <see cref="RelativeRoot"/>.</summary>
    internal static string[] Lines(string relativePath) => File.ReadAllLines(Path.Combine(Root(), relativePath));

    internal static string Root()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            string candidate = Path.Combine(directory.FullName, RelativeRoot);
            if (Directory.Exists(candidate))
                return candidate;
        }

        throw new DirectoryNotFoundException($"{RelativeRoot} is not reachable from {AppContext.BaseDirectory}");
    }

    /// <summary>
    /// The lines with their <c>//</c> comments removed, so a sentence ABOUT a write is never read as the write.
    ///
    /// This is not decoration: with the comment left in place, commenting <c>owner.CanMove = true;</c> out of
    /// <c>doneWithAnimation</c> left <c>SelfAnimationHoldTests</c> green, because the commented line still CONTAINS the
    /// text it looks for. A check that reads prose about a write is a check that passes on the defect it exists for.
    /// </summary>
    internal static IReadOnlyList<string> Code(IReadOnlyList<string> lines) => lines.Select(WithoutComment).ToList();

    internal static string WithoutComment(string line)
    {
        int at = line.IndexOf("//", StringComparison.Ordinal);
        return at < 0 ? line : line[..at];
    }

    /// <summary>The body of the method declared by <paramref name="declaration"/>, or no lines when it is absent.</summary>
    internal static IReadOnlyList<string> MethodBody(IReadOnlyList<string> lines, string declaration)
    {
        for (int index = 0; index < lines.Count; index++)
        {
            if (lines[index].Contains(declaration, StringComparison.Ordinal))
                return BraceBlock(lines, index);
        }

        return Array.Empty<string>();
    }

    /// <summary>
    /// The method name out of a one-line declaration, for a finding that has to name WHICH release went missing.
    /// </summary>
    internal static string MethodName(string declaration)
    {
        int at = declaration.IndexOf('(', StringComparison.Ordinal);
        return at < 0 ? declaration : declaration[..at].Split(' ')[^1];
    }

    /// <summary>
    /// The body of the method that encloses <paramref name="index"/>: the nearest preceding declaration whose brace
    /// block actually contains that line.
    /// </summary>
    internal static IReadOnlyList<string> EnclosingMethod(IReadOnlyList<string> lines, int index)
    {
        for (int candidate = index; candidate >= 0; candidate--)
        {
            string text = lines[candidate].Trim();
            if (!text.EndsWith(")", StringComparison.Ordinal))
                continue;
            if (!Declarations.Any(prefix => text.StartsWith(prefix, StringComparison.Ordinal)))
                continue;
            IReadOnlyList<string> body = BraceBlock(lines, candidate);
            if (body.Count > index - candidate)
                return body;
        }

        return Array.Empty<string>();
    }

    /// <summary>From <paramref name="start"/> to the line closing its first brace block, inclusive.</summary>
    private static IReadOnlyList<string> BraceBlock(IReadOnlyList<string> lines, int start)
    {
        var body = new List<string>();
        int depth = 0;
        bool opened = false;
        for (int index = start; index < lines.Count; index++)
        {
            body.Add(lines[index]);
            foreach (char character in lines[index])
            {
                if (character == '{')
                {
                    depth++;
                    opened = true;
                }
                else if (character == '}')
                {
                    depth--;
                }
            }

            if (opened && depth == 0)
                return body;
        }

        return body;
    }
}
