using System;
using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The grammar of one `for_each` node, as the MOD reads it off an admitted node.
///
/// <para>
/// WHY THE MOD PARSES THIS ITSELF. The Host's compiler already writes the loop document, but a program node can also be
/// authored directly through `stardew_submit_action_program`, so the document a `for_each` node carries is untrusted input
/// by the time it reaches the game thread. A reader that only handled the compiler's own output would refuse nothing and
/// execute anything - and a source word the form does not have is refused BY NAME with the words it DOES have, rather than
/// silently narrowed into an area.
/// </para>
/// <para>
/// EVERY BOUND AND EVERY SPELLING COMES FROM THE MODEL, never from this file: `FarmhandForEachSource.Kinds`,
/// `FarmhandForEachStride.EveryOperator`, `FarmhandForEachStep.ByKindAction`, `FarmhandForEachLoop.MaximumRules`,
/// `FarmhandForEachRule.MaximumPredicates`, `FarmhandForEachPredicate.MaximumValues`,
/// `FarmhandForEachStep.MaximumArguments` and `FarmhandForEachEffect.MaximumSteps`. The bare numbers in this file's
/// documents are the CALLER's values (a 3x20 patch, every-3 columns); the limits are read from those constants so a bound
/// that changes cannot leave a test behind.
/// </para>
/// </summary>
public sealed class FarmhandForEachArgumentsTests
{
    /// <summary>The shape the Host's compiler writes, and the one the measured task needed: one 3x20 patch, one rule.</summary>
    private const string TillThePatch =
        "{\"source\":{\"area\":{\"x\":60,\"y\":18,\"w\":20,\"h\":3}},\"do\":{\"action\":\"till_soil\"}}";

    private static IReadOnlyDictionary<string, BodyProgramCanonicalValue> Arguments(string document) =>
        new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
        {
            [FarmhandForEachArguments.LoopArgument] = new(BodyProgramArgumentKind.String, document),
        };

    private static void Refused(string document, string expectedReasonCode)
    {
        FarmhandForEachArguments.TryParse(Arguments(document), out FarmhandForEachLoop? loop, out string reasonCode)
            .Should()
            .BeFalse($"'{document}' is not a loop this pass can run");
        loop.Should().BeNull("a refusal produces no loop, so nothing downstream can run a half-read one");
        reasonCode.Should().Be(expectedReasonCode, "the refusal names the part of the declaration to fix");
    }

    /// <summary>
    /// The measured case: one rectangle, no observation, no per-tile coordinate, one action for every row.
    /// </summary>
    [Fact]
    public void AnAreaLoopBecomesTheModelsOwnLoop()
    {
        FarmhandForEachArguments.TryParse(Arguments(TillThePatch), out FarmhandForEachLoop? loop, out string reasonCode)
            .Should()
            .BeTrue(reasonCode);

        loop.Should().NotBeNull();
        loop!.Source.X.Should().Be(60);
        loop.Source.Y.Should().Be(18);
        loop.Source.Width.Should().Be(20);
        loop.Source.Height.Should().Be(3);
        loop.Source.AreaRowCount.Should().Be(60, "three rows by twenty columns is one intent, not sixty");
        loop.Where.Should().BeNull("an absent predicate list means every row of the source");
        loop.Do!.Steps.Should().ContainSingle("the single object is the chain of length one, the one shape downstream reads");
        loop.Do.Steps[0].Action.Should().Be("till_soil");
        loop.Do.Steps[0].Arguments.Should().BeNull("the caller declared no argument, and absence is not an empty string");
        loop.IsValid.Should().BeTrue("the parse answers only loops the model itself accepts");
    }

