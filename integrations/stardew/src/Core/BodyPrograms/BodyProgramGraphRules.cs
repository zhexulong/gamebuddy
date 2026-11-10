namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>
/// One node of a Body Program graph, as every rule in <see cref="BodyProgramGraphRules"/> reads it: who must go first, and
/// what resources it claims while it runs.
///
/// <para>
/// The rules below never read a wire candidate, a verified program or a journal program directly - those are three
/// projections of the SAME graph, and a rule written against any one of them is a rule the other two cannot share. The
/// projectors at the top of the rules class are the only place a concrete shape is read.
/// </para>
/// <para>
/// <see cref="OrderedAfter"/> is the second edge: a node must not start before these predecessors are terminal, and is not
/// skipped when one of them fails. It is projected from the wire candidate and from the durable record, which are the only
/// two places a graph is read from.
/// </para>
/// </summary>
internal sealed record BodyProgramGraphNode(
    string NodeId,
    IReadOnlyList<string> DependsOn,
    IReadOnlyList<string> OrderedAfter,
    IReadOnlyCollection<string> ClaimKeys);

/// <summary>
/// The rules a Body Program graph obeys, declared once and read by every surface that has to decide them: the design-time
/// verifier for a wire candidate, the journal validator for every document it persists or reopens, and the authority's
/// pump and state recomputation.
///
/// <para>
/// Why one home: the claim-ordering rule existed twice - once in <c>BodyProgramVerifier</c> and once in
/// <c>BodyProgramJournalPersistence</c> - and the two copies had already drifted in what they REPORTED for the same
/// violation, the verifier naming the action and the node and the journal naming neither while
/// <c>MatchesCatalogProgram</c> ran on every persist. <c>BodyProgramGraphRulesTests</c> drives both readers with one graph
/// precisely so a reader that stops calling these rules stops agreeing with the other.
/// </para>
/// </summary>
internal static class BodyProgramGraphRules
{
    /// <summary>The graph of a wire candidate. Claims come from the descriptor's resource template, which is what a candidate is judged against.</summary>
    internal static IReadOnlyList<BodyProgramGraphNode> FromCandidates(IReadOnlyDictionary<string, ActionProgramCandidateNode> nodes, BodyProgramActionCatalog catalog) =>
        Array.AsReadOnly(nodes.Values.Select(node => new BodyProgramGraphNode(
            node.NodeId,
            node.DependsOn,
            node.OrderedAfter,
            catalog.TryGetAction(node.ActionId, out BodyProgramActionDescriptor? action)
                ? Array.AsReadOnly(action!.ResourceTemplate.Select(claim => claim.Key).ToArray())
                : Array.Empty<string>())).ToArray());

    /// <summary>The graph of a verified program. Claims are the ones already derived and frozen into the record.</summary>
    internal static IReadOnlyList<BodyProgramGraphNode> FromVerified(VerifiedBodyProgram program) =>
        Array.AsReadOnly(program.Nodes.Select(node => new BodyProgramGraphNode(
            node.NodeId,
            node.DependsOn,
            node.OrderedAfter,
            Array.AsReadOnly(node.DerivedResourceClaims.Keys.ToArray()))).ToArray());

    /// <summary>The graph of a durable journal program - the same nodes a verified program carries.</summary>
    internal static IReadOnlyList<BodyProgramGraphNode> FromJournalNodes(BodyProgramJournalProgram program) => FromVerified(program.Program);

    /// <summary>The durable state of each node, which the eligibility and work rules read beside the graph.</summary>
    internal static IReadOnlyDictionary<string, BodyProgramNodeState> StatesOf(BodyProgramJournalProgram program) =>
        program.Nodes.ToDictionary(node => node.NodeId, node => node.State, StringComparer.Ordinal);

    /// <summary>
    /// May <paramref name="fromNodeId"/> reach <paramref name="toNodeId"/> through the graph - a dependency edge or an
    /// ordering-only one? This is the question "are these two nodes ordered at all", never "will one skip the other".
    /// </summary>
    internal static bool OrderedTransitively(IReadOnlyList<BodyProgramGraphNode> graph, string fromNodeId, string toNodeId)
    {
        Dictionary<string, BodyProgramGraphNode> nodes = ById(graph);
        if (!nodes.ContainsKey(fromNodeId)) return false;
        HashSet<string> visited = new(StringComparer.Ordinal);
        bool Visit(string nodeId) => visited.Add(nodeId)
            && Predecessors(nodes[nodeId]).Any(predecessor => predecessor == toNodeId || (nodes.ContainsKey(predecessor) && Visit(predecessor)));
        return Visit(fromNodeId);
    }

