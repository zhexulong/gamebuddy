using System.Globalization;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Objects;
using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew;

/// <summary>
/// The closed set of layers a refusal can blame, declared once and in the ORDER the probe asks them.
///
/// <para>
/// `blocked_by` answered only the world question before this existed: it named a map tile, a building footprint or a
/// terrain feature, and everything else a refusal could know about arrived as a bare reason code. A model reading
/// `no_native_path` with `blocked_by=none` cannot tell "you lack the axe" from "an NPC is standing there" from "that
/// machine is full", so it re-aims instead of adapting. Naming the LAYER is the smallest thing that makes a refusal
/// actionable.
/// </para>
/// <para>
/// The members are ordered, and <see cref="RefusalProbe"/> stops at the first one that refuses: an ordered answer is a
/// CAUSE, while a list of everything that happens to be true is a puzzle. The terrain members keep the granularity the
/// engine itself reports (it asks the Back tile, then the Buildings tile, then the location's own collision test), so a
/// map that blocks in its own override stays distinguishable from a wall that is a wall.
/// </para>
/// </summary>
internal enum RefusalLayerKind
{
    /// <summary>No layer refused. Never a stand-in for "the probe did not run".</summary>
    None = 0,

    /// <summary>The tool the action's own registration claims, resolved against the pack.</summary>
    Tool = 1,

    /// <summary>The inventory item the action's own declaration pins.</summary>
    Item = 2,

    /// <summary>A character or farm animal standing on the target tile.</summary>
    Character = 3,

    /// <summary>An object or furniture piece on the target tile.</summary>
    ObjectOnTile = 4,

    /// <summary>The actor is outside the spatial relation the action's registration declares.</summary>
    Range = 5,

    /// <summary>The map's Back tile property refuses the tile.</summary>
    BackTile = 6,

    /// <summary>The map's Buildings tile refuses the tile.</summary>
    BuildingsTile = 7,

    /// <summary>The location's own collision override refuses the tile.</summary>
    LocationConstraint = 8,

    /// <summary>A terrain feature occupies the tile.</summary>
    Terrain = 9,

    /// <summary>A resource clump occupies the tile.</summary>
    Clump = 10,

    /// <summary>A large terrain feature's bounding box covers the tile.</summary>
    Large = 11,

    /// <summary>A building footprint covers the tile.</summary>
    Building = 12,

    /// <summary>
    /// The actor's own stamina cannot pay for the swings the action needs.
    ///
    /// <para>
    /// Not a world layer, and it earned its place the hard way: the engine does not refuse a swing for lack of stamina,
    /// it lets it run negative and then faints the actor (<c>Game1.cs:6452</c>), which halves next day's stamina. A
    /// handler that prices the action and refuses early is naming a fact no other layer can carry, and leaving it bare
    /// made it indistinguishable from "nothing is in the way".
    /// </para>
    /// </summary>
    Stamina = 13,
}

/// <summary>
/// The wire word of each layer, and the whole set as data.
///
/// <para>
/// The switch is exhaustive over <see cref="RefusalLayerKind"/> and throws on anything else, so a layer the Mod cannot
/// render is a programming error rather than a token nobody declared. <see cref="All"/> is derived from the enum, not
/// written out again: the gate reads it to check that every token the probe can emit belongs to the declared set.
/// </para>
/// </summary>
internal static class RefusalLayerWire
{
    internal static string ToWireValue(this RefusalLayerKind layer) => layer switch
    {
        RefusalLayerKind.None => "none",
        RefusalLayerKind.Tool => "tool",
        RefusalLayerKind.Item => "item",
        RefusalLayerKind.Character => "character",
        RefusalLayerKind.ObjectOnTile => "object",
        RefusalLayerKind.Range => "range",
        RefusalLayerKind.BackTile => "back_tile",
        RefusalLayerKind.BuildingsTile => "buildings_tile",
        RefusalLayerKind.LocationConstraint => "location_constraint",
        RefusalLayerKind.Terrain => "terrain",
        RefusalLayerKind.Clump => "clump",
        RefusalLayerKind.Large => "large",
        RefusalLayerKind.Building => "building",
        RefusalLayerKind.Stamina => "stamina",
        _ => throw new ArgumentOutOfRangeException(nameof(layer)),
    };

    /// <summary>Every word <see cref="RefusalLayerKind"/> can put on the wire, in declaration order.</summary>
    internal static IReadOnlyList<string> All { get; } = Array.AsReadOnly(
        Enum.GetValues<RefusalLayerKind>().Select(static layer => layer.ToWireValue()).ToArray());
}

