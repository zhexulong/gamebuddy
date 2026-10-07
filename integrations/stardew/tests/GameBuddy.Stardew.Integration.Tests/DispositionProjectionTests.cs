using FluentAssertions;
using Xunit;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The snapshot's disposition is the World Model's single authority, PROJECTED. These tests pin the two
/// halves that matter: every kind the classifier can produce is expressible on the wire, and the snapshot
/// reads the value the controller already computed rather than deriving its own.
/// </summary>
public class DispositionProjectionTests
{
    private static string ReadSource(params string[] relativeParts) =>
        File.ReadAllText(Path.Combine(new[] { RepositoryRoot() }.Concat(relativeParts).ToArray()));

    private static string RepositoryRoot()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the repository root is the directory holding AGENTS.md");
        return directory!.FullName;
    }

    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int depth = 0;
        int first = source.IndexOf('{', start);
        for (int i = first; i < source.Length; i++)
        {
            if (source[i] == '{') depth++;
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0) return source[start..(i + 1)];
            }
        }
        return source[start..];
    }

    [Fact]
    public void EveryDispositionKindTheClassifierProducesIsOnTheWire()
    {
        // The Host validates a CLOSED set. Two ways to get this wrong, and the first one shipped for a few
        // minutes before this test existed: deriving the wire value with Kind.ToString().ToLowerInvariant()
        // gives `passout` for the enum member `PassOut` while the contract says `pass_out`, so the bridge
        // would close with invalid_snapshot:actorDispositionKind:passout exactly when the actor faints; and a
        // kind the Mod can produce but the Host rejects breaks the same way. So this asserts the MAPPING:
        // every enum member has one, and the mapped values are exactly the set the Host accepts.
        string worldModel = ReadSource("integrations", "stardew", "WorldModel.cs");
        int at = worldModel.IndexOf("public enum ActorDispositionKind", StringComparison.Ordinal);
        at.Should().BeGreaterThanOrEqualTo(0);
        int open = worldModel.IndexOf('{', at);
        int close = worldModel.IndexOf('}', open);
        List<string> enumMembers = worldModel[(open + 1)..close]
            .Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(part => part.Trim())
            .Where(part => part.Length > 0)
            .ToList();
        enumMembers.Should().HaveCount(5);

        int mapAt = worldModel.IndexOf("KindForWire(ActorDispositionKind kind) => kind switch", StringComparison.Ordinal);
        mapAt.Should().BeGreaterThanOrEqualTo(0, "the wire spelling must be an explicit mapping");
        int mapEnd = worldModel.IndexOf("    };", mapAt, StringComparison.Ordinal);
        mapEnd.Should().BeGreaterThan(mapAt);
        string mapping = worldModel[mapAt..mapEnd];

        List<string> mapped = new();
        foreach (string member in enumMembers)
        {
            string needle = "ActorDispositionKind." + member + " => " + "\"";
            int lineAt = mapping.IndexOf(needle, StringComparison.Ordinal);
            lineAt.Should().BeGreaterThanOrEqualTo(0, $"the wire mapping must cover {member}");
            int valueStart = lineAt + needle.Length;
            int valueEnd = mapping.IndexOf("\"", valueStart, StringComparison.Ordinal);
            valueEnd.Should().BeGreaterThan(valueStart);
            mapped.Add(mapping[valueStart..valueEnd]);
        }

        // The set the Host accepts, read from the validator rather than restated here.
        string protocol = ReadSource("host", "src", "protocol.ts");
        int acceptAt = protocol.IndexOf("includes(value.actorDispositionKind)", StringComparison.Ordinal);
        acceptAt.Should().BeGreaterThanOrEqualTo(0, "the Host must validate the kind against a set");
        int acceptStart = protocol.LastIndexOf('[', acceptAt);
        int acceptEnd = protocol.IndexOf(']', acceptStart);
        List<string> accepted = protocol[(acceptStart + 1)..acceptEnd]
            .Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(part => part.Trim().Trim('"'))
            .Where(part => part.Length > 0)
            .ToList();

        mapped.Should().BeEquivalentTo(accepted, "the Mod's wire spellings and the Host's accepted set are the same set");
        mapped.Should().Contain("pass_out", "the enum member PassOut maps to pass_out, not to the lowercase of its name");
    }

    [Fact]
    public void TheSnapshotReadsTheDispositionTheControllerAlreadyComputed()
    {
        // One authority: Update() computes it once (farmhandexecutioncontroller.cs:1070), the snapshot
        // PROJECTS that value. A second ComputeDisposition call in the snapshot path would be a second
        // authority that could disagree with admission and the body loop within the same tick.
        string controller = ReadSource("integrations", "stardew", "farmhandexecutioncontroller.cs");
        controller.Should().Contain("this.disposition = WorldModel.ComputeDisposition(Game1.player);");

        // Every occurrence of the call must be an assignment to the field: one per tick, never inside the
        // snapshot construction.
        int calls = 0;
        int assignments = 0;
        int from = 0;
        while ((from = controller.IndexOf("WorldModel.ComputeDisposition(", from, StringComparison.Ordinal)) >= 0)
        {
            string line = controller[..from].Split('\n')[^1];
            // A comment may mention the call: the controller's own XML doc writes it with parens. Only an
            // executable occurrence counts, so documentation lines are skipped.
            if (!line.TrimStart().StartsWith("///", StringComparison.Ordinal))
            {
                calls++;
                if (line.Contains("this.disposition =", StringComparison.Ordinal)) assignments++;
            }
            from += 1;
        }
        calls.Should().Be(1, "the disposition is computed once per tick and stored, never recomputed for a projection");
        assignments.Should().Be(calls);

        string models = ReadSource("integrations", "stardew", "src", "Core", "Models", "BridgeProtocolModels.cs");
        models.Should().Contain("string ActorDispositionKind = \"idle\"");

        string snapshotBuild = controller;
        snapshotBuild.Should().Contain("ActorDispositionKind: WorldModel.KindForWire(this.disposition.Kind)");
        snapshotBuild.Should().Contain("ActorDispositionDetail: this.disposition.ModalType ?? this.disposition.TransientKind");
        snapshotBuild.Should().Contain("ActorDispositionActionOwned: this.disposition.ModalActionOwned");
    }

    [Fact]
    public void TheWorldNotReadySnapshotPublishesIdleRatherThanAnAbsentField()
    {
        // The field is sent on EVERY snapshot, including the not-ready one, so a consumer never has to
        // decide what a missing disposition means.
        string controller = ReadSource("integrations", "stardew", "farmhandexecutioncontroller.cs");
        controller.Should().Contain("ActorDispositionKind: \"idle\"");
    }
}
