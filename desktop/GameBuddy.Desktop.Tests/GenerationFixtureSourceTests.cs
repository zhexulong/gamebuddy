using GameBuddy.Desktop.Tests.Fixtures;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The installed generation these tests run against can be supplied prebuilt instead of being published
/// on the spot, which is what stops an unrelated in-flight Host edit from reddening the whole assembly.
/// A supplied root is admitted structurally and never substituted by a build, so these cases pin both
/// the shape that is accepted and every refusal: a fixture the harness cannot use must say so.
/// </summary>
public sealed class GenerationFixtureSourceTests
{
    [Fact]
    public async Task Supplied_generation_root_is_accepted_only_in_the_publishers_own_shape()
    {
        await using var root = await GenerationRootFixture.CreateAsync(builder =>
        {
            builder.WriteCurrentPointer();
            builder.WriteGeneration("g-fixture-1", hostRuntimeAdmission: true, runtimeNode: true);
        });

        Assert.Equal(root.Path, DisposableInstalledGuardianGeneration.RequirePublishedGenerationRoot(root.Path));
    }

    [Fact]
    public async Task Supplied_generation_root_without_a_current_pointer_is_refused()
    {
        await using var root = await GenerationRootFixture.CreateAsync(builder => builder.WriteGeneration("g-fixture-1", hostRuntimeAdmission: true, runtimeNode: true));

        Assert.Contains(
            "desktop_test_generation_fixture_current_pointer_missing",
            Assert.Throws<InvalidOperationException>(() => DisposableInstalledGuardianGeneration.RequirePublishedGenerationRoot(root.Path)).Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task Supplied_generation_root_with_more_than_one_generation_is_refused()
    {
        await using var root = await GenerationRootFixture.CreateAsync(builder =>
        {
            builder.WriteCurrentPointer();
            builder.WriteGeneration("g-fixture-1", hostRuntimeAdmission: true, runtimeNode: true);
            builder.WriteGeneration("g-fixture-2", hostRuntimeAdmission: true, runtimeNode: true);
        });

        Assert.Contains(
            "desktop_test_generation_fixture_generation_count:2",
            Assert.Throws<InvalidOperationException>(() => DisposableInstalledGuardianGeneration.RequirePublishedGenerationRoot(root.Path)).Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task Supplied_generation_root_without_host_runtime_admission_is_refused()
    {
        await using var root = await GenerationRootFixture.CreateAsync(builder =>
        {
            builder.WriteCurrentPointer();
            builder.WriteGeneration("g-fixture-1", hostRuntimeAdmission: false, runtimeNode: true);
        });

        Assert.Contains(
            "desktop_test_generation_fixture_host_runtime_admission_missing",
            Assert.Throws<InvalidOperationException>(() => DisposableInstalledGuardianGeneration.RequirePublishedGenerationRoot(root.Path)).Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task Supplied_generation_root_without_its_runtime_is_refused()
    {
        await using var root = await GenerationRootFixture.CreateAsync(builder =>
        {
            builder.WriteCurrentPointer();
            builder.WriteGeneration("g-fixture-1", hostRuntimeAdmission: true, runtimeNode: false);
        });

        Assert.Contains(
            "desktop_test_generation_fixture_runtime_missing",
            Assert.Throws<InvalidOperationException>(() => DisposableInstalledGuardianGeneration.RequirePublishedGenerationRoot(root.Path)).Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Empty_supplied_generation_path_is_refused()
    {
        Assert.Contains(
            "desktop_test_generation_fixture_path_empty",
            Assert.Throws<InvalidOperationException>(() => DisposableInstalledGuardianGeneration.RequirePublishedGenerationRoot("   ")).Message,
            StringComparison.Ordinal);
    }

    /// <summary>A disposable skeleton of the publisher's output root, with each piece optional.</summary>
    private sealed class GenerationRootFixture : IAsyncDisposable
    {
        private GenerationRootFixture(string path) => Path = path;

        internal string Path { get; }

        internal static Task<GenerationRootFixture> CreateAsync(Action<Builder> compose)
        {
            var path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "GameBuddy.Desktop.Tests", "generation-fixture", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(path);
            compose(new Builder(path));
            return Task.FromResult(new GenerationRootFixture(path));
        }

        public ValueTask DisposeAsync()
        {
            if (Directory.Exists(Path)) Directory.Delete(Path, recursive: true);
            return ValueTask.CompletedTask;
        }

        internal sealed class Builder(string root)
        {
            internal void WriteCurrentPointer() => File.WriteAllText(System.IO.Path.Combine(root, "current.json"), "{\"schema\":\"gamebuddy-host-production-current/v2\"}\n");

            internal void WriteGeneration(string id, bool hostRuntimeAdmission, bool runtimeNode)
            {
                var generation = System.IO.Path.Combine(root, "generations", id);
                Directory.CreateDirectory(generation);
                if (hostRuntimeAdmission) File.WriteAllText(System.IO.Path.Combine(generation, "host-runtime-admission.json"), "{}\n");
                if (!runtimeNode) return;
                Directory.CreateDirectory(System.IO.Path.Combine(generation, "runtime"));
                File.WriteAllBytes(System.IO.Path.Combine(generation, "runtime", "node.exe"), []);
            }
        }
    }
}
