using System.Text.Json;

namespace GameBuddy.Stardew.Core.Protocol;

/// <summary>
/// The ORDER the wire's members are written in - one rule, applied to every frame before it is framed.
///
/// <para>
/// `System.Text.Json` writes a payload's members in the order the runtime hands its properties back, and no part of the
/// contract pins that order: it belongs to the compiled assembly, not to the statement. Two frames carrying one world
/// therefore differed only in layout - measured 2026-11-11 by the snapshot loopback gate, which rejected twelve thousand
/// bytes that held the same values in two arrangements (`targetId` from the front of its row to the back). That is not
/// only a test's problem: the Host derives a fact's identity from this payload (`factContentIdentity`,
/// `host/src/event-pump.ts`), so a re-laid-out re-statement reads as news and opens a turn to repeat what she already had.
/// </para>
/// <para>
/// Members are therefore ordered by ORDINAL NAME at every depth. An ARRAY keeps its own order: a list of rows is a
/// sequence the projection chose, and reordering it would be a different statement rather than the same one written
/// differently.
/// </para>
/// <para>
/// THE BOUNDARY, stated because a frame cannot show it: <see cref="Canonical"/> orders the members of the JSON it is
/// given, and a world fact carries its subject as opaque JSON TEXT (<c>BridgeWorldFact.PayloadJson</c>) - a string is
/// a value, not members, so what is inside it keeps the layout its producer wrote. Two producers write their own
/// (<c>NpcDialoguePager.Report</c>, and <c>ModalTransitionObserver.PublishPresented</c> / <c>PublishDismissed</c>),
/// and they are allowed to because nothing keys on those bytes: the Host parses the text and works from the object
/// (<c>stardew-integration-launcher-body-program.internal.ts</c>, its <c>payloadJson</c> branch), the pending window is
/// keyed on the Mod-minted <c>eventId</c> (<c>worldFactKey</c>), and the identity the Host compares is computed from the
/// PARSED object under this same ordinal-name rule at every depth (<c>factContentIdentity</c>,
/// <c>host/src/event-pump.ts</c>). The third producer of such text, <c>StardewSalientEventHooks</c>, hand-writes one- and
/// two-member literals, so its order is the literal's and is already this one. The Mod's half of the claim is pinned by
/// <c>EmbeddedWorldFactPayload</c> and the two producers' tests; the day something does key on those bytes, that
/// producer wraps its payload in <see cref="Canonical"/> as well and this paragraph goes away.
/// </para>
/// </summary>
internal static class WireJson
{
    /// <summary>One frame's bytes, with every object's members in ordinal name order.</summary>
    internal static string Canonical(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        var buffer = new System.Buffers.ArrayBufferWriter<byte>(System.Text.Encoding.UTF8.GetByteCount(json));
        using (var writer = new Utf8JsonWriter(buffer))
        {
            WriteCanonicalMembers(document.RootElement, writer);
        }

        return System.Text.Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void WriteCanonicalMembers(JsonElement element, Utf8JsonWriter writer)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (JsonProperty property in element.EnumerateObject().OrderBy(member => member.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonicalMembers(property.Value, writer);
                }

                writer.WriteEndObject();
                return;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (JsonElement item in element.EnumerateArray()) WriteCanonicalMembers(item, writer);
                writer.WriteEndArray();
                return;
            default:
                element.WriteTo(writer);
                return;
        }
    }
}
