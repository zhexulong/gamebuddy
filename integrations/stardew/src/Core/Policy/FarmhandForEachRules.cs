namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// One scalar a live world row can be tested on.
///
/// A row is what the `for_each` plan form loops over: a rectangle's tile, a published target family's entry, or a query
/// result. Their fields disagree about type - `health` is a number, `readyForHarvest` a flag, `kind` a word - so the
/// predicate has to compare typed values rather than strings, and this is that type.
/// </summary>
public sealed record FarmhandForEachValue(string? Text = null, double? Number = null, bool? Flag = null)
{
    public static FarmhandForEachValue Of(string text) => new(Text: text);

    public static FarmhandForEachValue Of(double number) => new(Number: number);

    public static FarmhandForEachValue Of(bool flag) => new(Flag: flag);
}

/// <summary>
/// The two operators a repeating position guard offers: `every: n, offset: k` claims local index k, k+n, k+2n...
///
/// This is the operator the whole form exists for. Trellis crops (green bean, hops, grape) grow into impassable tiles, so
/// a real farm leaves a walkable column between trellis columns and plants a filler crop between trellis rows - hops
/// with coffee is a standard summer layout. Every one of those decisions depends on POSITION, not on what the tile
/// currently contains, so a dispatch keyed on the row's kind cannot represent them.
/// </summary>
public sealed record FarmhandForEachStride(int Every, int Offset)
{
    public const string EveryOperator = "every";

    public const string OffsetOperator = "offset";

    /// <summary>The two keys a stride is written with, in the order a refusal names them.</summary>
    public static readonly string[] Operators = { EveryOperator, OffsetOperator };

    /// <summary>
    /// An offset at or past the stride claims no index at all, and a rule that can never match is indistinguishable from
    /// a tile nobody thought about - so it is refused rather than silently dead.
    /// </summary>
    public bool IsValid => this.Every >= 1 && this.Offset >= 0 && this.Offset < this.Every;

    public bool Claims(int localIndex) => localIndex >= 0 && localIndex % this.Every == this.Offset;
}

public enum FarmhandForEachComparison
{
    Eq = 1,
    Ne = 2,
    Lt = 3,
    Lte = 4,
    Gt = 5,
    Gte = 6,
    In = 7,
}

