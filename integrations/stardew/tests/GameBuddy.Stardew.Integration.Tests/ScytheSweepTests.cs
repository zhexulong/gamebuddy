using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gates ONE scythe swing needs, each named with the defect it exists for.
///
/// <para>
/// `sweep_scythe` performs the engine's own arc in one tick, so three things can silently break the promise it makes:
/// the arc can be driven with an index set the engine's swing does not use (a different area, with no error anywhere);
/// the destruction rule can be answered from a list instead of from the catalogue (a planted tuft cut by a swing nobody
/// aimed at it); and the actor state the sweep writes can be left behind on an exit this suite cannot drive (success,
/// refusal, STOP, exception). The population of every check below is derived - from the engine's own frame table, from
/// `FarmhandActionCatalog.Registrations`, or from the shipped Mod sources walked as text - never from a list written
/// here.
/// </para>
/// </summary>
public sealed class ScytheSweepTests
{
    private const string ModRoot = "integrations/stardew";
    private const string ExecutionManagerSource = "integrations/stardew/farmhandexecutioncontroller.cs";
    private const string ResourceToolActionsSource = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";

    [Fact]
    public void TheSweepRefusesOnlyWhatItDoesNotDeclareAndNeverAnImmatureCrop()
    {
        // THE THREE-VALUED MASK, and the two-way version it replaces was a defect of its own: treating every destructive
        // occupant as forbidden made the one action built for pasture refuse every pasture. Both directions are asserted
        // here: a destructive occupant the action DECLARES (read from its own `Clears`) is cut, one it does not declare is
        // refused by name, and an immature crop is refused whatever the declaration says.
        HashSet<string> declared = MeleeSweepOccupancy.Intent.ToHashSet(StringComparer.Ordinal);
        declared.Should().BeEquivalentTo(MeleeSweepOccupancy.Intent,
            "the mask reads the action's own declaration rather than a list kept beside it");
        declared.Should().BeSubsetOf(MeleeSweepOccupancy.Destructive,
            "what the sweep declares it is for is drawn from the catalogue's destructive occupants");
        declared.Should().Contain(new[] { MeleeSweepOccupancy.Grass, MeleeSweepOccupancy.Crop });
        declared.Should().NotContain(MeleeSweepOccupancy.Weed,
            "a weed is not this action's route-opening job; naming it here would offer a second clearer beside cut_weeds");

        Vector2 named = new(10f, 10f);
        Vector2 tuft = new(11f, 10f);
        Vector2 readyCrop = new(9f, 10f);
        Vector2 immatureCrop = new(10f, 11f);
        Vector2 weed = new(9f, 11f);
        var world = new Dictionary<Vector2, MeleeSweepTile>
        {
            [named] = new MeleeSweepTile(MeleeSweepOccupancy.Grass, 0, 4),
            [tuft] = new MeleeSweepTile(MeleeSweepOccupancy.Grass, 0, 3),
            [readyCrop] = new MeleeSweepTile(MeleeSweepOccupancy.Crop, 0, 0, true),
            [immatureCrop] = new MeleeSweepTile(MeleeSweepOccupancy.Crop, 0, 0, false),
            [weed] = new MeleeSweepTile(MeleeSweepOccupancy.Weed, 2, 0),
        };
        List<Vector2> arc = new() { named, tuft, readyCrop, immatureCrop, weed };

        List<(Vector2 Tile, string Kind)> refused = MeleeSweepOccupancy.Undeclared(arc, tile => world[tile], named);

        refused.Should().BeEquivalentTo(
            new[] { (Tile: immatureCrop, Kind: MeleeSweepOccupancy.Crop) },
            "the declared tuft and the ready crop are the work, the weed is not destructive, and only the immature crop is a loss");

        // THE OTHER DIRECTION, driven through the same code path with a narrower declaration: a destructive occupant the
        // request did not declare is refused by name. This is how a future `Destructive` occupant behaves until an action
        // declares it, which is the invariant "one swing may destroy only what it declared".
        List<(Vector2 Tile, string Kind)> narrower = MeleeSweepOccupancy.Undeclared(
            arc,
            tile => world[tile],
            named,
            new HashSet<string>(new[] { MeleeSweepOccupancy.Grass }, StringComparer.Ordinal));

        narrower.Should().BeEquivalentTo(
            new[]
            {
                (Tile: readyCrop, Kind: MeleeSweepOccupancy.Crop),
                (Tile: immatureCrop, Kind: MeleeSweepOccupancy.Crop),
            },
            "a crop this declaration does not name is refused, ready or not");
    }

