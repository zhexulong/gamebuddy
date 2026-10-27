using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A published target list is a WALKING ORDER, and the discovery functions were taking it from a Dictionary.
///
/// Measured 2026-10-27, an independent audit of the chain-fixed run: the Agent received `rockSourceTargets` in
/// hash-bucket order and walked them in that order, crossing the farm between consecutive targets. The
/// chain-nearest-neighbour work (`cf9cff80`) was meant to prevent exactly that, but it lives in
/// `synthesizePrograms`, which has NO production caller - the Agent uses `stardew_plan_work` and reads these
/// published targets directly.
///
/// SCOPE, stated plainly: this reads the discovery source, because the ordering happens before the cap inside a
/// `private static` method that needs a live `GameLocation` and a real `Farmer`. What it can prove is the defect
/// that existed - a dictionary enumeration reaching a `Take` without passing through the ordering helper - and it
/// names each remaining place so the next one is not discovered by a live run.
/// </summary>
public sealed class TargetPublicationOrderTests
{
    private static readonly string[] WalkingOrderDiscoveries =
    {
        "DiscoverRockSourceTargets",
        "DiscoverWeedTargets",
        "DiscoverClearHoeDirtTargets",
        "DiscoverCropTargets",
        "DiscoverHarvestTargets",
        "DiscoverForageTargets",
        "DiscoverTreeChopSourceTargets",
        "DiscoverTreeStumpTargets",
    };

    // THE REST OF THE DISCOVERY LAYER IS DELIBERATELY ABSENT, and this is the record of the survey that decided
    // it, so the next audit does not re-litigate them. The line between the two groups is whether the Agent
    // FILTERS the list before acting:
    //
    //   walking order - every published member is already eligible (the `Where` above the `Take` selected them)
    //                   and the action's arguments have the same shape for all of them, so the list is a work
    //                   queue and the Agent dispatches one action per member in the order it received them;
    //   set membership - which member to touch is decided by that member's own published state, so the Agent
    //                   reads the list as a set and picks one, and the order it arrived in is never a route.
    //
    // Set membership, left alone on purpose:
    //   DiscoverMachineTargets        `loadInputSlot` / `collectOutputReady` / `minutesUntilReady` decide which
    //                                 keg, so `machine_load` and `machine_collect_output` copy their arguments
    //                                 from one chosen entry; the others are alternatives, not a queue.
    //   DiscoverPetTargets            `stationary` + `pettedToday` decide (protocol.ts: "a wandering pet will not
    //                                 be where it was when you observed it"); petting is once per pet per day.
    //   DiscoverSiloTargets           the silo the actor is standing at; `hay` is the reading, not a target rank.
    //   DiscoverMannequinTargets      one decorated object the Agent walks up to, and `dress_mannequin` needs the
    //                                 matching wearable slot for that object.
    //   DiscoverSignTargets           same shape: `hasDisplayItem` decides, and the item slot is the Agent's own.
    //   DiscoverTreeChopResultTargets no action consumes this list at all - it is the postcondition readback of a
    //                                 chop-tree-source strike (`treeChopSourceTargets 1->0`, result `0->1`), so its
    //                                 order cannot become a walk.

    [Fact]
    public void EveryWalkingOrderListIsOrderedBeforeItIsCapped()
    {
        string source = Source();
        var unordered = new List<string>();

        foreach (string name in WalkingOrderDiscoveries)
        {
            // The DEFINITION is `private static IReadOnlyList<BridgeX> Name(`; call sites are bare `Name(`. Anchoring
            // on the full signature avoids the call-site trap that made an earlier version read a lambda body.
            Match definition = Regex.Match(source, @"private static IReadOnlyList<Bridge\w+> " + name + @"\(");
            definition.Success.Should().BeTrue($"{name} must be defined");

            string body = BracedBody(source, definition.Index);
            if (!body.Contains("NearestFirst(", StringComparison.Ordinal)) unordered.Add(name);
        }

        unordered.Should().BeEmpty(
            "a dictionary-backed target list is walked in published order, so hash order must not reach the caller");
    }

    [Fact]
    public void TheSharedHelperSortsByDistanceThenBreaksTies()
    {
        string source = Source();
        int start = source.IndexOf("NearestFirst<T>", StringComparison.Ordinal);
        start.Should().BeGreaterThan(0, "the shared ordering helper must exist");

        // The helper is EXPRESSION-BODIED (`=> ...;`), not brace-bodied, so the body runs from the `=>` to the next
        // semicolon. Reading braces here found the method AFTER it - which is how an earlier version asserted against
        // `IsDiggableSoilTile`.
        int arrow = source.IndexOf("=>", start, StringComparison.Ordinal);
        arrow.Should().BeGreaterThan(start, "the helper must be an expression-bodied member");
        int semicolon = source.IndexOf(';', arrow);
        string helper = source.Substring(arrow, semicolon - arrow + 1);

        helper.Should().Contain("ChebyshevDistance(");
        helper.Should().Contain("ThenBy(pair => pair.Key.X)");
        helper.Should().Contain("ThenBy(pair => pair.Key.Y)",
            "two equidistant targets must not swap between runs, or a run-to-run diff measures the dictionary");
    }

    /// <summary>The text from the next `{` after <paramref name="from"/> through its matching `}`.</summary>
    private static string BracedBody(string source, int from)
    {
        int brace = source.IndexOf('{', from);
        brace.Should().BeGreaterThan(from, "a method body must follow its signature");
        int depth = 0;
        for (int index = brace; index < source.Length; index += 1)
        {
            if (source[index] == '{') depth += 1;
            else if (source[index] == '}')
            {
                depth -= 1;
                if (depth == 0) return source.Substring(brace, index - brace + 1);
            }
        }

        throw new InvalidOperationException("unbalanced braces");
    }

    private static string Source() => System.IO.File.ReadAllText(RepositoryFile());

    private static string RepositoryFile()
    {
        var directory = new System.IO.DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !System.IO.Directory.Exists(System.IO.Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return System.IO.Path.Combine(directory!.FullName, "integrations/stardew/farmhandexecutioncontroller.cs");
    }
}
