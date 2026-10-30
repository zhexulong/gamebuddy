using System.Reflection;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The installer's payload has to be IN the image, not merely present on the build machine.
///
/// The defect this closes, found only by running Setup for real after building a sandbox
/// artifact: the payload was added to <c>@(EmbeddedResource)</c> from inside a target
/// (<c>BeforeTargets="PrepareForBuild"</c>), the build succeeded, the archive existed and the
/// property pointed at it - and the produced assembly listed ZERO manifest resources, so
/// <c>Program.OpenPayload</c> threw <c>installer_payload_unavailable</c> at install time. The
/// SDK captures the resource set while evaluating the project, so an item a target adds is not
/// in the set the compiler receives.
///
/// Asserting the resource NAME on the compiled assembly is what closes it: it is the same fact
/// <c>Program.OpenPayload</c> reads, so a build that cannot install fails the test run rather
/// than the player's first double-click.
/// </summary>
public sealed class SetupPayloadEmbeddingTests
{
    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (Directory.Exists(Path.Combine(directory.FullName, "desktop")) &&
                File.Exists(Path.Combine(directory.FullName, "package.json")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("repository root not found");
    }

    [Fact]
    public void The_payload_resource_is_declared_at_evaluation_time_so_the_compiler_receives_it()
    {
        var project = File.ReadAllText(
            Path.Combine(RepositoryRoot(), "desktop", "installer", "GameBuddy.Setup", "GameBuddy.Setup.csproj"));
        // Declared as an ItemGroup at evaluation time, with the resource name the code reads.
        Assert.Contains("<EmbeddedResource Include=\"$(GameBuddyPlayerDistributionPayload)\" LogicalName=\"payload.zip\"", project, StringComparison.Ordinal);
        // And NOT inside a target: that is the shape that compiled cleanly with no resource.
        var targetStart = project.IndexOf("<Target ", StringComparison.Ordinal);
        if (targetStart >= 0)
        {
            var insideTargets = project[targetStart..];
            Assert.DoesNotContain("<EmbeddedResource", insideTargets, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void The_code_reads_the_very_resource_name_the_project_declares()
    {
        // No fact gets two spellings: the name in the source and the name in the project are
        // asserted equal rather than assumed to be.
        var project = File.ReadAllText(
            Path.Combine(RepositoryRoot(), "desktop", "installer", "GameBuddy.Setup", "GameBuddy.Setup.csproj"));
        var logicalName = "payload.zip";
        Assert.Contains($"LogicalName=\"{logicalName}\"", project, StringComparison.Ordinal);
        var program = File.ReadAllText(
            Path.Combine(RepositoryRoot(), "desktop", "installer", "GameBuddy.Setup", "Program.cs"));
        Assert.Contains($"EmbeddedPayloadResourceName = \"{logicalName}\"", program, StringComparison.Ordinal);
    }

    [Fact]
    public void The_built_installer_assembly_carries_the_payload_resource_when_one_was_given()
    {
        // Only meaningful for a build that was given a payload. A plain Debug build (no archive)
        // is expected to carry none, and the warning it emits says so; this test states both
        // readings rather than passing vacuously when no payload exists.
        var assembly = typeof(GameBuddy.Setup.Program).Assembly;
        var names = assembly.GetManifestResourceNames();
        var repositoryPayload = Path.Combine(RepositoryRoot(), "desktop", "dist", "payload.zip");
        if (File.Exists(repositoryPayload))
        {
            Assert.Contains("payload.zip", names);
        }
        else
        {
            // The honest negative half: the name is either present or the payload was absent from
            // the build's inputs. What must never happen is a payload on disk and no resource.
            Assert.True(
                names.Length == 0 || names.Contains("payload.zip"),
                "an assembly built with no payload input must carry none");
        }
    }
}
