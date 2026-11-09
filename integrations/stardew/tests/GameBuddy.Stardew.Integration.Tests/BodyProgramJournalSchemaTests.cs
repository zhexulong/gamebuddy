using System.Globalization;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// One schema-version number, in one place, so an older payload can never be read by a second opinion.
///
/// <para>
/// The defect class: a codec that grows a new key and keeps reading the old shape "because it still parses". The Mod's
/// answer is that an older payload is SUPERSEDED - counted, set aside intact, replaced by a fresh journal
/// (<c>BodyProgramJournalPersistence.TryReadSchemaVersion</c>) - and the only way that stays true is that no other reader
/// spells the number. A single inline `version &lt; 3` anywhere in the codec would be a second schema decision, taken
/// silently, in a file whose whole contract is that there is exactly one.
/// </para>
/// <para>
/// The population is the codec source itself, read through the working tree so a failure names the file. The behavioural
/// twin - a v3 payload that violates every current rule still yields only counts and zero programs - is
/// <c>BodyProgramJournalSupersedeTests.AnOlderJournalIsSetAsideWithItsCountsAndAFreshWritableOneStarts</c> in the Core
/// suite.
/// </para>
/// </summary>
public sealed class BodyProgramJournalSchemaTests
{
    private const string CodecFile = "integrations/stardew/src/Core/BodyPrograms/BodyProgramJournalPersistence.cs";

    /// <summary>
    /// The other half of the same read path: the authority is the place that DECIDES an older payload is set aside, so a
    /// literal here would be the likelier drift of the two.
    /// </summary>
    private const string AuthorityFile = "integrations/stardew/src/Core/BodyPrograms/OpenBodyProgramJournalAuthority.cs";

    [Fact]
    public void TheReadPathDerivesEveryVersionDecisionFromTheOneDeclaration()
    {
        string source = File.ReadAllText(RepositoryFile(CodecFile));

        Match[] declarations = Regex.Matches(source, @"\bSchemaVersion\s*=\s*(\d+)").ToArray();
        declarations.Should().ContainSingle($"{CodecFile} must declare the payload shape number in exactly one place");
        declarations[0].Groups[1].Value.Should().Be(BodyProgramJournalPersistence.SchemaVersion.ToString(CultureInfo.InvariantCulture),
            "the declared constant is the authority every reader must derive from");

        // Both directions of the version comparison are derived from the constant, in both readers. A literal here is a
        // second schema decision, and it is the one that would silently reinterpret an older payload instead of setting it
        // aside - or discard a newer one it cannot read.
        foreach (string file in new[] { CodecFile, AuthorityFile })
        {
            string[] numericComparisons = Regex.Matches(File.ReadAllText(RepositoryFile(file)), @"(?:schemaVersion|SchemaVersion|fromSchema)\s*(?:==|!=|<=|>=|<|>)\s*-?\d")
                .Select(match => match.Value).ToArray();
            numericComparisons.Should().BeEmpty(
                $"{file} must compare versions against SchemaVersion, never against a literal: {string.Join(", ", numericComparisons)}");
        }
    }

    private static string RepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            for (DirectoryInfo? directory = new(start); directory is not null; directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate)) return candidate;
            }
        }
        throw new FileNotFoundException($"Could not locate {relative} from {AppContext.BaseDirectory}.");
    }
}
