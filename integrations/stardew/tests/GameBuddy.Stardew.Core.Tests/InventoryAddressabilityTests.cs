using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// TWO CROSSINGS between the surfaces that publish an action and the facts a caller must be SHOWN to call it.
///
/// <para>
/// <b>Why this exists.</b> A live run ended with <c>place_owned_object</c> refused while <c>craft_item</c> succeeded, and
/// the inference drawn from that pair was "the crafted item has no backpack slot the plan can name, so
/// <c>DiscoverInventoryItemFacts</c>'s five-capability gate must be widened". The inference was wrong, and cheaply so:
/// the shipped journal (<c>tools/body-program-journal/journal.json</c>, program <c>plan_20_e2a98045f7d5667c</c>) shows
/// the node was given <c>slot=8</c> and refused <c>place_owned_object_unsupported_item</c> - the slot WAS named, and
/// <c>TryDescribePlacementSource</c> refused the ITEM because a path is neither a bigCraftable nor Furniture. Correlation
/// between two receipts was read as cause, and the fix it pointed at would have published 36 rows on every observation
/// to answer a question that was already answered.
/// </para>
/// <para>
/// So neither test below is about that run. Each is a property over a population DERIVED from an authority, so the next
/// member added to either surface is covered without editing this file.
/// </para>
/// </summary>
public sealed class InventoryAddressabilityTests
{
    /// <summary>
    /// EVERY ACTION THAT TAKES A <c>slot</c> ARGUMENT HAS A PUBLISHED SOURCE FOR IT.
    ///
    /// <para>
    /// The population is <c>action-surface.v1.json</c> - the generated descriptor artifact, i.e. what the companion is
    /// told exists. An action added later with a <c>slot</c> argument and no way to be given one fails here by name,
    /// which is the defect this gate exists for: an action whose only addressing fact is behind a capability list that
    /// does not include it is an action that cannot be called at all.
    /// </para>
    /// <para>
    /// <b>What counts as a source.</b> Two things, and both are read from an authority rather than listed here:
    /// </para>
    /// <list type="bullet">
    ///   <item>a SNAPSHOT FAMILY whose rows carry a backpack-slot property and which
    ///       <c>CreateBridgeSnapshot</c> publishes for this action (ungated, or gated on a capability list that names
    ///       it). The wire row shapes come from <c>protocol/bridge-v1.schema.json</c>; the capability gates come from
    ///       the Mod's own call site.</item>
    ///   <item>the SCALAR <c>currentToolSlot</c>, for an action whose handler requires the slot to be the held one.
    ///       That requirement is not a guess: it is what the action's own published <c>slot</c> description declares,
    ///       in the one sentence <see cref="HeldSlotClaim"/> matches.</item>
    /// </list>
    /// <para>
    /// <b>Why the scalar counts.</b> <c>currentToolSlot</c> is published unconditionally, so an action that must name the
    /// held slot already has its addressing fact. The earlier reading of this defect counted families only and so
    /// reported <c>dress_mannequin</c> and five of its siblings as unsourced, when in fact their handler refuses unless
    /// <c>CurrentToolIndex == slot</c> - the number they need is on the wire on every snapshot.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryActionThatTakesASlotHasAPublishedSourceForIt()
    {
        IReadOnlyList<CatalogAction> actions = SlotTakingActions();
        actions.Should().NotBeEmpty("the catalog must declare actions that take a slot, or this gate reads nothing");

        IReadOnlyDictionary<string, SnapshotFamily> families = PublishedFamilies();
        families.Should().NotBeEmpty("CreateBridgeSnapshot must publish snapshot families");

        List<string> unsourced = new();
        foreach (CatalogAction action in actions)
        {
            List<string> sources = SourcesFor(action, families);
            if (sources.Count == 0)
                unsourced.Add($"{action.ActionId} (slot declared as \"{action.SlotDescription}\")");
        }

        unsourced.Should().BeEmpty(
            "every action that declares a `slot` argument must have a published fact a caller can copy that number "
                + "from. An action with none cannot be called at all, and the remedy is to publish its addressing fact "
                + "or stop advertising the action - never to widen an unrelated family:\n  "
                + string.Join("\n  ", unsourced));
    }

