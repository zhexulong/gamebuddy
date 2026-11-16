using System.Globalization;
using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The launcher's companion switch could not be performed at all - it could not even
/// determine the state it would be switching from. This is deliberately not the same event
/// as a refused request: a refusal is a switch that did not happen in a state the launcher
/// understood, while this is a state it does not, and a launch that cannot read its own data
/// root must not pretend it did.
/// </summary>
internal sealed class CompanionSwitchUnavailableException : Exception
{
    internal CompanionSwitchUnavailableException(Exception innerException)
        : base("GameBuddy companion switch state is unavailable.", innerException)
    {
    }
}

/// <summary>
/// One companion whose semantic authority root is set aside: everything the launcher needs
/// to put her back exactly as she was. The five identity values are the ones her authority
/// was created with, so restoring them leaves the Host's marker and bootstrap row matching
/// instead of refusing the root as belonging to another identity.
/// </summary>
internal sealed record ParkedCompanion(
    string CompanionId,
    string ContinuityId,
    string PlayerId,
    string BootstrapOperationId,
    int AuthorityGeneration,
    string DirectoryName);

/// <summary>The one step a fault can be injected at, for the rollback test.</summary>
internal enum CompanionSwitchStep
{
    TargetRootMove,
}

internal enum CompanionSwitchStatus
{
    /// <summary>Nothing was asked for, or the request was already applied.</summary>
    None,

    /// <summary>The installation now plays the requested companion.</summary>
    Switched,

    /// <summary>The request was not applied, and the companion that was in play still is.</summary>
    Refused,
}

/// <summary>
/// Whether a refusal is the answer to a state or to a moment in it, and therefore whether the
/// player still has to do anything.
///
/// The distinction is not a severity: it is whether spending the request is honest. A
/// <see cref="Permanent"/> refusal says the state itself is the reason, so the same request
/// would be refused identically by every later launch - keeping it would be a promise the
/// launcher cannot keep, and the player has to be told what to do instead. A
/// <see cref="Transient"/> refusal says the reason is a moment the next launch is outside of (a
/// Host that is still leaving, a name this second already holds), so the request is still the
/// player's live choice and must not be spent on it: keeping it makes the next launch apply it
/// without the player having to ask again.
/// </summary>
internal enum CompanionSwitchRefusalLifetime
{
    /// <summary>The state itself refuses: the request is spent and a human has to act.</summary>
    Permanent,

    /// <summary>The moment refuses: the request is kept, and the next launch applies it.</summary>
    Transient,
}

/// <summary>
/// One switch's bounded outcome. <see cref="Code"/> is the named refusal a refusal reports
/// and is null on every other status, so a caller can never read a code off a success.
/// <see cref="TargetCompanionId"/> is the companion the switch was about and
/// <see cref="ActiveCompanionId"/> the one who is still in play, so a caller that records a
/// refusal can name both: the target is the only part of the request a spent request no longer
/// carries.
/// <see cref="Lifetime"/> says whether that request was spent, and is null on every other status
/// for the same reason <see cref="Code"/> is: a caller may not read a refusal off a success.
/// </summary>
internal readonly record struct CompanionSwitchOutcome(
    CompanionSwitchStatus Status,
    string? Code,
    string? ActiveCompanionId,
    string? TargetCompanionId,
    CompanionSwitchRefusalLifetime? Lifetime);