    [Fact]
    public void AWeedGrassAndCropEachReportTheirOwnTransition()
    {
        // THE HONESTY OF `changed`. An occupancy WORD cannot say whether a swing moved a tile: a weed at 2 that took one
        // point of damage is still `weed`, and a tuft at 4 that lost one is still `grass`. Each occupant class therefore
        // reports its own transition, from the counter the engine's own branch decrements.
        MeleeSweepOccupancy.Changed(
            new MeleeSweepTile(MeleeSweepOccupancy.Weed, 2, 0),
            new MeleeSweepTile(MeleeSweepOccupancy.Weed, 1, 0))
            .Should().BeTrue("a weed that lost a point of health moved, even though its word did not");
        MeleeSweepOccupancy.Changed(
            new MeleeSweepTile(MeleeSweepOccupancy.Weed, 1, 0),
            new MeleeSweepTile(FarmhandForEachHealing.NoOccupant, 0, 0))
            .Should().BeTrue("a weed that left the map moved");
        MeleeSweepOccupancy.Changed(
            new MeleeSweepTile(MeleeSweepOccupancy.Grass, 0, 4),
            new MeleeSweepTile(MeleeSweepOccupancy.Grass, 0, 1))
            .Should().BeTrue("a tuft that lost weeds moved");
        MeleeSweepOccupancy.Changed(
            new MeleeSweepTile(MeleeSweepOccupancy.Crop, 0, 0),
            new MeleeSweepTile(FarmhandForEachHealing.NoOccupant, 0, 0))
            .Should().BeTrue("a crop that left its dirt moved");
        MeleeSweepOccupancy.Changed(
            new MeleeSweepTile(MeleeSweepOccupancy.Crop, 0, 0),
            new MeleeSweepTile(MeleeSweepOccupancy.Crop, 0, 0))
            .Should().BeFalse("an unready crop the swing never touched did not move, and is not a shortfall of it");
        MeleeSweepOccupancy.Changed(
            new MeleeSweepTile(FarmhandForEachHealing.NoOccupant, 0, 0),
            new MeleeSweepTile(FarmhandForEachHealing.NoOccupant, 0, 0))
            .Should().BeFalse("a tile that held nothing is already clear, never a change");

        MeleeSweepOccupancy.Describe(new[] { (Tile: new Vector2(3f, 7f), Kind: MeleeSweepOccupancy.Weed) })
            .Should().Be("3:7:weed", "the detail is split on `;` then `=`, so the tile and its kind use `:` and `|`");
        MeleeSweepOccupancy.Describe(Array.Empty<(Vector2, string)>())
            .Should().Be("none", "an empty set is the explicit word the Host accepts, never an empty value");
    }

