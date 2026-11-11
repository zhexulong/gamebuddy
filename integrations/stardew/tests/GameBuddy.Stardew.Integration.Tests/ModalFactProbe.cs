using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The harness the modal-fact tests share: the <c>Game1</c> statics saved and restored around one probe, an
/// authenticated <see cref="BridgeSession"/> whose outbound sink records every fact, and menu instances built without
/// running a menu constructor (no menu constructor runs outside the game - the convention this repository's other
/// headless menu fixtures already use).
/// </summary>
internal static class ModalFactProbe
{
    internal const string Token = "modal_token_0123456789abcdef";
    internal const int FakeTick = 7500;
    internal const string SaveId = "save_01";

    internal static T Menu<T>()
        where T : IClickableMenu =>
        (T)FormatterServices.GetUninitializedObject(typeof(T));

    internal static IClickableMenu Menu(Type type) => (IClickableMenu)FormatterServices.GetUninitializedObject(type);

    internal static BridgeSession CreateAuthenticatedSession(out RecordingSink sink)
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });
        var scope = new BridgeScope("stardew", SaveId, "world_01", "player_01", "companion_01");
        var session = new BridgeSession(
            new ExecutionManager(new DummyMonitor(), () => publication),
            new FarmhandActionRouter(),
            scope,
            Token,
            () => publication,
            () => "en-US");
        sink = new RecordingSink();
        session.SetOutboundSink(sink.Capture);
        var hello = new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "hello_modal_01",
            "hello_modal_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(Token));
        session.TryAuthenticate(1, hello, out _, out string reasonCode).Should().BeTrue(reasonCode);
        return session;
    }

    internal static JsonElement PayloadOf(BridgeWorldFact fact)
    {
        fact.PayloadJson.Should().NotBeNull("a world fact without a payload states nothing");
        return JsonDocument.Parse(fact.PayloadJson!).RootElement.Clone();
    }

    /// <summary>Every fact that reached the authenticated bridge, in the order it left.</summary>
    internal sealed class RecordingSink
    {
        private readonly List<string> emitted = new();

        internal int Emissions => this.emitted.Count;

        internal bool Capture(long generation, string json)
        {
            this.emitted.Add(json);
            return true;
        }

        internal BridgeWorldFact FactAt(int index)
        {
            index.Should().BeLessThan(this.emitted.Count, "no world fact reached the outbound sink");
            BridgeProtocol.TryDeserializeWorldFact(this.emitted[index], out BridgeEnvelope<BridgeWorldFact>? envelope, out string reason)
                .Should().BeTrue(reason);
            return envelope!.Payload;
        }
    }

    /// <summary>The <c>Game1</c> statics the observer reads, saved and restored around one probe.</summary>
    internal sealed class GameStateScope : IDisposable
    {
        private readonly FieldInfo menuField;
        private readonly object? menuBefore;
        private readonly int ticksBefore;
        private readonly int timeOfDayBefore;

        internal GameStateScope()
        {
            this.menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
            this.menuBefore = this.menuField.GetValue(null);
            this.ticksBefore = Game1.ticks;
            this.timeOfDayBefore = Game1.timeOfDay;
            Game1.ticks = FakeTick;
            Game1.timeOfDay = 900;
        }

        internal void SetActiveMenu(IClickableMenu? menu) => this.menuField.SetValue(null, menu);

        public void Dispose()
        {
            this.menuField.SetValue(null, this.menuBefore);
            Game1.ticks = this.ticksBefore;
            Game1.timeOfDay = this.timeOfDayBefore;
        }
    }
}
