using GameBuddy.Stardew;
using StardewModdingAPI;
using StardewValley;

internal static class FarmhandActionCapabilityProjectionTests
{
    internal static void RunPolicySemantics()
    {
        VersionOneDefaultAdvertisementContainsEveryStableAction();
        VersionOneDefaultAndDenyProjection();
        VersionOneFamilyAndExperimentalProjection();
        LegacyProjection();
        InvalidPolicyConfigurationsFailClosed();
        DeterministicSurfaceAndControls();
        CanonicalDefinitionsHaveValidStaticIdentityVersion();
        StructuralValidationRejectsNonCanonicalActionArguments();
        StrictInboundWireRejectsNonCanonicalJson();
        RouterRejectsOffThreadDispatch();
    }

    private static void VersionOneDefaultAdvertisementContainsEveryStableAction()
    {
        string[] stablePublishedActions = new[]
        {
            "move_to_tile", "equip_tool", "travel", "enter_exit", "till_soil", "pickup_forage", "pickup_item", "water_crop",
            "plant_seed", "fertilize_tile", "machine_inspect", "machine_load", "machine_collect_output", "collect_animal_product",
            "feed_animal", "use_item", "harvest_crop", "place_wood_fence", "place_crab_pot", "bait_crab_pot", "chop_tree_source",
            "break_rock_source", "clear_hoedirt", "dig_artifact_spot", "refill_watering_can",
        };
        FarmhandCapabilitySurface surface = new ModConfig { ActionPolicyVersion = 1 }.CreateFarmhandCapabilitySurface();

        foreach (string action in stablePublishedActions)
        {
            Assert(surface.ContainsGameAction(action), $"v1 must include every stable PublishedActions member in execution membership: {action}.");
            Assert(surface.Capabilities.Contains(action, StringComparer.Ordinal), $"v1 must advertise every stable PublishedActions member: {action}.");
        }
        Assert(surface.Capabilities.SequenceEqual(stablePublishedActions.OrderBy(action => action, StringComparer.Ordinal)
            .Concat(new[] { "inspect_self", "cancel_active_execution" }), StringComparer.Ordinal),
            "v1 advertisement must be exactly the stable published actions followed by fixed controls.");
    }

    private static void VersionOneDefaultAndDenyProjection()
    {
        FarmhandCapabilitySurface defaultSurface = new ModConfig { ActionPolicyVersion = 1 }.CreateFarmhandCapabilitySurface();
        Assert(!defaultSurface.ContainsGameAction("clear_debris"), "v1 must not publish experimental actions by default.");
        Assert(!defaultSurface.ContainsGameAction("tree_first_hit"), "retired tree_first_hit must be rejected from the v1 game-action surface.");
        Assert(!defaultSurface.Capabilities.Contains("tree_first_hit", StringComparer.Ordinal), "retired tree_first_hit must not be advertised.");

        FarmhandCapabilitySurface deniedSurface = new ModConfig
        {
            ActionPolicyVersion = 1,
            DeniedActions = new List<string> { "move_to_tile" },
        }.CreateFarmhandCapabilitySurface();
        Assert(!deniedSurface.ContainsGameAction("move_to_tile"), "v1 denied action must be absent from game-action membership.");
        Assert(!deniedSurface.Capabilities.Contains("move_to_tile", StringComparer.Ordinal), "v1 denied action must be absent from advertisement.");
    }

    private static void VersionOneFamilyAndExperimentalProjection()
    {
        ModConfig config = new()
        {
            ActionPolicyVersion = 1,
            DeniedActionFamilies = new List<string> { "farming_crops" },
            ExperimentalActions = new List<string> { "clear_debris", "pet_animal" },
            DeniedActions = new List<string> { "pet_animal" },
        };
        FarmhandCapabilitySurface surface = config.CreateFarmhandCapabilitySurface();
        string[] farmingActions = new[] { "till_soil", "water_crop", "plant_seed", "fertilize_tile", "harvest_crop", "clear_hoedirt", "refill_watering_can" };
        foreach (string action in farmingActions)
        {
            Assert(!surface.ContainsGameAction(action), $"farming_crops deny must remove stable farming action: {action}.");
            Assert(!surface.Capabilities.Contains(action, StringComparer.Ordinal), $"farming_crops deny must remove farming action from advertisement: {action}.");
        }
        foreach (string action in new[] { "move_to_tile", "machine_inspect", "chop_tree_source" })
            Assert(surface.ContainsGameAction(action), $"farming_crops deny must retain unrelated stable action: {action}.");
        Assert(surface.ContainsGameAction("clear_debris"), "explicit v1 experimental action must project.");
        Assert(!surface.ContainsGameAction("pet_animal"), "deny must remove explicitly enabled experimental action.");
    }