/// <summary>
/// Which companion this installation plays, as the launcher changes it at the next launch.
///
/// **Why a switch is a park-and-restore and not an edit.** The companion in play is
/// <c>principal.companionId</c> of the deployment identity, and the Host binds the semantic
/// authority's database to exactly that principal: <c>production_bootstrap.companion_id</c>,
/// <c>production_partition.companion_id</c> and the authority marker must all match it or
/// the Host refuses the root with <c>production_store_identity_mismatch</c>. So the identity
/// cannot simply be repointed - the authority root it was created for has to move with it.
/// Everything else already partitions per companion by itself: <c>contexts/&lt;identityKey&gt;</c>,
/// <c>tavern/v1</c> companion roots and each companion's Magic Context store ALL hang off
/// <c>identityKey(playerId, companionId, continuityId)</c>, so a second companion's records
/// sit beside the first's and are never touched by a switch. The authority root is therefore
/// the ONE thing that has to be set aside, and setting it aside reversibly is what makes the
/// whole operation reversible.
///
/// **Why it is reversible.** <see cref="ApplyPending"/> parks the authority root under a
/// directory that names the companion and the moment, and writes the five identity values
/// that root was created with beside it. Switching back moves that directory into the active
/// position and restores those same values verbatim, so the marker, the bootstrap row and
/// her Chat, Memory and cabin binding are exactly what they were.
///
/// **Why the ordering is the guarantee.** Ordered steps 4-8 below are the whole fail-closed
/// argument: the parked index entry is written BEFORE the move it describes, the derived
/// projection is removed before the identity changes, the identity record changes before the
/// target's root is moved in, and the request is deleted last. Each crash window between them
/// therefore leaves a state <see cref="Reconcile"/> can finish or undo from facts the
/// launcher already owns, and the identity record - which is what every later step reads - is
/// written atomically.
///
/// **What this deliberately is not.** It is not a Host write. The Host only states which
/// companion it was playing and which one the player chose; the operation identifier a new
/// baseline needs, the moves, and the identity record are the launcher's, because
/// <see cref="DeploymentIdentity"/> is the identity's one authority.
/// </summary>
internal static class CompanionSwitch
{
    /// <summary>
    /// The one file the Host writes and the launcher consumes. It sits beside the deployment
    /// identity record it is about, so the two are read and repaired together.
    /// </summary>
    internal const string RequestFileName = "companion-switch-request.json";

    internal const string RequestSchema = "gamebuddy-companion-switch-request/v1";

    /// <summary>
    /// The directory that holds every set-aside authority root, and the index that names the
    /// companion each one belongs to. The index is a separate file rather than a record inside
    /// each parked root: a parked root has to stay byte-identical to what the Host wrote, and
    /// the Host accepts only its own two files there.
    /// </summary>
    internal const string ParkedDirectoryName = "parked-companions";

    internal const string ParkedIndexFileName = "index.json";

    internal const string ParkedIndexSchema = "gamebuddy-parked-companions/v1";

    private const string StatusRequested = "requested";