/// <summary>
/// One `where` predicate over a row: `{ field: "health", gt: 0 }`, `{ field: "kind", in: ["rock","stump"] }`,
/// `{ occupant: "weed" }`, or a position guard `{ col: { every: 3, offset: 1 } }`.
///
/// ONE SPELLING PER TEST, declared in <see cref="Selectors"/> and <see cref="Comparisons"/> and nowhere else: the reader
/// accepts what those declare and its refusal prints them, so "a word this form does not have" is answered with the words
/// it does have instead of with the caller's own word back.
///
/// `occupant` IS NOT A SECOND VOCABULARY. It is the ONE field test on <see cref="FarmhandForEachHealing.OccupantField"/> -
/// the field the clearing join reads, whose words are the engine's own (`ExecutionManager.DescribeTileOccupant`) and the
/// same words `FarmhandActionDescriptor.Clears` is declared in - so `{ occupant: "weed" }` and
/// `{ field: "occupant", eq: "weed" }` are one test with one meaning.
/// </summary>
public sealed record FarmhandForEachPredicate(
    string? Field,
    FarmhandForEachComparison Comparison,
    IReadOnlyList<FarmhandForEachValue> Values)
{
    public const string FieldOperator = "field";

    public const string ColOperator = "col";

    public const string RowOperator = "row";

    /// <summary>The named test of what STANDS on the tile, in the words the clearing join is written in.</summary>
    public const string OccupantOperator = "occupant";

    // The wire words of the field comparisons this pass accepts. They belong here, beside the type they name, so the
    // reader that accepts a declaration and the model that decides a row cannot disagree about how one is spelled.
    public const string EqOperator = "eq";

    public const string NeOperator = "ne";

    public const string LtOperator = "lt";

    public const string LteOperator = "lte";

    public const string GtOperator = "gt";

    public const string GteOperator = "gte";

    /// <summary>The one comparison that takes a LIST of values: `kind in ["rock","stump"]`.</summary>
    public const string InOperator = "in";

    /// <summary>The keys that say WHAT one predicate tests, in the order a refusal names them.</summary>
    public static readonly string[] Selectors = { FieldOperator, ColOperator, RowOperator, OccupantOperator };

    /// <summary>
    /// Every comparison word, with the comparison it spells: the ONE declaration the reader accepts a field test against
    /// and the one a refusal prints. A word added here is a word the reader must read, and the test beside this file
    /// asserts that for every member rather than for the three that were written by hand.
    /// </summary>
    public static readonly (string Word, FarmhandForEachComparison Kind)[] Comparisons =
    {
        (EqOperator, FarmhandForEachComparison.Eq),
        (NeOperator, FarmhandForEachComparison.Ne),
        (LtOperator, FarmhandForEachComparison.Lt),
        (LteOperator, FarmhandForEachComparison.Lte),
        (GtOperator, FarmhandForEachComparison.Gt),
        (GteOperator, FarmhandForEachComparison.Gte),
        (InOperator, FarmhandForEachComparison.In),
    };

    /// <summary>
    /// How many values one `in` list may carry.
    ///
    /// The bound lives here rather than in the reader because it is a fact about the PREDICATE: a conjunction of eight
    /// predicates over lists of eight values is a rule a person can still read. Mirrors `MAX_FOR_EACH_VALUES`
    /// (`host/src/body-program-for-each.ts:144`), which is the compiler's half of the same bound.
    /// </summary>
    public const int MaximumValues = 8;

    /// <summary>The axis a position predicate claims (`col` / `row`), or null for a field predicate.</summary>
    public string? Axis { get; init; }

    /// <summary>The repeating guard a position predicate carries, or null when it is a field predicate.</summary>
    public FarmhandForEachStride? Stride { get; init; }

    /// <summary>A predicate with no field is a position guard, carried by <see cref="Stride"/> instead.</summary>
    public bool IsPositionGuard => this.Axis is not null;

    public bool IsValid => this.Field is null
        ? this.Axis is ColOperator or RowOperator && this.Stride is not null && this.Stride.IsValid
        : this.Field.Length is >= 1 and <= 64 && this.Values.Count is >= 1 and <= MaximumValues;
}

/// <summary>
/// Where a `for_each` loop reads its rows from.
///
/// Three sources, ONE loop semantic. An area is a rectangle of live map tiles, a family is one of the snapshot arrays the
/// Mod already publishes, and a query is a subject the Mod classifies for itself. The area is a SOURCE and not a
/// privileged form: "every dry crop on the farm" is a family source, "every tree with health left" is a family source
/// with a field predicate, and neither of them is a rectangle.
/// </summary>
public sealed record FarmhandForEachSource(
    string Kind,
    int X = 0,
    int Y = 0,
    int Width = 0,
    int Height = 0,
    string? Family = null,
    string? Subject = null,
    string? Only = null)
{
    public const string AreaKind = "area";

    public const string FamilyKind = "family";

    public const string QueryKind = "query";

    /// <summary>
    /// How many rows one loop may address.
    ///
    /// A per-INTENT budget, not a view radius: the point of the form is that a 3x20 row is bigger than the 13x13 an
    /// observation carries. Over the bound the answer says `omitted: n` with the rectangle it covered - never a
    /// truncated table that looks complete, because a truncated table reads as a finished pass.
    /// </summary>
    public const int MaximumRows = 64;

    public int AreaRowCount => this.Width > 0 && this.Height > 0 ? checked(this.Width * this.Height) : 0;

    public bool IsValid => this.Kind switch
    {
        AreaKind => this.X >= 0 && this.Y >= 0 && this.Width >= 1 && this.Height >= 1
            && this.AreaRowCount is >= 1 and <= MaximumRows,
        FamilyKind => this.Family is { Length: >= 1 and <= 64 },
        QueryKind => this.Subject is { Length: >= 1 and <= 64 },
        _ => false,
    };
}

