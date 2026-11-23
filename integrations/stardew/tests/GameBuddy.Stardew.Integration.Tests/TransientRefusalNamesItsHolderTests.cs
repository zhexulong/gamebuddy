using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_transient_refusal_names_its_holder`: a refusal that says the body is held for a moment has to say WHO holds it and
/// what ends it, and one that names a bucket of holds instead sends its caller round the loop it was written to break.
///
/// <para>
/// MEASURED `round86`: sixteen `move_to_tile` refusals read
/// <c>transient_kind=movement_lock;retry_window_ms=2000;can_move=false</c> while the game clock stood at day 7 16:40 for
/// four minutes, and the caller re-sent on the 2 s window the sentence had promised. `round83` had fixed the same defect
/// one word over for the navigation refusal (`held_by=unknown_holder:CanMove`); the movement refusal went through the
/// other describer and lost the holder again. `movement_lock` read like a native lock with a timer and was neither.
/// </para>
///
/// <para>
/// THE POPULATION IS THE MOD'S OWN SET OF TRANSIENT HOLDS. The named kinds are <see cref="ActorTransientKind"/>'s members,
/// the closed set <see cref="WorldModel.Classify"/> mints from and <see cref="WorldModel.KindForWire"/> spells, so a kind added
/// to that declaration is in this gate the moment it exists and a word `Classify` mints outside it fails by name; the two
/// shapes the closed set cannot name are the `CanMove` tail, which is the other half of the same producer
/// (<c>ExecutionManager.ProjectAdmissionDisposition</c>). The third check holds the population's OWNER: only
/// <c>WorldModel.cs</c> constructs a disposition, so a new producer can only publish a sentence through
/// <see cref="WorldModel.DescribeHeldBody"/> - the door that names the holder.
/// </para>
///
/// <para>
/// Limits, stated rather than hidden: the kinds are derivable from the classifier's source but a FIXTURE is not, so the
/// shapes are driven through the sentence builder with the disposition <c>Classify</c> mints for them, not by setting
/// fifteen fact flags to invent one. That is the same decision table - <c>DescribeHeldBody</c> takes the classification
/// rather than recomputing it - and it is what lets a kind this gate has never seen be examined without a game.
/// </para>
/// </summary>
public sealed class TransientRefusalNamesItsHolderTests
{
    private const string Gate = "transient_refusal_names_its_holder/v1";

    /// <summary>The file that owns the sentence, the holder ladder, and the minting of every disposition.</summary>
    private const string OwnerFile = "integrations/stardew/WorldModel.cs";

    private const string ModSource = "integrations/stardew";

    /// <summary>
    /// Directories under the Mod that hold no production source: build output, the pins that read it, and the
    /// action-development toolchain. Every other directory is scanned, so a new source directory joins the population by
    /// existing rather than by being added here.
    /// </summary>
    private static readonly string[] NotProductionSource = { "bin", "obj", "tests", "action-development" };

    /// <summary>
    /// `round86`, verbatim: the evidence sixteen `move_to_tile` refusals carried
    /// (`tools/_multiday_routine-round86.result.json`, the `world-facts` line of every turn from day 7 16:40 on). Kept as
    /// the text it was, because this gate's falsifier is that run and not one the author invented.
    /// </summary>
    private const string Round86Evidence = "transient_kind=movement_lock;retry_window_ms=2000;can_move=false";

    /// <summary>200 ms, the value `express_emote` writes into `Farmer.noMovementPause` (Farmer.cs:2505).</summary>
    private const int NativeBodyPauseMs = 200;

    /// <summary>The holder-word family of the three declared native body timers (<see cref="BodyHold"/>).</summary>
    private const string BodyPauseHolderPrefix = "body_pause:";

    /// <summary>The two ways a disposition is created rather than read - the producer side of the population.</summary>
    private static readonly string[] DispositionConstructions = { "new ActorDisposition(", "with { Kind = ActorDispositionKind." };

    private readonly ITestOutputHelper output;

    public TransientRefusalNamesItsHolderTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryTransientRefusalTheModCanMintNamesItsHolder()
    {
        string[] kinds = NamedTransientKinds();
        IReadOnlyList<(string Code, string Evidence)> shapes = Shapes(kinds);
        string[] minters = DispositionMinters();

        this.output.WriteLine(
            $"{Gate}: kinds {kinds.Length} · shapes {shapes.Count} · examined {shapes.Count}"
            + $" · dispositions constructed by {minters.Length} file(s)");
        foreach ((string code, string evidence) in shapes)
            this.output.WriteLine($"{Gate}: {code} :: {evidence}");

        kinds.Should().NotBeEmpty(
            "blocked: no transient kind could be read out of Classify, so this gate examined nothing and agrees with itself");
        shapes.Should().NotBeEmpty("blocked: the shapes list is empty, so nothing was examined");

        IReadOnlyList<string> findings = Judge(shapes, kinds);
        findings.Should().BeEmpty(
            "every transient refusal has to name the holder and the step that ends it; findings: {0}",
            string.Join(" | ", findings));

        minters.Should().Equal(
            new[] { OwnerFile },
            "a disposition minted outside the owner is a second spelling of the closed set of holds, and the producer that"
            + " reached for the weaker describer in `round86` was exactly that");
    }

    /// <summary>
    /// THE FALSIFIER, on the run it was measured by: `round86`'s own evidence goes through the same judge and lands in the
    /// findings, with the offending word named.
    /// </summary>
    [Fact]
    public void TheGateIsRedOnTheShapeRound86WasRefusedWith()
    {
        IReadOnlyList<string> findings = Judge(new[] { ("transient_busy", Round86Evidence) }, NamedTransientKinds());

        this.output.WriteLine($"{Gate}: falsifier -> {string.Join(" | ", findings)}");

        findings.Should().NotBeEmpty("the shape a live run was refused with is not a shape this gate may pass");
        findings.Should().Contain(
            finding => finding.Contains("transient_kind=movement_lock", StringComparison.Ordinal),
            "the bucket word has to be named, not merely counted");
        findings.Should().Contain(
            finding => finding.Contains("no `held_by=`", StringComparison.Ordinal),
            "and so does the missing holder, which is the half that cost the run its four minutes");
    }

    /// <summary>
    /// The shape the rule must NOT flatten: a DECLARED timer with time still on it, so waiting is honest and what is left
    /// travels with the sentence. `Farmer.noMovementPause` is the engine's countdown; `body_pause:<site>` is the holder
    /// the probe declared when that site wrote it.
    /// </summary>
    [Fact]
    public void TheDeclaredTimerShapeStaysGreen()
    {
        (string code, string evidence) = WorldModel.DescribeHeldBody(
            ActorDisposition.Idle, default, canMove: false, hold: DeclaredBodyPause());

        this.output.WriteLine($"{Gate}: body_pause -> {code} :: {evidence}");

        code.Should().Be("transient_busy", "round86's code is what callers already handle; the HOLDER was what was missing");
        evidence.Should().Contain($"held_by={BodyHold.EmoteHolder}");
        evidence.Should().Contain("hold_remaining_ms=");
        Judge(new[] { (code, evidence) }, NamedTransientKinds()).Should().BeEmpty();
    }

    /// <summary>
    /// And the shape that names no holder but the absence: a named defect that ends the attempt, and no window at all - a
    /// window is only honest where a timer will honour it.
    /// </summary>
    [Fact]
    public void TheUndeclaredShapeStaysGreenAndPromisesNoWindow()
    {
        (string code, string evidence) = WorldModel.DescribeHeldBody(ActorDisposition.Idle, default, canMove: false, hold: BodyHoldFact.Free);

        this.output.WriteLine($"{Gate}: stalled -> {code} :: {evidence}");

        evidence.Should().Contain($"held_by={WorldModel.StalledHolderPrefix}{WorldModel.UnnamedHolderEngineFact}");
        evidence.Should().Contain($"defect={WorldModel.HoldWithoutOwnerDefect}");
        evidence.Should().Contain($"next_step={WorldModel.ReportTheStalledBodyStep}");
        evidence.Should().NotContain("retry_window_ms", "nothing is running, so nothing will honour a window");
        evidence.Should().NotContain("movement_lock");
        WorldModel.NextStepEndsTheHold(WorldModel.ReportTheStalledBodyStep).Should().BeTrue();
        Judge(new[] { (code, evidence) }, NamedTransientKinds()).Should().BeEmpty();
    }

    /// <summary>
    /// Every transient refusal the Mod can mint, as <see cref="WorldModel.DescribeHeldBody"/> publishes it: the kinds
    /// <see cref="WorldModel.Classify"/> names, plus the two shapes of the `CanMove` tail it cannot.
    /// </summary>
    private static IReadOnlyList<(string Code, string Evidence)> Shapes(IEnumerable<string> kinds)
    {
        var shapes = new List<(string, string)>();
        foreach (string kind in kinds)
            shapes.Add(WorldModel.DescribeHeldBody(new ActorDisposition(ActorDispositionKind.Transient, null, false, kind), default, canMove: false, hold: BodyHoldFact.Free));

        // The tail: `Classify` says Idle and the engine says the body cannot move. `ProjectAdmissionDisposition` calls that
        // a transient, which is why both of its shapes belong to this population: a declared timer, and no declaration.
        shapes.Add(WorldModel.DescribeHeldBody(ActorDisposition.Idle, default, canMove: false, hold: BodyHoldFact.Free));
        shapes.Add(WorldModel.DescribeHeldBody(ActorDisposition.Idle, default, canMove: false, hold: DeclaredBodyPause()));
        return shapes;
    }

    /// <summary>
    /// The emote's declared timer: the holder `performPlayerEmote` writes (Farmer.cs:2505), with the 200 ms window its own
    /// site declares. Stated here rather than read from the live ledger, so the gate examines a shape it can name.
    /// </summary>
    private static BodyHoldFact DeclaredBodyPause() =>
        new(BodyHoldState.Held, BodyHold.EmoteHolder, BodyHold.NativeTimerReason, BodyHold.NowMs() + NativeBodyPauseMs);

    /// <summary>
    /// One transient refusal's sentence, judged: it names a holder, in the vocabulary the Mod can actually report, and a
    /// step that ends the hold; and it claims a window only where something is really running.
    /// </summary>
    internal static IReadOnlyList<string> Judge(
        IReadOnlyList<(string Code, string Evidence)> shapes,
        IReadOnlyCollection<string> namedKinds)
    {
        string stalled = $"{WorldModel.StalledHolderPrefix}{WorldModel.UnnamedHolderEngineFact}";
        var findings = new List<string>();
        foreach ((string code, string evidence) in shapes)
        {
            string? heldBy = FieldOf(evidence, "held_by");
            string? kind = FieldOf(evidence, "transient_kind");
            string? step = FieldOf(evidence, "next_step");

            if (kind is not null && !namedKinds.Contains(kind, StringComparer.Ordinal))
                findings.Add($"{code}: transient_kind={kind} is a bucket, and no branch of Classify mints it: {evidence}");
            if (string.IsNullOrEmpty(heldBy))
                findings.Add($"{code}: no `held_by=`, so the sentence names no holder: {evidence}");
            else if (heldBy.StartsWith(BodyPauseHolderPrefix, StringComparison.Ordinal))
            {
                if (FieldOf(evidence, "hold_remaining_ms") is null or "0")
                    findings.Add($"{code}: held_by={heldBy} publishes no remainder, so its window is a guess: {evidence}");
            }
            else if (heldBy != stalled && kind is null)
                findings.Add($"{code}: held_by={heldBy} names a code rather than a holder, and no transient_kind says which: {evidence}");

            if (heldBy == stalled && FieldOf(evidence, "defect") is null)
                findings.Add($"{code}: held_by={heldBy} names an absence without naming the defect: {evidence}");
            if (heldBy != stalled && FieldOf(evidence, "defect") is not null)
                findings.Add($"{code}: held_by={heldBy} is a declared hold and the sentence calls it a defect: {evidence}");

            if (step is null || !WorldModel.NextStepEndsTheHold(step))
                findings.Add($"{code}: next_step={step ?? "<none>"} is not a step that ends the hold: {evidence}");
            if (heldBy == stalled
                && (FieldOf(evidence, "retry_window_ms") is not null || FieldOf(evidence, "hold_remaining_ms") is not null))
                findings.Add($"{code}: nothing is running, so nothing honours a window: {evidence}");
        }

        return findings;
    }

    /// <summary>The transient kinds the classifier mints, in the declaration's own words.</summary>
    private static string[] NamedTransientKinds() => Enum
        .GetValues<ActorTransientKind>()
        .Select(WorldModel.KindForWire)
        .OrderBy(kind => kind, StringComparer.Ordinal)
        .ToArray();

    /// <summary>
    /// The production files that CONSTRUCT a disposition rather than read one. The set is the population's owner: the
    /// sentence that names a holder lives beside these constructions, and a file that makes its own disposition is a
    /// producer outside that owner.
    /// </summary>
    private static string[] DispositionMinters()
    {
        string root = RepositoryRoot();
        var minters = new List<string>();
        foreach (string file in Directory.EnumerateFiles(Path.Combine(root, ModSource), "*.cs", SearchOption.AllDirectories))
        {
            string relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            if (relative.Split('/').Any(part => NotProductionSource.Contains(part, StringComparer.Ordinal)))
                continue;

            string code = string.Join('\n', File.ReadAllLines(file).Select(DecompiledSource.WithoutComment));
            if (DispositionConstructions.Any(construction => code.Contains(construction, StringComparison.Ordinal)))
                minters.Add(relative);
        }

        return minters.OrderBy(file => file, StringComparer.Ordinal).ToArray();
    }

    /// <summary>
    /// One <c>key=value</c> field of an evidence sentence, read the way the wire reads it: split on <c>;</c> and then on
    /// <c>=</c>, so a field is a field and never a substring of another.
    /// </summary>
    private static string? FieldOf(string evidence, string key) =>
        evidence
            .Split(';')
            .Select(field => field.Split('='))
            .Where(parts => parts.Length == 2 && parts[0] == key)
            .Select(parts => parts[1])
            .FirstOrDefault();

    private static string RepositoryRoot()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, OwnerFile)))
                return directory.FullName;
        }

        throw new DirectoryNotFoundException($"{OwnerFile} is not reachable from {AppContext.BaseDirectory}");
    }
}
