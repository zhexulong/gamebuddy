namespace GameBuddy.Stardew;

/// <summary>
/// This world's identity as an attachment request must name it: the two fields the engine mints for a world and
/// this Host publishes in its advertisement (<see cref="HostFarmhandProvisioner"/>). Read once per use, so the slot
/// a binding is looked up by, the identity an advertisement carries and the identity a request is validated against
/// cannot be three spellings of two different moments.
/// </summary>
internal readonly record struct FarmhandWorldIdentity(string SaveId, string WorldId);

/// <summary>
/// Everything a signed attachment request is validated against that is not the request itself: the moment it is
/// being judged, this Mod instance's own session nonce, the session token its signature is keyed with, and the live
/// identity of the world it names.
/// </summary>
internal readonly record struct FarmhandRequestInput(
    FarmhandAttachmentRequest? Request,
    long NowUnixMs,
    string SessionNonce,
    string SessionToken,
    FarmhandWorldIdentity Live);

/// <summary>Who creates the fact a request refusal names: the Host's own signed request, or the engine's world.</summary>
internal enum FarmhandRequestRefusalOwner
{
    Host,
    Engine,
}

/// <summary>
/// Every reason a signed attachment request can be refused before it is acted on: one name per predicate, in the
/// order the predicates are applied, and each row naming who creates the fact it refuses on and the production
/// mechanism that creates it.
///
/// <para>
/// WHY THE PREDICATES ARE A TABLE AND NOT ONE <c>&amp;&amp;</c> CHAIN. Until 2026-11-21 <c>HandleRequest</c>
/// answered all of them with the single code <c>invalid_or_unauthorized_request</c>, and this repository's own
/// source-shape gate declared that code to mean <c>HasValidSignature</c> - so the code described one of fourteen
/// facts. A live first join (run r26) was refused with it, and the refusal could not be explained from any artifact
/// the run left: the request file is deleted on the next game tick, the answer carried a code that named none of the
/// predicates, and the Host surfaced it as one uncertain handoff. Two of those predicates are read from a game that
/// moves under the read, so "the request's copy of this world is stale" and "the signature does not verify" were
/// indistinguishable, and they need different fixes.
/// </para>
/// <para>
/// The table is also the one authority for the vocabulary: <c>AttachPreconditionOwnershipSourceShapeTests</c> reads
/// these rows instead of carrying a hand-typed row for a single code that stood for every one of them.
/// </para>
/// </summary>
internal static class FarmhandRequestRefusal
{
    internal const string RequestMissing = "request_missing";
    internal const string SchemaVersionUnsupported = "request_schema_version_unsupported";
    internal const string IntegrationMismatch = "request_integration_mismatch";
    internal const string SessionNonceStale = "request_session_nonce_stale";
    internal const string SaveIdMalformed = "request_save_id_malformed";
    internal const string WorldIdMalformed = "request_world_id_malformed";
    internal const string CompanionIdMalformed = "request_companion_id_malformed";
    internal const string CabinIdMalformed = "request_cabin_id_malformed";
    internal const string RequestIdMalformed = "request_request_id_malformed";
    internal const string ExpectedFarmhandMalformed = "request_expected_farmhand_malformed";
    internal const string ConfirmationNotYetReached = "request_confirmation_not_yet_reached";
    internal const string ConfirmationExpired = "request_confirmation_expired";
    internal const string SignatureInvalid = "request_signature_invalid";
    internal const string SaveIdentityStale = "request_save_identity_stale";
    internal const string WorldIdentityStale = "request_world_identity_stale";

    /// <summary>One refusal: its code, who creates the fact, the mechanism that creates it, and the predicate.</summary>
    internal readonly record struct Predicate(
        string Code,
        FarmhandRequestRefusalOwner Owner,
        string CreatedBy,
        Func<FarmhandRequestInput, bool> Holds);

    /// <summary>The confirmation window the Host's own signed request is accepted in.</summary>
    private const long ConfirmationWindowMs = 5 * 60_000;

