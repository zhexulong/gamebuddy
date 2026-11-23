using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Which controller partial DECLARES a member, resolved from the source tree instead of written down.
///
/// <para>
/// The execution controller is 48 partial files, and a source-shape test that pins a member's body has to read the
/// file the member is declared in. Those reads used to name <c>farmhandexecutioncontroller.cs</c> directly, which is
/// where every target-discovery member lived - until they were extracted into their own partial. A hardcoded path
/// turns a MOVE into a red gate (<c>row_discovery_missing</c> in <c>tools/check-stardew-crop-row-derivation.mjs</c>
/// was exactly that shape), and the second hardcoded path is the same defect one move later.
/// </para>
///
/// <para>
/// So the file is resolved from the member: <see cref="Declaring"/> scans the controller family and answers with the
/// one file whose declaration of that name it found, and THROWS naming the member when none - or more than one - is
/// found. A test that pins a body therefore keeps pinning the same body wherever the member lives, and a renamed or
/// deleted member fails loudly here rather than silently reading an empty string.
/// </para>
/// </summary>
internal static class ControllerPartials
{
    /// <summary>The dispatcher: the ledger, the frame update and the snapshot assembly.</summary>
    internal const string Main = "farmhandexecutioncontroller.cs";

    /// <summary>The discovery type the dispatcher reads a world through: the `Discover*` family and the caps it applies.</summary>
    internal const string Discovery = "farmhandtargetdiscovery.cs";

    private const string Directory = "integrations/stardew";

    /// <summary>The file NAME of the partial that declares <paramref name="member"/>.</summary>
    internal static string DeclaringFile(string member)
    {
        var declaring = new List<string>();
        foreach ((string file, string source) in Sources())
        {
            if (Declares(source, member)) declaring.Add(file);
        }

        if (declaring.Count == 1) return declaring[0];
        throw new InvalidOperationException(declaring.Count == 0
            ? $"controller_partial_missing: no controller partial declares `{member}`"
            : $"controller_partial_ambiguous: `{member}` is declared in {string.Join(", ", declaring)}");
    }

    /// <summary>The whole text of the partial that declares <paramref name="member"/>.</summary>
    internal static string Declaring(string member) => ReadFile(Path.Combine(Directory, DeclaringFile(member)));

    /// <summary>Every controller partial's text, for a test whose subject is the family rather than one file.</summary>
    internal static string All() =>
        string.Join("\n\n", Sources().Select(entry => entry.Source));

    /// <summary>One named file under <c>integrations/stardew</c>.</summary>
    internal static string Read(string fileName) => ReadFile(Path.Combine(Directory, fileName));

    /// <summary>The controller family as (file name, text), in a stable order.</summary>
    internal static IEnumerable<(string File, string Source)> Sources()
    {
        string directory = Path.Combine(RepositoryRoot(), Directory);
        return new[] { "farmhandexecutioncontroller*.cs", "farmhandtargetdiscovery*.cs" }
            .SelectMany(pattern => System.IO.Directory.EnumerateFiles(directory, pattern))
            .OrderBy(path => path, StringComparer.Ordinal)
            .Select(path => (Path.GetFileName(path), File.ReadAllText(path)));
    }

    /// <summary>
    /// A DECLARATION of <paramref name="member"/>: a member signature line, not a call site or a `nameof`.
    /// </summary>
    private static bool Declares(string source, string member)
    {
        string marker = $" {member}(";
        int at = source.IndexOf(marker, StringComparison.Ordinal);
        while (at >= 0)
        {
            int lineStart = source.LastIndexOf('\n', Math.Max(at - 1, 0)) + 1;
            string line = source[lineStart..(at + marker.Length)];
            string trimmed = line.TrimStart();
            if (trimmed.StartsWith("private ", StringComparison.Ordinal)
                || trimmed.StartsWith("internal ", StringComparison.Ordinal)
                || trimmed.StartsWith("public ", StringComparison.Ordinal)
                || trimmed.StartsWith("protected ", StringComparison.Ordinal))
                return true;
            at = source.IndexOf(marker, at + marker.Length, StringComparison.Ordinal);
        }
        return false;
    }

    private static string ReadFile(string relative) => File.ReadAllText(Path.Combine(RepositoryRoot(), relative));

    private static string RepositoryRoot()
    {
        string? directory = AppContext.BaseDirectory;
        while (directory is not null && !System.IO.Directory.Exists(Path.Combine(directory, "integrations")))
            directory = Path.GetDirectoryName(directory);
        return directory ?? throw new InvalidOperationException("repository_root_not_found");
    }
}
