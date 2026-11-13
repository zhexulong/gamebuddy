using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using HarmonyLib;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

/// <summary>
/// One-shot, game-thread measurement of the engine's own chat entry as a companion input:
/// does <c>Game1.chatBox.activate()</c> really take the keyboard in a single-player world, and does typed
/// text reach <c>ChatBox.chatBox.Text</c> and then the engine's submit seam <c>ChatBox.textBoxEnter(string)</c>?
///
/// <para>
/// The product's only text ingress is a Harmony postfix on that submit seam
/// (<see cref="NativeChatIngressPolicy.IsTextSubmitPostfix"/>), so the whole feature rests on a claim nobody has
/// observed: that a player can get characters into the box at all. Reading the engine's IL says the chat key is
/// handled by <c>Game1.UpdateChatBox</c> once per frame with no multiplayer gate, and that
/// <c>TextBox.Selected = true</c> installs the box as <c>Game1.keyboardDispatcher.Subscriber</c> - but "the code
/// path exists" is not "typed text arrives". This probe types with real OS keystrokes (<c>SendInput</c>) into the
/// focused game window and records what the box contains, so the answer comes from the running game.
/// </para>
/// <para>
/// It is env-gated exactly like <see cref="PathPredicateProbe"/>: a reusable measurement, never a product
/// capability, so it adds no <c>ModConfig</c> field. It writes one bounded JSON evidence file and never mutates the
/// world.
/// </para>
/// </summary>
internal sealed class CompanionChatProbe
{
    private const string Schema = "gamebuddy-companion-chat-probe/v1";
    private const string EnableLiveProbeVariable = "GAMEBUDDY_STARDEW_COMPANION_CHAT_PROBE_LIVE";
    private const string EvidencePathVariable = "GAMEBUDDY_STARDEW_COMPANION_CHAT_PROBE_EVIDENCE";

    /// <summary>Ticks the world gets to settle (menus closing, fade-in) before anything is typed.</summary>
    private const int SettleTicks = 240;

    /// <summary>Ticks to wait for the engine to consume what was typed, per step.</summary>
    private const int SettleAfterInputTicks = 45;

    private readonly IMonitor monitor;
    private readonly string evidencePath;
    private readonly List<Dictionary<string, object?>> stages = new();
    private readonly List<string> submittedTexts = new();
    private int ticks;
    private int waitUntilTick;
    private int step;
    private string stage = string.Empty;
    private string osInput = "none";
    private uint sendInputResult;
    private int sendInputError;
    private bool finished;

    private CompanionChatProbe(IMonitor monitor, string evidencePath)
    {
        this.monitor = monitor;
        this.evidencePath = evidencePath;
    }

    internal static CompanionChatProbe? TryStart(IMonitor monitor)
    {
        if (!string.Equals(Environment.GetEnvironmentVariable(EnableLiveProbeVariable), "1", StringComparison.Ordinal))
            return null;
        string evidencePath = Environment.GetEnvironmentVariable(EvidencePathVariable) ?? string.Empty;
        if (!Path.IsPathFullyQualified(evidencePath))
        {
            monitor.Log(
                $"GameBuddy companion-chat probe refused: {EvidencePathVariable} must be an absolute path.",
                LogLevel.Error);
            return null;
        }
        CompanionChatProbe probe = new(monitor, evidencePath);
        try
        {
            MethodInfo? target = AccessTools.Method(typeof(ChatBox), "textBoxEnter", new[] { typeof(string) });
            MethodInfo? postfix = AccessTools.Method(typeof(CompanionChatProbe), nameof(SubmittedTextPostfix));
            if (target is null || postfix is null)
                throw new MissingMethodException("ChatBox.textBoxEnter(string)");
            new Harmony("GameBuddy.Stardew.companion-chat-probe").Patch(target, postfix: new HarmonyMethod(postfix));
            owner = probe;
        }
        catch (Exception exception)
        {
            monitor.Log(
                $"GameBuddy companion-chat probe refused: submit seam unavailable ({exception.GetType().Name}).",
                LogLevel.Error);
            return null;
        }
        monitor.Log("GameBuddy companion-chat probe started.", LogLevel.Info);
        return probe;
    }

    private static CompanionChatProbe? owner;

