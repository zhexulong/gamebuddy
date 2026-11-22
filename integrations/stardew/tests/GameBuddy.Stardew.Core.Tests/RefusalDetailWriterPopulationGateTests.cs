using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// EVERY WRITER OF A REFUSAL DETAIL BOUNDS IT AT THE PRODUCER.
///
/// <para>
/// Measured `round92`: two `no_native_path` refusals carried 544 and 698 characters of route evidence into
/// `RefusalDetail`, the journal refused them (`BodyProgramValidation.IsValidRefusalDetail`), and the controller settled
/// those nodes `RecoveryRequired` - so a legitimate refusal changed its STATE because its text was long. The fix is a
/// bounded write where the detail is written (<c>BodyProgramValidation.BoundRefusalDetail</c>); this gate is the reason the
/// NEXT writer cannot reintroduce the defect.
/// </para>
/// <para>
/// The population is derived from the record it protects, not from a list of files this gate remembered: the terminal's
/// three reason fields are `init` properties, so every writer names the field it writes and no writer can hand a ninth
/// positional argument past the scan. That shape is asserted first - a positional field would make the second check blind
/// while it stayed green.
/// </para>
/// <para>
/// A WRITE is an assignment into the field. A derived property (`internal string RefusalDetail => ...`) reads the field's
/// name and computes something else, and a variable that merely ends in `RefusalDetail` is not this field at all; both are
/// left alone, and what remains is every place a reason detail is stored.
/// </para>
/// </summary>
public sealed class RefusalDetailWriterPopulationGateTests
{
    private const string TerminalModels = "integrations/stardew/src/Core/BodyPrograms/BodyProgramModels.cs";
    private const string BoundWrite = "BoundRefusalDetail(";

    /// <summary>`RefusalDetail = value`, never `RefusalDetail => value`, never a longer identifier that ends in it.</summary>
    private static readonly Regex WriteSite = new(@"(?<![A-Za-z0-9_])RefusalDetail\s*=(?![=>])", RegexOptions.CultureInvariant);

    /// <summary>
    /// The record's reason fields are written by name, which is what makes the write population below complete.
    /// </summary>
    [Fact]
    public void TheTerminalsReasonFieldsAreNamedPropertiesSoNoWriteCanBePositional()
    {
        string terminal = TerminalRecord(Read(TerminalModels));

        foreach (string field in new[] { "FailureCode", "Hint", "RefusalDetail" })
            terminal.Should().Contain(
                $"public string? {field} {{ get; init; }}",
                $"{field} is a reason field: written by name, so every writer is a site this gate can see and a swapped pair of strings cannot compile");
        terminal.Should().NotContain(
            "string? RefusalDetail = null",
            "a positional RefusalDetail can be written as the ninth constructor argument, where no scan of the named writes would find it");
    }

    /// <summary>
    /// One bounded spelling per write: `BodyProgramValidation.BoundRefusalDetail(...)`, or the word for "no detail".
    /// </summary>
    [Fact]
    public void EveryNamedWriteOfARefusalDetailBoundsItOrStatesNone()
    {
        string root = RepositorySourcePath("integrations/stardew");
        string[] production = Directory
            .EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Select(path => path.Replace('\\', '/'))
            .Where(path => !path.Contains("/tests/", StringComparison.Ordinal))
            .Where(path => !path.Contains("/bin/", StringComparison.Ordinal) && !path.Contains("/obj/", StringComparison.Ordinal))
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();
        production.Should().NotBeEmpty("a scan with no production file would agree with itself");

        var examined = new List<string>();
        var unbounded = new List<string>();
        foreach (string file in production)
        {
            string[] lines = File.ReadAllLines(file);
            for (int index = 0; index < lines.Length; index += 1)
            {
                string line = lines[index];
                Match match = WriteSite.Match(line);
                if (!match.Success) continue;
                string value = line[(match.Index + match.Length)..].Trim();
                string site = $"{Path.GetRelativePath(root, file)}:{index + 1}";
                examined.Add(site);
                if (!value.StartsWith("null", StringComparison.Ordinal) && !value.Contains(BoundWrite, StringComparison.Ordinal))
                    unbounded.Add($"{site} writes `{value}`");
            }
        }

        examined.Should().NotBeEmpty(
            $"no `RefusalDetail =` site was found in {production.Length} production files, so this gate read nothing and agrees with itself");
        unbounded.Should().BeEmpty(
            $"{examined.Count} reason-detail write(s) examined; every one must bound what it writes, or the journal refuses the detail "
            + "and the controller settles an ordinary refusal as RecoveryRequired. Examined: "
            + string.Join(", ", examined));
    }

    /// <summary>The terminal record only, so a `Hint` property elsewhere cannot stand in for the one this gate protects.</summary>
    private static string TerminalRecord(string source)
    {
        int start = source.IndexOf("public sealed record BodyProgramTerminalResult(", StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "the terminal record is where a writer names its reason fields");
        int next = source.IndexOf("public sealed record VerifiedBodyProgramNode(", start, StringComparison.Ordinal);
        next.Should().BeGreaterThan(start);
        return source[start..next];
    }

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate) || Directory.Exists(candidate)) return candidate;
            }
        }
        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
