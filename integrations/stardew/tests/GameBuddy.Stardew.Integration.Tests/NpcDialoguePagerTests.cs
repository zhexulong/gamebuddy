using System.Reflection;
using System.Runtime.Serialization;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Sensory;
using Netcode;
using StardewValley;
using StardewValley.Menus;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The W6 (i) dialogue stream: the Mod drives the game's OWN DialogueBox pager
/// to exhaustion, hard-stops on a question, and reports the whole dialogue once
/// as a typed <c>npc_dialogue_presented</c> world fact.
///
/// The behaviour tests drive <see cref="NpcDialoguePager"/> against a
/// <see cref="DialogueBox"/> whose page advance is scripted (see
/// <see cref="ScriptedDialogueBox"/>): the real advance ends in
/// <c>DialogueBox.closeDialogue()</c>, which reads <c>Game1.player</c> and
/// loaded content a headless xunit process does not have. The native contract
/// the production code relies on is pinned line by line by
/// <see cref="DriftAnchors_NativeDialogueBoxExposesThePagerSeam"/>, and the
/// production source is pinned by
/// <see cref="Source_NpcDialoguePager_MutatesOnlyThroughTheNativeClick"/>; real
/// live cover for the advance belongs to the Lane D4 live gate.
/// </summary>
public sealed class NpcDialoguePagerTests
{
    private const string Token = "pager_token_0123456789abcdef";
    private const int FakeTick = 4242;
    private const string DecompiledDialogueBoxRelativePath =
        "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Menus/DialogueBox.cs";
    private const string ImplementationRelativePath = "integrations/stardew/Sensory/NpcDialoguePager.cs";

    // ---- the advance predicate -------------------------------------------------

    [Fact]
    public void CanAdvance_RefusesAQuestionPage()
    {
        DialogueBox question = CreateDialogueBox("Do you like it here?");
        question.isQuestion = true;
        question.responses = new[] { new Response("Yes", "Yes") };

        NpcDialoguePager.CanAdvance(question).Should().BeFalse(
            "the native click path on a question ANSWERS it from selectedResponse (DialogueBox.cs:371-404); it never flips the page");
    }

    [Fact]
    public void CanAdvance_WaitsForTheTypingIndexAndTheBoxesOwnSafetyWindow()
    {
        DialogueBox box = CreateDialogueBox("Fully typed page.");

        NpcDialoguePager.CanAdvance(box).Should().BeTrue();

        box.characterIndexInDialogue = 3;
        NpcDialoguePager.CanAdvance(box).Should().BeFalse(
            "a click while the text is still typing only settles typing (DialogueBox.cs:361-364)");

        box.characterIndexInDialogue = 1000;
        box.safetyTimer = 750;
        NpcDialoguePager.CanAdvance(box).Should().BeFalse(
            "a click inside the box's own post-page safety window is discarded (DialogueBox.cs:367-370)");

        box.safetyTimer = 0;
        box.transitioning = true;
        NpcDialoguePager.CanAdvance(box).Should().BeFalse(
            "a click during a transition is discarded (DialogueBox.cs:357-360)");
    }

    [Fact]
    public void IsOutro_MatchesOnlyTheReverseTransition()
    {
        DialogueBox box = CreateDialogueBox("Page.");

        box.transitioning = true;
        box.transitioningBigger = true;
        NpcDialoguePager.IsOutro(box).Should().BeFalse("this is the opening transition of a fresh box");

        box.transitioningBigger = false;
        NpcDialoguePager.IsOutro(box).Should().BeTrue("only beginOutro writes this pair (DialogueBox.cs:256-261)");

        box.transitioning = false;
        NpcDialoguePager.IsOutro(box).Should().BeFalse();
    }

    [Fact]
    public void SpeakerOf_UsesTheCharactersStableNameOrTheNarratorLabel()
    {
        DialogueBox unattributed = CreateDialogueBox("An object speaks.");
        NpcDialoguePager.SpeakerOf(unattributed).Should().Be(NpcDialoguePager.NarratorSpeaker,
            "an object dialogue or a plain string box carries no character");

        DialogueBox attributed = CreateDialogueBox("Abigail speaks.");
        attributed.characterDialogue = CreateDialogueWithSpeaker("Abigail");
        NpcDialoguePager.SpeakerOf(attributed).Should().Be("Abigail");
    }

