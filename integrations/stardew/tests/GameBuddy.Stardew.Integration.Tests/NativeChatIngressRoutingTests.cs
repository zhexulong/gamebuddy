using System.Text;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

// MIXED SHAPE AND BEHAVIOUR: the routing test drives the real session and wire objects with a real submitted line, while
// the two pins read the Mod's own source. The pins are the only form available for what they ask - the game thread that
// carries a keystroke cannot be started in a test, and "this Mod adds no input surface of its own" is a fact about what
// the source contains rather than about a return value.
public sealed class NativeChatIngressRoutingTests
{
    /// <summary>
    /// The player's way in is the engine's own chat box, opened by the engine's own key: <c>Game1.UpdateChatBox</c> at
    /// <c>Game1.cs:12484</c> compares <c>options.chatButton</c> (T by default) and calls <c>chatBox.activate()</c> in a
    /// block with no multiplayer gate (verified against the decompiled 1.6.15 tree, lines 12454-12492). Everything this
    /// Mod owns is downstream of that: a Harmony postfix on the submit seam, the fact, the pipe frame.
    /// </summary>
    private static readonly string[] ForbiddenInputSurfaceTokens =
    {
        // the removed feature, by every spelling it had
        "CompanionChat",
        "companionChat",
        "companion_chat",
        "OpenKey",
        // a key subscription: the engine already answers one
        "Events.Input",
        "ButtonPressed",
        // the Mod opening the box, rather than the player
        "Game1.chatBox.activate()",
        // the words the removed feature drew: a hint teaching a key, and a title over the engine's own box
        "addHUDMessage(",
        "(typeof(ChatBox), \"draw\"",
    };