    private static void LegacyProjection()
    {
        ModConfig emptyLegacy = new();
        Assert(!emptyLegacy.CreateFarmhandCapabilitySurface().ContainsGameAction("move_to_tile"), "legacy null allowlist must fail closed.");

        ModConfig legacy = new()
        {
            EnabledActions = new List<string> { "equip_tool", "clear_debris", "unpublished_action" },
        };
        FarmhandCapabilitySurface surface = legacy.CreateFarmhandCapabilitySurface();
        Assert(surface.ContainsGameAction("equip_tool"), "legacy explicit stable allowlist entry must project.");
        Assert(surface.ContainsGameAction("clear_debris"), "legacy explicit experimental allowlist entry must project.");
        Assert(!surface.ContainsGameAction("unpublished_action"), "legacy unknown action must not project.");
    }

    private static void InvalidPolicyConfigurationsFailClosed()
    {
        Assert(!new ModConfig { ActionPolicyVersion = 2 }.HasValidActionPolicy, "unsupported policy version must be invalid.");
        Assert(!new ModConfig { ActionPolicyVersion = 1, EnabledActions = new List<string>() }.HasValidActionPolicy, "v1 EnabledActions mix must be invalid.");
        Assert(!new ModConfig { DeniedActions = new List<string> { "move_to_tile" } }.HasValidActionPolicy, "v0 deny action must be invalid.");
        Assert(!new ModConfig { DeniedActionFamilies = new List<string> { "farming_crops" } }.HasValidActionPolicy, "v0 deny family must be invalid.");
        Assert(!new ModConfig { ActionPolicyVersion = 1, DeniedActions = new List<string> { "unknown_action" } }.HasValidActionPolicy, "unknown denied action must be invalid.");
        Assert(!new ModConfig { ActionPolicyVersion = 1, DeniedActionFamilies = new List<string> { "unknown_family" } }.HasValidActionPolicy, "unknown denied family must be invalid.");
        Assert(!new ModConfig { ActionPolicyVersion = 1, ExperimentalActions = new List<string> { "move_to_tile" } }.HasValidActionPolicy, "stable action cannot be an experimental opt-in.");
        Assert(new ModConfig { EnabledActions = new List<string> { "move_to_tile" } }.HasValidActionPolicy, "valid v0 allowlist must be accepted.");
        Assert(new ModConfig { ActionPolicyVersion = 1, DeniedActions = new List<string> { "move_to_tile" }, DeniedActionFamilies = new List<string> { "farming_crops" }, ExperimentalActions = new List<string> { "clear_debris" } }.HasValidActionPolicy, "valid v1 policy must be accepted.");
    }

    internal static void RunSameLiveSurfaceHelloAndWorldNotReadySnapshotCharacterization()
    {
        Assert(Game1.player is null,
            "offline same-live-surface characterization requires Game1.player to be absent rather than a game-state-backed snapshot.");
        string[] retainedGameActions = new[]
        {
            "bait_crab_pot", "chop_tree_source", "move_to_tile", "place_crab_pot",
        };
        ModConfig policy = new()
        {
            ActionPolicyVersion = 1,
            DeniedActions = ModConfig.FarmhandActionDefinitions
                .Where(definition => definition.Lifecycle == FarmhandActionLifecycle.Published
                    && !retainedGameActions.Contains(definition.ActionId, StringComparer.Ordinal))
                .Select(definition => definition.ActionId)
                .ToList(),
        };
        Assert(policy.UsesDefaultConsentPolicy && policy.HasValidActionPolicy,
            "characterization must use an explicit valid version-1 default-consent policy with denied published actions.");

        FarmhandCapabilitySurface surface = policy.CreateFarmhandCapabilitySurface();
        string[] expectedCapabilities = new[]
        {
            "bait_crab_pot", "chop_tree_source", "move_to_tile", "place_crab_pot",
            "inspect_self", "cancel_active_execution",
        };
        Assert(surface.Capabilities.SequenceEqual(expectedCapabilities, StringComparer.Ordinal),
            "the non-default policy-derived surface must retain exactly the selected actions followed by protocol controls.");

        BridgeScope scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");
        const string token = "characterization_token_0123456789";
        ExecutionManager executions = new(new SilentMonitor(), surface);
        BridgeSession session = new(executions, scope, token, surface, () => "en-US");
        BridgeEnvelope<BridgeHello> hello = new(
            BridgeProtocol.Version, "hello_01", "hello_01", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));
        Assert(session.TryAuthenticate(1, hello, out BridgeEnvelope<BridgeHelloAck>? generationOneAcknowledgement, out string generationOneHelloReason)
            && generationOneHelloReason == "accepted" && generationOneAcknowledgement is not null,
            "offline characterization must authenticate generation 1 on the same immutable-surface bridge session.");
        Assert(generationOneAcknowledgement!.Payload.Capabilities.SequenceEqual(expectedCapabilities, StringComparer.Ordinal),
            "generation-1 hello must emit immutable surface A's exact policy-derived capability sequence.");