    /// <summary>Does any node reach itself? An unknown predecessor is not an edge, so it cannot be a cycle either.</summary>
    internal static bool HasCycle(IReadOnlyList<BodyProgramGraphNode> graph)
    {
        Dictionary<string, BodyProgramGraphNode> nodes = ById(graph);
        HashSet<string> done = new(StringComparer.Ordinal), active = new(StringComparer.Ordinal);
        bool Visit(string nodeId)
        {
            if (!done.Add(nodeId)) return active.Contains(nodeId);
            active.Add(nodeId);
            bool cycle = Predecessors(nodes[nodeId]).Any(predecessor => nodes.ContainsKey(predecessor) && Visit(predecessor));
            active.Remove(nodeId);
            return cycle;
        }
        return nodes.Keys.Any(Visit);
    }

    /// <summary>
    /// Every pair of nodes that claim a shared resource without being ordered either way, as (first, second) in graph
    /// order. Pairs rather than a bool because the two readers state the answer differently: the verifier refuses the
    /// candidate naming the second node's action, and the journal refuses the document naming the same node.
    /// </summary>
    internal static IReadOnlyList<(BodyProgramGraphNode First, BodyProgramGraphNode Second)> UnorderedClaimPairs(IReadOnlyList<BodyProgramGraphNode> graph)
    {
        List<(BodyProgramGraphNode First, BodyProgramGraphNode Second)> pairs = new();
        for (int index = 0; index < graph.Count; index++)
            for (int other = index + 1; other < graph.Count; other++)
                if (graph[index].ClaimKeys.Intersect(graph[other].ClaimKeys, StringComparer.Ordinal).Any()
                    && !OrderedTransitively(graph, graph[index].NodeId, graph[other].NodeId)
                    && !OrderedTransitively(graph, graph[other].NodeId, graph[index].NodeId))
                    pairs.Add((graph[index], graph[other]));
        return pairs;
    }

    /// <summary>
    /// May this node start now? Every dependency succeeded - a dependency is a consumption edge, so its fact must exist -
    /// and every ordering-only predecessor is at least terminal, which does not require it to have succeeded.
    /// </summary>
    internal static bool EligibleToStart(IReadOnlyList<BodyProgramGraphNode> graph, IReadOnlyDictionary<string, BodyProgramNodeState> states, string nodeId)
    {
        Dictionary<string, BodyProgramGraphNode> nodes = ById(graph);
        return nodes.TryGetValue(nodeId, out BodyProgramGraphNode? node)
            && DependenciesSatisfied(node, states) && OrderedAfterReached(node, states);
    }

    /// <summary>
    /// Does this program still have something to do? A program that answers no is finished, and every reader of the answer
    /// must agree: the authority recomputes the program's state with it, and the journal refuses an `Active` program whose
    /// nodes say otherwise.
    /// </summary>
    internal static bool HasExecutableWork(IReadOnlyList<BodyProgramGraphNode> graph, IReadOnlyDictionary<string, BodyProgramNodeState> states)
    {
        if (states.Values.Any(state => state is BodyProgramNodeState.AwaitingHostAdmission or BodyProgramNodeState.HostAdmitted or BodyProgramNodeState.Running)) return true;
        Dictionary<string, BodyProgramGraphNode> nodes = ById(graph);
        return nodes.Values.Any(node => states[node.NodeId] == BodyProgramNodeState.Pending
            && DependenciesSatisfied(node, states) && OrderedAfterReached(node, states));
    }

    /// <summary>
    /// The states after which a node will never act again. Terminal is not "succeeded": a failed, partial or vetoed
    /// predecessor has settled whatever it was going to be, and a successor may start after it once its dependencies
    /// allow it.
    ///
    /// <para>
    /// `PartiallySucceeded` MUST be here, and it is the whole reason a pass can be reported honestly: an ordering-only
    /// successor of a 58-of-60 pass starts, because the pass is over. A CONSUMING successor still cannot start - its
    /// fact does not exist - but `DependenciesSatisfied` says that, and the journal settles it `SkippedDependency`
    /// instead of leaving it Pending.
    /// </para>
    /// </summary>
    internal static bool IsTerminal(BodyProgramNodeState state) => state is BodyProgramNodeState.Succeeded or BodyProgramNodeState.Failed
        or BodyProgramNodeState.PartiallySucceeded or BodyProgramNodeState.Cancelled or BodyProgramNodeState.Rejected
        or BodyProgramNodeState.SkippedDependency or BodyProgramNodeState.Abandoned;

    private static bool DependenciesSatisfied(BodyProgramGraphNode node, IReadOnlyDictionary<string, BodyProgramNodeState> states) =>
        node.DependsOn.All(dependency => states[dependency] == BodyProgramNodeState.Succeeded);

    private static bool OrderedAfterReached(BodyProgramGraphNode node, IReadOnlyDictionary<string, BodyProgramNodeState> states) =>
        node.OrderedAfter.All(predecessor => IsTerminal(states[predecessor]));

    private static IEnumerable<string> Predecessors(BodyProgramGraphNode node) => node.DependsOn.Concat(node.OrderedAfter);

    private static Dictionary<string, BodyProgramGraphNode> ById(IReadOnlyList<BodyProgramGraphNode> graph) =>
        new(graph.ToDictionary(node => node.NodeId, StringComparer.Ordinal), StringComparer.Ordinal);
}