    // The bounded identifier shape the manifest schema, the semantic store and the authority
    // marker all enforce. A request that carries anything else can never name a companion.
    private static readonly System.Text.RegularExpressions.Regex Identifier =
        new("^[A-Za-z0-9_-]{1,128}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>Nominal UTC, fixed width, so the parked names sort by when they were set aside.</summary>
    private const string ParkedStampFormat = "yyyyMMdd'T'HHmmss'Z'";

    /// <summary>
    /// How long the switch waits for the Host that was running before it to finish leaving,
    /// before it refuses to touch the authority at all.
    ///
    /// It is a ceiling and not a schedule: the wait ends the moment the files can be opened, and
    /// a Host that was killed a moment before this launch is normally gone well within it. A Host
    /// that is not gone inside it is one no honest rename can be built on.
    /// </summary>
    private static readonly TimeSpan HostReclaimCeiling = TimeSpan.FromSeconds(5);

    /// <summary>How often the wait above asks whether the Host has left.</summary>
    private static readonly TimeSpan HostReclaimInterval = TimeSpan.FromMilliseconds(100);

    internal static string RequestPath(CurrentUserRootLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        return Path.Combine(layout.DataRoot, RequestFileName);
    }

    internal static string ParkedDirectoryPath(CurrentUserRootLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        return Path.Combine(layout.DataRoot, ParkedDirectoryName);
    }

    internal static string ParkedRootPath(CurrentUserRootLayout layout, string directoryName)
    {
        ArgumentNullException.ThrowIfNull(layout);
        return Path.Combine(ParkedDirectoryPath(layout), directoryName);
    }

    internal static string ParkedIndexPath(CurrentUserRootLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        return Path.Combine(ParkedDirectoryPath(layout), ParkedIndexFileName);
    }

    internal static bool HasPendingRequest(CurrentUserRootLayout layout) => File.Exists(RequestPath(layout));

    /// <summary>
    /// The companions this installation has set aside, as the index records them.
    ///
    /// The index is the truth about who was parked, and it is deliberately NOT filtered by
    /// whether the directory happens to be there: an entry whose root is missing is a real
    /// inconsistency, and a reader that silently dropped it would report the companion as one
    /// who has never played - which is the one wrong answer, because acting on it would mint a
    /// new baseline over data the product promised to bring back.
    /// </summary>
    internal static IReadOnlyList<ParkedCompanion> ReadParked(CurrentUserRootLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        return ReadParkedIndex(layout);
    }

    internal static CompanionSwitchOutcome ApplyPending(CurrentUserRootLayout layout) =>
        ApplyPending(layout, DateTimeOffset.UtcNow, null, HostReclaimCeiling);

    /// <summary>
    /// Runs a switch with a fault injected at one named step. The launcher never passes this:
    /// it exists so the rollback path - which is the whole fail-closed claim - is exercised at
    /// the step where it matters instead of only in front of the first mutation.
    /// </summary>
    internal static CompanionSwitchOutcome ApplyPendingForTesting(
        CurrentUserRootLayout layout,
        DateTimeOffset now,
        Action<CompanionSwitchStep> fault,
        TimeSpan? hostReclaimCeiling = null) =>
        ApplyPending(layout, now, fault, hostReclaimCeiling ?? HostReclaimCeiling);

    /// <summary>
    /// Applies the pending switch, if there is one, and returns what happened. The clock is a
    /// parameter because the parked directory's name records the moment, and a name that
    /// cannot be asserted is a name nothing can be checked against.
    /// </summary>
    private static CompanionSwitchOutcome ApplyPending(
        CurrentUserRootLayout layout,
        DateTimeOffset now,
        Action<CompanionSwitchStep>? fault,
        TimeSpan hostReclaimCeiling)
    {
        ArgumentNullException.ThrowIfNull(layout);

        // A switch that died between two moves is finished or undone from the same facts a
        // switch that never started would use, so this runs on every launch and not only when
        // a request exists.
        Reconcile(layout);

        if (!HasPendingRequest(layout)) return new CompanionSwitchOutcome(CompanionSwitchStatus.None, null, null, null, null);

        var request = ReadRequest(layout);
        if (request is null)
        {
            // A request this launcher cannot read is not a switch: it is a malformed record. It is
            // spent here, and a record that could not be removed is answered the same way by every
            // later launch until it can be - a refusal that repeats is still the honest answer, and
            // it is the only one this launcher has.
            TryDiscardRequest(layout);
            return new CompanionSwitchOutcome(CompanionSwitchStatus.Refused, "companion_switch_record_unreadable", null, null, CompanionSwitchRefusalLifetime.Permanent);
        }

        var active = DeploymentIdentity.ReadActive(layout);
        var wanted = request.Value;

        // The request was already applied (the crash window between the identity record and
        // the target's move, which Reconcile finished). Reporting a stale refusal here would
        // tell the player the switch did not happen while she is already in play.
        if (StringComparer.Ordinal.Equals(active.CompanionId, wanted.TargetCompanionId))
        {
            TryDiscardRequest(layout);
            return new CompanionSwitchOutcome(CompanionSwitchStatus.Switched, null, active.CompanionId, active.CompanionId, null);
        }

        // The compare-and-set the surface read. Somebody else changed the installation
        // between the player's choice and this launch, so this request is about a companion
        // who is no longer the one being replaced.
        if (!StringComparer.Ordinal.Equals(active.CompanionId, wanted.ExpectedActiveCompanionId))
        {
            TryDiscardRequest(layout);
            return new CompanionSwitchOutcome(CompanionSwitchStatus.Refused, "companion_switch_request_stale", active.CompanionId, wanted.TargetCompanionId, CompanionSwitchRefusalLifetime.Permanent);
        }

        return Switch(layout, active, wanted, now, fault, hostReclaimCeiling);
    }

    private static CompanionSwitchOutcome Switch(
        CurrentUserRootLayout layout,
        DeploymentIdentityValues active,
        SwitchRequest request,
        DateTimeOffset now,
        Action<CompanionSwitchStep>? fault,
        TimeSpan hostReclaimCeiling)
    {
        var parked = ReadParked(layout);
        var target = parked.FirstOrDefault(entry => StringComparer.Ordinal.Equals(entry.CompanionId, request.TargetCompanionId));

        var activeRoot = ProductionAuthority.DirectoryPath(layout);
        var activeRootExists = Directory.Exists(activeRoot);
        var targetRoot = target is null ? null : ParkedRootPath(layout, target.DirectoryName);
        if (targetRoot is not null && !Directory.Exists(targetRoot))
            return Refuse(layout, request, "companion_switch_unavailable", CompanionSwitchRefusalLifetime.Permanent);

        // A parked root is only a companion who can come back when it is an authority the Host
        // will open. The Host publishes a root by writing the completion marker LAST, so a root
        // that never reached it is not an authority - it is the leftover of a first launch that
        // died - and moving it into the mount position would hand it to the session-mode
        // decision, which reads an absent marker as "establish this one". `fresh` is the one
        // mount that DISCARDS a leftover root, and the launcher must never be the one who asks
        // for that on a root it parked itself. So the switch refuses by name, before it renames
        // anything, and both roots stay exactly where they are.
        if (targetRoot is not null && !ProductionAuthority.IsCompleteIn(targetRoot))
            return Refuse(layout, request, "companion_switch_target_authority_incomplete", CompanionSwitchRefusalLifetime.Permanent);

        var parkedName = ParkedDirectoryNameFor(now, active.CompanionId);
        if (Directory.Exists(ParkedRootPath(layout, parkedName)))
            return Refuse(layout, request, "companion_switch_unavailable", CompanionSwitchRefusalLifetime.Transient);

        // The one predecessor this operation has is a Host that has left, and this is where it is
        // proved rather than assumed. A clean quit is already proof - closing the authenticated
        // broker is the child's controller EOF, and the launcher then waits for the child inside
        // the deadline the child itself published, terminating it only as the watchdog over that
        // wait (`RuntimeSupervisorLease.CloseAsync`). What that ordering cannot cover is the
        // launcher that was killed or crashed instead: the child notices the same EOF by itself
        // and leaves, but nothing bounds that against the next launch, and the app-instance mutex
        // serializes launchers rather than Hosts. A Host still holding the authority's files would
        // make the park below fail on a sharing violation, roll back and end the launch with a code
        // that says nothing about why - so the switch asks first, waits out a Host that is already
        // on its way, and refuses by name if one never leaves.
        if (activeRootExists && !AuthorityIsReleased(activeRoot, hostReclaimCeiling))
            return Refuse(layout, request, "companion_switch_host_still_running", CompanionSwitchRefusalLifetime.Transient);

        // The identity the target will carry. A companion coming back from a parked root gets
        // the values her authority was created with - anything else makes the Host refuse the
        // root it is being handed. A companion who has never played gets a new baseline, and
        // that is exactly why the launcher mints the operation identifier rather than the Host.
        var next = target is null
            ? new DeploymentIdentityValues(
                request.TargetContinuityId,
                request.TargetCompanionId,
                active.PlayerId,
                DeploymentIdentity.MintBootstrapOperationId(),
                1)
            : new DeploymentIdentityValues(
                target.ContinuityId,
                target.CompanionId,
                target.PlayerId,
                target.BootstrapOperationId,
                target.AuthorityGeneration);

        var undo = new List<Action>();
        try
        {
            EnsureParkedDirectory(layout);

            // 3. The index entry is written BEFORE the move it describes, so a crash between
            //    the two leaves an entry whose directory is absent - reported as nothing - and
            //    never a directory whose owner cannot be named.
            if (activeRootExists)
            {
                WriteParkedIndex(layout, [.. parked, EntryFor(active, parkedName)]);
                undo.Add(() => WriteParkedIndex(layout, parked));
            }

            // 4. The projection goes before the identity changes. It is derived, so removing it
            //    is always safe: the launcher re-materializes it from the identity record.
            var manifestPath = Path.Combine(layout.OperationalRoot, OperationalDeploymentManifest.FileName);
            if (File.Exists(manifestPath))
            {
                File.Delete(manifestPath);
                undo.Add(() => DeploymentIdentity.MaterializeProjection(layout, active));
            }

            // 5. The authority root in play is set aside, not deleted. This is the move that
            //    makes every one of her records reachable again the moment she comes back.
            if (activeRootExists)
            {
                Directory.Move(activeRoot, ParkedRootPath(layout, parkedName));
                undo.Add(() => Directory.Move(ParkedRootPath(layout, parkedName), activeRoot));
            }

            // 6. The identity record is the linearization point: everything after this reads it.
            DeploymentIdentity.ReplaceActive(layout, next);
            undo.Add(() => DeploymentIdentity.ReplaceActive(layout, active));

            // 7. The target's root takes the active position, and her index entry stops
            //    describing a parked companion because she is no longer one.
            if (targetRoot is not null)
            {
                fault?.Invoke(CompanionSwitchStep.TargetRootMove);
                Directory.Move(targetRoot, activeRoot);
                WriteParkedIndex(layout, parked.Where(entry => !ReferenceEquals(entry, target)).ToArray());
                undo.Add(() =>
                {
                    Directory.Move(activeRoot, targetRoot);
                    WriteParkedIndex(layout, [.. parked.Where(entry => !ReferenceEquals(entry, target)), EntryFor(active, parkedName)]);
                });
            }

            // 8. Last: the request is spent. Every launch before this point re-reads the same
            //    facts and lands on the same outcome, which is what makes a crash survivable -
            //    including a launch that answered this request and could not remove it.
            TryDiscardRequest(layout);
            return new CompanionSwitchOutcome(CompanionSwitchStatus.Switched, null, next.CompanionId, next.CompanionId, null);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or ArgumentException or NotSupportedException)
        {
            for (var index = undo.Count - 1; index >= 0; index -= 1)
            {
                try
                {
                    undo[index]();
                }
                catch (Exception rollbackFailure) when (rollbackFailure is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or ArgumentException or NotSupportedException)
                {
                    // A rollback that cannot complete leaves the state Reconcile owns: it runs
                    // on the next launch and finishes the same restoration from the index.
                }
            }

            throw new CompanionSwitchUnavailableException(exception);
        }
    }

    /// <summary>
    /// Finishes or undoes a switch that died between two of its steps, and removes the parks it
    /// can prove never happened.
    ///
    /// One rule, derived from facts the launcher owns: **if the identity record names a
    /// companion whose authority root is set aside while the active position is empty, that
    /// root belongs in the active position.** With the record still naming the companion who
    /// was being replaced this undoes the switch (her root goes back and she plays on); with
    /// the record already naming the target this completes it. Both are the fail-closed answer,
    /// because in both the identity record - never a half-moved directory - is what says who
    /// plays.
    ///
    /// The repair is the other half of the same argument, and it is not a second rule about
    /// missing directories. **An entry whose directory is absent, whose companion the identity
    /// record names, while her authority root IS in the active position, describes a park that
    /// did not hold**: step 3 writes the entry before the move it describes and step 5 makes
    /// that move, so a crash between them leaves exactly this; and the restore above moves her
    /// root back before it rewrites the index, so a crash between those two leaves it as well.
    /// Dropping such an entry removes a claim her own identity record and her own root refute.
    /// Keeping it is what makes the claim permanent: the index would keep naming a root that was
    /// never set aside, and every later switch to her would answer <c>companion_switch_unavailable</c>
    /// because <see cref="Switch"/> can only find the entry, not the directory.
    ///
    /// An entry whose directory is absent and whose companion is NOT the one in play is a
    /// different fact - the parked authority is genuinely gone - and it is deliberately left
    /// alone: dropping it would make the next switch to her mint a new baseline over data the
    /// product promised to bring back, and that is the one wrong answer.
    /// </summary>
    internal static void Reconcile(CurrentUserRootLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        if (!File.Exists(Path.Combine(layout.DataRoot, DeploymentIdentity.RecordFileName))) return;

        var active = DeploymentIdentity.ReadActive(layout);
        var parked = ReadParked(layout);
        var activeRoot = ProductionAuthority.DirectoryPath(layout);
        if (Directory.Exists(activeRoot))
        {
            var neverParked = parked
                .Where(entry => StringComparer.Ordinal.Equals(entry.CompanionId, active.CompanionId) &&
                    !Directory.Exists(ParkedRootPath(layout, entry.DirectoryName)))
                .ToArray();
            if (neverParked.Length > 0)
                WriteParkedIndex(layout, [.. parked.Where(entry => !neverParked.Contains(entry))]);
            return;
        }

        var mine = parked.FirstOrDefault(entry => StringComparer.Ordinal.Equals(entry.CompanionId, active.CompanionId));
        if (mine is null) return;

        // An entry whose directory is gone cannot be put back, and inventing an empty
        // authority for her would be the half-switched state this whole file exists to
        // prevent. The index entry stays and the state stays refused until it is resolved.
        var mineRoot = ParkedRootPath(layout, mine.DirectoryName);
        if (!Directory.Exists(mineRoot)) return;

        // The same rule as `Switch`, at the seam a crash leaves: what `Reconcile` puts in the
        // mount position is what the session-mode decision reads next, so an unfinished root is
        // not restored either. Her entry stays, her root stays parked and the mount position
        // stays empty - the launch that follows establishes a new authority for the identity the
        // record names, and not one byte of hers is deleted or discarded to get there.
        if (!ProductionAuthority.IsCompleteIn(mineRoot)) return;

        Directory.Move(mineRoot, ProductionAuthority.DirectoryPath(layout));
        WriteParkedIndex(layout, parked.Where(entry => !ReferenceEquals(entry, mine)).ToArray());
    }

    /// <summary>
    /// Whether nothing else holds the authority root's files, asked the way Windows answers it.
    ///
    /// The Host's store is opened with sharing, so the file that a rename would collide with is
    /// the file this probe cannot open exclusively: the probe asks the same question the move
    /// would ask, before anything is moved. It is also the bound on the one predecessor this
    /// operation has - a Host from a launch that was killed rather than quit - because a child
    /// that is already reclaiming releases these handles within the wait, and one that does not
    /// is wedged rather than slow.
    ///
    /// Anything the launcher cannot open - including a file it has no permission for - counts as
    /// held, and the caller refuses by name: the launcher may not rename a root it cannot prove
    /// nobody is writing.
    /// </summary>
    private static bool AuthorityIsReleased(string authorityRoot, TimeSpan ceiling)
    {
        var waited = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            if (AuthorityFilesAreFree(authorityRoot)) return true;
            if (waited.Elapsed >= ceiling) return false;
            Thread.Sleep(HostReclaimInterval);
        }
    }

