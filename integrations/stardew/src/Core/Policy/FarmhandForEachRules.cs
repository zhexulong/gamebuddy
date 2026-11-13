using System.Globalization;
using GameBuddy.Stardew.Core.BodyPrograms;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// One scalar a live world row can be tested on.
///
/// A row is what the `for_each` plan form loops over: one live map tile inside the loop's rectangle. The fields disagree
/// about type - `health` is a number, `readyForHarvest` a flag, `kind` a word - so the predicate has to compare typed
/// values rather than strings, and this is that type.
/// </summary>
public sealed record FarmhandForEachValue(string? Text = null, double? Number = null, bool? Flag = null)
{
    public static FarmhandForEachValue Of(string text) => new(Text: text);

    public static FarmhandForEachValue Of(double number) => new(Number: number);

    public static FarmhandForEachValue Of(bool flag) => new(Flag: flag);
}

/// <summary>
/// One `where` predicate over a row: `{ occupant: "weed" }` or `{ field: "tillable", in: [true] }`.
///
/// <para>
/// TWO SPELLINGS, declared in <see cref="Selectors"/> and nowhere else: the reader accepts what that declares and its
/// refusal prints it, so "a word this form does not have" is answered with the words it does have instead of with the
/// caller's own word back. The field test has ONE comparison (<see cref="Comparisons"/>), a membership list, because that
/// is the one the corpus ever wrote: measured 2026-11-14 over every plan script a run captured (2,871 raw calls), `field`
/// was written 7 times and every one of them with `in`. `eq`, `ne`, `lt`, `lte`, `gt` and `gte` were authored
/// <c>0 of 2,871</c> each and are withdrawn; the position guards <c>col</c>/<c>row</c> measured the same zero.
/// </para>
/// <para>
/// `occupant` IS NOT A SECOND VOCABULARY. It is the ONE field test on <see cref="FarmhandForEachHealing.OccupantField"/> -
/// the field the clearing join reads, whose words are the engine's own (`ExecutionManager.DescribeTileOccupant`) and the
/// same words `FarmhandActionDescriptor.Clears` is declared in - so `{ occupant: "weed" }` and
/// `{ field: "occupant", in: ["weed"] }` are one test with one meaning.
/// </para>
/// <para>
/// A LOOP'S <c>Where</c> IS A CONJUNCTION: every predicate must hold for the row, and each predicate is ONE test. The pair
/// the corpus writes twice, <c>[{ occupant: "none" }, { field: "tillable", in: [true] }]</c>, only means anything as AND -
/// whether a tile is empty AND tillable - and its failure mode if read as OR is an effect rather than a refusal: a
/// `till_soil` pass that took either half would till the grass.
/// </para>
/// </summary>
public sealed record FarmhandForEachPredicate(string Field, IReadOnlyList<FarmhandForEachValue> Values)
{
    public const string FieldOperator = "field";

    /// <summary>The named test of what STANDS on the tile, in the words the clearing join is written in.</summary>
    public const string OccupantOperator = "occupant";

    /// <summary>The one comparison a field test offers: a membership list, `<c>in</c>`.</summary>
    public const string InOperator = "in";

    /// <summary>The keys that say WHAT one predicate tests, in the order a refusal names them.</summary>
    public static readonly string[] Selectors = { FieldOperator, OccupantOperator };

    /// <summary>
    /// Every comparison word this pass accepts, in the order a refusal names them: the ONE declaration the reader accepts
    /// a field test against and the one a refusal prints. The six ordering/equality words that used to sit beside `in`
    /// measured `0 of 2,871` raw calls and are gone; a word added here is a word the reader must read, and the test beside
    /// this file asserts that for every member rather than for the ones that were written by hand.
    /// </summary>
    public static readonly string[] Comparisons = { InOperator };