    private static void SubmittedTextPostfix(string text_to_send) => owner?.submittedTexts.Add(text_to_send);

    /// <summary>One game tick of the measurement. Returns true once the evidence file has been written.</summary>
    internal bool Update()
    {
        if (this.finished)
            return true;
        this.ticks++;
        if (!Context.IsWorldReady || Game1.player is null || Game1.chatBox is null)
            return false;
        if (this.ticks < SettleTicks || this.ticks < this.waitUntilTick)
            return false;
        try
        {
            switch (this.step)
            {
                case 0:
                    this.RecordBaseline();
                    PressVirtualKey(vkChatKey);
                    this.Start("stage_1_vanilla_chat_key", SettleAfterInputTicks);
                    return false;
                case 1:
                    this.Measure("stage_1_vanilla_chat_key");
                    this.ActivateChatBox();
                    this.Start("stage_2_activate", 5);
                    return false;
                case 2:
                    this.Measure("stage_2_activate");
                    this.TypeText("probe says hi");
                    this.Start("stage_3_os_typed_text", SettleAfterInputTicks);
                    return false;
                case 3:
                    this.Measure("stage_3_os_typed_text");
                    PressVirtualKey(vkReturn);
                    this.Start("stage_4_os_submit", SettleAfterInputTicks);
                    return false;
                case 4:
                    this.Measure("stage_4_os_submit");
                    this.EngineType("seam");
                    this.Start("stage_5_engine_typed_text", 5);
                    return false;
                case 5:
                    this.Measure("stage_5_engine_typed_text");
                    this.EngineSubmit();
                    this.Start("stage_6_engine_submit", SettleAfterInputTicks);
                    return false;
                case 6:
                    this.Measure("stage_6_engine_submit");
                    this.Write();
                    this.finished = true;
                    return true;
                default:
                    return false;
            }
        }
        catch (Exception exception)
        {
            this.monitor.Log($"GameBuddy companion-chat probe failed: {exception.GetType().Name}.", LogLevel.Error);
            this.stages.Add(new() { ["stage"] = "probe_failed", ["exception"] = exception.GetType().FullName });
            this.Write();
            this.finished = true;
            return true;
        }
    }

    private void Start(string stage, int ticks)
    {
        this.stage = stage;
        this.step++;
        this.waitUntilTick = this.ticks + ticks;
    }

    private void RecordBaseline()
    {
        this.stages.Add(new()
        {
            ["stage"] = "stage_0_baseline",
            ["gameVersion"] = Game1.version,
            ["isMultiplayer"] = Game1.IsMultiplayer,
            ["isMasterGame"] = Game1.IsMasterGame,
            ["chatBoxActive"] = Game1.chatBox.isActive(),
            ["keyboardSubscriber"] = SubscriberName(),
            ["hasKeyboardFocus"] = Game1.game1?.HasKeyboardFocus(),
            ["windowIsActive"] = Game1.game1?.IsActive,
            ["chatKeyBindings"] = BindingNames(Game1.options.chatButton),
            ["optionsPresent"] = Game1.options is not null,
            ["windowHandle"] = (Game1.game1?.Window?.Handle ?? IntPtr.Zero).ToString(),
            ["foregroundWindowHandle"] = GetForegroundWindow().ToString(),
            ["setForegroundWindowResult"] = SetForegroundWindow(Game1.game1?.Window?.Handle ?? IntPtr.Zero),
            ["userInteractive"] = Environment.UserInteractive,
        });
    }

    private void Measure(string stage)
    {
        ChatBox chat = Game1.chatBox;
        this.stages.Add(new()
        {
            ["stage"] = stage,
            ["chatBoxActive"] = chat.isActive(),
            ["keyboardSubscriber"] = SubscriberName(),
            ["text"] = chat.chatBox.Text,
            ["titleText"] = chat.chatBox.TitleText,
            ["hasKeyboardFocus"] = Game1.game1?.HasKeyboardFocus(),
            ["submittedTexts"] = this.submittedTexts.ToArray(),
            ["osInput"] = this.osInput,
            ["sendInputResult"] = this.sendInputResult,
            ["sendInputError"] = this.sendInputError,
        });
    }