    /// <summary>
    /// The intercropped patch: three rules of ONE pass, the first that claims a row deciding it.
    /// </summary>
    [Fact]
    public void ThePredicatesAndTheLaterRulesArriveInTheOrderTheCallerWroteThem()
    {
        string document =
            "{\"source\":{\"area\":{\"x\":60,\"y\":18,\"w\":20,\"h\":3}},"
            + "\"where\":[{\"col\":{\"every\":3,\"offset\":0}}],"
            + "\"do\":{\"action\":\"plant_seed\",\"slot\":0,\"expectedQualifiedItemId\":\"(O)472\"},"
            + "\"then\":["
            + "{\"where\":[{\"col\":{\"every\":3,\"offset\":1}}],\"do\":{\"action\":\"plant_seed\",\"slot\":0,\"expectedQualifiedItemId\":\"(O)473\"}},"
            + "{\"where\":[{\"col\":{\"every\":3,\"offset\":2}}],\"do\":null}]}";

        FarmhandForEachArguments.TryParse(Arguments(document), out FarmhandForEachLoop? loop, out string reasonCode)
            .Should()
            .BeTrue(reasonCode);

        loop!.Rules.Should().HaveCount(3, "the loop's own rule is first, then the alternates in order");
        loop.Rules[0].Where!.Should().ContainSingle();
        loop.Rules[0].Where![0].Axis.Should().Be(FarmhandForEachPredicate.ColOperator);
        loop.Rules[0].Where![0].Stride!.Every.Should().Be(3);
        loop.Rules[0].Where![0].Stride!.Offset.Should().Be(0);
        // A declared argument rides through as the caller's own scalar, spelled the way a wire scalar is spelled.
        loop.Rules[0].Do!.Steps[0].Arguments!["slot"].Should().Be("0");
        loop.Rules[0].Do!.Steps[0].Arguments!["expectedQualifiedItemId"].Should().Be("(O)472");
        loop.Rules[2].Do.Should().BeNull("`do: null` is a STATEMENT - this column is a path - and not a forgotten row");
    }

    [Fact]
    public void AFieldPredicateCarriesItsComparisonAndItsValue()
    {
        string document =
            "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":2,\"h\":1}},"
            + "\"where\":[{\"field\":\"kind\",\"eq\":\"weed\"},{\"field\":\"health\",\"gt\":0}],"
            + "\"do\":{\"action\":\"cut_weeds\"}}";

        FarmhandForEachArguments.TryParse(Arguments(document), out FarmhandForEachLoop? loop, out string reasonCode)
            .Should()
            .BeTrue(reasonCode);

        loop!.Where.Should().HaveCount(2);
        loop.Where![0].Field.Should().Be("kind");
        loop.Where[0].Comparison.Should().Be(FarmhandForEachComparison.Eq);
        loop.Where[0].Values[0].Text.Should().Be("weed");
        loop.Where[1].Field.Should().Be("health");
        loop.Where[1].Comparison.Should().Be(FarmhandForEachComparison.Gt);
        loop.Where[1].Values[0].Number.Should().Be(0, "a JSON number is a number, not the word for one");
    }

    /// <summary>
    /// A SOURCE WORD THIS FORM DOES NOT HAVE IS ANSWERED WITH THE WORDS IT DOES HAVE.
    ///
    /// The two sources whose row sourcing was never written - `family` and `query` - were accepted by the Host's grammar
    /// and refused HERE as `for_each_source_unavailable:<kind>`, a code naming a source the caller had written and
    /// offering nothing to write instead. Both are gone from the grammar on both sides now, and the word a caller gets for
    /// either is generated from <see cref="FarmhandForEachSource.Kinds"/>.
    /// </summary>
    [Theory]
    [InlineData("{\"source\":{\"family\":\"cropTargets\"},\"do\":{\"action\":\"harvest_crop\"}}", "family")]
    [InlineData("{\"source\":{\"query\":{\"subject\":\"trees\"}},\"do\":{\"action\":\"chop_tree\"}}", "query")]
    [InlineData("{\"source\":{},\"do\":{\"action\":\"chop_tree\"}}", "empty")]
    public void AnUnknownSourceWordIsRefusedWithTheWordsThatMayBeWritten(string document, string given) =>
        Refused(document, $"for_each_source_unrecognised:{given};allowed={string.Join(",", FarmhandForEachSource.Kinds)}");

