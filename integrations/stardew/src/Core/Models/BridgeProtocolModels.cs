using System.Text.Json;
using System.Text.Json.Serialization;
using GameBuddy.Stardew.Core.BodyPrograms;

namespace GameBuddy.Stardew.Core.Models;

public enum ExecutionState
{
    Accepted,
    Running,
    MeaningfulProgress,
    Blocked,
    Invalidated,
    Succeeded,
    PartiallySucceeded,
    Failed,
    Cancelled,
    Rejected,
    Expired,
    Uncertain,
}

public static class ExecutionStateWire
{
    public static string ToWireValue(this ExecutionState state) => state switch
    {
        ExecutionState.Accepted => "accepted",
        ExecutionState.Running => "running",
        ExecutionState.MeaningfulProgress => "meaningful_progress",
        ExecutionState.Blocked => "blocked",
        ExecutionState.Invalidated => "invalidated",
        ExecutionState.Succeeded => "succeeded",
        ExecutionState.PartiallySucceeded => "partially_succeeded",
        ExecutionState.Failed => "failed",
        ExecutionState.Cancelled => "cancelled",
        ExecutionState.Rejected => "rejected",
        ExecutionState.Expired => "expired",
        ExecutionState.Uncertain => "uncertain",
    };

    /// <summary>
    /// Whether the state settles an execution. `Accepted`, `Running` and `MeaningfulProgress` are the three states
    /// an execution still occupies; everything else has ended, by success, refusal, cancellation or expiry.
    ///
    /// This lives beside the enum because two very different readers ask it - the durable journal's receipt ranking and
    /// the modal owner lease's "is the owner still active" - and a second copy is a disagreement scheduled for later.
    /// </summary>
    public static bool IsTerminal(this ExecutionState state) =>
        state is not (ExecutionState.Accepted or ExecutionState.Running or ExecutionState.MeaningfulProgress);
}

public sealed record BridgeLocalObservation(
    string Location,
    int TileX,
    int TileY,
    int Facing,
    string InGameTime,
    bool PlayerNearby,
    int Revision
);

public sealed record BridgeWorldFact(
    string EventId,
    string SourceEventId,
    string Kind,
    long ObservedTick,
    string? GameTime,
    int Revision,
    string? PayloadJson,
    string? DeduplicationKey = null
);

public sealed record ExpressEmoteArgs(string Emote);
public sealed record FaceDirectionArgs(string Direction);

/// <summary>
/// Mod-owned execution evidence. <see cref="ActionId"/> is bound on the game
/// thread before dispatch and remains with the bounded receipt record; bridge
/// transport caches never supply or recover this authority.
/// </summary>
public sealed record LocalExecutionReceipt(
    string ExecutionId,
    string RequestId,
    ExecutionState State,
    string ReasonCode,
    long Revision,
    string? Evidence,
    string? ActionId = null,
    BridgeLocalObservation? Observation = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ObserveSceneResultPayload? PiggybackedScene = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? NativeNotices = null,
    /// <summary>
    /// Where the caller can go instead, when the reason is "there is no path to what you asked for".
    ///
    /// <para>
    /// Carried beside <see cref="ReasonCode"/> and NOT as part of <see cref="Evidence"/>: the evidence string is
    /// `from=...;to=...;target_enclosed=...` and was computed, stored, published as a world fact and then dropped before the
    /// model ever saw it - `component_tiles`, `target_enclosed` and `route_exists_cardinal` appear 0 times in `round21`'s
    /// session while `no_native_path` appears 26. This field is the one part of that evidence a model can ACT on, carried
    /// separately so the Body Program journal can publish it without publishing evidence for a node that proved nothing.
    /// </para>
    /// </summary>
    string? Hint = null,
    /// <summary>
    /// The family this terminal's work CONSUMED - the Mod's declaration, typed - or null on a step that finished nobody's
    /// chore. Carried beside <see cref="Evidence"/> rather than inside it.
    ///
    /// <para>
    /// <see cref="Evidence"/> is `location=Farm;tile=60,9;chore=harvestTargets`, and a READER PARSE cannot be deleted
    /// while the fact exists only there: `host/src/fact-brief.ts` found the clause with `indexOf` in that string, so a
    /// space, a reordered pair or a renamed key silently turned a finished chore into `未测`. The string stays (every
    /// existing reader still reads it, and it is what a run's log shows), and this field is the same family stated in a
    /// shape no separator can break. One expression fills both: `ExecutionManager.RememberTerminal` takes the family from
    /// <see cref="Core.Policy.FarmhandActionCatalog.ChoreFamilyOf"/> once, puts it here and spells the clause with
    /// <see cref="Core.Policy.FarmhandActionCatalog.ChoreClause"/>.
    /// </para>
    /// <para>
    /// A terminal of ANY outcome names it - `rejected`, `uncertain` and `blocked` included - because "which family is this
    /// step's work" is a declaration about the ACTION, while how much of it is left is the reader's own world reading. A
    /// step that has not settled (`accepted`, `running`) names none: it has consumed nothing yet.
    /// </para>
    /// </summary>
    string? Chore = null
);

public sealed record BridgeScope(string IntegrationId, string SaveId, string WorldId, string PlayerId, string CompanionId)
{
    [JsonIgnore]
    public bool IsValid => IsOpaqueId(IntegrationId) && IsOpaqueId(SaveId) && IsOpaqueId(WorldId) && IsOpaqueId(PlayerId) && IsOpaqueId(CompanionId);

    private static bool IsOpaqueId(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or '-');
}

public sealed record BridgeEnvelope<TPayload>(
    int ProtocolVersion,
    string MessageId,
    string CorrelationId,
    long TimestampMs,
    BridgeScope Scope,
    string Type,
    TPayload Payload
);

/// <summary>Wire projections only; Core BodyProgram records remain the authority model.</summary>
public sealed record BodyNodeAdmissionPolicyIdentityWire(string Value, long CapabilityRevision);
public sealed record BodyNodeAdmissionSelectorWire(string Kind, string? Label = null, string? Ref = null);
public sealed record BodyNodeAdmissionCanonicalValueWire(string Type, string? CanonicalValue = null, BodyNodeAdmissionSelectorWire? Destination = null);
public sealed record BodyNodeAdmissionExecutionBindingWire(string ProgramId, string NodeId, int NodeAttempt, string RequestId, string IdempotencyKey, string ExecutionId);

 public sealed record BodyNodeAdmissionChallengeWire(
     string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch,
     long CatalogRevision, BodyNodeAdmissionPolicyIdentityWire PolicyIdentity, string ActionId,
     IReadOnlyDictionary<string, BodyNodeAdmissionCanonicalValueWire> CanonicalBoundArgs,
     IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs);

 public sealed record BodyNodeAdmissionGrantWire(
     string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch,
     long CatalogRevision, BodyNodeAdmissionPolicyIdentityWire PolicyIdentity, string ActionId,
     IReadOnlyDictionary<string, BodyNodeAdmissionCanonicalValueWire> CanonicalBoundArgs,
     IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs,
     string GrantId, string AttachmentGeneration, string PolicyRevision, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BodyNodeAdmissionExecutionBindingWire? ExecutionBinding = null);

 public sealed record BodyNodeAdmissionGrantedResultWire(
     string Result, string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch,
     long CatalogRevision, BodyNodeAdmissionPolicyIdentityWire PolicyIdentity, string ActionId,
     IReadOnlyDictionary<string, BodyNodeAdmissionCanonicalValueWire> CanonicalBoundArgs,
     IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs,
     string GrantId, string AttachmentGeneration, string PolicyRevision, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BodyNodeAdmissionExecutionBindingWire? ExecutionBinding = null) : BodyNodeAdmissionResultWire;
  public sealed record BodyNodeAdmissionRejectedResultWire(
      string Result, string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch,
      long CatalogRevision, BodyNodeAdmissionPolicyIdentityWire PolicyIdentity, string ActionId,
      IReadOnlyDictionary<string, BodyNodeAdmissionCanonicalValueWire> CanonicalBoundArgs,
      IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs, string Code) : BodyNodeAdmissionResultWire;
  public sealed record BodyNodeAdmissionUnavailableResultWire(
      string Result, string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch,
      long CatalogRevision, BodyNodeAdmissionPolicyIdentityWire PolicyIdentity, string ActionId,
      IReadOnlyDictionary<string, BodyNodeAdmissionCanonicalValueWire> CanonicalBoundArgs,
      IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs, string Code) : BodyNodeAdmissionResultWire;
  public abstract record BodyNodeAdmissionResultWire;

