using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>redeem_prize_ticket</c> contract pins.
///
/// SEAM DECISION. The exchange is the timed branch inside <c>PrizeTicketMenu.update</c>
/// (Menus/PrizeTicketMenu.cs:180-190) — the click handler at <c>:145</c> only arms UI state — and it is
/// a literal sequence of three PUBLIC calls (<c>Farmer.addItemToInventoryBool</c>,
/// <c>Inventory.ReduceId</c>, <c>Stats.Increment</c>) with no single settlement to call. So this action
/// reproduces that public call sequence and never drives the menu, its click handler or its private
/// prize track; the choice itself is re-derived from the game's own public faces
/// (<c>PrizeTicketMenu.getPrizeItem</c> + the live <c>ticketPrizesClaimed</c> stat). That is the B1b
/// form `design/domains/stardew/menu-bound-and-ui-boundary.md` §2.1 already ruled on.
///
/// WHAT THIS FILE PINS, and why these are the assertions worth having: the public call sequence and the
/// ABSENCE of every menu/input path, the "nothing is consumed before the prize was delivered" order,
/// both halves of the pack-read postcondition with its honest <c>Uncertain</c>, the two named refusals,
/// the argument-free registration, the fixture's Given and the runner's own two-halves contract.
/// The native exchange itself, the world's numbers and the stale replay belong to the live gate.
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class RedeemPrizeTicketActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.prizeticketactions.cs";
    private const string FixtureFile = "ModEntry.Fixtures.RedeemPrizeTicket.cs";
    private const string RunnerFile = "run-stardew-native-local-player-prize-ticket-smoke.mjs";

    /// <summary>The exact evidence keys the handler emits, in their emitted order.</summary>
    private static readonly string[] EvidenceKeys =
    {
        "prize_level",
        "prize_item_id",
        "prize_stack",
        "prize_held_before",
        "prize_held_after",
        "ticket_item_id",
        "tickets_before",
        "tickets_after",
        "prizes_claimed_before",
        "prizes_claimed_after",
        "prize_delivered",
    };

    [Fact]
    public void Handler_RedeemsThroughThePublicCallSequence_AndNeverDrivesTheMenu()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteRedeemPrizeTicket(");

        // The three public calls of the native reward branch, in its own order.
        executed.Should().Contain("player.addItemToInventoryBool(prize);");
        executed.Should().Contain("player.Items.ReduceId(PrizeTicketItemId, 1);");
        executed.Should().Contain("Game1.stats.Increment(TicketPrizesClaimedStatKey);");

        // The choice, from the game's own public faces only. The handler derives the prize through
        // TryDescribePrizeRedemption, which calls the same public members, so scan the whole source - the
        // contract is the public member, not which method hosts the call.
        code.Should().Contain("PrizeTicketMenu.getPrizeItem(prizeLevel)");
        executed.Should().Contain("Game1.stats.Get(TicketPrizesClaimedStatKey)");

        // NEGATIVE: none of the menu path, the input path or the private track may appear in CODE (the
        // header names what it does not call, so scanning the raw file would flag prose).
        code.Should().NotContain("new PrizeTicketMenu");
        code.Should().NotContain("receiveLeftClick");
        code.Should().NotContain("gettingReward");
        code.Should().NotContain("getRewardTimer");
        code.Should().NotContain("currentPrizeTrack");
        code.Should().NotContain("movingRewardTrack");
        code.Should().NotContain("activeClickableMenu");
        code.Should().NotContain(".update(");

        // The native branch's ground-drop fallback is deliberately NOT reproduced: the declared
        // postcondition is the prize in the PACK, so a pack that cannot take it is a named refusal.
        code.Should().NotContain("createItemDebris");
    }

    [Fact]
    public void Handler_ConsumesNothingBeforeThePrizeWasDelivered()
    {
        string executed = MethodBody(ReadHandlerSource(), "private LocalExecutionReceipt ExecuteRedeemPrizeTicket(");

        int delivery = executed.IndexOf("addItemToInventoryBool(prize)", StringComparison.Ordinal);
        int guard = executed.IndexOf("if (delivered)", StringComparison.Ordinal);
        int reduce = executed.IndexOf("ReduceId(PrizeTicketItemId, 1)", StringComparison.Ordinal);
        int increment = executed.IndexOf("Increment(TicketPrizesClaimedStatKey)", StringComparison.Ordinal);

        delivery.Should().BeGreaterThanOrEqualTo(0);
        guard.Should().BeGreaterThan(delivery, "the delivery verdict decides whether anything is consumed");
        reduce.Should().BeGreaterThan(guard);
        increment.Should().BeGreaterThan(reduce, "the stat advances with the ticket, exactly as the native branch orders them");
    }

    [Fact]
    public void Handler_ReadsBothHalvesOfThePostconditionOffTheLivePack()
    {
        string executed = MethodBody(ReadHandlerSource(), "private LocalExecutionReceipt ExecuteRedeemPrizeTicket(");

        // BOTH halves: the ticket stack fell by one AND the pack holds exactly the delivered prize stack
        // more than it did. One half alone would be duplication or destruction.
        executed.Should().Contain("ticketsAfter == ticketsBefore - 1");
        executed.Should().Contain("prizeHeldAfter - prizeHeldBefore == prizeStack");
        executed.Should().Contain("prizesClaimedAfter == prizesClaimedBefore + 1");
        executed.Should().Contain("player.Items.CountId(prizeItemId)");

        // The call sequence cannot refuse, so a receipt whose fresh postcondition does not hold must be
        // Uncertain — never a success, and never a silent retry.
        executed.Should().Contain("ExecutionState.Uncertain");
        executed.Should().Contain("\"redeem_prize_ticket_postcondition_unavailable\"");
        executed.Should().Contain("ExecutionState.Succeeded");
        executed.Should().Contain("\"prize_ticket_redeemed\"");
        executed.Should().Contain("prize_delivered=");

        // The evidence key set is the receipt's contract with the Host's completion rule, so every key is
        // pinned, in order, and no field value may contain the list's own separators.
        int at = -1;
        foreach (string key in EvidenceKeys)
        {
            int next = executed.IndexOf($"{key}=", at + 1, StringComparison.Ordinal);
            next.Should().BeGreaterThan(at, $"evidence key {key} must be emitted after the previous one");
            at = next;
        }
    }

    [Fact]
    public void Handler_RefusesByNamesBeforeAnyWrite()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string predicate = MethodBody(source, "internal static bool TryDescribePrizeRedemption(");

        code.Should().Contain("\"prize_ticket_unavailable\"");
        code.Should().Contain("\"prize_inventory_full\"");
        predicate.Should().Contain("player.Items.CountId(PrizeTicketItemId)");
        // The pack's capacity is the game's OWN predicate - the same question the prize-ticket
        // dispenser asks before handing a ticket over - so the fixture and the product cannot disagree.
        predicate.Should().Contain("player.couldInventoryAcceptThisItem(prize)");

        // The refusal is decided before the delivery call, so a refused request moves nothing at all.
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteRedeemPrizeTicket(");
        executed.IndexOf("TryDescribePrizeRedemption", StringComparison.Ordinal)
            .Should().BeLessThan(executed.IndexOf("addItemToInventoryBool(prize)", StringComparison.Ordinal));
    }

    [Fact]
    public void Action_IsRegisteredArgumentFreeAndExperimental()
    {
        string definitions = ReadRepositoryFile(Path.Combine("integrations", "stardew", "src", "Core", "Policy", "FarmhandActionDefinitions.cs"));
        int at = definitions.IndexOf("E(\"redeem_prize_ticket\"", StringComparison.Ordinal);
        at.Should().BeGreaterThanOrEqualTo(0, "the Mod catalog must register the action");
        string entry = definitions[at..Math.Min(definitions.Length, at + 700)];
        entry.Should().Contain("FarmhandActionLifecycle.LiveVerified", "promoted after its native-local gate passed with real world evidence (prize 0->12 in hand, tickets 1->0)");
        entry.Should().Contain("\"prize_ticket_redeemed\"", "the descriptor's terminal must be the code the handler mints");
        entry.Should().Contain("PrizeTicketMenu.getPrizeItem", "the descriptor's seam field must name the native face the choice comes from");
        entry.Should().Contain("Array.Empty<FarmhandActionArgument>()", "the subject is native state, so there is no client-supplied argument");

        string protocol = ReadRepositoryFile(Path.Combine("integrations", "stardew", "src", "Core", "Protocol", "BridgeProtocol.cs"));
        protocol.Should().Contain("\"redeem_prize_ticket\" => Array.Empty<string>()",
            "the wire argument-name list is what the parser reads before any handler sees the request");

        string router = ReadRepositoryFile(Path.Combine("integrations", "stardew", "Handlers", "WorldLifecycleActionHandler.cs"));
        router.Should().Contain("\"redeem_prize_ticket\" => this.executions.RequestLocalRedeemPrizeTicket(request.RequestId, request.DeadlineMs)");
    }

    [Fact]
    public void Fixture_EstablishesOnlyTheDeclaredGiven_ThroughTheProductPredicate()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        fixture.Should().Contain("ExecutionManager.TryDescribePrizeRedemption(",
            "the Given is asserted through the product's own predicate, so the two cannot disagree");
        fixture.Should().Contain("ItemRegistry.Create(ExecutionManager.PrizeTicketItemId, 1)",
            "the Given is exactly one prize ticket");
        fixture.Should().Contain("fixture_native_local_redeem_prize_ticket_not_redeemable",
            "a world the action cannot redeem fails here, naming what rejected the candidates");
        fixture.Should().Contain("rejected=");
        fixture.Should().Contain("last_prize_item_id=");
        fixture.Should().Contain("levels_tried=");

        // The fixture establishes a Given: it emits no receipt and never performs the action.
        fixture.Should().NotContain("RequestLocalRedeemPrizeTicket");
        fixture.Should().NotContain("RememberTerminal");

        // And the scenario must be armed on both sides the Mod validates it: the closed scenario set and
        // the pre-attachment dispatcher.
        string config = ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModConfig.cs"));
        config.Should().Contain("\"native_prize_ticket_v1\"");
        string entryPoint = ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModEntry.Fixtures.cs"));
        entryPoint.Should().Contain("InitializeNativeLocalRedeemPrizeTicketFixture(player)");
    }

    [Fact]
    public void Runner_ProvesBothHalvesFromThePack_AndTheStaleReplayRefusal()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", RunnerFile));

        // The capability surface is checked with the required-subset helper, not the exact-surface one.
        runner.Should().Contain("assertRequiredCapabilities");
        runner.Should().NotContain("assertTopologyCapabilities");
        runner.Should().Contain("inventoryItemFacts", "both halves are read from the pack facts the snapshot carries");
        runner.Should().Contain("\"prize_ticket_redeemed\"");
        runner.Should().Contain("prize_ticket_unavailable", "the negative case is the stale replay's named refusal");
        runner.Should().Contain("not_checked", "an unobservable pack must never read as a pass");
        runner.Should().Contain("import.meta.main");
    }

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

    private static string ReadHandlerSource() => ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

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
