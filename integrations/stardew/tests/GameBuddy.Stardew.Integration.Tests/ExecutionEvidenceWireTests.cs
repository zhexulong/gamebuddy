using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The tailoring family's transaction boilerplate was pipelined into <see cref="EvidenceDetail"/> (the one
/// `key=value;…` builder), <see cref="ExecutionManager.TerminalRecorder"/> (the one terminal seam) and the family's two
/// <see cref="PairVocabulary"/> declarations. A pipeline over wire strings buys exactly one thing - the same bytes for
/// less code - and loses everything if it changes a character, so the assertions here are equality against the strings
/// the family emitted BEFORE the pipeline, transcribed from the retired interpolation expressions.
///
/// <para>
/// THE EXPECTED SIDE IS THE FROZEN WIRE TEXT, not a copy of the new code: each row's <c>Tail</c> is the
/// `key=value;…` half the old `$"{identity};…"` produced, and the identity half is produced by the family's own
/// <see cref="ExecutionManager.TailoringIdentity"/> - so a shape that reorders fields, renames a key, drops a field or
/// renders a number differently fails here, naming the row.
/// </para>
/// <para>
/// THE SECOND POPULATION IS THE FILE ITSELF. A byte test can only cover the shapes it names; a field dropped from a
/// CALL SITE is invisible to it. So the site gate reads
/// `integrations/stardew/farmhandexecutioncontroller.tailoringactions.cs`, and for every site whose detail the file
/// writes itself (the four single-site chains and the postcondition outcomes) compares the keys it names, in order,
/// against the keys of the same frozen tail. A dropped `.Field(…)` fails there, by site and by key.
/// </para>
/// <para>
/// THE BOUNDARY, stated rather than discovered: the remaining SHAPE calls carry their keys inside
/// <see cref="ExecutionManager.TerminalRecorder"/>'s methods, so the file does not spell them and the site gate cannot
/// read them; each is covered by its own row below, and the site gate asserts both populations so a row that stops
/// being reachable is red rather than silently unmeasured.
/// </para>
// MIXED SHAPE AND BEHAVIOUR: the byte-equality facts construct the recorder and read the receipt the Mod would publish, while the site gate reads the family's own source text, because a field dropped at a CALL SITE is invisible to any string the recorder can produce here; the trait would claim the whole class pins text, so this comment carries the mix instead.
public sealed class ExecutionEvidenceWireTests
{
    private const string TailoringFile = "farmhandexecutioncontroller.tailoringactions.cs";
    private const string Target = "tailoring_recipe_0123456789abcdef";
    private const string LiveTarget = "tailoring_recipe_fedcba9876543210";
    private const string Cloth = "(O)428";
    private const string Reagent = "(O)684";
    private const string Output = "(S)1002";
    private const string Garment = "(S)1001";
    private const string DyeItem = "(O)400";
    private const string NativeExceptionName = "InvalidOperationException";
    private const int Slots = 36;

    /// <summary>`left=…;right=…;output=…;…` - the fourteen fields `tailor_clothing` reports after its native call.</summary>
    private static readonly string TailorPostconditionTail =
        $"left={Cloth};right={Reagent};output={Output};left_before={Slots};left_after=35;right_before=12;right_after=11;right_spent=true;"
        + "output_before=0;output_after=1;delivered=1;dropped=0;disposition=inventory;dropped_debris=0";

    /// <summary>`garment=…;dye=…;colour_before=…;…` - the thirteen fields `dye_clothing_with_item` reports.</summary>
    private static readonly string DyePostconditionTail =
        $"garment={Garment};dye={DyeItem};colour_before=255,0,0;colour_expected=0,255,0;colour_after=10,20,30;strength=1;strength_source=prismatic_shard_white;"
        + "colour_changed=true;prismatic_after=true;dye_before=12;dye_after=11;dye_spent=true;colour_route=TailoringMenu.GetDyeColor";

