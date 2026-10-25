using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A node that fails must hand its dependents a terminal state, exactly as a rejected node does.
///
/// Measured 2026-10-25 on the multi-day run: `exit_house` was dispatched while the actor was still six
/// tiles from the door, the native call refused with `door_out_of_range`, and the journal marked that node
/// Failed. Its dependents were never touched, so they stayed Pending - and `HasExecutableWork` is
/// "a Pending node whose DependsOn are all Succeeded", which no longer holds for anything. The program was
/// then recomputed to Failed with unnamed Pending nodes still inside it: the state the persistence layer's
/// own comment calls the poison.
///
/// The asymmetry is the defect: `Rejected` propagates a `SkippedDependency` closure, `Failed` propagates
/// nothing. Both are terminals, so both owe their dependents a reason.
///
/// These cases pin the rule on the graph alone, because that is the whole question: given a set of node
/// states and a dependency graph, which nodes are owed a skip.
/// </summary>
public sealed class FailedNodeDependentTests
{
    private static readonly (string Node, string[] DependsOn)[] Graph =
    {
        ("exit_house", Array.Empty<string>()),
        ("walk_east", new[] { "exit_house" }),
        ("clear_rocks", new[] { "walk_east" }),
        ("tend_crops", new[] { "exit_house" }),
        ("harvest", new[] { "tend_crops" }),
    };

    [Fact]
    public void TheDirectDependentsOfAFailedNodeAreOwedASkip()
    {
        IReadOnlyList<string> owed = FailedDependents.Compute(
            Graph,
            failed: new[] { "exit_house" },
            stateOf: node => node == "exit_house" ? "Failed" : "Pending");

        // The closure, not just the direct children: clear_rocks depends on walk_east, so it is owed a skip
        // it cannot derive from its own dependency list alone.
        owed.Should().BeEquivalentTo(new[] { "walk_east", "tend_crops", "clear_rocks", "harvest" });
    }

    [Fact]
    public void TheSkipReachesTheWholeClosure()
    {
        // clear_rocks depends on walk_east, which depends on exit_house: it is owed a skip it cannot derive
        // from its own direct dependency alone.
        IReadOnlyList<string> owed = FailedDependents.Compute(
            Graph,
            failed: new[] { "exit_house" },
            stateOf: node => node == "exit_house" ? "Failed" : "Pending");

        owed.Should().Contain("clear_rocks");
        owed.Should().Contain("harvest");
    }

    [Fact]
    public void ANodeWithNoPathToTheFailureIsNotTouched()
    {
        // An independent branch keeps its own chance to run.
        var graph = new (string Node, string[] DependsOn)[]
        {
            ("a", Array.Empty<string>()),
            ("fails", Array.Empty<string>()),
            ("after_a", new[] { "a" }),
        };

        IReadOnlyList<string> owed = FailedDependents.Compute(
            graph,
            failed: new[] { "fails" },
            stateOf: node => node == "fails" ? "Failed" : "Pending");

        owed.Should().BeEmpty("nothing depends on the failed node");
    }

    [Fact]
    public void NodesThatAlreadyFinishedAreNotRewritten()
    {
        // A dependency that succeeded before the failure must keep its result.
        IReadOnlyList<string> owed = FailedDependents.Compute(
            Graph,
            failed: new[] { "exit_house" },
            stateOf: node => node switch
            {
                "exit_house" => "Failed",
                "walk_east" => "Succeeded",
                _ => "Pending",
            });

        owed.Should().NotContain("walk_east", "a terminal node is not pending work to skip");
    }

    [Fact]
    public void ACycleTerminatesInsteadOfRecursingForever()
    {
        var graph = new (string Node, string[] DependsOn)[]
        {
            ("a", new[] { "b" }),
            ("b", new[] { "a" }),
            ("c", new[] { "a" }),
        };

        IReadOnlyList<string> owed = FailedDependents.Compute(
            graph,
            failed: new[] { "a" },
            stateOf: node => node == "a" ? "Failed" : "Pending");

        owed.Should().BeEquivalentTo(new[] { "b", "c" });
    }
}