/// <summary>One step of a row's chain: a published action with its own arguments.</summary>
public sealed record FarmhandForEachStep(string Action, IReadOnlyDictionary<string, string>? Arguments = null)
{
    /// <summary>How long an action id may be, which is the longest published action id by a wide margin.</summary>
    public const int MaximumActionLength = 128;

    /// <summary>
    /// How many arguments one step may name.
    ///
    /// A fact about the STEP, not about the reader: it is the same bound the compiler writes it against
    /// (`MAX_FOR_EACH_EFFECT_ARGUMENTS`, `host/src/body-program-for-each.ts:166`).
    /// </summary>
    public const int MaximumArguments = 16;

    /// <summary>
    /// The token that means "whatever action the Mod's own classifier names for this row's kind".
    ///
    /// It is a REFERENCE, not a mapping the caller supplies: the classifier that names a kind is the only thing that can
    /// say which action clears it, so the table lives beside the classifier and the caller may not restate it.
    /// </summary>
    public const string ByKindAction = "by_kind";

    public bool IsValid => this.Action.Length is >= 1 and <= MaximumActionLength
        && (this.Arguments is null || this.Arguments.Count <= MaximumArguments);
}

/// <summary>
/// What a matching row gets: an ORDERED CHAIN of steps worked on one tile in one pass, or null for "leave this row alone".
///
/// <para>
/// WHY A CHAIN. Farm work is a chain per tile - clear, till, water, sow - and a form that could name only ONE action per
/// row needed one pass per action: four passes of waking, ordering and receipts over the same sixty tiles, each pass
/// reporting the tiles the previous one had just prepared by the action the next one wanted. One row is one tile's work,
/// in the order the caller wrote it, and at most <see cref="MaximumSteps"/> steps of it.
/// </para>
/// <para>
/// THE SINGLE FORM IS THE CHAIN OF LENGTH ONE. `do: { action, ... }` and `do: [{ action, ... }]` are the same value here,
/// so the decision has one shape to answer and a row's receipt has one shape to report.
/// </para>
/// </summary>
public sealed record FarmhandForEachEffect(params FarmhandForEachStep[] Steps)
{
    /// <summary>
    /// How many steps one row may chain: long enough to be the clear-till-water-sow chain a farm tile really needs, short
    /// enough that a row is still one tile's work and not a plan.
    /// </summary>
    public const int MaximumSteps = 4;

    public bool IsValid => this.Steps is { Length: >= 1 and <= MaximumSteps }
        && this.Steps.All(step => step is not null && step.IsValid);
}

/// <summary>
/// One more rule of the same pass: an optional conjunction of predicates and what a matching row gets.
///
/// WHY A PASS HAS MORE THAN ONE RULE. A 3x20 intercropped patch is ONE intent and not three: hops on columns 0, 3, 6...,
/// coffee on 1, 4, 7..., and column 2, 5, 8... deliberately a path. Three separate passes would report every tile a pass
/// did not claim as `no_rule_matched` twice over, and a tile two rules claim would be worked twice; one pass with ordered
/// rules decides each row exactly once, by the FIRST rule that claims it.
/// </summary>
public sealed record FarmhandForEachRule(
    IReadOnlyList<FarmhandForEachPredicate>? Where,
    FarmhandForEachEffect? Do)
{
    /// <summary>
    /// How many predicates one rule's conjunction may carry: long enough to be a rule, short enough to be read.
    ///
    /// Mirrors `MAX_FOR_EACH_PREDICATES` (`host/src/body-program-for-each.ts:116`).
    /// </summary>
    public const int MaximumPredicates = 8;

    public bool IsValid =>
        (this.Where is null || (this.Where.Count <= MaximumPredicates
            && this.Where.All(predicate => predicate is not null && predicate.IsValid)))
        && (this.Do is null || this.Do.IsValid);
}

