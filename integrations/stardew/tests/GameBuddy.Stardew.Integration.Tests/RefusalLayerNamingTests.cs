using System.Globalization;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gate for `blocked_by`: a refusal that knows a layer must NAME it, and the vocabulary it names it with is closed.
///
/// <para>
/// The defect class this exists for is one shape seen many times: the Mod answers `no_native_path` with
/// `blocked_by=none` (or with a bare reason code) about a world it could have described. A model cannot adapt from
/// `none` - it re-aims at a neighbouring tile instead, which is what the 2026-11-01 and 2026-11-02 runs recorded - so
/// every refusal path that already knows what is missing has to say it.
/// </para>
/// <para>
/// <b>Population.</b> Nothing here is a hand-written list of actions:
/// <list type="bullet">
/// <item>the declared layers come from <see cref="FarmhandActionCatalog.Registrations"/> - the tool claims, the pinned
/// items and the approach requirements the actions themselves publish;</item>
/// <item>the world layers are driven through the probe with a real (empty or single-object) <see cref="GameLocation"/>;</item>
/// <item>the refusal paths come from the <c>NoNativePathReasonCode</c> mint shapes in the Mod's own source;</item>
/// <item>the vocabulary comes from <see cref="RefusalLayerKind"/> itself, never from a list of words written here.</item>
/// </list>
/// Adding an action that declares a tool, or a refusal path that mints `no_native_path`, enrols it automatically.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the source-shape pins read the Mod's own text to keep the refusal vocabulary closed, while the
// behaviour tests drive the layer probe with real tiles to see which layer names itself; one guards invention, the other lying.
public sealed class RefusalLayerNamingTests
{
    /// <summary>
    /// Sites that render the field through a shared helper instead of inline. Kept per HELPER, not per site, and each
    /// entry is verified against its own body by <see cref="EveryFieldRenderingHelperStillEmitsTheField"/> - so an entry
    /// cannot rot, and a new helper that wants credit has to be added here and in one place in the Mod.
    /// </summary>
    private static readonly string[] FieldRenderingHelpers =
    {
        "DescribeDeclaredToolRefusal",
        "DescribeApproachRange",
        "DescribeClumpToolRefusal",
        "DescribeClumpTargetRefusal",
        "GeodeRefusal",
        // The furniture-and-decoration lane's one renderer: two of its refusals are produced by a shared
        // `TryDescribe*` predicate, so the field has to be rendered where the CALL is for the gate to see it.
        "DescribeRefusalLayer",
    };

    /// <summary>
    /// The number of refusal sites that named no layer when this gate was written, recorded so it can only fall.
    ///
    /// <para>
    /// Most of these are not world preconditions at all - `invalid_deadline`, `stale_revision`, a request whose target
    /// moved - and they will never name a layer, which is why the record is a budget rather than a target of zero. What
    /// it exists to stop is a NEW refusal path joining them silently: a handler that mints a bare rejection fails here
    /// with its own file and line, in the commit that adds it, instead of in a live run three weeks later.
    /// </para>
    /// <para>
    /// RAISED FROM 539 TO 546 by `pet_farm_animal`, and the seven sites are named rather than absorbed: the seven
    /// `RememberTerminal(..., Rejected, ...)` calls in its request/execution bodies (the scope proof, `world_not_ready`,
    /// `farm_animal_target_gone` twice, the shared `FarmAnimalPetRefusal` result twice, and `target_out_of_reach`).
    /// None of them can name a layer: the day marker, the held Golden Animal Cracker and the 19:00 clock are not world
    /// layers in the closed vocabulary, and inventing a word for them would give the model a token that names no
    /// countermeasure.
    /// </para>
    /// </summary>
    private const int RecordedBare = 546;

