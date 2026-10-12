using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// send_multiplayer_chat contract pins.
///
/// Seam: the game's OWN chat egress, <c>Multiplayer.sendChatMessage(LanguageCode, string, long)</c>
/// (Multiplayer.cs:1127), addressed to <c>Multiplayer.AllPlayers</c>. It is <c>virtual</c> and it
/// branches on <c>Game1.IsClient</c> / <c>Game1.IsServer</c> itself (:1129-1148), so the Mod must
/// call it and never reproduce either half. The double below overrides exactly that method, records
/// the arguments it received, and can invoke the base implementation so the pin does not merely
/// assume the call reached the game.
///
/// The receipt proves the SEND and nothing more. A lane that arrived somewhere says nothing about
/// anyone reading it, so the terminal code is <c>chat_message_sent</c>, the evidence says
/// <c>sent=true</c>, and there is no assertion anywhere that a client received the line - the
/// observable effect of a private relay does not exist in this process. A native call that throws
/// is <c>Uncertain</c>: the line may already be gone, which is neither a success nor a retry.
///
/// The multiplayer topology facts, the egress field and the lobby dictionary are Game1 statics, so
/// each probe saves and restores them (the suite serializes its assembly for exactly this reason).
/// </summary>
public sealed class SendMultiplayerChatTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.chatactions.cs";
    private const string DecompiledRelativeRoot = @"ref\external\StardewValleyDecompiled\Stardew Valley";

    private static readonly string[] ReasonCodes =
    {
        "chat_message_sent",
        "chat_multiplayer_only",
        "chat_message_invalid",
        "chat_rate_limited",
        "chat_egress_unavailable",
        "chat_message_native_exception",
    };

    // -----------------------------------------------------------------------------------------
    // The happy path: the call reaches the game's own egress with the whole lobby as recipient
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Sends_OnAServer_ReachesTheGamesOwnEgressForEveryPlayer()
    {
        var sink = new RecordingMultiplayer(invokeBase: true);
        LocalExecutionReceipt? receipt = null;

        InMultiplayerSession(CompanionSessionHosting.ServerMultiplayerMode, sink, () =>
            receipt = Manager().RequestLocalSendMultiplayerChat("req_chat_server_1", "hello farm", FutureDeadline()));

        sink.Sends.Should().Equal((LocalizedContentManager.CurrentLanguageCode, "hello farm", Multiplayer.AllPlayers));

        receipt.Should().NotBeNull();
        receipt!.State.Should().Be(ExecutionState.Succeeded);
        receipt.ReasonCode.Should().Be("chat_message_sent");
        // The one claim this receipt is allowed to make, spelled out: the recipient is the whole
        // lobby, the length is the text's, the role is the engine's, and the send happened.
        receipt.Evidence.Should().Be("recipient=all_players;length=10;role=server;sent=true");
    }

    [Fact]
    public void Sends_OnAClient_ReportsTheClientRole()
    {
        // The double records only. The base method's client half relays into Game1.client, which a
        // headless process does not have; what a client's send must prove is the argument triple,
        // which is asserted here, and the relay itself belongs to the live lobby gate.
        var sink = new RecordingMultiplayer();
        LocalExecutionReceipt? receipt = null;

        InMultiplayerSession(1, sink, () =>
            receipt = Manager().RequestLocalSendMultiplayerChat("req_chat_client_1", "hi", FutureDeadline()));

        sink.Sends.Should().Equal((LocalizedContentManager.CurrentLanguageCode, "hi", Multiplayer.AllPlayers));
        receipt!.State.Should().Be(ExecutionState.Succeeded);
        receipt.Evidence.Should().Contain("role=client");
    }

    // -----------------------------------------------------------------------------------------
    // One test per refusal
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Refusal_WithoutALobby_IsChatMultiplayerOnly_AndNeverTouchesTheEgress()
    {
        // The egress instance IS resolvable here, so a non-empty recording would mean the refusal
        // came from a missing object rather than from the engine's topology.
        var sink = new RecordingMultiplayer(invokeBase: true);
        LocalExecutionReceipt? receipt = null;

        InMultiplayerSession(mode: 0, sink, () =>
            receipt = Manager().RequestLocalSendMultiplayerChat("req_chat_solo_1", "hello", FutureDeadline()));

        receipt!.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("chat_multiplayer_only");
        sink.Sends.Should().BeEmpty("a single-player world has no lobby to speak to");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Refusal_EmptyOrBlankText_IsChatMessageInvalid(string text)
    {
        var sink = new RecordingMultiplayer();
        LocalExecutionReceipt? receipt = null;

        InMultiplayerSession(CompanionServerMode, sink, () =>
            receipt = Manager().RequestLocalSendMultiplayerChat("req_chat_blank_1", text, FutureDeadline()));

        receipt!.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("chat_message_invalid");
        receipt.Evidence.Should().Contain($"maximum_length={ExecutionManager.ChatMessageMaximumLength}");
        sink.Sends.Should().BeEmpty();
    }

    [Fact]
    public void Refusal_TextLongerThanOneNativeChatLine_IsChatMessageInvalid()
    {
        var sink = new RecordingMultiplayer();
        LocalExecutionReceipt? tooLong = null;
        LocalExecutionReceipt? atTheLimit = null;

        InMultiplayerSession(CompanionServerMode, sink, () =>
        {
            tooLong = Manager().RequestLocalSendMultiplayerChat(
                "req_chat_long_1", new string('x', ExecutionManager.ChatMessageMaximumLength + 1), FutureDeadline());
            // The exact limit is a different manager so the limiter is not what refuses it: the
            // bound must be a bound, not an off-by-one.
            atTheLimit = Manager().RequestLocalSendMultiplayerChat(
                "req_chat_limit_1", new string('x', ExecutionManager.ChatMessageMaximumLength), FutureDeadline());
        });

        tooLong!.State.Should().Be(ExecutionState.Rejected);
        tooLong.ReasonCode.Should().Be("chat_message_invalid");
        atTheLimit!.State.Should().Be(ExecutionState.Succeeded);
        sink.Sends.Should().ContainSingle("only the line at the limit may reach the game");
    }

    [Fact]
    public void Refusal_SecondSendInsideTheMinimumInterval_IsChatRateLimited()
    {
        var sink = new RecordingMultiplayer();
        LocalExecutionReceipt? limited = null;

        InMultiplayerSession(CompanionServerMode, sink, () =>
        {
            ExecutionManager manager = Manager();
            long deadlineMs = FutureDeadline();
            manager.RequestLocalSendMultiplayerChat("req_chat_rate_1", "first", deadlineMs).State
                .Should().Be(ExecutionState.Succeeded);
            limited = manager.RequestLocalSendMultiplayerChat("req_chat_rate_2", "second", deadlineMs);
        });

        limited!.State.Should().Be(ExecutionState.Rejected);
        limited.ReasonCode.Should().Be("chat_rate_limited");
        sink.Sends.Should().ContainSingle("a refusal must never reach the game");

        // The refusal carries the wait, so an Agent can act on it instead of retrying blind.
        Match match = Regex.Match(limited.Evidence ?? string.Empty, "^retry_after_ms=(\\d+);minimum_interval_ms=(\\d+)$");
        match.Success.Should().BeTrue($"the rate-limit refusal must carry its wait: {limited.Evidence}");
        long.Parse(match.Groups[1].Value).Should().BeInRange(1, ExecutionManager.ChatMessageMinimumIntervalMs);
        long.Parse(match.Groups[2].Value).Should().Be(ExecutionManager.ChatMessageMinimumIntervalMs);
    }

    [Fact]
    public void Refusal_NativeCallThrew_IsUncertainAndNeverClaimsSent()
    {
        var sink = new ThrowingMultiplayer();
        LocalExecutionReceipt? receipt = null;

        InMultiplayerSession(CompanionServerMode, sink, () =>
            receipt = Manager().RequestLocalSendMultiplayerChat("req_chat_throw_1", "boom", FutureDeadline()));

        receipt!.State.Should().Be(ExecutionState.Uncertain);
        receipt.ReasonCode.Should().Be("chat_message_native_exception");
        receipt.Evidence.Should().NotContain("sent=true", "nobody can claim the line was sent once the native call threw");
    }

    // -----------------------------------------------------------------------------------------
    // The source contract: the game's egress is called, nothing of it is reproduced, and no
    // world state is touched
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Handler_SendsThroughTheGamesOwnEgress_AndReproducesNeitherBranch()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);

        foreach (string reasonCode in ReasonCodes)
            code.Should().Contain($"\"{reasonCode}\"", $"the action must be able to report {reasonCode}");

        // The seam is the game's own method, addressed to the whole lobby, in the language the
        // client is actually running.
        code.Should().Contain("sendChatMessage(LocalizedContentManager.CurrentLanguageCode, text, Multiplayer.AllPlayers)");
        // ... resolved through the exact static field identity, never an arbitrary member.
        code.Should().Contain("IsExactMultiplayerField(");
        code.Should().Contain("Game1.IsClient");
        code.Should().Contain("Game1.IsServer");

        // NEGATIVE: neither half of the game's branch may be reproduced, and the receipt may not be
        // read off the local chat box (null on a client, Multiplayer.cs:1153).
        code.Should().NotContain("Game1.client");
        code.Should().NotContain("Game1.server");
        code.Should().NotContain("sendMessage(10");
        code.Should().NotContain("receiveChatMessage");
        code.Should().NotContain("FilterDirtyWords");
        code.Should().NotContain("Game1.chatBox");
        code.Should().NotContain("showGlobalMessage");

        // NEGATIVE: no world side effect of any kind - no movement, no menu, no inventory, no friendship.
        foreach (string forbidden in new[]
                 {
                     "faceDirection", "doEmote", "warpFarmer", "addItemToInventory", "friendshipData",
                     "activeClickableMenu", "CanMove", "Halt(", "Game1.currentLocation", "Objects.Add",
                 })
            code.Should().NotContain(forbidden, $"sending a chat line must not touch {forbidden}");

        // The rate limit is Mod-owned state armed by the attempt, not wall-clock rounding.
        source.Should().Contain("private long lastChatSendUnixMs");
        code.Should().Contain("this.lastChatSendUnixMs = nowMs");
        code.Should().Contain("ChatMessageMinimumIntervalMs");
        code.Should().Contain("retry_after_ms=");

        // The one terminal that proves anything is the one after the native call returned.
        code.Should().Contain("sent=true");
        code.Should().Contain("recipient=all_players");
        code.Should().Contain("AdmissionActionabilityProfile.General");

        // The order inside the request body: the limiter is consulted BEFORE the game's egress,
        // and the interval is armed by the attempt - before the call that may throw.
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalSendMultiplayerChat(");
        int rateLimit = body.IndexOf("chat_rate_limited", StringComparison.Ordinal);
        int armInterval = body.IndexOf("this.lastChatSendUnixMs = nowMs", StringComparison.Ordinal);
        int nativeSend = body.IndexOf("sendChatMessage(LocalizedContentManager.CurrentLanguageCode", StringComparison.Ordinal);
        nativeSend.Should().BeGreaterThan(rateLimit, "a flood must be refused before it reaches the game");
        armInterval.Should().BeGreaterThan(rateLimit).And.BeLessThan(nativeSend);
    }

    [Theory]
    [InlineData("chat_message_sent")]
    [InlineData("chat_multiplayer_only")]
    [InlineData("chat_message_invalid")]
    [InlineData("chat_rate_limited")]
    [InlineData("chat_egress_unavailable")]
    [InlineData("chat_message_native_exception")]
    public void ReasonCodes_MatchReceiptSchemaPattern(string reasonCode)
    {
        // Mirrors protocol/bridge-v1.schema.json #/$defs/reasonCode.
        Regex.IsMatch(reasonCode, "^[a-z0-9_:-]{1,128}$").Should().BeTrue($"reasonCode '{reasonCode}' must satisfy the bridge schema pattern");
    }

    [Fact]
    public void DriftAnchors_MultiplayerChatSeam_StillMatchesTargetVersion()
    {
        // Target-version drift tripwire. The action's whole contract is the identity of the method it
        // calls and of the recipient constant it passes, so both are pinned in the decompilation.
        AssertLinesContain(Path.Combine(DecompiledRelativeRoot, "StardewValley", "Multiplayer.cs"), new (int Line, string Fragment)[]
        {
            (44, "public static readonly long AllPlayers = 0L;"),
            (1127, "public virtual void sendChatMessage(LocalizedContentManager.LanguageCode language, string message, long recipientID)"),
            (1129, "if (Game1.IsClient)"),
            (1131, "Game1.client.sendMessage(10, recipientID, language, message);"),
            (1139, "if (recipientID == AllPlayers)"),
            (1143, "Game1.server.sendMessage(key, 10, Game1.player, recipientID, language, message);"),
        });

        // The game's own caller: the same language fact and the same recipient constant this action uses.
        AssertLinesContain(Path.Combine(DecompiledRelativeRoot, "StardewValley.Menus", "ChatBox.cs"), new (int Line, string Fragment)[]
        {
            (126, "Game1.multiplayer.sendChatMessage(LocalizedContentManager.CurrentLanguageCode, text_to_send, Multiplayer.AllPlayers);"),
        });

        // Game1.chatBox is null unless the chat UI exists - the reason this action's receipt may not
        // be read off it.
        AssertLinesContain(Path.Combine(DecompiledRelativeRoot, "StardewValley", "Game1.cs"), new (int Line, string Fragment)[]
        {
            (1069, "public static ChatBox chatBox;"),
        });
    }

    // -----------------------------------------------------------------------------------------
    // Harness
    // -----------------------------------------------------------------------------------------

    /// <summary>The engine's own server mode for a LAN host (Game1.IsServer).</summary>
    private const byte CompanionServerMode = CompanionSessionHosting.ServerMultiplayerMode;

    private static long FutureDeadline() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;

    /// <summary>
    /// A manager whose admission can be reached: the world is absent in this process, so the
    /// shared admission's scope-bound actor check is answered by the suite's probe-farmer seam.
    /// </summary>
    private static ExecutionManager Manager()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "send_multiplayer_chat" });
        ExecutionManager executions = new(new DummyMonitor(), () => publication);
        Farmer actor = CreateActor(1001);
        executions.SetTestActorResolver(() => actor);
        return executions;
    }

    /// <summary>
    /// Runs a probe as a multiplayer session: the engine's topology mode, the exact static
    /// <c>Game1.multiplayer</c> field and the live lobby dictionary are the facts this action reads,
    /// and all three are shared statics, so each is restored afterwards.
    /// </summary>
    private static void InMultiplayerSession(byte mode, Multiplayer multiplayer, Action body)
    {
        FieldInfo multiplayerField = typeof(Game1).GetField("multiplayer", BindingFlags.Static | BindingFlags.NonPublic)!;
        FieldInfo otherFarmersField = typeof(Game1).GetField("otherFarmers", BindingFlags.Static | BindingFlags.Public)!;
        byte modeBefore = Game1.multiplayerMode;
        object? multiplayerBefore = multiplayerField.GetValue(null);
        object? otherFarmersBefore = otherFarmersField.GetValue(null);
        bool dialogueUpBefore = Game1.dialogueUp;
        try
        {
            Game1.multiplayerMode = mode;
            multiplayerField.SetValue(null, multiplayer);
            // The base method's server half fans out over this dictionary; a process that never
            // hosted a lobby has none, and the base call would dereference null without it.
            otherFarmersField.SetValue(null, new NetRootDictionary<long, Farmer>());
            Game1.dialogueUp = false;
            RunWithGameState(body);
        }
        finally
        {
            Game1.multiplayerMode = modeBefore;
            multiplayerField.SetValue(null, multiplayerBefore);
            otherFarmersField.SetValue(null, otherFarmersBefore);
            Game1.dialogueUp = dialogueUpBefore;
        }
    }

    /// <summary>
    /// The admission reads Game1 statics (activeClickableMenu / eventUp / timeOfDay); save and
    /// restore them around each probe, matching the ScopeBoundActorAdmissionTests convention.
    /// </summary>
    private static void RunWithGameState(Action action)
    {
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool eventUpBefore = Game1.eventUp;
        int timeOfDayBefore = Game1.timeOfDay;
        try
        {
            menuField.SetValue(null, null);
            Game1.eventUp = false;
            Game1.timeOfDay = 600;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
        }
    }

    /// <summary>
    /// A FormatterServices-created probe farmer, the shared test pattern: SkipNetFields are null
    /// until seeded, so every field the disposition projection reads is replaced with a live
    /// NetField or plain value.
    /// </summary>
    private static Farmer CreateActor(long id)
    {
        Farmer actor = (Farmer)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Farmer));
        typeof(Farmer)
            .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLong(id));
        actor.CanMove = true;
        actor.freezePause = 0;
        typeof(Farmer)
            .GetField("usingTool", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetBool(false));
        typeof(Farmer)
            .GetField("netStamina", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetFloat(270f));
        typeof(Farmer)
            .GetField("toolPower", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetInt(0));
        return actor;
    }

    /// <summary>
    /// The game's own egress, faked at exactly the virtual the Mod calls. <paramref name="invokeBase"/>
    /// runs the real base implementation as well, which in a server-mode probe takes the fan-out
    /// branch over an empty lobby and returns - so the pin is not merely assuming the call landed.
    /// </summary>
    private sealed class RecordingMultiplayer : Multiplayer
    {
        private readonly bool invokeBase;

        public RecordingMultiplayer(bool invokeBase = false) => this.invokeBase = invokeBase;

        public List<(LocalizedContentManager.LanguageCode Language, string Message, long RecipientId)> Sends { get; } = new();

        public override void sendChatMessage(LocalizedContentManager.LanguageCode language, string message, long recipientID)
        {
            this.Sends.Add((language, message, recipientID));
            if (this.invokeBase)
                base.sendChatMessage(language, message, recipientID);
        }
    }

    private sealed class ThrowingMultiplayer : Multiplayer
    {
        public override void sendChatMessage(LocalizedContentManager.LanguageCode language, string message, long recipientID) =>
            throw new InvalidOperationException("chat egress probe");
    }

    // -----------------------------------------------------------------------------------------

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

    private static void AssertLinesContain(string relative, IReadOnlyList<(int Line, string Fragment)> expected)
    {
        string? path = TryFindRepositoryFile(relative);
        path.Should().NotBeNull($"the decompiled reference must exist at {relative}");
        string[] lines = File.ReadAllLines(path!);

        foreach ((int line, string fragment) in expected)
        {
            int index = line - 1;
            if (index >= lines.Length || !lines[index].Contains(fragment, StringComparison.Ordinal))
                Assert.Fail($"decompiled {Path.GetFileName(relative)}:{line} no longer contains '{fragment}' -- the target version drifted; re-derive the multiplayer chat seam before accepting this action.");
        }
    }

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

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

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>Drop <c>//</c>/<c>///</c> comments so negative pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    private static string ReadRepositoryFile(string relative)
    {
        string? path = TryFindRepositoryFile(relative);
        if (path is null)
            throw new FileNotFoundException($"repository path not found: {relative}");
        return File.ReadAllText(path);
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string? TryFindRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        return null;
    }
}
