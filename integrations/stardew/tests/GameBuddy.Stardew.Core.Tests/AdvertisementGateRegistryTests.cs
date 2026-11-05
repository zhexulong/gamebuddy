using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// EVERY CAPABILITY THE MOD PUBLISHES A SNAPSHOT FAMILY FOR NAMES AN ACTION THE SURFACE REGISTERS.
///
/// <para>
/// <b>Why this exists.</b> <c>reconcile:stardew-action-inventory</c> reported four <c>family_gated_off</c> findings: four
/// snapshot families were never published to anyone. The terms gating them named <c>break_rock_source</c>,
/// <c>chop_tree_source</c> and <c>break_container_source</c> - the handler names before the actions were renamed to
/// <c>break_rock</c>, <c>chop_tree</c> and <c>break_container</c>. <c>FarmhandCapabilitySet</c> advertises ids drawn
/// from <see cref="FarmhandActionCatalog.Registrations"/> plus the two protocol controls, so each of those three terms
/// was a constant <c>false</c>: <c>rockSourceTargets</c> and <c>treeChopSourceTargets</c> were withheld from every
/// snapshot, which left <c>break_rock</c> and <c>chop_tree</c> without an addressable target at all.
/// </para>
/// <para>
/// A rename is what produced it, so this gate cannot be a list of ids checked by hand: the population is every
/// advertisement term in the Mod's own sources, and the authority for "registered" is
/// <see cref="FarmhandActionCatalog.Registrations"/> - the same table <c>FarmhandActionSurfacePublication</c> exports
/// and <c>FarmhandCapabilitySet</c> advertises from. A term added tomorrow for an action that is never registered fails
/// here, whatever the family it gates.
/// </para>
/// <para>
/// The other half of that defect no single term can express: <c>worldObjectTargets</c> was gated on the three actions
/// that carry no furniture rows, so <c>move_placed_furniture</c> - the one action whose target only that family carries
/// - saw no target while it was the only action advertised. That is a coverage question over the WHOLE chain, measured
/// by <c>PublicationGateCoverage</c> in the reconciliation tool by joining each action's declared family against these
/// terms; this test checks the terms themselves.
/// </para>
/// </summary>
public sealed class AdvertisementGateRegistryTests
{
    /// <summary>
    /// One <c>&lt;set&gt;.Contains("&lt;action id&gt;", StringComparer.X)</c> term of an advertisement chain.
    ///
    /// The receiver is deliberately not named: the one property under test is that a quoted action id tested for
    /// ordinal membership against a set is a registered id, so renaming the capability list must not silence the gate.
    /// </summary>
    private static readonly Regex AdvertisementTerm = new(
        "\\.Contains\\(\\s*\"(?<actionId>[a-z][a-z0-9_]*)\"\\s*,\\s*StringComparer\\.\\w+\\s*\\)",
        RegexOptions.CultureInvariant);

    [Fact]
    public void EveryAdvertisementTermNamesARegisteredAction()
    {
        HashSet<string> registered = FarmhandActionCatalog.Registrations
            .Select(registration => registration.ActionId)
            .ToHashSet(StringComparer.Ordinal);
        registered.Should().HaveCountGreaterThan(
            50,
            "the catalog is the authority this gate checks against, so reading none of it proves nothing");

        List<string> terms = new();
        List<string> unregistered = new();
        foreach (string path in ModSourceFiles())
        {
            string code = WithoutComments(File.ReadAllText(path));
            foreach (Match term in AdvertisementTerm.Matches(code))
            {
                string actionId = term.Groups["actionId"].Value;
                terms.Add(actionId);
                if (!registered.Contains(actionId))
                    unregistered.Add($"{RelativePath(path)}:{LineOf(code, term.Index)} names \"{actionId}\"");
            }
        }

        // A floor, not an exact count: the chain around each Discover* call is the thing measured, and a reader that
        // found none would pass over a Mod with no gates at all.
        terms.Should().HaveCountGreaterThanOrEqualTo(
            75,
            "the Mod gates its snapshot families on advertised capabilities, and this gate has to see those terms");

        unregistered.Should().BeEmpty(
            "a gate term naming an action the surface does not register is a constant false - `advertisedCapabilities` "
                + "is built from FarmhandActionCatalog.Registrations (plus the two protocol controls, which no gate names) "
                + "- so the family it publishes is never published, and the action that needed a row from it has no "
                + "addressable target. Name the registered id, or delete the term when the action is gone; a rename must "
                + "not leave a gate behind:\n  "
                + string.Join("\n  ", unregistered));
    }

    // ---- the population, derived from the authorities ---------------------------------------------------

    /// <summary>The Mod's own <c>.cs</c> sources: the tree the advertisement chains live in.</summary>
    private static IReadOnlyList<string> ModSourceFiles()
    {
        var excluded = new HashSet<string>(new[] { "bin", "obj", "tests", "action-development" }, StringComparer.Ordinal);
        List<string> files = new();
        Collect(new DirectoryInfo(ModRoot()), files, excluded);
        files.Sort(StringComparer.Ordinal);
        files.Should().NotBeEmpty("the Mod root must hold the sources the gates are written in");
        return files;
    }

    private static void Collect(DirectoryInfo directory, List<string> files, HashSet<string> excluded)
    {
        foreach (DirectoryInfo child in directory.EnumerateDirectories().OrderBy(entry => entry.Name, StringComparer.Ordinal))
            if (!excluded.Contains(child.Name))
                Collect(child, files, excluded);
        files.AddRange(directory.EnumerateFiles("*.cs").Select(file => file.FullName));
    }

    /// <summary>
    /// The source with its comments removed and its string literals INTACT, newlines preserved.
    ///
    /// A gate that reads prose is a gate on the explanation of its own rule: the three stale ids this test was written
    /// for are also named in doc comments by the very commits that renamed them.
    /// </summary>
    private static string WithoutComments(string source)
    {
        var result = new StringBuilder(source.Length);
        for (int position = 0; position < source.Length; position++)
        {
            char current = source[position];
            char next = position + 1 < source.Length ? source[position + 1] : '\0';
            if (current == '/' && next == '/')
            {
                while (position < source.Length && source[position] != '\n') position++;
                result.Append('\n');
                continue;
            }

            if (current == '/' && next == '*')
            {
                position += 2;
                while (position < source.Length && !(source[position] == '*' && position + 1 < source.Length && source[position + 1] == '/'))
                {
                    if (source[position] == '\n') result.Append('\n');
                    position++;
                }

                position++;
                continue;
            }

            if (current == '"' || current == '\'')
            {
                char quote = current;
                result.Append(current);
                position++;
                while (position < source.Length)
                {
                    if (source[position] == '\\')
                    {
                        result.Append(source, position, 2);
                        position++;
                        continue;
                    }

                    result.Append(source[position]);
                    if (source[position] == quote) break;
                    position++;
                }

                continue;
            }

            result.Append(current);
        }

        return result.ToString();
    }

    private static int LineOf(string code, int index) => code.Substring(0, index).Count(character => character == '\n') + 1;

    // ---- repository paths --------------------------------------------------------------------------------

    private static string ModRoot() => RepositoryPath("integrations/stardew");

    private static string RelativePath(string absolute) => Path.GetRelativePath(RepositoryRoot(), absolute).Replace('\\', '/');

    private static string RepositoryPath(string relative) => Path.Combine(RepositoryRoot(), relative.Replace('/', Path.DirectorySeparatorChar));

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null) throw new InvalidOperationException("repository root not found");
        return directory.FullName;
    }
}