    /// <summary>
    /// Every terminal the tailoring family can mint, with the detail text it emitted before the pipeline. `Emit` is the
    /// call the family makes today; `Tail` is what the retired interpolation put after the identity. Twenty-three rows,
    /// because the family mints twenty-three terminals.
    /// </summary>
    private static readonly (string Action, string Label, string Code, string Tail, Func<ExecutionManager.TerminalRecorder, LocalExecutionReceipt> Emit)[] Frozen =
    {
        ("tailor", "left slot", "tailoring_left_slot_invalid",
            $"inventory_slots={Slots};left_item=none",
            terminal => terminal.SlotRejected("tailoring_left_slot_invalid", ExecutionManager.RecipePair, Slots, "none")),
        ("tailor", "right slot, same slot", "tailoring_right_slot_invalid",
            $"inventory_slots={Slots};left_item={Cloth};right_item=same_slot",
            terminal => terminal.SlotRejected("tailoring_right_slot_invalid", ExecutionManager.RecipePair, Slots, Cloth, "same_slot")),
        ("tailor", "right slot, empty", "tailoring_right_slot_invalid",
            $"inventory_slots={Slots};left_item={Cloth};right_item=none",
            terminal => terminal.SlotRejected("tailoring_right_slot_invalid", ExecutionManager.RecipePair, Slots, Cloth, "none")),
        ("tailor", "target not found", "tailoring_target_not_found",
            $"left_item={Cloth};right_item={Reagent};published_kind=recipe",
            terminal => terminal.PairRejected("tailoring_target_not_found", ExecutionManager.RecipePair, Cloth, Reagent, "published_kind", ExecutionManager.TailoringRecipeKind)),
        ("tailor", "dye route required", "tailoring_dye_route_required",
            $"left_item={Cloth};right_item={Reagent};reason=the_pair_has_no_recipe_only_a_dye_colour",
            terminal => terminal.Rejected("tailoring_dye_route_required",
                EvidenceDetail.Of(ExecutionManager.RecipePair.ItemFirst, Cloth)
                    .Field(ExecutionManager.RecipePair.ItemSecond, Reagent)
                    .Field("reason", "the_pair_has_no_recipe_only_a_dye_colour"))),
        ("tailor", "colour picker required", "tailoring_colour_picker_required",
            $"left_item={Cloth};right_item={Reagent};reason=the_native_branch_defers_the_colour_to_a_free_rgb_picker",
            terminal => terminal.Rejected("tailoring_colour_picker_required",
                EvidenceDetail.Of(ExecutionManager.RecipePair.ItemFirst, Cloth)
                    .Field(ExecutionManager.RecipePair.ItemSecond, Reagent)
                    .Field("reason", "the_native_branch_defers_the_colour_to_a_free_rgb_picker"))),
        ("tailor", "no recipe", "tailoring_no_recipe",
            $"left_item={Cloth};right_item={Reagent}",
            terminal => terminal.PairRejected("tailoring_no_recipe", ExecutionManager.RecipePair, Cloth, Reagent)),
        ("tailor", "target changed", "tailoring_target_changed",
            $"live={LiveTarget};left_item={Cloth};right_item={Reagent}",
            terminal => terminal.LiveTargetRejected("tailoring_target_changed", ExecutionManager.RecipePair, LiveTarget, Cloth, Reagent)),
        ("tailor", "native exception", "tailoring_native_exception",
            $"left_item={Cloth};right_item={Reagent};native_exception={NativeExceptionName};native_call_ran_unknown=true",
            terminal => terminal.NativeExceptionUncertain("tailoring_native_exception", ExecutionManager.RecipePair, Cloth, Reagent, NativeException())),
        ("tailor", "output unavailable", "tailoring_output_unavailable",
            $"left_item={Cloth};right_item={Reagent}",
            terminal => terminal.PairRejected("tailoring_output_unavailable", ExecutionManager.RecipePair, Cloth, Reagent)),
        ("tailor", "in place combination", "tailoring_in_place_combination",
            $"left_item={Cloth};right_item={Reagent};native_branch=in_place",
            terminal => terminal.Rejected("tailoring_in_place_combination",
                EvidenceDetail.Of(ExecutionManager.RecipePair.ItemFirst, Cloth)
                    .Field(ExecutionManager.RecipePair.ItemSecond, Reagent)
                    .Field("native_branch", "in_place"))),
        ("tailor", "postcondition unavailable", "tailoring_postcondition_unavailable",
            TailorPostconditionTail,
            terminal => terminal.Uncertain("tailoring_postcondition_unavailable", TailorPostconditionDetail())),
        ("tailor", "clothing tailored", "clothing_tailored",
            TailorPostconditionTail,
            terminal => terminal.Succeeded("clothing_tailored", TailorPostconditionDetail())),
        ("tailor", "clothing tailoring output dropped", "clothing_tailoring_output_dropped",
            TailorPostconditionTail,
            terminal => terminal.PartiallySucceeded("clothing_tailoring_output_dropped", TailorPostconditionDetail())),

        ("dye", "left slot", "tailoring_left_slot_invalid",
            $"inventory_slots={Slots};garment_item=none",
            terminal => terminal.SlotRejected("tailoring_left_slot_invalid", ExecutionManager.DyePair, Slots, "none")),
        ("dye", "right slot, same slot", "tailoring_right_slot_invalid",
            $"inventory_slots={Slots};garment_item={Garment};dye_item=same_slot",
            terminal => terminal.SlotRejected("tailoring_right_slot_invalid", ExecutionManager.DyePair, Slots, Garment, "same_slot")),
        ("dye", "target not found", "tailoring_target_not_found",
            $"garment_item={Garment};dye_item={DyeItem};published_kind=dye",
            terminal => terminal.PairRejected("tailoring_target_not_found", ExecutionManager.DyePair, Garment, DyeItem, "published_kind", ExecutionManager.TailoringDyeKind)),
        ("dye", "garment not dyeable", "dye_clothing_garment_not_dyeable",
            $"garment_item={Garment};dyeable=false",
            terminal => terminal.Rejected("dye_clothing_garment_not_dyeable",
                EvidenceDetail.Of(ExecutionManager.DyePair.ItemFirst, Garment).Flag("dyeable", false))),
        ("dye", "no colour", "dye_clothing_no_colour",
            $"garment_item={Garment};dye_item={DyeItem}",
            terminal => terminal.PairRejected("dye_clothing_no_colour", ExecutionManager.DyePair, Garment, DyeItem)),
        ("dye", "target changed", "tailoring_target_changed",
            $"live={LiveTarget};garment_item={Garment};dye_item={DyeItem}",
            terminal => terminal.LiveTargetRejected("tailoring_target_changed", ExecutionManager.DyePair, LiveTarget, Garment, DyeItem)),
        ("dye", "native exception", "dye_clothing_native_exception",
            $"garment_item={Garment};dye_item={DyeItem};colour_before=255,0,0;native_exception={NativeExceptionName};native_call_ran_unknown=true",
            terminal => terminal.NativeExceptionUncertain("dye_clothing_native_exception", ExecutionManager.DyePair, Garment, DyeItem, "255,0,0", NativeException())),
        ("dye", "clothing dyed", "clothing_dyed",
            DyePostconditionTail,
            terminal => terminal.Succeeded("clothing_dyed", DyePostconditionDetail())),
        ("dye", "dye postcondition unavailable", "dye_clothing_postcondition_unavailable",
            DyePostconditionTail,
            terminal => terminal.Uncertain("dye_clothing_postcondition_unavailable", DyePostconditionDetail())),
    };