    /// <summary>
    /// EVERY FIELD THE MOD'S <c>BridgeSnapshot</c> DECLARES REACHES BOTH THE WIRE SCHEMA AND THE HOST'S TYPE.
    ///
    /// <para>
    /// The Mod's record is the producer; <c>protocol/bridge-v1.schema.json</c> is what any non-TypeScript consumer
    /// validates against, and <c>Snapshot</c> in <c>host/src/protocol.ts</c> is what every TypeScript reader sees. A
    /// field present in the record and absent from either is published by the Mod and then silently dropped - the
    /// failure shape that is invisible precisely because nothing errors.
    /// </para>
    /// <para>
    /// Found this way: <c>CurrentToolSlotItem</c> was declared on the record, populated at the call site, and named in
    /// the Host's <c>SNAPSHOT_KEYS</c> allowlist - and it appeared in neither the schema (whose
    /// <c>additionalProperties: false</c> made it unshippable to a schema consumer) nor the <c>Snapshot</c> interface
    /// (so no TypeScript reader could type it). The held-slot actions refuse unless the named slot holds the exact item
    /// AND is the held one, so the slot's OCCUPANT is the half that was missing.
    /// </para>
    /// <para>
    /// The population is the record's own parameter list, read from source, so a field added tomorrow is covered
    /// without editing this test. The name crossing is the serializer's: <c>BridgeProtocol.JsonOptions</c> uses
    /// camelCase and the record carries no <c>JsonPropertyName</c>, which is asserted rather than assumed.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryFieldTheModPublishesReachesTheSchemaAndTheHostType()
    {
        IReadOnlyList<string> recordFields = BridgeSnapshotFieldNames();
        recordFields.Should().NotBeEmpty("BridgeSnapshot must declare fields");
        recordFields.Should().Contain(
            "CurrentToolSlotItem",
            "the record's own declaration is the authority this test reads; a rename must be seen here");

        HashSet<string> schemaFields = SchemaSnapshotFieldNames();
        HashSet<string> interfaceFields = SnapshotInterfaceFieldNames();
        schemaFields.Should().NotBeEmpty("the schema must declare snapshot fields");
        interfaceFields.Should().NotBeEmpty("the Host's Snapshot type must declare members");

        string camelCased = string.Join(
            ", ",
            recordFields.Where(field => !schemaFields.Contains(CamelCase(field)) || !interfaceFields.Contains(CamelCase(field))));

        recordFields
            .Where(field => !schemaFields.Contains(CamelCase(field)))
            .Should()
            .BeEmpty(
                "every field BridgeSnapshot declares must be declared by protocol/bridge-v1.schema.json, whose "
                    + "additionalProperties:false refuses a snapshot that carries one it does not know. Missing: "
                    + camelCased);

        recordFields
            .Where(field => !interfaceFields.Contains(CamelCase(field)))
            .Should()
            .BeEmpty(
                "every field BridgeSnapshot declares must be a member of the Snapshot type in host/src/protocol.ts, "
                    + "or the Mod publishes it and every TypeScript reader drops it. Missing: "
                    + camelCased);
    }

    /// <summary>
    /// The two directions of the same crossing, stated once so a rename cannot pass through both halves.
    ///
    /// A schema field with no record parameter is a field the Mod can never populate; an interface member with no record
    /// parameter is a field every reader types and nothing produces. Both are the same defect from the other side.
    /// </summary>
    [Fact]
    public void NeitherTheSchemaNorTheHostTypeDeclaresAFieldTheModCannotPublish()
    {
        HashSet<string> recordFields = BridgeSnapshotFieldNames().Select(CamelCase).ToHashSet(StringComparer.Ordinal);

        SchemaSnapshotFieldNames()
            .Where(field => !recordFields.Contains(field))
            .Should()
            .BeEmpty("the schema declares snapshot fields the Mod's BridgeSnapshot cannot populate");

        SnapshotInterfaceFieldNames()
            .Where(field => !recordFields.Contains(field))
            .Should()
            .BeEmpty("the Host's Snapshot type declares members the Mod's BridgeSnapshot cannot populate");
    }

    // ---- the population, derived from the authorities ---------------------------------------------------

    /// <summary>The one sentence an action's own <c>slot</c> description uses when the slot must be the held one.</summary>
    private static readonly Regex HeldSlotClaim = new(
        "must also be `snapshot\\.currentToolSlot`",
        RegexOptions.CultureInvariant);