public sealed record BridgeTile(float X, float Y);
/// <summary>Deterministic Mod-declared action identity projected on hello_ack.
/// Reflects FarmhandActionCatalog.Registrations exactly; the Host treats this as
/// the registration authority and rejects unknown extra action IDs.</summary>
public sealed record FarmhandActionArgumentWire(
    string Name,
    string Type,
    IReadOnlyList<string>? Enum = null,
    string? Description = null,
    // The value range the Mod's own acceptance validator enforces, projected from ONE declaration
    // (`FarmhandArgumentBounds`) rather than restated per action. A consumer that describes the argument - the Host's
    // tool schema is the one - used to derive these by probing its own wire predicates, which is a second authority for
    // a number this record already decides. Omitted when the argument is not bounded that way, so an argument whose
    // value is a closed set or an exact id carries no range rather than a guessed one.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Minimum = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Maximum = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? MinLength = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? MaxLength = null);
public sealed record FarmhandActionResourceTemplateClaimWire(string Key, string Value);
public sealed record FarmhandActionResourceTemplateWire(IReadOnlyList<FarmhandActionResourceTemplateClaimWire> Claims);
public sealed record FarmhandActionPostconditionWire(string Name);
public sealed record FarmhandActionObservationBindingDescriptorWire(string Type, int Version, bool Required, IReadOnlyList<string> RequiredProperties);
/// <summary>Where the body must already stand, in the Mod's own words (<c>Relation</c>: `adjacent`, or `self_walked`
/// when the action closes the distance itself), or null when that relationship states no distance.</summary>
public sealed record FarmhandActionApproachRequirementWire(
    string Relation,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? WithinTiles = null);
public sealed record FarmhandActionDescriptorWire(
    IReadOnlyList<FarmhandActionArgumentWire> Arguments,
    IReadOnlyDictionary<string, string> OutputFacts,
    FarmhandActionResourceTemplateWire ResourceTemplate,
    string Effect,
    FarmhandActionPostconditionWire Postcondition,
    string? NativeBinding = null,
    FarmhandActionObservationBindingDescriptorWire? SceneTarget = null,
    // The Mod's OWN watchdog for this action, in milliseconds: hang protection it already owns
    // (`FarmhandActionDescriptor.WatchdogMs`; the lifecycle actions deliberately carry 600s because a night waits
    // on other players, the save, and the day start). Published so the Host can size a dispatch deadline the way
    // the action was designed to be waited on, instead of one hard-coded number for every action - measured
    // 2026-10-17: `advance_day` was dispatched with a 30s deadline against a 600s watchdog, so it timed out by
    // construction and the failure read as the companion being unable to sleep.
    long? WatchdogMs = null,
    // The spatial precondition the Mod enforces, so the companion can stand in the right place instead of learning it
    // by being refused. Absent when the action declares none (WhenWritingNull), which is NOT "stand anywhere".
    FarmhandActionApproachRequirementWire? Approach = null,
    // The snapshot family that supplies this action's targets (`cropTargets`), or null when it addresses nothing a
    // snapshot publishes. Published so a refusal can name the family to re-read instead of leaving the caller to
    // guess at a vocabulary it cannot see.
    string? TargetFamily = null,
    // What the action is CALLED and the sentence a model reads about it, from the Mod's one declaration
    // (`FarmhandActionPresentation`). Absent on the actions that publish none, because their tool text is still written
    // in the Host's own mount block - and an absent member is that statement, where an empty string would be a label
    // nobody wrote. `TargetKinds` is the same declaration's third member: the words `stardew_search_interactions` matches
    // a caller's own query against.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Label = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Description = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? TargetKinds = null
);

public sealed record FarmhandActionRegistrationWire(
    string ActionId,
    string FamilyId,
    int IdentityVersion,
    string Lifecycle,
    string Kind,
    FarmhandActionDescriptorWire? Descriptor = null
);

/// <summary>Exact Mod-owned capability publication identity projected on authenticated bridge availability messages.</summary>
public sealed record FarmhandPolicyIdentityWire(string Value, long CapabilityRevision);

/// <summary>
/// One tile a soil action addresses NOW, in both states this family publishes: ground the Hoe still admits, and ground
/// already carrying <c>HoeDirt</c> (work done, and the `plant_seed`/`fertilize_tile`/`water_crop` target).
///
/// <para>
/// THE ROW STATES WHICH OF THE TWO THE TILE IS, because `till_soil` refuses the one already under the Hoe and a family of
/// bare coordinates made the companion till what she had tilled: measured round80: twenty-seven <c>soil_already_tilled</c>
/// receipts in one runner log, twenty-one
/// of them one programme walking a block it had already hoed, while every row of that block answered `hoeDirt: true`.
/// </para>
///
/// <para>
/// <see cref="BlockX"/>/<see cref="BlockY"/>/<see cref="BlockW"/>/<see cref="BlockH"/> are the bounds of the CONNECTED
/// strip this tile belongs to: the axis-aligned box of every tile reachable from it by a cardinal step over the ground a
/// patch can be opened in - the permanent half of the Hoe's admission, under an occupant some published action clears -
/// measured over the whole map rather than over the discovery window. They exist because a task has a SHAPE and the
/// family published only points: measured `round92`, she was asked for one 3-tile-wide, twenty-long strip and planted 34
/// times scattered across x 62..79, y 17..26 - "which rectangle should I open" was arithmetic she had to invent from a
/// 13x13 grid, and the row that would have said `3x20` said nothing. The box therefore measures the GROUND and not this
/// family's rows: a tile with a weed on it is inside the strip and is not a row, because a row is a tile a soil action
/// addresses now. The box is a measurement of the world, never a request: `till_soil` still admits one tile at a time.
/// </para>
///
/// <para>
/// <see cref="Surface"/> IS WHAT THE TILE'S GROUND IS, and it is the fact this family could not state. Measured
/// `round98` (2026-11-23): the greenhouse's stone doorstep at `29,17` answered `hoeDirt: true, crop: null` - the same row
/// an ordinary field tile gives - and a cauliflower grew in the doorway. The word is <c>GroundSurface</c>'s reading,
/// which is also the predicate a fixture may not hand-make dirt over, so the world the companion reads and the world a
/// fixture builds cannot disagree about a tile. <see cref="SurfaceOwner"/> names the building whose own tile data
/// answered (`Greenhouse`) and is null when the map did; a tile the engine cannot answer says
/// `not_measured:&lt;x&gt;,&lt;y&gt;:&lt;why&gt;`, because defaulting to soil is the same lie a hand-made doorstep was.
/// </para>
/// </summary>
public sealed record BridgeSoilTile(
    int X,
    int Y,
    bool HoeDirt,
    int BlockX,
    int BlockY,
    int BlockW,
    int BlockH,
    string Surface,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SurfaceOwner = null);

/// <summary>
/// One reason the tiles of a <see cref="BridgeFieldCandidate"/> do not take the Hoe, and how many tiles it accounts for.
///
/// <para>
/// <see cref="Kind"/> is a word from ONE OF THREE DECLARATIONS, and the shape is one row per (word, count) because the
/// three cannot answer for each other: a tile outside the field the layout keeps (<see cref="Core.FieldLayout"/>:
/// `building`, `walkway`), a tile the GROUND itself refuses (<c>ExecutionManager.DescribeSoilGroundRefusal</c>: `water`,
/// `not_map_diggable`, `impassable`), or a tile something stands on (<see cref="Core.TileOccupantKind"/>: `tree`,
/// `stone`, `weed`, ... - the same words a `for_each` filter and a `Clears` declaration are written in). Translating any of
/// them into a fourth vocabulary here is how one fact acquires two spellings.
/// </para>
/// </summary>
public sealed record BridgeFieldBlocker(string Kind, int Count);

/// <summary>
/// One patch of ground the location's LAYOUT offers as a field: a rectangle, how much of it the Hoe takes now, and what
/// stands in the way of the rest.
///
/// <para>
/// WHY THE LAYOUT AND NOT MORE TILES. A field is a shape a farmer keeps; `soilTiles` is a list of tiles a soil action
/// addresses now, and the companion's "field" was therefore the sum of wherever targets happened to be. Measured
/// `round92`: 34 seedings scattered across x 62..79 / y 17..26, tilled 7 - she planted into ground that was already tilled
/// rather than making a field. Measured `round95`: told to fill one rectangle, `(44,21)..(63,23)`, the same companion got
/// 58 of 60 - a field appeared the moment a task named a shape. So the observation names the shapes, and the tiles stay
/// what they always were. Measured `round98`: a cauliflower in the ruined greenhouse's stone doorstep, because that one
/// tile read `HoeDirt: true, crop: null`.
/// </para>
///
/// <para>
/// THE BOX IS THE MOD'S OWN MEASUREMENT, NOT A SECOND ONE. It is the connected strip the soil family already publishes as
/// `blockX`/`blockY`/`blockW`/`blockH` (<c>FarmhandTargetDiscovery.FarmableBlocks</c>), measured over the whole map, so a
/// patch longer than the observation window still states its shape. What is added is the ARITHMETIC over that box - what
/// the Hoe takes now, what is already soil, and what is in the way by kind - which is the work the companion was doing
/// from a 13x13 window.
/// </para>
///
/// <para>
/// EVERY TILE OF THE BOX LANDS IN EXACTLY ONE BUCKET: <c>w * h == Tillable + Opened + Sum(Blocked.Count)</c>. That is the
/// invariant a reader reconciles against, and it is what makes a rectangle that is mostly obstacles read as one instead of
/// reading as a field. <see cref="Opened"/> is the tiles already carrying soil: work done, which is neither free ground
/// nor blocked ground, and leaving it out of the sum would make a finished field read as an empty one.
/// </para>
///
/// <para>
/// <see cref="DoorDistance"/> is the Chebyshev distance from the farmhouse's own entry tile
/// (<c>GameLocation.GetMainFarmHouseEntry</c>) to the nearest tile of the box: how far she has to walk before the field
/// starts. It is published because "which of these is my field" is a decision about the farm, and a patch by the porch is
/// nearer than one across the yard.
/// </para>
/// </summary>
public sealed record BridgeFieldCandidate(
    int X,
    int Y,
    int W,
    int H,
    int Tillable,
    int Opened,
    IReadOnlyList<BridgeFieldBlocker> Blocked,
    int DoorDistance);

/// <summary>
/// Inbound rectangle question: every tile of <c>x..x+w-1</c> by <c>y..y+h-1</c> in the actor's current location.
///
/// <para>
/// It exists because the published family for soil is a SQUARE window around the actor with a cap
/// (<see cref="ExecutionManager.DiscoverSoilTiles"/>), and a task shapes the ground it wants: measured round42, the
/// companion asked to till 3x20 received a 7x8 blob at 55% density, because nothing in her hands could answer "what is
/// at (44..46, 12..31)". The request is a rectangle, so the answer is the rectangle.
/// </para>
/// </summary>
public sealed record BridgeTileAreaQueryRequest(int X, int Y, int W, int H);

/// <summary>
/// One tile of a rectangle, with the facts a planner decides from and nothing else.
///
/// <para>
/// <see cref="Tillable"/> is the Hoe's own admission (<c>ExecutionManager.IsTillableTile</c>, the predicate the soil
/// discovery calls); <see cref="Occupant"/> is the engine's stored thing for the tile, named by its own type
/// (<c>none</c> when the tile is free, <c>unspecified</c> when the name does not survive); <see cref="Passable"/> is the
/// pathfinder's own answer (<c>StardewBodyController.IsWalkableTile</c>, the wrapper over
/// <c>PathFindController.cs:222</c>). There is no <c>fixture</c> field: a fixture plants real engine entities, so the
/// occupant and soil facts already carry it and a flag beside them would be a second spelling of one fact.
/// </para>
/// <para>
/// TWO OCCUPANT FIELDS, TWO VOCABULARIES, said out loud because a reader must never have to guess which one a filter
/// speaks: <see cref="Occupant"/> answers "what engine thing is stored here" in runtime type names, and
/// <see cref="OccupantKind"/> answers "what is standing here" in the words a `for_each` `where: [{ occupant: ... }]`
/// filter and an action's `Clears` declaration are written in (<see cref="TileOccupancy.Of"/>, the one producer both
/// this row and the pass read). A weed is `object` in the first and `weed` in the second; a crop tile is `none` in the
/// first and `crop` in the second.
/// </para>
/// </summary>
public sealed record BridgeTileAreaRow(
    int X,
    int Y,
    bool Tillable,
    string Occupant,
    string OccupantKind,
    bool Hoed,
    bool Watered,
    bool Crop,
    bool Passable
);

/// <summary>
/// The answer to one rectangle question: the rectangle, the location and revision it describes, and one row per tile.
///
/// <para>
/// <see cref="Status"/> is the Mod's own closed vocabulary. <see cref="Detail"/> names the refusal in full
/// (<c>inspect_tiles_area_too_large:100:11x10</c>), because a bound that refuses without stating the limit and the
/// requested size is a bound the caller can only discover by bisecting. <see cref="Omitted"/> is the number of requested
/// tiles the answer does not carry for any reason OTHER than the area bound - a second bound added here must state what
/// it dropped, and an answered rectangle satisfies <c>rows.Count + omitted == w * h</c>.
/// </para>
/// </summary>
public sealed record BridgeTileAreaQueryResult(
    string Status,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Detail,
    int X,
    int Y,
    int W,
    int H,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Location,
    int Revision,
    int AreaLimit,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyList<BridgeTileAreaRow>? Rows,
    int Omitted
);

/// <summary>
/// One inventory slot that holds a tool: a slot a tool action may name, the tool's own item identity, and its upgrade
/// level. The level is a fact, not advice: which owned tool satisfies an action's `tool:&lt;category&gt;` claim is decided
/// by the claim's own upgrade requirement, so an identity alone would leave the level unreadable beside it.
///
/// <para>
/// <see cref="Label"/> is the native identity an internal item id happens to be (`(W)47` for the scythe), which
/// says which ITEM this is but never which TOOL it is; <see cref="Category"/> says the latter, in the vocabulary
/// an action's own `tool:&lt;category&gt;` resource claim uses, so a caller satisfying a claim reads the word the
/// claim names instead of guessing it from an id. A tool the Mod's one mapping has no word for reports
/// `unknown` rather than the nearest-looking guess.
/// </para>
///
/// <para>
/// <see cref="UpgradeLevel"/> is ABSENT on the wire for a tool that cannot be upgraded, and that is the whole reason
/// it is nullable. The engine gives a non-upgradable tool `-1` rather than `0` (measured on Stardew Valley 1.6.15,
/// build 24356: `new MilkPail().UpgradeLevel == -1` and `new Shears().UpgradeLevel == -1`, while Axe, Hoe, Pickaxe
/// and WateringCan are `0`), and the Host reads a level as an upgrade tier: a negative one is not a tier. Absent
/// therefore means "this tool does not upgrade" and never "unknown" - sending the engine's sentinel instead closed
/// the bridge with `invalid_snapshot:toolSlots` on the collection lane, whose pack carries a Milk Pail.
/// </para>
/// </summary>
public sealed record BridgeToolSlot(
    int Slot,
    string Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? UpgradeLevel,
    string Category);

public sealed record BridgeWateringCanFact(int Slot, string QualifiedItemId, string Label, int Water, int Max);

public sealed record BridgeRefillWateringCanTarget(string TargetId, int X, int Y);

/// <summary>
/// One tile the ENGINE says a rod may be cast at, from the same two questions <c>FishingRod.DoFunction</c> gates a cast
/// on (<c>FishingRod.cs:411</c>): <c>location.canFishHere()</c> and <c>location.isTileFishable(x, y)</c>. Discovery asks
/// them once per tile, so the family cannot drift from the predicate the cast itself re-asks.
///
/// <para>
/// <see cref="TargetId"/> is the address <c>fish_here</c> takes as <c>expectedTargetId</c>, recomputed by the handler from
/// the same location identity and tile. A row therefore does not promise a FISH: which fish swims here is decided by the
/// engine inside <c>GameLocation.getFish</c> at the bite, from weather, season, time, depth and skill, and nothing in this
/// family participates in that.
/// </para>
/// </summary>
public sealed record BridgeWaterTarget(string TargetId, int X, int Y);

/// <summary>
/// One interaction point the MAP ITSELF fixes at a tile: a mine level's ladder, a shop counter, a
/// television. Not an entity, and not a warp: it has no <c>location.objects</c> row and no
/// <c>location.warps</c> entry, so a radius-bounded entity discovery can never publish it.
///
/// <para>
/// <see cref="Kind"/> is a token from the closed vocabulary in
/// <c>GameBuddy.Stardew.Core.Policy.FixedInteractionPointKinds</c>, mirrored by the wire schema's
/// enum. <see cref="ActionWord"/> is the engine's own first word at that tile (<c>MinecartTransport</c>
/// out of <c>Action: MinecartTransport Default</c>), and <c>null</c> where the engine carries no word
/// - a mine ladder is a tile INDEX, not a property, so it has nothing to quote.
/// </para>
/// </summary>
public sealed record BridgeFixedInteractionPoint(
    int X,
    int Y,
    string Kind,
    // NEVER omitted. The bridge's own serializer drops a null member
    // (`BridgeProtocol.JsonOptions.DefaultIgnoreCondition = WhenWritingNull`), and the wire schema REQUIRES this
    // member: a null that vanished would fail `hasExactKeys` on the Host and refuse the WHOLE snapshot with
    // `invalid_snapshot:fixedInteractionPoints`. A mine ladder has no engine word, so null is the honest value and
    // it has to reach the wire.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ActionWord
);

/// <summary>
/// One native forage object. <see cref="IsForage"/> is <c>Object.isForage()</c> at publish time - the predicate that is
/// the only difference between this family and <see cref="BridgeItemTarget"/>.
/// </summary>
public sealed record BridgeForageTarget(string TargetId, int X, int Y, string QualifiedItemId, string DisplayName, int Stack, bool IsForage);

public sealed record BridgeItemTarget(string TargetId, int X, int Y, string QualifiedItemId, string DisplayName, int Stack);

/// <summary>
/// One crop tile the companion may water, carrying the facts that decide what to do with it.
///
/// <para>
/// The row is what a reader gets WITHOUT asking a second question. Measured 2026-11-09: the runtime already answered
/// "how should this crop be planted" through `look_up({subject:"data", table:"Crops"})`, and across a day of runs that
/// table was asked zero times - so a trellis crop stood on a column that stops being walkable and nothing in the
/// companion's working set said so. `DaysToHarvest`, `RegrowDays`, `HarvestMethod`, `IsRaised` and `Seasons` are the
/// same five facts `ContentDataQuery.CropRow` publishes, named the same way, so the row can be joined to a data answer.
/// </para>
///
/// <para>
/// The five data fields are NULLABLE and the serializer drops a null member (`WhenWritingNull`), because a crop with no
/// `Data/Crops` row - a content pack may add a seed whose data the engine cannot resolve - has no such fact at all, and
/// a default would read as truth. `CropFactsUnknown` is then the row's own one-token statement of why: <c>crop_data_missing</c>.
/// </para>
///
/// <para>
/// `FullyGrown` and `Harvestable` are DIFFERENT engine questions and the row carries both: <c>Crop.fullyGrown</c> says
/// the plant finished its phases, <c>HoeDirt.readyForHarvest()</c> says it can be picked this instant. A crop just
/// harvested and regrowing is the case they disagree on, and it is exactly the case a layout decision needs while a
/// harvest decision must refuse it.
/// </para>
///
/// <para>
/// `TileBlockedNow` is <c>GameLocation.isCollidingPosition</c> over the tile's own 62x62 box - the admission test
/// `PathFindController.cs:222` itself uses - read at the revision of the snapshot that carries it. It is deliberately
/// NOT <c>GameLocation.isTilePassable</c> (GameLocation.cs:2898), which reads only the map's Back and Buildings layers
/// and reports a trellis crop as open ground; the two disagree on precisely the tile this field exists for.
/// </para>
/// </summary>
public sealed record BridgeCropTarget(
    string TargetId,
    int X,
    int Y,
    string CropId,
    string DisplayName,
    bool Watered,
    bool Harvestable,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? DaysToHarvest,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? RegrowDays,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? HarvestMethod,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? IsRaised,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? Seasons,
    bool FullyGrown,
    bool TileBlockedNow,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? CropFactsUnknown,
    string Surface,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SurfaceOwner = null);

/// <summary>
/// One crop tile <c>harvest_crop</c> accepts, with the four facts its admission branches on: whether the crop is ready
/// (<c>HoeDirt.readyForHarvest()</c>), whether it is a forage crop (<c>Crop.forageCrop</c>), which tool the engine's
/// harvest path requires (<c>Crop.GetHarvestMethod()</c>: <c>grab</c> or <c>scythe</c>) and whether it regrows.
/// </summary>
public sealed record BridgeHarvestTarget(
    string TargetId,
    int X,
    int Y,
    string CropId,
    string QualifiedHarvestItemId,
    string DisplayName,
    bool RegrowsAfterHarvest,
    bool ReadyForHarvest,
    bool ForageCrop,
    string HarvestMethod,
    string Surface,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SurfaceOwner = null);

/// <summary>
/// One empty HoeDirt tile paired with a carried seed.
///
/// <para>
/// <see cref="CanPlantThisSeedHere"/> is <c>HoeDirt.canPlantThisSeedHere(seed.ItemId, isFertilizer: false)</c> - the
/// engine's season/raised-crop admission, which is what <c>plant_seed</c> refuses on. <see cref="Crop"/> is the handler's
/// other test (<c>HoeDirt.crop is not null</c>): a tile that already carries a crop is not a seed target.
/// </para>
///
/// <para>
/// <see cref="Surface"/> is the SAME reading <see cref="BridgeSoilTile"/> publishes (<c>GroundSurface</c>): what the
/// ground under this HoeDirt is, and the building that owns it when one does. It is here because a planting decision is
/// a decision about ground - measured `round98`, a seed went into the greenhouse's stone doorstep because the row said
/// only that the tile was empty tilled soil.
/// </para>
/// </summary>
public sealed record BridgeSeedTarget(
    string TargetId,
    int Slot,
    int X,
    int Y,
    string QualifiedItemId,
    string DisplayName,
    bool CanPlantThisSeedHere,
    bool Crop,
    string Surface,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SurfaceOwner = null);

/// <summary>
/// One HoeDirt tile paired with a carried fertilizer. <see cref="CanApplyFertilizer"/> is the engine's own
/// <c>HoeDirt.CanApplyFertilizer(fertilizerId)</c>, the predicate <c>fertilize_tile</c> refuses on.
/// </summary>
public sealed record BridgeFertilizerTarget(
    string TargetId,
    int Slot,
    int X,
    int Y,
    string QualifiedItemId,
    string DisplayName,
    bool CanApplyFertilizer,
    string Surface,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SurfaceOwner = null);

public sealed record BridgeWoodFenceTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName);

public sealed record BridgeWoodFenceResultTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName, bool IsFence, bool IsGate, float Health, float MaxHealth);

public sealed record BridgeCrabPotTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName);

public sealed record BridgeCrabPotOverlayTile(int X, int Y, int Count);

public sealed record BridgeCrabPotResultTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName, long OwnerId, float OffsetX, float OffsetY, IReadOnlyList<BridgeCrabPotOverlayTile> OverlayTiles);

/// <summary>
/// A live mature crab pot the companion may collect from: required by
/// collect_crab_pot_output, which otherwise has no discovery channel and could
/// never be reached by its own advertised capability. Carries only stable
/// local values; production alone calls the native interaction.
/// </summary>
public sealed record BridgeCrabPotCollectTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId, string DisplayName, string OutputQualifiedItemId, int OutputStack);

public sealed record BridgeBaitCrabPotTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName, string BaitQualifiedItemId, string OwnerId, int BaitStack);

public sealed record BridgeBaitCrabPotResultTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName, string BaitQualifiedItemId, string OwnerId, int BaitStack);

/// <summary>
/// One native ResourceClump a tool swing could break, with the footprint it occupies.
///
/// <para>
/// <c>W</c>/<c>H</c> are the engine's own <c>ResourceClump.width</c>/<c>height</c> - the tiles the clump spans, which
/// is not the same thing as the one tile its <c>X</c>/<c>Y</c> names. A 2x2 boulder read as a single tile is a boulder
/// whose remaining three tiles the companion never learns about, so the row states the footprint instead of leaving a
/// reader to assume one. <c>X</c>/<c>Y</c> stay the LEFT-TOP origin.
/// </para>
/// </summary>
public sealed record BridgeDebrisTarget(string TargetId, int Slot, int X, int Y, int ParentSheetIndex, string ToolKind, int RequiredUpgradeLevel, int Health, int W, int H);

public sealed record BridgeRockSourceTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId, string DisplayName, int Health);

public sealed record BridgeArtifactSpotTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId, string DisplayName);

public sealed record BridgeArtifactSpotResultTarget(
    string TargetId,
    string Location,
    int X,
    int Y,
    bool Crop,
    bool Ground,
    string Surface,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SurfaceOwner = null);

public sealed record BridgeClearHoeDirtTarget(
    string TargetId,
    string Location,
    int X,
    int Y,
    bool Crop,
    bool Ground,
    string Surface,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SurfaceOwner = null);

/// <summary>
/// One native machine.
///
/// <para>
/// <see cref="MachineData"/> is <c>Object.GetMachineData() is not null</c> at publish time: whether the object carries
/// its own <c>Data/Machines</c> rows, which is what makes it a machine `machine_inspect`/`machine_load` can address
/// rather than an ordinary placed object.
/// </para>
///
/// <para>
/// <see cref="Accepts"/> is what the machine's own <c>Data/Machines</c> rows declare it takes, derived from the same
/// trigger rows the load refusal names. It is published because the row otherwise promised only "this is a machine":
/// measured 2026-10-31, a furnace reached the model as a load target with no statement of inputs and the model loaded
/// coffee beans into it. It is written even when null, because <c>null</c> means the machine data could not answer -
/// which is a different fact from an empty list (the data was read and declares no load input), and the pipeline's
/// default is to omit nulls, which would collapse the two into one absent key.
/// </para>
/// </summary>
public sealed record BridgeMachineTarget(string TargetId, int X, int Y, string QualifiedItemId, string DisplayName, bool ReadyForHarvest, int MinutesUntilReady, string? HeldObjectQualifiedItemId, string? LastInputQualifiedItemId, int? LoadInputSlot, string? LoadInputQualifiedItemId, int? LoadInputStack, bool? CollectOutputReady, bool MachineData,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] MachineInputAcceptance? Accepts = null);

public sealed record BridgeTreeChopSourceTarget(string TargetId, string Location, int X, int Y, string TreeType, int GrowthStage, float Health, bool Stump, bool Moss, bool Tapped);

public sealed record BridgeTreeChopResultTarget(string TargetId, string Location, int X, int Y, string TreeType, float Health, bool Stump, bool Moss, bool Tapped);

/// <summary>
/// One villager a plan can name, with the relationship the engine holds for them AND what the world is showing over
/// their head.
///
/// <para>
/// <see cref="Marker"/> is the thing the player reads as a bubble over the NPC and the companion had no field for.
/// Measured `round92`: the player asked "there is a question mark over Pierre - what quest is that? does she know?", and
/// the row carried `talkedToToday`, `specialOrderTargets` and `activeSpecialOrderKeys` and nothing that said which of
/// them was about HIM. The engine draws no stored marker and keeps no marker field: the states a bubble is drawn for
/// come from THREE different places, so all three are read here and the strongest is published, in this order:
/// </para>
/// <list type="number">
/// <item><c>quest</c> - the player's own quest log holds a quest that NAMES this NPC and is not complete. The two engine
/// types that name one are <c>ItemDeliveryQuest.target</c> and <c>ResourceCollectionQuest.target</c> (both `Data/Quests`
/// rows the billboard hands out), and `completed` is the engine's own flag (`Quest.questComplete`, Quest.cs:609).</item>
/// <item><c>special_order</c> - a live order in <c>FarmerTeam.specialOrders</c> has this NPC as its
/// <c>SpecialOrder.requester</c> (SpecialOrder.cs:100, the same field the board's own offer screen reads).</item>
/// <item><c>dialogue</c> - the engine has a temporary message for this NPC: `NPC.hasTemporaryMessageAvailable()`
/// (NPC.cs:4315, an end-of-route message or the location's own override dialogue) or one already queued in
/// `NPC.TemporaryDialogue` (NPC.cs:318). This is deliberately NOT `NPC.CurrentDialogue.Count`: that property's getter
/// COMPUTES and caches the day's dialogue when it is not loaded yet (NPC.cs:564-585 -> `loadCurrentDialogue`, :3608),
/// and an observation may not write engine state.</item>
/// <item><c>none</c> - none of the three, which is a measured answer and never silence: a villager already talked to
/// today with nothing queued carries `none`.</item>
/// </list>
/// </summary>
public sealed record BridgeNpcRelationshipTarget(string TargetId, int X, int Y, string NpcName, int FriendshipPoints, string FriendshipStatus, bool TalkedToToday, int GiftsToday, int GiftsThisWeek, string Marker);

/// <summary>
/// Where one villager currently is, across the whole loaded world.
///
/// <para>
/// The per-location discovery lists only describe the player's current map, so
/// an Agent told to find a villager has no way to learn that she is elsewhere -
/// a live run searched three maps by trial and never found her. This is the
/// missing fact: the villager's authoritative location in the loaded world.
/// </para>
/// <para>
/// Read-only and bounded. It publishes nothing the game does not already hold;
/// only instantiated, non-event villagers on a loaded location appear.
/// </para>
/// </summary>
public sealed record BridgeVillagerWhereabouts(string TargetId, string NpcName, string DisplayName, string Location, int X, int Y, bool InCurrentLocation);

/// <summary>
/// One OTHER HUMAN PLAYER in the co-op session, standing where this observation can see them.
///
/// <para>
/// THE COLLECTION IS <c>Game1.otherFarmers</c> and nothing else. It is the engine's dictionary of the players who are not
/// the local one (<c>NetRootDictionary&lt;long, Farmer&gt;</c>, Game1.cs:1011), populated as each one connects, and it is
/// the collection the engine's own body update walks while skipping a self entry
/// (<c>otherFarmer.Key != player.UniqueMultiplayerID</c>, Game1.cs:9471-9475). The local actor is NOT published here: her
/// body already is the snapshot's <c>tile</c>, <c>currentTool</c>, <c>stamina</c> and disposition, and a row naming her
/// twice would be a second spelling of the same body. <c>Game1.getAllFarmers()</c> is deliberately not read: it also
/// yields OFFLINE farmhands (<c>netWorldState.farmhandData</c>), whose farmer object is a save record rather than someone
/// standing on the map.
/// </para>
/// <para>
/// EVERY MEMBER IS AN ENGINE ANSWER, or the word <c>not_measured</c>. <c>Location</c>/<c>X</c>/<c>Y</c> are the farmer's
/// own <c>currentLocation</c> and tile; <c>Name</c> is <c>Farmer.Name</c>; <c>Facing</c> is
/// <c>FacingDirection</c> (0 up, 1 right, 2 down, 3 left - NetDirection.cs:43-66); the held pair is
/// <c>Farmer.CurrentItem</c>, with <c>none</c> for the measured answer "empty hands" (the value this wire already uses for
/// a measured absence); and <c>Doing</c> is the first of the engine's own action predicates that holds - <c>UsingTool</c>,
/// <c>isEmoting</c>, <c>IsSitting()</c>, <c>isMoving()</c>, else a measured <c>idle</c>. A farmer the engine holds no
/// sprite for publishes <c>not_measured</c> instead of <c>idle</c>, because "standing still" is a claim about a body this
/// process is not simulating.
/// </para>
/// <para>
/// THERE IS NO <c>TargetId</c>, and that is the row's whole honesty: no published action takes a human player as its
/// target (the farmhand action surface has no such action and this family declares none), so there is no address to mint.
/// The row is a PERCEPTION fact - who is beside her, where they look, what they hold, what they are doing - and the Host's
/// label says so. A row that looked addressable and was not is the same defect class as a block printing an address no
/// action accepts.
/// </para>
/// </summary>
public sealed record BridgeOtherFarmerTarget(
    string Location,
    int X,
    int Y,
    string Name,
    string Facing,
    string HeldQualifiedItemId,
    string HeldDisplayName,
    string Doing);

/// <summary>
/// One farm location's ready-for-harvest crop summary, across the loaded world.
///
/// <para>
/// Per-location harvest targets are Chebyshev-bounded to the player's
/// neighbourhood, so an Agent standing at the FarmHouse entrance cannot see
/// the lone ripe crop sixty tiles away — a live ladder-5 run measured the
/// Agent searching Farm (63-64,17-19) while the crop sat at (3,12) and never
/// discovered it. This is the missing planning fact: how many ripe crops each
/// loaded location holds and where the nearest (Chebyshev) one is, so the
/// companion can route to a location before the bounded discovery takes over.
/// </para>
/// <para>
/// ANOTHER MAP'S COORDINATE IS NOT AN ADDRESS. The nearest tile is published only for the location the player stands in;
/// a row for any other map carries its count and NO coordinate. `-1` would be a magic number, and the Host refuses a
/// negative tile, so the two members are nullable and omitted on the wire (WhenWritingNull) - once this row was emitted
/// only when a nearest tile existed, which dropped every other map's count and told a companion waking in the farmhouse
/// that nothing on any map was ripe.
/// </para>
/// <para>
/// AND THE ADDRESS IS THE TARGET FAMILY'S. The nearest tile is also withheld when `harvestTargets` would not publish it
/// (<c>FarmhandTargetDiscovery.IsPublishedHarvestTile</c>: the family's six-tile window, a neighbour the body can stand
/// on, an item to pick). The count is the whole map's, which is why this row exists; the coordinate is offered only when
/// the same observation can also hand out that crop's `targetId`. Measured `round99` (`game-1795514126213`): the row read
/// `3 (nearest 33,16)` while `harvestTargets` was `[]`, and the companion spent four observations and three game hours
/// looking for an id that no reading carried.
/// </para>
/// </summary>
public sealed record BridgeHarvestWhereabouts(
    string Location,
    int ReadyForHarvestCount,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? NearestX = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? NearestY = null);

/// <summary>
/// How many crops on this map need water, and where the nearest one is.
///
/// <para>
/// The counterpart of <see cref="BridgeHarvestWhereabouts"/>, and it exists because its absence produced a FALSE ZERO in
/// the prompt: the unwatered count was rendered from `cropTargets`, which is radius-6 discovery, so a farm with 24 dry
/// tiles beyond that radius read as "unwatered crops: 0". Measured 2026-10-31: the companion was told nothing needed water
/// while standing in a field that did. A radius-bounded list cannot answer a whole-map question, so the whole-map answer is
/// published beside it.
/// </para>
/// <para>
/// The nearest tile has the same rule as <see cref="BridgeHarvestWhereabouts"/>: it is published only for the player's own
/// map, and a row for any other map carries its count with both coordinates absent.
/// </para>
/// </summary>
public sealed record BridgeWateringWhereabouts(
    string Location,
    int NeedsWaterCount,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? NearestX = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? NearestY = null);

/// <summary>
/// One available minecart ride from a station on the current map (travel's
/// minecart objective family).
///
/// <para>
/// Native 1.6 minecart travel is data-driven (`Data/Minecarts`): a station tile
/// carries an `Action MinecartTransport &lt;networkId&gt;` map property, the
/// network has an `UnlockCondition` game-state query, and each destination has
/// its own `Condition`, optional `Price`, and target location/tile. The native
/// player path opens `ShowMineCartMenu` (a menu), but the ride itself is the
/// public, UI-free `GameLocation.MinecartWarp(destination)`. Publishing one
/// entry per (station tile, destination) keeps the choice with the companion
/// while the Mod only reads the game's own data.
/// </para>
/// </summary>
public sealed record BridgeMinecartTarget(
    string TargetId,
    string NetworkId,
    string DestinationId,
    string DisplayName,
    int Price,
    int StationX,
    int StationY,
    string TargetLocation,
    int TargetTileX,
    int TargetTileY);

public sealed record BridgeRaftTarget(string TargetId, int X, int Y);
public sealed record BridgeHorseTarget(string TargetId, int X, int Y, string Name);

/// <summary>
/// <para>
/// One selectable mine-elevator floor. The set is NOT a client-supplied range: it
/// is a pure function of the live <c>MineShaft.lowestLevelReached</c> — floor 0
/// plus every multiple of 5 up to min(lowestLevelReached, 120) — which is exactly
/// the enumeration <c>MineElevatorMenu</c> builds (MineElevatorMenu.cs:16/37). The
/// Mod re-derives it on the game thread and refuses an unadvertised floor, so the
/// action cannot be used to teleport to a level the player has not reached.
/// </para>
/// <para>
/// <c>IsMineEntrance</c> is floor 0's real meaning: it is not "go home" but "return
/// to the mine entrance", and the native handler refuses it outside a MineShaft
/// (MineElevatorMenu.cs:80-88). <c>IsCurrentFloor</c> records the native no-op
/// (MineElevatorMenu.cs:90-93) so the Agent can avoid submitting it.
/// </para>
/// </summary>
public sealed record BridgeMineElevatorFloorTarget(
    string TargetId,
    int Floor,
    bool IsCurrentFloor,
    bool IsMineEntrance);
public sealed record BridgeMineEntranceTarget(string TargetId, int X, int Y);
public sealed record BridgePetBowlTarget(string TargetId, int X, int Y);

public sealed record BridgeSlimeHutchTroughTarget(string TargetId, int X, int Y);

public sealed record BridgePetTarget(string TargetId, int X, int Y, string PetType, int Friendship, bool PettedToday, bool Stationary);