    private void ActivateChatBox()
    {
        if (Game1.chatBox?.chatBox is null)
            return;
        Game1.chatBox.activate();
    }

    private void EngineType(string text)
    {
        if (Game1.keyboardDispatcher?.Subscriber is not { } subscriber)
        {
            this.osInput = "engine_seam_no_subscriber";
            return;
        }
        foreach (char character in text)
            subscriber.RecieveTextInput(character);
        this.osInput = "engine_seam_sent";
    }

    private void EngineSubmit()
    {
        if (Game1.keyboardDispatcher?.Subscriber is not { } subscriber)
        {
            this.osInput = "engine_seam_no_subscriber";
            return;
        }
        subscriber.RecieveCommandInput('\r');
        this.osInput = "engine_seam_submitted";
    }

    private void TypeText(string text)
    {
        if (!this.TryFocus())
            return;
        TypeUnicode(text);
    }

    /// <summary>
    /// OS keystrokes go to whatever window has focus, so they are only ever sent while the game itself reports being
    /// the active window. Anything else would be typing into a stranger's application, and a skipped keystroke is an
    /// honest measurement where a borrowed one would be a wrong one.
    /// </summary>
    private bool TryFocus()
    {
        IntPtr handle = Game1.game1?.Window?.Handle ?? IntPtr.Zero;
        if (handle != IntPtr.Zero)
            SetForegroundWindow(handle);
        this.osInput = Game1.game1?.IsActive == true ? "sent" : "skipped_window_not_active";
        return this.osInput == "sent";
    }

    private void Write()
    {
        Dictionary<string, object?> evidence = new()
        {
            ["schema"] = Schema,
            ["state"] = "completed",
            ["reasonCode"] = "measured",
            ["stages"] = this.stages.ToArray(),
        };
        File.WriteAllText(this.evidencePath, JsonSerializer.Serialize(evidence, IndentedJson));
        this.monitor.Log($"GameBuddy companion-chat probe wrote {this.evidencePath}.", LogLevel.Info);
    }

    private static string? SubscriberName() => Game1.keyboardDispatcher?.Subscriber?.GetType().FullName;

    private static string[] BindingNames(StardewValley.InputButton[]? buttons)
    {
        if (buttons is null)
            return Array.Empty<string>();
        string[] names = new string[buttons.Length];
        for (int index = 0; index < buttons.Length; index++)
            names[index] = buttons[index].ToString() ?? string.Empty;
        return names;
    }

    // ── OS keyboard input ────────────────────────────────────────────────────────────────

    private const ushort vkChatKey = 0x54;
    private const ushort vkReturn = 0x0D;
    private const uint inputKeyboard = 1;
    private const uint keyeventfKeyUp = 0x0002;
    private const uint keyeventfUnicode = 0x0004;

    private static readonly JsonSerializerOptions IndentedJson = new() { WriteIndented = true };

    private void EnsureForeground()
    {
        IntPtr handle = Game1.game1?.Window?.Handle ?? IntPtr.Zero;
        if (handle != IntPtr.Zero)
            SetForegroundWindow(handle);
    }

    private static void TypeUnicode(string text)
    {
        foreach (char character in text)
        {
            SendKey(new KEYBDINPUT { wScan = character, dwFlags = keyeventfUnicode });
            SendKey(new KEYBDINPUT { wScan = character, dwFlags = keyeventfUnicode | keyeventfKeyUp });
        }
    }

    private static void PressVirtualKey(ushort virtualKey)
    {
        SendKey(new KEYBDINPUT { wVk = virtualKey });
        SendKey(new KEYBDINPUT { wVk = virtualKey, dwFlags = keyeventfKeyUp });
    }

    private static void SendKey(KEYBDINPUT keyboard)
    {
        INPUT input = new() { type = inputKeyboard, U = new InputUnion { ki = keyboard } };
        Instance.sendInputResult = SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>());
        Instance.sendInputError = Marshal.GetLastWin32Error();
    }

    /// <summary>The running probe, so the static injection helpers can record what the OS answered.</summary>
    private static CompanionChatProbe Instance => owner ?? throw new InvalidOperationException("probe owner missing");

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint numberOfInputs, INPUT[] inputs, int sizeOfInputStructure);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }
}
