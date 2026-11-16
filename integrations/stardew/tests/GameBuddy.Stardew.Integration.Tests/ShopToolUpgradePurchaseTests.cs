using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A purchase that is a TOOL UPGRADE is a success whose goods never enter the pack, and the receipt has to say so.
///
/// <para>
/// THE DEFECT. `shop_purchase` minted `item_purchased` only when the pack GAINED the item it was asked for
/// (`farmhandexecutioncontroller.shopactions.cs`: `currencyAfter &lt; currencyBefore &amp;&amp; gained &gt; 0`). A tool
/// upgrade never gains anything: `ShopMenu.tryToPurchaseItem` charges the purse (<c>ShopMenu.cs:1364</c>) and then
/// discards the entry when <c>actionWhenPurchased</c> returns true (:1369-1378), while
/// <c>Tool.actionWhenPurchased</c> puts the upgraded tool into <c>Farmer.toolBeingUpgraded</c>, sets
/// <c>daysLeftForToolUpgrade = 2</c> and REMOVES the tool the upgrade consumes (<c>Tool.cs:875-895</c>). So a finished,
/// paid-for, engine-recorded upgrade came back <c>Uncertain/purchase_partial</c> - "something happened" - which is the
/// one answer a caller cannot act on: it cannot tell a completed upgrade from a half-done trade, and it must not retry
/// a purchase that already consumed the tool.
/// </para>
/// <para>
/// WHAT IS DRIVEN HERE. <see cref="ExecutionManager.ShopPurchaseOutcomeFor"/> is the decision the receipt is built from,
/// and these cases hand it the facts the transaction produced. The upgrade facts are the ENGINE's own fields, so the
/// cases below are about the rule that reads them, not about a fake that reports them: the child half (does the engine
/// really set those two fields and consume that item?) is `ShopSaleReachTests`'s, which drives the real
/// <c>ShopMenu.receiveLeftClick</c> over a fabricated menu.
/// </para>
/// </summary>
public sealed class ShopToolUpgradePurchaseTests
{
    private const string SteelHoe = "(T)SteelHoe";
    private const string CopperHoe = "(T)CopperHoe";

    /// <summary>The ordinary purchase, unchanged: the purse paid and the goods arrived.</summary>
    [Fact]
    public void AnOrdinaryPurchaseIsStillItemPurchased()
    {
        ExecutionManager.ShopPurchaseOutcome outcome = ExecutionManager.ShopPurchaseOutcomeFor(
            currencyBefore: 500,
            currencyAfter: 480,
            gained: 1,
            purchaseRefusal: null,
            expectedItemId: "(O)472",
            upgradedToolId: null,
            daysLeftForToolUpgrade: 0,
            requiredToolId: null,
            requiredToolBefore: 0,
            requiredToolAfter: 0);

        outcome.State.Should().Be(ExecutionState.Succeeded);
        outcome.ReasonCode.Should().Be("item_purchased", "the ordinary terminal must not move");
    }

    /// <summary>
    /// The case this file exists for: the engine paid, wrote its upgrade fields, and took the tool that upgrades.
    /// </summary>
    [Fact]
    public void AnEngineRecordedUpgradeIsToolUpgradePurchased()
    {
        ExecutionManager.ShopPurchaseOutcome outcome = ExecutionManager.ShopPurchaseOutcomeFor(
            currencyBefore: 5000,
            currencyAfter: 0,
            gained: 0,
            purchaseRefusal: null,
            expectedItemId: SteelHoe,
            upgradedToolId: SteelHoe,
            daysLeftForToolUpgrade: 2,
            requiredToolId: "CopperHoe",
            requiredToolBefore: 1,
            requiredToolAfter: 0);

        outcome.State.Should().Be(ExecutionState.Succeeded);
        outcome.ReasonCode.Should().Be("tool_upgrade_purchased");
    }

    /// <summary>
    /// The upgraded tool already at Clint's belongs to somebody else: `toolBeingUpgraded` may hold a DIFFERENT tool
    /// (Tool.cs:875 is the only writer's guard), and this purchase is not the answer for it.
    /// </summary>
    [Fact]
    public void AToolSomebodyElseIsUpgradingIsNotThisUpgrade()
    {
        ExecutionManager.ShopPurchaseOutcome outcome = ExecutionManager.ShopPurchaseOutcomeFor(
            currencyBefore: 5000,
            currencyAfter: 0,
            gained: 0,
            purchaseRefusal: null,
            expectedItemId: SteelHoe,
            upgradedToolId: "(T)GoldHoe",
            daysLeftForToolUpgrade: 2,
            requiredToolId: "CopperHoe",
            requiredToolBefore: 1,
            requiredToolAfter: 0);

        outcome.ReasonCode.Should().NotBe("tool_upgrade_purchased");
        outcome.State.Should().Be(ExecutionState.Uncertain, "the purse paid and nothing arrived, which is a partial");
        outcome.ReasonCode.Should().Be("purchase_partial");
    }