/// <summary>
/// One farm animal (barn/coop stock, `location.animals`) this actor can still pet today, addressed by an identity that
/// carries no coordinate: `FarmAnimal.pet` is reached by walking to wherever the animal currently is, and a barn animal
/// wanders, so a tile in the id would refuse a legitimate request the moment it moved.
///
/// <para>
/// `friendship` is the engine's own `friendshipTowardFarmer`, the field the pet applies its +15 to (capped at 1000), so
/// a caller can read the effect of its own petting from the next observation rather than inferring it.
/// </para>
/// </summary>
public sealed record BridgeFarmAnimalPetTarget(string TargetId, int X, int Y, string AnimalType, int Friendship);

public sealed record BridgeAnimalProductTarget(string TargetId, int Slot, int X, int Y, string AnimalType, string QualifiedProduceItemId, string DisplayName, string ToolKind, int ProduceStack);

/// <summary>
/// One EMPTY trough of an <see cref="AnimalHouse"/> interior, paired with the actor's own Hay slot.
///
/// <para>
/// EVERY FACT ON THIS ROW IS THE TROUGH'S EXCEPT <c>BagHay</c>, AND THE NAME SAYS SO. Membership is the trough's own
/// fact: `DiscoverFeedTroughTargets` publishes a tile only while `location.objects` holds nothing at it, so a row means
/// "this trough holds no hay, and here is the pack stack that can fill it". The number beside it is the ACTOR's - the
/// stack in <c>Slot</c> that `feed_animal` will spend one of - so it is published as `bagHay`.
/// </para>
///
/// <para>
/// THE MEASUREMENT. `round92` day 2 (2026-11-22, `tend_the_animals`, run
/// `.live-runs/game-ladder/2026-11-22T09-12-45-412Z-multiday_routine`): three empty troughs published
/// <c>hayStack: 5</c> each while the pack held one stack of five Hay in slot 9, her thinking read the number as the
/// trough's - "料槽三个都有 5 干草（已够）… 槽里 hayStack 5 表示已有" - and the day neither fed nor collected. A field
/// named for the trough carrying the bag's count is a wrong answer the row itself printed.
/// </para>
/// </summary>
public sealed record BridgeFeedTroughTarget(string TargetId, int Slot, int X, int Y, int BagHay);

/// <summary>
/// One storage container as a SENSED ENTITY: its identity, where it is, and every item inside it.
///
/// <para>
/// `ChestId` is `BuildContainerTargetId` - the same opaque identity `chest_store`/`chest_retrieve` take as their
/// `chestId` argument - so the container an observation names and the container an execution resolves are one
/// spelling.
/// </para>
/// <para>
/// `Items` is the WHOLE mirror: every occupied slot, in the container's own slot order, with no budget and no
/// truncation. A container's contents are a fact about that container; a companion told about 16 of 36 items
/// cannot plan the other 20. The two row-per-pair families this replaced answered `chest_store` and
/// `chest_retrieve` by multiplying the container set against the item set, which is why a full chest published
/// only a window of itself.
/// </para>
/// </summary>
public sealed record BridgeChestState(string ChestId, int X, int Y, string DisplayName, bool IsFridge, IReadOnlyList<BridgeChestItem> Items);

/// <summary>One occupied slot of a <see cref="BridgeChestState"/>: the container's own slot index, what is in it, and how many.</summary>
public sealed record BridgeChestItem(int Slot, string QualifiedItemId, string DisplayName, int Stack);

/// <summary>
/// The chests of the LOCATION the actor is standing in, counted as one bounded line: how many there are, how many items
/// they hold between them, and how many have no free slot left.
///
/// <para>
/// `Chests` is the entity family: one row per container the actor could reach right now, carrying that container's whole
/// contents. It cannot answer "what is in my chests" without the reader counting rows and adding stacks, and its list is
/// bounded to `TargetDiscoveryRadius` (6) so a container across the farm is not in it at all. This is the summary beside
/// it, the same split `wateringWhereabouts` makes beside `cropTargets`.
/// </para>
/// <para>
/// The count is LOCATION-WIDE, not radius-bounded: every eligible container the location holds is counted, including the
/// ones `Chests` leaves out. That is why the field carries no location of its own - it describes `BridgeSnapshot.Location`,
/// the one place the actor is, so there is no second spelling of that fact to disagree with it - and why the rendered fact
/// line says "this location" rather than presenting the number as a world total. A count that silently means "within six
/// tiles" is the defect this exists to avoid: `待浇水作物: 0` printed from a 6-tile scan, measured 2026-10-31.
/// </para>
/// <para>
/// `ItemCount` is the number of ITEMS (the sum of every occupied slot's stack), not the number of occupied slots.
/// `FullCount` counts containers whose occupied slots have reached the engine's own `Chest.GetActualCapacity()`: such a
/// container has no slot left for a new stack, which is what a player means by a full chest. Merging into an existing
/// stack is still possible, so this is a fact about room, not a promise that `chest_store` would refuse.
/// </para>
/// </summary>
public sealed record BridgeChestsSummary(int ChestCount, int ItemCount, int FullCount);

// Lane E: one native Shipping Bin building plus the exact shippable backpack
// slot the actor would hand to Farm.shipItem. X/Y is the bin's top-left
// footprint tile (the actor must stand adjacent to the building), never a tile
// the client may use to retarget the native call.
public sealed record BridgeShippingBinTarget(string TargetId, int X, int Y, int Slot, string QualifiedItemId, string DisplayName, int Stack);
public sealed record BridgeTreeStumpTarget(string TargetId, string Location, int X, int Y, string TreeType, float Health);
public sealed record BridgeTreeSaplingTarget(string TargetId, int Slot, int X, int Y, string QualifiedItemId, string DisplayName);
public sealed record BridgeWeedTarget(string TargetId, string Location, int X, int Y, int Health, bool IsWeeds);

/// <summary>
/// One live grass tuft discoverable on the current map (the TerrainFeature
/// `Grass`, distinct from the Object-layer weeds `cut_weeds` targets).
/// Carries the tuft identity so admission can re-validate before swinging.
/// </summary>
public sealed record BridgeGrassTarget(string TargetId, string Location, int X, int Y, int GrassType, int NumberOfWeeds);
public sealed record BridgeBushTarget(string TargetId, string Location, int X, int Y);
public sealed record BridgeFruitTreeTarget(string TargetId, string Location, int X, int Y);
public sealed record BridgeShakeTreeTarget(string TargetId, string Location, int X, int Y);
public sealed record BridgePedestalTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId, int Stack);
public sealed record BridgeFenceGateTarget(string TargetId, string Location, int X, int Y, bool IsOpen);
public sealed record BridgeCaskTarget(string TargetId, string Location, int X, int Y, bool HasHeldObject, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? HeldQualifiedItemId);
public sealed record BridgeMannequinTarget(string TargetId, string Location, int X, int Y);
public sealed record BridgeSignTarget(string TargetId, string Location, int X, int Y, bool HasDisplayItem, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? DisplayQualifiedItemId);
public sealed record BridgeSiloTarget(string TargetId, string Location, int X, int Y, int Hay);
public sealed record BridgeLanternSlot(int Slot, bool IsOn, int FuelLeft);
/// <summary>
/// One crop tile the scythe owns: a ready <c>scythe</c>-method crop, or a dead crop of any method.
///
/// <para>
/// The four facts <c>scythe_crop</c> branches on are published rather than implied by the row's existence, because the
/// two terminals differ: <c>dead</c> means the tile can only be CLEARED and drops nothing (<c>HoeDirt.cs:732-735</c>),
/// while the harvest branch needs <c>readyForHarvest</c>, a non-forage crop and <c>harvestMethod == scythe</c>
/// (<c>HoeDirt.cs:711-731</c>). None of these move on a tile the radar already published, so a reader cannot infer them
/// from a re-read.
/// </para>
/// </summary>
public sealed record BridgeScytheCropTarget(
    string TargetId,
    string Location,
    int X,
    int Y,
    string CropId,
    string QualifiedHarvestItemId,
    string DisplayName,
    bool ReadyForHarvest,
    bool Dead,
    bool ForageCrop,
    string HarvestMethod,
    string Surface,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SurfaceOwner = null);
public sealed record BridgeInventoryItemFact(int Slot, string QualifiedItemId, string DisplayName, int Stack);

public sealed record BridgeFoodTarget(int Slot, string QualifiedItemId, string DisplayName, int Stack, int Edibility, bool IsDrink);

/// <summary>
/// One learned recipe, published under the exact identity craft_item/cook_recipe
/// accept. The opaque argument alphabet cannot carry the space in a vanilla key
/// ("Wood Fence"), so TargetId is the key itself when it is already wire-legal and
/// otherwise its unique underscore alias - the form TryResolveRecipeIdentity maps
/// back to that same single key. Discovery only: the handler still resolves the
/// identity and evaluates the learned and ingredient gates, so IngredientsAvailable
/// is a fact, not admission.
///
/// <para>
/// MissingIngredients is WHY IngredientsAvailable is false, one row per short
/// ingredient: the boolean alone left the companion knowing a recipe was
/// unmakeable and not what was short, which is the fact a plan is priced from
/// (measured round87b: a Furnace row absent from every observation while
/// craft_item(Furnace) was dispatched and refused craft_ingredients_missing). It is
/// empty - never null, never absent - when nothing is short, because an absent array
/// cannot be told apart from "the producer did not compute it", and those are
/// `not_measured` against `available`. The row therefore states one fact twice, and the
/// two are derived from the same predicate
/// (CraftingRecipe.ItemMatchesForCrafting over the backpack, the walk
/// doesFarmerHaveIngredientsInInventory itself ends in), so the Host can refuse a row
/// where IngredientsAvailable is not exactly `MissingIngredients.Count == 0`.
/// </para>
/// </summary>
public sealed record BridgeRecipeTarget(string TargetId, string DisplayName, bool IngredientsAvailable, IReadOnlyList<BridgeRecipeMissingIngredient> MissingIngredients);

/// <summary>
/// One ingredient a recipe needs and the backpack does not hold enough of.
///
/// <para>
/// QualifiedItemId is the engine's own recipe ingredient key: the QUALIFIED item id
/// when the key names an item (`(O)388`, the spelling the inventory rows carry), and
/// the engine's negative category number when it names a category instead
/// (`-5`, and `-777` for its seasonal-wild-seeds rule) - a recipe's keys are both
/// kinds, because CraftingRecipe.ItemMatchesForCrafting matches an item's Category
/// before it compares any QualifiedItemId (CraftingRecipe.cs:358-378). Held is
/// therefore what that key counts: the carried stack of that item, or, for a category
/// key, the sum across every carried item in the category. Needed is the recipe's own
/// amount, so MissingIngredients never carries an entry that is not short.
/// </para>
/// </summary>
public sealed record BridgeRecipeMissingIngredient(string QualifiedItemId, string DisplayName, int Needed, int Held);

/// <summary>
/// A live cooking station the companion must stand adjacent to: the vanilla
/// kitchen action tile or a placed cookout kit (BC)278. cook_recipe carries only
/// the recipe identity, so this list exists purely to tell the Agent where a
/// station is; dispatch still derives and revalidates the station from the live
/// world and never trusts a client coordinate.
/// </summary>
public sealed record BridgeCookingStationTarget(string TargetId, string Location, int X, int Y, string StationKind);

/// <summary>
/// One reason one discovery family withheld subjects it could see: the wire field the family publishes into, the
/// reason from the closed vocabulary (<c>DiscoveryExclusionReasons</c>), and how many subjects it took.
///
/// <para>
/// <c>Family</c> carries the WIRE FIELD NAME (<c>treeChopSourceTargets</c>, <c>petTargets</c>, ...), so the row is
/// attributable to the family whose list it explains even though all the rows travel in one array: one array is one
/// additive field and one closed vocabulary, where a field per family would have been eighteen more positional
/// parameters on this record and eighteen more validators for one fact. <c>Count</c> is at least one - a zero-count
/// exclusion is not an exclusion - and is a COUNT, never an identity: the subject the filter removed is by
/// definition not addressable, so what a reader can act on is "one mature tapped tree is in range".
/// </para>
/// </summary>
public sealed record BridgeDiscoveryExclusion(string Family, string Reason, int Count);

