using System;
using System.Collections.Generic;
using System.Linq;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// Which nodes a failure owes a terminal answer to.
///
/// The journal has two terminals for a node that did not succeed: `Rejected` (the Host refused admission)
/// and `Failed` (it was admitted and the native call did not land). `Rejected` computes the transitive
/// closure of its dependents and marks them `SkippedDependency`; `Failed` did not, so its dependents stayed
/// `Pending` for ever.
///
/// That is not a cosmetic difference. `HasExecutableWork` is "a Pending node whose DependsOn are all
/// Succeeded" - once the dependency failed, no such node exists, so the program recomputes to Failed with
/// unnamed Pending nodes still inside it. The persistence layer's own comment calls an abandoned program
/// still holding Pending work "the poison", and the live run of 2026-10-25 produced exactly that shape from
/// a single `door_out_of_range`.
///
/// This is the closure as a pure function, so the asymmetry can be closed and tested without a journal.
///
/// Only nodes the caller reports as Pending are owed a skip: a dependency that already succeeded keeps its
/// result, and a node already terminal is not pending work. Cycles cannot recurse away because the visited
/// set is updated before descending.
/// </summary>
public static class FailedDependents
{
    /// <summary>
    /// The nodes in <paramref name="graph"/> that depend - directly or through other dependents - on any
    /// node named in <paramref name="failed"/> and are still <c>Pending</c>.
    ///
    /// <paramref name="stateOf"/> is the caller's own read of each node's state, as a name, because the
    /// journal's enum lives in the Mod and this rule does not need to know it: what matters is which nodes
    /// are still waiting for work to start.
    /// </summary>
    public static IReadOnlyList<string> Compute(
        IReadOnlyList<(string Node, string[] DependsOn)> graph,
        IEnumerable<string> failed,
        Func<string, string> stateOf)
    {
        ArgumentNullException.ThrowIfNull(graph);
        ArgumentNullException.ThrowIfNull(failed);
        ArgumentNullException.ThrowIfNull(stateOf);

        var failedSet = new HashSet<string>(failed, StringComparer.Ordinal);

        // Every node reachable by following depends-on edges FORWARD from a failed node, i.e. the failure's
        // dependents. Seeded with the failed nodes themselves so a descendant of a descendant is found.
        var descendants = new HashSet<string>(StringComparer.Ordinal);
        bool changed;
        do
        {
            changed = false;
            foreach ((string node, string[] dependsOn) in graph)
            {
                if (descendants.Contains(node)) continue;
                if (!dependsOn.Any(dependency => failedSet.Contains(dependency) || descendants.Contains(dependency)))
                    continue;
                changed |= descendants.Add(node);
            }
        } while (changed);

        return graph
            .Select(entry => entry.Node)
            .Where(descendants.Contains)
            .Where(node => string.Equals(stateOf(node), "Pending", StringComparison.Ordinal))
            .OrderBy(node => node, StringComparer.Ordinal)
            .ToArray();
    }
}
