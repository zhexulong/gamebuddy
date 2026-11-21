using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// One refusal per predicate, and every refusal REACHABLE ALONE: each case hands the validator a request that
/// differs from an admissible one in exactly one fact, signed so the signature predicate still holds, and requires
/// exactly that fact's name.
///
/// <para>
/// The admissible request is the one live run firstjoin-r1 measured on a world the game created in that same
/// session - save `454941739`, host `-8562175747207173782`, one ownerless Cabin, an empty expected Farmhand id - so
/// the baseline is a FIRST JOIN and not a re-attachment. Before the split every case below answered the same code,
/// `invalid_or_unauthorized_request`, which is why the one refusal a live run ever produced (r26) could not be
/// traced to a fact.
/// </para>
/// </summary>
public sealed class FarmhandRequestRefusalTests
{
    private const string Token = "0123456789abcdef0123456789abcdef";
    private const string OtherToken = "fedcba9876543210fedcba9876543210";
    private const string Nonce = "b77e469cdeb946c0b7c941b494347172";
    private const long Now = 1_795_264_968_882;
    private const string SaveId = "454941739";
    private const string WorldId = "-8562175747207173782";
    private const string CabinId = "FarmHousea0b06a3c-90b4-46e3-a8ac-a0296f3dd8db";
    private const string RequestId = "abeb3277f5ad400393b7c7f3c15a4790";

    [Fact]
    public void AnAdmissibleFirstJoin_HasNoRefusal()
    {
        FarmhandRequestRefusal.For(Input()).Should().BeEmpty();
    }

    public static TheoryData<string, object> Falsified()
    {
        var cases = new TheoryData<string, object>();
        cases.Add(FarmhandRequestRefusal.RequestMissing, new FarmhandRequestInput(null, Now, Nonce, Token, Live()));
        cases.Add(FarmhandRequestRefusal.SchemaVersionUnsupported, Input(schemaVersion: 2));
        cases.Add(FarmhandRequestRefusal.IntegrationMismatch, Input(integrationId: "not_stardew"));
        cases.Add(FarmhandRequestRefusal.SessionNonceStale, Input(sessionNonce: "2565481896434e25bcb010cd4140925b"));
        cases.Add(FarmhandRequestRefusal.SaveIdMalformed, Input(saveId: "454941739 1"));
        cases.Add(FarmhandRequestRefusal.WorldIdMalformed, Input(worldId: "-8562175747207173782.0"));
        cases.Add(FarmhandRequestRefusal.CompanionIdMalformed, Input(companionId: "firstjoin r1"));
        cases.Add(FarmhandRequestRefusal.CabinIdMalformed, Input(cabinId: ""));
        cases.Add(FarmhandRequestRefusal.RequestIdMalformed, Input(requestId: ""));
        cases.Add(FarmhandRequestRefusal.ExpectedFarmhandMalformed, Input(expectedFarmhandId: "not_an_id"));
        cases.Add(FarmhandRequestRefusal.ConfirmationNotYetReached, Input(confirmedAtUnixMs: Now + 1));
        cases.Add(FarmhandRequestRefusal.ConfirmationExpired, Input(confirmedAtUnixMs: Now - (5 * 60_000) - 1));
        cases.Add(FarmhandRequestRefusal.SignatureInvalid, Input(signatureToken: OtherToken));
        cases.Add(FarmhandRequestRefusal.SaveIdentityStale, Input(saveId: "454940607"));
        cases.Add(FarmhandRequestRefusal.WorldIdentityStale, Input(worldId: "2554279959941605519"));
        return cases;
    }

    [Theory]
    [MemberData(nameof(Falsified))]
    public void OneFalsifiedPredicate_NamesThatRefusalAndNoOther(string expected, object payload)
    {
        FarmhandRequestRefusal.For((FarmhandRequestInput)payload).Should().Be(expected);
    }

    /// <summary>
    /// The vocabulary and the table are one fact: a name with no row is a code nobody can reach, and a row whose
    /// code is not a name is a refusal nobody can match on.
    /// </summary>
    [Fact]
    public void EveryNamedRefusal_IsARowOfTheTable()
    {
        string[] named = typeof(FarmhandRequestRefusal)
            .GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            .Where(field => field is { IsLiteral: true } && field.FieldType == typeof(string))
            .Select(field => (string)field.GetRawConstantValue()!)
            .ToArray();

        named.Should().NotBeEmpty("the vocabulary is a declaration, and a reader that found nothing agrees with itself");
        named.Should().BeEquivalentTo(FarmhandRequestRefusal.Predicates.Select(predicate => predicate.Code));
        FarmhandRequestRefusal.Predicates.Should().OnlyHaveUniqueItems(predicate => predicate.Code);
    }

    private static FarmhandRequestInput Input(
        int schemaVersion = 1,
        string integrationId = FarmhandProvisioningProtocol.IntegrationId,
        string sessionNonce = Nonce,
        string saveId = SaveId,
        string worldId = WorldId,
        string companionId = "firstjoin-r1_companion",
        string cabinId = CabinId,
        string expectedFarmhandId = "",
        long confirmedAtUnixMs = Now,
        string requestId = RequestId,
        string signatureToken = Token,
        FarmhandWorldIdentity? live = null)
    {
        FarmhandAttachmentRequest unsigned = new()
        {
            SchemaVersion = schemaVersion,
            IntegrationId = integrationId,
            SessionNonce = sessionNonce,
            SaveId = saveId,
            WorldId = worldId,
            CompanionId = companionId,
            CabinId = cabinId,
            ExpectedFarmhandId = expectedFarmhandId,
            ConfirmedAtUnixMs = confirmedAtUnixMs,
            RequestId = requestId,
        };
        FarmhandAttachmentRequest signed = Signed(unsigned, signatureToken);
        return new FarmhandRequestInput(signed, Now, Nonce, Token, live ?? Live());
    }

    /// <summary>The same request with the signature its own bytes produce under <paramref name="token"/>.</summary>
    private static FarmhandAttachmentRequest Signed(FarmhandAttachmentRequest request, string token) => new()
    {
        SchemaVersion = request.SchemaVersion,
        IntegrationId = request.IntegrationId,
        SessionNonce = request.SessionNonce,
        SaveId = request.SaveId,
        WorldId = request.WorldId,
        CompanionId = request.CompanionId,
        CabinId = request.CabinId,
        ExpectedFarmhandId = request.ExpectedFarmhandId,
        ConfirmedAtUnixMs = request.ConfirmedAtUnixMs,
        RequestId = request.RequestId,
        Signature = FarmhandProvisioningProtocol.Sign(request, token),
    };

    private static FarmhandWorldIdentity Live() => new(SaveId, WorldId);
}