/// <summary>
/// One layer answer: the layer that refused, and the bounded detail that makes it specific.
///
/// <para>
/// The detail is what turns "blocked" into "blocked by this": the tool category, the item id, the occupant's name or
/// id, the declared relation and its distance. It is deliberately a single token with no spaces, so the whole field
/// stays machine-readable (`blocked_by=object:(O)390@12,3`) and a model can branch on the part before the first colon.
/// </para>
/// </summary>
internal readonly record struct RefusalLayerToken(RefusalLayerKind Layer, string? Detail = null)
{
    /// <summary>The absence of a refusal. Named rather than constructed at each call site.</summary>
    internal static RefusalLayerToken None => new(RefusalLayerKind.None);

    internal bool Refused => this.Layer != RefusalLayerKind.None;

    internal string Format() =>
        this.Detail is null ? this.Layer.ToWireValue() : $"{this.Layer.ToWireValue()}:{this.Detail}";
}

/// <summary>
/// The one probe that answers "which named precondition refuses this target, for this action".
///
/// <para>
/// It exists because the model can only adapt from a failure that says what the WORLD is missing, in world terms.
/// `ref/external/voyager` raises <c>No furnace nearby</c> and <c>No item named ${name}</c> and its agent changes its
/// plan on the first refusal; a bare <c>no_native_path</c> gets re-aimed at a neighbouring tile instead.
/// </para>
/// <para>
/// Every declared layer reads its requirement from the ACTION'S OWN ROW - the `tool:&lt;category&gt;` claim, the pinned
/// item in its acceptance facts, the declared approach - and never from a table here. A second hand-written copy of
/// what each action needs is the defect this project keeps paying for: the two copies agree on the day they are
/// written and disagree the first time either moves.
/// </para>
/// <para>
/// Order matters and is the whole design: the first layer that actually refuses is reported, so a tile that is both
/// walled and occupied names the occupant the caller could move away from rather than the wall it cannot. The world
/// layers keep the engine's own granularity so they stay separable from the declared ones.
/// </para>
/// </summary>
internal static class RefusalProbe
{
    /// <summary>
    /// The first layer that refuses <paramref name="tile"/> for <paramref name="action"/>, or
    /// <see cref="RefusalLayerToken.None"/> when none does.
    ///
    /// <paramref name="action"/> is null for a walk: a move declares no tool, no item and no approach, so the world
    /// layers are the only ones that can honestly answer - and passing a row a walk does not have would make
    /// `blocked_by` blame the caller's inventory for a route the planner refused.
    /// </summary>
    internal static RefusalLayerToken Describe(
        FarmhandActionRegistration? action,
        GameLocation? location,
        Vector2 tile,
        Farmer? player)
    {
        RefusalLayerToken declared = DescribeDeclared(action, player?.Items);
        return declared.Refused
            ? declared
            : DescribeWorld(action, location, tile, player?.Tile, player);
    }

    /// <summary>
    /// The layers a refusal can read from the ACTION'S OWN ROW and the pack it carries, with no world at all.
    ///
    /// <para>
    /// Split out because it needs no `GameLocation` and no `Farmer`: the same question a live refusal asks can be
    /// asked of a synthetic pack, which is what lets the gate drive every declared requirement from
    /// <see cref="FarmhandActionCatalog.Registrations"/> instead of a list of actions somebody remembered.
    /// </para>
    /// </summary>
    internal static RefusalLayerToken DescribeDeclared(FarmhandActionRegistration? action, IList<Item?>? pack)
    {
        RefusalLayerToken tool = DeclaredTool(action, pack);
        if (tool.Refused)
            return tool;
        return DeclaredItem(action, pack);
    }

    /// <summary>
    /// The layers that need the world: an occupant standing or lying on the tile, the declared spatial relation, then
    /// the map itself.
    ///
    /// <paramref name="player"/> is the walking body, and the map stage needs it: a location that blocks in its own
    /// `isCollidingPosition` override (Mountain's `landslide`) has no entity and no tile property to find, so the only
    /// way to observe it is the rectangle test a walking character performs.
    /// </summary>
    internal static RefusalLayerToken DescribeWorld(
        FarmhandActionRegistration? action,
        GameLocation? location,
        Vector2 tile,
        Vector2? actorTile,
        Farmer? player = null)
    {
        if (location is not null)
        {
            RefusalLayerToken character = CharacterOn(location, tile);
            if (character.Refused)
                return character;
            RefusalLayerToken occupying = ObjectOn(location, tile);
            if (occupying.Refused)
                return occupying;
        }
        // The declared relation needs no location: it is arithmetic between the two tiles, and an action that declares
        // `adjacent` is out of range whether or not the caller could hand the probe a world.
        RefusalLayerToken range = OutsideDeclaredRange(action, tile, actorTile);
        if (range.Refused)
            return range;
        return location is null
            ? RefusalLayerToken.None
            : StardewBodyController.DescribeTerrainLayer(location, tile, player);
    }