    private static bool AuthorityFilesAreFree(string authorityRoot)
    {
        string[] files;
        try
        {
            files = Directory.GetFiles(authorityRoot);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }

        foreach (var file in files)
        {
            try
            {
                using var probe = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                return false;
            }
        }

        return true;
    }

    private static string ParkedDirectoryNameFor(DateTimeOffset now, string companionId) =>
        string.Create(CultureInfo.InvariantCulture, $"{now.UtcDateTime.ToString(ParkedStampFormat, CultureInfo.InvariantCulture)}-{companionId}");

    private static ParkedCompanion EntryFor(DeploymentIdentityValues values, string directoryName) =>
        new(values.CompanionId, values.ContinuityId, values.PlayerId, values.BootstrapOperationId, values.AuthorityGeneration, directoryName);

    private static CompanionSwitchOutcome Refuse(
        CurrentUserRootLayout layout,
        SwitchRequest request,
        string code,
        CompanionSwitchRefusalLifetime lifetime)
    {
        // Nothing was moved and nothing was renamed, so the refusal is the whole effect, and the
        // companion in play still is. Whether the request survives it is the one thing `lifetime`
        // decides, and it is the only difference between a refusal the player has to answer and one
        // the next launch answers for her.
        if (lifetime == CompanionSwitchRefusalLifetime.Permanent) TryDiscardRequest(layout);
        return new CompanionSwitchOutcome(
            CompanionSwitchStatus.Refused,
            code,
            request.ExpectedActiveCompanionId,
            request.TargetCompanionId,
            lifetime);
    }