    /// <summary>A field the Mod would silently ignore is refused instead, so nothing can be smuggled past it.</summary>
    [Fact]
    public void AnUnknownTopLevelKeyIsRefusedByName() =>
        Refused(
            "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":{\"action\":\"till_soil\"},\"limit\":4}",
            "for_each_unknown_key:limit");

    private static string Document(string predicate) =>
        "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"where\":[" + predicate + "],\"do\":{\"action\":\"cut_weeds\"}}";

    /// <summary>
    /// EVERY SPELLING THE MODEL DECLARES IS READ HERE, AND A REFUSAL NAMES THE ONES THAT ARE.
    ///
    /// <para>
    /// THE POPULATION IS THE MODEL'S OWN: <see cref="FarmhandForEachPredicate.Selectors"/> and
    /// <see cref="FarmhandForEachPredicate.Comparisons"/>. A spelling added to either is red here until this reader reads
    /// it, in both directions - so the two languages cannot drift into "the compiler and the wire accept a document this
    /// reader refuses".
    /// </para>
    /// <para>
    /// WHAT IT CLOSES. The Host's compiler and the wire accepted <c>{"field":"kind","in":["weed"]}</c> while this
    /// reader refused it as <c>for_each_where_unrecognised:in</c> - a word that named nothing the caller could write
    /// instead, for a document two thirds of the pipeline had already accepted. Measured: that exact failureCode sits in
    /// <c>tools/body-program-journal/journal.json</c>.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryDeclaredWhereSpellingIsReadAndTheRefusalNamesThem()
    {
        foreach (string selector in FarmhandForEachPredicate.Selectors)
        {
            string predicate = selector switch
            {
                FarmhandForEachPredicate.FieldOperator => "{\"field\":\"kind\",\"eq\":\"weed\"}",
                FarmhandForEachPredicate.OccupantOperator => "{\"occupant\":\"weed\"}",
                FarmhandForEachPredicate.ColOperator or FarmhandForEachPredicate.RowOperator =>
                    "{\"" + selector + "\":{\"every\":2,\"offset\":0}}",
                _ => throw new InvalidOperationException($"where_spelling_unproven:{selector}"),
            };
            FarmhandForEachArguments.TryParseDocument(Document(predicate), out _, out string answered)
                .Should()
                .BeTrue($"where_readers_disagree:{selector}:mod answered {answered}");
        }

        foreach ((string word, FarmhandForEachComparison _) in FarmhandForEachPredicate.Comparisons)
        {
            string value = string.Equals(word, FarmhandForEachPredicate.InOperator, StringComparison.Ordinal) ? "[\"weed\"]" : "\"weed\"";
            FarmhandForEachArguments.TryParseDocument(Document("{\"field\":\"kind\",\"" + word + "\":" + value + "}"), out _, out string answered)
                .Should()
                .BeTrue($"where_readers_disagree:{word}:mod answered {answered}");
        }

        // A WORD THE MODEL DOES NOT HAVE IS ANSWERED WITH THE WORDS IT DOES, derived from the declaration and not restated.
        FarmhandForEachArguments.TryParseDocument(Document("{\"in\":[\"weed\"]}"), out _, out string reasonCode).Should().BeFalse();
        reasonCode.Should().StartWith(
            $"{FarmhandForEachArguments.WhereUnrecognised}:in;allowed={string.Join(",", FarmhandForEachPredicate.Selectors)}",
            "the refusal names the word that was written AND the spellings that may be written instead");

        FarmhandForEachArguments.TryParseDocument(Document("{\"field\":\"kind\",\"equals\":\"weed\"}"), out _, out reasonCode).Should().BeFalse();
        reasonCode.Should().StartWith(
            $"{FarmhandForEachArguments.WhereUnrecognised}:equals;allowed={string.Join(",", FarmhandForEachPredicate.Comparisons.Select(entry => entry.Word))}",
            "beside `field` the alternatives are the comparison words, and they are printed from the same declaration the reader accepts");

        (FarmhandForEachPredicate.Selectors.Length + FarmhandForEachPredicate.Comparisons.Length).Should()
            .BeGreaterThan(0, "blocked: the model declares no spelling, so this gate examined nothing");
    }

    /// <summary>
    /// `occupant` IS THE TILE FIELD THE CLEARING JOIN READS, not a second vocabulary beside it.
    ///
    /// The words are the engine's own (<c>ExecutionManager.DescribeTileOccupant</c>, and the `Clears` declarations that
    /// name the same words), and the predicate is the ONE field test on
    /// <see cref="FarmhandForEachHealing.OccupantField"/> - so `occupant: "weed"` and
    /// `field: "occupant", eq: "weed"` cannot come to mean two things.
    /// </summary>
    [Fact]
    public void TheOccupantSpellingReadsTheFieldTheClearingJoinReads()
    {
        FarmhandForEachArguments.TryParseDocument(Document("{\"occupant\":\"weed\"}"), out FarmhandForEachLoop? loop, out string reasonCode)
            .Should()
            .BeTrue(reasonCode);

        loop!.Where.Should().ContainSingle();
        loop.Where![0].Field.Should().Be(FarmhandForEachHealing.OccupantField);
        loop.Where[0].Comparison.Should().Be(FarmhandForEachComparison.Eq);
        loop.Where[0].Values[0].Text.Should().Be("weed");
        loop.Where[0].IsPositionGuard.Should().BeFalse("occupant is a test of what stands there, not of where the row is");
    }

    /// <summary>A stride that claims no index is a rule that can never match, so it is refused rather than run dead.</summary>
    [Fact]
    public void AStrideThatClaimsNoIndexIsRefusedAsAWhereFault() =>
        Refused(
            "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":3,\"h\":1}},\"where\":[{\"col\":{\"every\":3,\"offset\":3}}],\"do\":{\"action\":\"till_soil\"}}",
            "for_each_invalid:where");

    [Fact]
    public void MoreRulesThanTheBoundAreRefusedWithTheCount()
    {
        // `then` carries the bound's worth of rules, so the pass would have one MORE than the bound: the loop's own rule
        // is one of them, and the refusal names the total the caller actually declared.
        string[] rules = new string[FarmhandForEachLoop.MaximumRules];
        for (int index = 0; index < rules.Length; index++) rules[index] = "{\"do\":{\"action\":\"till_soil\"}}";
        Refused(
            "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":{\"action\":\"till_soil\"},\"then\":[" + string.Join(",", rules) + "]}",
            $"for_each_too_many_rules:{FarmhandForEachLoop.MaximumRules + 1}");
    }

    /// <summary>An extent past the per-intent bound says which part of the declaration failed, not a bare `invalid`.</summary>
    [Fact]
    public void AnAreaPastThePerIntentRowBoundIsRefusedAsASourceFault() =>
        Refused(
            $"{{\"source\":{{\"area\":{{\"x\":0,\"y\":0,\"w\":20,\"h\":4}}}},\"do\":{{\"action\":\"till_soil\"}}}}",
            "for_each_invalid:source");

    [Fact]
    public void AnExtentOfZeroRowsIsRefusedAsASourceFault() =>
        Refused("{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":0,\"h\":3}},\"do\":{\"action\":\"till_soil\"}}", "for_each_invalid:source");

    /// <summary>
    /// A `do` whose step names no action is refused BY THE STEP, not as a bare `invalid`: the caller has to know which step of
    /// its chain it wrote wrongly, and `for_each_invalid:do` named nothing anyone could act on.
    /// </summary>
    [Fact]
    public void AnEffectWithoutAnActionNamesTheStepThatIsNotAStep() =>
        Refused("{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":{\"slot\":0}}", "for_each_do_step_unrecognised:0");

    [Fact]
    public void ANodeWithoutTheLoopArgumentIsRefusedAsALoopFault()
    {
        IReadOnlyDictionary<string, BodyProgramCanonicalValue> arguments =
            new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal);

        FarmhandForEachArguments.TryParse(arguments, out FarmhandForEachLoop? loop, out string reasonCode).Should().BeFalse();
        loop.Should().BeNull();
        reasonCode.Should().Be("for_each_invalid:loop");
    }

    /// <summary>An argument the loop form does not declare cannot ride along inside the node either.</summary>
    [Fact]
    public void AnUnknownNodeArgumentIsRefusedByName()
    {
        var arguments = new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
        {
            [FarmhandForEachArguments.LoopArgument] = new(BodyProgramArgumentKind.String, TillThePatch),
            ["repeat"] = new(BodyProgramArgumentKind.String, "3"),
        };

        FarmhandForEachArguments.TryParse(arguments, out _, out string reasonCode).Should().BeFalse();
        reasonCode.Should().Be("for_each_unknown_key:repeat");
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[1,2,3]")]
    [InlineData("")]
    public void ADocumentThatIsNotAnObjectIsRefusedAsALoopFault(string document) => Refused(document, "for_each_invalid:loop");

    /// <summary>
    /// THE ROW'S IDENTITY IS THE MOD'S, NOT THE CALLER'S. A `do` that names `expectedTargetId` is a statement about a
    /// tile the caller cannot see - true only until the world differs - and the form fills it per row, so the declaration
    /// is refused BY NAME instead of being silently overridden.
    /// </summary>
    [Theory]
    [InlineData(
        "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":{\"action\":\"water_crop\",\"expectedTargetId\":\"crop_0123456789abcdef\"}}")]
    [InlineData(
        "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":null,\"then\":[{\"do\":{\"action\":\"harvest_crop\",\"expectedQualifiedItemId\":\"(O)24\",\"expectedTargetId\":\"crop_0123456789abcdef\"}}]}")]
    public void ARowIdentityTheCallerWroteIsRefusedByName(string document) =>
        Refused(document, FarmhandForEachArguments.RowIdentityIsNotTheCallers);

    /// <summary>
    /// The by-kind reference is a REFERENCE the Mod resolves, not an action id the caller may restate: it must survive the
    /// parse unchanged so the classifier beside the row reader is the only thing that names the action.
    /// </summary>
    [Fact]
    public void TheByKindReferenceRidesThroughAsItselfForTheRowReaderToResolve()
    {
        FarmhandForEachArguments.TryParse(
                Arguments("{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":2,\"h\":2}},\"do\":{\"action\":\"by_kind\"}}"),
                out FarmhandForEachLoop? loop,
                out string reasonCode)
            .Should()
            .BeTrue(reasonCode);

        loop!.Do!.Steps[0].Action.Should().Be(FarmhandForEachStep.ByKindAction);
    }

    /// <summary>
    /// ONE TILE, THREE STEPS, ONE PASS. The measured reason the chain exists: clearing a tile, tilling it and sowing it are
    /// one tile's work, and a form that could name one action per row spent three passes - with three rounds of waking,
    /// ordering and receipts - to do it. The steps arrive in the order the caller wrote them, with their own arguments.
    /// </summary>
    [Fact]
    public void ADoneArrayIsOneChainOfStepsInTheOrderTheCallerWroteThem()
    {
        string document =
            "{\"source\":{\"area\":{\"x\":60,\"y\":18,\"w\":6,\"h\":1}},"
            + "\"do\":[{\"action\":\"till_soil\"},{\"action\":\"water_crop\"},{\"action\":\"plant_seed\",\"seed\":\"hops\"}]}";

        FarmhandForEachArguments.TryParse(Arguments(document), out FarmhandForEachLoop? loop, out string reasonCode)
            .Should()
            .BeTrue(reasonCode);

        loop!.Do!.Steps.Should().HaveCount(3);
        loop.Do.Steps.Select(step => step.Action).Should().Equal("till_soil", "water_crop", "plant_seed");
        loop.Do.Steps[2].Arguments!["seed"].Should().Be("hops", "each step carries its OWN arguments, not the chain's");
        loop.IsValid.Should().BeTrue();
    }

    /// <summary>
    /// THE CHAIN IS BOUNDED AT BOTH ENDS, and each end says which it is. An empty array is not "leave this row alone" - that
    /// is `do: null` - and a chain past the bound is refused with its own count so the caller can see how far over it is.
    /// </summary>
    [Fact]
    public void AChainPastItsBoundIsRefusedWithItsOwnCount()
    {
        string overlong =
            "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":["
            + string.Join(",", Enumerable.Repeat("{\"action\":\"till_soil\"}", FarmhandForEachEffect.MaximumSteps + 1))
            + "]}";

        Refused(overlong, $"for_each_too_many_steps:{FarmhandForEachEffect.MaximumSteps + 1}:{FarmhandForEachEffect.MaximumSteps}");
        Refused("{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":[]}", "for_each_do_empty");
    }

    /// <summary>
    /// A STEP THAT IS NOT A STEP IS NAMED BY ITS POSITION. In a chain the caller has to know WHICH step to fix, and the
    /// refusal that used to answer a missing action said nothing a caller could act on.
    /// </summary>
    [Theory]
    [InlineData(
        "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":[{\"action\":\"till_soil\"},\"water_crop\"]}",
        "for_each_do_step_unrecognised:1")]
    [InlineData(
        "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":[{\"action\":\"till_soil\"},{\"seed\":\"hops\"}]}",
        "for_each_do_step_unrecognised:1")]
    [InlineData(
        "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":[{\"action\":\"till_soil\"},{\"action\":\"plant_seed\",\"seed\":[\"hops\"]}]}",
        "for_each_do_step_unrecognised:1:seed")]
    public void AStepThatIsNotAStepIsRefusedByItsPosition(string document, string expectedReasonCode) =>
        Refused(document, expectedReasonCode);

    /// <summary>A row identity is the Mod's in EVERY step of a chain, not only in the first one.</summary>
    [Fact]
    public void ARowIdentityInsideALaterStepIsRefusedByName() =>
        Refused(
            "{\"source\":{\"area\":{\"x\":0,\"y\":0,\"w\":1,\"h\":1}},\"do\":[{\"action\":\"till_soil\"},"
            + "{\"action\":\"water_crop\",\"expectedTargetId\":\"crop_0123456789abcdef\"}]}",
            FarmhandForEachArguments.RowIdentityIsNotTheCallers);
}
