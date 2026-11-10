using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// How one `for_each` node crosses the wire, and why it crosses it that way.
///
/// <para>
/// On the wire the loop is a runtime value TAGGED by `type: "loop"`, which is what stops it being mistaken for a string
/// that happens to hold the same JSON (<c>host/src/protocol.ts</c> `isBodyProgramRuntimeValue`). A canonical argument,
/// however, is a scalar or a destination selector on this frozen contract - <c>isBodyCanonicalValue</c> admits no third
/// shape - so the tag is dropped at the ONE boundary that knows it and the document becomes the canonical string its
/// argument declares. The Mod's own reader (<see cref="FarmhandForEachArguments"/>) is the only thing that reads it back.
/// </para>
/// <para>
/// These cases are the boundary itself: without them, "the loop arrives as a string" would only be true of a value a test
/// built by hand.
/// </para>
/// </summary>
public sealed class FarmhandForEachWireTests
{
    private const string Prefix = "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\",\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},\"type\":\"program_submit\",\"payload\":";

    private const string Patch = "{\"source\":{\"area\":{\"x\":60,\"y\":18,\"w\":20,\"h\":3}},\"do\":{\"action\":\"till_soil\"}}";

    private static ActionProgramCandidate Read(string loopValue)
    {
        string payload = "{\"programId\":\"program_1\",\"nodes\":[{\"nodeId\":\"loop\",\"actionId\":\"for_each\",\"arguments\":{\"loop\":"
            + loopValue
            + "},\"dependsOn\":[],\"bindings\":{}}]}";
        BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(Prefix + payload + "}", out BridgeEnvelope<ActionProgramCandidate>? envelope, out string reason)
            .Should()
            .BeTrue(reason);
        return envelope!.Payload;
    }

    /// <summary>
    /// The tagged loop becomes the canonical string the plan form declares, and it is exactly the document the Mod's
    /// reader accepts - one fact, two readers, no second spelling.
    /// </summary>
    [Fact]
    public void ATaggedLoopCrossesTheWireAsTheCanonicalStringItsArgumentDeclares()
    {
        ActionProgramCandidate program = Read("{\"type\":\"loop\"," + Patch[1..]);

        BodyProgramRuntimeValue value = program.Nodes.Single().Arguments[FarmhandForEachArguments.LoopArgument];
        value.Type.Should().Be("string", "a canonical argument has no third shape on this contract");
        value.CanonicalValue.Should().Be(Patch, "the document is carried verbatim, with the wire tag removed and nothing else changed");

        FarmhandForEachArguments.TryParseDocument(value.CanonicalValue, out FarmhandForEachLoop? loop, out string reasonCode)
            .Should()
            .BeTrue(reasonCode);
        loop!.Source.AreaRowCount.Should().Be(60);
        loop!.Do!.Steps[0].Action.Should().Be("till_soil");
    }

    /// <summary>
    /// The bound is the wire's, and it is refused at the boundary that knows it rather than carried into an admission
    /// challenge the Host would answer with a code that names nothing.
    /// </summary>
    [Fact]
    public void ALoopDocumentPastTheWireBoundIsRefusedAtTheCandidateBoundary()
    {
        string oversized = "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":{\"action\":\"till_soil\"},\"note\":\""
            + new string('x', FarmhandForEachArguments.MaximumDocumentChars)
            + "\"}";
        string payload = "{\"programId\":\"program_1\",\"nodes\":[{\"nodeId\":\"loop\",\"actionId\":\"for_each\",\"arguments\":{\"loop\":{\"type\":\"loop\","
            + oversized[1..]
            + "},\"dependsOn\":[],\"bindings\":{}}]}";

        BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(Prefix + payload + "}", out _, out string reasonCode).Should().BeFalse();
        reasonCode.Should().Be("invalid_body_program_request");
    }
}
