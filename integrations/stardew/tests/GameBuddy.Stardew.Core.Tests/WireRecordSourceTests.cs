using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// THE SHAPES A WIRE RECORD'S PARAMETER LIST MAY TAKE, each asserted against the one reader that parses it.
///
/// <para>
/// <b>Why the first fact exists.</b> <c>251b0da0</c> added the first attribute WITH ARGUMENTS to the snapshot record:
/// <c>[property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? SleepAdmitsHere = null</c>. The
/// reader split each declaration on <c>=</c> and took the identifier ending the left half, so it read the attribute's
/// own argument <c>Condition</c> as a snapshot field and dropped <c>SleepAdmitsHere</c> entirely. Nothing errored: one
/// crossing reported a field the schema does not declare, the other reported a field the record does not declare, and
/// the parser was correct only while every attribute it met was argument-free.
/// </para>
/// <para>
/// So the assertion is two-way on purpose - the argument token is ABSENT and the member is PRESENT - because a fix that
/// stripped the attribute by cutting at the first <c>(</c> would keep the member and still be wrong the day an attribute
/// has no argument list.
/// </para>
/// </summary>
public sealed class WireRecordSourceTests
{
    /// <summary>The declaration <c>251b0da0</c> added, verbatim from `BridgeProtocolModels.cs`.</summary>
    private const string ShippedDeclaration =
        "[property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? SleepAdmitsHere = null";

    [Fact]
    public void TheAttributedMemberIsReadByNameAndItsArgumentIsNotReadAtAll()
    {
        const string Source =
            "public sealed record BridgeSnapshot(\n" +
            "    long Revision,\n" +
            "    IReadOnlyList<BridgeWaterTarget>? WaterTargets = null,\n" +
            "    // The prose between the members carries commas, parentheses and backticks of its own.\n" +
            "    " + ShippedDeclaration + ");";

        IReadOnlyList<DeclaredMember> members = WireRecordSource.DeclaredMembers(Source, "BridgeSnapshot");

        members.Select(member => member.Name).Should().Equal(
            new[] { "Revision", "WaterTargets", "SleepAdmitsHere" },
            "the member the attribute is applied to is named by its declaration, not by the attribute's argument");
        DeclaredMember shipped = members[members.Count - 1];
        shipped.Attributes.Should().ContainSingle()
            .Which.ArgumentTokens.Should().Contain("Condition", "the token the shipped split misread is read as an argument now");
        shipped.Attributes[0].Name.Should().Be("property:JsonIgnore", "the attribute is named with its own target");
    }

    [Fact]
    public void EveryShapeAnAttributeTakesIsRemovedBeforeTheDefaultValueIsSplit()
    {
        const string Source =
            "public sealed record BridgeSnapshot(\n" +
            "    [JsonIgnore] bool? Bare,\n" +
            "    [Obsolete(\"gone\")] string Positional,\n" +
            "    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? Named = 7,\n" +
            "    [property: SomeAttribute(Inner(1), Outer = Nested(Call(x)))] string Nested,\n" +
            "    [A][B(Offset = 2)] string Several,\n" +
            "    string DefaultWithASeparator = \"a=b\");";

        IReadOnlyList<DeclaredMember> members = WireRecordSource.DeclaredMembers(Source, "BridgeSnapshot");

        members.Select(member => member.Name).Should().Equal(
            new[] { "Bare", "Positional", "Named", "Nested", "Several", "DefaultWithASeparator" },
            "each attribute shape is stripped whole, so every member is named by its own declaration");
        members[1].Attributes.Single().ArgumentTokens.Should().BeEmpty("a quoted argument states no identifier");
        members[3].Attributes.Single().ArgumentTokens.Should().Contain(new[] { "Inner", "Outer", "Nested", "Call", "x" });
        members[4].Attributes.Select(attribute => attribute.Name).Should().Equal(new[] { "A", "B" });
    }

    [Fact]
    public void ACommaInsideATypeArgumentDoesNotStartANewMember()
    {
        const string Source =
            "public sealed record BridgeWorldFact(\n" +
            "    IReadOnlyDictionary<string, string> Facts,\n" +
            "    int Revision);";

        WireRecordSource.DeclaredMembers(Source, "BridgeWorldFact").Select(member => member.Name)
            .Should().Equal(new[] { "Facts", "Revision" }, "a type argument's comma is not a member boundary");
    }

    [Fact]
    public void AMemberWhoseNameCannotBeReadIsRefusedRatherThanDropped()
    {
        const string Source = "public sealed record BridgeSnapshot([JsonIgnore], int Revision);";

        Action reading = () => WireRecordSource.DeclaredMembers(Source, "BridgeSnapshot");

        reading.Should().Throw<InvalidOperationException>()
            .WithMessage(
                "*unreadable wire-record member*",
                "a declaration that names nothing must be refused: a silently shorter list is how SleepAdmitsHere was lost");
    }

    [Fact]
    public void TheRealSnapshotRecordDeclaresTheAttributedFieldAndNoAttributeArgument()
    {
        IReadOnlyList<string> fields = WireRecordSource.DeclaredMembers(WireRecordSource.ModelSource(), "BridgeSnapshot")
            .Select(member => member.Name)
            .ToArray();

        fields.Should().Contain("SleepAdmitsHere", "the field `251b0da0` published is a field of the record");
        fields.Should().NotContain(new[] { "Condition", "JsonIgnore", "JsonIgnoreCondition", "WhenWritingNull" });
        fields.Should().OnlyHaveUniqueItems("two members with one name would zip against the construction site twice");
    }
}