    /// <summary>
    /// The half of the engine's effect that is easy to miss: the tool the upgrade consumes must really have left the
    /// pack. Without it the money moved and neither the pack nor `toolBeingUpgraded` explains where it went.
    /// </summary>
    [Fact]
    public void AnUpgradeThatDidNotConsumeItsToolIsNotASuccess()
    {
        ExecutionManager.ShopPurchaseOutcome outcome = ExecutionManager.ShopPurchaseOutcomeFor(
            currencyBefore: 5000,
            currencyAfter: 0,
            gained: 0,
            purchaseRefusal: null,
            expectedItemId: SteelHoe,
            upgradedToolId: SteelHoe,
            daysLeftForToolUpgrade: 2,
            requiredToolId: "CopperHoe",
            requiredToolBefore: 1,
            requiredToolAfter: 1);

        outcome.State.Should().Be(ExecutionState.Uncertain);
        outcome.ReasonCode.Should().Be("purchase_partial");
    }

    /// <summary>An upgrade field with no days left is not a fresh upgrade.</summary>
    [Fact]
    public void AnUpgradeWithNoDaysLeftIsNotAFreshUpgrade()
    {
        ExecutionManager.ShopPurchaseOutcome outcome = ExecutionManager.ShopPurchaseOutcomeFor(
            currencyBefore: 5000,
            currencyAfter: 0,
            gained: 0,
            purchaseRefusal: null,
            expectedItemId: SteelHoe,
            upgradedToolId: SteelHoe,
            daysLeftForToolUpgrade: 0,
            requiredToolId: "CopperHoe",
            requiredToolBefore: 1,
            requiredToolAfter: 0);

        outcome.ReasonCode.Should().NotBe("tool_upgrade_purchased");
    }

    /// <summary>Nothing was charged, so nothing was upgraded however the engine's fields read.</summary>
    [Fact]
    public void AnUpgradeNobodyPaidForIsNotASuccess()
    {
        ExecutionManager.ShopPurchaseOutcome outcome = ExecutionManager.ShopPurchaseOutcomeFor(
            currencyBefore: 5000,
            currencyAfter: 5000,
            gained: 0,
            purchaseRefusal: null,
            expectedItemId: SteelHoe,
            upgradedToolId: SteelHoe,
            daysLeftForToolUpgrade: 2,
            requiredToolId: "CopperHoe",
            requiredToolBefore: 1,
            requiredToolAfter: 0);

        outcome.State.Should().Be(ExecutionState.Failed, "nothing moved at all");
        outcome.ReasonCode.Should().Be("shop_purchase_refused:no_effect");
    }

    /// <summary>
    /// A refusal keeps its own terminal and its own state, and an upgrade that consumed the tool still counts as movement
    /// for the state: the caller must not read it as "nothing happened, try again".
    /// </summary>
    [Fact]
    public void ARefusalAfterAConsumedUpgradeToolIsUncertainNotEmpty()
    {
        ExecutionManager.ShopPurchaseOutcome outcome = ExecutionManager.ShopPurchaseOutcomeFor(
            currencyBefore: 5000,
            currencyAfter: 0,
            gained: 0,
            purchaseRefusal: "inventory_cannot_accept:(T)SteelHoe",
            expectedItemId: SteelHoe,
            upgradedToolId: SteelHoe,
            daysLeftForToolUpgrade: 2,
            requiredToolId: "CopperHoe",
            requiredToolBefore: 1,
            requiredToolAfter: 0);

        outcome.State.Should().Be(ExecutionState.Uncertain);
        outcome.ReasonCode.Should().Be("inventory_cannot_accept:(T)SteelHoe", "the refusal keeps its own name");
    }

    /// <summary>
    /// The ordinary receipt's bytes are a frozen contract with the Host: the upgrade fields exist only on the upgrade
    /// path, so a plain purchase publishes exactly the keys it published before.
    /// </summary>
    [Fact]
    public void TheUpgradeFieldsAreAbsentFromAnOrdinaryReceipt()
    {
        ExecutionManager
            .ShopToolUpgradeEvidence(
                upgradedToolId: null,
                daysLeftForToolUpgrade: 0,
                requiredToolQualifiedId: CopperHoe,
                requiredToolBefore: 1,
                requiredToolAfter: 0,
                purchaseDialogue: "none")
            .Should()
            .BeEmpty("an ordinary purchase's detail is an exact key set the Host rules on, so it gains no field");

        ExecutionManager
            .ShopToolUpgradeEvidence(SteelHoe, 2, CopperHoe, 1, 0, "closed")
            .Should()
            .Be(
                ";tool_upgraded=(T)SteelHoe;days_left=2;required_tool=(T)CopperHoe;required_before=1;required_after=0;purchase_dialogue=closed",
                "the Host's rule declares these five keys, and this is their one spelling");
    }
}