    // ---- the paging loop -------------------------------------------------------

    [Fact]
    public void Observe_OnAQuestionBox_ReportsOnceAndNeverClicksTheQuestion()
    {
        using var game = new GameStateScope();
        ScriptedDialogueBox box = CreateScriptedDialogueBox("Do you like it here?");
        box.isQuestion = true;
        box.responses = new[] { new Response("Yes", "Yes, it's lovely"), new Response("No", "Not really") };
        game.SetActiveMenu(box);
        BridgeSession session = CreateSession();
        var sink = new OutboundSink();
        session.SetOutboundSink(sink.Capture);
        Authenticate(session);
        var pager = new NpcDialoguePager(new DummyMonitor());

        for (int tick = 0; tick < 3; tick++)
            pager.Observe(session);

        box.Clicks.Should().Be(0,
            "the Agent answers questions through answer_dialogue; a Mod click would pick an answer nobody chose");
        sink.Emissions.Should().Be(1, "one dialogue is one fact");

        BridgeWorldFact fact = FactOf(sink);
        fact.Kind.Should().Be(NpcDialoguePresentedPayload.Kind);
        // The key carries the tick the dialogue appeared PLUS a Mod-owned sequence. It is asserted by its
        // PROPERTY rather than by value (the sequence is a global counter, so a literal would be fragile), and
        // the property is what matters: the tick alone could collide, because the increment is skipped while
        // the game loads incrementally (Game1.cs:3911-3914).
        fact.EventId.Should().Be(fact.DeduplicationKey);
        fact.EventId.Should().Be(fact.SourceEventId);
        fact.EventId.Should().StartWith($"npc_dialogue_{FakeTick}_", "the tick is still part of the identity");
        JsonElement payload = ParsePayload(fact);
        payload.GetProperty("speaker").GetString().Should().Be(NpcDialoguePager.NarratorSpeaker);
        payload.GetProperty("isQuestion").GetBoolean().Should().BeTrue();
        payload.GetProperty("pages").EnumerateArray().Select(page => page.GetString())
            .Should().Equal("Do you like it here?");
        JsonElement[] choices = payload.GetProperty("choices").EnumerateArray().ToArray();
        choices.Select(choice => choice.GetProperty("key").GetString()).Should().Equal("Yes", "No");
        choices.Select(choice => choice.GetProperty("text").GetString()).Should().Equal("Yes, it's lovely", "Not really");
    }

    [Fact]
    public void Observe_OnAnInformationalBox_ReportsEveryPresentedPageInOrder()
    {
        using var game = new GameStateScope();
        ScriptedDialogueBox box = CreateScriptedDialogueBox("First page.", "Second page.");
        game.SetActiveMenu(box);
        BridgeSession session = CreateSession();
        var sink = new OutboundSink();
        session.SetOutboundSink(sink.Capture);
        Authenticate(session);
        var pager = new NpcDialoguePager(new DummyMonitor());

        pager.Observe(session);
        box.Clicks.Should().Be(1, "the first readable page is advanced through the native click entry");
        box.safetyTimer.Should().Be(750, "the native advance re-arms the safety window from DialogueBox.safetyDelay");

        pager.Observe(session);
        box.Clicks.Should().Be(1, "the safety window is open, so the next page is not clicked yet");
        sink.Emissions.Should().Be(0, "the dialogue is still on screen");

        box.safetyTimer = 0;
        pager.Observe(session);
        box.Clicks.Should().Be(2);

        pager.Observe(session);
        sink.Emissions.Should().Be(1);
        JsonElement payload = ParsePayload(FactOf(sink));
        payload.GetProperty("speaker").GetString().Should().Be(NpcDialoguePager.NarratorSpeaker);
        payload.GetProperty("isQuestion").GetBoolean().Should().BeFalse();
        payload.GetProperty("pages").EnumerateArray().Select(page => page.GetString())
            .Should().Equal("First page.", "Second page.");
        payload.GetProperty("choices").GetArrayLength().Should().Be(0);

        pager.Observe(session);
        sink.Emissions.Should().Be(1, "the same dialogue never reports twice");
    }

