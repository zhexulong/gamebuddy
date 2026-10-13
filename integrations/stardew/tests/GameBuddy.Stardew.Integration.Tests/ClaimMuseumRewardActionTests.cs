using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// claim_museum_reward contract pins.
///
/// The museum has NO persistent container: the reward menu is built from a computed list, and the game's
/// own flow is <c>LibraryMuseum.getRewardsForPlayer</c> (LibraryMuseum.cs:264, which both lists the item
/// rewards and grants the non-item ones) feeding an <c>ItemGrabMenu</c> whose grab callback is
/// <c>LibraryMuseum.OnRewardCollected</c> (:385, wired at :360). Both caveats that shape the body are pinned
/// here: the enumeration is NOT a pure query (it must be called exactly once), and the collected callback
/// depends on the lookup the enumeration populates.
///
/// Structural assertions run without a Game1 harness (world-not-ready path); the native calls, the observed
/// world change and the negative case belong to the native-local fixture gate (scenario
/// <c>native_claim_museum_reward_v1</c>).
/// </summary>
public sealed class ClaimMuseumRewardActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.museumrewards.cs";
    private const string FixtureFile = "ModEntry.Fixtures.ClaimMuseumReward.cs";
    private const string RunnerFile = "run-stardew-native-local-player-claim-museum-reward-smoke.mjs";
    private const string CatalogFile = "src/Core/Policy/FarmhandActionDefinitions.cs";
    private const string ProtocolFile = "src/Core/Protocol/BridgeProtocol.cs";
    private const string RouterFile = "Handlers/WorldLifecycleActionHandler.cs";

    private static readonly string[] ReasonCodes =
    {
        "museum_reward_unavailable",
        "museum_rewards_empty",
        "museum_reward_target_moved",
        "museum_reward_native_exception",
        "museum_reward_not_observed",
        "museum_rewards_collected",
    };

    /// <summary>
    /// The evidence keys, IN ORDER. The Host's completion rule uses <c>exactEvidence</c>, which requires the
    /// emitted key COUNT to equal its expected key count, so this list is the contract on both sides.
    /// </summary>
    private static readonly string[] EvidenceKeys =
    {
        "target",
        "location",
        "rewards_before",
        "rewards_returned",
        "rewards_delivered",
        "rewards_recorded",
        "rewards_after",
        "mail_flags_before",
        "mail_flags_after",
        "inventory_units_before",
        "inventory_units_after",
        "rewards_collected",
    };

    [Fact]
    public void Registered_AsExperimental_WithTheOpaqueRewardSetIdAlone()
    {
        FarmhandActionRegistration registration = FindRegistration("claim_museum_reward");
        registration.FamilyId.Should().Be("quests_journal");
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.WorldLifecycle);
        registration.Descriptor!.Arguments.Select(argument => argument.Name).Should().Equal("expectedTargetId");
        registration.Descriptor.Effect.Should().Be("write");
        registration.Descriptor.Postcondition.Should().Be("museum_rewards_collected");
        registration.Descriptor.NativeBinding.Should().Be("LibraryMuseum.getRewardsForPlayer");
    }

    [Fact]
    public void WireShape_RouterAndCatalog_AllNameTheRewardSetId()
    {
        string protocol = ReadRepositoryFile(Path.Combine("integrations", "stardew", ProtocolFile));
        protocol.Should().Contain("\"claim_museum_reward\" => new[] { \"expectedTargetId\" }");

        string router = ReadRepositoryFile(Path.Combine("integrations", "stardew", RouterFile));
        router.Should().Contain("\"claim_museum_reward\" => this.executions.RequestLocalClaimMuseumReward(");

        string catalog = ReadRepositoryFile(Path.Combine("integrations", "stardew", CatalogFile));
        catalog.Should().Contain("\"claim_museum_reward\"");
        catalog.Should().Contain("museum_rewards_collected");
    }

    /// <summary>
    /// The two caveats the seam has, as hard pins: the enumeration is called EXACTLY ONCE per request
    /// (calling it twice re-runs every non-item reward action and overwrites the lookup the collected
    /// callbacks depend on), and the read-only precondition path never calls it at all.
    /// </summary>
    [Fact]
    public void Handler_EnumeratesExactlyOnce_AndTheReadOnlyPathNeverWrites()
    {
        string source = ReadHandlerSource();
        string body = MethodBody(source, "private LocalExecutionReceipt ExecuteClaimMuseumReward(");
        string bodyCode = StripLineComments(body);
        string resolver = MethodBody(source, "internal static MuseumRewardTargetResolution ResolveMuseumRewardTarget(");

        bodyCode.Split("getRewardsForPlayer(player)").Length.Should().Be(
            2,
            "the enumeration is query-and-collect, so it must be called exactly once per request");
        // The collected callback must run on the SAME instances the enumeration returned.
        body.Should().Contain("museum.OnRewardCollected(item, player);");
        // And the item must actually reach the pack: the menu's own deposit call.
        body.Should().Contain("player.addItemToInventoryBool(item)");
        // The read-only precondition path must not write anything.
        StripLineComments(resolver).Should().NotContain("getRewardsForPlayer");
        resolver.Should().Contain("ReadCollectableMuseumRewards(");
        source.Should().Contain("museum.GetDonatedByContextTag(");
        source.Should().Contain("museum.CanCollectReward(");
        source.Should().Contain("museum.getRewardItemKey(");
    }

    [Fact]
    public void Handler_PostconditionIsAnObservableWorldChangeReadBack_WithEveryEvidenceKey()
    {
        string source = ReadHandlerSource();
        string body = MethodBody(source, "private LocalExecutionReceipt ExecuteClaimMuseumReward(");
        string bodyCode = StripLineComments(body);

        // The re-read happens AFTER the native calls, and is itself read-only.
        int nativeCall = bodyCode.IndexOf("museum.getRewardsForPlayer(player)", StringComparison.Ordinal);
        int callbacks = bodyCode.IndexOf("museum.OnRewardCollected(item, player);", StringComparison.Ordinal);
        int readBack = bodyCode.IndexOf("ReadCollectableMuseumRewards(museum, player)", StringComparison.Ordinal);
        nativeCall.Should().BeGreaterThanOrEqualTo(0);
        callbacks.Should().BeGreaterThan(nativeCall);
        readBack.Should().BeGreaterThan(callbacks, "the postcondition must be read AFTER the writes");
        bodyCode.Split("ReadCollectableMuseumRewards(museum, player)").Length.Should().Be(
            2,
            "exactly one post-collection re-read; the pre-collection read lives in the resolver");

        body.Should().Contain("ExecutionState.Uncertain");
        body.Should().Contain("museum_reward_not_observed");
        body.Should().Contain("stillCollectable.Count == 0");

        foreach (string key in EvidenceKeys)
            body.Should().Contain($"{key}=", $"the receipt must emit the {key} evidence field");
    }

    [Fact]
    public void Fixture_EstablishesOnlyTheDeclaredGiven_AndNeverCollects()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        fixture.Should().Contain("private void InitializeNativeLocalClaimMuseumRewardFixture(Farmer player)");
        // The donations are the ones the GAME calls donatable, not a table reproduced here.
        fixture.Should().Contain("LibraryMuseum.IsItemSuitableForDonation(");
        fixture.Should().Contain("Game1.netWorldState.Value.MuseumPieces");
        // Asserted through the PRODUCT'S OWN predicate, so the fixture and the product cannot disagree.
        fixture.Should().Contain("ExecutionManager.ReadCollectableMuseumRewards(");
        fixture.Should().Contain("ExecutionManager.ResolveMuseumRewardTarget(");
        fixture.Should().Contain("InvalidOperationException");
        fixture.Should().Contain("fixture_native_local_claim_museum_reward_");

        // NEGATIVE: the fixture must not collect, mint a receipt, or call the seam. Asserted against CODE
        // only - the header legitimately names the seams this fixture does not call.
        string code = StripLineComments(fixture);
        code.Should().NotContain("getRewardsForPlayer");
        code.Should().NotContain("OnRewardCollected");
        code.Should().NotContain("addItemToInventoryBool");
        code.Should().NotContain("RequestLocal");
        code.Should().NotContain("PublishReceipt");
    }

    [Fact]
    public void Runner_AssertsTheObservedWorldChange_AndCarriesTheNegativeCase()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", RunnerFile));
        runner.Should().Contain("const ACTION = \"claim_museum_reward\";");
        runner.Should().Contain("assertRequiredCapabilities");
        runner.Should().NotContain("assertExactCapabilities");
        runner.Should().Contain("connectNativeLocalClient");
        foreach (string clause in new[]
                 {
                     "museumRewardTargets",
                     "museum_rewards_collected",
                     "museum_rewards_empty",
                     "museum_reward_stale_not_refused",
                     "not_checked",
                     "export function assertClaimMuseumRewardPostconditions",
                 })
            runner.Should().Contain(clause, $"{RunnerFile} must carry {clause}");
    }

    [Fact]
    public void RejectsWhenTheWorldIsNotReady()
    {
        RejectWithoutWorld("claim_museum_reward", new BridgeExecutionArgs { ExpectedTargetId = "museum_reward_0123456789abcdef" })
            .Should().Be("world_not_ready");
    }

    // ---------------------------------------------------------------------------------

    private static FarmhandActionRegistration FindRegistration(string actionId)
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(entry => entry.ActionId == actionId);
        registration.Should().NotBeNull($"{actionId} must be registered");
        return registration!;
    }

    private static string RejectWithoutWorld(string actionId, BridgeExecutionArgs args)
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { actionId });
        ExecutionManager executions = new(new DummyMonitor(), () => publication);
        IFarmhandActionHandler handler = new WorldLifecycleActionHandler(executions);
        BridgeExecutionRequest request = new(
            $"req_{actionId}_world_not_ready",
            $"idemp_{actionId}_world_not_ready",
            actionId,
            args,
            1,
            5000);

        LocalExecutionReceipt receipt = handler.Execute(request, executions);
        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        return receipt.ReasonCode;
    }

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>Drop <c>//</c>/<c>///</c> comments so negative pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string ReadRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