        BridgeEnvelope<BridgeHello> successorHello = new(
            BridgeProtocol.Version, "hello_02", "hello_02", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));
        Assert(session.TryAuthenticate(2, successorHello, out BridgeEnvelope<BridgeHelloAck>? generationTwoAcknowledgement, out string generationTwoHelloReason)
            && generationTwoHelloReason == "accepted" && generationTwoAcknowledgement is not null,
            "the same BridgeSession must accept a valid generation-2 hello.");
        Assert(generationTwoAcknowledgement!.Payload.Capabilities.SequenceEqual(expectedCapabilities, StringComparer.Ordinal),
            "generation-2 hello must retain exactly immutable surface A rather than replace or withdraw capabilities.");
        Assert(generationOneAcknowledgement.Payload.Capabilities.SequenceEqual(generationTwoAcknowledgement.Payload.Capabilities, StringComparer.Ordinal),
            "successor authentication must not replace immutable surface A or withdraw any of its capabilities.");

        BridgeEnvelope<BridgeObserveRequest> observe = new(
            BridgeProtocol.Version, "observe_01", "observe_01", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "observe_request", new BridgeObserveRequest());
        Assert(!session.TryObserve(1, observe, out BridgeEnvelope<BridgeSnapshot>? rejectedGenerationOneSnapshot, out string generationOneObserveReason)
            && generationOneObserveReason == "unauthenticated" && rejectedGenerationOneSnapshot is null,
            "generation-1 observe must be rejected unauthenticated after generation 2 succeeds.");
        Assert(session.TryObserve(2, observe, out BridgeEnvelope<BridgeSnapshot>? snapshot, out string generationTwoObserveReason)
            && generationTwoObserveReason == "accepted" && snapshot is not null,
            "generation-2 observe must succeed without executing an action.");
        Assert(snapshot!.Payload.Capabilities.SequenceEqual(expectedCapabilities, StringComparer.Ordinal),
            "generation-2 world-not-ready snapshot must retain exactly immutable surface A.");
        Assert(generationTwoAcknowledgement.Payload.Capabilities.SequenceEqual(snapshot.Payload.Capabilities, StringComparer.Ordinal),
            "generation-2 hello and snapshot must emit exactly equal immutable surface A capability sequences.");
        Assert(snapshot.Payload is { Revision: 0, Location: "unknown", Tile: { X: 0f, Y: 0f }, Stamina: 0f, Health: 0, CurrentTool: null,
            InventorySlots: 0, Actionable: false, ActiveExecution: null },
            "successor-generation fencing is not a revision advance, surface replacement, or capability withdrawal; offline observation retains revision 0 and the explicit world-not-ready state.");
    }

    internal static void RunPortfolioAndFarmhandActionIsolationCharacterization()
    {
        string[] portfolioActions = PortfolioActionIds();
        FarmhandCapabilitySurface ordinarySurface = new ModConfig { ActionPolicyVersion = 1 }.CreateFarmhandCapabilitySurface();
        foreach (string portfolioAction in portfolioActions)
        {
            Assert(!ordinarySurface.ContainsGameAction(portfolioAction),
                $"ordinary v1 Farmhand membership must exclude Portfolio action {portfolioAction}.");
            Assert(!ordinarySurface.Capabilities.Contains(portfolioAction, StringComparer.Ordinal),
                $"ordinary v1 Farmhand advertisement must exclude Portfolio action {portfolioAction}.");
        }

        BridgeScope scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");
        const string token = "isolation_token_0123456789";
        ExecutionManager executions = new(new SilentMonitor(), ordinarySurface);
        BridgeSession session = new(executions, scope, token, ordinarySurface, () => "en-US");
        BridgeEnvelope<BridgeHello> hello = new(BridgeProtocol.Version, "isolation_hello", "isolation_hello",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));
        Assert(session.TryAuthenticate(1, hello, out BridgeEnvelope<BridgeHelloAck>? acknowledgement, out string helloReason)
            && helloReason == "accepted" && acknowledgement is not null,
            "ordinary isolation characterization must authenticate its offline Farmhand session.");
        BridgeEnvelope<BridgeObserveRequest> observe = new(BridgeProtocol.Version, "isolation_observe", "isolation_observe",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "observe_request", new BridgeObserveRequest());
        Assert(session.TryObserve(1, observe, out BridgeEnvelope<BridgeSnapshot>? snapshot, out string observeReason)
            && observeReason == "accepted" && snapshot is not null,
            "ordinary isolation characterization must produce its offline world-not-ready snapshot.");
        foreach (string portfolioAction in portfolioActions)
        {
            Assert(!acknowledgement!.Payload.Capabilities.Contains(portfolioAction, StringComparer.Ordinal),
                $"ordinary Farmhand hello must exclude Portfolio action {portfolioAction}.");
            Assert(!snapshot!.Payload.Capabilities.Contains(portfolioAction, StringComparer.Ordinal),
                $"ordinary Farmhand world-not-ready snapshot must exclude Portfolio action {portfolioAction}.");
        }

        string[] selectedFarmhandActions = new[] { "move_to_tile", "equip_tool", "place_crab_pot", "inspect_self" };
        foreach (string portfolioAction in portfolioActions)
        {
            PortfolioConfig exactPortfolioConfig = CreateValidPortfolioConfig(portfolioAction);
            Assert(exactPortfolioConfig.IsValid, $"single-action Portfolio config must be valid for {portfolioAction}.");
            Assert(exactPortfolioConfig.IsPortfolioActionAuthorized(portfolioAction),
                $"valid single-action Portfolio config must authorize {portfolioAction}.");
            foreach (string farmhandAction in selectedFarmhandActions)
                Assert(!exactPortfolioConfig.IsPortfolioActionAuthorized(farmhandAction),
                    $"Portfolio config for {portfolioAction} must reject ordinary Farmhand/control action {farmhandAction}.");

            PortfolioConfig contaminatedPortfolioConfig = CreateValidPortfolioConfig(portfolioAction, "move_to_tile");
            Assert(!contaminatedPortfolioConfig.IsValid,
                $"Portfolio config containing Farmhand action must be invalid for {portfolioAction}.");
            Assert(!contaminatedPortfolioConfig.IsPortfolioActionAuthorized(portfolioAction),
                $"invalid Portfolio config containing Farmhand action must not authorize {portfolioAction}.");
            Assert(!contaminatedPortfolioConfig.IsPortfolioActionAuthorized("move_to_tile"),
                "invalid Portfolio config containing Farmhand action must never authorize that action.");
        }

        foreach (string portfolioAction in portfolioActions)
            Assert(!ordinarySurface.ContainsGameAction(portfolioAction),
                $"ordinary Farmhand policy/capability must not make Portfolio action authorized: {portfolioAction}.");
    }

    private static string[] PortfolioActionIds() => new[]
    {
        PortfolioBridgeProtocol.SleepDayAction,
        PortfolioBridgeProtocol.MineElevatorAction,
        PortfolioBridgeProtocol.MineLadderAction,
        PortfolioBridgeProtocol.MineEntryAction,
    };

    private static PortfolioConfig CreateValidPortfolioConfig(params string[] enabledActions) => new()
    {
        Enable = true,
        Topology = PortfolioBridgeProtocol.Topology,
        EnableObserveBridge = true,
        EnabledActions = enabledActions.ToList(),
        PipeName = PortfolioBridgeProtocol.PipeNamePrefix + "-isolation",
        BridgeToken = "portfolio_isolation_token_0123456789",
        SaveId = "save_01",
        WorldId = "world_01",
        LocalPlayerId = "player_01",
        CompanionId = "companion_01",
        DataRoot = Path.GetFullPath("portfolio-isolation-test-root"),
    };

    private static void StructuralValidationRejectsNonCanonicalActionArguments()
    {
        BridgeExecutionRequest request = new(
            "request_01",
            "idempotency_01",
            "move_to_tile",
            new BridgeExecutionArgs { X = 1, Y = 1, Slot = 2 },
            0,
            DateTimeOffset.UtcNow.AddSeconds(30).ToUnixTimeMilliseconds());
        System.Reflection.MethodInfo validate = typeof(BridgeSession).GetMethod(
            "IsStructurallyValidExecutionRequest",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("BridgeSession structural validator must exist.");
        object?[] arguments = new object?[] { request, null };
        bool accepted = (bool)(validate.Invoke(null, arguments)
            ?? throw new InvalidOperationException("BridgeSession structural validator must return a bool."));

        Assert(!accepted && (string?)arguments[1] == "invalid_execution_request",
            "ordinary Farmhand structural validation must reject fields belonging to another action before native dispatch.");
    }

    private static void StrictInboundWireRejectsNonCanonicalJson()
    {
        const string canonical = "{\"protocolVersion\":1,\"messageId\":\"message_01\",\"correlationId\":\"correlation_01\",\"timestampMs\":1700000000000,\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_01\",\"worldId\":\"world_01\",\"playerId\":\"player_01\",\"companionId\":\"companion_01\"},\"type\":\"execution_request\",\"payload\":{\"requestId\":\"request_01\",\"idempotencyKey\":\"idempotency_01\",\"action\":\"move_to_tile\",\"args\":{\"x\":1,\"y\":1},\"expectedRevision\":0,\"deadlineMs\":1700000030000}}";
        Assert(BridgeProtocol.TryDeserializeExecutionRequest(canonical, out BridgeEnvelope<BridgeExecutionRequest>? accepted, out string acceptedReason)
            && acceptedReason == "accepted" && accepted is not null,
            "canonical execution JSON must deserialize at the Mod ingress.");

        string wrongCase = canonical.Replace("\"messageId\"", "\"MessageId\"", StringComparison.Ordinal);
        Assert(!BridgeProtocol.TryDeserializeExecutionRequest(wrongCase, out _, out string wrongCaseReason)
            && wrongCaseReason == "invalid_envelope",
            "Mod ingress must reject wrong-case envelope fields before DTO binding.");

        string crossActionField = canonical.Replace("\"y\":1}", "\"y\":1,\"slot\":2}", StringComparison.Ordinal);
        Assert(!BridgeProtocol.TryDeserializeExecutionRequest(crossActionField, out _, out string crossActionReason)
            && crossActionReason == "invalid_envelope",
            "Mod ingress must reject fields owned by a different action before native dispatch.");

        string duplicateArgument = canonical.Replace("\"x\":1,\"y\":1", "\"x\":1,\"x\":2,\"y\":1", StringComparison.Ordinal);
        Assert(!BridgeProtocol.TryDeserializeExecutionRequest(duplicateArgument, out _, out string duplicateReason)
            && duplicateReason == "invalid_envelope",
            "Mod ingress must reject duplicate action argument fields.");
    }

    private static void RouterRejectsOffThreadDispatch()
    {
        FarmhandActionRouter router = new();
        FarmhandCapabilitySurface surface = new ModConfig { ActionPolicyVersion = 1 }.CreateFarmhandCapabilitySurface();
        BridgeExecutionRequest request = new(
            "request_01",
            "idempotency_01",
            "move_to_tile",
            new BridgeExecutionArgs { X = 1, Y = 1 },
            0,
            DateTimeOffset.UtcNow.AddSeconds(30).ToUnixTimeMilliseconds());

        (bool routed, string reasonCode) result = Task.Run(() =>
        {
            bool routed = router.TryRoute(request, null!, surface, out _, out string reasonCode);
            return (routed, reasonCode);
        }).GetAwaiter().GetResult();

        Assert(!result.routed && result.reasonCode == "game_thread_required",
            "Farmhand router must reject off-thread dispatch before reading execution state or invoking a native handler.");
    }

    private static void CanonicalDefinitionsHaveValidStaticIdentityVersion()
    {
        Assert(ModConfig.FarmhandActionDefinitions.All(definition => definition.IdentityVersion > 0),
            "every canonical Farmhand action definition must declare a positive static identityVersion.");
    }

    private static void DeterministicSurfaceAndControls()
    {
        ModConfig config = new()
        {
            EnabledActions = new List<string> { "water_crop", "equip_tool" },
        };
        FarmhandCapabilitySurface first = config.CreateFarmhandCapabilitySurface();
        FarmhandCapabilitySurface second = config.CreateFarmhandCapabilitySurface();
        string[] expected = new[] { "equip_tool", "water_crop", "inspect_self", "cancel_active_execution" };
        Assert(first.Capabilities.SequenceEqual(expected, StringComparer.Ordinal), "surface list must be deterministic actions followed by controls.");
        Assert(first.Capabilities.SequenceEqual(second.Capabilities, StringComparer.Ordinal), "equivalent enabled set must project identically.");
        Assert(!first.ContainsGameAction("inspect_self") && !first.ContainsGameAction("cancel_active_execution"), "protocol controls must not become game-action execution inputs.");
    }

    private sealed class SilentMonitor : IMonitor
    {
        public bool IsVerbose => false;
        public void Log(string message, LogLevel level = LogLevel.Trace) { }
        public void LogOnce(string message, LogLevel level = LogLevel.Trace) { }
        public void VerboseLog(string message) { }
        public void VerboseLog(ref StardewModdingAPI.Framework.Logging.VerboseLogStringHandler message) { }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