    [Fact]
    public void EveryFrozenDetailIsByteIdenticalThroughTheRecorder()
    {
        foreach ((string label, string action, string expected, Func<ExecutionManager.TerminalRecorder, LocalExecutionReceipt> emit) in Cases())
        {
            string actual = emit(Recorder(action)).Evidence ?? string.Empty;

            // Mapped first, so a failure says WHICH field of WHICH wire string moved; then byte for byte.
            Keyed(actual).Should().Equal(Keyed(expected), $"'{label}' must carry the same fields in the same order");
            actual.Should().Be(expected, $"'{label}' must emit the detail string this family emitted before the pipeline");
        }
    }

    [Fact]
    public void TheIdentityIsByteIdenticalForBothActions()
    {
        // The identity half of every detail above: `target=…;left_slot=…;right_slot=…;location=…` for the recipe action,
        // `garment_slot`/`dye_slot` for the dye action - one helper, two vocabularies, both spellings frozen.
        ExecutionManager.TailoringIdentity(ExecutionManager.RecipePair, Target, 3, 7, "Farm").ToString()
            .Should().Be($"target={Target};left_slot=3;right_slot=7;location=Farm");
        ExecutionManager.TailoringIdentity(ExecutionManager.DyePair, Target, 3, 7, "Farm").ToString()
            .Should().Be($"target={Target};garment_slot=3;dye_slot=7;location=Farm");
    }