    /// <summary>
    /// The tool the action's registration claims, resolved against the pack by the ONE resolver the handlers use, so a
    /// refusal cannot disagree with the selection that would have run.
    /// </summary>
    private static RefusalLayerToken DeclaredTool(FarmhandActionRegistration? action, IList<Item?>? pack)
    {
        if (action is null || pack is null)
            return RefusalLayerToken.None;
        // Only a row that DECLARES a `tool:` claim can be refused for one. Asking the resolver anyway would turn its
        // `tool_requirement_undeclared` answer - a registration defect inside the Mod - into a `blocked_by=tool:` the
        // caller is told to fix by finding a tool it was never asked for.
        if (ExecutionManager.DeclaredToolClaim(action.ActionId) is null)
            return RefusalLayerToken.None;
        DeclaredToolResolution resolution = ExecutionManager.ResolveDeclaredTool(pack, action.ActionId);
        return resolution.RefusalDetail is { } detail
            ? new RefusalLayerToken(RefusalLayerKind.Tool, detail)
            : RefusalLayerToken.None;
    }

    /// <summary>
    /// The item the action's own acceptance facts pin, when the pack carries none of it. Only a PINNED item can be read
    /// from the row; an action that takes "whatever the caller names in `slot`" states no requirement the surface could
    /// know before the request arrives, and inventing one here would refuse a request the handler accepts.
    /// </summary>
    private static RefusalLayerToken DeclaredItem(FarmhandActionRegistration? action, IList<Item?>? pack)
    {
        if (action?.Descriptor?.Acceptance?.ExactExpectedQualifiedItemId is not { } pinned || pack is null)
            return RefusalLayerToken.None;
        foreach (Item? carried in pack)
        {
            if (carried is not null && string.Equals(carried.QualifiedItemId, pinned, StringComparison.Ordinal))
                return RefusalLayerToken.None;
        }
        return new RefusalLayerToken(RefusalLayerKind.Item, pinned);
    }

    /// <summary>
    /// A villager, pet or farm animal standing on the tile.
    ///
    /// <para>
    /// The engine treats it as collision and says nothing, so a refusal about a tile an NPC happens to occupy used to
    /// read `blocked_by=none` - the one answer that reads as "nothing is in the way" about something that is, and that
    /// walks away on its own.
    /// </para>
    /// </summary>
    private static RefusalLayerToken CharacterOn(GameLocation location, Vector2 tile)
    {
        foreach (NPC character in location.characters)
        {
            if (character is not null && character.Tile == tile)
                return Named(RefusalLayerKind.Character, character.Name, character.GetType().Name, tile);
        }
        foreach (FarmAnimal animal in location.animals.Values)
        {
            if (animal is not null && animal.Tile == tile)
                return Named(RefusalLayerKind.Character, animal.Name, animal.GetType().Name, tile);
        }
        return RefusalLayerToken.None;
    }

    /// <summary>
    /// An object or a furniture piece on the tile: both block a body, and furniture lives in its own collection
    /// (`GameLocation.furniture`) rather than in `objects`, so asking only `objects` answered `none` about a sofa.
    /// </summary>
    internal static RefusalLayerToken ObjectOn(GameLocation location, Vector2 tile)
    {
        if (location.objects.TryGetValue(tile, out StardewValley.Object? item) && item is not null)
            return new RefusalLayerToken(RefusalLayerKind.ObjectOnTile, $"{item.QualifiedItemId}@{FormatPoint(tile)}");
        Furniture? piece = location.furniture.FirstOrDefault(
            candidate => candidate is not null && candidate.TileLocation == tile);
        if (piece is not null)
            return new RefusalLayerToken(RefusalLayerKind.ObjectOnTile, $"{piece.QualifiedItemId}@{FormatPoint(tile)}");
        return RefusalLayerToken.None;
    }

    /// <summary>
    /// The actor is outside the spatial relation the action's row declares.
    ///
    /// <para>
    /// Both halves come from the declaration: the relation word and the distance the row allows. An action that
    /// declares no approach is not out of range - its handler walks the actor in itself - so this layer stays silent
    /// rather than refusing work the action does.
    /// </para>
    /// </summary>
    private static RefusalLayerToken OutsideDeclaredRange(FarmhandActionRegistration? action, Vector2 tile, Vector2? actorTile)
    {
        if (action?.Descriptor?.Approach is not { WithinTiles: int within } approach || actorTile is not Vector2 actor)
            return RefusalLayerToken.None;
        int distance = Math.Max(
            Math.Abs((int)actor.X - (int)tile.X),
            Math.Abs((int)actor.Y - (int)tile.Y));
        return distance > within
            ? new RefusalLayerToken(
                RefusalLayerKind.Range,
                $"{approach.Relation}:{distance.ToString(CultureInfo.InvariantCulture)}")
            : RefusalLayerToken.None;
    }

    /// <summary>One named occupant as a token: the name the player sees, or the type when it has none.</summary>
    private static RefusalLayerToken Named(RefusalLayerKind layer, string? name, string fallback, Vector2 tile) =>
        new(layer, $"{WithoutSpaces(string.IsNullOrWhiteSpace(name) ? fallback : name)}@{FormatPoint(tile)}");

    /// <summary>A token carries no spaces: the field is split on `;` and `:`, and a name must not break that.</summary>
    internal static string WithoutSpaces(string value) => value.Replace(' ', '_');

    internal static string FormatPoint(Vector2 tile) =>
        $"{(int)tile.X},{(int)tile.Y}";
}
