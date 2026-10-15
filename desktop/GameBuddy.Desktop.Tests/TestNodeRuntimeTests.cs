using GameBuddy.Desktop.Tests.Fixtures;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The Desktop fixtures resolve the Node interpreter they drive the Host publisher and the Node
/// client fixtures with off PATH, the way the repository's own scripts and launchers invoke it.
/// </summary>
public sealed class TestNodeRuntimeTests
{
    [Fact]
    public void ResolveExecutable_returns_the_node_binary_the_process_path_holds()
    {
        var executable = TestNodeRuntime.ResolveExecutable();

        Assert.True(File.Exists(executable));
        Assert.Equal("node.exe", Path.GetFileName(executable));
    }

    [Fact]
    public void ResolveExecutable_names_path_when_no_directory_holds_a_node_binary()
    {
        var previous = Environment.GetEnvironmentVariable("PATH");
        var emptyDirectory = Directory.CreateTempSubdirectory("gamebuddy-no-node-").FullName;
        try
        {
            Environment.SetEnvironmentVariable("PATH", emptyDirectory);

            var error = Assert.Throws<InvalidOperationException>(TestNodeRuntime.ResolveExecutable);

            Assert.Contains("test_node_runtime_unavailable", error.Message, StringComparison.Ordinal);
            Assert.Contains("PATH", error.Message, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", previous);
            Directory.Delete(emptyDirectory);
        }
    }
}
