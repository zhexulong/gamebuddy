using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace GameBuddy.Stardew.Core.Diagnostics;

/// <summary>
/// ONE dispatched node's game-thread cost, split by the Mod seams that run inside it, printed as one log line
/// when the node was expensive enough for a player to feel.
///
/// <para>
/// WHY THIS EXISTS. A hitch ("the game stutters when she breaks a stone") is a game-thread cost, and the Mod's
/// per-node numbers used to live only in the span trace: <c>mod.execute.&lt;action&gt;</c> said how long ONE
/// handler took, and nothing said whether that time was the admission gate, the reachability flood behind a
/// tool approach, or the native call itself. This meter answers that in the file the owner already reads - the
/// SMAPI log - instead of a trace they would have to open.
/// </para>
///
/// <para>
/// WHAT EACH NUMBER CONTAINS. <c>total_ms</c> is the node from its dispatch to its return, so it includes the
/// ledger bookkeeping the handler is called through. <c>dispatch_ms</c> is the handler's own call. The named
/// seams are INCLUSIVE and nest inside the handler - admission runs first, the approach leg runs after it, a
/// receipt's journal read and write after that - and each one is printed under its own name, so
/// <c>handler_rest_ms</c> (= dispatch − every named seam) is what no seam accounts for. A seam that is
/// <c>0.00</c> was not run by this node at all, which is how a gesture shows that it planned no walk.
/// </para>
///
/// <para>
/// ONE LINE PER NODE, AND ONLY WHEN IT COSTS SOMETHING. A node under half a frame cannot be the hitch a player
/// feels, so it prints nothing; the line exists to be read on the run where the hitch happened, not parsed out
/// of a megabyte of log.
/// </para>
///
/// <para>
/// THE NODE BELONGS TO THE THREAD. Every seam here runs on the game thread, and the bridge already refuses a
/// dispatch from any other, so the node in flight is thread state rather than a parameter threaded through five
/// types. A node dispatched from inside another (a program expanding a <c>for_each</c> into node dispatches) does
/// not open its own line: the outer node owns the cost and its line carries it.
/// </para>
/// </summary>
internal static class GameThreadCost
{
    /// <summary>The mechanical admission every executing action shares (<c>ExecutionAdmission.Admit</c>).</summary>
    internal const string AdmissionSeam = "admission";

    /// <summary>The shared tool-approach leg, which owns the reachability flood a walk is planned with.</summary>
    internal const string ApproachSeam = "approach";

    /// <summary>
    /// Reading the durable execution journal, which every operation reloads and validates in full
    /// (<c>FarmhandExecutionJournal.ReadValidatedState</c>): the payload read, its deserialization and the duplicate scan.
    /// </summary>
    internal const string JournalReadSeam = "journal_read";

    /// <summary>
    /// Writing the durable execution journal, which every operation rewrites in full through
    /// <c>IDataHelper.WriteGlobalData</c>: one serialize plus one whole-payload file write, on the calling thread.
    /// </summary>
    internal const string JournalWriteSeam = "journal_write";

    /// <summary>The native call itself (<c>Farmer.doEmote</c>), which is the gesture and nothing else.</summary>
    internal const string NativeSeam = "native";

    /// <summary>The world reading a receipt is published with (<c>ExecutionManager.CreateLocalObservation</c>).</summary>
    internal const string ObservationSeam = "observation";

    /// <summary>
    /// Half a frame at 60 fps. A node cheaper than this cannot be the hitch a player feels, so it is not a line;
    /// the number is a frame budget rather than a taste, and it is why the log stays a list of suspects.
    /// </summary>
    private const double ReportThresholdMs = 8d;

    [ThreadStatic]
    private static Dispatch? current;

    [ThreadStatic]
    private static string? nodeLabel;

    /// <summary>
    /// Where the line goes. The Mod installs its monitor here at startup; it stays null in every test that does
    /// not ask for a line, which is what keeps the suite off the log.
    /// </summary>
    internal static Action<string>? Report { get; set; }