    [Fact]
    public void TheLayerVocabularyIsClosedAndWireShaped()
    {
        // The words ARE the enum: one declaration, and the switch that renders it throws for anything else, so a layer
        // the Mod could not name is a programming error rather than a token nobody declared.
        RefusalLayerKind[] layers = Enum.GetValues<RefusalLayerKind>();
        layers.Should().HaveCount(14, "every layer the probe asks has exactly one wire word");
        RefusalLayerKind.None.ToWireValue().Should().Be("none", "the absence of a refusal keeps the word the model already reads");

        IReadOnlyList<string> words = RefusalLayerWire.All;
        words.Should().OnlyHaveUniqueItems("two layers spelled the same word cannot be told apart on the wire");
        words.Should().HaveCount(layers.Length, "the declared set is derived from the enum, not written out again");
        foreach (string word in words)
        {
            word.Should().MatchRegex("^[a-z][a-z_]*$", "a wire word is a token: lowercase, no spaces, no punctuation");
        }
    }

    [Fact]
    public void EveryDeclaredLayerIsEmittedSomewhereInTheMod()
    {
        // A layer declared and never emitted is dead vocabulary - the next reader would trust a word that no refusal can
        // ever carry. The population is the enum, and the message names the member that has no emitter.
        string source = ReadMod();
        foreach (RefusalLayerKind layer in Enum.GetValues<RefusalLayerKind>())
        {
            source.Should().Contain($"RefusalLayerKind.{layer}",
                $"{layer.ToWireValue()} is declared and must be reachable from the probe, or it is not part of the closed set at all");
        }
    }