public sealed record BridgeSnapshot(
    long Revision,
    string Location,
    BridgeTile Tile,
    float Stamina,
    // The persistent native exhaustion flag (Farmer.exhausted). Plain native state,
    // not an interpretation: while it is set, the next day's stamina restore is
    // halved, so the companion must be able to see the cost it just incurred.
    bool Exhausted,
    int Health,
    string? CurrentTool,
    int InventorySlots,
    bool Actionable,
    IReadOnlyList<string> Capabilities,
    long CatalogRevision,
    IReadOnlyList<string> EnabledActionIds,
    BridgeActiveExecution? ActiveExecution,
    IReadOnlyList<BridgeWarp>? Warps,
    IReadOnlyList<BridgeDoor>? DoorTargets,
    IReadOnlyList<BridgeSoilTile>? SoilTiles,
    IReadOnlyList<BridgeToolSlot>? ToolSlots,
    IReadOnlyList<BridgeWateringCanFact>? WateringCanFacts,
    IReadOnlyList<BridgeRefillWateringCanTarget>? RefillWateringCanTargets,
    IReadOnlyList<BridgeForageTarget>? ForageTargets,
    IReadOnlyList<BridgeItemTarget>? ItemTargets,
    IReadOnlyList<BridgeCropTarget>? CropTargets,
    IReadOnlyList<BridgePetBowlTarget>? PetBowlTargets,
    IReadOnlyList<BridgeSlimeHutchTroughTarget>? SlimeHutchTroughTargets,
    IReadOnlyList<BridgeHarvestTarget>? HarvestTargets,
    IReadOnlyList<BridgeSeedTarget>? SeedTargets,
    IReadOnlyList<BridgeFertilizerTarget>? FertilizerTargets,
    IReadOnlyList<BridgeWoodFenceTarget>? WoodFenceTargets,
    IReadOnlyList<BridgeWoodFenceResultTarget>? WoodFenceResultTargets,
    IReadOnlyList<BridgeCrabPotTarget>? CrabPotTargets,
    IReadOnlyList<BridgeCrabPotResultTarget>? CrabPotResultTargets,
    IReadOnlyList<BridgeCrabPotCollectTarget>? CrabPotCollectTargets,
    IReadOnlyList<BridgeBaitCrabPotTarget>? BaitCrabPotTargets,
    IReadOnlyList<BridgeBaitCrabPotResultTarget>? BaitCrabPotResultTargets,
    IReadOnlyList<BridgeDebrisTarget>? DebrisTargets,
    IReadOnlyList<BridgeRockSourceTarget>? RockSourceTargets,
    IReadOnlyList<BridgeClearHoeDirtTarget>? ClearHoeDirtTargets,
    IReadOnlyList<BridgeArtifactSpotTarget>? ArtifactSpotTargets,
    IReadOnlyList<BridgeArtifactSpotResultTarget>? ArtifactSpotResultTargets,
    int? ArtifactSpotFarmSourceCount,
    IReadOnlyList<BridgeMachineTarget>? MachineTargets,
    IReadOnlyList<BridgeTreeChopSourceTarget>? TreeChopSourceTargets,
    IReadOnlyList<BridgeTreeChopResultTarget>? TreeChopResultTargets,
    IReadOnlyList<BridgeTreeStumpTarget>? TreeStumpTargets,
    IReadOnlyList<BridgeTreeSaplingTarget>? TreeSaplingTargets,
    IReadOnlyList<BridgeWeedTarget>? WeedTargets,
    IReadOnlyList<BridgeGrassTarget>? GrassTargets,
    IReadOnlyList<BridgeCaskTarget>? CaskTargets,
    IReadOnlyList<BridgeMannequinTarget>? MannequinTargets,
    IReadOnlyList<BridgeSignTarget>? SignTargets,
    IReadOnlyList<BridgeSiloTarget>? SiloTargets,
    IReadOnlyList<BridgeLanternSlot>? LanternSlots,
    IReadOnlyList<BridgeScytheCropTarget>? ScytheCropTargets,
    IReadOnlyList<BridgeNpcRelationshipTarget>? NpcRelationshipTargets,
    IReadOnlyList<BridgeVillagerWhereabouts>? VillagerWhereabouts,
    IReadOnlyList<BridgeHarvestWhereabouts>? HarvestWhereabouts,
    IReadOnlyList<BridgeWateringWhereabouts>? WateringWhereabouts,
    IReadOnlyList<BridgePetTarget>? PetTargets,
    // Farm animals (cows/chickens/etc.) that this actor has NOT petted today. `pet_animal` is the household Pet; this
    // family is `FarmAnimal.pet`, whose +15 friendship and `wasPet` marker are per farmer and per day.
    IReadOnlyList<BridgeFarmAnimalPetTarget>? FarmAnimalPetTargets,
    IReadOnlyList<BridgeAnimalProductTarget>? AnimalProductTargets,
    IReadOnlyList<BridgeFeedTroughTarget>? FeedTroughTargets,
    // The container family as SENSED ENTITIES: one row per eligible storage container in range, carrying the
    // container's own execution identity and the contents of every occupied slot inside it, in slot order and
    // without truncation. Perception is the complete mirror; the container list itself stays distance-bounded
    // like every other radar family. Named `Chests` because that is the wire field the Host validates (`chests`
    // in host/src/protocol.ts, `isChestStateFact`): the family is the container list, not a list of target rows.
    // Positional and required here, unlike its defaulted siblings, because the two row-per-pair families it
    // replaced are gone: there is no earlier parameter to preserve an argument order against.
    IReadOnlyList<BridgeChestState>? Chests,
    // The container SUMMARY beside the container family: the location's chests, their items and how many are full, in one
    // row instead of a list the reader has to add up. Location-wide, so it answers a question `Chests` cannot (that family
    // is radius-bounded), and published under the same capability gate because both describe the same containers.
    BridgeChestsSummary? ChestsSummary,
    IReadOnlyList<BridgeInventoryItemFact>? InventoryItemFacts,
    IReadOnlyList<BridgeFoodTarget>? FoodTargets,
    IReadOnlyList<BridgeShippingBinTarget>? ShippingBinTargets,
    IReadOnlyList<BridgeRecipeTarget>? CraftingRecipeTargets,
    IReadOnlyList<BridgeRecipeTarget>? CookingRecipeTargets,
    IReadOnlyList<BridgeCookingStationTarget>? CookingStationTargets,
    IReadOnlyList<BridgeMinecartTarget>? MinecartTargets,
    IReadOnlyList<BridgeMineElevatorFloorTarget>? MineElevatorFloorTargets,
    /// <summary>Shops with an eligible owner in the CURRENT location. The owner tile is
    /// reported so the Agent can walk into native interaction range itself; this action
    /// deliberately does not path (it refuses with shop_counter_out_of_reach instead).</summary>
    IReadOnlyList<BridgeShopTarget>? ShopTargets,
    IReadOnlyList<BridgeBushTarget>? BushTargets,
    IReadOnlyList<BridgeFruitTreeTarget>? FruitTreeTargets,
    IReadOnlyList<BridgeShakeTreeTarget>? ShakeTreeTargets,
    IReadOnlyList<BridgePedestalTarget>? PedestalTargets,
    IReadOnlyList<BridgeFenceGateTarget>? FenceGateTargets,
    // Macro time context. Native behaviour is time-driven -- a Pet sleeps from
    // 20:00, villagers follow schedules, shops close, crops advance -- but the
    // snapshot previously published no time at all, so the companion could not
    // reason about any of it. These are plain reads of Game1 state: no
    // interpretation, no derived phases, no advice about what the hour implies.
    int TimeOfDay,
    int DayOfMonth,
    int SeasonIndex,
    int Year,
    // The native weather flags (Game1.isRaining / isSnowing / isLightning /
    // isDebrisWeather) projected as a single stable token. Same macro-context
    // rule as the date fields: plain native reads, no interpretation.
    string Weather,
    string PresentationLocale,
    IReadOnlyList<BridgeRaftTarget>? RaftTargets = null,
    IReadOnlyList<BridgeHorseTarget>? HorseTargets = null,
    IReadOnlyList<BridgeMineEntranceTarget>? MineEntranceTargets = null,
    // Defaulted and LAST on purpose: the three siblings above already end the positional list, so
    // inserting anywhere earlier silently re-binds their existing positional arguments.
    IReadOnlyList<BridgeObeliskTarget>? ObeliskTargets = null,
    IReadOnlyList<BridgeAnimalDoorTarget>? AnimalDoorTargets = null,
    // The ponds the actor could empty right now. Advertised only while the action is itself
    // advertised, and never an empty pond: an empty one has nothing to clear.
    IReadOnlyList<BridgeFishPondTarget>? FishPondTargets = null,
    // Defaulted and LAST for the same reason as its siblings above: the positional list is
    // already closed by the parameters before it.
    IReadOnlyList<BridgeBuildingChestTarget>? BuildingChestTargets = null
,
    // The world-object lane's projection. ONE array, four kinds: a placement candidate names the
    // tile and the backpack slot a placeable item would take (the object does not exist yet),
    // and the objects already on world tiles name the slot an axe, a pickaxe or a heavy hitter
    // would act through. See BridgeWorldObjectTarget in WorldObjectTargetModels.cs.
    IReadOnlyList<BridgeWorldObjectTarget>? WorldObjectTargets = null
    // Item/tile lane projections. Defaulted and LAST for the same reason as the siblings
    // above: the positional list is already closed by the parameters before them.
    ,IReadOnlyList<BridgeWarpItemTarget>? WarpItemTargets = null
    ,IReadOnlyList<BridgePanSiteTarget>? PanSites = null
    ,IReadOnlyList<BridgeMailboxTarget>? MailboxTargets = null

        ,
        // The actor's OWN wearable body slots (hat/boots/shirt/pants/left_ring/right_ring): the
        // discovery projection the two wearable actions' expectedTargetId is taken from. Every slot
        // is published, empty or not, because an EMPTY slot is exactly the target an equip into a
        // free slot names; the occupant fields say which are filled. Defaulted and LAST for the same
        // reason as its siblings above: the positional list is already closed by the parameters
        // before it.
        IReadOnlyList<BridgeWearableTarget>? WearableTargets = null,
        // The chests this actor can repaint right now, each carrying the colour it already has. Published
        // only while its own action is advertised. Defaulted and LAST for the same reason as its siblings
        // above: the positional list is already closed by the parameters before it.
        IReadOnlyList<BridgeColorTarget>? ColorTargets = null,
        // The farm-building lane's projection: the commission sites this actor can name right now
        // (`build_site`) and the buildings already standing (`built`), so the caller can see its own
        // commission change the published fact. Defaulted, like every sibling projection.
        IReadOnlyList<BridgeFarmBuildingTarget>? FarmBuildingTargets = null,
        // The World Model's disposition for this tick - the single authority every consumer reads
        // instead of re-deriving the body's environment (WIA rev C). `Kind` is one of idle, modal,
        // event, pass_out, transient; `Detail` names the modal class or transient kind when the kind
        // carries one, and is null otherwise; `ActionOwned` is the L0 binary for a modal, true when the
        // newest execution opened it and false when the world did. Published so the Agent can see WHAT
        // is holding the body rather than only that it cannot act.
        string ActorDispositionKind = "idle",
        string? ActorDispositionDetail = null,
        bool ActorDispositionActionOwned = false,
        // The day's posted quest, published only while `accept_daily_quest` is advertised and the
        // game would accept it - the discovery projection the action's expectedTargetId comes from -
        // plus the world flag the accept turns true. Defaulted and LAST for the same reason as the
        // siblings above: the positional list is already closed by the parameters before them.
        IReadOnlyList<BridgeDailyQuestTarget>? DailyQuestTargets = null,
        bool? AcceptedDailyQuest = null,
        // The offered special orders plus the team's own active-order read, published only while
        // `accept_special_order` is advertised - the discovery projection that action's expectedTargetId
        // comes from - and the museum's reward set for `claim_museum_reward`. Defaulted and LAST for the
        // same reason as their siblings above.
        IReadOnlyList<BridgeSpecialOrderTarget>? SpecialOrderTargets = null,
        IReadOnlyList<string>? ActiveSpecialOrderKeys = null,
        IReadOnlyList<BridgeMuseumRewardTarget>? MuseumRewardTargets = null
    
    // The sewing-machine targets this actor can act on right now: defaulted and LAST for the same reason as
    // its siblings above - the positional list is already closed by the parameters before it.
    ,IReadOnlyList<BridgeTailoringTarget>? TailoringTargets = null,
    // The level-ups the engine will ask about at the next night boundary, as `skill@level` (0 Farming … 5 Luck). The
    // engine pushes one LevelUpMenu per entry in `player.newLevels` (Game1.cs:9130-9134), and until this field existed
    // the harness learned the pending pair by PARSING THE REFUSAL receipt of `dismiss_modal` - reading a fact out of a
    // failure. Defaulted and LAST for the same reason as its siblings above.
    IReadOnlyList<string>? PendingLevelUps = null,
    // The pending profession MILESTONES (level 5 and 10) the engine will offer: the `(skill, level)` pair and both
    // candidate professions in the game's own card order, each carrying the engine's own title and description
    // (`LevelUpMenu.getProfessionTitleFromNumber` / `getProfessionDescription`, public statics). The boundary card
    // requires the companion to SEE the options before choosing - a profession is a permanent, synced save field, so
    // a blind choice is worse than stopping. Derived from the engine's own rule (`LevelUpMenu.cs:421-437`), never
    // from the menu's private `professionsToChoose`. Defaulted and LAST for the same reason as its siblings above.
    IReadOnlyList<BridgeLevelUpChoice>? PendingLevelUpChoices = null,
    // The actor's own profession ids. A fresh read of this set is how a caller sees that a profession branch landed
    // on the chosen id and NOT on the other card, and the level-5 choice a level-10 pair continues from is a member
    // of it. Defaulted and LAST for the same reason as its siblings above.
    IReadOnlyList<int>? Professions = null,
    // The farmer's ACTIVE tool slot (`Farmer.CurrentToolIndex`) and what that slot holds, whatever its kind. A tool
    // action takes a `slot` it RECORDS and then selects the tool its own claim declares, so this index is what the actor
    // was holding - never a precondition the caller has to satisfy - and the companion cannot name it statically: last
    // night's `invalid_tool_selector` receipts were that guess failing. `currentToolSlotItem` names the occupant even
    // when it is NOT a tool, so a present occupant beside an absent `currentTool` reads as "holding something that is
    // not a tool" rather than as an equip that silently did nothing. Null only while the world is not ready, like every
    // sibling projection.
    // Defaulted and LAST for the same reason as its siblings above.
    int? CurrentToolSlot = null,
    string? CurrentToolSlotItem = null,
    // The map's OWN fixed interaction points, whole-map and small: no entities, no reachability. Every
    // other family in this record is either an entity within `TargetDiscoveryRadius` or a table the engine
    // keeps for itself (`warps`, `doorTargets`); a mine level's ladder tile is in neither, which is why a
    // companion that entered a mine could name no way out. `fixedInteractionPointsOmitted` counts the
    // points the cap left out, so truncation is stated rather than silent.
    // Defaulted and LAST for the same reason as its siblings above: the positional list is already
    // closed by the parameters before them.
    IReadOnlyList<BridgeFixedInteractionPoint>? FixedInteractionPoints = null,
    int? FixedInteractionPointsOmitted = null,
    // The soil tiles the cap left out, beside the family it truncates: `soilTiles` is a bounded slice of a 13x13
    // neighbourhood, so without this count a patch larger than the bound is indistinguishable from a complete one.
    // Defaulted and LAST for the same reason as its siblings above: the positional list is already closed.
    int? SoilTilesOmitted = null,
    // The same statement for the building family: `farmBuildingTargets` is capped at eight `built` rows, so a farm with
    // more buildings than the bound used to answer "eight" whether it had eight or eighty.
    int? FarmBuildingTargetsOmitted = null,
    // What discovery WITHHELD, and why: the sibling of the truncation counts above. `soilTilesOmitted` states "the cap
    // took rows"; this states "the filter took rows, and here is the reason". Without it a family's empty list answers
    // "there is a tree here but you cannot chop it" and "there is no tree here" with the same `[]`, and the companion
    // plans against an empty world. Null when no exclusion-reporting capability was advertised this snapshot (the
    // family was not measured); an empty array when one was and nothing was withheld - the two are different answers,
    // exactly as `soilTiles` null differs from `soilTiles: []`.
    // Defaulted and LAST for the same reason as its siblings above: the positional list is already closed.
    IReadOnlyList<BridgeDiscoveryExclusion>? DiscoveryExclusions = null,
    int? DiscoveryExclusionsOmitted = null,
    // The seed-shortage SUPPLY fact, beside the family it answers: one row per (plantable seed the actor HOLDS x shop
    // whose stock sells it), carrying the charged price, the row's declared price, the owner's own hours condition and
    // the engine's open-now answer. Published only while `plant_seed` is advertised and bounded to eight rows, with the
    // count the cap left out beside it. Null means NOT MEASURED; an empty array is the measured answer "she holds no
    // plantable seed", exactly as `soilTiles` null differs from `soilTiles: []`.
    IReadOnlyList<BridgeSeedSupplyTarget>? SeedSupplyTargets = null,
    int? SeedSupplyTargetsOmitted = null,
    // The tiles this location's own engine predicates say a rod may be cast at - the discovery projection `fish_here`'s
    // expectedTargetId comes from. Published only while `fish_here` is advertised. Defaulted and LAST for the same reason
    // as its siblings above: the positional list is already closed by the parameters before them.
    IReadOnlyList<BridgeWaterTarget>? WaterTargets = null,
    // Whether the LOCATION half of the night's own eligibility admits where the actor stands - the same `HomeOf`
    // declaration `TryEnterEligibility` refuses `not_home` from, read on the game thread. Only the location half: the
    // clock, an open menu, a running event and the co-op minimum are separate and transient, so this answers "can the
    // day end here" and never "will `sleep` succeed now". Absent when no world is ready. Nullable and LAST for the same
    // reason as its siblings: the positional list is already closed by the parameters before them.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? SleepAdmitsHere = null,
    // The actor's WALLET (`Farmer.Money`), which is what every price on this wire is denominated in. Absent only while
    // no world is ready, exactly as the store projections beside it are - and absent means NOT MEASURED, so no consumer
    // may read a missing wallet as "0 gold" or as "can afford it".
    //
    // Measured round87b (2026-11-21): `shop_purchase` was dispatched at 75g a unit with 35g in hand, and nothing in the
    // snapshot could have answered whether 15 of them were affordable - the wallet was on no field at all. Published as
    // a plain native read, no interpretation: what to buy, and whether to walk, stays the caller's decision.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Money = null,
    // The world-object rows the lane's caps left out of `worldObjectTargets` - the same statement the soil, building,
    // seed-supply and exclusion registers make beside their own lists. Its population is every kind the lane publishes
    // (placement candidates, objects, placed furniture, empty pedestals), and the reason it had to exist: the object half
    // publishes EVERYTHING standing in `location.objects` now, so a farmhouse or a cluttered farm routinely offers more
    // than the sixteen object rows one budget admits, and a reader receiving sixteen cannot tell that room from one with
    // exactly sixteen.
    //
    // A CAP IS NOT THE ONLY REASON A ROW IS ABSENT FROM THE LIST, and both reasons are the same fact here - "the room
    // holds a subject this list does not name": a subject another family already publishes (a storage container, a
    // mannequin, a sign) is withheld by `SubjectsOwnedBySiblingFamilies` and counted here too, and the Mod logs which
    // family owns which subject and where (`world_object_targets_owned_elsewhere`). Anything published by exactly one
    // family is still published; what this count never means is "the row was dropped because its item id looked wrong".
    // Null when the family itself was not measured (none of its capabilities advertised).
    // Defaulted and LAST for the same reason as its siblings above: the positional list is already closed.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? WorldObjectTargetsOmitted = null,
    // The OTHER HUMAN PLAYERS this observation can see - the one fact nothing in this record used to carry. Crops, weeds,
    // objects, chests, animals, villagers, buildings and ground were all published; the person standing at (33,17) facing
    // left with a watering can was on no field at all, so a co-op session read as an empty farm with a companion in it.
    // Read from `Game1.otherFarmers` (see `BridgeOtherFarmerTarget`), window-limited like every other entity family, and
    // NOT gated on an advertised capability: there is no action to gate it behind, and a perception fact that appears only
    // once some action is unlocked is a fact about the action surface rather than about the world.
    // Defaulted and LAST for the same reason as its siblings above: the positional list is already closed.
    IReadOnlyList<BridgeOtherFarmerTarget>? OtherFarmers = null,
    // The other farmers the window left out: this family is radius-bounded like its siblings, so a farm with one human
    // standing at the far end must not read as a farm with nobody else on it. Null when the family was not measured, an
    // empty array's count being the measured zero.
    int? OtherFarmersOmitted = null);