    [Fact]
    public void ASubmittedLineReachesTheHostAsPlayerInputWithTheSameBytes()
    {
        // The exact string the engine hands its submit seam for a line the player typed: unicode, punctuation, and
        // deliberate leading/trailing spaces, because a pipeline that trimmed or re-formatted it would still "work".
        const string Submitted = "  琥珀, head to the mine — 记得带镐。 ";

        NativeChatIngressPolicy.ClassifySubmittedText(Submitted)
            .Should().Be(NativeChatIngressTextClassification.Ordinary,
                "an ordinary line the player submitted is the one thing this ingress exists to carry");

        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal));
        BridgeScope scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");
        const string token = "player_input_routing_0123456789abcdef";
        BridgeSession session = new(
            new ExecutionManager(new DummyMonitor(), () => publication),
            new FarmhandActionRouter(),
            scope,
            token,
            () => publication,
            () => "en-US");
        BridgeEnvelope<BridgeHello> hello = new(
            BridgeProtocol.Version,
            "hello_player_input_01",
            "hello_player_input_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(token));
        session.TryAuthenticate(1, hello, out _, out string helloReason).Should().BeTrue(helloReason);

        // The fact the AI client mints from the received ModMessage: name for name the constructor call in
        // ModEntry.OnModMessageReceived, with the received text in its one text position.
        BridgePlayerControlFact fact = new(PlayerControlProtocol.PlayerInput, "control_01", "source_01", Submitted, "en-US", "player_01");
        session.TryCreatePlayerControlEvent(1, fact, "player_control_01", out string json)
            .Should().BeTrue("an authenticated generation must be able to publish the player's own line");

        using JsonDocument document = JsonDocument.Parse(json);
        document.RootElement.GetProperty("type").GetString().Should().Be("semantic_event");
        JsonElement payload = document.RootElement.GetProperty("payload");
        payload.GetProperty("kind").GetString().Should().Be(PlayerControlProtocol.PlayerInput,
            "the opener is `player_input`: the person spoke");
        payload.GetProperty("reasonCode").GetString().Should().Be("player_control");
        payload.GetProperty("playerControl").GetProperty("text").GetString().Should().Be(Submitted,
            "the same characters the engine submitted have to arrive: no trim, no locale rewriting, no truncation");
    }

    [Fact]
    public void TheEngineSubmittedTextTravelsToTheFactWithoutBeingRewritten()
    {
        string modEntry = Code(ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModEntry.cs")));

        string postfix = MethodBody(modEntry, "private static void NativeChatTextBoxEnterPostfix(");
        postfix.Should().Contain("ObserveNativeChatText(text_to_send)",
            "the engine's submitted argument is forwarded as-is; a hop that renamed or copied it could also rewrite it");

        string observer = MethodBody(modEntry, "private void ObserveNativeChatText(");
        observer.Should().Contain("PublishNativeChat(PlayerControlProtocol.PlayerInput, text, null)",
            "the same text variable is published with the player_input kind");

        string publish = MethodBody(modEntry, "private void PublishNativeChat(");
        publish.Should().Contain("PlayerControlModMessage message = new(")
            .And.Contain(", text, locale)", "the message carries the same text variable in its one text position");

        string receive = MethodBody(modEntry, "private void OnModMessageReceived(");
        receive.Should().Contain("BridgePlayerControlFact fact = new(message.Kind, message.ControlId, message.SourceEventId, message.Text,",
            "the received text is carried into the fact in its own position, not through a derived value");

        foreach (string body in new[] { postfix, observer, publish, receive })
        {
            foreach (string rewrite in new[] { ".Trim(", ".TrimEnd(", ".TrimStart(", ".ToLower(", ".ToUpper(", ".Replace(" })
            {
                body.Should().NotContain(rewrite,
                    "nothing on the path from the submit seam to the fact may rewrite what the player typed");
            }
        }
    }

    [Fact]
    public void TheModBindsNoKeyOfItsOwn()
    {
        // Game1.cs:12484 is the whole reason this can hold: the engine opens its own chat box on options.chatButton with
        // no multiplayer gate, so a key of our own would be a second owner of one door and a hint teaching a key that
        // already works. If an input surface is ever genuinely needed, it has to be declared here with the vanilla key it
        // duplicates - not added quietly beside an engine that already answers the question.
        IReadOnlyList<string> sources = ProductionSources();
        sources.Should().HaveCountGreaterThan(200,
            "the population is every production .cs file found by walking the tree; a walk that finds nothing agrees with itself");

        List<string> findings = new();
        foreach (string path in sources)
        {
            string code = Code(File.ReadAllText(path));
            foreach (string token in ForbiddenInputSurfaceTokens)
            {
                if (code.Contains(token, StringComparison.Ordinal))
                    findings.Add($"{RelativeToRepository(path)} still contains '{token}'");
            }
        }

        findings.Should().BeEmpty(
            "the Mod observes the text the engine submits and binds nothing: {0}", string.Join("; ", findings));
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────

    private static IReadOnlyList<string> ProductionSources()
    {
        string mod = Path.Combine(RepositoryRoot(), "integrations", "stardew");
        return Directory.EnumerateFiles(mod, "*.cs", SearchOption.AllDirectories)
            .Where(path => !IsTestOrBuildArtifact(Path.GetRelativePath(mod, path)))
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();
    }

    private static bool IsTestOrBuildArtifact(string relativePath)
    {
        string[] segments = relativePath.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return segments[0].Equals("tests", StringComparison.OrdinalIgnoreCase)
            || segments.Any(segment => segment.Equals("bin", StringComparison.OrdinalIgnoreCase)
                || segment.Equals("obj", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// The repository root, found by CONTENT rather than by a fixed number of <c>..</c> hops: the test binary's output
    /// depth changes with the configuration, and a count that silently resolved to the wrong directory would leave every
    /// pin below reading no file at all.
    /// </summary>
    private static string RepositoryRoot()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "integrations", "stardew", "ModEntry.cs")))
                return directory.FullName;
        }

        throw new DirectoryNotFoundException($"no repository root above {AppContext.BaseDirectory}");
    }

    private static string RelativeToRepository(string path) =>
        Path.GetRelativePath(RepositoryRoot(), path);

    private static string ReadRepositoryFile(string relativePath) =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), relativePath));

    /// <summary>
    /// The source with every <c>//</c> comment (and the URL inside a string, which this Mod never contains) removed, so a
    /// sentence ABOUT the removed feature is not read as the feature. Without this the gate would stay red on prose that
    /// explains why the surface is gone.
    /// </summary>
    private static string Code(string source)
    {
        StringBuilder builder = new(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }

        return builder.ToString();
    }

    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        if (start < 0)
            return string.Empty;
        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        return source[start..];
    }
}