    [Fact]
    public void Observe_WhenTheBoxDisappearsMidRun_ReportsOnlyWhatItPresented()
    {
        using var game = new GameStateScope();
        ScriptedDialogueBox box = CreateScriptedDialogueBox("One.", "Two.", "Three.");
        game.SetActiveMenu(box);
        BridgeSession session = CreateSession();
        var sink = new OutboundSink();
        session.SetOutboundSink(sink.Capture);
        Authenticate(session);
        var pager = new NpcDialoguePager(new DummyMonitor());

        pager.Observe(session);
        pager.Observe(session);
        sink.Emissions.Should().Be(0);

        game.SetActiveMenu(null);
        pager.Observe(session);

        sink.Emissions.Should().Be(1, "a box that disappears mid-run is not an error");
        JsonElement payload = ParsePayload(FactOf(sink));
        payload.GetProperty("pages").EnumerateArray().Select(page => page.GetString())
            .Should().Equal(new[] { "One.", "Two." }, "the third page was never displayed, so it was never reported");
    }

    [Fact]
    public void Observe_WithoutAPublishableSession_LeavesTheDialogueToThePlayer()
    {
        using var game = new GameStateScope();
        ScriptedDialogueBox box = CreateScriptedDialogueBox("Hello there.");
        game.SetActiveMenu(box);
        var pager = new NpcDialoguePager(new DummyMonitor());

        pager.Observe(null);
        box.Clicks.Should().Be(0, "with no bridge at all the box belongs to the player");
        box.dialogues.Should().Equal("Hello there.");

        BridgeSession unauthenticated = CreateSession();
        unauthenticated.SetOutboundSink((_, _) => true);
        pager.Observe(unauthenticated);
        box.Clicks.Should().Be(0, "a session that cannot publish the fact must not run the native side effects");
        box.dialogues.Should().Equal("Hello there.");
    }

    [Fact]
    public void CanPublishWorldFact_RequiresAnAuthenticatedOutboundPath()
    {
        BridgeSession session = CreateSession();
        session.CanPublishWorldFact.Should().BeFalse("no transport and no authentication yet");

        session.SetOutboundSink((_, _) => true);
        session.CanPublishWorldFact.Should().BeFalse("an unauthenticated session cannot publish");

        Authenticate(session);
        session.CanPublishWorldFact.Should().BeTrue();

        session.SetOutboundSink(null);
        session.CanPublishWorldFact.Should().BeFalse();
    }

    // ---- drift anchors ---------------------------------------------------------

    [Fact]
    public void DriftAnchors_NativeDialogueBoxExposesThePagerSeam()
    {
        string? path = TryFindRepoFile(DecompiledDialogueBoxRelativePath);
        path.Should().NotBeNull($"decompiled DialogueBox.cs must exist at {DecompiledDialogueBoxRelativePath}");
        string[] lines = File.ReadAllLines(path!);

        // The public page state the pager reads.
        lines[12 - 1].Should().Contain("public List<string> dialogues");
        lines[14 - 1].Should().Contain("public Dialogue characterDialogue;");
        lines[16 - 1].Should().Contain("public Stack<string> characterDialoguesBrokenUp");
        lines[18 - 1].Should().Contain("public Response[] responses");
        lines[32 - 1].Should().Contain("public const int characterAdvanceDelay = 30;");
        lines[34 - 1].Should().Contain("public const int safetyDelay = 750;");
        lines[58 - 1].Should().Contain("public int characterIndexInDialogue;");
        lines[60 - 1].Should().Contain("public int safetyTimer = 750;");
        lines[73 - 1].Should().Contain("public bool transitioning = true;");
        lines[75 - 1].Should().Contain("public bool transitioningBigger = true;");
        lines[81 - 1].Should().Contain("public bool isQuestion;");
        lines[712 - 1].Should().Contain("public string getCurrentString()");

        // The public click entry the pager advances with, and the three rules
        // inside it that make the pacer's predicates the native ones.
        lines[355 - 1].Should().Contain("public override void receiveLeftClick(int x, int y, bool playSound = true)");
        lines[361 - 1].Should().Contain("if (characterIndexInDialogue < getCurrentString().Length - 1)");
        lines[363 - 1].Should().Contain("characterIndexInDialogue = getCurrentString().Length - 1;");
        lines[367 - 1].Should().Contain("if (safetyTimer > 0)");
        lines[371 - 1].Should().Contain("if (isQuestion)");
        lines[392 - 1].Should().Contain("if (Game1.currentLocation.answerDialogue(responses[selectedResponse]))");
        lines[462 - 1].Should().Contain("safetyTimer = ((!Game1.IsDedicatedHost) ? 750 : 0);");
        lines[771 - 1].Should().Contain("if (safetyTimer > 0)");
        lines[773 - 1].Should().Contain("safetyTimer -= time.ElapsedGameTime.Milliseconds;");

        // The reverse transition is the native end-of-dialogue signal.
        lines[256 - 1].Should().Contain("public void beginOutro()");
        lines[258 - 1].Should().Contain("transitioning = true;");
        lines[259 - 1].Should().Contain("transitioningBigger = false;");

        // ...and closeDialogue stays the audited close, which the pager must not
        // use: clearing a dialogue belongs to the action path (Lane D2).
        lines[192 - 1].Should().Contain("public void closeDialogue()");
    }

