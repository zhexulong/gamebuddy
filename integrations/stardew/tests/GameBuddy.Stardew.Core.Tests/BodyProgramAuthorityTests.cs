using System.Text.Json;
using System.Text.Json.Nodes;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class BodyProgramAuthorityTests
{
    [Theory]
    [InlineData(BodyProgramJournalReadStatus.Empty, BodyProgramJournalOpenStatus.Empty)]
    [InlineData(BodyProgramJournalReadStatus.ReadFailed, BodyProgramJournalOpenStatus.PersistenceReadFailed)]
    public void OpenMapsExplicitStoreReadStatusWithoutUsingAbsenceSentinels(BodyProgramJournalReadStatus readStatus, BodyProgramJournalOpenStatus expectedStatus)
    {
        var store = new MemoryStore();
        if (readStatus == BodyProgramJournalReadStatus.ReadFailed)
        {
            store.Set("committed-old-target");
            store.ReadResult = new BodyProgramJournalReadResult(readStatus, null);
        }
        else
        {
            store.ReadResult = new BodyProgramJournalReadResult(readStatus, null);
        }

        OpenBodyProgramJournalAuthority authority = Open(store);

        authority.OpenStatus.Should().Be(expectedStatus);
        store.WriteCount.Should().Be(0);
        if (readStatus == BodyProgramJournalReadStatus.ReadFailed)
            store.Value.Should().Be("committed-old-target");
        if (expectedStatus != BodyProgramJournalOpenStatus.Empty)
            authority.Submit(Program("blocked")).Code.Should().Be(BodyProgramSubmitCode.Quarantined);
    }

    [Fact]
    public void CloseIsIdempotentAndRetainedAuthorityQueriesAndMutationsFailClosed()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        authority.Close().Should().Be(BodyProgramAuthorityLifecycleState.Closed);
        authority.Close().Should().Be(BodyProgramAuthorityLifecycleState.Closed);
        authority.LifecycleState.Should().Be(BodyProgramAuthorityLifecycleState.Closed);

        Action query = () => authority.Status("program");
        Action verify = () => authority.Verify(Program("program"));
        query.Should().Throw<ObjectDisposedException>();
        verify.Should().Throw<ObjectDisposedException>();
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Quarantined);
        authority.TryStop("program", 1).Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
    }

    [Fact]
    public void OpenTreatsPresentEmptyOrMalformedPayloadAsCorruptWithoutClearingIt()
    {
        foreach (string payload in new[] { string.Empty, "not-json" })
        {
            var store = new MemoryStore { ReadResult = new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, payload) };

            OpenBodyProgramJournalAuthority authority = Open(store);

            authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
            store.WriteCount.Should().Be(0);
            authority.Submit(Program("blocked")).Code.Should().Be(BodyProgramSubmitCode.Quarantined);
        }
    }

    [Fact]
    public void OpenUsesPresentPayloadForStrictDecode()
    {
        BodyProgramJournalState emptyState = new(BodyProgramJournalPersistence.SchemaVersion, Scope(), Policy(), 0, Array.Empty<BodyProgramJournalProgram>(), Array.Empty<BodyProgramJournalEvent>());
        string encoded = BodyProgramJournalPersistence.Encode(emptyState, Catalog(), Scope());
        var store = new MemoryStore { ReadResult = new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, encoded) };

        OpenBodyProgramJournalAuthority authority = Open(store);

        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Opened);
        authority.Snapshot.Programs.Should().BeEmpty();
        store.WriteCount.Should().Be(0);
    }

    [Fact]
    public void OpenFailsClosedOnUnknownStoreReadStatus()
    {
        var store = new MemoryStore { ReadResult = new BodyProgramJournalReadResult((BodyProgramJournalReadStatus)999, "ignored") };

        OpenBodyProgramJournalAuthority authority = Open(store);

        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.PersistenceReadFailed);
        authority.Submit(Program("blocked")).Code.Should().Be(BodyProgramSubmitCode.Quarantined);
        store.WriteCount.Should().Be(0);
    }

    [Fact]
    public void CodecMatchesFrozenHostCandidateShapeAndDecodesTypedArguments()
    {
        const string json = "{\"programId\":\"program\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"move_to_tile\",\"arguments\":{\"tile\":{\"type\":\"integer\",\"canonicalValue\":\"7\"}},\"dependsOn\":[],\"bindings\":{}}]}";
        ActionProgramCandidateCodec.TryDecode(json, out ActionProgramCandidate? candidate, out _).Should().BeTrue();
        Open().Verify(candidate!).Accepted.Should().BeTrue();
        ActionProgramCandidateCodec.TryDecode(json.Replace("\"7\"", "\"07\"", StringComparison.Ordinal), out _, out _).Should().BeTrue();
        ActionProgramCandidateCodec.TryDecode(json.Replace("\"7\"", "\"07\"", StringComparison.Ordinal), out ActionProgramCandidate? invalid, out _).Should().BeTrue();
        Open().Verify(invalid!).Accepted.Should().BeFalse();
        // Agent-facing candidates never carry a clock field; any deadlineMs is rejected.
        ActionProgramCandidateCodec.TryDecode(json.Replace("\"nodes\"", "\"deadlineMs\":1000,\"nodes\"", StringComparison.Ordinal), out _, out _).Should().BeFalse();
        ActionProgramCandidateCodec.TryDecode(json.Replace("\"bindings\":{}", "\"bindings\":{},\"deadlineMs\":9007199254740992", StringComparison.Ordinal), out _, out _).Should().BeFalse();
    }

    [Fact]
    public void CandidateCodecRoundTripsNonEmptyBindingUsingCanonicalCamelCaseKeys()
    {
        ActionProgramCandidate source = Program("program", twoNodes: true);
        string json = JsonSerializer.Serialize(source, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

        json.Should().Contain("producerNodeId").And.NotContain("\"nodeId\":\"first\",\"factName\"");
        ActionProgramCandidateCodec.TryDecode(json, out ActionProgramCandidate? decoded, out _).Should().BeTrue();
        decoded!.Nodes.Single(node => node.NodeId == "second").Bindings["tile"]
            .Should().Be(new ActionProgramBinding("first", "arrival"));
        ActionProgramCandidateCodec.TryDecode(json.Replace("producerNodeId", "nodeId", StringComparison.Ordinal), out _, out _).Should().BeFalse();
    }

    [Fact]
    public void CandidateCodecAcceptsDestinationSelectorObjectAndRejectsScalarizedSelector()
    {
        const string json = "{\"programId\":\"program\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"navigate\",\"arguments\":{\"destination\":{\"type\":\"destination_selector\",\"destination\":{\"kind\":\"label\",\"label\":\"Town\"}}},\"dependsOn\":[],\"bindings\":{}}]}";
        ActionProgramCandidateCodec.TryDecode(json, out ActionProgramCandidate? candidate, out _).Should().BeTrue();
        candidate!.Nodes.Single().Arguments["destination"].CanonicalValue.Should().BeNull();
        candidate.Nodes.Single().Arguments["destination"].Destination!.Label.Should().Be("Town");
        ActionProgramCandidateCodec.TryDecode(json.Replace("{\"kind\":\"label\",\"label\":\"Town\"}", "\"Town\"", StringComparison.Ordinal), out _, out _).Should().BeFalse();
    }

    [Fact]
    public void JournalPersistenceRoundTripsValidArrivalWithNullContextLabel()
    {
        BodyProgramActionCatalog catalog = ArrivalCatalog();
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store, catalog: catalog);
        authority.Submit(ArrivalProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, TerminalSuccess(grant, ArrivalFact(grant))).IsSuccess.Should().BeTrue();

        OpenBodyProgramJournalAuthority reopened = Open(store, catalog: catalog);

        reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Opened);
        using (JsonDocument persisted = JsonDocument.Parse(store.Value!))
        {
            persisted.RootElement.GetProperty("policyIdentity").EnumerateObject().Select(property => property.Name)
                .Should().BeEquivalentTo(new[] { "value", "capabilityRevision" }, options => options.WithStrictOrdering());
            persisted.RootElement.GetProperty("policyIdentity").GetProperty("value").GetString().Should().Be("policy-a");
            persisted.RootElement.GetProperty("policyIdentity").GetProperty("capabilityRevision").GetInt64().Should().Be(1);
        }
         reopened.Snapshot.PolicyIdentity.Should().Be(Policy());
         reopened.Snapshot.Programs.Single().Nodes.Single().ExecutionBinding.Should().Be(grant.ExecutionBinding);
         reopened.Snapshot.Programs.Single().Facts.Single().Values["arrival"].Arrival.Should()
             .Be(new BodyProgramDestinationArrival("destination_arrived", new BodyProgramArrivalDestination("Town", null)));
    }

    [Fact]
    public void JournalPersistenceRejectsNullDestinationAndForbiddenArrivalFields()
    {
        BodyProgramActionCatalog catalog = ArrivalCatalog();
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store, catalog: catalog);
        authority.Submit(ArrivalProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, TerminalSuccess(grant, ArrivalFact(grant))).IsSuccess.Should().BeTrue();
        string valid = store.Value!;

        string[] invalidForms =
        {
            valid.Replace("\"destination\":{\"label\":\"Town\"}", "\"destination\":null", StringComparison.Ordinal),
            valid.Replace("\"arrival\":{\"reason\":\"destination_arrived\",\"destination\":{\"label\":\"Town\"}}", "\"arrival\":null", StringComparison.Ordinal),
            valid.Replace("\"destination\":{\"label\":\"Town\"}", "\"destination\":{\"label\":\"Town\",\"extra\":null}", StringComparison.Ordinal),
            valid.Replace("\"destination\":{\"label\":\"Town\"}", "\"destination\":{\"label\":\"Town\",\"ref\":\"forbidden\"}", StringComparison.Ordinal),
            valid.Replace("\"factName\":\"arrival\",\"values\"", "\"factName\":\"arrival\",\"route\":[],\"values\"", StringComparison.Ordinal),
            valid.Replace("\"factName\":\"arrival\",\"values\"", "\"factName\":\"arrival\",\"evidence\":\"forbidden\",\"values\"", StringComparison.Ordinal),
        };

        foreach (string invalid in invalidForms)
        {
            store.Set(invalid);
            Open(store, catalog: catalog).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
        }
    }

    [Fact]
    public void ActionDescriptorRejectsSelectorAsFactAndArrivalAsArgument()
    {
        Action selectorAsFact = () => _ = new BodyProgramActionCatalog(7, new[]
        {
            new BodyProgramActionDescriptor("produces_selector", 1, Array.Empty<BodyProgramArgumentDescriptor>(),
                new[] { new BodyProgramFactDescriptor("destination", BodyProgramArgumentKind.DestinationSelector) }, Array.Empty<BodyProgramResourceTemplateClaim>()),
        });
        Action arrivalAsArgument = () => _ = new BodyProgramActionCatalog(7, new[]
        {
            new BodyProgramActionDescriptor("accepts_arrival", 1,
                new[] { new BodyProgramArgumentDescriptor("arrival", BodyProgramArgumentKind.DestinationArrival) },
                Array.Empty<BodyProgramFactDescriptor>(), Array.Empty<BodyProgramResourceTemplateClaim>()),
        });

        selectorAsFact.Should().Throw<ArgumentException>();
        arrivalAsArgument.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void CandidateCodecAcceptsDestinationSelectorRefAndRejectsExtraSelectorKeys()
    {
        const string reference = "dr1_AAAAAAAAAAAAAAAAAAAAAA";
        string json = $"{{\"programId\":\"program\",\"nodes\":[{{\"nodeId\":\"first\",\"actionId\":\"navigate\",\"arguments\":{{\"destination\":{{\"type\":\"destination_selector\",\"destination\":{{\"kind\":\"ref\",\"ref\":\"{reference}\"}}}}}},\"dependsOn\":[],\"bindings\":{{}}}}]}}";
        ActionProgramCandidateCodec.TryDecode(json, out ActionProgramCandidate? candidate, out _).Should().BeTrue();
        candidate!.Nodes.Single().Arguments["destination"].Destination!.Ref.Should().Be(reference);
        ActionProgramCandidateCodec.TryDecode(json.Replace("\"ref\":\"" + reference, "\"ref\":\"" + reference + "\",\"extra\":null", StringComparison.Ordinal), out _, out _).Should().BeFalse();
    }

    [Fact]
    public void VerifyIsPureWhileSubmitDurablyAcceptsAndIsIdempotent()
    {
        var store = new MemoryStore(); var authority = Open(store); ActionProgramCandidate candidate = Program("program");
        authority.Verify(candidate).Accepted.Should().BeTrue(); store.Value.Should().BeNull();
        authority.Submit(candidate).Code.Should().Be(BodyProgramSubmitCode.Accepted); store.Value.Should().NotBeNull();
        authority.Submit(candidate).Code.Should().Be(BodyProgramSubmitCode.Idempotent);
        // A candidate with a different bound argument is a distinct program.
        string other = "{\"programId\":\"program\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"move_to_tile\",\"arguments\":{\"tile\":{\"type\":\"integer\",\"canonicalValue\":\"8\"}},\"dependsOn\":[],\"bindings\":{}}]}";
        ActionProgramCandidateCodec.TryDecode(other, out ActionProgramCandidate? otherCandidate, out _).Should().BeTrue();
        authority.Submit(otherCandidate!).Code.Should().Be(BodyProgramSubmitCode.Conflict);
    }

    [Fact]
    public void ExistingSameCandidateRejectsChangedPolicyIdentity()
    {
        BodyProgramPolicyIdentity policy = Policy("policy-a", 2);
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store, policy: () => policy);
        ActionProgramCandidate candidate = Program("program");
        authority.Submit(candidate).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        policy = Policy("policy-b", 2);
        BodyProgramSubmitResult stale = authority.Submit(candidate);

        stale.Code.Should().Be(BodyProgramSubmitCode.Rejected);
        stale.Verification.Diagnostics.Should().ContainSingle(diagnostic => diagnostic.Code == "policy_identity_stale");
        authority.Status("program").Code.Should().Be(BodyProgramQueryCode.Found);
    }

    [Fact]
    public void ExistingConflictRejectsChangedPolicyIdentity()
    {
        BodyProgramPolicyIdentity policy = Policy("policy-a", 2);
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store, policy: () => policy);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        policy = Policy("policy-a", 3);
        BodyProgramSubmitResult stale = authority.Submit(Program("program"));

        stale.Code.Should().Be(BodyProgramSubmitCode.Rejected);
        stale.Verification.Diagnostics.Should().ContainSingle(diagnostic => diagnostic.Code == "policy_identity_stale");
        authority.Status("program").Code.Should().Be(BodyProgramQueryCode.Found);
    }

    [Fact]
    public void ExistingSameCandidateReturnsIdempotentForExactPolicyIdentity()
    {
        BodyProgramPolicyIdentity policy = Policy("policy-a", 2);
        var authority = Open(policy: () => policy);
        ActionProgramCandidate candidate = Program("program");
        authority.Submit(candidate).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        authority.Submit(candidate).Code.Should().Be(BodyProgramSubmitCode.Idempotent);
    }

    [Fact]
    public void SubmitRejectsChangedPolicyIdentityWithoutChangingDurableState()
    {
        BodyProgramPolicyIdentity policy = Policy("policy-a", 2);
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store, policy: () => policy);
        authority.Submit(Program("accepted")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        string persistedPolicy = store.Value!;

        policy = Policy("policy-b", 2);
        BodyProgramSubmitResult stale = authority.Submit(Program("stale"));

        stale.Code.Should().Be(BodyProgramSubmitCode.Rejected);
        stale.Verification.Diagnostics.Should().ContainSingle(diagnostic => diagnostic.Code == "policy_identity_stale");
        store.Value.Should().Be(persistedPolicy);
        authority.Snapshot.PolicyIdentity.Should().Be(Policy("policy-a", 2));
        authority.Status("stale").Code.Should().Be(BodyProgramQueryCode.NotFound);
    }

    [Fact]
    public void SubmitRejectsChangedPolicyRevisionAndAbaWithoutChangingDurableState()
    {
        BodyProgramPolicyIdentity policy = Policy("policy-a", 2);
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store, policy: () => policy);
        authority.Submit(Program("accepted")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        string persistedPolicy = store.Value!;

        policy = Policy("policy-a", 3);
        authority.Submit(Program("revision-stale")).Code.Should().Be(BodyProgramSubmitCode.Rejected);
        policy = Policy("policy-b", 2);
        authority.Submit(Program("value-stale")).Code.Should().Be(BodyProgramSubmitCode.Rejected);
        policy = Policy("policy-a", 2);
        BodyProgramSubmitResult aba = authority.Submit(Program("aba-stale"));

        aba.Code.Should().Be(BodyProgramSubmitCode.Rejected);
        aba.Verification.Diagnostics.Should().ContainSingle(diagnostic => diagnostic.Code == "policy_identity_stale");
        store.Value.Should().Be(persistedPolicy);
        authority.Snapshot.PolicyIdentity.Should().Be(Policy("policy-a", 2));
        authority.Status("revision-stale").Code.Should().Be(BodyProgramQueryCode.NotFound);
        authority.Status("value-stale").Code.Should().Be(BodyProgramQueryCode.NotFound);
        authority.Status("aba-stale").Code.Should().Be(BodyProgramQueryCode.NotFound);
    }

    [Fact]
    public void PolicyIdentityRequiresExactValueAndRevisionAndRejectsAbaReuse()
    {
        BodyProgramPolicyIdentity policy = Policy("policy-a", 1);
        var authority = Open(policy: () => policy);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        policy = Policy("policy-b", 1);
        authority.TryConsumeHostGrant(grant).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);

        policy = Policy("policy-a", 2);
        authority.TryConsumeHostGrant(grant).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);

        policy = Policy("policy-b", 2);
        authority.TryConsumeHostGrant(grant).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);
        policy = Policy("policy-a", 1);
        authority.TryConsumeHostGrant(grant).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);
    }

    [Fact]
    public void PolicyIdentityPersistenceRejectsLegacyAndMalformedShapes()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        string persisted = store.Value!;
        store.Set(persisted.Replace("\"value\":\"policy-a\",\"capabilityRevision\":1", "\"embodimentId\":\"policy-a\",\"generation\":1", StringComparison.Ordinal));
        Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);

        Action malformed = () => Open(policy: () => new BodyProgramPolicyIdentity("", 1));
        malformed.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void StatusAndEventsCarryHostAddressedCatalogProjection()
    {
        var authority = Open(); authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        status.CatalogRevision.Should().Be(7); status.EventHighWater.Should().BeGreaterThan(0);
        BodyProgramEventsResult events = authority.Events("program", 0, 1);
        events.Events.Should().ContainSingle().Which.CatalogRevision.Should().Be(7);
        events.NextCursor.Should().Be(events.Events.Single().Cursor);
    }

    [Fact]
    public void EventsPastHighWaterProjectAndSerializeAsAnEmptyContinuationPage()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        long highWater = authority.Status("program").Snapshot!.EventHighWater;

        BodyProgramEventsResult page = authority.Events("program", highWater + 1, 1);

        page.Code.Should().Be(BodyProgramQueryCode.Found);
        page.Events.Should().BeEmpty();
        page.NextCursor.Should().Be(highWater + 1);
    }

    [Fact]
    public void DispatchAndCompletionRejectModifiedGrantDeadlineStopCatalogArgsResourcesAndPolicyAba()
    {
        BodyProgramPolicyIdentity policy = Policy(); long now = 10; var authority = Open(policy: () => policy, now: () => now);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!; HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        NodeExecutionBinding execution = Execution(grant);
        authority.TryBeginNativeDispatch(grant with { GrantId = "forged" }, execution).Code.Should().Be(BodyProgramControllerResultCode.GrantMismatch);
        authority.TryBeginNativeDispatch(grant with { DeadlineMs = 999 }, execution).Code.Should().Be(BodyProgramControllerResultCode.GrantMismatch);
        authority.TryBeginNativeDispatch(grant with { CanonicalArguments = CanonicalMap("tile", 8) }, execution).Code.Should().Be(BodyProgramControllerResultCode.GrantMismatch);
        authority.TryBeginNativeDispatch(grant with { DerivedResourceClaims = Claims("actor", "other") }, execution).Code.Should().Be(BodyProgramControllerResultCode.GrantMismatch);
        policy = Policy("policy-b", 1); authority.TryBeginNativeDispatch(grant, execution).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);
        policy = Policy("policy-a", 2); authority.TryBeginNativeDispatch(grant, execution).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);
        now = 1001; authority.TryBeginNativeDispatch(grant, execution).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);
    }

    [Fact]
    public void CompleteRejectsUndefinedOutcomeWithoutChangingRunningNodeOrJournal()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        var controller = new FarmhandBodyProgramController(authority);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = controller.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = controller.TryConsumeHostGrant(grant).Value!;
        controller.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        string journalBeforeCompletion = store.Value!;

        BodyProgramControllerResult<BodyProgramTerminalResult> result = controller.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), (BodyProgramNodeOutcome)999, Array.Empty<RuntimeFact>(), null, null, null));

        result.Code.Should().Be(BodyProgramControllerResultCode.InvalidInput);
        authority.Status("program").Snapshot!.State.Should().Be(BodyProgramState.Active);
        authority.Status("program").Snapshot!.Nodes.Single().State.Should().Be(BodyProgramNodeState.Running);
        store.Value.Should().Be(journalBeforeCompletion);
    }

    [Fact]
    public void AuthorityCompleteRejectsUndefinedOutcomeWithoutChangingRunningNodeOrJournal()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        string journalBeforeCompletion = store.Value!;

        BodyProgramControllerResult<BodyProgramTerminalResult> result = authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), (BodyProgramNodeOutcome)999, Array.Empty<RuntimeFact>(), null, null, null));

        result.Code.Should().Be(BodyProgramControllerResultCode.InvalidInput);
        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Empty);
        authority.OpenStatus.Should().NotBe(BodyProgramJournalOpenStatus.PersistenceWriteFailed);
        authority.Status("program").Snapshot!.State.Should().Be(BodyProgramState.Active);
        authority.Status("program").Snapshot!.Nodes.Single().State.Should().Be(BodyProgramNodeState.Running);
        store.Value.Should().Be(journalBeforeCompletion);
    }

    [Theory]
    [InlineData(BodyProgramNodeOutcome.Failed)]
    [InlineData(BodyProgramNodeOutcome.Cancelled)]
    public void RestartFencesTerminalFailedOrCancelledProgramsWithAnyNonterminalSibling(BodyProgramNodeOutcome outcome)
    {
        var store = new MemoryStore(); var authority = Open(store);
        authority.Submit(Program("program", twoNodes: true)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!; HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!; authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, TerminalOutcome(grant, outcome)).IsSuccess.Should().BeTrue();

         OpenBodyProgramJournalAuthority reopened = Open(store, policy: () => Policy("policy-b", 2));
         BodyProgramJournalPersistence.TryValidate(reopened.Snapshot, out string? restartValidationReason).Should().BeTrue(restartValidationReason);
         reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
        BodyProgramJournalProgram program = reopened.Snapshot.Programs.Single();
        program.State.Should().Be(BodyProgramState.RecoveryRequired);
         BodyProgramJournalNode terminal = program.Nodes.Single(node => node.NodeId == "first");
         terminal.State.Should().Be(outcome == BodyProgramNodeOutcome.Failed ? BodyProgramNodeState.Failed : BodyProgramNodeState.Cancelled);
         terminal.ExecutionBinding.Should().NotBeNull();
         terminal.GrantId.Should().BeNull();
         program.Nodes.Single(node => node.NodeId == "second").State.Should().Be(BodyProgramNodeState.Pending);
    }
    [Fact]
    public void ReopenRejectsPersistedFactWithTamperedOutputKind()
    {
        var store = new MemoryStore(); var authority = Open(store);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!; HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!; authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, TerminalSuccess(grant, Fact(grant))).IsSuccess.Should().BeTrue();

        store.Set(store.Value!.Replace("\"factName\":\"arrival\",\"values\":{\"arrival\":{\"kind\":1", "\"factName\":\"arrival\",\"values\":{\"arrival\":{\"kind\":2", StringComparison.Ordinal));
        OpenBodyProgramJournalAuthority? reopened = null;
        Action reopen = () => reopened = Open(store);
        reopen.Should().NotThrow();
        reopened!.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
    }

    [Fact]
    public void CandidateVerifierRejectsDuplicateDependencyIds()
    {
        ActionProgramCandidate candidate = new("program", new[]
        {
            new ActionProgramCandidateNode("first", "move_to_tile", RuntimeMap("tile", 7), Array.Empty<string>(), Bindings()),
            new ActionProgramCandidateNode("second", "till_soil", RuntimeMap("tile", 8), new[] { "first", "first" }, Bindings()),
        });

        BodyProgramVerificationReport verification = Open().Verify(candidate);

        verification.Accepted.Should().BeFalse();
        verification.Diagnostics.Should().ContainSingle(diagnostic => diagnostic.Code == "invalid_dependency" && diagnostic.NodeId == "second");
    }

    [Fact]
    public void ReopenRejectsPersistedDuplicateDependencyId()
    {
        var store = new MemoryStore();
        Open(store).Submit(OrderedConflictingProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        store.Set(store.Value!.Replace("\"dependsOn\":[\"first\"]", "\"dependsOn\":[\"first\",\"first\"]", StringComparison.Ordinal));

        Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
    }

    [Fact]
    public void ReopenRejectsPersistedUnorderedResourceConflict()
    {
        var store = new MemoryStore();
        Open(store).Submit(OrderedConflictingProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        store.Set(store.Value!.Replace("\"dependsOn\":[\"first\"]", "\"dependsOn\":[]", StringComparison.Ordinal));

        Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
    }

    [Fact]
    public void CandidateCodecRejectsAgentAuthoredDeadlineField()
    {
        string withDeadline = "{\"programId\":\"program\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"move_to_tile\",\"arguments\":{\"tile\":{\"type\":\"integer\",\"canonicalValue\":\"7\"}},\"dependsOn\":[],\"bindings\":{},\"deadlineMs\":9007199254740992}]}";
        ActionProgramCandidateCodec.TryDecode(withDeadline, out _, out _).Should().BeFalse();
        // The descriptor/Mod derives the watchdog deadline at admission time;
        // a candidate without any clock field is the only accepted shape.
        string clean = "{\"programId\":\"program\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"move_to_tile\",\"arguments\":{\"tile\":{\"type\":\"integer\",\"canonicalValue\":\"7\"}},\"dependsOn\":[],\"bindings\":{}}]}";
        ActionProgramCandidateCodec.TryDecode(clean, out ActionProgramCandidate? candidate, out _).Should().BeTrue();
        Open().Verify(candidate!).Accepted.Should().BeTrue();
    }

    [Fact]
    public void CandidateCodecDoesNotApplyBodyProgramSpecificSizeCap()
    {
        BodyProgramArgumentDescriptor[] arguments = Enumerable.Range(0, 32).Select(index => new BodyProgramArgumentDescriptor($"arg{index:D2}", BodyProgramArgumentKind.String)).ToArray();
        BodyProgramActionCatalog catalog = new(7, new[] { new BodyProgramActionDescriptor("large_action", 1, arguments, Array.Empty<BodyProgramFactDescriptor>(), Array.Empty<BodyProgramResourceTemplateClaim>()) });
        IReadOnlyDictionary<string, BodyProgramRuntimeValue> values = arguments.ToDictionary(argument => argument.Name, _ => new BodyProgramRuntimeValue("string", new string('x', 400)), StringComparer.Ordinal);
        ActionProgramCandidate source = new("program", new[] { new ActionProgramCandidateNode("first", "large_action", values, Array.Empty<string>(), Bindings()) });
        string json = JsonSerializer.Serialize(source, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

        System.Text.Encoding.UTF8.GetByteCount(json).Should().BeGreaterThan(12 * 1024);
        ActionProgramCandidateCodec.TryDecode(json, out ActionProgramCandidate? decoded, out _).Should().BeTrue();
        Open(catalog: catalog).Verify(decoded!).Accepted.Should().BeTrue();
    }

    [Fact]
    public void ReopenRejectsMalformedDescriptorMapsFactsBindingsAndTopologyWithoutThrowing()
    {
        Action invalidTemplate = () => _ = new BodyProgramActionCatalog(7, new[] { new BodyProgramActionDescriptor("move_to_tile", 1, new[] { new BodyProgramArgumentDescriptor("tile", BodyProgramArgumentKind.Integer) }, Array.Empty<BodyProgramFactDescriptor>(), new[] { new BodyProgramResourceTemplateClaim("actor", BodyProgramResourceTemplateValue.ScopePlayer), new BodyProgramResourceTemplateClaim("actor", BodyProgramResourceTemplateValue.ActionId) }) });
        invalidTemplate.Should().Throw<ArgumentException>();
        var store = new MemoryStore(); var authority = Open(store); authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        string corrupt = store.Value!.Replace("\"canonicalValue\":\"7\"", "\"canonicalValue\":\"07\"", StringComparison.Ordinal);
        store.Set(corrupt);
        Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
    }

    [Fact]
    public void ExecutionBindingExactLinksProgramIdNodeAttemptAndIsPersistedOnRunningNode()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        NodeExecutionBinding execution = Execution(grant);
        authority.TryBeginNativeDispatch(grant, execution).IsSuccess.Should().BeTrue();
        authority.Status("program").Snapshot!.Nodes.Single().ExecutionBinding.Should().Be(execution);
        BodyProgramJournalState persisted = BodyProgramJournalPersistence.FreezeState(authority.Snapshot);
        persisted.Programs.Single().Nodes.Single().ExecutionBinding.Should().Be(execution);
        using JsonDocument document = JsonDocument.Parse(store.Value!);
        JsonElement binding = document.RootElement.GetProperty("programs")[0].GetProperty("nodes")[0].GetProperty("executionBinding");
        binding.GetProperty("programId").GetString().Should().Be(execution.ProgramId);
        binding.GetProperty("nodeId").GetString().Should().Be(execution.NodeId);
        binding.GetProperty("nodeAttempt").GetInt32().Should().Be(execution.NodeAttempt);
        binding.GetProperty("requestId").GetString().Should().Be(execution.RequestId);
        binding.GetProperty("idempotencyKey").GetString().Should().Be(execution.IdempotencyKey);
        binding.GetProperty("executionId").GetString().Should().Be(execution.ExecutionId);
    }

    [Fact]
    public void DispatchRejectsExecutionBindingWithMismatchedNodeAttempt()
    {
        var authority = Open();
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        NodeExecutionBinding mismatched = new(grant.ProgramId, grant.NodeId, grant.NodeAttempt + 1, "request-1", "idem-1", "exec-1");
        authority.TryBeginNativeDispatch(grant, mismatched).Code.Should().Be(BodyProgramControllerResultCode.ExecutionBindingMismatch);
    }

    [Fact]
    public void CompletionRejectsExecutionBindingNotEqualToDispatchBinding()
    {
        var authority = Open();
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        NodeExecutionBinding different = new(grant.ProgramId, grant.NodeId, grant.NodeAttempt, "other-request", "other-idem", "other-exec");
        authority.TryComplete(grant, new BodyProgramTerminalResult(different, BodyProgramNodeOutcome.Succeeded, new[] { Fact(grant) }, "receipt", "evidence", "postcondition")).Code.Should().Be(BodyProgramControllerResultCode.ExecutionBindingMismatch);
    }

    [Fact]
    public void CompletionRejectsGrantMissingExecutionBindingWithoutChangingRunningNodeOrJournal()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        string journalBeforeCompletion = store.Value!;

        HostAdmissionGrant forgedGrant = grant with { ExecutionBinding = null };
        BodyProgramControllerResult<BodyProgramTerminalResult> result = authority.TryComplete(
            forgedGrant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Succeeded, new[] { Fact(grant) }, "receipt", "evidence", "postcondition"));

        result.Code.Should().Be(BodyProgramControllerResultCode.ExecutionBindingMismatch);
        authority.Status("program").Snapshot!.Nodes.Single().State.Should().Be(BodyProgramNodeState.Running);
        store.Value.Should().Be(journalBeforeCompletion);
    }

    [Fact]
    public void CompletionRejectsGrantWithAlteredExecutionBindingWithoutChangingRunningNodeOrJournal()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        string journalBeforeCompletion = store.Value!;

        NodeExecutionBinding altered = new(grant.ProgramId, grant.NodeId, grant.NodeAttempt, "altered-request", "altered-idempotency", "altered-execution");
        HostAdmissionGrant forgedGrant = grant with { ExecutionBinding = altered };
        BodyProgramControllerResult<BodyProgramTerminalResult> result = authority.TryComplete(
            forgedGrant, new BodyProgramTerminalResult(altered, BodyProgramNodeOutcome.Succeeded, new[] { Fact(grant) }, "receipt", "evidence", "postcondition"));

        result.Code.Should().Be(BodyProgramControllerResultCode.ExecutionBindingMismatch);
        authority.Status("program").Snapshot!.Nodes.Single().State.Should().Be(BodyProgramNodeState.Running);
        store.Value.Should().Be(journalBeforeCompletion);
    }

    [Fact]
    public void SuccessRequiresNonemptyEvidenceReceiptAndPostconditionVerification()
    {
        var authority = Open();
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        RuntimeFact fact = Fact(grant);
        authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Succeeded, new[] { fact }, null, "evidence", "postcondition")).Code.Should().Be(BodyProgramControllerResultCode.TerminalProofMissing);
        authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Succeeded, new[] { fact }, "receipt", null, "postcondition")).Code.Should().Be(BodyProgramControllerResultCode.TerminalProofMissing);
        authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Succeeded, new[] { fact }, "receipt", "evidence", null)).Code.Should().Be(BodyProgramControllerResultCode.TerminalProofMissing);
    }

    [Fact]
    public void SuccessRequiresNonemptyFactWithValidProvenance()
    {
        var authority = Open();
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(), "receipt", "evidence", "postcondition")).Code.Should().Be(BodyProgramControllerResultCode.FactProvenanceMismatch);
    }

    [Fact]
    public void SuccessRequiresAnExactDescriptorFactSetAndPersistsEveryFact()
    {
        BodyProgramActionCatalog catalog = MultiFactCatalog();
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store, catalog: catalog);
        authority.Submit(MultiFactProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();

        RuntimeFact first = new(grant.ProgramId, grant.NodeId, grant.NodeAttempt, "count", CanonicalMap("count", 7));
        RuntimeFact second = new(grant.ProgramId, grant.NodeId, grant.NodeAttempt, "ready", CanonicalBooleanMap("ready", true));
        RuntimeFact extra = new(grant.ProgramId, grant.NodeId, grant.NodeAttempt, "extra", CanonicalMap("extra", 7));
        RuntimeFact wrongKind = second with { Values = CanonicalMap("ready", 7) };
        RuntimeFact wrongAttempt = second with { NodeAttempt = grant.NodeAttempt + 1 };

        foreach (IReadOnlyList<RuntimeFact> invalid in new IReadOnlyList<RuntimeFact>[] { Array.Empty<RuntimeFact>(), new[] { first }, new[] { first, first }, new[] { first, second, extra }, new[] { first, wrongKind }, new[] { first, wrongAttempt } })
            authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Succeeded, invalid, "receipt", "evidence", "postcondition"))
                .Code.Should().Be(BodyProgramControllerResultCode.FactProvenanceMismatch);

        authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Succeeded, new[] { first, second }, "receipt", "evidence", "postcondition"))
            .IsSuccess.Should().BeTrue();
        authority.Snapshot.Programs.Single().State.Should().Be(BodyProgramState.Succeeded);
        authority.Snapshot.Programs.Single().Facts.Should().BeEquivalentTo(new[] { first, second }, options => options.WithStrictOrdering());
        Open(store, catalog: catalog).Snapshot.Programs.Single().Facts.Should().BeEquivalentTo(new[] { first, second }, options => options.WithStrictOrdering());
    }

    [Fact]
    public void SuccessWithoutDeclaredOutputFactsRequiresProofButAllowsNoFact()
    {
        var authority = Open();
        authority.Submit(NoOutputFactProgram("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();

        authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(), null, "evidence", "postcondition"))
            .Code.Should().Be(BodyProgramControllerResultCode.TerminalProofMissing);
        authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(), "receipt", "evidence", "postcondition"))
            .IsSuccess.Should().BeTrue();

        BodyProgramJournalProgram program = authority.Snapshot.Programs.Single();
        program.State.Should().Be(BodyProgramState.Succeeded);
        program.Nodes.Single().State.Should().Be(BodyProgramNodeState.Succeeded);
        program.Facts.Should().BeEmpty();
    }

    [Fact]
    public void SuccessWithoutDeclaredOutputFactsRejectsFact()
    {
        var authority = Open();
        authority.Submit(NoOutputFactProgram("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();

        authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Succeeded, new[] { Fact(grant) }, "receipt", "evidence", "postcondition"))
            .Code.Should().Be(BodyProgramControllerResultCode.FactProvenanceMismatch);
    }

    [Fact]
    public void NonSuccessOutcomeRejectsFactReceiptEvidenceAndPostcondition()
    {
        var authority = Open();
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        RuntimeFact fact = Fact(grant);
        authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Failed, new[] { fact }, null, null, null)).Code.Should().Be(BodyProgramControllerResultCode.InvalidInput);
        authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Failed, Array.Empty<RuntimeFact>(), "receipt", null, null)).Code.Should().Be(BodyProgramControllerResultCode.InvalidInput);
        authority.TryComplete(grant, new BodyProgramTerminalResult(Execution(grant), BodyProgramNodeOutcome.Cancelled, Array.Empty<RuntimeFact>(), null, "evidence", null)).Code.Should().Be(BodyProgramControllerResultCode.InvalidInput);
    }

    [Fact]
    public void UncertainOutcomeTransitionsToRecoveryRequiredWithoutFactOrProof()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program", twoNodes: true)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        NodeExecutionBinding execution = Execution(grant);
        authority.TryBeginNativeDispatch(grant, execution).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, TerminalOutcome(grant, BodyProgramNodeOutcome.Uncertain)).IsSuccess.Should().BeTrue();
        BodyProgramJournalProgram program = authority.Snapshot.Programs.Single();
        program.State.Should().Be(BodyProgramState.RecoveryRequired);
        BodyProgramJournalNode uncertain = program.Nodes.Single(node => node.NodeId == "first");
        uncertain.State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        uncertain.GrantId.Should().BeNull();
        uncertain.ExecutionBinding.Should().Be(execution);
        uncertain.CanonicalBoundArguments.Should().NotBeNull();
        uncertain.AttemptPolicyIdentity.Should().Be(Policy());
        uncertain.ClaimOwnership.Should().NotBeNull();
        uncertain.ReceiptId.Should().BeNull();
        uncertain.Evidence.Should().BeNull();
        uncertain.PostconditionVerification.Should().BeNull();
        uncertain.RecoveryDiagnostic.Should().Be("execution_uncertain");
        program.Nodes.Single(node => node.NodeId == "second").State.Should().Be(BodyProgramNodeState.Pending);
        program.Facts.Should().BeEmpty();

        OpenBodyProgramJournalAuthority reopened = Open(store);
        reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
        BodyProgramJournalNode persisted = reopened.Snapshot.Programs.Single().Nodes.Single(node => node.NodeId == "first");
        persisted.ExecutionBinding.Should().Be(execution);
        persisted.CanonicalBoundArguments.Should().BeEquivalentTo(uncertain.CanonicalBoundArguments);
        persisted.AttemptPolicyIdentity.Should().Be(Policy());
        persisted.ClaimOwnership.Should().BeEquivalentTo(uncertain.ClaimOwnership);
    }

      [Fact]
      public void ReopenRejectsRecoveryRequiredNodeWithZeroAttempt()
      {
          var store = new MemoryStore();
          string valid = PersistRecoveryRequiredState(store);

          OpenBodyProgramJournalAuthority reopened = Open(store);
          reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
          BodyProgramJournalPersistence.TryValidate(reopened.Snapshot, out string? reason).Should().BeTrue(reason);

          store.Set(MutatePersistedNode(valid, node => node["nodeAttempt"] = 0));

          Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
      }

      [Theory]
      [InlineData("receiptId")]
      [InlineData("evidence")]
      [InlineData("postconditionVerification")]
      [InlineData("grantId")]
      public void ReopenRejectsRecoveryRequiredNodeWithTerminalProofOrGrant(string propertyName)
      {
          var store = new MemoryStore();
          string valid = PersistRecoveryRequiredState(store);
          Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);

          store.Set(MutatePersistedNode(valid, node => node[propertyName] = "forged"));

          Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
      }

      [Theory]
      [InlineData(BodyProgramNodeState.HostAdmitted)]
      [InlineData(BodyProgramNodeState.Running)]
      public void ReopenRejectsRecoveryRequiredProgramWithExecutableNodeResidue(BodyProgramNodeState executableState)
      {
          var store = new MemoryStore();
          string valid = PersistRecoveryRequiredState(store);
          Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);

          store.Set(MutatePersistedNode(valid, node =>
          {
              node["state"] = (int)executableState;
              node["grantId"] = "grant";
              node["recoveryDiagnostic"] = null;
          }));

          Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
      }

      [Fact]
      public void FailedTerminalPreservesExecutionLineageAfterReopen()
     {
         var store = new MemoryStore();
         OpenBodyProgramJournalAuthority authority = Open(store);
         authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
         NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
         HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
         NodeExecutionBinding execution = Execution(grant);
         authority.TryBeginNativeDispatch(grant, execution).IsSuccess.Should().BeTrue();

         authority.TryComplete(grant, TerminalOutcome(grant, BodyProgramNodeOutcome.Failed)).IsSuccess.Should().BeTrue();

         BodyProgramJournalNode failed = authority.Snapshot.Programs.Single().Nodes.Single();
         failed.State.Should().Be(BodyProgramNodeState.Failed);
         failed.NodeAttempt.Should().Be(1);
         failed.GrantId.Should().BeNull();
         failed.ExecutionBinding.Should().Be(execution);
         failed.ReceiptId.Should().BeNull();
         failed.Evidence.Should().BeNull();
         failed.PostconditionVerification.Should().BeNull();
         OpenBodyProgramJournalAuthority reopened = Open(store);
         reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Opened);
         reopened.Snapshot.Programs.Single().Nodes.Single().ExecutionBinding.Should().Be(execution);
     }

     [Fact]
     public void CancelledBoundTerminalPreservesExecutionLineageAfterReopen()
     {
         var store = new MemoryStore();
         OpenBodyProgramJournalAuthority authority = Open(store);
         authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
         NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
         HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
         NodeExecutionBinding execution = Execution(grant);
         authority.TryBeginNativeDispatch(grant, execution).IsSuccess.Should().BeTrue();

         authority.TryComplete(grant, TerminalOutcome(grant, BodyProgramNodeOutcome.Cancelled)).IsSuccess.Should().BeTrue();

         BodyProgramJournalNode cancelled = authority.Snapshot.Programs.Single().Nodes.Single();
         cancelled.State.Should().Be(BodyProgramNodeState.Cancelled);
         cancelled.GrantId.Should().BeNull();
         cancelled.ExecutionBinding.Should().Be(execution);
         OpenBodyProgramJournalAuthority reopened = Open(store);
         reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Opened);
         reopened.Snapshot.Programs.Single().Nodes.Single().ExecutionBinding.Should().Be(execution);
     }

     [Fact]
     public void PreAdmissionCancellationRemainsUnboundAndPreservesAttemptProjection()
     {
         var store = new MemoryStore();
         OpenBodyProgramJournalAuthority authority = Open(store);
         authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
         authority.TryCreateAdmissionChallenge("program").IsSuccess.Should().BeTrue();

         authority.TryStop("program", 1).IsSuccess.Should().BeTrue();

         BodyProgramJournalNode cancelled = authority.Snapshot.Programs.Single().Nodes.Single();
         cancelled.State.Should().Be(BodyProgramNodeState.Cancelled);
         cancelled.NodeAttempt.Should().Be(1);
         cancelled.GrantId.Should().BeNull();
         cancelled.ExecutionBinding.Should().BeNull();
         cancelled.CanonicalBoundArguments.Should().NotBeNull();
         OpenBodyProgramJournalAuthority reopened = Open(store);
         reopened.Snapshot.Programs.Single().Nodes.Single().ExecutionBinding.Should().BeNull();
     }

     [Fact]
     public void UnboundAwaitingAdmissionIsQuarantinedWithoutFabricatedExecutionLineage()
     {
         var store = new MemoryStore();
         OpenBodyProgramJournalAuthority authority = Open(store);
         authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
         authority.TryCreateAdmissionChallenge("program").IsSuccess.Should().BeTrue();

         OpenBodyProgramJournalAuthority reopened = Open(store);

         reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
         BodyProgramJournalProgram program = reopened.Snapshot.Programs.Single();
         program.State.Should().Be(BodyProgramState.RecoveryRequired);
         BodyProgramJournalNode node = program.Nodes.Single();
         node.State.Should().Be(BodyProgramNodeState.RecoveryRequired);
         node.NodeAttempt.Should().Be(1);
         node.GrantId.Should().BeNull();
         node.ExecutionBinding.Should().BeNull();
         node.RecoveryDiagnostic.Should().Be("recovery_required");
         BodyProgramJournalPersistence.TryValidate(reopened.Snapshot, out string? reason).Should().BeTrue(reason);
         reopened.TryCreateAdmissionChallenge("program").Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
     }

     [Fact]
     public void ReopenRejectsTerminalBindingWithCrossAttemptOrCrossProgramLineage()
     {
         var store = new MemoryStore();
         OpenBodyProgramJournalAuthority authority = Open(store);
         authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
         NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
         HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
         authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
         authority.TryComplete(grant, TerminalOutcome(grant, BodyProgramNodeOutcome.Failed)).IsSuccess.Should().BeTrue();
         string valid = store.Value!;

         store.Set(valid.Replace("\"executionBinding\":{\"programId\":\"program\",\"nodeId\":\"first\",\"nodeAttempt\":1", "\"executionBinding\":{\"programId\":\"other\",\"nodeId\":\"first\",\"nodeAttempt\":1", StringComparison.Ordinal));
         Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);

         store.Set(valid.Replace("\"executionBinding\":{\"programId\":\"program\",\"nodeId\":\"first\",\"nodeAttempt\":1", "\"executionBinding\":{\"programId\":\"program\",\"nodeId\":\"first\",\"nodeAttempt\":2", StringComparison.Ordinal));
         Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
     }

     [Fact]
      public void ReopenRejectsSucceededTerminalBindingWithCrossAttemptOrCrossProgramLineage()
      {
          var store = new MemoryStore();
          OpenBodyProgramJournalAuthority authority = Open(store);
          authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
          NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
          HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
          NodeExecutionBinding execution = Execution(grant);
          authority.TryBeginNativeDispatch(grant, execution).IsSuccess.Should().BeTrue();
          authority.TryComplete(grant, TerminalSuccess(grant, Fact(grant))).IsSuccess.Should().BeTrue();

          authority.Snapshot.Programs.Single().State.Should().Be(BodyProgramState.Succeeded);
          authority.Snapshot.Programs.Single().Nodes.Single().State.Should().Be(BodyProgramNodeState.Succeeded);
          Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Opened);
          string valid = store.Value!;

          store.Set(MutatePersistedNode(valid, node => node["executionBinding"]!.AsObject()["programId"] = "other"));
          Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);

          store.Set(MutatePersistedNode(valid, node => node["executionBinding"]!.AsObject()["nodeAttempt"] = 2));
          Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
      }

       [Fact]
       public void ReopenRejectsPersistedActiveProgramWithOnlySucceededNodes()
       {
           var store = new MemoryStore();
           OpenBodyProgramJournalAuthority authority = Open(store);
           authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
           NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
           HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
           authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
           authority.TryComplete(grant, TerminalSuccess(grant, Fact(grant))).IsSuccess.Should().BeTrue();

           BodyProgramJournalProgram persistedProgram = authority.Snapshot.Programs.Single();
           persistedProgram.State.Should().Be(BodyProgramState.Succeeded);
           persistedProgram.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Succeeded);
           string valid = store.Value!;
           JsonObject root = JsonNode.Parse(valid)?.AsObject() ?? throw new InvalidOperationException("Persisted journal root is not an object.");
           JsonArray programs = root["programs"]?.AsArray() ?? throw new InvalidOperationException("Persisted journal has no programs.");
           JsonObject program = programs[0]?.AsObject() ?? throw new InvalidOperationException("Persisted journal has no program object.");
           program["state"] = (int)BodyProgramState.Active;
           store.Set(root.ToJsonString());

           Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
       }

       [Fact]
       public void StopAfterNativeDispatchCancelsNodeAndPreservesExecutionBinding()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        NodeExecutionBinding execution = Execution(grant);
        authority.TryBeginNativeDispatch(grant, execution).IsSuccess.Should().BeTrue();

        BodyProgramControllerResult<BodyProgramStatusSnapshot> stopped = authority.TryStop("program", 1);

        stopped.IsSuccess.Should().BeTrue();
        stopped.Code.Should().Be(BodyProgramControllerResultCode.Succeeded);
        stopped.Value!.State.Should().Be(BodyProgramState.Cancelled);
         stopped.Value.Nodes.Single().State.Should().Be(BodyProgramNodeState.Cancelled);
         stopped.Value.Nodes.Single().ExecutionBinding.Should().Be(execution);
         BodyProgramJournalNode persisted = Open(store).Snapshot.Programs.Single().Nodes.Single();
         persisted.State.Should().Be(BodyProgramNodeState.Cancelled);
         persisted.ExecutionBinding.Should().Be(execution);
        authority.OpenStatus.Should().NotBe(BodyProgramJournalOpenStatus.PersistenceWriteFailed);
    }

    [Fact]
    public void RestartFencePreservesExecutionLineageAndFencesPendingSuccessor()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program", twoNodes: true)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        NodeExecutionBinding execution = Execution(grant);
        authority.TryBeginNativeDispatch(grant, execution).IsSuccess.Should().BeTrue();
        BodyProgramJournalNode beforeRestart = authority.Snapshot.Programs.Single().Nodes.Single(node => node.NodeId == "first");

        OpenBodyProgramJournalAuthority reopened = Open(store);

        reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
        BodyProgramJournalProgram program = reopened.Snapshot.Programs.Single();
        BodyProgramJournalNode running = program.Nodes.Single(node => node.NodeId == "first");
        running.State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        running.GrantId.Should().BeNull();
        running.ExecutionBinding.Should().Be(execution);
        running.CanonicalBoundArguments.Should().BeEquivalentTo(beforeRestart.CanonicalBoundArguments);
        running.AttemptPolicyIdentity.Should().Be(beforeRestart.AttemptPolicyIdentity);
        running.ClaimOwnership.Should().NotBeNull();
        running.ClaimOwnership!.Values.Should().AllBeEquivalentTo(BodyProgramClaimOwnershipState.Released,
            "a restart fence durably releases every claim the interrupted attempt held (acquire→release transition)");
        beforeRestart.ClaimOwnership!.Values.Should().AllBeEquivalentTo(BodyProgramClaimOwnershipState.Acquired,
            "the running attempt held the claims before the restart fence");
        running.RecoveryDiagnostic.Should().Be("recovery_required");
         BodyProgramJournalNode pending = program.Nodes.Single(node => node.NodeId == "second");
         pending.State.Should().Be(BodyProgramNodeState.Pending);
         pending.NodeAttempt.Should().Be(0);
         pending.GrantId.Should().BeNull();
         pending.ExecutionBinding.Should().BeNull();
         pending.RecoveryDiagnostic.Should().BeNull();

        reopened.TryCreateAdmissionChallenge("program").Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
        reopened.TryConsumeHostGrant(grant).Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
        reopened.TryBeginNativeDispatch(grant, execution).Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
    }
    [Fact]
    public void SuccessorChallengeMaterializesDeclaredBindingFromExactProducingAttempt()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        authority.Submit(Program("program", twoNodes: true)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge first = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(first);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, TerminalSuccess(grant, Fact(grant))).IsSuccess.Should().BeTrue();

        NodeAdmissionChallenge second = authority.TryCreateAdmissionChallenge("program").Value!;

        second.NodeId.Should().Be("second");
        // tile is bound to first.arrival; the challenge must carry the producing
        // attempt's persisted fact value (7), never the candidate literal (8).
        second.CanonicalArguments["tile"].CanonicalValue.Should().Be("7");
    }

    [Fact]
    public void ExactAdmissionRejectionPersistsCodeCascadesPendingDescendantsAndIsIdempotent()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program", twoNodes: true)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;

        authority.TryRejectAdmission(challenge, "policy_denied").IsSuccess.Should().BeTrue();

        BodyProgramJournalProgram rejected = authority.Snapshot.Programs.Single();
        rejected.State.Should().Be(BodyProgramState.Failed);
        BodyProgramJournalNode first = rejected.Nodes.Single(node => node.NodeId == "first");
        first.State.Should().Be(BodyProgramNodeState.Rejected);
        first.RejectionCode.Should().Be("policy_denied");
        first.RecoveryDiagnostic.Should().BeNull();
        first.GrantId.Should().BeNull();
        first.ExecutionBinding.Should().BeNull();
        first.ReceiptId.Should().BeNull();
        first.Evidence.Should().BeNull();
        first.PostconditionVerification.Should().BeNull();
        BodyProgramJournalNode second = rejected.Nodes.Single(node => node.NodeId == "second");
        second.State.Should().Be(BodyProgramNodeState.SkippedDependency);
        second.NodeAttempt.Should().Be(0);
        second.AdmissionAttempt.Should().Be(0);
        second.CanonicalBoundArguments.Should().BeNull();
        second.AttemptPolicyIdentity.Should().BeNull();
        second.ClaimOwnership.Should().BeNull();
        second.RejectionCode.Should().BeNull();
        authority.Events("program", 0, 32).Events.Should().ContainSingle(@event => @event.Kind == "admission_rejected")
            .Which.NodeAttempt.Should().Be(1);
        authority.Events("program", 0, 32).Events.Should().ContainSingle(@event => @event.Kind == "node_skipped")
            .Which.NodeAttempt.Should().Be(0);
        int eventCount = authority.Snapshot.Events.Count;

        authority.TryRejectAdmission(challenge, "policy_denied").IsSuccess.Should().BeTrue();
        authority.Snapshot.Events.Should().HaveCount(eventCount);
        authority.TryRejectAdmission(challenge, "deadline_expired").Code.Should().Be(BodyProgramControllerResultCode.InvalidInput);
        authority.TryRejectAdmission(challenge with { StopEpoch = challenge.StopEpoch + 1 }, "policy_denied")
            .Code.Should().Be(BodyProgramControllerResultCode.InvalidInput);
        authority.Snapshot.Events.Should().HaveCount(eventCount);

        OpenBodyProgramJournalAuthority reopened = Open(store);
        reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Opened);
        reopened.Snapshot.Programs.Single().Nodes.Single(node => node.NodeId == "first").RejectionCode.Should().Be("policy_denied");
        reopened.Snapshot.Programs.Single().Nodes.Single(node => node.NodeId == "second").State.Should().Be(BodyProgramNodeState.SkippedDependency);
    }

    [Fact]
    public void RejectionCodeMustBeAllowlistedAndStrictlyLowerSnakeCase()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;

        foreach (string code in new[] { "POLICY_DENIED", "policy-denied", "policy_denied_extra", " policy_denied", "policy_denied " })
            authority.TryRejectAdmission(challenge, code).Code.Should().Be(BodyProgramControllerResultCode.InvalidInput);

        authority.Snapshot.Programs.Single().Nodes.Single().State.Should().Be(BodyProgramNodeState.AwaitingHostAdmission);
        authority.Snapshot.Events.Should().ContainSingle(@event => @event.Kind == "admission_challenge");
    }

    [Fact]
     public void SuccessorGrantMustEchoMaterializedArgumentsBeforeConsumeDispatchAndComplete()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        authority.Submit(Program("program", twoNodes: true)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge first = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(first);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, TerminalSuccess(grant, Fact(grant))).IsSuccess.Should().BeTrue();
        NodeAdmissionChallenge second = authority.TryCreateAdmissionChallenge("program").Value!;

        HostAdmissionGrant forged = Grant(second) with { CanonicalArguments = CanonicalMap("tile", 8) };
        authority.TryConsumeHostGrant(forged).Code.Should().Be(BodyProgramControllerResultCode.GrantMismatch);

        HostAdmissionGrant real = authority.TryConsumeHostGrant(Grant(second)).Value!;
        real.CanonicalArguments["tile"].CanonicalValue.Should().Be("7");
        authority.TryBeginNativeDispatch(real, Execution(real)).IsSuccess.Should().BeTrue();
        authority.TryComplete(real, new BodyProgramTerminalResult(Execution(real), BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(), "receipt-2", "evidence-2", "postcondition-2")).IsSuccess.Should().BeTrue();

        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        status.State.Should().Be(BodyProgramState.Succeeded);
        status.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Succeeded);
        BodyProgramEventsResult events = authority.Events("program", 0, 32);
        events.Events.Select(@event => @event.NodeId).Where(node => node is not null).Distinct().Should().BeEquivalentTo(new[] { "first", "second" }, options => options.WithStrictOrdering());
        events.Events.Should().Contain(@event => @event.Kind == "admission_challenge" && @event.NodeId == "second" && @event.NodeAttempt == 1);
    }

        [Fact]
    public void ReopenRejectsAdmissionRejectionEventWithTamperedNodeState()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        authority.TryRejectAdmission(challenge, "policy_denied").IsSuccess.Should().BeTrue();

        JsonObject root = JsonNode.Parse(store.Value!)!.AsObject();
        root["programs"]!.AsArray()[0]!.AsObject()["state"] = (int)BodyProgramState.Failed;
        root["programs"]!.AsArray()[0]!.AsObject()["nodes"]!.AsArray()[0]!.AsObject()["state"] = (int)BodyProgramNodeState.Failed;
        store.Set(root.ToJsonString());

        Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
    }

    [Fact]
    public void ReopenRejectsAdmissionRejectionEventWithWrongExactAttempt()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        authority.TryRejectAdmission(challenge, "policy_denied").IsSuccess.Should().BeTrue();
        JsonObject root = JsonNode.Parse(store.Value!)!.AsObject();
        JsonObject rejection = root["events"]!.AsArray().Single(item => item!.AsObject()["kind"]!.GetValue<string>() == "admission_rejected")!.AsObject();
        rejection["nodeAttempt"] = 2;
        store.Set(root.ToJsonString());

        Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
    }

    [Fact]
    public void ReopenRejectsPersistedSuccessorFactWithWrongProducingAttemptOrProgram()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.Submit(Program("program", twoNodes: true)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge first = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(first);
        grant = authority.TryConsumeHostGrant(grant).Value!;
        authority.TryBeginNativeDispatch(grant, Execution(grant)).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, TerminalSuccess(grant, Fact(grant))).IsSuccess.Should().BeTrue();
        string valid = store.Value!;

        store.Set(valid.Replace("\"nodeAttempt\":1,\"factName\":\"arrival\"", "\"nodeAttempt\":2,\"factName\":\"arrival\"", StringComparison.Ordinal));
        Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);

        store.Set(valid.Replace("\"programId\":\"program\",\"nodeId\":\"first\",\"nodeAttempt\":1,\"factName\":\"arrival\"", "\"programId\":\"other\",\"nodeId\":\"first\",\"nodeAttempt\":1,\"factName\":\"arrival\"", StringComparison.Ordinal));
        Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
    }

     private static string PersistRecoveryRequiredState(MemoryStore store)
     {
         OpenBodyProgramJournalAuthority authority = Open(store);
         authority.Submit(Program("program")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
         NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
         HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
         NodeExecutionBinding execution = Execution(grant);
         authority.TryBeginNativeDispatch(grant, execution).IsSuccess.Should().BeTrue();
         authority.TryComplete(grant, TerminalOutcome(grant, BodyProgramNodeOutcome.Uncertain)).IsSuccess.Should().BeTrue();
         return store.Value!;
     }

     private static string MutatePersistedNode(string encoded, Action<JsonObject> mutate)
     {
         JsonObject root = JsonNode.Parse(encoded)?.AsObject() ?? throw new InvalidOperationException("Persisted journal root is not an object.");
         JsonArray programs = root["programs"]?.AsArray() ?? throw new InvalidOperationException("Persisted journal has no programs.");
         JsonObject program = programs[0]?.AsObject() ?? throw new InvalidOperationException("Persisted journal has no program object.");
         JsonArray nodes = program["nodes"]?.AsArray() ?? throw new InvalidOperationException("Persisted journal has no nodes.");
         JsonObject node = nodes[0]?.AsObject() ?? throw new InvalidOperationException("Persisted journal has no node object.");
         mutate(node);
         return root.ToJsonString();
     }

     private static BodyProgramActionCatalog ArrivalCatalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("move_to_tile", 1, new[] { new BodyProgramArgumentDescriptor("tile", BodyProgramArgumentKind.Integer) }, new[] { new BodyProgramFactDescriptor("arrival", BodyProgramArgumentKind.DestinationArrival) }, new[] { new BodyProgramResourceTemplateClaim("actor", BodyProgramResourceTemplateValue.ScopePlayer) }),
    });
    private static ActionProgramCandidate ArrivalProgram() => new("program", new[]
    {
        new ActionProgramCandidateNode("first", "move_to_tile", RuntimeMap("tile", 7), Array.Empty<string>(), Bindings()),
    });
    private static RuntimeFact ArrivalFact(HostAdmissionGrant grant) => new(grant.ProgramId, grant.NodeId, grant.NodeAttempt, "arrival", new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
    {
        ["arrival"] = new(BodyProgramArgumentKind.DestinationArrival, null, null, new BodyProgramDestinationArrival("destination_arrived", new BodyProgramArrivalDestination("Town", null))),
    });
    private static OpenBodyProgramJournalAuthority Open(MemoryStore? store = null, BodyProgramActionCatalog? catalog = null, Func<BodyProgramPolicyIdentity>? policy = null, Func<long>? now = null) =>
        OpenBodyProgramJournalAuthority.Open(store ?? new MemoryStore(), catalog ?? Catalog(), Scope(), policy ?? (() => Policy()), now ?? (() => 10));
    private static NodeExecutionBinding Execution(HostAdmissionGrant grant) => grant.ExecutionBinding!;
    private static BodyProgramTerminalResult TerminalSuccess(HostAdmissionGrant grant, RuntimeFact fact) => new(Execution(grant), BodyProgramNodeOutcome.Succeeded, new[] { fact }, "receipt-1", "evidence-1", "postcondition-1");
    private static BodyProgramTerminalResult TerminalOutcome(HostAdmissionGrant grant, BodyProgramNodeOutcome outcome) => new(Execution(grant), outcome, Array.Empty<RuntimeFact>(), null, null, null);
    private static BodyProgramTerminalResult TerminalWithFact(HostAdmissionGrant grant, BodyProgramNodeOutcome outcome, RuntimeFact fact) => new(Execution(grant), outcome, new[] { fact }, null, null, null);
    private static BodyProgramActionCatalog MultiFactCatalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("measure", 1, new[] { new BodyProgramArgumentDescriptor("tile", BodyProgramArgumentKind.Integer) }, new[] { new BodyProgramFactDescriptor("count", BodyProgramArgumentKind.Integer), new BodyProgramFactDescriptor("ready", BodyProgramArgumentKind.Boolean) }, new[] { new BodyProgramResourceTemplateClaim("actor", BodyProgramResourceTemplateValue.ScopePlayer) }),
    });
    private static ActionProgramCandidate MultiFactProgram() => new("program", new[]
    {
        new ActionProgramCandidateNode("first", "measure", RuntimeMap("tile", 7), Array.Empty<string>(), Bindings()),
    });
    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("move_to_tile", 1, new[] { new BodyProgramArgumentDescriptor("tile", BodyProgramArgumentKind.Integer) }, new[] { new BodyProgramFactDescriptor("arrival", BodyProgramArgumentKind.Integer) }, new[] { new BodyProgramResourceTemplateClaim("actor", BodyProgramResourceTemplateValue.ScopePlayer) }),
        new BodyProgramActionDescriptor("till_soil", 1, new[] { new BodyProgramArgumentDescriptor("tile", BodyProgramArgumentKind.Integer) }, Array.Empty<BodyProgramFactDescriptor>(), new[] { new BodyProgramResourceTemplateClaim("actor", BodyProgramResourceTemplateValue.ScopePlayer) }),
    });
    private static ActionProgramCandidate OrderedConflictingProgram() => new("program", new[]
    {
        new ActionProgramCandidateNode("first", "move_to_tile", RuntimeMap("tile", 7), Array.Empty<string>(), Bindings()),
        new ActionProgramCandidateNode("second", "till_soil", RuntimeMap("tile", 8), new[] { "first" }, Bindings()),
    });
    private static ActionProgramCandidate Program(string programId, bool twoNodes = false)
    {
        ActionProgramCandidateNode first = new("first", "move_to_tile", RuntimeMap("tile", 7), Array.Empty<string>(), Bindings());
        return twoNodes ? new(programId, new[] { first, new ActionProgramCandidateNode("second", "till_soil", RuntimeMap("tile", 8), new[] { "first" }, Bindings("tile", new ActionProgramBinding("first", "arrival"))) }) : new(programId, new[] { first });
    }
    private static ActionProgramCandidate NoOutputFactProgram(string programId) => new(programId, new[]
    {
        new ActionProgramCandidateNode("first", "till_soil", RuntimeMap("tile", 8), Array.Empty<string>(), Bindings()),
    });
    private static HostAdmissionGrant Grant(NodeAdmissionChallenge challenge) => new(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt, challenge.StopEpoch, challenge.CatalogRevision, challenge.PolicyIdentity, challenge.ActionId, challenge.CanonicalArguments, challenge.DerivedResourceClaims, challenge.DeadlineMs, "grant", "attachment_01", "host-policy_01");
    private static RuntimeFact Fact(HostAdmissionGrant grant) => new(grant.ProgramId, grant.NodeId, grant.NodeAttempt, "arrival", CanonicalMap("arrival", 7));
    private static BodyProgramPolicyIdentity Policy(string value = "policy-a", long revision = 1) => new(value, revision);
    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");
    private static IReadOnlyDictionary<string, ActionProgramBinding> Bindings(params object[] values) => values.Chunk(2).ToDictionary(pair => (string)pair[0], pair => (ActionProgramBinding)pair[1], StringComparer.Ordinal);
    private static IReadOnlyDictionary<string, BodyProgramRuntimeValue> RuntimeMap(string key, long value) => new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal) { [key] = new("integer", value.ToString(System.Globalization.CultureInfo.InvariantCulture)) };
    private static IReadOnlyDictionary<string, BodyProgramCanonicalValue> CanonicalMap(string key, long value) => new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal) { [key] = new(BodyProgramArgumentKind.Integer, value.ToString(System.Globalization.CultureInfo.InvariantCulture)) };
    private static IReadOnlyDictionary<string, BodyProgramCanonicalValue> CanonicalBooleanMap(string key, bool value) => new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal) { [key] = new(BodyProgramArgumentKind.Boolean, value ? "true" : "false") };
    private static IReadOnlyDictionary<string, string> Claims(string key, string value) => new Dictionary<string, string>(StringComparer.Ordinal) { [key] = value };
     private sealed class MemoryStore : IBodyProgramJournalStore
     {
         internal string? Value { get; private set; }
         internal BodyProgramJournalReadResult? ReadResult { get; set; }
         internal int WriteCount { get; private set; }
         public BodyProgramJournalReadResult Read() => this.ReadResult ?? (this.Value is null
             ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
             : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.Value));
         public bool TryWrite(string encodedState) { this.WriteCount++; this.Value = encodedState; return true; }
         internal void Set(string value) { this.ReadResult = null; this.Value = value; }
     }
}