    /// <summary>
    /// The numbers and flags the retired interpolations wrote, cross-checked against those interpolations themselves
    /// rather than against a literal: an int through `string.Create(CultureInfo.InvariantCulture, …)`, a float the same
    /// way (the one place the old code pinned the culture), and a bool as `x.ToString().ToLowerInvariant()`.
    /// </summary>
    [Fact]
    public void ScalarFieldsRenderTheFormTheRetiredInterpolationsWrote()
    {
        const int Count = 36;
        float[] strengths = { 1f, 0.5f, 0.25f };
        const bool SpendRight = true;

        string.Create(CultureInfo.InvariantCulture, $"inventory_slots={Count}")
            .Should().Be(EvidenceDetail.Of("inventory_slots", Count).ToString());
        foreach (float strength in strengths)
            string.Create(CultureInfo.InvariantCulture, $"pad=0;strength={strength}")
                .Should().Be(EvidenceDetail.Of("pad", 0).Field("strength", strength).ToString(), "the wire carries the invariant form");
        $"right_spent={SpendRight.ToString().ToLowerInvariant()}"
            .Should().Be(EvidenceDetail.Of("pad", 0).Flag("right_spent", SpendRight).ToString().Replace("pad=0;", "", StringComparison.Ordinal));
    }

    /// <summary>
    /// THE SEPARATOR DECISION: a value carrying `;` or `=` is REFUSED, not escaped. The detail is a map the Host parses
    /// by splitting on those two characters, so escaping would change bytes the Host already reads, while a refusal is
    /// already a terminal outcome (the router settles a handler's exception as `uncertain/handler_exception`). Every
    /// value this family passes is a game item id, a reason token or a location name; a separator in one of them means
    /// a programming error, and this is where it stops being a silent one.
    /// </summary>
    [Theory]
    [InlineData("left_item", "a;b")]
    [InlineData("left_item", "a=b")]
    [InlineData("left;item", "a")]
    [InlineData("left=item", "a")]
    public void AValueCarryingASeparatorIsRefused(string name, string value)
    {
        Action refuse = () => EvidenceDetail.Of(name, value);

        refuse.Should().Throw<ArgumentException>($"'{name}={value}' cannot be read back by the detail's own parse");
    }

    [Fact]
    public void ARefusalNamesTheFieldItRefused()
    {
        // The message is the caller's only handle on WHICH field it should not have passed.
        Action refuse = () => EvidenceDetail.Of("left_item", "a;b");

        refuse.Should().Throw<ArgumentException>().WithMessage("*left_item*");
    }

    /// <summary>
    /// The inverse direction: what the builder wrote is what a parser reads back. A detail is a keyed map, so a value
    /// the builder accepted must survive the round trip unchanged - the empty string, spaces, commas (the colour form),
    /// quotes and non-ASCII included. If any of these split, the builder's acceptance of it was a lie.
    /// </summary>
    [Theory]
    [InlineData("")]
    [InlineData("Farm")]
    [InlineData("255,0,0")]
    [InlineData("a b:c\"d")]
    [InlineData("(O)74 prismatic")]
    [InlineData("ünïcode")]
    public void WhatTheBuilderWritesParsesBackToTheSameMap(string value)
    {
        EvidenceDetail detail = EvidenceDetail.Of("inventory_slots", Slots).Field("left_item", value).Flag("dyeable", false);

        Keyed(detail.ToString()).Should().Equal(
            new List<string> { $"inventory_slots={Slots}", "left_item=" + value, "dyeable=false" },
            "a value the builder accepted must read back as the same field");
    }

