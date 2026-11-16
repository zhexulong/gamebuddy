using System.Buffers;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE MEMBER ORDER OF A PAYLOAD A WORLD FACT CARRIES AS TEXT - what it decides, and what it must not be able to.
///
/// <para>
/// `WireJson.Canonical` decides the order of every frame's members and cannot reach inside this text: a world fact
/// carries its subject as an opaque JSON STRING (<see cref="BridgeWorldFact.PayloadJson"/>), and a string is a value,
/// not members. So <c>NpcDialoguePager.Report</c> and <c>ModalTransitionObserver</c> write the order their own records
/// declare. That is allowed, and this file is what keeps it from being an exception nobody noticed.
/// </para>
/// <para>
/// WHY IT IS ALLOWED. Nothing keys on those bytes. The Host parses the text and works from the object
/// (`JSON.parse(message.payload.payloadJson)`, `host/src/stardew-integration-launcher-body-program.internal.ts`); the
/// pending window is keyed on the Mod-minted `eventId` (`worldFactKey`); and the identity the Host compares is computed
/// from the PARSED object under the same ordinal-name rule at every depth (`factContentIdentity`,
/// `host/src/event-pump.ts`). The day something does key on the text, its producer wraps it in `WireJson.Canonical` and
/// the reason below is gone with it.
/// </para>
/// <para>
/// WHAT IS PROVED HERE, which is the Mod's half only: the text crosses the egress exactly as its producer wrote it, one
/// statement written in two layouts reads as one statement for the Mod's reader, and the two layouts collapse to one
/// string under the ordering rule. The Host's half - that it parses rather than compares - is stated by the readers
/// named above; nothing here can run them.
/// </para>
/// </summary>
internal static class EmbeddedWorldFactPayload
{
    /// <summary>
    /// One fact a producer really emitted, with the three things its embedded layout must be true of.
    ///
    /// <para>
    /// The fact under test came back out of a real frame, so re-serialising it below is the egress applied a second
    /// time rather than a projection this file invented - a test that builds its own second projection can agree with
    /// itself while the wire disagrees with both.
    /// </para>
    /// </summary>
    internal static void AssertLayoutIsNotTheStatement<T>(BridgeWorldFact fact)
        where T : class
    {
        string carried = Carried(fact);
        string rearranged = Rearranged(carried);
        rearranged.Should().NotBe(
            carried,
            "the perturbation has to change the bytes, or every comparison below is one text read twice");

        Carried(fact with { PayloadJson = rearranged }).Should().Be(
            rearranged,
            "the layout is the producer's: the egress orders the FRAME's members and hands the text it was given on "
                + "unchanged, so nothing else decides what is inside it");

        T? statement = JsonSerializer.Deserialize<T>(carried);
        statement.Should().NotBeNull(
            "a payload that parsed to null would make the comparison below vacuously true");
        JsonSerializer.Deserialize<T>(rearranged).Should().BeEquivalentTo(
            statement,
            "the Mod's reader is keyed by member NAME, so the layout its producer chose cannot change what it reads");

        WireJson.Canonical(rearranged).Should().Be(
            WireJson.Canonical(carried),
            "member order is not part of what the fact states: the one ordering rule collapses the two layouts, so a "
                + "consumer that ever needs these bytes has a single door instead of the producers pre-sorting them");
    }

    /// <summary>The payload text one fact carries, extracted through the shipped frame writer.</summary>
    private static string Carried(BridgeWorldFact fact)
    {
        BridgeProtocol.TrySerialize(fact, out string frame, out string reasonCode).Should().BeTrue(reasonCode);
        using JsonDocument document = JsonDocument.Parse(frame);
        JsonElement embedded = document.RootElement.GetProperty("payloadJson");
        // The precondition of the read below, asserted by name rather than thrown out of GetString(): a world fact
        // states its subject as text, and as members the frame's own ordering rule would decide the payload's order.
        embedded.ValueKind.Should().Be(JsonValueKind.String, "a world fact states its subject as opaque text");
        string carried = embedded.GetString()!;
        carried.Should().NotBeNullOrWhiteSpace("a payload that says nothing is no evidence about its layout");
        return carried;
    }

    /// <summary>One statement in an order nobody chose: object members reversed at every depth, arrays untouched.</summary>
    private static string Rearranged(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        var buffer = new ArrayBufferWriter<byte>(Encoding.UTF8.GetByteCount(json));
        using (var writer = new Utf8JsonWriter(buffer))
        {
            WriteReversedMembers(document.RootElement, writer);
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void WriteReversedMembers(JsonElement element, Utf8JsonWriter writer)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (JsonProperty property in element.EnumerateObject().Reverse())
                {
                    writer.WritePropertyName(property.Name);
                    WriteReversedMembers(property.Value, writer);
                }

                writer.WriteEndObject();
                return;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (JsonElement item in element.EnumerateArray()) WriteReversedMembers(item, writer);
                writer.WriteEndArray();
                return;
            default:
                element.WriteTo(writer);
                return;
        }
    }
}