    [Fact]
    public void Source_NpcDialoguePager_MutatesOnlyThroughTheNativeClick()
    {
        string? path = TryFindRepoFile(ImplementationRelativePath);
        path.Should().NotBeNull();
        string text = File.ReadAllText(path!);

        // The single permitted world mutation.
        text.Should().Contain("tracked.receiveLeftClick(0, 0);");
        // The hard stop: a question can never satisfy the advance predicate.
        text.Should().Contain("internal static bool CanAdvance(DialogueBox box) =>");
        text.Should().Contain("!box.isQuestion");
        // The fact leaves through the existing typed world-fact seam.
        text.Should().Contain("session.TryCreateWorldFactEvent(fact)");
        text.Should().Contain("NpcDialoguePresentedPayload.Kind");
        // It writes no field of the box and does not close it by a second
        // mechanism; it only reads the public natives above.
        text.Should().NotContain("characterIndexInDialogue =");
        text.Should().NotContain("safetyTimer =");
        text.Should().NotContain("dialogues =");
        text.Should().NotContain("closeDialogue()");
        text.Should().NotContain("dialogueFinished =");
        text.Should().NotContain("Game1.activeClickableMenu =");
    }

    // ---- fixtures --------------------------------------------------------------

    private static DialogueBox CreateDialogueBox(params string[] pages)
    {
        DialogueBox box = (DialogueBox)FormatterServices.GetUninitializedObject(typeof(DialogueBox));
        box.dialogues = new List<string>(pages);
        box.responses = Array.Empty<Response>();
        box.characterDialoguesBrokenUp = new Stack<string>();
        box.transitioning = false;
        box.transitioningBigger = true;
        box.safetyTimer = 0;
        box.characterIndexInDialogue = 1000;
        return box;
    }

    private static ScriptedDialogueBox CreateScriptedDialogueBox(params string[] pages)
    {
        ScriptedDialogueBox box = (ScriptedDialogueBox)FormatterServices.GetUninitializedObject(typeof(ScriptedDialogueBox));
        box.dialogues = new List<string>(pages);
        box.responses = Array.Empty<Response>();
        box.characterDialoguesBrokenUp = new Stack<string>();
        box.transitioning = false;
        box.transitioningBigger = true;
        box.safetyTimer = 0;
        box.characterIndexInDialogue = 1000;
        return box;
    }

    private static Dialogue CreateDialogueWithSpeaker(string name)
    {
        var speaker = (NPC)FormatterServices.GetUninitializedObject(typeof(NPC));
        typeof(Character).GetField("name", BindingFlags.Public | BindingFlags.Instance)!
            .SetValue(speaker, new NetString(name));
        var dialogue = (Dialogue)FormatterServices.GetUninitializedObject(typeof(Dialogue));
        dialogue.speaker = speaker;
        return dialogue;
    }