    [Fact]
    public void EveryDeclaredToolClaimIsNamedWhenThePackCannotSatisfyIt()
    {
        int population = 0;
        var pack = new List<Item?>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (DeclaredToolCategory(registration) is not { } category)
                continue;
            population++;

            RefusalLayerToken token = RefusalProbe.DescribeDeclared(registration, pack);

            token.Layer.Should().Be(RefusalLayerKind.Tool, $"{registration.ActionId} declares tool:{category} and an empty pack cannot satisfy it");
            token.Detail.Should().Be(category, $"{registration.ActionId}'s token names the category its OWN row declares");
            AssertWireBounded(token.Format());
        }
        population.Should().BeGreaterThan(0, "the population comes from the catalog; zero means the derivation stopped matching");
    }

    [Fact]
    public void AToolThePackSatisfiesIsNotBlamedForTheRefusal()
    {
        // The inverse of the test above, over the SAME population: a layer may only speak when it actually refuses. A
        // `tool:` token next to a pack that holds the tool would send the caller to fix something already fixed.
        var pack = EveryToolCategory();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (DeclaredToolCategory(registration) is null)
                continue;

            RefusalProbe.DescribeDeclared(registration, pack).Layer
                .Should().NotBe(RefusalLayerKind.Tool, $"{registration.ActionId} claims a tool this pack holds");
        }
    }

    [Fact]
    public void EveryPinnedItemIsNamedWhenThePackDoesNotCarryIt()
    {
        int population = 0;
        var empty = new List<Item?>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Descriptor?.Acceptance?.ExactExpectedQualifiedItemId is not { } pinned)
                continue;
            population++;

            // No tool claim competes here: a pinned item is only interesting for a row that declares no tool, and the
            // probe orders the tool layer first by design.
            if (DeclaredToolCategory(registration) is not null)
                continue;

            RefusalLayerToken token = RefusalProbe.DescribeDeclared(registration, empty);
            token.Layer.Should().Be(RefusalLayerKind.Item, $"{registration.ActionId} pins {pinned} and an empty pack cannot carry it");
            token.Detail.Should().Be(pinned, $"{registration.ActionId}'s token names the id its OWN acceptance facts pin");
            AssertWireBounded(token.Format());

            // And the same row with the item in hand must fall through to the world layers rather than blaming the pack.
            RefusalProbe.DescribeDeclared(registration, new List<Item?> { SeededObject(pinned) }).Layer
                .Should().NotBe(RefusalLayerKind.Item, $"{registration.ActionId} carries {pinned}, so the pack is not the reason");
        }
        population.Should().BeGreaterThan(0, "the population comes from the acceptance facts the catalog declares");
    }

    [Fact]
    public void EveryDeclaredApproachIsNamedWhenTheActorIsOutsideIt()
    {
        int population = 0;
        Vector2 target = new(10f, 10f);
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Descriptor?.Approach is not { WithinTiles: int within } approach)
                continue;
            population++;

            // The BOUNDARY: one tile past the declared distance refuses, the declared distance itself does not. Both
            // readings come from the same row, so a row that widens its relation widens both.
            Vector2 outside = target + new Vector2(within + 1, 0f);
            RefusalLayerToken token = RefusalProbe.DescribeWorld(registration, null, target, outside);
            token.Layer.Should().Be(RefusalLayerKind.Range, $"{registration.ActionId} declares {approach.Relation} within {within} and the actor is {within + 1} away");
            token.Detail.Should().Be($"{approach.Relation}:{within + 1}", "the detail names the declared relation and the measured distance");
            AssertWireBounded(token.Format());

            RefusalProbe.DescribeWorld(registration, null, target, target + new Vector2(within, 0f)).Layer
                .Should().NotBe(RefusalLayerKind.Range, $"{registration.ActionId} allows {within} and the actor is inside it");
        }
        population.Should().BeGreaterThan(0, "the population comes from the approach requirements the catalog declares");
    }

    [Fact]
    public void AnActionThatDeclaresNothingInventsNoRequirement()
    {
        // The other direction of the same gate: the probe must not manufacture a precondition an action does not have.
        // A row with no tool claim, no pinned item and no approach can only be refused by the world, so with no world in
        // scope it must refuse nothing at all - never a `tool:` the caller cannot act on.
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (DeclaredToolCategory(registration) is not null
                || registration.Descriptor?.Acceptance?.ExactExpectedQualifiedItemId is not null
                || registration.Descriptor?.Approach is not null)
                continue;

            RefusalProbe.DescribeDeclared(registration, new List<Item?>()).Refused
                .Should().BeFalse($"{registration.ActionId} declares no tool and no pinned item");
        }
    }

    [Fact]
    public void TheWorldLayersReadTheCollectionsTheEngineHides()
    {
        // A character or a piece of furniture is collision to the engine and nothing else, so each lives in a collection
        // of its own and a probe that reads the obvious two answers `none` about both. Their behaviour needs live NPCs
        // and live content, so this pins the readings where they are written - the same instrument the sibling body
        // controller tests use for predicates that need a real location.
        string source = Read("integrations/stardew/RefusalLayer.cs");
        source.Should().Contain("location.characters", "a villager standing on the tile is a character layer, not `none`");
        source.Should().Contain("location.animals.Values", "a farm animal standing on the tile is a character layer too");
        source.Should().Contain("location.furniture", "furniture lives in its own collection and never in `objects`");
        source.Should().Contain("location.objects.TryGetValue", "an object is the object layer");
        // The map stage needs the WALKING BODY: a location that blocks in its own collision override has no entity and
        // no tile property to find (Mountain's `landslide`, the measured 2026-11-01 case), so dropping the player here
        // silently loses that layer while every other assertion stays green.
        source.Should().Contain("DescribeTerrainLayer(location, tile, player)",
            "the location-constraint layer is only observable through the player's own collision test");

        // And the occupant token is `layer:occupant@tile`, which is the shape this whole field depends on:
        // one bounded token, no spaces, layer first.
        string occupant = new RefusalLayerToken(RefusalLayerKind.ObjectOnTile, "(O)390@4,5").Format();
        occupant.Should().Be("object:(O)390@4,5");
        AssertWireBounded(occupant);
    }

    [Fact]
    public void NoLayerRefusedIsTheWordNoneAndNothingElse()
    {
        // `none` must mean exactly "the probe looked and no layer refused" - never "the probe did not run". An empty
        // location with an actor standing on the tile it asks about is the one world where that is literally true.
        var location = new GameLocation();
        Vector2 tile = new(2f, 3f);

        RefusalProbe.DescribeWorld(null, location, tile, tile).Format().Should().Be("none");
    }

    [Fact]
    public void EveryNoNativePathRefusalNamesALayer()
    {
        // The refusal paths this vocabulary was built for. The population is derived from the mapping itself: every
        // `WalkRefusalCode(...)` call is one reachability verdict, and each must be handed the layer token AND have
        // `blocked_by=` in the evidence it pieces together. The count floor is the guard against the derivation
        // silently matching nothing after a rename.
        string source = Read("integrations/stardew/StardewBodyController.cs");
        var sites = new List<(int Index, string Shape)>();
        const string shape = "WalkRefusalCode(";
        int index = 0;
        while ((index = source.IndexOf(shape, index, StringComparison.Ordinal)) >= 0)
        {
            // The declaration itself is not a site; the three call sites are.
            bool isDeclaration = index >= 20 && source[(index - 20)..index].Contains("static ", StringComparison.Ordinal);
            if (!isDeclaration)
                sites.Add((index, shape));
            index += shape.Length;
        }

        sites.Count.Should().BeGreaterThanOrEqualTo(3,
            "the Mod refuses with `no_native_path` from the flood, the native finder and the resumed clear-approach walk - fewer means this derivation stopped matching");
        foreach ((int site, string _) in sites)
        {
            string window = source[site..Math.Min(source.Length, site + 1200)];
            window.Should().Contain("blocked_by=",
                $"the refusal minted at StardewBodyController.cs:{(LineOf(source, site))} ({shape}) must name the layer it knows");
        }

        // And no site may bypass the mapping: a bare `no_native_path` assignment is a verdict about the MAP, which is
        // exactly what a body standing on the target tile is not. The two shapes below are the ones this file used
        // before the mapping existed.
        source.Should().NotContain("reasonCode = NoNativePathReasonCode;",
            "a reachability verdict must go through WalkRefusalCode so a character in the way is never reported as an absent route");
        source.Should().NotContain("Fail(NoNativePathReasonCode,");
    }

    [Fact]
    public void EveryFieldRenderingHelperStillEmitsTheField()
    {
        // The two helpers the ratchet gives credit to. Crediting a helper that no longer renders the field would hide a
        // whole family of sites behind a green gate, so each entry is checked against its own body.
        string sources = ReadMod();
        foreach (string helper in FieldRenderingHelpers)
        {
            int declaration = sources.IndexOf($"string {helper}(", StringComparison.Ordinal);
            declaration.Should().BeGreaterThanOrEqualTo(0, $"{helper} is credited by {nameof(RefusalNamingRatchet)} and must exist");
            string body = MethodBody(sources, declaration);
            body.Should().Contain("blocked_by=", $"{helper} is credited for rendering the field and must still render it");
            body.Should().Contain("RefusalLayerToken(", $"{helper} renders a layer token, never a hand-written word");
        }
    }

    [Fact]
    public void RefusalNamingRatchet()
    {
        // Every site that can refuse a request, classified by whether it names a layer. The number may only fall: a new
        // handler that mints a bare refusal fails HERE, naming its file and line, while it is still a one-line change.
        int total = 0;
        int covered = 0;
        var bare = new List<string>();
        foreach (string file in ModSourceFiles())
        {
            string source = File.ReadAllText(file);
            int index = 0;
            while ((index = source.IndexOf("RememberTerminal(", index, StringComparison.Ordinal)) >= 0)
            {
                int openParen = index + "RememberTerminal".Length;
                string call = CallSegment(source, openParen);
                if (call.Contains("ExecutionState.Rejected", StringComparison.Ordinal))
                {
                    total++;
                    bool names = call.Contains("blocked_by=", StringComparison.Ordinal)
                        || FieldRenderingHelpers.Any(helper => call.Contains($"{helper}(", StringComparison.Ordinal));
                    if (names)
                        covered++;
                    else
                        bare.Add($"{Path.GetFileName(file)}:{LineOf(source, index)}");
                }
                index = openParen + call.Length;
            }
        }

        string report = $"covered {covered.ToString(CultureInfo.InvariantCulture)} of {total.ToString(CultureInfo.InvariantCulture)}; "
            + $"bare {(total - covered).ToString(CultureInfo.InvariantCulture)}";
        (total - covered).Should().BeLessThanOrEqualTo(RecordedBare,
            $"{report} - a refusal site that names no layer was added: {string.Join(", ", bare.Take(12))}");
    }

    // ---- helpers -------------------------------------------------------------

    private static string? DeclaredToolCategory(FarmhandActionRegistration registration)
    {
        string? key = registration.Descriptor?.ResourceTemplate
            .FirstOrDefault(claim => claim.Key.StartsWith("tool:", StringComparison.Ordinal))?.Key;
        return key is null ? null : key["tool:".Length..];
    }

    /// <summary>A pack holding one tool of every category the selection vocabulary publishes.</summary>
    private static List<Item?> EveryToolCategory() => new()
    {
        SeedTool<Axe>("(T)Axe", 0),
        SeedTool<Pickaxe>("(T)Pickaxe", 0),
        SeedTool<Hoe>("(T)Hoe", 0),
        SeedTool<WateringCan>("(T)WateringCan", 0),
        SeedTool<FishingRod>("(T)FishingRod", 0),
        SeedTool<Shears>("(T)Shears", 0),
        SeedTool<MilkPail>("(T)MilkPail", 0),
        SeedTool<Pan>("(T)Pan", 0),
        SeedTool<MeleeWeapon>("(W)47", 0),
        SeedTool<MeleeWeapon>("(W)4", 0),
        SeedTool<Lantern>("(T)Lantern", 0),
        SeedTool<Raft>("(T)Raft", 0),
    };

    /// <summary>A tool whose identity and level are the only things the declaration is resolved against.</summary>
    private static T SeedTool<T>(string qualifiedItemId, int upgradeLevel)
        where T : Tool
    {
        var tool = (T)FormatterServices.GetUninitializedObject(typeof(T));
        typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(tool, qualifiedItemId);
        typeof(Tool).GetField("upgradeLevel", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(tool, new Netcode.NetInt(upgradeLevel));
        return tool;
    }

    private static StardewValley.Object SeededObject(string qualifiedItemId)
    {
        var item = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
        typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(item, qualifiedItemId);
        return item;
    }

    /// <summary>The bound the field lives inside: one short token, no prose, no line breaks.</summary>
    private static void AssertWireBounded(string token)
    {
        token.Should().NotContain(" ");
        token.Should().NotContain("\n");
        token.Length.Should().BeLessThanOrEqualTo(48, $"`blocked_by={token}` has to stay a token a model can branch on");
    }

    /// <summary>Every production source file of the Mod, tests and build output excluded.</summary>
    private static IReadOnlyList<string> ModSourceFiles()
    {
        string root = RepositorySourcePath(Path.Combine("integrations", "stardew"));
        return Directory.GetFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .OrderBy(file => file, StringComparer.Ordinal)
            .ToArray();
    }

    private static string ReadMod() =>
        string.Join("\n", ModSourceFiles().Select(File.ReadAllText));

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    private static string RepositorySourcePath(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return Path.Combine(directory.FullName, relative);
    }

    private static int LineOf(string source, int index)
    {
        int line = 1;
        for (int position = 0; position < index && position < source.Length; position++)
        {
            if (source[position] == '\n')
                line++;
        }
        return line;
    }

    /// <summary>The balanced call text beginning at <paramref name="openParen"/>.</summary>
    private static string CallSegment(string source, int openParen)
    {
        int depth = 0;
        int position = openParen;
        for (; position < source.Length; position++)
        {
            if (source[position] == '(')
                depth++;
            else if (source[position] == ')' && --depth == 0)
                return source[openParen..(position + 1)];
        }
        return source[openParen..];
    }

    /// <summary>The balanced body of the method whose declaration precedes <paramref name="declaration"/>.</summary>
    private static string MethodBody(string source, int declaration)
    {
        int opening = source.IndexOf('{', declaration);
        opening.Should().BeGreaterThanOrEqualTo(0, "the credited helper must have a body");
        int depth = 0;
        for (int position = opening; position < source.Length; position++)
        {
            if (source[position] == '{')
                depth++;
            else if (source[position] == '}' && --depth == 0)
                return source[opening..(position + 1)];
        }
        throw new InvalidOperationException("method body is not balanced");
    }
}