    /// <summary>
    /// How many values one `in` list may carry.
    ///
    /// The bound lives here rather than in the reader because it is a fact about the PREDICATE: a conjunction of eight
    /// predicates over lists of eight values is a rule a person can still read. Mirrors `MAX_FOR_EACH_VALUES`
    /// (`host/src/body-program-for-each.ts`), which is the compiler's half of the same bound.
    /// </summary>
    public const int MaximumValues = 8;

    public bool IsValid => this.Field.Length is >= 1 and <= 64 && this.Values.Count is >= 1 and <= MaximumValues;
}

/// <summary>
/// Where a `for_each` loop reads its rows from: a rectangle of live map tiles, and nothing else.
///
/// <para>
/// ONE SOURCE, DECLARED IN <see cref="Kinds"/>. The form used to name three - an area, a published target family and a
/// query subject - and the enumerator walked one: <c>FarmhandForEachArguments.TryReadSource</c> answered the other two with
/// <c>for_each_source_unavailable:&lt;kind&gt;</c>, so a caller could write a loop the Host's compiler accepted, the
/// preflight passed, and the game thread then refused for a source this Mod does not have. A family or query source would
/// be a SECOND enumeration - its own scan, its own answer for what a row's local column and row mean when the rows are not
/// a rectangle, and its own answer for a family whose rows are not tiles - so it is withdrawn rather than advertised.
/// </para>
/// <para>
/// "EVERY DRY CROP IN THIS PATCH" IS NOT A LOST SPELLING: it is the field test on an area's rows
/// (<c>{ field: "kind", in: ["crop"] }</c>), which this form already reads live.
/// </para>
/// </summary>
public sealed record FarmhandForEachSource(int X = 0, int Y = 0, int Width = 0, int Height = 0)
{
    /// <summary>The wire word of the one source kind: a rectangle of live map tiles.</summary>
    public const string AreaKind = "area";

    /// <summary>
    /// The source kinds this reader accepts, declared ONCE.
    ///
    /// <see cref="FarmhandForEachArguments.TryReadSource"/> reads what this names and answers any other word with this
    /// list, so a kind cannot be accepted in one place and missing from the other. The Host's `PLAN_FOR_EACH_SOURCES` is
    /// asserted equal to this array by `body-program-for-each.test.ts`, which is what keeps the grammar and this reader
    /// from drifting apart again - measured 2026-11-13, the grammar accepted three kinds and this reader one.
    /// </summary>
    public static readonly string[] Kinds = { AreaKind };

    /// <summary>
    /// How many rows one loop may address.
    ///
    /// A per-INTENT budget, not a view radius: the point of the form is that a 3x20 row is bigger than the 13x13 an
    /// observation carries. Over the bound the answer says `omitted: n` with the rectangle it covered - never a
    /// truncated table that looks complete, because a truncated table reads as a finished pass.
    /// </summary>
    public const int MaximumRows = 64;

    public int AreaRowCount => this.Width > 0 && this.Height > 0 ? checked(this.Width * this.Height) : 0;