    [Fact]
    public void APartialSwingClaimsOnlyTheTilesItObservedMoving()
    {
        // THE HONESTY GATE. A step's receipt may never claim a tile it did not observe. The claim is the intersection of
        // three things - the arc the engine sampled, the tile's state before, the tile's state after - so this drives one
        // tile that moved, one that was already clear, one the swing MISSED, and one that changed although it is outside
        // the arc (another swing, another actor, the game's own tick). Only the first may appear.
        Vector2 moved = new(10f, 9f);
        Vector2 alreadyClear = new(11f, 9f);
        Vector2 missed = new(10f, 10f);
        Vector2 outsideTheArc = new(30f, 30f);
        List<Vector2> arc = new() { moved, alreadyClear, missed };
        var before = new Dictionary<Vector2, MeleeSweepTile>
        {
            [moved] = new MeleeSweepTile(MeleeSweepOccupancy.Weed, 1, 0),
            [alreadyClear] = new MeleeSweepTile(FarmhandForEachHealing.NoOccupant, 0, 0),
            [missed] = new MeleeSweepTile(MeleeSweepOccupancy.Weed, 2, 0),
            [outsideTheArc] = new MeleeSweepTile(MeleeSweepOccupancy.Grass, 0, 4),
        };
        var after = new Dictionary<Vector2, MeleeSweepTile>
        {
            [moved] = new MeleeSweepTile(FarmhandForEachHealing.NoOccupant, 0, 0),
            [alreadyClear] = new MeleeSweepTile(FarmhandForEachHealing.NoOccupant, 0, 0),
            [missed] = new MeleeSweepTile(MeleeSweepOccupancy.Weed, 2, 0),
            [outsideTheArc] = new MeleeSweepTile(FarmhandForEachHealing.NoOccupant, 0, 0),
        };

        List<(Vector2 Tile, string Kind)> changed = MeleeSweepOccupancy.Changes(arc, before, after);

        changed.Should().BeEquivalentTo(
            new[] { (Tile: moved, Kind: MeleeSweepOccupancy.Weed) },
            "the tile the swing did not move and the tile outside the arc are not changes it may claim");
        changed.Should().HaveCount(1);
        MeleeSweepOccupancy.Describe(changed).Split('|').Should().HaveCount(changed.Count,
            "`tiles_changed` is the count of the set the receipt names, never a second number");
        MeleeSweepOccupancy.Describe(changed).Should().Be("10:9:weed",
            "the kind travels with the tile: after the cut the tile is empty and the kind would be unrecoverable");
    }

    [Fact]
    public void TheActorStateTheSweepWritesIsRestoredOnEveryExit()
    {
        // G2 for this action. `who.FarmerSprite.currentAnimationIndex` is the one piece of actor state the sweep writes,
        // and a value left behind resumes an animation nobody asked for. The check is STRUCTURAL because it must cover
        // exits this suite cannot drive - success, a refusal, a STOP and an exception - so it asserts the shape that
        // makes all of them safe: one writer, one `try`, one unconditional restore in the `finally`, and no suspended
        // section between them.
        string source = Read(ExecutionManagerSource);
        string seam = MethodBody(source, "private static void UseNativeMeleeSweep(");

        var writes = new List<string>();
        foreach (string file in ModSourceFiles())
        {
            string text = File.ReadAllText(file);
            int index = 0;
            while ((index = text.IndexOf("currentAnimationIndex =", index, StringComparison.Ordinal)) >= 0)
            {
                string relative = Path.GetRelativePath(RepositoryRoot(), file).Replace('\\', '/');
                writes.Add($"{relative}:{LineOf(text, index)}");
                index += "currentAnimationIndex =".Length;
            }
        }

        writes.Should().NotBeEmpty("sweep_actor_state_not_restored_on:no_writer: the sweep writes the animation index");
        string[] outside = writes.Where(write => !write.StartsWith(ExecutionManagerSource + ":", StringComparison.Ordinal)).ToArray();
        outside.Should().BeEmpty(
            "sweep_actor_state_not_restored_on:write_outside_seam: " + string.Join(", ", outside));
        // Two writes and no more, both inside the seam: one per rectangle, and the restore. A third would be a second
        // writer; the file-equals-seam count is what proves the two the seam has are the only two there are.
        int inSeam = CountOccurrences(seam, "currentAnimationIndex =");
        inSeam.Should().Be(2,
            "sweep_actor_state_not_restored_on:unexpected_write_count: the seam writes the index once per rectangle and restores it once");
        CountOccurrences(source, "currentAnimationIndex =").Should().Be(inSeam,
            "sweep_actor_state_not_restored_on:write_outside_seam: " + string.Join(", ", writes));

        int tryAt = seam.IndexOf("try", StringComparison.Ordinal);
        int finallyAt = seam.IndexOf("finally", StringComparison.Ordinal);
        tryAt.Should().BeGreaterThanOrEqualTo(0, "sweep_actor_state_not_restored_on:no_try");
        finallyAt.Should().BeGreaterThan(tryAt, "sweep_actor_state_not_restored_on:no_finally: a return would skip a bare restore");
        seam[tryAt..finallyAt].Should().Contain("DoDamage(",
            "sweep_actor_state_not_restored_on:dispatch_outside_try: the native call must be inside the guarded section");
        seam[finallyAt..].Should().Contain("who.FarmerSprite.currentAnimationIndex = restingIndex;",
            "sweep_actor_state_not_restored_on:restore_missing: the index read before the section is what must come back");
        seam.Should().NotContain("await", "sweep_actor_state_not_restored_on:await_in_section: a suspended section can be left written");
        seam.Should().NotContain("yield", "sweep_actor_state_not_restored_on:yield_in_section: a suspended section can be left written");
    }