/// <summary>
/// One loop intent: a source, an optional conjunction of predicates, what to do with a matching row, and the further
/// rules of the same pass.
///
/// `Do: null` is a STATEMENT - "this column is a path" - and the pass counts it separately so a reader can tell a
/// deliberate path from a tile the predicates forgot.
/// </summary>
public sealed record FarmhandForEachLoop(
    FarmhandForEachSource Source,
    IReadOnlyList<FarmhandForEachPredicate>? Where,
    FarmhandForEachEffect? Do,
    IReadOnlyList<FarmhandForEachRule>? Then = null)
{
    /// <summary>How many rules one pass may carry, this loop's own included.</summary>
    public const int MaximumRules = 8;

    /// <summary>
    /// The ordered rules of one pass: this loop's own predicate and effect first, then <see cref="Then"/> in order.
    ///
    /// FIRST MATCH WINS, and this is the ONE spelling of "what a pass tries": the compiler that composes several
    /// `for_each` calls over one source and the expansion that runs them enumerate the rules through it, so the two
    /// cannot disagree about the order or about how many there are.
    /// </summary>
    public IReadOnlyList<FarmhandForEachRule> Rules
    {
        get
        {
            var rules = new List<FarmhandForEachRule>(1 + (this.Then?.Count ?? 0))
            {
                new FarmhandForEachRule(this.Where, this.Do),
            };
            if (this.Then is not null) rules.AddRange(this.Then);
            return rules.AsReadOnly();
        }
    }

    public bool IsValid =>
        this.Source is not null
        && this.Source.IsValid
        && (this.Where is null || this.Where.All(predicate => predicate is not null && predicate.IsValid))
        && (this.Do is null || this.Do.IsValid)
        && (this.Then is null
            || (this.Then.Count + 1 <= MaximumRules && this.Then.All(rule => rule is not null && rule.IsValid)));
}

/// <summary>One row the loop considered, and what it decided.</summary>
public enum FarmhandForEachRowOutcome
{
    /// <summary>The predicates matched and named an effect; the effect was dispatched.</summary>
    Dispatched = 1,

    /// <summary>The predicates matched and said `do: null`: a deliberate path, not a forgotten row.</summary>
    LeftAlone = 2,

    /// <summary>NO predicate matched. Reported, never skipped: a skipped row reads as a cleared patch.</summary>
    NotMatched = 3,
}

public sealed record FarmhandForEachRowDecision(
    int? X,
    int? Y,
    int LocalColumn,
    int LocalRow,
    FarmhandForEachRowOutcome Outcome,
    FarmhandForEachEffect? Effect);

/// <summary>
/// The one authority for "does this live world row belong to this loop, and what happens to it".
///
/// It is pure on purpose: the caller supplies the row as the world reports it NOW, and this answers yes/no. Expansion
/// therefore happens against live state on the game thread, never against the snapshot the plan was written from, and
/// the decision order is testable without a game.
/// </summary>
public static class FarmhandForEachRules
{
    /// <summary>
    /// Whether every predicate holds for this row.
    ///
    /// `Where` absent means every row, which is why an absent predicate list is not an error: the caller may genuinely
    /// mean "every row of this source".
    /// </summary>
    public static bool Matches(
        FarmhandForEachLoop loop,
        IReadOnlyDictionary<string, FarmhandForEachValue> fields,
        int localColumn,
        int localRow)
    {
        ArgumentNullException.ThrowIfNull(loop);
        return MatchesRule(loop.Where, fields, localColumn, localRow);
    }

    /// <summary>
    /// Whether every predicate of ONE rule holds for this row.
    ///
    /// A pass with several rules asks this once per rule and takes the first that answers yes, so the rule grammar and
    /// the loop grammar cannot drift: <see cref="Matches(FarmhandForEachLoop, IReadOnlyDictionary{string, FarmhandForEachValue}, int, int)"/>
    /// is this method with the loop's own predicate list.
    /// </summary>
    public static bool MatchesRule(
        IReadOnlyList<FarmhandForEachPredicate>? where,
        IReadOnlyDictionary<string, FarmhandForEachValue> fields,
        int localColumn,
        int localRow)
    {
        ArgumentNullException.ThrowIfNull(fields);
        // An absent predicate list means every row, which is why it is not an error: the caller may genuinely mean
        // "every row of this source".
        if (where is null) return true;
        foreach (FarmhandForEachPredicate predicate in where)
        {
            if (predicate.IsPositionGuard)
            {
                FarmhandForEachStride stride = predicate.Stride!;
                int localIndex = predicate.Axis == FarmhandForEachPredicate.ColOperator ? localColumn : localRow;
                if (!stride.Claims(localIndex)) return false;
                continue;
            }
            if (!fields.TryGetValue(predicate.Field!, out FarmhandForEachValue? value) || value is null) return false;
            if (!Holds(predicate, value)) return false;
        }
        return true;
    }

