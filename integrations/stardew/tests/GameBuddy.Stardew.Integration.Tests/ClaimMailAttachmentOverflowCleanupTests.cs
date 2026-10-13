using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `claim_mail_attachment`'s overflow residual contract.
///
/// SEAM. The claim is `GameLocation.mailbox()` (GameLocation.cs:10547) and the letter it
/// opens finishes through ITS OWN exit path -- `LetterViewerMenu.cleanupBeforeExit`
/// hands the letter's `%item` attachment to `Farmer.addItemsByMenuIfNecessary`
/// (LetterViewerMenu.cs:1030) -- so the delivery step is not touched here.
///
/// THE RESIDUAL. `addItemsByMenuIfNecessary` gives what the inventory can take to the
/// player and turns the rest into `ItemGrabMenu.CreateOverflowMenu` (Farmer.cs:4512-4522).
/// Because the letter is STILL `Game1.activeClickableMenu` while its `cleanupBeforeExit`
/// runs -- `IClickableMenu.exitThisMenu` runs cleanup at :868 and only nulls the menu at
/// :875 -- that overflow is appended to `Game1.nextClickableMenu`, never set active. It
/// drains into the active menu on the next tick (Game1.cs:1711-1715) and from then on
/// freezes the actor, so every following action is refused `player_not_actionable` until
/// it is cleared.
///
/// WHAT THIS FILE PINS. The body must read the QUEUE as well as the active menu, and clear
/// both AFTER the letter's own delivery, so the actor is actionable again. The clearance
/// adds no evidence key: the Host's exact-shape contract for this action
/// (host/src/stardew-game-integration-adapter.ts) names `collection_overflow_pending`
/// plus exactly the eighteen other keys, so the receipt keeps that shape.
/// </summary>
public sealed class ClaimMailAttachmentOverflowCleanupTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.itemtileactions.cs";

    /// <summary>
    /// The residual is detected by reading BOTH places it can sit: the active menu (the
    /// case where the game had already drained the queue) and -- the case the letter's own
    /// exit actually produces -- the `Game1.nextClickableMenu` queue the overflow is
    /// appended to while the letter is still the active menu.
    /// </summary>
    [Fact]
    public void ClaimMailAttachment_ReadsTheOverflowQueue_NotOnlyTheActiveMenu()
    {
        string source = ReadHandlerSource();
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalClaimMailAttachment(");
        string bodyCode = StripLineComments(body);

        bodyCode.Should().Contain(
            "Game1.activeClickableMenu is StardewValley.Menus.ItemGrabMenu",
            "the residual can already be the active menu");
        bodyCode.Should().Contain(
            "Game1.nextClickableMenu",
            "the letter's own exit queues its overflow into Game1.nextClickableMenu, where an active-menu-only detector cannot see it");
        // The detector must read the QUEUE and filter it to the overflow kind - a bare count would clear any
        // queued menu, not just this action's residual (parent narrowing replaced `Count > 0` with an
        // ItemGrabMenu filter to honor that).
        bodyCode.Should().Contain(
            "Game1.nextClickableMenu.Any(menu => menu is StardewValley.Menus.ItemGrabMenu)",
            "the queue check must be for the overflow kind, not any queued menu");
        bodyCode.Should().NotContain(
            "bool claimOverflowPending = Game1.activeClickableMenu is StardewValley.Menus.ItemGrabMenu;",
            "the active-menu-only detector never fires for the queued overflow the defect leaves behind");
    }

    /// <summary>
    /// The clearance is the native close plus the queue drain, and it runs AFTER the letter
    /// finished its own exit -- so it clears the residual rather than discarding an
    /// attachment the letter has not yet delivered.
    /// </summary>
    [Fact]
    public void ClaimMailAttachment_ClearsTheResidualAfterTheLetterDelivered_SoTheActorIsActionable()
    {
        string source = ReadHandlerSource();
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalClaimMailAttachment(");
        string bodyCode = StripLineComments(body);

        string guard = MethodBody(body, "if (claimOverflowPending)");
        guard.Should().Contain(
            "Game1.exitActiveMenu();",
            "an active residual menu is closed through the same native step shop_purchase uses");
        guard.Should().Contain(
            "Game1.nextClickableMenu.Clear();",
            "the queued overflow the letter leaves behind is otherwise drained into the active menu on the next tick and freezes the actor");

        int delivery = body.IndexOf("openedLetter.exitThisMenu();", StringComparison.Ordinal);
        int clearance = body.IndexOf("if (claimOverflowPending)", StringComparison.Ordinal);
        delivery.Should().BeGreaterThanOrEqualTo(0, "the letter must still finish through its own exit path");
        clearance.Should().BeGreaterThan(
            delivery,
            "the residual is only cleared after the letter's own exit delivered the attachment");

        // The clearance reports itself through the key the Host already knows, and adds none.
        body.Should().Contain("collection_overflow_pending={claimOverflowPending");
        bodyCode.Should().NotContain("overflow_cleaned");
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

    /// <summary>Drop <c>//</c>/<c>///</c> comments so the pins test code, not prose.</summary>
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