    [Fact]
    public void TheArcIsReadBeforeTheSwingAndTheHandlerSwingsNothingItself()
    {
        // ONE SET OF FACTS. The arc the swing will use is asked of the engine BEFORE anything is written, so the
        // destructive pre-check and the `sweep_arc_misses_target` refusal are about the same rectangles the swing will
        // drive. The handler itself calls no native method: `UseNativeMeleeSweep` is the only one, which is what makes
        // the actor-state invariant above cover every path.
        string handler = MethodBody(Read(ResourceToolActionsSource), "private LocalExecutionReceipt ExecuteSweepScythe(");

        int arc = handler.IndexOf("MeleeSweepArc.Sampled(", StringComparison.Ordinal);
        int misses = handler.IndexOf("sweep_arc_misses_target", StringComparison.Ordinal);
        int destroy = handler.IndexOf("MeleeSweepOccupancy.Undeclared(", StringComparison.Ordinal);
        int swing = handler.IndexOf("UseNativeMeleeSweep(", StringComparison.Ordinal);
        int after = handler.IndexOf("MeleeSweepOccupancy.Changed(", StringComparison.Ordinal);

        arc.Should().BeGreaterThanOrEqualTo(0, "the handler asks the engine for the arc");
        misses.Should().BeGreaterThan(arc, "the arc is read first, then the named tile is proved to be inside it");
        destroy.Should().BeGreaterThan(misses, "the destruction rule is answered against that same arc");
        swing.Should().BeGreaterThan(destroy, "nothing is swung before the destructive tiles are refused by name");
        after.Should().BeGreaterThan(swing, "`changed` is measured after the swing, never predicted before it");

        handler.Should().NotContain("performToolAction(", "the handler must drive no per-tile native call of its own");
        handler.Should().NotContain(".DoDamage(", "the one DoDamage call site is the seam, so one gate covers every path");
    }

    // ---- helpers -------------------------------------------------------------

    private static IEnumerable<string> ModSourceFiles() =>
        Directory.GetFiles(RepositorySourcePath(ModRoot), "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}action-development{Path.DirectorySeparatorChar}", StringComparison.Ordinal));

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    private static int CountOccurrences(string source, string needle)
    {
        int count = 0;
        int index = 0;
        while ((index = source.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }
        return count;
    }

    private static int LineOf(string source, int offset) =>
        source[..offset].Count(character => character == '\n') + 1;

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");
        int depth = 0;
        for (int position = opening; position < source.Length; position++)
        {
            if (source[position] == '{') depth++;
            else if (source[position] == '}' && --depth == 0)
                return source.Substring(opening, position - opening + 1);
        }
        throw new InvalidOperationException($"{signature} has an unbalanced body");
    }

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return directory.FullName;
    }

    private static string RepositorySourcePath(string relative) => Path.Combine(RepositoryRoot(), relative);
}
