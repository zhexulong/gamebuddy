using System;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The lantern action takes the tool its own registration claims.
///
/// <para>
/// Measured 2026-11-06: <c>toggle_tool_light</c> refused unless the actor was already holding the lantern, while the
/// pack carried one - the same defect the nine declared-tool actions were repaired of, surviving only because this
/// action's requirement was a tool subclass no category word named. The population-wide half lives in
/// <see cref="ToolPreconditionUniformityTests"/> and <see cref="DeclaredToolSelectionTests"/>; this file pins the one
/// action, in the handler that would drift.
/// </para>
/// </summary>
public sealed class ToolLightActionTests
{
    private const string Handler = "integrations/stardew/farmhandexecutioncontroller.facilityactions.cs";
    private const string Signature = "public LocalExecutionReceipt RequestLocalToggleToolLight(";

    [Fact]
    public void Catalog_DeclaresTheLanternAndPublishesTheAutoSelectedSlotContract()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(entry => entry.ActionId == "toggle_tool_light");

        registration.Descriptor!.ResourceTemplate.Should().Contain(
            new FarmhandActionResourceTemplateClaim("tool:lantern", FarmhandResourceTemplateValue.AnyUpgrade),
            "the handler takes the lantern its own row declares, and the row is where the caller learns it exists");
        FarmhandActionCatalog.ToolEnum.Should().Contain(
            "lantern",
            "the word in the claim is the same vocabulary `equip_tool` and `toolSlots[].category` speak");
        // The held-slot sentence is the OTHER shape, and an action that publishes it has told the planner the slot is a
        // precondition on the hand. This one no longer has that precondition.
        registration.Descriptor.Arguments.Single(argument => argument.Name == "slot").Description
            .Should().Contain("need NOT be `snapshot.currentToolSlot`")
            .And.NotContain("must also be `snapshot.currentToolSlot`");
    }

    [Fact]
    public void Handler_TakesTheLanternFromThePackAndPutsTheActorsSelectionBack()
    {
        string body = MethodBody(ReadHandler(), Signature);

        int selected = body.IndexOf("TrySelectDeclaredTool(Game1.player, \"toggle_tool_light\"", StringComparison.Ordinal);
        int native = body.IndexOf("lantern.DoFunction(", StringComparison.Ordinal);
        int @finally = body.IndexOf("finally", StringComparison.Ordinal);
        int restore = body.IndexOf("RestoreToolSelection(Game1.player, selection)", StringComparison.Ordinal);

        selected.Should().BeGreaterThanOrEqualTo(0, "the lantern is the action's own claim, not the caller's guess");
        native.Should().BeGreaterThan(selected, "the native toggle runs with the declared tool in hand");
        @finally.Should().BeGreaterThan(native, "the restore is unconditional, so it cannot sit on the success path");
        restore.Should().BeGreaterThan(@finally, "the restore lives inside that finally");

        // NEGATIVE: the refusal this replaced is unreachable for a pack that holds a lantern, so neither spelling of
        // "the tool must already be in your hand" may survive here.
        body.Should().NotContain("CurrentToolIndex");
        body.Should().NotContain("not_equipped");
        // The refusal that survives is the resolver's own `tool_not_owned:lantern`, produced from the claim.
        body.Should().Contain("toolRefusalCode");
    }

    [Fact]
    public void Handler_KeepsTheReceiptShapeTheHostValidates()
    {
        // The Host pins this action's success evidence to the exact key set `slot;was_on;is_on`. Adding a selection fact
        // here would make every success unverifiable, so the selection is proved by the tests above instead.
        string body = MethodBody(ReadHandler(), Signature);

        body.Should().Contain("$\"slot={selection.Slot};was_on={wasOn.ToString().ToLowerInvariant()};is_on={isOn.ToString().ToLowerInvariant()}\"");
        body.Should().NotContain("tool_selected=");
        body.Should().NotContain("tool_restored=");
    }

    private static string ReadHandler() => File.ReadAllText(RepositoryPath(Handler));

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");

        int depth = 0;
        for (int position = opening; position < source.Length; position++)
        {
            if (source[position] == '{') depth++;
            else if (source[position] == '}' && --depth == 0)
                return source.Substring(opening, position - opening + 1);
        }

        throw new InvalidOperationException("the handler body is not balanced");
    }

    private static string RepositoryPath(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return Path.Combine(directory.FullName, relative);
    }
}