    /// <summary>
    /// What a pass decides for one row: the FIRST rule that claims it, and whether any rule did.
    ///
    /// The two are returned together because "no rule claimed this row" is an outcome the caller must report and not an
    /// absence it can skip - a skipped row reads as a cleared patch.
    /// </summary>
    public static (bool Matched, FarmhandForEachEffect? Effect) DecideByRules(
        FarmhandForEachLoop loop,
        IReadOnlyDictionary<string, FarmhandForEachValue> fields,
        int localColumn,
        int localRow)
    {
        ArgumentNullException.ThrowIfNull(loop);
        foreach (FarmhandForEachRule rule in loop.Rules)
            if (MatchesRule(rule.Where, fields, localColumn, localRow)) return (true, rule.Do);
        return (false, null);
    }

    /// <summary>The decision for one row, given the fields the live world reports for it.</summary>
    public static FarmhandForEachRowDecision Decide(
        FarmhandForEachLoop loop,
        int? x,
        int? y,
        int localColumn,
        int localRow,
        IReadOnlyDictionary<string, FarmhandForEachValue> fields)
    {
        ArgumentNullException.ThrowIfNull(loop);
        if (!Matches(loop, fields, localColumn, localRow))
            return new FarmhandForEachRowDecision(x, y, localColumn, localRow, FarmhandForEachRowOutcome.NotMatched, null);
        return loop.Do is null
            ? new FarmhandForEachRowDecision(x, y, localColumn, localRow, FarmhandForEachRowOutcome.LeftAlone, null)
            : new FarmhandForEachRowDecision(x, y, localColumn, localRow, FarmhandForEachRowOutcome.Dispatched, loop.Do);
    }

    /// <summary>The row's position, in the order every answer uses: row by row, then column by column.</summary>
    public static IEnumerable<(int X, int Y, int LocalColumn, int LocalRow)> AreaRows(FarmhandForEachSource source)
    {
        ArgumentNullException.ThrowIfNull(source);
        if (source.Kind != FarmhandForEachSource.AreaKind) yield break;
        for (int localRow = 0; localRow < source.Height; localRow++)
        for (int localColumn = 0; localColumn < source.Width; localColumn++)
            yield return (source.X + localColumn, source.Y + localRow, localColumn, localRow);
    }

    /// <summary>
    /// A row no predicate claimed, in the reason-code form the pass reports.
    ///
    /// `no_rule_matched:&lt;kind&gt;@&lt;x&gt;,&lt;y&gt;` names WHICH row and WHICH kind was forgotten: "three rows unmatched" cannot be
    /// acted on, and the row is what the next rule needs.
    /// </summary>
    public static string NoRuleMatchedReasonCode(string kind, int x, int y) => $"no_rule_matched:{kind}@{x},{y}";

    private static bool Holds(FarmhandForEachPredicate predicate, FarmhandForEachValue value)
    {
        switch (predicate.Comparison)
        {
            case FarmhandForEachComparison.In:
                return predicate.Values.Any(candidate => Equals(candidate, value));
            case FarmhandForEachComparison.Eq:
                return Equals(predicate.Values[0], value);
            case FarmhandForEachComparison.Ne:
                return !Equals(predicate.Values[0], value);
        }
        // The ordered comparisons are about numbers; a text or flag field under `gt` is a caller mistake the loop
        // refuses rather than ordering behind their back.
        if (value.Number is not { } number || predicate.Values[0].Number is not { } bound) return false;
        return predicate.Comparison switch
        {
            FarmhandForEachComparison.Lt => number < bound,
            FarmhandForEachComparison.Lte => number <= bound,
            FarmhandForEachComparison.Gt => number > bound,
            FarmhandForEachComparison.Gte => number >= bound,
            _ => false,
        };
    }
}
