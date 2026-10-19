using System.IO.Compression;
using System.Text;
using GameBuddy.Setup;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The installer's half of the packaging contract: the archive it embeds is the one
/// `host/scripts/package-player-distribution.mjs` seals, and what it lays into the program
/// root has to be a root the launcher can be invoked from. Every case drives that step
/// directly, against a scratch LocalApplicationData and a synthetic archive, so what is
/// measured is the extract -> verify boundary and never the current user's registry.
/// </summary>
public sealed class SetupPayloadWiringTests
{
    [Fact]
    public void LayPayloadIntoProgramRoot_lays_the_launcher_beside_the_pointer_and_its_generation()
    {
        using var scratch = new ScratchLocalApplicationData();
        var layout = SetupLayout.Resolve(scratch.Path);

        GameBuddy.Setup.Program.LayPayloadIntoProgramRoot(SealedPayload("gen-1"), layout);

        Assert.True(File.Exists(Path.Combine(layout.ProgramRoot, SetupLayout.LauncherEntryRelativePath)));
        Assert.True(File.Exists(Path.Combine(layout.ProgramRoot, SetupLayout.PointerFileName)));
        Assert.True(Directory.Exists(Path.Combine(layout.ProgramRoot, SetupLayout.GenerationsDirectoryName, "gen-1")));
    }

    [Fact]
    public void LayPayloadIntoProgramRoot_refuses_a_pointer_naming_a_generation_the_payload_does_not_carry()
    {
        using var scratch = new ScratchLocalApplicationData();
        var layout = SetupLayout.Resolve(scratch.Path);

        AssertRefuses(SealedPayload("gen-1", pointerGeneration: "gen-2"), layout);
    }

    [Fact]
    public void LayPayloadIntoProgramRoot_refuses_a_payload_whose_only_generation_carries_no_launcher()
    {
        using var scratch = new ScratchLocalApplicationData();
        var layout = SetupLayout.Resolve(scratch.Path);

        AssertRefuses(SealedPayload("gen-1", withLauncher: false), layout);
    }

    [Fact]
    public void LayPayloadIntoProgramRoot_refuses_an_entry_that_escapes_the_program_root()
    {
        using var scratch = new ScratchLocalApplicationData();
        var layout = SetupLayout.Resolve(scratch.Path);

        AssertRefuses(SealedPayload("gen-1", escapingEntry: "../escaped.txt"), layout);

        Assert.False(File.Exists(Path.Combine(scratch.Path, "escaped.txt")));
        Assert.False(File.Exists(Path.Combine(scratch.Path, "Programs", "escaped.txt")));
    }

    private static void AssertRefuses(Stream payload, SetupLayout layout)
    {
        var exception = Assert.Throws<SetupException>(() => GameBuddy.Setup.Program.LayPayloadIntoProgramRoot(payload, layout));
        Assert.Equal(SetupFailure.PayloadUnavailable, exception.Failure);
    }

    private static MemoryStream SealedPayload(
        string generation,
        bool withLauncher = true,
        string? pointerGeneration = null,
        string? escapingEntry = null)
    {
        var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            Write(archive, SetupLayout.PointerFileName, $"{{\"schema\":\"{SetupLayout.PointerSchema}\",\"generation\":\"{pointerGeneration ?? generation}\"}}");
            Write(archive, $"{SetupLayout.GenerationsDirectoryName}/{generation}/main.js", "// generation payload");
            if (withLauncher)
            {
                Write(archive, SetupLayout.LauncherEntryRelativePath, "launcher");
            }

            if (escapingEntry is not null)
            {
                Write(archive, escapingEntry, "escaped");
            }
        }

        buffer.Position = 0;
        return buffer;
    }

    private static void Write(ZipArchive archive, string name, string content)
    {
        using var entry = archive.CreateEntry(name).Open();
        entry.Write(Encoding.UTF8.GetBytes(content));
    }

    private sealed class ScratchLocalApplicationData : IDisposable
    {
        internal ScratchLocalApplicationData()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "GameBuddy.Desktop.Tests", "setup-payload", Guid.NewGuid().ToString("N"));
        }

        internal string Path { get; }

        public void Dispose()
        {
            if (Directory.Exists(Path))
            {
                Directory.Delete(Path, recursive: true);
            }
        }
    }
}
