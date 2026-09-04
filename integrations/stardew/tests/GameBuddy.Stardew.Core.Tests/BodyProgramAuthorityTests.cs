using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class BodyProgramAuthorityTests
{
    [Fact]
    public void CodecMatchesFrozenHostCandidateShapeAndDecodesTypedArguments()
    {
        const string json = "{\"programId\":\"program\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"move_to_tile\",\"arguments\":{\"tile\":{\"type\":\"integer\",\"canonicalValue\":\"7\"}},\"dependsOn\":[],\"bindings\":{},\"deadlineMs\":1000}]}";
        ActionProgramCandidateCodec.TryDecode(json, out ActionProgramCandidate? candidate, out _).Should().BeTrue();
        candidate!.Nodes.Single().DeadlineMs.Should().Be(1000);
        Open().Verify(candidate).Accepted.Should().BeTrue();
        ActionProgramCandidateCodec.TryDecode(json.Replace("\"7\"", "\"07\"", StringComparison.Ordinal), out _, out _).Should().BeTrue();
        ActionProgramCandidateCodec.TryDecode(json.Replace("\"7\"", "\"07\"", StringComparison.Ordinal), out ActionProgramCandidate? invalid, out _).Should().BeTrue();
        Open().Verify(invalid!).Accepted.Should().BeFalse();
        ActionProgramCandidateCodec.TryDecode(json.Replace("\"nodes\"", "\"deadlineMs\":1000,\"nodes\"", StringComparison.Ordinal), out _, out _).Should().BeFalse();
        ActionProgramCandidateCodec.TryDecode(json.Replace("\"deadlineMs\":1000", "", StringComparison.Ordinal).Replace(",}", "}", StringComparison.Ordinal), out _, out _).Should().BeFalse();
    }

    [Fact]
    public void CandidateCodecRoundTripsNonEmptyBindingUsingCanonicalCamelCaseKeys()
    {
        ActionProgramCandidate source = Program("program", 1000, twoNodes: true);
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
        const string json = "{\"programId\":\"program\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"navigate\",\"arguments\":{\"destination\":{\"type\":\"destination_selector\",\"destination\":{\"kind\":\"label\",\"label\":\"Town\"}}},\"dependsOn\":[],\"bindings\":{},\"deadlineMs\":1000}]}";
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
        authority.TryConsumeHostGrant(grant).IsSuccess.Should().BeTrue();
        authority.TryBeginNativeDispatch(grant).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, ArrivalFact(grant), BodyProgramNodeOutcome.Succeeded).IsSuccess.Should().BeTrue();

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
        authority.TryConsumeHostGrant(grant).IsSuccess.Should().BeTrue();
        authority.TryBeginNativeDispatch(grant).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, ArrivalFact(grant), BodyProgramNodeOutcome.Succeeded).IsSuccess.Should().BeTrue();
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
        string json = $"{{\"programId\":\"program\",\"nodes\":[{{\"nodeId\":\"first\",\"actionId\":\"navigate\",\"arguments\":{{\"destination\":{{\"type\":\"destination_selector\",\"destination\":{{\"kind\":\"ref\",\"ref\":\"{reference}\"}}}}}},\"dependsOn\":[],\"bindings\":{{}},\"deadlineMs\":1000}}]}}";
        ActionProgramCandidateCodec.TryDecode(json, out ActionProgramCandidate? candidate, out _).Should().BeTrue();
        candidate!.Nodes.Single().Arguments["destination"].Destination!.Ref.Should().Be(reference);
        ActionProgramCandidateCodec.TryDecode(json.Replace("\"ref\":\"" + reference, "\"ref\":\"" + reference + "\",\"extra\":null", StringComparison.Ordinal), out _, out _).Should().BeFalse();
    }

    [Fact]
    public void VerifyIsPureWhileSubmitDurablyAcceptsAndIsIdempotent()
    {
        var store = new MemoryStore(); var authority = Open(store); ActionProgramCandidate candidate = Program("program", 1000);
        authority.Verify(candidate).Accepted.Should().BeTrue(); store.Value.Should().BeNull();
        authority.Submit(candidate).Code.Should().Be(BodyProgramSubmitCode.Accepted); store.Value.Should().NotBeNull();
        authority.Submit(candidate).Code.Should().Be(BodyProgramSubmitCode.Idempotent);
        authority.Submit(Program("program", 2000)).Code.Should().Be(BodyProgramSubmitCode.Conflict);
    }

    [Fact]
    public void SubmitRejectsChangedPolicyIdentityWithoutChangingDurableState()
    {
        BodyProgramPolicyIdentity policy = Policy("policy-a", 2);
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store, policy: () => policy);
        authority.Submit(Program("accepted", 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        string persistedPolicy = store.Value!;

        policy = Policy("policy-b", 2);
        BodyProgramSubmitResult stale = authority.Submit(Program("stale", 1000));

        stale.Code.Should().Be(BodyProgramSubmitCode.Rejected);
        stale.Verification.Diagnostics.Should().ContainSingle(diagnostic => diagnostic.Code == "policy_identity_stale");
        store.Value.Should().Be(persistedPolicy);
        authority.Snapshot.PolicyIdentity.Should().Be(Policy("policy-a", 2));
        authority.Status("stale").Code.Should().Be(BodyProgramQueryCode.NotFound);
    }

    [Fact]
    public void PolicyIdentityRequiresExactValueAndRevisionAndRejectsAbaReuse()
    {
        BodyProgramPolicyIdentity policy = Policy("policy-a", 1);
        var authority = Open(policy: () => policy);
        authority.Submit(Program("program", 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
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
        authority.Submit(Program("program", 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        string persisted = store.Value!;
        store.Set(persisted.Replace("\"value\":\"policy-a\",\"capabilityRevision\":1", "\"embodimentId\":\"policy-a\",\"generation\":1", StringComparison.Ordinal));
        Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);

        Action malformed = () => Open(policy: () => new BodyProgramPolicyIdentity("", 1));
        malformed.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void StatusAndEventsCarryHostAddressedCatalogProjection()
    {
        var authority = Open(); authority.Submit(Program("program", 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
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
        authority.Submit(Program("program", 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        long highWater = authority.Status("program").Snapshot!.EventHighWater;

        BodyProgramEventsResult page = authority.Events("program", highWater + 1, 1);
        BridgeBodyProgramEventsResult projected = BridgeProtocol.ProjectBodyProgramEventsResult(page);

        page.Code.Should().Be(BodyProgramQueryCode.Found);
        page.Events.Should().BeEmpty();
        page.NextCursor.Should().Be(highWater + 1);
        BridgeProtocol.TrySerialize(projected, out _, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");
    }

    [Fact]
    public void DispatchAndCompletionRejectModifiedGrantDeadlineStopCatalogArgsResourcesAndPolicyAba()
    {
        BodyProgramPolicyIdentity policy = Policy(); long now = 10; var authority = Open(policy: () => policy, now: () => now);
        authority.Submit(Program("program", 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!; HostAdmissionGrant grant = Grant(challenge);
        authority.TryConsumeHostGrant(grant).IsSuccess.Should().BeTrue();
        authority.TryBeginNativeDispatch(grant with { GrantId = "forged" }).Code.Should().Be(BodyProgramControllerResultCode.GrantMismatch);
        authority.TryBeginNativeDispatch(grant with { DeadlineMs = 999 }).Code.Should().Be(BodyProgramControllerResultCode.GrantMismatch);
        authority.TryBeginNativeDispatch(grant with { CanonicalArguments = CanonicalMap("tile", 8) }).Code.Should().Be(BodyProgramControllerResultCode.GrantMismatch);
        authority.TryBeginNativeDispatch(grant with { DerivedResourceClaims = Claims("actor", "other") }).Code.Should().Be(BodyProgramControllerResultCode.GrantMismatch);
        policy = Policy("policy-b", 1); authority.TryBeginNativeDispatch(grant).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);
        policy = Policy("policy-a", 2); authority.TryBeginNativeDispatch(grant).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);
        now = 1001; authority.TryBeginNativeDispatch(grant).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);
    }

    [Fact]
    public void CompleteRejectsUndefinedOutcomeWithoutChangingRunningNodeOrJournal()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        var controller = new FarmhandBodyProgramController(authority);
        authority.Submit(Program("program", 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = controller.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        controller.TryConsumeHostGrant(grant).IsSuccess.Should().BeTrue();
        controller.TryBeginNativeDispatch(grant).IsSuccess.Should().BeTrue();
        string journalBeforeCompletion = store.Value!;

        BodyProgramControllerResult<RuntimeFact> result = controller.TryComplete(grant, Fact(grant), (BodyProgramNodeOutcome)999);

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
        authority.Submit(Program("program", 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant grant = Grant(challenge);
        authority.TryConsumeHostGrant(grant).IsSuccess.Should().BeTrue();
        authority.TryBeginNativeDispatch(grant).IsSuccess.Should().BeTrue();
        string journalBeforeCompletion = store.Value!;

        BodyProgramControllerResult<RuntimeFact> result = authority.TryComplete(grant, Fact(grant), (BodyProgramNodeOutcome)999);

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
        authority.Submit(Program("program", 1000, twoNodes: true)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!; HostAdmissionGrant grant = Grant(challenge);
        authority.TryConsumeHostGrant(grant).IsSuccess.Should().BeTrue(); authority.TryBeginNativeDispatch(grant).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, Fact(grant), outcome).IsSuccess.Should().BeTrue();

        OpenBodyProgramJournalAuthority reopened = Open(store, policy: () => Policy("policy-b", 2));
        reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
        BodyProgramJournalProgram program = reopened.Snapshot.Programs.Single();
        program.State.Should().Be(BodyProgramState.RecoveryRequired);
        program.Nodes.Single(node => node.NodeId == "first").State.Should().Be(outcome == BodyProgramNodeOutcome.Failed ? BodyProgramNodeState.Failed : BodyProgramNodeState.Cancelled);
        program.Nodes.Single(node => node.NodeId == "second").State.Should().Be(BodyProgramNodeState.RecoveryRequired);
    }

    [Fact]
    public void ReopenRejectsPersistedFactWithTamperedOutputKind()
    {
        var store = new MemoryStore(); var authority = Open(store);
        authority.Submit(Program("program", 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!; HostAdmissionGrant grant = Grant(challenge);
        authority.TryConsumeHostGrant(grant).IsSuccess.Should().BeTrue(); authority.TryBeginNativeDispatch(grant).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, Fact(grant), BodyProgramNodeOutcome.Succeeded).IsSuccess.Should().BeTrue();

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
            new ActionProgramCandidateNode("first", "move_to_tile", RuntimeMap("tile", 7), Array.Empty<string>(), Bindings(), 1000),
            new ActionProgramCandidateNode("second", "till_soil", RuntimeMap("tile", 8), new[] { "first", "first" }, Bindings(), 1000),
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
    public void CandidateCodecAndVerifierRejectDeadlinePastJavaScriptSafeInteger()
    {
        const long maximumSafeInteger = 9007199254740991L;
        string tooLarge = "{\"programId\":\"program\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"move_to_tile\",\"arguments\":{\"tile\":{\"type\":\"integer\",\"canonicalValue\":\"7\"}},\"dependsOn\":[],\"bindings\":{},\"deadlineMs\":9007199254740992}]}";
        ActionProgramCandidateCodec.TryDecode(tooLarge, out _, out _).Should().BeFalse();
        Open().Verify(Program("program", maximumSafeInteger + 1)).Accepted.Should().BeFalse();
        ActionProgramCandidateCodec.TryDecode(tooLarge.Replace("9007199254740992", "9007199254740991", StringComparison.Ordinal), out ActionProgramCandidate? candidate, out _).Should().BeTrue();
        Open().Verify(candidate!).Accepted.Should().BeTrue();
    }

    [Fact]
    public void CandidateCodecDoesNotApplyBodyProgramSpecificSizeCap()
    {
        BodyProgramArgumentDescriptor[] arguments = Enumerable.Range(0, 32).Select(index => new BodyProgramArgumentDescriptor($"arg{index:D2}", BodyProgramArgumentKind.String)).ToArray();
        BodyProgramActionCatalog catalog = new(7, new[] { new BodyProgramActionDescriptor("large_action", 1, arguments, Array.Empty<BodyProgramFactDescriptor>(), Array.Empty<BodyProgramResourceTemplateClaim>()) });
        IReadOnlyDictionary<string, BodyProgramRuntimeValue> values = arguments.ToDictionary(argument => argument.Name, _ => new BodyProgramRuntimeValue("string", new string('x', 400)), StringComparer.Ordinal);
        ActionProgramCandidate source = new("program", new[] { new ActionProgramCandidateNode("first", "large_action", values, Array.Empty<string>(), Bindings(), 1000) });
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
        var store = new MemoryStore(); var authority = Open(store); authority.Submit(Program("program", 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        string corrupt = store.Value!.Replace("\"canonicalValue\":\"7\"", "\"canonicalValue\":\"07\"", StringComparison.Ordinal);
        store.Set(corrupt);
        Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
    }
    private static BodyProgramActionCatalog ArrivalCatalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("move_to_tile", 1, new[] { new BodyProgramArgumentDescriptor("tile", BodyProgramArgumentKind.Integer) }, new[] { new BodyProgramFactDescriptor("arrival", BodyProgramArgumentKind.DestinationArrival) }, new[] { new BodyProgramResourceTemplateClaim("actor", BodyProgramResourceTemplateValue.ScopePlayer) }),
    });
    private static ActionProgramCandidate ArrivalProgram() => new("program", new[]
    {
        new ActionProgramCandidateNode("first", "move_to_tile", RuntimeMap("tile", 7), Array.Empty<string>(), Bindings(), 1000),
    });
    private static RuntimeFact ArrivalFact(HostAdmissionGrant grant) => new(grant.ProgramId, grant.NodeId, grant.NodeAttempt, "arrival", new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
    {
        ["arrival"] = new(BodyProgramArgumentKind.DestinationArrival, null, null, new BodyProgramDestinationArrival("destination_arrived", new BodyProgramArrivalDestination("Town", null))),
    });
    private static OpenBodyProgramJournalAuthority Open(MemoryStore? store = null, BodyProgramActionCatalog? catalog = null, Func<BodyProgramPolicyIdentity>? policy = null, Func<long>? now = null) =>
        OpenBodyProgramJournalAuthority.Open(store ?? new MemoryStore(), catalog ?? Catalog(), Scope(), policy ?? (() => Policy()), now ?? (() => 10));
    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("move_to_tile", 1, new[] { new BodyProgramArgumentDescriptor("tile", BodyProgramArgumentKind.Integer) }, new[] { new BodyProgramFactDescriptor("arrival", BodyProgramArgumentKind.Integer) }, new[] { new BodyProgramResourceTemplateClaim("actor", BodyProgramResourceTemplateValue.ScopePlayer) }),
        new BodyProgramActionDescriptor("till_soil", 1, new[] { new BodyProgramArgumentDescriptor("tile", BodyProgramArgumentKind.Integer) }, Array.Empty<BodyProgramFactDescriptor>(), new[] { new BodyProgramResourceTemplateClaim("actor", BodyProgramResourceTemplateValue.ScopePlayer) }),
    });
    private static ActionProgramCandidate OrderedConflictingProgram() => new("program", new[]
    {
        new ActionProgramCandidateNode("first", "move_to_tile", RuntimeMap("tile", 7), Array.Empty<string>(), Bindings(), 1000),
        new ActionProgramCandidateNode("second", "till_soil", RuntimeMap("tile", 8), new[] { "first" }, Bindings(), 1000),
    });
    private static ActionProgramCandidate Program(string programId, long deadline, bool twoNodes = false)
    {
        ActionProgramCandidateNode first = new("first", "move_to_tile", RuntimeMap("tile", 7), Array.Empty<string>(), Bindings(), deadline);
        return twoNodes ? new(programId, new[] { first, new ActionProgramCandidateNode("second", "till_soil", RuntimeMap("tile", 8), new[] { "first" }, Bindings("tile", new ActionProgramBinding("first", "arrival")), deadline) }) : new(programId, new[] { first });
    }
    private static HostAdmissionGrant Grant(NodeAdmissionChallenge challenge) => new(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt, challenge.StopEpoch, challenge.CatalogRevision, challenge.PolicyIdentity, challenge.ActionId, challenge.CanonicalArguments, challenge.DerivedResourceClaims, challenge.DeadlineMs, "grant");
    private static RuntimeFact Fact(HostAdmissionGrant grant) => new(grant.ProgramId, grant.NodeId, grant.NodeAttempt, "arrival", CanonicalMap("arrival", 7));
    private static BodyProgramPolicyIdentity Policy(string value = "policy-a", long revision = 1) => new(value, revision);
    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");
    private static IReadOnlyDictionary<string, ActionProgramBinding> Bindings(params object[] values) => values.Chunk(2).ToDictionary(pair => (string)pair[0], pair => (ActionProgramBinding)pair[1], StringComparer.Ordinal);
    private static IReadOnlyDictionary<string, BodyProgramRuntimeValue> RuntimeMap(string key, long value) => new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal) { [key] = new("integer", value.ToString(System.Globalization.CultureInfo.InvariantCulture)) };
    private static IReadOnlyDictionary<string, BodyProgramCanonicalValue> CanonicalMap(string key, long value) => new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal) { [key] = new(BodyProgramArgumentKind.Integer, value.ToString(System.Globalization.CultureInfo.InvariantCulture)) };
    private static IReadOnlyDictionary<string, string> Claims(string key, string value) => new Dictionary<string, string>(StringComparer.Ordinal) { [key] = value };
    private sealed class MemoryStore : IBodyProgramJournalStore { internal string? Value { get; private set; } public string? Read() => this.Value; public bool TryWrite(string encodedState) { this.Value = encodedState; return true; } internal void Set(string value) => this.Value = value; }
}