    private static BridgeSession CreateSession()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });
        return new BridgeSession(
            new ExecutionManager(new DummyMonitor(), () => publication),
            new FarmhandActionRouter(),
            new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01"),
            Token,
            () => publication,
            () => "en-US");
    }

    private static void Authenticate(BridgeSession session)
    {
        var hello = new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "hello_pager_01",
            "hello_pager_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01"),
            "hello",
            new BridgeHello(Token));

        session.TryAuthenticate(1, hello, out _, out string reasonCode).Should().BeTrue(reasonCode);
    }

    private static BridgeWorldFact FactOf(OutboundSink sink)
    {
        sink.Json.Should().NotBeNull("no world fact reached the outbound sink");
        BridgeProtocol.TryDeserializeWorldFact(sink.Json!, out BridgeEnvelope<BridgeWorldFact>? envelope, out string reason)
            .Should().BeTrue(reason);
        return envelope!.Payload;
    }

    private static JsonElement ParsePayload(BridgeWorldFact fact)
    {
        fact.PayloadJson.Should().NotBeNull();
        return JsonDocument.Parse(fact.PayloadJson!).RootElement.Clone();
    }

    private static string? TryFindRepoFile(string relativePath)
    {
        string[] starts = { AppContext.BaseDirectory, Environment.CurrentDirectory };
        foreach (string start in starts)
        {
            DirectoryInfo? dir = new(start);
            for (int depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relativePath);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        return null;
    }

    private sealed class OutboundSink
    {
        public string? Json { get; private set; }

        public int Emissions { get; private set; }

        public bool Capture(long generation, string json)
        {
            this.Emissions++;
            this.Json = json;
            return true;
        }
    }

    /// <summary>
    /// A DialogueBox whose page advance is scripted instead of native.
    ///
    /// The real advance (DialogueBox.cs:355-468) runs the box to
    /// <c>closeDialogue()</c>, which writes <c>Game1.player</c> and reads loaded
    /// content; a headless xunit process has neither. The script keeps the
    /// pacer's real state machine - page capture, the box's own safety timer,
    /// the question hard stop - against a box whose pages the test controls,
    /// while the native contract stays pinned by the drift anchors.
    /// </summary>
    private sealed class ScriptedDialogueBox : DialogueBox
    {
        // Never executed: instances come from GetUninitializedObject so the real
        // DialogueBox ctor (which reads Game1.options) does not run headless. The
        // constructor exists only to satisfy the base type's own constructors.
        private ScriptedDialogueBox()
            : base(0, 0, 100, 100)
        {
        }

        public int Clicks { get; private set; }

        public override void receiveLeftClick(int x, int y, bool playSound = true)
        {
            this.Clicks++;
            if (this.isQuestion)
            {
                // Native: a question click answers from selectedResponse; it never flips a page.
                return;
            }

            this.dialogues.RemoveAt(0);
            this.characterIndexInDialogue = 1000;
            this.safetyTimer = 750;
            if (this.dialogues.Count == 0)
            {
                this.transitioning = true;
                this.transitioningBigger = false;
            }
        }
    }

    /// <summary>
    /// The Game1 statics the pager reads, saved and restored around one probe -
    /// the convention the repo's other headless menu fixtures use.
    /// </summary>
    private sealed class GameStateScope : IDisposable
    {
        private readonly FieldInfo menuField;
        private readonly object? menuBefore;
        private readonly int ticksBefore;
        private readonly int timeOfDayBefore;

        public GameStateScope()
        {
            this.menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
            this.menuBefore = this.menuField.GetValue(null);
            this.ticksBefore = Game1.ticks;
            this.timeOfDayBefore = Game1.timeOfDay;
            Game1.ticks = FakeTick;
            Game1.timeOfDay = 900;
        }

        public void SetActiveMenu(IClickableMenu? menu) => this.menuField.SetValue(null, menu);

        public void Dispose()
        {
            this.menuField.SetValue(null, this.menuBefore);
            Game1.ticks = this.ticksBefore;
            Game1.timeOfDay = this.timeOfDayBefore;
        }
    }
}