    /// <summary>
    /// The node a dispatch belongs to, for the duration of one dispatch: <c>&lt;programId&gt;/&lt;nodeId&gt;</c>, the same
    /// pair the body-program journal names an execution by. Nothing downstream of admission carries it, so it is offered
    /// by the one caller that holds it (<c>RouteReenteringBodyProgramExecutor</c>) and read when the line is opened; a
    /// dispatch that arrives from the bridge has no node and says <c>node=none</c> rather than pretending.
    /// </summary>
    internal readonly struct NodeScope : IDisposable
    {
        private readonly string? previous;

        internal NodeScope(string label)
        {
            this.previous = nodeLabel;
            nodeLabel = label;
        }

        public void Dispose() => nodeLabel = this.previous;
    }

    /// <summary>
    /// Opens the node a dispatch is about to route, or answers null when one is already open on this thread (in
    /// which case the outer node owns the cost and this dispatch must not close it).
    /// </summary>
    internal static long? BeginDispatch(string actionId, string requestId)
    {
        if (current is not null)
            return null;
        current = new Dispatch(actionId, requestId, nodeLabel);
        return Stopwatch.GetTimestamp();
    }

    /// <summary>Closes the node <paramref name="started"/> opened, printing its line when it was expensive.</summary>
    internal static void EndDispatch(long? started)
    {
        if (started is null)
            return;
        Dispatch? dispatch = current;
        current = null;
        if (dispatch is null)
            return;
        double totalMs = ElapsedMs(started.Value);
        if (totalMs < ReportThresholdMs)
            return;
        Report?.Invoke(dispatch.Describe(totalMs));
    }

    /// <summary>
    /// The timestamp a seam starts at, or 0 when no node is open - in which case
    /// <see cref="NoteSeam"/> and <see cref="NoteFlood"/> have nothing to attribute and do nothing.
    /// </summary>
    internal static long BeginSeam() => current is null ? 0 : Stopwatch.GetTimestamp();

    /// <summary>Attributes everything since <paramref name="started"/> to the handler's own call.</summary>
    internal static void NoteDispatch(long started)
    {
        Dispatch? dispatch = current;
        if (dispatch is null || started == 0)
            return;
        dispatch.AddDispatch(ElapsedMs(started));
    }

    /// <summary>Attributes everything since <paramref name="started"/> to <paramref name="seam"/>.</summary>
    internal static void NoteSeam(string seam, long started)
    {
        Dispatch? dispatch = current;
        if (dispatch is null || started == 0)
            return;
        dispatch.AddSeam(seam, ElapsedMs(started));
    }

    /// <summary>
    /// Attributes one reachability flood: how long it took and how many tiles it admitted to the component. A
    /// flood that abandoned its budget has no component, so the caller passes the ceiling it stopped at - the
    /// number of tiles it examined, which is the cost.
    /// </summary>
    internal static void NoteFlood(long started, int tiles)
    {
        Dispatch? dispatch = current;
        if (dispatch is null || started == 0)
            return;
        dispatch.AddFlood(ElapsedMs(started), tiles);
    }

    /// <summary>The receipt the node minted, so the line names the outcome it paid for.</summary>
    internal static void NoteOutcome(string state, string reasonCode)
    {
        Dispatch? dispatch = current;
        if (dispatch is null)
            return;
        dispatch.State = state;
        dispatch.ReasonCode = reasonCode;
    }

    /// <summary>
    /// A scope over one seam, for a method that answers from several places: the <c>using</c> disposes on every exit
    /// path, so the seam is measured once without editing the body it measures.
    /// </summary>
    internal readonly struct SeamScope : IDisposable
    {
        private readonly string seam;
        private readonly long started;

        internal SeamScope(string seam)
        {
            this.seam = seam;
            this.started = BeginSeam();
        }

        public void Dispose() => NoteSeam(this.seam, this.started);
    }