    /// <summary>Every catalog action declaring a <c>slot</c> argument, with that argument's published meaning.</summary>
    private static IReadOnlyList<CatalogAction> SlotTakingActions()
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(CatalogPath()));
        List<CatalogAction> actions = new();
        foreach (JsonElement action in document.RootElement.GetProperty("actions").EnumerateArray())
        {
            if (!action.TryGetProperty("argumentSchema", out JsonElement schema)) continue;
            if (!schema.TryGetProperty("slot", out JsonElement slot)) continue;
            string description = slot.TryGetProperty("description", out JsonElement text)
                ? text.GetString() ?? string.Empty
                : string.Empty;
            // Whether the action consumes a TOOL is its own `tool:<category>` claim, not this test's opinion: that
            // claim is what the handler selects from, and what `toolSlots` can therefore address a slot for.
            bool toolClaim = action.TryGetProperty("resourceTemplate", out JsonElement template)
                && template.TryGetProperty("claims", out JsonElement claims)
                && claims.EnumerateArray().Any(claim =>
                    claim.GetProperty("key").GetString()?.StartsWith("tool:", StringComparison.Ordinal) == true);
            actions.Add(new CatalogAction(action.GetProperty("actionId").GetString()!, description, toolClaim));
        }

        return actions;
    }

    /// <summary>
    /// The snapshot families <c>CreateBridgeSnapshot</c> publishes, each with the capability list that gates it.
    ///
    /// An empty <see cref="SnapshotFamily.Capabilities"/> means the family is published on every snapshot, which is a
    /// strictly wider source than a gated one.
    /// </summary>
    private static IReadOnlyDictionary<string, SnapshotFamily> PublishedFamilies()
    {
        string controller = File.ReadAllText(RepositoryPath(Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.cs")));
        string models = File.ReadAllText(RepositoryPath(Path.Combine("integrations", "stardew", "src", "Core", "Models", "BridgeProtocolModels.cs")));
        IReadOnlyList<string> parameterNames = BridgeSnapshotParameterNames(models);
        IReadOnlyList<string> arguments = CallArguments(controller, "return new BridgeSnapshot(");

        HashSet<string> schemaFamilies = SchemaArrayFamilies();
        Dictionary<string, SnapshotFamily> families = new(StringComparer.Ordinal);
        for (int index = 0; index < arguments.Count && index < parameterNames.Count; index++)
        {
            string parameter = parameterNames[index];
            // A named argument states its own parameter; a positional one takes the record's declaration order.
            Match named = Regex.Match(arguments[index], "^([A-Za-z][A-Za-z0-9_]*):\\s*(?s)(.*)$", RegexOptions.CultureInvariant);
            string field = named.Success ? named.Groups[1].Value : parameter;
            string value = named.Success ? named.Groups[2].Value : arguments[index];
            string camel = CamelCase(field);
            if (!schemaFamilies.Contains(camel)) continue;
            families[camel] = new SnapshotFamily(
                camel,
                value
                    .Split(new[] { "Contains(\"" }, StringSplitOptions.None)
                    .Skip(1)
                    .Select(part => part.Split('"')[0])
                    .Distinct(StringComparer.Ordinal)
                    .ToArray());
        }

        return families;
    }

    /// <summary>
    /// Every published fact that could supply one action's <c>slot</c>: the backpack-slot families the snapshot
    /// carries for it, plus the scalar held-slot index when the action's own description demands it.
    /// </summary>
    private static List<string> SourcesFor(CatalogAction action, IReadOnlyDictionary<string, SnapshotFamily> families)
    {
        List<string> sources = new();
        // The scalar is published unconditionally on every snapshot, and an action whose own surface says the slot must
        // EQUAL it can name the number from it. Reading the requirement off the description keeps this in step with the
        // surface: an action that stops demanding the held slot stops counting on it here.
        if (HeldSlotClaim.IsMatch(action.SlotDescription)) sources.Add("currentToolSlot");

        IReadOnlyDictionary<string, IReadOnlyList<string>> rowProperties = SchemaRowProperties();
        foreach (SnapshotFamily family in families.Values)
        {
            if (!rowProperties.TryGetValue(family.Field, out IReadOnlyList<string>? properties)) continue;
            // `toolSlots` is the TOOL index: it addresses a slot for an action that consumes a tool, which the action's
            // own `tool:<category>` claim declares, and for no other action. An item action cannot name its item's slot
            // there, which is why the surface says so in the item actions' own argument descriptions.
            if (family.Field == "toolSlots" && !action.DeclaresToolClaim && !HeldSlotClaim.IsMatch(action.SlotDescription))
                continue;
            bool carriesBackpackSlot = properties.Any(property =>
                (property == "slot" || property.EndsWith("Slot", StringComparison.Ordinal))
                && !NotABackpackSlot.Contains(property));
            if (!carriesBackpackSlot) continue;
            // Ungated, or gated on a list that names this action. A family gated on somebody else's capability is not a
            // source for this action: it is absent from exactly the snapshots this action is advertised in.
            if (family.Capabilities.Count > 0 && !family.Capabilities.Contains(action.ActionId, StringComparer.Ordinal))
                continue;
            sources.Add(family.Field);
        }

        return sources;
    }

    /// <summary>
    /// Row properties that end in <c>Slot</c> and are NOT a backpack index. Each is a different noun, so the exclusion
    /// is declared rather than inferred from the name - a new <c>*Slot</c> property is treated as a backpack slot until
    /// someone says otherwise here, which is the failure direction that surfaces a wrong assumption.
    /// </summary>
    private static readonly HashSet<string> NotABackpackSlot = new(StringComparer.Ordinal)
    {
        // The actor's own body slots (hat/shirt/pants/boots/left_ring/right_ring), named by equip_wearable's target.
        "bodySlot",
        // The sewing machine's two ingredient slots, which the machine owns rather than the backpack.
        "leftSlot",
        "rightSlot",
    };

    // ---- the sources each assertion reads ---------------------------------------------------------------

    private static IReadOnlyList<string> BridgeSnapshotParameterNames(string models)
    {
        // Comments first: the record is heavily documented, and a prose line such as "// ... state ..." parses as a
        // parameter name once the declaration is split on commas.
        models = StripLineComments(models);
        int start = models.IndexOf("public sealed record BridgeSnapshot(", StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "BridgeSnapshot must be declared in the Core models");
        int open = models.IndexOf('(', start);
        int close = MatchingClose(models, open, '(', ')');
        return TopLevelSegments(models.Substring(open + 1, close - open - 1))
            .Select(segment => Regex.Match(segment.Split('=')[0], "([A-Za-z_][A-Za-z0-9_]*)\\s*$", RegexOptions.CultureInvariant))
            .Where(match => match.Success)
            .Select(match => match.Groups[1].Value)
            .ToArray();
    }

    private static IReadOnlyList<string> BridgeSnapshotFieldNames() =>
        BridgeSnapshotParameterNames(
            File.ReadAllText(RepositoryPath(Path.Combine("integrations", "stardew", "src", "Core", "Models", "BridgeProtocolModels.cs"))));

    /// <summary>The snapshot properties the language-neutral schema declares, which its closed shape makes exhaustive.</summary>
    private static HashSet<string> SchemaSnapshotFieldNames()
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(SchemaPath()));
        return document.RootElement
            .GetProperty("$defs")
            .GetProperty("snapshot")
            .GetProperty("properties")
            .EnumerateObject()
            .Select(property => property.Name)
            .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>The snapshot properties that are ARRAYS of row objects, i.e. the families.</summary>
    private static HashSet<string> SchemaArrayFamilies()
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(SchemaPath()));
        HashSet<string> families = new(StringComparer.Ordinal);
        foreach (JsonProperty property in document.RootElement.GetProperty("$defs").GetProperty("snapshot").GetProperty("properties").EnumerateObject())
            if (property.Value.TryGetProperty("items", out JsonElement items) && items.TryGetProperty("$ref", out _))
                families.Add(property.Name);
        return families;
    }

    /// <summary>Each family's row properties, resolved through the schema's own <c>$ref</c>.</summary>
    private static IReadOnlyDictionary<string, IReadOnlyList<string>> SchemaRowProperties()
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(SchemaPath()));
        JsonElement definitions = document.RootElement.GetProperty("$defs");
        Dictionary<string, IReadOnlyList<string>> rows = new(StringComparer.Ordinal);
        foreach (JsonProperty property in definitions.GetProperty("snapshot").GetProperty("properties").EnumerateObject())
        {
            if (!property.Value.TryGetProperty("items", out JsonElement items)) continue;
            if (!items.TryGetProperty("$ref", out JsonElement reference)) continue;
            string name = reference.GetString()!;
            name = name.Substring(name.LastIndexOf('/') + 1);
            if (!definitions.TryGetProperty(name, out JsonElement definition)) continue;
            if (!definition.TryGetProperty("properties", out JsonElement properties)) continue;
            rows[property.Name] = properties.EnumerateObject().Select(member => member.Name).ToArray();
        }

        return rows;
    }

    /// <summary>The members of <c>Snapshot</c> in the Host's protocol module, read from its own declaration.</summary>
    private static HashSet<string> SnapshotInterfaceFieldNames()
    {
        string protocol = File.ReadAllText(RepositoryPath(Path.Combine("host", "src", "protocol.ts")));
        const string Declaration = "export type Snapshot = Readonly<{";
        int start = protocol.IndexOf(Declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "the Host must declare the Snapshot type");
        int end = protocol.IndexOf("\n}>;", start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start, "the Snapshot declaration must be closed");
        string body = protocol.Substring(start, end - start);
        // A member is a two-space-indented `name:` or `name?:`; nested row shapes are indented further.
        return Regex.Matches(body, "^\\s{2}([a-zA-Z][A-Za-z0-9_]*)\\??:", RegexOptions.Multiline | RegexOptions.CultureInvariant)
            .Select(match => match.Groups[1].Value)
            .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>The arguments of one call, comment-stripped and split at its own top level.</summary>
    private static IReadOnlyList<string> CallArguments(string source, string callPrefix)
    {
        int start = source.IndexOf(callPrefix, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{callPrefix} must exist");
        int open = source.IndexOf('(', start);
        int close = MatchingClose(source, open, '(', ')');
        return TopLevelSegments(StripLineComments(source.Substring(open + 1, close - open - 1)));
    }

    // ---- small text helpers ------------------------------------------------------------------------------

    /// <summary>
    /// The serializer's own crossing: <c>BridgeProtocol.JsonOptions</c> names every field camelCase, and the record
    /// carries no per-property override that would escape it.
    /// </summary>
    private static string CamelCase(string name) => char.ToLowerInvariant(name[0]) + name.Substring(1);

    private static int MatchingClose(string text, int open, char opening, char closing)
    {
        int depth = 0;
        for (int index = open; index < text.Length; index++)
        {
            if (text[index] == opening) depth++;
            else if (text[index] == closing && --depth == 0) return index;
        }

        throw new InvalidOperationException($"{opening} at {open} is not closed");
    }

    private static IReadOnlyList<string> TopLevelSegments(string text)
    {
        List<string> segments = new();
        int depth = 0;
        int start = 0;
        for (int index = 0; index < text.Length; index++)
        {
            char character = text[index];
            if (character is '(' or '[' or '{') depth++;
            else if (character is ')' or ']' or '}') depth--;
            else if (character == ',' && depth == 0)
            {
                segments.Add(text.Substring(start, index - start));
                start = index + 1;
            }
        }

        if (start < text.Length) segments.Add(text.Substring(start));
        return segments.Select(segment => segment.Trim()).Where(segment => segment.Length > 0).ToArray();
    }

    /// <summary>
    /// Strip `//` line comments before splitting: the call site is heavily commented and a comment carrying a paren or a
    /// comma would move both the call's closing paren and the argument boundaries.
    /// </summary>
    private static string StripLineComments(string text) => string.Join(
        "\n",
        text.Split('\n').Select(line =>
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            return comment == -1 ? line : line.Substring(0, comment);
        }));

    // ---- repository paths --------------------------------------------------------------------------------

    private static string SchemaPath() => RepositoryPath(Path.Combine("protocol", "bridge-v1.schema.json"));

    private static string CatalogPath() => RepositoryPath(
        Path.Combine("integrations", "stardew", "action-development", "contracts", "generated", "action-surface.v1.json"));

    private static string RepositoryPath(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null) throw new InvalidOperationException("repository root not found");
        return Path.Combine(directory.FullName, relative);
    }

    private sealed record CatalogAction(string ActionId, string SlotDescription, bool DeclaresToolClaim);

    private sealed record SnapshotFamily(string Field, IReadOnlyList<string> Capabilities);
}
