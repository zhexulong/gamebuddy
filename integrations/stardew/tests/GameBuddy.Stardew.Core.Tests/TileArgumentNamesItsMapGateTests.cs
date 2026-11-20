using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The gate <c>a_coordinate_argument_names_the_map_it_is_on:&lt;action&gt;.&lt;argument&gt;</c>: every action argument that
/// is a TILE must declare which map's coordinates it is read on.
///
/// <para>
/// THE INCIDENT, twice in one run. Measured <c>round82</c>, day 5: from <c>FarmHouse</c> at <c>(3,11)</c> she sent
/// <c>move_to_tile(64,14)</c> and then <c>enter_exit(64,14)</c>; from <c>AnimalShop</c> at <c>(13,19)</c> the same shape
/// with <c>(90,15)</c>. Both numbers are the door tile of the SAME door spelled the way the map she had just LEFT spells
/// it - <c>Farm:64,14</c> is the farmhouse's own human door, <c>Forest:90,15</c> the animal shop's - so each request named
/// a tile that is not on her map at all. Nothing in the catalog said <c>x</c>/<c>y</c> is a tile of the map she is
/// standing on, and the refusal reported the distance as if it were: <c>door_out_of_range ... distance=61</c>, a walk
/// between two maps that cannot exist.
/// </para>
///
/// <para>
/// THE POPULATION IS THE CATALOG, never a list. <see cref="FarmhandActionCatalog.Registrations"/> is the authority the
/// Agent's action surface is built from, so an action added tomorrow is examined without anybody remembering to add it
/// here, and the two names a tile pair is published under are the product's own (<c>x</c>/<c>y</c> - the same pair the
/// row planner treats as the row's address). The three counts are printed because "0 bare" means nothing without
/// "examined N": <c>arguments A · map-checked M · bare B</c>, and <c>B&gt;0</c> fails naming the action and the
/// argument.
/// </para>
/// </summary>
public sealed class TileArgumentNamesItsMapGateTests
{
    private const string Gate = "a_coordinate_argument_names_the_map_it_is_on";

    private readonly ITestOutputHelper output;

    public TileArgumentNamesItsMapGateTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryTileArgumentSaysWhichMapItsCoordinateIsOn()
    {
        (string ActionId, FarmhandActionArgument Argument)[] arguments =
            TileArguments(FarmhandActionCatalog.Registrations).ToArray();

        arguments.Should().NotBeEmpty(
            "an empty population is a blocked reading, not a pass: no action publishing `x`/`y` means this gate examined "
            + "nothing, which is not the same fact as every coordinate being declared");

        string[] bare = Bare(arguments);
        int mapChecked = arguments.Length - bare.Length;

        this.output.WriteLine($"{Gate}: arguments {arguments.Length} · map-checked {mapChecked} · bare {bare.Length}");
        foreach (string entry in bare)
            this.output.WriteLine($"  bare {entry}");

        mapChecked.Should().BePositive(
            "some argument must declare its map, or the measured zero is a catalog that was not read");

        bare.Should().BeEmpty(
            "a tile argument that does not say which map its coordinates are read on is a coordinate the Agent can copy "
            + "from the map she left, and every refusal will report a walk that does not exist. Declare "
            + "`TileSpace: FarmhandTileSpace.CurrentMap` (or add the space this action really means): "
            + string.Join(", ", bare));
    }

    /// <summary>
    /// THE FALSIFIER, on the gate itself: two tile arguments carrying no declaration are reported BY ACTION AND
    /// ARGUMENT. <c>move_to_tile</c> and <c>enter_exit</c> are the pair <c>round82</c> lost the map on, so a missing
    /// declaration there is the defect this gate exists for - and a gate that only ever runs against a clean catalog
    /// cannot be shown to fail on a dirty one.
    /// </summary>
    [Fact]
    public void ABareTileArgumentIsReportedByActionAndArgument()
    {
        (string ActionId, FarmhandActionArgument Argument)[] injected =
        {
            ("move_to_tile", new FarmhandActionArgument("x", "integer")),
            ("enter_exit", new FarmhandActionArgument(
                "y", "integer", null, FarmhandActionCatalog.TransitionSourceTileMeaning)),
            ("till_soil", new FarmhandActionArgument("x", "integer", TileSpace: FarmhandTileSpace.CurrentMap)),
        };

        Bare(injected).Should().Equal(
            new[]
            {
                $"{Gate}:move_to_tile.x",
                $"{Gate}:enter_exit.y",
            },
            "the declaration must fail by ACTION and ARGUMENT, and a declared argument must not be reported at all");
    }

    /// <summary>
    /// The population: every argument of every registered action that is a TILE, derived from the catalog itself.
    /// <c>x</c>/<c>y</c> is the pair this product publishes a tile under, and the pair its own row dispatch reads as the
    /// row's coordinates (<c>RouteReenteringBodyProgramExecutor</c>), so one spelling decides membership for both.
    /// </summary>
    private static IEnumerable<(string ActionId, FarmhandActionArgument Argument)> TileArguments(
        IEnumerable<FarmhandActionRegistration> registrations) =>
        registrations.SelectMany(registration =>
            (registration.Descriptor?.Arguments ?? Array.Empty<FarmhandActionArgument>())
            .Where(IsATile)
            .Select(argument => (registration.ActionId, argument)));

    private static bool IsATile(FarmhandActionArgument argument) =>
        argument.Name is "x" or "y" && string.Equals(argument.Type, "integer", StringComparison.Ordinal);

    /// <summary>One finding per tile argument that has not declared which map its coordinates are read on.</summary>
    internal static string[] Bare(IEnumerable<(string ActionId, FarmhandActionArgument Argument)> arguments) =>
        arguments
            .Where(entry => entry.Argument.TileSpace is null)
            .Select(entry => $"{Gate}:{entry.ActionId}.{entry.Argument.Name}")
            .ToArray();
}