    private static double ElapsedMs(long started) =>
        (Stopwatch.GetTimestamp() - started) * 1000d / Stopwatch.Frequency;

    /// <summary>One node in flight on the game thread, and the seams it has paid for so far.</summary>
    private sealed class Dispatch
    {
        private readonly string actionId;
        private readonly string requestId;
        private readonly string node;
        private readonly List<(string Seam, double Ms)> seams = new();
        private double dispatchMs;
        private double floodMs;
        private long floodTiles;
        private int floods;

        internal Dispatch(string actionId, string requestId, string? node)
        {
            this.actionId = actionId;
            this.requestId = requestId;
            this.node = node ?? "none";
        }

        internal string State { get; set; } = "unknown";

        internal string ReasonCode { get; set; } = "unknown";

        /// <summary>
        /// Adds <paramref name="elapsedMs"/> to the named seam, keeping the order the seams were first measured in so the
        /// line reads the way the dispatch ran. A seam measured twice in one node (two journal reads, an attempt and a
        /// retry) is SUMMED: the line answers "what did this seam cost", never "what did one call of it cost".
        /// </summary>
        internal void AddSeam(string seam, double elapsedMs)
        {
            for (int index = 0; index < this.seams.Count; index++)
            {
                if (string.Equals(this.seams[index].Seam, seam, StringComparison.Ordinal))
                {
                    this.seams[index] = (seam, this.seams[index].Ms + elapsedMs);
                    return;
                }
            }

            this.seams.Add((seam, elapsedMs));
        }

        private double SeamMs(string seam) =>
            this.seams.Where(row => string.Equals(row.Seam, seam, StringComparison.Ordinal)).Sum(row => row.Ms);

        /// <summary>The named seams that are not one of the two the line keeps in fixed positions.</summary>
        private IEnumerable<(string Seam, double Ms)> OtherSeams() =>
            this.seams.Where(row => !string.Equals(row.Seam, AdmissionSeam, StringComparison.Ordinal)
                && !string.Equals(row.Seam, ApproachSeam, StringComparison.Ordinal));

        internal void AddDispatch(double elapsedMs) => this.dispatchMs += elapsedMs;

        internal void AddFlood(double elapsedMs, int tiles)
        {
            this.floods++;
            this.floodMs += elapsedMs;
            this.floodTiles += tiles;
        }

        /// <summary>
        /// The one line: `;`-separated like every other Mod line, with every duration in milliseconds. The
        /// free field (<c>handler_rest_ms</c>) can only be arithmetic on measured values, so it is clamped at zero
        /// rather than allowed to print a negative remainder the stopwatch cannot mean.
        /// </summary>
        internal string Describe(double totalMs)
        {
            double rest = Math.Max(0d, this.dispatchMs - this.seams.Sum(row => row.Ms));
            StringBuilder line = new StringBuilder()
                .Append("[game-thread-cost]")
                .Append($" action={this.actionId}")
                .Append($";node={this.node}")
                .Append($";request={this.requestId}")
                .Append($";total_ms={Ms(totalMs)}")
                .Append($";dispatch_ms={Ms(this.dispatchMs)}")
                .Append($";admission_ms={Ms(this.SeamMs(AdmissionSeam))}")
                .Append($";approach_ms={Ms(this.SeamMs(ApproachSeam))}")
                .Append($";handler_rest_ms={Ms(rest)}");
            foreach ((string seam, double elapsedMs) in this.OtherSeams())
                line.Append($";{seam}_ms={Ms(elapsedMs)}");
            return line
                .Append($";floods={this.floods.ToString(CultureInfo.InvariantCulture)}")
                .Append($";flood_ms={Ms(this.floodMs)}")
                .Append($";flood_tiles={this.floodTiles.ToString(CultureInfo.InvariantCulture)}")
                .Append($";state={this.State}")
                .Append($";reason={this.ReasonCode}")
                .ToString();
        }

        private static string Ms(double value) => value.ToString("0.00", CultureInfo.InvariantCulture);
    }
}