    /// <summary>
    /// The file-level half. Every terminal the tailoring family mints goes through the recorder (no site re-spells
    /// `RememberTerminal`, the state or the identity prefix), and every site whose detail the file writes itself names
    /// exactly the fields its frozen counterpart carried, in order.
    /// </summary>
    [Fact]
    public void EveryTailoringTerminalGoesThroughTheRecorderAndNamesItsFields()
    {
        string source = File.ReadAllText(Path.Combine(RepositoryRoot(), "integrations", "stardew", TailoringFile));
        source.Should().NotContain("RememberTerminal(",
            "the family's terminals are the recorder's to mint; a site that writes its own is the pipeline being bypassed");

        List<(string Method, string Code, List<string> Keys)> sites = TerminalSites(source);
        // The rows freeze twenty-three details but the family makes twenty-two calls: the right-slot refusal's two rows
        // are its two VALUES (`same_slot` and `none`), not two sites. The written population is nine: four single-site
        // chains (three recipe, one dye) and the five postcondition outcomes.
        sites.Should().HaveCount(22,
            "the derivation must find every terminal the family makes - a rename that stopped it matching would otherwise pass here");
        List<(string Method, string Code, List<string> Keys)> written = sites.Where(site => site.Keys.Count > 0).ToList();
        written.Should().HaveCount(9,
            "nine of the family's details are written by the file itself; the other thirteen live in the recorder's shapes");

        foreach (IGrouping<string, (string Method, string Code, List<string> Keys)> group in written.GroupBy(site => site.Code))
        {
            var expected = Frozen
                .Where(row => row.Code == group.Key && ActionOf(row.Action) == ActionOf(group.First().Method))
                .Select(row => string.Join(",", Keys(row.Tail)))
                .ToList();
            var actual = group.Select(site => string.Join(",", site.Keys)).ToList();

            expected.Should().NotBeEmpty($"'{group.Key}' is emitted by the file, so the frozen table must declare its fields");
            actual.Should().BeEquivalentTo(expected, $"'{group.Key}' must name the fields its frozen counterpart carried");
        }
    }

    /// <summary>
    /// The frozen table is the authority the equality assertions rest on, so it is checked for the shape those
    /// assertions assume: every field splits into exactly one `name=value`, no tail repeats a field, and the reason
    /// codes it covers are the family's own.
    /// </summary>
    [Fact]
    public void TheFrozenTableIsWellFormed()
    {
        Frozen.Should().HaveCount(23, "the family mints twenty-three terminals");
        Frozen.Select(row => row.Code).Distinct(StringComparer.Ordinal).Should().HaveCount(18,
            "the family emits eighteen distinct reason codes");
        foreach ((string _, string label, string code, string tail, Func<ExecutionManager.TerminalRecorder, LocalExecutionReceipt> _) in Frozen)
        {
            code.Should().NotBeNullOrEmpty($"'{label}' must name the code it freezes");
            List<string> fields = Keyed(tail);
            fields.Should().NotBeEmpty($"'{label}' must carry at least one field");
            foreach (string field in fields)
                field.Split('=').Should().HaveCount(2, $"'{label}': '{field}' must be exactly one name=value");
            Keys(tail).Should().OnlyHaveUniqueItems($"'{label}' must not name the same field twice");
        }
    }

    // ---- the frozen table, evaluated -------------------------------------------------------------------------

    private static IEnumerable<(string Label, string Action, string Expected, Func<ExecutionManager.TerminalRecorder, LocalExecutionReceipt> Emit)> Cases()
    {
        foreach ((string action, string label, string _, string tail, Func<ExecutionManager.TerminalRecorder, LocalExecutionReceipt> emit) in Frozen)
            yield return ($"{action}: {label}", action, $"{Identity(action)};{tail}", emit);
    }