public sealed record BridgeActiveExecution(
    string ExecutionId,
    string RequestId,
    string Action,
    string State,
    string ReasonCode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyDictionary<string, string>? Evidence,
    // Who holds the body, as the SAME named code (`body_owned_*`) a refusal would carry, plus whether a new
    // directive may replace the holder. Both are derived from the Mod's single body-owner table, so the
    // observation surface and the refusal vocabulary cannot disagree. Optional and last: a settled body and
    // the world-not-ready snapshot keep ActiveExecution null, and existing positional construction is unchanged.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? OwnerKind = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Interruptible = null,
    // The holder's PHASE and whether that hold can still be released, both read from the same owner table as
    // `OwnerKind`. Cancel safety is a property of the phase, never of an action id: an approach leg is motion
    // (stoppable, held in the same KIND as `move_to_tile`) while everything from the native release onwards is
    // committed and exits only through its terminal receipt. Optional and last, for the same reason as above.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Phase = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? CancelSafe = null
);

/// <summary>
/// What this Mod's own journal says about the programme an execution belongs to: the exact node that started it
/// (`programme`), the fact that no node did (`standalone`), or the fact that the journal could not answer
/// (`unattributed`).
///
/// <para>
/// IT TRAVELS WITH EVERY RECEIPT AND EVERY BODY TRACE, because those are the two statements of one step and a consumer
/// that has to file either of them must not be left inferring which programme it belongs to. The tokens are the union the
/// Host's protocol validates, so a token added here without a Host member is refused at the bridge rather than read as an
/// unknown.
/// </para>
/// </summary>
public sealed record BridgeExecutionOrigin(string Kind, string? ProgramId = null, string? NodeId = null);

public sealed record BridgeReceipt(
    string ExecutionId,
    string RequestId,
    string ActionId,
    string State,
    string ReasonCode,
    long Revision,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyDictionary<string, string>? Evidence,
    BridgeExecutionOrigin Origin,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BridgeLocalObservation? Observation = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ObserveSceneResultPayload? PiggybackedScene = null,
    // Raw native HUD notice text observed inside the action's synchronous
    // window. Ephemeral wire-only evidence: the Mod never interprets it and no
    // durable journal record retains it.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? NativeNotices = null
);

public sealed record BridgeError(string ReasonCode);

public sealed record BridgeSemanticEvent(
    string Kind,
    long Revision,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeActiveExecution? ActiveExecution,
    string ReasonCode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BridgeBodyTrace? BodyTrace = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BridgePlayerControlFact? PlayerControl = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BridgeStopObservation? StopObservation = null
);

public sealed record BridgePlayerControlFact(
    string Kind,
    string ControlId,
    string SourceEventId,
    string? Text,
    string Locale,
    string IssuerPlayerId
);

public sealed record BridgeStopObservation(
    string Kind,
    string StopId,
    string SourceEventId,
    long Epoch
);

public sealed record BridgeBodyTrace(
    string Category,
    string ExecutionId,
    string RequestId,
    int Tick,
    long Revision,
    string? Location,
    BridgeTile? Tile,
    BridgeExecutionOrigin Origin
);

