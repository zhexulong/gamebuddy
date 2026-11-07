using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using GameBuddy.Setup;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// Upgrade recovery: the previous generation survives an upgrade, and the pointer that restores it is recorded.
///
/// Before this, the installer deleted every generation the new payload did not contain, so a release that failed to
/// start left the player with nothing to step back to - and reinstalling installs the same release. Each case below
/// drives the real extract/prune step against a scratch root and a synthetic archive, then the real rollback against
/// what it produced.
///
/// Retention is one generation, so the bounded collection is checked too: a third upgrade must leave exactly two.
/// </summary>
public sealed class UpgradeRetentionTests
{
    private const string GenerationOne = "g-aaa111-1-00000000000000000000000000000001";
    private const string GenerationTwo = "g-bbb222-2-00000000000000000000000000000002";
    private const string GenerationThree = "g-ccc333-3-00000000000000000000000000000003";

    /// <summary>
    /// The fixture's own generation ids have to be ids a launch accepts, or every rollback case fails for a reason that
    /// has nothing to do with the behaviour under test.
    /// </summary>
    [Fact]
    public void The_fixtures_generation_ids_are_ids_the_launcher_accepts()
    {
        Assert.All(
            new[] { GenerationOne, GenerationTwo, GenerationThree },
            generation => Assert.True(InstalledGenerationPaths.ValidGeneration(generation), generation));
    }

    [Fact]
    public void A_first_install_records_no_rollback_pointer_because_there_is_nothing_to_return_to()
    {
        using var scratch = new ScratchProgramRoot();

        scratch.Install(GenerationOne);

        Assert.True(Directory.Exists(scratch.GenerationPath(GenerationOne)));
        Assert.False(File.Exists(scratch.RollbackPointerPath));
    }

    [Fact]
    public void An_upgrade_keeps_the_previous_generation_and_records_the_pointer_that_selects_it()
    {
        using var scratch = new ScratchProgramRoot();
        scratch.Install(GenerationOne);

        scratch.Install(GenerationTwo);

        // The new generation is selected, the previous one is still on disk, and the rollback pointer names it.
        Assert.Equal(GenerationTwo, scratch.SelectedGeneration());
        Assert.True(Directory.Exists(scratch.GenerationPath(GenerationOne)));
        Assert.Equal(GenerationOne, scratch.RollbackGeneration());
    }

    [Fact]
    public void A_third_upgrade_keeps_exactly_one_generation_back_so_the_collection_drains()
    {
        using var scratch = new ScratchProgramRoot();
        scratch.Install(GenerationOne);
        scratch.Install(GenerationTwo);

        scratch.Install(GenerationThree);

        // Two generations, never three: the pointer moved along and the oldest was pruned.
        var present = Directory.GetDirectories(scratch.GenerationsRoot)
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(new[] { GenerationTwo, GenerationThree }, present);
        Assert.Equal(GenerationTwo, scratch.RollbackGeneration());
    }

    [Fact]
    public void Reinstalling_the_same_generation_clears_the_rollback_pointer_instead_of_pointing_at_itself()
    {
        using var scratch = new ScratchProgramRoot();
        scratch.Install(GenerationOne);
        scratch.Install(GenerationTwo);

        // The same generation again: a rollback here would restore the release that is already running.
        scratch.Install(GenerationTwo);

        Assert.False(File.Exists(scratch.RollbackPointerPath));
    }

    [Fact]
    public void Restore_selects_the_previous_generation_and_the_swap_allows_stepping_forward_again()
    {
        using var scratch = new ScratchProgramRoot();
        scratch.Install(GenerationOne);
        scratch.Install(GenerationTwo);

        Assert.Equal(InstalledGenerationRollback.Result.Restored, InstalledGenerationRollback.Restore(scratch.ProgramRoot));
        Assert.Equal(GenerationOne, scratch.SelectedGeneration());
        // The pointer that was replaced becomes the rollback target, so the player can step forward once more.
        Assert.Equal(GenerationTwo, scratch.RollbackGeneration());

        Assert.Equal(InstalledGenerationRollback.Result.Restored, InstalledGenerationRollback.Restore(scratch.ProgramRoot));
        Assert.Equal(GenerationTwo, scratch.SelectedGeneration());
    }

    [Fact]
    public void Restore_reports_nothing_to_roll_back_when_no_pointer_was_recorded()
    {
        using var scratch = new ScratchProgramRoot();
        scratch.Install(GenerationOne);

        Assert.Equal(
            InstalledGenerationRollback.Result.NothingToRollBack,
            InstalledGenerationRollback.Restore(scratch.ProgramRoot));
    }