    /// <summary>The sample identity both actions bind a terminal to, built by the family's own helper.</summary>
    private static EvidenceDetail Identity(string action) =>
        ExecutionManager.TailoringIdentity(VocabularyOf(action), Target, 3, 7, "Farm");

    private static ExecutionManager.TerminalRecorder Recorder(string action)
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal));
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        return new ExecutionManager.TerminalRecorder(executions, $"req_{Guid.NewGuid():N}", $"exec_{Guid.NewGuid():N}", Identity(action));
    }

    private static PairVocabulary VocabularyOf(string action) =>
        ActionOf(action) == "dye" ? ExecutionManager.DyePair : ExecutionManager.RecipePair;

    private static Exception NativeException() => new InvalidOperationException("native");

    private static EvidenceDetail TailorPostconditionDetail() =>
        EvidenceDetail.Of("left", Cloth).Field("right", Reagent).Field("output", Output)
            .Field("left_before", Slots).Field("left_after", 35).Field("right_before", 12).Field("right_after", 11)
            .Flag("right_spent", true).Field("output_before", 0).Field("output_after", 1).Field("delivered", 1)
            .Field("dropped", 0).Field("disposition", "inventory").Field("dropped_debris", 0);

    private static EvidenceDetail DyePostconditionDetail() =>
        EvidenceDetail.Of("garment", Garment).Field("dye", DyeItem).Field("colour_before", "255,0,0")
            .Field("colour_expected", "0,255,0").Field("colour_after", "10,20,30").Field("strength", 1f)
            .Field("strength_source", "prismatic_shard_white").Flag("colour_changed", true).Flag("prismatic_after", true)
            .Field("dye_before", 12).Field("dye_after", 11).Flag("dye_spent", true).Field("colour_route", "TailoringMenu.GetDyeColor");

    /// <summary>The action a label, a handler name or an already-derived action names.</summary>
    private static string ActionOf(string nameOrAction) =>
        nameOrAction.Contains("Dye", StringComparison.Ordinal) || nameOrAction.Contains("dye", StringComparison.Ordinal)
            ? "dye"
            : "tailor";

    // ---- parsing, on both sides ------------------------------------------------------------------------------

    /// <summary>`key=value;…` split into its fields. The Mod's own reader does the same two splits.</summary>
    private static List<string> Keyed(string detail) => detail.Split(';').ToList();

    /// <summary>The field names of a detail, in wire order.</summary>
    private static List<string> Keys(string detail) =>
        Keyed(detail).Select(field => field[..field.IndexOf('=', StringComparison.Ordinal)]).ToList();

    /// <summary>
    /// The field names a `<c>.Of(…)</c>`/`<c>.Field(…)</c>`/`<c>.Flag(…)</c>` chain names, in order: a literal key as
    /// written, or a vocabulary member resolved through the action's own <see cref="PairVocabulary"/> - so a site that
    /// says `RecipePair.ItemFirst` is read as `left_item`, never as its own spelling of it.
    /// </summary>
    private static List<string> KeysNamed(string text) =>
        Regex.Matches(text, ChainMember, RegexOptions.None, TimeSpan.FromSeconds(5))
            .Cast<Match>()
            .Select(match => match.Groups[1].Success ? match.Groups[1].Value : ResolveKey(match.Groups[2].Value))
            .ToList();

    /// <summary>One vocabulary member as the key it renders.</summary>
    private static string ResolveKey(string member)
    {
        PairVocabulary pair = member.StartsWith("DyePair", StringComparison.Ordinal) ? ExecutionManager.DyePair : ExecutionManager.RecipePair;
        return member.EndsWith("ItemFirst", StringComparison.Ordinal) ? pair.ItemFirst : pair.ItemSecond;
    }

    private const string ChainMember = @"\.(?:Of|Field|Flag)\((?:""([a-z_]+)""|([A-Za-z]+Pair\.Item(?:First|Second)))";

    /// <summary>
    /// Every `<c>terminal.&lt;Shape&gt;("code", …)</c>` in the file, with the field names its own text names. A call
    /// that hands its detail by name resolves that variable's chain; a call whose keys live inside a recorder SHAPE
    /// resolves none, which is what the shape's own frozen row proves instead.
    /// </summary>
    private static List<(string Method, string Code, List<string> Keys)> TerminalSites(string source)
    {
        var sites = new List<(string, string, List<string>)>();
        foreach ((string method, string body) in MethodBodies(source))
        {
            List<string> carried = DetailVariables(body);
            foreach (Match call in Regex.Matches(body, @"terminal\.[A-Za-z]+\(", RegexOptions.None, TimeSpan.FromSeconds(5)).Cast<Match>())
            {
                string segment = Segment(body, call.Index + call.Length - 1);
                Match code = Regex.Match(segment, "\"([a-z_]+)\"", RegexOptions.None, TimeSpan.FromSeconds(5));
                code.Success.Should().BeTrue($"every terminal in {TailoringFile} names its reason code: {segment}");
                string codeName = code.Groups[1].Value;

                var keys = KeysNamed(segment);
                if (keys.Count == 0 && carried.Any(name => Passes(segment, name)))
                    keys = DetailKeys(body);
                sites.Add((method, codeName, keys));
            }
        }
        return sites;
    }

    /// <summary>Whether one balanced call segment hands this expression name as an argument.</summary>
    private static bool Passes(string segment, string name) => Regex.IsMatch(
        segment, $"[\\s(,]{Regex.Escape(name)}[\\s),]", RegexOptions.None, TimeSpan.FromSeconds(5));

    /// <summary>The names of the `EvidenceDetail <name> = …` declarations in one method body.</summary>
    private static List<string> DetailVariables(string body) =>
        Regex.Matches(body, @"EvidenceDetail\s+([a-z_]+)\s*=", RegexOptions.None, TimeSpan.FromSeconds(5))
            .Cast<Match>().Select(match => match.Groups[1].Value).ToList();

    /// <summary>The fields of a method's `EvidenceDetail … = …;` chain, in order.</summary>
    private static List<string> DetailKeys(string body)
    {
        Match declaration = Regex.Match(body, @"EvidenceDetail\s+[a-z_]+\s*=", RegexOptions.None, TimeSpan.FromSeconds(5));
        declaration.Success.Should().BeTrue($"a site that hands its detail by name must declare it: {body}");
        int end = body.IndexOf(";\n", declaration.Index, StringComparison.Ordinal);
        string chain = body[declaration.Index..(end < 0 ? body.Length : end)];
        return KeysNamed(chain);
    }

    /// <summary>One handler of the family, from its declaration to its own closing brace.</summary>
    private static List<(string Method, string Body)> MethodBodies(string source)
    {
        var methods = new List<(string, string)>();
        foreach (Match declaration in Regex.Matches(source, @"public LocalExecutionReceipt (RequestLocal[A-Za-z]+)\(", RegexOptions.None, TimeSpan.FromSeconds(5)).Cast<Match>())
        {
            int end = source.IndexOf("\n    }\n", declaration.Index, StringComparison.Ordinal);
            end.Should().BeGreaterThan(declaration.Index, $"the body of {declaration.Groups[1].Value} must be readable");
            methods.Add((declaration.Groups[1].Value, source[declaration.Index..end]));
        }
        methods.Should().HaveCount(2, "the family has two handlers; a third must be added here deliberately");
        return methods;
    }

    /// <summary>The balanced text of the call whose `(` is at <paramref name="open"/>.</summary>
    private static string Segment(string source, int open)
    {
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '(') depth++;
            else if (source[index] == ')' && --depth == 0) return source[open..(index + 1)];
        }
        return source[open..];
    }

    private static string RepositoryRoot()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the repository root is the directory holding AGENTS.md");
        return directory!.FullName;
    }
}