    public bool IsValid => this.X >= 0 && this.Y >= 0 && this.Width >= 1 && this.Height >= 1
        && this.AreaRowCount is >= 1 and <= MaximumRows;
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
/// One loop intent: a source, an optional conjunction of predicates, and what to do with a matching row.
///
/// <para>
/// ONE CALL, ONE RULE. A loop used to carry further rules under <c>then</c>, which is what made one pass able to claim two
/// kinds of row; measured over every plan she ever wrote it was authored <c>0 of 37</c> <c>for_each</c> scripts, and the
/// only thing that ever wrote it was the Host's own fold of two calls over one rectangle into one pass. Both are withdrawn
/// here and in the grammar at the same time: two kinds of row in one rectangle are two <c>for_each</c> calls, each its own
/// node, each reporting the rows it did not claim.
/// </para>
/// <para>
/// <c>Do: null</c> is a STATEMENT - "every row this rule claims is a path" - and the pass counts it separately so a reader
/// can tell a deliberate path from a tile the predicate forgot.
/// </para>
/// </summary>
public sealed record FarmhandForEachLoop(
    FarmhandForEachSource Source,
    IReadOnlyList<FarmhandForEachPredicate>? Where,
    FarmhandForEachEffect? Do)
{
    /// <summary>
    /// How many predicates one loop's conjunction may carry: long enough to be a rule, short enough to be read.
    ///
    /// Mirrors `MAX_FOR_EACH_PREDICATES` (`host/src/body-program-for-each.ts`), which is the compiler's half of the same
    /// bound.
    /// </summary>
    public const int MaximumPredicates = 8;

    public bool IsValid =>
        this.Source is not null
        && this.Source.IsValid
        && (this.Where is null || (this.Where.Count <= MaximumPredicates
            && this.Where.All(predicate => predicate is not null && predicate.IsValid)))
        && (this.Do is null || this.Do.IsValid);
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
    /// Whether every predicate holds for this row - the loop's conjunction, AND rather than OR.
    ///
    /// `Where` absent means every row, which is why an absent predicate list is not an error: the caller may genuinely
    /// mean "every row of this source".
    /// </summary>
    public static bool Matches(FarmhandForEachLoop loop, IReadOnlyDictionary<string, FarmhandForEachValue> fields)
    {
        ArgumentNullException.ThrowIfNull(loop);
        ArgumentNullException.ThrowIfNull(fields);
        // An absent predicate list means every row, which is why it is not an error: the caller may genuinely mean
        // "every row of this source".
        if (loop.Where is null) return true;
        foreach (FarmhandForEachPredicate predicate in loop.Where)
        {
            if (!fields.TryGetValue(predicate.Field, out FarmhandForEachValue? value) || value is null) return false;
            if (!Holds(predicate, value)) return false;
        }
        return true;
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
        if (!Matches(loop, fields))
            return new FarmhandForEachRowDecision(x, y, localColumn, localRow, FarmhandForEachRowOutcome.NotMatched, null);
        return loop.Do is null
            ? new FarmhandForEachRowDecision(x, y, localColumn, localRow, FarmhandForEachRowOutcome.LeftAlone, null)
            : new FarmhandForEachRowDecision(x, y, localColumn, localRow, FarmhandForEachRowOutcome.Dispatched, loop.Do);
    }

    /// <summary>
    /// The tiles of a rectangle in the order the actor WALKS them: row 0 left to right, row 1 right to left, and so on.
    ///
    /// <para>
    /// THE ORDER IS A WALK, NOT AN ANSWER. A pass dispatches one row per tile and the actor walks between them, so a
    /// typewriter sweep pays the whole row width again at every break for nothing: measured on the 3x20 patch, 97 steps
    /// walked against 59, and the 38 saved are exactly one column per break. Walking is what a harvest node spends nearly
    /// all of its time on (2,235 ms of 2,232 ms), and it is paid whenever the model is not thinking.
    /// </para>
    /// <para>
    /// WHAT THE ORDER CANNOT MOVE. Each row keeps its own <c>LocalColumn</c>/<c>LocalRow</c>, which a row's dispatch
    /// identity is minted from; the tile set, the per-row decision and every reason code are the same in either order; and
    /// the answer's table is sorted by position before it is written
    /// (<c>RouteReenteringBodyProgramExecutor.Aggregate</c>), so no caller reads the walk.
    /// </para>
    /// </summary>
    public static IEnumerable<(int X, int Y, int LocalColumn, int LocalRow)> AreaRows(FarmhandForEachSource source)
    {
        ArgumentNullException.ThrowIfNull(source);
        for (int localRow = 0; localRow < source.Height; localRow++)
        for (int step = 0; step < source.Width; step++)
        {
            // EVEN ROWS RUN FORWARDS AND ODD ROWS RUN BACK along the row the previous one finished, so a break costs the
            // one step down and never the width. The column the guard tests is still the tile's own.
            int localColumn = localRow % 2 == 0 ? step : source.Width - 1 - step;
            yield return (source.X + localColumn, source.Y + localRow, localColumn, localRow);
        }
    }

    /// <summary>
    /// A row no predicate claimed, in the reason-code form the pass reports.
    ///
    /// `no_rule_matched:&lt;kind&gt;@&lt;x&gt;,&lt;y&gt;` names WHICH row and WHICH kind was forgotten: "three rows unmatched" cannot be
    /// acted on, and the row is what the next rule needs. It is the MIXED pass's word - see
    /// <see cref="NoRowMatchedWhereReasonCode"/> for the pass that claimed nothing at all.
    /// </summary>
    public static string NoRuleMatchedReasonCode(string kind, int x, int y) => $"no_rule_matched:{kind}@{x},{y}";

    /// <summary>The prefix of the ONE code a pass that claimed no row at all answers with.</summary>
    public const string NoRowMatchedWhere = "no_row_matched_where";

    /// <summary>
    /// A pass that claimed NO row, as one code: `no_row_matched_where:&lt;test&gt;:&lt;occupants&gt;`.
    ///
    /// <para>
    /// WHY ONE CODE AND NOT ONE PER TILE. Measured `round45` (`plan_66_dc0f5736a9faf977`): a 48-tile `cut_weeds` pass
    /// answered forty-eight entries of `no_rule_matched:ground@x,y` and the caller could act on none of them. When EVERY
    /// row misses, the fact is about the patch and not about the tiles: the test the caller wrote, and what the tiles
    /// carry instead. The per-tile word stays for the MIXED pass, where the tiles differ and the row is the news.
    /// </para>
    /// <para>
    /// THE BOUND IS THE GRAMMAR, NOT A NUMBER COPIED HERE: an occupant is appended only while the code is still one
    /// `BodyProgramValidation.IsReasonCode` accepts, so a long `in` list cannot produce a code the journal refuses - which
    /// would arrive as a node with no reason at all.
    /// </para>
    /// </summary>
    public static string NoRowMatchedWhereReasonCode(IReadOnlyList<FarmhandForEachPredicate> where, IReadOnlyList<string> occupants)
    {
        ArgumentNullException.ThrowIfNull(where);
        ArgumentNullException.ThrowIfNull(occupants);
        string code = $"{NoRowMatchedWhere}:{SpellingOf(where)}";
        if (!BodyProgramValidation.IsReasonCode(code)) return NoRowMatchedWhere;
        bool first = true;
        foreach (string occupant in occupants.Distinct(StringComparer.Ordinal))
        {
            string extended = $"{code}{(first ? ":" : "_")}{occupant}";
            if (!BodyProgramValidation.IsReasonCode(extended)) break;
            code = extended;
            first = false;
        }
        return code;
    }

    /// <summary>Every predicate of one rule, in the order a caller wrote them: `<test>_and_<test>`.</summary>
    private static string SpellingOf(IReadOnlyList<FarmhandForEachPredicate> where) =>
        string.Join("_and_", where.Select(SpellingOf));

    /// <summary>
    /// One predicate's own word: `<field>_<comparison>_<value>`, as `<field>_in_<value>` or `occupant_in_<word>`.
    ///
    /// Every part comes from the predicate's own declarations (<see cref="FarmhandForEachPredicate.Comparisons"/>), so the
    /// sentence a caller reads is built from the grammar it wrote in rather than from a table beside it.
    /// </summary>
    private static string SpellingOf(FarmhandForEachPredicate predicate) =>
        string.Join(
            "_",
            new[] { predicate.Field, FarmhandForEachPredicate.InOperator }.Concat(predicate.Values.Select(ValueText)));

    private static string ValueText(FarmhandForEachValue value) =>
        value.Text
        ?? value.Number?.ToString(CultureInfo.InvariantCulture)
        ?? (value.Flag is true ? "true" : "false");

    /// <summary>
    /// Whether the row's own value is one of the values the predicate names: every predicate left is a membership test,
    /// because `in` is the one comparison this form has.
    /// </summary>
    private static bool Holds(FarmhandForEachPredicate predicate, FarmhandForEachValue value) =>
        predicate.Values.Any(candidate => Equals(candidate, value));
}