    private static void EnsureParkedDirectory(CurrentUserRootLayout layout)
    {
        var path = ParkedDirectoryPath(layout);
        if (!Directory.Exists(path)) Directory.CreateDirectory(path);
    }

    /// <summary>
    /// Spends the request and reports whether it is gone.
    ///
    /// `false` is a named outcome rather than a swallowed failure: the request outlives the pass
    /// that answered it, and it stays the ONLY thing that does. Every answer this file gives is a
    /// function of the identity record and the parked index, and neither is changed twice for the
    /// same input - an applied request's answer IS the identity record already naming its target,
    /// and a refused one's answer is the state that refused it - so the next launch re-reads the
    /// same request, arrives at the same answer, and applies nothing a second time. A switch
    /// therefore does not have to undo itself over a file it could not delete, and it must not
    /// pretend the request was spent: the callers are the passes that did not spend it.
    /// </summary>
    private static bool TryDiscardRequest(CurrentUserRootLayout layout)
    {
        try
        {
            File.Delete(RequestPath(layout));
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static SwitchRequest? ReadRequest(CurrentUserRootLayout layout)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(RequestPath(layout)));
            var value = document.RootElement;
            if (value.ValueKind != JsonValueKind.Object ||
                !ExactProperties(value, ["schemaVersion", "requestId", "status", "expectedActiveCompanionId", "targetCompanionId", "targetContinuityId"]) ||
                !StringEquals(value.GetProperty("schemaVersion"), RequestSchema) ||
                !StringEquals(value.GetProperty("status"), StatusRequested) ||
                !Opaque(value.GetProperty("requestId")))
                return null;
            var expected = value.GetProperty("expectedActiveCompanionId");
            var targetCompanion = value.GetProperty("targetCompanionId");
            var targetContinuity = value.GetProperty("targetContinuityId");
            if (!Opaque(expected) || !Opaque(targetCompanion) || !Opaque(targetContinuity)) return null;
            return new SwitchRequest(
                expected.GetString()!,
                targetCompanion.GetString()!,
                targetContinuity.GetString()!);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or KeyNotFoundException or ArgumentException)
        {
            return null;
        }
    }

    private static ParkedCompanion[] ReadParkedIndex(CurrentUserRootLayout layout)
    {
        var path = ParkedIndexPath(layout);
        try
        {
            if (!File.Exists(path)) return [];
            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            var value = document.RootElement;
            if (value.ValueKind != JsonValueKind.Object ||
                !ExactProperties(value, ["schemaVersion", "entries"]) ||
                !StringEquals(value.GetProperty("schemaVersion"), ParkedIndexSchema) ||
                value.GetProperty("entries").ValueKind != JsonValueKind.Array)
                throw new CompanionSwitchUnavailableException(new InvalidDataException("The parked companion index is not an exact record."));

            var entries = new List<ParkedCompanion>();
            foreach (var entry in value.GetProperty("entries").EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.Object ||
                    !ExactProperties(entry, ["companionId", "continuityId", "playerId", "bootstrapOperationId", "authorityGeneration", "directoryName"]))
                    throw new CompanionSwitchUnavailableException(new InvalidDataException("A parked companion entry is not an exact record."));
                var companionId = entry.GetProperty("companionId");
                var continuityId = entry.GetProperty("continuityId");
                var playerId = entry.GetProperty("playerId");
                var operationId = entry.GetProperty("bootstrapOperationId");
                var directoryName = entry.GetProperty("directoryName");
                if (!Opaque(companionId) || !Opaque(continuityId) || !Opaque(playerId) || !Opaque(operationId) || !Opaque(directoryName))
                    throw new CompanionSwitchUnavailableException(new InvalidDataException("A parked companion entry does not name a companion."));
                if (!entry.GetProperty("authorityGeneration").TryGetInt32(out var generation) || generation < 1)
                    throw new CompanionSwitchUnavailableException(new InvalidDataException("A parked companion entry has no authority generation."));
                entries.Add(new ParkedCompanion(
                    companionId.GetString()!,
                    continuityId.GetString()!,
                    playerId.GetString()!,
                    operationId.GetString()!,
                    generation,
                    directoryName.GetString()!));
            }

            return [.. entries];
        }
        catch (FileNotFoundException)
        {
            return [];
        }
        catch (DirectoryNotFoundException)
        {
            return [];
        }
        catch (JsonException exception)
        {
            throw new CompanionSwitchUnavailableException(exception);
        }
        catch (KeyNotFoundException exception)
        {
            throw new CompanionSwitchUnavailableException(exception);
        }
        catch (InvalidOperationException exception)
        {
            throw new CompanionSwitchUnavailableException(exception);
        }
        catch (ArgumentException exception)
        {
            throw new CompanionSwitchUnavailableException(exception);
        }
        catch (System.Security.SecurityException exception)
        {
            throw new CompanionSwitchUnavailableException(exception);
        }
    }

    /// <summary>
    /// Writes a parked-companion index directly. The launcher's own switch writes this file in
    /// the middle of its ordered steps; this seam exists so a test can construct the state a
    /// crash halfway through would leave - an index that promises a root which is not there -
    /// without having to crash a process to get it.
    /// </summary>
    internal static void WriteParkedForTesting(CurrentUserRootLayout layout, IReadOnlyList<ParkedCompanion> entries) =>
        WriteParkedIndex(layout, entries);

    private static void WriteParkedIndex(CurrentUserRootLayout layout, IReadOnlyList<ParkedCompanion> entries)
    {
        EnsureParkedDirectory(layout);
        var document = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["schemaVersion"] = ParkedIndexSchema,
            ["entries"] = entries
                .Select(entry => (object?)new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["companionId"] = entry.CompanionId,
                    ["continuityId"] = entry.ContinuityId,
                    ["playerId"] = entry.PlayerId,
                    ["bootstrapOperationId"] = entry.BootstrapOperationId,
                    ["authorityGeneration"] = entry.AuthorityGeneration,
                    ["directoryName"] = entry.DirectoryName,
                })
                .ToArray(),
        };
        WriteAtomically(ParkedIndexPath(layout), JsonSerializer.Serialize(document));
    }

    /// <summary>
    /// One ordinary document written beside its target and renamed over it, so a reader never
    /// sees a half-written index. The bytes are the product's usual shape: UTF-8 without a
    /// BOM and exactly one trailing newline.
    /// </summary>
    internal static void WriteAtomically(string path, string json)
    {
        var temporary = path + ".tmp";
        var bytes = new List<byte>(new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(json)) { (byte)'\n' };
        try
        {
            using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes.ToArray(), 0, bytes.Count);
                stream.Flush(flushToDisk: true);
            }

            File.Move(temporary, path, overwrite: true);
        }
        catch
        {
            try
            {
                File.Delete(temporary);
            }
            catch (Exception cleanupFailure) when (cleanupFailure is IOException or UnauthorizedAccessException)
            {
                // The temporary is inert: nothing reads it, and the next write replaces it.
            }

            throw;
        }
    }

    private static bool ExactProperties(JsonElement value, string[] names) =>
        value.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal)
            .SequenceEqual(names.OrderBy(name => name, StringComparer.Ordinal), StringComparer.Ordinal);

    private static bool StringEquals(JsonElement value, string expected) =>
        value.ValueKind == JsonValueKind.String && StringComparer.Ordinal.Equals(value.GetString(), expected);

    private static bool Opaque(JsonElement value) =>
        value.ValueKind == JsonValueKind.String && value.GetString() is { } text && Identifier.IsMatch(text);

    private readonly record struct SwitchRequest(
        string ExpectedActiveCompanionId,
        string TargetCompanionId,
        string TargetContinuityId);
}