    [Fact]
    public void Restore_refuses_a_pointer_whose_generation_is_no_longer_installed()
    {
        using var scratch = new ScratchProgramRoot();
        scratch.Install(GenerationOne);
        scratch.Install(GenerationTwo);
        // The generation the pointer names disappears; a rollback would select something the next launch refuses.
        Directory.Delete(scratch.GenerationPath(GenerationOne), recursive: true);

        Assert.Equal(
            InstalledGenerationRollback.Result.TargetUnavailable,
            InstalledGenerationRollback.Restore(scratch.ProgramRoot));
        Assert.Equal(GenerationTwo, scratch.SelectedGeneration());
    }

    [Fact]
    public void Restore_refuses_a_pointer_whose_admission_digest_does_not_match_the_generation()
    {
        using var scratch = new ScratchProgramRoot();
        scratch.Install(GenerationOne);
        scratch.Install(GenerationTwo);
        // The pointer is well-formed and names a real generation, but its admission digest belongs to other bytes.
        File.WriteAllText(
            scratch.RollbackPointerPath,
            PointerFor(GenerationOne, admissionSha256: new string('a', 64)));

        Assert.Equal(
            InstalledGenerationRollback.Result.TargetUnavailable,
            InstalledGenerationRollback.Restore(scratch.ProgramRoot));
    }

    private static string PointerFor(string generation, string? admissionSha256 = null) =>
        $"{{\"schema\":\"{SetupLayout.PointerSchema}\",\"generation\":\"{generation}\"," +
        $"\"inventoryDigest\":\"{new string('b', 64)}\"," +
        $"\"runtimeAdmissionSha256\":\"{admissionSha256 ?? AdmissionDigest(generation)}\"}}";

    /// <summary>
    /// The admission digest the pointer for this generation must carry: the hash of the admission file this test writes
    /// into that generation, which is what a launch verifies.
    /// </summary>
    private static string AdmissionDigest(string generation) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"admission:{generation}"))).ToLowerInvariant();

    private sealed class ScratchProgramRoot : IDisposable
    {
        private readonly SetupLayout layout;

        internal ScratchProgramRoot()
        {
            var localApplicationData = Path.Combine(
                System.IO.Path.GetTempPath(), "GameBuddy.Desktop.Tests", "upgrade-retention", Guid.NewGuid().ToString("N"));
            layout = SetupLayout.Resolve(localApplicationData);
        }

        internal string ProgramRoot => layout.ProgramRoot;

        internal string GenerationsRoot => Path.Combine(layout.ProgramRoot, SetupLayout.GenerationsDirectoryName);

        internal string RollbackPointerPath => Path.Combine(layout.ProgramRoot, InstalledGenerationRetention.RollbackPointerFileName);

        internal string GenerationPath(string generation) => Path.Combine(GenerationsRoot, generation);

        internal void Install(string generation) =>
            GameBuddy.Setup.Program.LayPayloadIntoProgramRoot(Payload(generation), layout);

        internal string SelectedGeneration()
        {
            using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(
                Path.Combine(layout.ProgramRoot, SetupLayout.PointerFileName)));
            return document.RootElement.GetProperty("generation").GetString()!;
        }

        internal string RollbackGeneration()
        {
            using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(RollbackPointerPath));
            return document.RootElement.GetProperty("generation").GetString()!;
        }

        /// <summary>
        /// One sealed payload: the pointer, the generation's own files (including the admission sidecar the launcher
        /// verifies) and the launcher entry the installer requires at the root.
        /// </summary>
        private static MemoryStream Payload(string generation)
        {
            var buffer = new MemoryStream();
            using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
            {
                Write(archive, SetupLayout.PointerFileName, PointerFor(generation));
                Write(archive, $"{SetupLayout.GenerationsDirectoryName}/{generation}/main.js", "// generation payload");
                Write(
                    archive,
                    $"{SetupLayout.GenerationsDirectoryName}/{generation}/host-runtime-admission.json",
                    $"admission:{generation}");
                Write(archive, SetupLayout.LauncherEntryRelativePath, "launcher");
            }

            buffer.Position = 0;
            return buffer;
        }

        private static void Write(ZipArchive archive, string name, string content)
        {
            using var entry = archive.CreateEntry(name).Open();
            entry.Write(Encoding.UTF8.GetBytes(content));
        }

        public void Dispose()
        {
            var localApplicationData = layout.LocalApplicationData;
            if (Directory.Exists(localApplicationData)) Directory.Delete(localApplicationData, recursive: true);
        }
    }
}
