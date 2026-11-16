using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// THE PARSER THAT READS A WIRE RECORD MUST NEVER READ AN ATTRIBUTE'S ARGUMENT AS A MEMBER.
///
/// <para>
/// <b>The class, not the instance.</b> <c>251b0da0</c> added <c>[property: JsonIgnore(Condition =
/// JsonIgnoreCondition.WhenWritingNull)] bool? SleepAdmitsHere = null</c> and the reader - which split every
/// declaration on <c>=</c> and kept the identifier ending the left half - produced <c>Condition</c> as a snapshot field
/// and no <c>SleepAdmitsHere</c>. Fixing that one declaration would have bought one instance: the next attribute with an
/// argument, or a second argument on this one, walks into the same split. The population here is therefore DERIVED from
/// the wire model file - every record it declares, every member of each parameter list, and every attribute the Mod
/// applies to those members - so an attribute nobody has written yet is covered without editing this file.
/// </para>
/// <para>
/// <b>The property.</b> No member's parsed name equals any identifier or number from any attribute's argument list on
/// that member. A parser that splits before it understands reads an argument as a name; whether the argument is
/// <c>Condition</c>, <c>Anything</c> or a hundredth nested call, the reading contains a token that was written inside
/// brackets and is not a member.
/// </para>
/// <para>
/// <b>What it cannot see, said rather than implied.</b> A token inside a QUOTED argument is not an argument token - a
/// quoted word cannot be read as a member name - so an attribute such as <c>[Foo("Bar")]</c> is judged on its
/// identifiers only; an attribute that drops its member silently is caught by
/// <see cref="InventoryAddressabilityTests"/>'s schema crossings instead, which is what caught this one.
/// </para>
/// <para>
/// <b>The falsifier.</b> <see cref="TheGateFiresOnTheShippedAttributeAndOnOneNobodyHasWrittenYet"/> replays the rule that
/// shipped over today's tree (where the shipped defect is still the input) and then over a record carrying
/// <c>[property: SomeAttribute(Anything = 1)]</c>, requiring the finding to name that attribute and that token. Without
/// it this gate would be an assertion that has only ever been green.
/// </para>
/// </summary>
public sealed class PublishedFieldParserGateTests
{
    private const string FindingCode = "published_field_parser_sees_an_attribute_argument";

    [Fact]
    public void NoMemberTheParserReadsIsAnAttributeArgument()
    {
        IReadOnlyList<DeclaredRecord> records = WireRecordSource.DeclaredRecords(WireRecordSource.ModelSource());
        int members = records.Sum(record => record.Members.Count);
        int attributes = records.Sum(record => record.Members.Sum(member => member.Attributes.Count));
        int withArguments = records.Sum(record => record.Members.Sum(member =>
            member.Attributes.Count(attribute => attribute.ArgumentTokens.Count > 0)));

        // Not measured is not the same as nothing to do: each of these zeroes has its own reason below.
        records.Should().NotBeEmpty("no record was read from the wire model file, so nothing was judged");
        members.Should().BeGreaterThan(0, "a record with no members means the parameter list was not read");
        attributes.Should().BeGreaterThan(0, "the wire models apply attributes; none was found, so the population is lost");
        withArguments.Should().BeGreaterThan(
            0,
            "no attribute carrying an argument was found, and an attribute's argument is the whole defect this gate is for");

        IReadOnlyList<Finding> findings = Findings(records, member => member.Name);
        findings.Select(finding => finding.Code).Should().BeEmpty(
            $"{members} member(s) and {attributes} attribute(s) ({withArguments} with arguments) were read; a finding "
                + "means the parser read an attribute's argument as a member, so that member's real name is missing from "
                + "the record's declared fields and the argument is a field the record cannot populate");
    }

    [Fact]
    public void TheGateFiresOnTheShippedAttributeAndOnOneNobodyHasWrittenYet()
    {
        // The rule that shipped: split the declaration on '=' FIRST, then take the identifier that ends the left half.
        static string ShippedRule(DeclaredMember member) => Regex.Match(
                member.Declaration.Split('=')[0],
                "([A-Za-z_][A-Za-z0-9_]*)\\s*$",
                RegexOptions.CultureInvariant)
            .Groups[1].Value;

        IReadOnlyList<DeclaredRecord> shipped = WireRecordSource.DeclaredRecords(WireRecordSource.ModelSource());
        Findings(shipped, ShippedRule)
            .Select(finding => finding.Code)
            .Distinct(StringComparer.Ordinal)
            .Should()
            .Contain(
                FindingCode + ":property:JsonIgnore:Condition",
                "the shipped rule over today's tree reads `Condition` out of `JsonIgnore(Condition = ...)`; if this list "
                    + "is empty the gate cannot see the defect it was written for");

        const string Injected =
            "public sealed record BridgeSnapshot(\n" +
            "    bool Exhausted,\n" +
            "    [property: SomeAttribute(Anything = 1)] bool? SleepAdmitsHere = null);";
        IReadOnlyList<DeclaredRecord> injected = WireRecordSource.DeclaredRecords(Injected);
        injected.Should().ContainSingle().Which.Members.Select(member => member.Name)
            .Should().Equal(new[] { "Exhausted", "SleepAdmitsHere" });
        Findings(injected, ShippedRule)
            .Select(finding => finding.Code)
            .Should()
            .Contain(
                FindingCode + ":property:SomeAttribute:Anything",
                "an attribute nobody has written yet, carrying an argument nobody has written yet, is named with its token");
        Findings(injected, member => member.Name)
            .Should()
            .BeEmpty("the parser strips the attribute whole, so a new attribute changes no member's name");
    }

    /// <summary>
    /// The gate's reading: one finding per member whose parsed name is a token from an attribute applied to it.
    ///
    /// <paramref name="nameOf"/> is the parser under judgement. The production call passes the member's own parsed name;
    /// the falsifier passes the rule that shipped, which is how the same check is shown red.
    /// </summary>
    private static IReadOnlyList<Finding> Findings(
        IReadOnlyList<DeclaredRecord> records,
        Func<DeclaredMember, string> nameOf) =>
        records
            .SelectMany(record => record.Members.SelectMany(member =>
            {
                string name = nameOf(member);
                return member.Attributes.SelectMany(attribute => attribute.ArgumentTokens
                    .Where(token => string.Equals(token, name, StringComparison.Ordinal))
                    .Select(token => new Finding(attribute.Name, token, $"{record.Name}.{member.Name} as `{attribute.Text}`")));
            }))
            .ToArray();

    private sealed record Finding(string Attribute, string Token, string Where)
    {
        public string Code => $"{FindingCode}:{Attribute}:{Token}";

        public override string ToString() => $"{Code} ({Where})";
    }
}