public sealed class BridgeExecutionArgs
{
    public float? X { get; init; }
    public float? Y { get; init; }
    public int? Slot { get; init; }
    /// <summary>The published identity of the storage container a `chest_store` / `chest_retrieve`
    /// names. It carries the location, the tile and the chest type inside the id itself, so the body
    /// re-derives the tile from it instead of being handed a second copy that could disagree.</summary>
    public string? ChestId { get; init; }
    /// <summary>The FIRST sewing-machine slot a tailoring request names (the recipe's first ingredient for
    /// `tailor_clothing`, the garment for `dye_clothing_with_item`). Only the tailoring pair uses it.</summary>
    public int? LeftSlot { get; init; }
    /// <summary>The SECOND sewing-machine slot (the reagent, or the dye item).</summary>
    public int? RightSlot { get; init; }
    /// <summary>The palette index a `color_placed_object` repaint asks for. The bound belongs to the
    /// GAME (`DiscreteColorPicker.totalColors`), so the acceptance layer only refuses negatives and the
    /// handler names `invalid_color_selection` for anything outside the palette.</summary>
    public int? ColorSelection { get; init; }
    /// <summary>Semantic tool selector (equip_tool/v2): a canonical category that the
    /// Mod resolves deterministically on the game thread; slot stays Mod-private.</summary>
    public string? Tool { get; init; }
    public string? ExpectedQualifiedItemId { get; init; }
    public string? ExpectedTargetId { get; init; }
    /// <summary>The `Data/Buildings` type id a build_farm_building commission is for (the value
    /// `CarpenterMenu.BlueprintEntry.Id` carries for the selected blueprint).</summary>
    public string? BuildingType { get; init; }
    /// <summary>How many units to buy. Only shop_purchase uses it today; the Mod clamps it
    /// against the live stock and the player's purse on the game thread.</summary>
    public int? Quantity { get; init; }
    public ObservationBindingV1? SceneTarget { get; init; }
    public BridgeNavigationDestinationSelector? Destination { get; init; }
    public string? Emote { get; init; }
    public string? Direction { get; init; }
    public string? ResponseKey { get; init; }
    /// <summary>Which native level-up response to apply (respond_level_up): `confirm` settles an ordinary
    /// level through the menu's own `okButtonClicked`, and `branch_a`/`branch_b` are the left/right profession
    /// the menu offers at levels 5 and 10. There is no default branch: the pair the game offers at level 10
    /// depends on the level-5 choice, so picking one here would take a decision that belongs to the companion.</summary>
    public string? Choice { get; init; }
    /// <summary>The `(skill, level)` pair the caller believes the displayed LevelUpMenu is about. The Mod refuses
    /// unless the menu's own pair matches, so a persistent save write cannot be applied to the wrong level-up.</summary>
    public int? ExpectedSkill { get; init; }
    public int? ExpectedLevel { get; init; }
    /// <summary>One chat line's text (send_multiplayer_chat). The native ingress is a single
    /// 896-px line, so the value is bounded by the Mod's own maximum rather than by this type.</summary>
    public string? Text { get; init; }
    /// <summary>How far the actor charges its tool before ONE native use (`till_soil`, `water_crop`). `0` is the plain
    /// vanilla tap and covers exactly the named tile; above it the engine's own rectangle (`Tool.tilesAffected`, whose
    /// power is `who.toolPower.Value`) covers 3/5/9/18/25 tiles, rotated by `who.FacingDirection`. The ladder's ends are
    /// bounded here; the ceiling of a particular act is the held tool's upgrade level, which only the game thread can
    /// read and which it refuses by name.</summary>
    public int? Charge { get; init; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalProperties { get; init; }
}

/// <summary>
/// <para>
/// One shop the player could actually buy from right now.
/// </para>
/// <para>
/// Discovery does NOT scan map tiles for "shop tiles". The game hardcodes which tile opens
/// which shop per location (GameLocation.checkAction calls TryOpenShopMenu with a literal
/// shop id), so a tile scan cannot generalise — only Dwarf and Krobus open a shop from
/// NPC.checkAction. Instead this walks `Data/Shops`, asks the game which owner entries are
/// currently eligible via `ShopBuilder.GetCurrentOwners` (that is where ShopOwnerData's
/// `Condition` game-state-query is evaluated), and then reports the shop only when its
/// owner NPC is in the CURRENT location within the native interaction radius.
/// </para>
/// <para>
/// <c>ClosedMessage</c> is the game's own text for "this shop is closed", so a refusal can
/// quote the game rather than invent a reason.
/// </para>
/// </summary>
/// <summary>A building's animal door, identified opaquely so the caller names the structure and
/// never the door's internal rectangle. `IsOpen` is part of the published fact because the action's
/// postcondition is that the state FLIPS, and a target whose identity ignores its state cannot be
/// verified.</summary>
public sealed record BridgeAnimalDoorTarget(string TargetId, string Location, int X, int Y, string BuildingType, bool IsOpen);

/// <summary>A built fish pond that currently HOLDS fish, identified opaquely so the caller names the
/// structure and never its internal state. `Occupants` is published because it is what the action would
/// eject (the body spawns one fish item per occupant as ground debris, so the count is what the player
/// recovers) - an EMPTY pond is never advertised, since it has nothing to clear.</summary>
public sealed record BridgeFishPondTarget(string TargetId, string Location, int X, int Y, string BuildingType, int Occupants, string FishType);

/// <summary>One sewing-machine target the actor can act on right now: the pair of backpack slots and the
/// item ids they hold, the kind of act (`craft` or `dye`), the qualified id the act produces, and - for a dye
/// target - the garment's CURRENT colour and name, because the colour is the fact
/// `dye_clothing_with_item` changes and this projection is the only read of it.</summary>
public sealed record BridgeTailoringTarget(
    string TargetId,
    string Kind,
    int LeftSlot,
    int RightSlot,
    string LeftQualifiedItemId,
    string RightQualifiedItemId,
    string OutputQualifiedItemId,
    string? GarmentColour,
    string? GarmentName);


/// <summary>One named inventory a BUILDING declares in its own data (Data/Buildings ->
/// BuildingData.Chests), reached from a tile on the building's exterior. `ChestId` and `Branch`
/// are the declared identity and the native branch the chest takes (`load` or `collect`); the
/// Chest-type branch is never published because it can only open a container menu.
/// `StackCount` is the number of occupied slots and `ItemCount` the number of items, both read
/// from the live chest: they are published because the two branches' own preconditions are
/// stated in those terms, so an Agent that could not see them would have to guess whether a
/// call can succeed. A Load chest additionally publishes the inventory slot holding an item its
/// own conversion accepts (`LoadInputSlot`/`LoadInputQualifiedItemId`/`LoadInputStack`, the
/// `slot` argument `load_building_chest` requires) or omits all three when the actor holds
/// nothing loadable; the Mod's serializer omits null members, so the Host accepts their
/// absence exactly as it does for `machineTargets`.</summary>
/// <summary>One placed chest the actor can name for `color_placed_object`, projected read-only
/// from live state: the opaque id discovery published, its tile and location, and the colour it
/// currently carries. What the write changes is the colour, so the colour is what the caller reads.</summary>
public sealed record BridgeColorTarget(string TargetId, string Location, int X, int Y, string Color);

/// <summary>
/// One PENDING profession milestone the engine will offer at the next night boundary, projected so the companion
/// can see the choice before it writes it. `LeftId`/`RightId` are the two candidates in the game's own card order
/// (`branch_a` addresses the left card, `branch_b` the right), each with the engine's own title and description.
/// `PreviousProfession` is the level-5 profession a level-10 pair continues from - the constraint that decides
/// which pair the engine offers - or null when the pair does not depend on an earlier choice.
/// </summary>
public sealed record BridgeLevelUpChoice(
    int Skill,
    int Level,
    int? PreviousProfession,
    int LeftId,
    string LeftTitle,
    string LeftDescription,
    int RightId,
    string RightTitle,
    string RightDescription);

public sealed record BridgeBuildingChestTarget(
    string TargetId,
    string Location,
    int X,
    int Y,
    string BuildingType,
    string ChestId,
    string Branch,
    int StackCount,
    int ItemCount,
    int? LoadInputSlot = null,
    string? LoadInputQualifiedItemId = null,
    int? LoadInputStack = null);

/// <summary>One farm-building fact the build_farm_building caller can name. `Kind` is what the
/// fact IS for this lane, never a client-supplied classification: <c>build_site</c> is a free
/// footprint the named building type could go on now (the structure does not exist yet, so
/// <c>BuildingId</c> is the literal `none` and <c>DaysOfConstructionLeft</c> is -1), and
/// <c>built</c> is a building already standing in the current location, carrying its own durable
/// <c>Building.id</c> and its `daysOfConstructionLeft`. <c>BuildCost</c> and <c>BuildDays</c> are
/// the type's own `Data/Buildings` facts, published because they are what the commission charges
/// and how long it takes - the two halves of the world change a receipt must be able to show.
///
/// A `built` row also carries the two scene facts the engine answers about the structure none of the
/// footprint could: where its door is (<c>HumanDoor</c>) and which rows in front of it its own tile data
/// calls its own (<c>OwnTiles</c>). Measured `round98`: she stood three tiles from a greenhouse, read the
/// footprint on the line, and still could not walk in or tell that the stone under the tile she was
/// standing on belonged to the building rather than to the field.</summary>
public sealed record BridgeFarmBuildingTarget(
    string TargetId,
    string Kind,
    string Location,
    int X,
    int Y,
    string BuildingType,
    string DisplayName,
    int BuildCost,
    int BuildDays,
    string BuildingId,
    int DaysOfConstructionLeft,
    // The footprint the structure occupies, in tiles, with `X`/`Y` as its LEFT-TOP origin. A `built` row carries the
    // standing building's own `tilesWide`/`tilesHigh`; a `build_site` row carries the type's declared `Size`, because the
    // structure does not exist yet and the numbers still decide which tiles the commission will take. Without them a
    // coop and a cabin read as the same one-tile square.
    int W,
    int H,
    // WHERE THE DOOR IS: `Building.getPointForHumanDoor()`, which is `tileX + humanDoor.X, tileY + humanDoor.Y`
    // (Building.cs:1925-1928) over the offset the type's own `Data/Buildings` entry declares (Building.cs:502-503). It
    // is the tile an `enter_exit` addresses and the tile a walk-to-the-door plan has to reach, and without it a row said
    // a greenhouse was standing three tiles away and nothing about how to get in.
    //
    // ONE SPELLING, AND IT IS ABSENCE: a building whose data declares no door (a silo, a fish pond, an obelisk - what
    // `BuildingContact.WithoutHumanDoor` names) and a `build_site` row, where no structure exists, carry no member at
    // all - this Mod's serializer omits nulls, so a null would read as an absent member anyway and a second spelling
    // would only invite a reader to tell two identical things apart.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] TilePoint? HumanDoor = null,
    // WHAT THE STRUCTURE'S OWN TILE DATA SAYS ABOUT THE ROWS IN FRONT OF IT: the tiles OUTSIDE its footprint that
    // `Building.doesTileHaveProperty` answers a `Type` word for (Building.cs:2419-2432 against the type's declared tile
    // properties, widened by `GreenhouseBuilding.doesTileHaveProperty`, GreenhouseBuilding.cs:60-97). The map under them
    // says nothing - measured `round98`, the ruined greenhouse's stone doorstep at `27..29 x 16..17` read as `Diggable`
    // farm soil, which is how a cauliflower was sown in the doorway. The footprint is NOT repeated here: the porch is
    // the part of the structure that is not the structure.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<TilePoint>? OwnTiles = null,
    // The tiles the lane's own cap (8) left out of `OwnTiles`, so a porch longer than the bound says so beside the
    // tiles it bounded rather than reading as the whole of it.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? OwnTilesOmitted = null);

/// <summary>One owned warp totem the actor can activate right now. `Slot` and
/// `QualifiedItemId` are exactly the action's arguments, and `Destination` is derived by the
/// same helper the action executes with, so the projection and the execution cannot
/// disagree. `Stack` is published because the native pair consumes one unit, which the
/// receipt must be able to show.</summary>
public sealed record BridgeWarpItemTarget(int Slot, string QualifiedItemId, string DisplayName, int Stack, string Destination, int DestinationX, int DestinationY);

/// <summary>The current location's live ore-pan site. The game owns at most one per location
/// (`GameLocation.orePanPoint`) and `performOrePanTenMinuteUpdate` is its only creator, so
/// nothing is published while the point is unset. There is no target id: the tile IS the
/// identity the request names, re-resolved against that live state.</summary>
public sealed record BridgePanSiteTarget(int X, int Y);

/// <summary>One mailbox tile in the current location, identified opaquely. `TargetId` binds
/// the location, the tile, the pending count AND the head letter, so a request that has
/// already been served is refused instead of claiming the NEXT letter; the head letter id is
/// hashed INTO the id and never published, so the projection carries the mail count without
/// carrying mailbox content.</summary>
public sealed record BridgeMailboxTarget(string TargetId, string Location, int X, int Y, int PendingCount);

/// <summary>One special order the player team is offering and no board has been used for, identified opaquely so the caller names the offer and never a raw native order. QuestKey and GenerationSeed are part of the identity the action re-resolves; OrderType is the board type the accept's own marker is keyed by (empty for the town board, which is a legal value).</summary>
public sealed record BridgeSpecialOrderTarget(string TargetId, string QuestKey, string OrderType, int GenerationSeed);

/// <summary>The museum's whole current reward set, identified opaquely. RewardCount is how many item rewards a claim would collect, published because it is what the action's own precondition tests; the reward-data keys themselves are hashed INTO the id and never published.</summary>
public sealed record BridgeMuseumRewardTarget(string TargetId, string Location, int RewardCount);

/// <summary>The day's posted help-wanted quest, identified opaquely and published only while
/// `accept_daily_quest` is advertised AND Game1.CanAcceptDailyQuest() is true - the same predicate
/// the board's own Accept button reads for its visible flag. It carries no tile: the offer is native
/// world state, not a position. QuestType is the native quest-type value and Title the game's own
/// title, so a receipt can be tied to the offer that produced it.</summary>
public sealed record BridgeDailyQuestTarget(string TargetId, int QuestType, string Title);

public sealed record BridgeObeliskTarget(
    string TargetId,
    string Route,
    string Location,
    int X,
    int Y,
    string DisplayName,
    string Destination,
    bool ForceDismount);

public sealed record BridgeShopTarget(
    string TargetId,
    string ShopId,
    string OwnerName,
    string Location,
    int OwnerTileX,
    int OwnerTileY,
    bool OwnerInReach,
    int StockCount,
    // The wire identities of what this shop can actually sell right now. Never null: the
    // Mod's serializer omits null values (WhenWritingNull), and a snapshot contract whose
    // field can be omitted is one the Host's exact-key check rejects — which is exactly how
    // the first live attempt failed. An empty list is a legal value and is still written.
    IReadOnlyList<string> StockItemIds,
    // What the menu CHARGES for each of those ids, one row per published id, in the same order and under the same
    // cap - which is why it is a second list of pairs rather than a number beside `StockItemIds`: a shop sells many
    // items at many prices, and pairing a price list to an id list BY POSITION would be an identity keyed on list
    // position. Same member name, meaning and reader as `BridgeSeedSupplyTarget.Price` (`ItemStockInformation.Price`
    // after the shop's and the entry's own modifiers), so there is one price spelling on the wire.
    //
    // Why it is published at all: measured round87b (2026-11-21), `shop_purchase({expectedQualifiedItemId: "(O)378",
    // quantity: 15})` was sent at 75g a unit with 35g in hand and refused `insufficient_money` by the GAME - the wallet
    // and the unit price were on neither side of the wire, so no compiler could have refused it first.
    IReadOnlyList<BridgeShopStockPrice> StockPrices,
    // The trading window this shop's OWN owner entry declares, in the engine's own 24h minutes - the `TIME` game-state
    // query `ShopBuilder.GetCurrentOwners` evaluates (ShopBuilder.cs:209-212), read out of `Data/Shops` rather than
    // written per shop id. Same two members and same meaning as `BridgeDoor`'s, so the wire has one window spelling.
    //
    // Why it is published: measured round96, a companion walked to a shop before it opened and learned the hour only
    // from the refusal. `StockCount` says what would be sold and this says when. ABSENT + no `HoursUnknown` means the
    // entry declares no window at all (a counter open all day is a fact, not an absence); `HoursUnknown` means an entry
    // DOES declare a window and this reader could not state it as one interval - never a guessed hour.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? OpensAt = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? ClosesAt = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? HoursUnknown = null);

/// <summary>
/// One <c>(item id, price)</c> pair of a counter's stock: the id exactly as <c>StockItemIds</c> publishes it and the
/// number the menu charges for ONE unit of it.
///
/// <para>
/// The pair is a row rather than two parallel lists because the id is the identity and the price is its fact: a reader
/// must never be able to pair them by position. <c>Price</c> is <c>ItemStockInformation.Price</c> verbatim - the number
/// <c>ShopMenu</c> multiplies by the quantity (<c>ShopMenu.cs:1337</c>) - so <c>Price * Quantity</c> is the arithmetic the
/// game itself performs, and a consumer that compares it with the wallet is comparing what the game would charge.
/// </para>
/// </summary>
public sealed record BridgeShopStockPrice(string QualifiedItemId, int Price);

/// <summary>
/// One (seed the actor holds) x (shop whose stock sells it) pair: the SUPPLY half of "can this day's patch be sown",
/// as the game itself states it.
///
/// <para>
/// Why this is published at all. Measured 2026-11-09: a day whose task was a three-wide strip twenty long, two seed
/// stacks in the pack, four tiles planted, then "种子就这些了，想铺满二十格还得再买种" - and asked afterwards, the
/// companion had never considered buying seed. The shortage was discoverable and the supply was not: `shopTargets`
/// publishes only shops whose owner stands in the CURRENT location (empty on the farm at 06:00), and nothing published
/// a price or an opening hour. This family is that fact, so the shortage and its source arrive together.
/// </para>
/// <para>
/// <c>Price</c> is what the menu would actually charge (<c>ShopBuilder.GetShopStock</c>'s
/// <c>ItemStockInformation.Price</c>, which applies the shop's and the entry's modifiers), and <c>DeclaredPrice</c> is
/// the <c>Data/Shops</c> row's own declared number when that row names this item literally. Both are published rather
/// than one being chosen: two numbers that agree today are a disagreement scheduled for later, and the reader can see
/// which one the game will charge.
/// </para>
/// <para>
/// <c>HoursCondition</c> is the owner entry's own game-state query, verbatim (vanilla writes the trading window that
/// way - `!TIME 900 2100`), and <c>OpenNow</c> is <c>ShopBuilder.GetCurrentOwners</c>' answer to that same query at
/// this moment. "Closed" without the condition would be a state the companion cannot learn from. When the condition
/// cannot be evaluated at all, <c>OpenNow</c> is null with <c>OpenNowReason</c> naming why - never false.
/// </para>
/// <para>
/// <c>HeldCount</c> is summed from the published <c>inventoryItemFacts</c> rows for the slots that hold this seed, so
/// it is the same reader that already knows stacks rather than a second counter. It is null - not 0 - when those rows
/// were not published or do not cover the holding slots: an absence read as a zero is the defect this field must not
/// repeat.
/// </para>
/// <para>
/// A row exists for EVERY plantable seed the actor holds, and the shop half is present only when a shop stocks it: a
/// seed nobody sells is a row with the seed and no <c>ShopId</c>, which is a different answer from no row at all (no
/// seed held) and from no family at all (nothing was measured). The three are the difference between "walking to town
/// is worth it" and "it is not".
/// </para>
/// <para>
/// <c>ShopDestination</c>, <c>ShopLocation</c> and <c>ShopLocationUnknown</c> are the ADDRESS half, and EXACTLY ONE of
/// them is written on every row. Measured 2026-11-09 (round40, 35 minutes): <c>plant_seed</c> landed two tiles because
/// the world gave her two seeds, `shop_purchase` was never called, and the shortage fact DID reach her - it named
/// <c>shopId=SeedShop</c>, the owner, the price and the trading window - but never where that shop is, so "go and buy"
/// had no first step to make. <c>ShopId</c> is the shop's identity in <c>Data/Shops</c>, not a position in the world.
/// </para>
/// <para>
/// <c>ShopDestination</c> is published when the shop's counter is in the location the actor is STANDING IN, and it is
/// the `shopTargets` row itself - the same id, tile and location <c>shop_purchase</c> takes as <c>targetId</c> -
/// selected out of the list that one discovery returned, so the two families cannot disagree. <c>ShopLocation</c> names
/// the room the counter is in when it is somewhere else: enough to head for, and deliberately NOT a destination, so a
/// reader never mistakes it for a waypoint within reach. <c>ShopLocationUnknown</c> names why neither could be read
/// (<c>shop_location_unreadable</c>, <c>no_shop_stocks_this_seed</c>). A price and an open-now answer with none of the
/// three would read as a shop she can walk to, which is the defect this half removes.
/// </para>
/// </summary>
public sealed record BridgeSeedSupplyTarget(
    string QualifiedItemId,
    string DisplayName,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? HeldCount,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ShopId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ShopDisplayName,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? OwnerName,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? HoursCondition,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Price,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? DeclaredPrice,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Currency,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? OpenNow,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? OpenNowReason,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BridgeSeedSupplyDestination? ShopDestination = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ShopLocation = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ShopLocationUnknown = null);

/// <summary>
/// Where a shop's counter IS, in terms a walk can start from: the location, the exact target id <c>shop_purchase</c>
/// accepts there, the tile that target stands on, and the name to show while walking.
///
/// <para>
/// Every member is taken from a row the Mod ALREADY publishes - a <c>shopTargets</c> row, selected out of the list
/// <c>DiscoverShopTargets</c> returned for this location - and never re-derived: a second copy of the identity would
/// agree with itself today and disagree with the purchase tomorrow, which is why the selection reads the published
/// row's own <c>TargetId</c> rather than minting one.
/// </para>
/// <para>
/// <c>Tile</c> is the published row's own owner tile, which is where the actor has to stand: one tile from it, the
/// engine's own interaction radius. It is carried here as well as on the shop row so that a reader holding only this
/// destination can still plan the walk - the tile is not a second measurement, it is the same number.
/// </para>
/// </summary>
public sealed record BridgeSeedSupplyDestination(
    string Location,
    string TargetId,
    BridgeTile Tile,
    string Label);

public sealed record BridgeExecutionRequest(
    string RequestId,
    string IdempotencyKey,
    string Action,
    BridgeExecutionArgs Args,
    long ExpectedRevision,
    long DeadlineMs
);

public sealed record BridgeExecutionReceiptQuery(string RequestId, string IdempotencyKey);

/// <summary>A read-only scene observation request. Radius defaults to 15 when omitted on the wire.</summary>
public sealed record ObserveSceneRequestPayload(int Radius = 15)
{
    public const int DefaultRadius = 15;
}

/// <summary>Short-lived exact target binding produced by a scene observation.</summary>
public sealed record ObservationBindingV1(string ObservationId, string Ref);

public sealed record ObserveSceneAffordancePayload(
    string Ref,
    string Kind,
    string Name,
    int Distance,
    string Direction,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ActionHint = null,
    // Whether the actor can act on this affordance from where it stands (walk onto the tile or stand beside it).
    //
    // OMITTED when undecided: the projection cannot measure it (no probe) or the probe exceeded its budget, and
    // writing an explicit `null` cost 17 bytes per affordance for no information -- measured, it pushed the golden
    // payload from 571 to 622 bytes and the worst-case fill past the headroom byte ceiling keeps.
    // The readers (Core `BridgeProtocol` and the Host validator) define ABSENT as undecided, which is why `null`
    // and "absent" must never mean `false`.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Reachable = null,
    /// <summary>
    /// The opaque entity identity this ref binds to, for the affordance kinds whose action needs it.
    ///
    /// <para>
    /// WITHOUT THIS, `pickup_forage` COULD NOT BE CALLED AT ALL even after the binding became visible. Its
    /// `sceneTarget` resolves to an `SceneAffordanceBinding` whose `OpaqueEntityIdentity` must equal the target's
    /// `QualifiedItemId` (`farmhandexecutioncontroller.gatheringactions.cs:64`), and the model has to send that same id as
    /// `expectedQualifiedItemId` (`:65`). The affordance published `ref` and a human `Name`, so the model held a ref and
    /// could not say which item it bound to - the id existed on both sides and never met.
    /// </para>
    /// <para>
    /// Omitted when the source has none, and bounded to the same 128 characters the binding validates, so the payload
    /// cost is one short id per affordance of a kind that has one.
    /// </para>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Identity = null
);

public sealed record ObserveSceneResultPayload(
    string ObservationId,
    string CurrentLocation,
    string CurrentRegion,
    IReadOnlyList<ObserveSceneAffordancePayload> Affordances,
    string Summary,
    bool Partial,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? TruncatedReason,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] ObserveSceneGroundPayload? Ground = null
);

/// <summary>
/// Ground summary for one observation, read from the map's Back-layer `Type`
/// property (the same signal the engine uses for footstep sounds and pathfinding
/// weights). Reported as a dominant kind plus the tiles that differ, so a
/// uniform meadow costs one entry instead of fifty.
/// </summary>
public sealed record ObserveSceneGroundPayload(
    string DominantKind,
    int DominantTileCount,
    int ScannedTileCount,
    IReadOnlyList<ObserveSceneGroundTilePayload> Exceptions,
    int OmittedExceptionTileCount);

public sealed record ObserveSceneGroundTilePayload(int TileX, int TileY, string Kind);

/// <summary>A read-only Navigation request for map inspection or destination search.</summary>
public sealed record BridgeNavigationReadRequest(string Operation, BridgeNavigationReadArgs Args);

public sealed class BridgeNavigationReadArgs
{
    public string? NodeRef { get; init; }
    public string? Cursor { get; init; }
    public string? Query { get; init; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalProperties { get; init; }
}

public sealed record BridgeNavigationDestinationSelector(
    string Kind,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Ref
);

public sealed record BridgeDestinationSearchCandidate(
    string Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ContextLabel,
    BridgeNavigationDestinationSelector Destination,
    string UnlockState
);

public sealed record BridgeWorldMapEntry(
    string Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ContextLabel,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? NodeRef,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeNavigationDestinationSelector? Destination
);

/// <summary>
/// One correlated read-only result. It is intentionally distinct from an
/// execution receipt and contains neither execution identity nor evidence.
/// </summary>
/// <summary>Body Program bridge candidate. Binding uses the external wire key <c>nodeId</c>; the adapter maps it to Core ProducerNodeId.</summary>
public sealed record BridgeBodyProgramCandidate(
    string ProgramId,
    IReadOnlyList<BridgeBodyProgramCandidateNode> Nodes
);

public sealed record BridgeBodyProgramCandidateNode(
    string NodeId,
    string ActionId,
    IReadOnlyDictionary<string, BodyProgramRuntimeValue> Arguments,
    IReadOnlyList<string> DependsOn,
    IReadOnlyDictionary<string, BridgeBodyProgramBinding> Bindings
);

public sealed record BridgeBodyProgramBinding(string NodeId, string FactName);

public sealed record BridgeBodyProgramDiagnostic(
    string Severity,
    string Code,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? NodeId,
    string Path,
    string Message
);

public sealed record BridgeBodyProgramSubmitVerification(
    bool Accepted,
    long CatalogRevision,
    IReadOnlyList<BridgeBodyProgramDiagnostic> Diagnostics
);

public sealed record BridgeBodyProgramNodeStatus(
string NodeId,
string State,
int NodeAttempt,
int AdmissionAttempt,
/// <summary>
/// Why this node holds its current state, when the authority recorded a reason.
///
/// <para>
/// Measured 2026-10-26: the companion's programs all ended `rejected` or `recovery_required` and the Host's admission
/// refused the challenge; the code was written onto the node itself (`RejectionCode`) but this projection dropped it, so
/// the model saw a bare state with no cause and retried the same shape four times. Omitted when null so an unrejected
/// node keeps the wire shape it had.
/// </para>
string? RejectionCode = null,
/// <summary>
/// Why a dispatched node settled without succeeding - the action-owned receipt's own reason code (`door_out_of_range`,
/// `player_not_actionable`, `stamina_depleted`). Present only on `failed`/`cancelled` nodes, omitted when null.
///
/// <para>
/// The same defect as <see cref="RejectionCode"/>, one state over: `RouteReenteringBodyProgramExecutor` had the reason in
/// hand and discarded it, so every native refusal reached the model as a bare `Failed` and the only thing it could do was
/// send the same node again. This is a cause, never proof of an effect: `failed`/`cancelled` still carry no receipt,
/// evidence, postcondition or facts (ADR-006 `:163`, `:175`).
/// </para>
string? FailureCode = null,
/// <summary>
/// Where the caller can go instead, when the reason is that the target has no route.
///
/// <para>
/// A hint, not evidence: it claims nothing happened, names no receipt and proves no effect, so the ban above does not
/// reach it - the same footing as <see cref="FailureCode"/>. Measured 2026-11-01 (`round21`): the companion re-aimed
/// at nine `move_to_tile` destinations in Mountain because every refusal reached it as a bare
/// `{"failureCode":"no_native_path"}`; the one fact that would have ended the loop, the closest reachable tile, was
/// computed and dropped. Bounded and omitted when null, so the wire shape only grows for a node that has one.
/// </para>
string? Hint = null,
/// <summary>
/// WHY a node settled without succeeding, in the refusing layer's OWN words - the part of the receipt's evidence a caller
/// could act on, carried as a reason detail rather than as proof of an effect.
///
/// <para>
/// Measured 2026-11-01 (`round41`): `shop_purchase` answered `shop_counter_out_of_reach` six times while the Mod's receipt
/// held `owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1`; the model got
/// `{"reasonCode":"shop_counter_out_of_reach","actionId":"shop_purchase"}`, invented the world fact and retried. Every
/// one of that round's 94 `program_status` replies carried no evidence and no detail at all.
/// </para>
/// <para>
/// Legal only on `failed`/`cancelled`/`rejected` and NEVER on `succeeded`, which is the shape ADR-006 already gives
/// `FailureCode`: it names an absence of effect, and the states that prove an effect may not also describe its absence.
/// Omitted when null, so a node without one keeps the wire shape it had.
/// </para>
string? RefusalDetail = null,
/// <summary>
/// The journal's own `RecoveryDiagnostic` for a node whose outcome cannot be determined (`execution_uncertain`,
/// `recovery_required`).
///
/// <para>
/// The journal held it and the wire did not publish it, so `recovery_required` reached a caller as a state with no reason
/// at all - and a Host that then had to say "no reason" would be saying something it already knew to be false. Legal only
/// on `recovery_required`; omitted when null.
/// </para>
string? RecoveryDiagnostic = null,
/// <summary>
/// The action this node runs, from the journal's own <see cref="VerifiedBodyProgramNode.ActionId"/>.
///
/// <para>
/// The wire dropped it, so a reader could see that node 3 of a program `failed` but never what node 3 WAS - and the only
/// program identity the model was ever handed was a `programId` in an unprotected tool result. Carried verbatim; the Mod
/// never renames an action id on the way out.
/// </para>
/// </summary>
string? ActionId = null,
/// <summary>
/// The tile this node addressed, read from the canonical arguments the Mod bound at admission, or null when they name no
/// tile. Travels with <see cref="Y"/> or not at all: one half of a coordinate is not a coordinate.
/// </summary>
int? X = null,
/// <summary>The tile's y, beside <see cref="X"/>.</summary>
int? Y = null,
/// <summary>
/// The pass's own ROW TABLE - the journal's `BodyProgramJournalNode.Evidence`, verbatim.
///
/// <para>
/// A `for_each` node settles sixty tiles as ONE node, and this is the sixty rows: `{"state":"succeeded","succeeded":0,
/// …, "rows":[{"x":67,"y":19,"action":"till_soil","state":"refused","reasonCode":…,"detail":…}]}`, built by
/// <see cref="Core.BodyPrograms.RouteReenteringBodyProgramExecutor"/>'s own aggregate. The journal has always stored it; this
/// projection dropped it, so a pass that tilled fifteen of sixty tiles reached every reader as `succeeded` with no tile
/// named - measured `round63`, `plan_239_2793c52c60b8cadf` node `n02`, whose own run bundle kept `{"nodeId":"n02",
/// "actionId":"for_each","state":"succeeded"}` and not one row.
/// </para>
/// <para>
/// Legal only where the node PROVED an effect (`succeeded`/`partially_succeeded`, the same `provesEffect`
/// <see cref="Core.BodyPrograms.OpenBodyProgramJournalAuthority"/> decides with), and bounded by
/// <see cref="Core.BodyPrograms.BodyProgramValidation.IsOpaqueTerminalProof"/> - which is the aggregate's own ceiling, so a
/// table that arrives whole is printed whole and one that does not says so itself (`rowsOmitted`). Omitted when null.
/// </para>
string? Evidence = null,
/// <summary>
/// The pass's own verdict line - the journal's `BodyProgramJournalNode.PostconditionVerification`, verbatim:
/// `for_each_pass:decided=60:succeeded=45:left_alone=0:omitted=0`, or the `partially_succeeded` spelling with
/// `failed`/`refused` beside them.
///
/// <para>
/// The one field that says HOW MANY of the rows in <see cref="Evidence"/> did the thing, and the only place a
/// `partially_succeeded` batch says so on its own row. Same state rule and same bound as <see cref="Evidence"/>; omitted
/// when null.
/// </para>
string? PostconditionVerification = null,
/// <summary>
/// The family this node's work consumed, typed - the journal's `BodyProgramJournalNode.Chore`, verbatim.
///
/// <para>
/// A settlement can name what is LEFT of the chore it just finished only if a reader can tell WHICH family it worked,
/// and the only other place that fact existed was inside the `evidence` string the Host scanned with `indexOf`. Unlike
/// <see cref="Evidence"/> this is ONE family name and not a document: it is the same value the node's own
/// `postconditionVerification` clause was minted from, so the two can never name different families. Same state rule
/// and same legality as <see cref="Evidence"/> (a node that proved no effect may not name a chore it did not finish),
/// and bounded by the journal's own identifier grammar. Omitted when null.
/// </para>
string? Chore = null
);

public sealed record BridgeBodyProgramStatusSnapshot(
    string ProgramId,
    string State,
    long CatalogRevision,
    long StopEpoch,
    long EventHighWater,
    IReadOnlyList<BridgeBodyProgramNodeStatus> Nodes
);

public sealed record BridgeBodyProgramSubmitResult(
    string Code,
    BridgeBodyProgramSubmitVerification Verification,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeBodyProgramStatusSnapshot? Snapshot
);

public sealed record BridgeBodyProgramStatusResult(
    string Code,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeBodyProgramStatusSnapshot? Snapshot,
    /// <summary>
    /// The journal's newest programs, newest first, when the query named no id. Null on an addressed query, so the two
    /// paths are distinguishable rather than one being an empty list.
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyList<BridgeBodyProgramStatusSnapshot>? Programs = null,
    /// <summary>The journal's total program count, so a bounded page reads as "8 of 143" rather than as a short history.</summary>
    int ProgramCount = 0
);

/// <summary>
/// One addressed event. Page continuation belongs to the surrounding result, not an event.
///
/// <para>
/// <c>AtMs</c> is the journal's own monotonic stamp for the moment it appended this event - the dispatch moment on
/// <c>native_dispatch</c>, the settlement moment on <c>node_completed</c>/<c>node_settled</c> - carried verbatim so a
/// reader never has to substitute the moment it received the frame for the moment the game acted.
/// </para>
/// </summary>
public sealed record BridgeBodyProgramEvent(
    long Cursor,
    string ProgramId,
    string Kind,
    long CatalogRevision,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? NodeId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? NodeAttempt,
    long AtMs
);

public sealed record BridgeBodyProgramEventsResult(
    string ProgramId,
    string Code,
    IReadOnlyList<BridgeBodyProgramEvent> Events,
    long NextCursor,
    long HighWater
);

/// <summary>
/// Inbound Body Program status query: one program by id, or - with no `programId` at all - the journal's newest programs.
///
/// <para>
/// An absent id is a request for the SAME journal, not for a different source: it is the only question a caller can still
/// ask after a context fold has removed the `programId` it was once handed.
/// </para>
/// </summary>
public sealed record BridgeBodyProgramStatusRequest(string? ProgramId);

/// <summary>
/// Inbound Body Program stop request: which program, and the STOP epoch that fences it.
///
/// <para>
/// The epoch is the caller's own monotonic fence, not a timestamp. The authority refuses a stop whose epoch is not
/// strictly greater than the one already recorded for that program, so a replayed or reordered stop cannot cancel a
/// program that a LATER intent has already taken over. It travels on the wire because the Mod must enforce it against
/// its own journal rather than trust the caller's ordering.
/// </para>
/// </summary>
public sealed record BridgeBodyProgramStopRequest(string ProgramId, long StopEpoch);

public sealed record BridgeBodyProgramStopResult(
    string Code,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeBodyProgramStatusSnapshot? Snapshot
);

/// <summary>Inbound Body Program events page query. Cursor must be non-negative; page size is bounded 1..32.</summary>
public sealed record BridgeBodyProgramEventsRequest(string ProgramId, long Cursor, int PageSize);

public sealed record BridgeNavigationReadResult(
    string Status,
    string Reason,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyList<BridgeWorldMapEntry>? Entries,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? NextCursor,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyList<BridgeDestinationSearchCandidate>? Candidates = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeNavigationDestinationSelector? Destination = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? UnlockState = null
);

/// <summary>
/// One destination's published names: every spelling this generation's directory DECLARES for one place, and the opaque
/// handle that names the place itself.
///
/// <para>
/// The fields are split by WHERE A NAME CAME FROM - the place's own label in this locale and in the fallback locale, the
/// other spellings its row declares, the residents that live there, the goods its shop sells - because the Mod is the only
/// side that can read `Data/Locations`, the world-map areas, `Data/Characters` and `Data/Shops`. How much each of them
/// counts towards a match is a ranking decision, and ranking is the Host's business (ADR-0014: the Mod does not interpret,
/// sort or compose), so no weight travels on this wire.
/// </para>
/// <para>
/// `Ref` is the place's `dr1_` handle, minted once per destination IDENTITY for this publication and bound to the same
/// runtime, scope and source generation as every other Navigation handle. Two rows may share one handle: the farm's water
/// landmark declares the farm's identity on purpose so arrival semantics keep working, and a handle names the identity,
/// not a spelling.
/// </para>
/// </summary>
public sealed record BridgeDestinationIndexRow(
    string Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ContextLabel,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? FallbackLabel,
    IReadOnlyList<string> Aliases,
    IReadOnlyList<string> RelatedNpcs,
    IReadOnlyList<string> ServiceTerms,
    string Ref
);

/// <summary>Inbound destination-index publication request. It carries no arguments: the directory is the world's.</summary>
public sealed record BridgeDestinationIndexRequest;

/// <summary>
/// One generation's flat destination-name directory, or the Mod's named refusal to publish one.
///
/// <para>
/// `Blocked` carries no half list on purpose: a directory the Mod could not publish completely would make the Host answer
/// "no such place" for the places it dropped, which is a false statement rather than an incomplete one.
/// </para>
/// </summary>
public sealed record BridgeDestinationIndexResult(
    string Status,
    string Reason,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Generation,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyList<BridgeDestinationIndexRow>? Destinations
);

/// <summary>Inbound content-table query: one engine content table, and optionally one row of it.</summary>
///
/// <para>
/// The engine's own tables (`Data/FarmAnimals`, `Data/Shops`, `Data/Machines`, ...) are what the game's rules are made
/// of, and until this request there was no way to ask them: a companion could see that a coop stood on the farm and
/// could not answer "how many days until this hen lays", because the answer lives in a table no snapshot family
/// publishes. `Table` is the engine's table name, never a path we ship; an absent `Key` asks for the row ids.
/// </para>
/// </summary>
public sealed record BridgeDataQueryRequest(string Table, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Key);

/// <summary>
/// One row of an engine content table, projected to the fields that decide an action.
///
/// <para>
/// `Fields` holds scalars and string arrays only: a projection that carried the whole row would be an observe with a
/// different name, and the fields it drops are the presentation ones (textures, sprite indexes, sounds) no action
/// chooses a target from. Values keep their engine type - an int stays a number - so a caller can compare it.
/// </para>
/// </summary>
public sealed record BridgeDataQueryRow(string Id, IReadOnlyDictionary<string, object?> Fields);

/// <summary>
/// The answer to one content-table query.
///
/// <para>
/// `Status` is the closed vocabulary the Host turns into a named outcome: `index` (the row ids), `row` (one projected
/// row), `absent_row` (the table exists and has no such row), `unknown_table` (the engine has no such table) and
/// `not_projectable` (the table exists and its rows are too large to answer with, named by `Detail`). `Population` is
/// how many rows the table has, so "the table is empty" and "the table has no such row" can never be the same answer;
/// it is -1 exactly when no table was found to count.
/// </para>
/// </summary>
public sealed record BridgeDataQueryResult(
    string Status,
    string Table,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int Population,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyList<string>? Ids,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeDataQueryRow? Row,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Detail);