    internal static readonly IReadOnlyList<Predicate> Predicates = new[]
    {
        new Predicate(RequestMissing, FarmhandRequestRefusalOwner.Host, "FarmhandAttachmentRequest",
            static input => input.Request is not null),
        new Predicate(SchemaVersionUnsupported, FarmhandRequestRefusalOwner.Host, "FarmhandProvisioningProtocol",
            static input => Body(input).SchemaVersion == FarmhandProvisioningProtocol.Version),
        new Predicate(IntegrationMismatch, FarmhandRequestRefusalOwner.Host, "FarmhandProvisioningProtocol",
            static input => Body(input).IntegrationId == FarmhandProvisioningProtocol.IntegrationId),
        // The nonce is minted once per Mod instance and published in every advertisement, so a request that names
        // another one was built from another session's advertisement - or from a provisioner this session replaced.
        new Predicate(SessionNonceStale, FarmhandRequestRefusalOwner.Host, "sessionNonce",
            static input => Body(input).SessionNonce == input.SessionNonce),
        new Predicate(SaveIdMalformed, FarmhandRequestRefusalOwner.Host, "IsValidOpaque",
            static input => FarmhandProvisioningProtocol.IsValidOpaque(Body(input).SaveId)),
        new Predicate(WorldIdMalformed, FarmhandRequestRefusalOwner.Host, "IsValidOpaque",
            static input => FarmhandProvisioningProtocol.IsValidOpaque(Body(input).WorldId)),
        new Predicate(CompanionIdMalformed, FarmhandRequestRefusalOwner.Host, "IsValidOpaque",
            static input => FarmhandProvisioningProtocol.IsValidOpaque(Body(input).CompanionId)),
        new Predicate(CabinIdMalformed, FarmhandRequestRefusalOwner.Host, "IsValidOpaque",
            static input => FarmhandProvisioningProtocol.IsValidOpaque(Body(input).CabinId)),
        new Predicate(RequestIdMalformed, FarmhandRequestRefusalOwner.Host, "IsValidOpaque",
            static input => FarmhandProvisioningProtocol.IsValidOpaque(Body(input).RequestId)),
        // The empty expected id is a value, not a missing one: it is how a first binding addresses an ownerless
        // cabin. Only a non-empty value that is not a native id is malformed.
        new Predicate(ExpectedFarmhandMalformed, FarmhandRequestRefusalOwner.Host, "TryParseNativeId",
            static input => Body(input).ExpectedFarmhandId.Length == 0
                || FarmhandProvisioningProtocol.TryParseNativeId(Body(input).ExpectedFarmhandId, out _)),
        new Predicate(ConfirmationNotYetReached, FarmhandRequestRefusalOwner.Host, "ConfirmedAtUnixMs",
            static input => Body(input).ConfirmedAtUnixMs <= input.NowUnixMs),
        new Predicate(ConfirmationExpired, FarmhandRequestRefusalOwner.Host, "ConfirmedAtUnixMs",
            static input => input.NowUnixMs - Body(input).ConfirmedAtUnixMs <= ConfirmationWindowMs),
        new Predicate(SignatureInvalid, FarmhandRequestRefusalOwner.Host, "HasValidSignature",
            static input => FarmhandProvisioningProtocol.HasValidSignature(Body(input), Body(input).Signature, input.SessionToken)),
        // The two live identities. An advertisement is republished from these every second and lives three, so a
        // request built from one is at most one beat old: if either has moved since, the request names a world this
        // Host has left, and the answer must say so rather than call the signature invalid.
        new Predicate(SaveIdentityStale, FarmhandRequestRefusalOwner.Engine, "uniqueIDForThisGame",
            static input => Body(input).SaveId == input.Live.SaveId),
        new Predicate(WorldIdentityStale, FarmhandRequestRefusalOwner.Engine, "MasterPlayer",
            static input => Body(input).WorldId == input.Live.WorldId),
    };

    /// <summary>The first refusal this input fails on, or the empty string when the request is admissible.</summary>
    internal static string For(FarmhandRequestInput input)
    {
        foreach (Predicate predicate in Predicates)
            if (!predicate.Holds(input))
                return predicate.Code;
        return string.Empty;
    }

    private static FarmhandAttachmentRequest Body(FarmhandRequestInput input) => input.Request!;
}
