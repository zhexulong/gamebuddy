namespace GameBuddy.Desktop.Tests.Fixtures;

/// <summary>
/// The Node interpreter the Desktop test harness drives the canonical Host publisher and the
/// Node client fixtures with. It is a test-harness dependency only: it is never copied into,
/// advertised by, or admitted from a published generation.
/// </summary>
/// <remarks>
/// The repository's own scripts and launchers invoke `node` off PATH, so this fixture resolves
/// the same way rather than encoding one machine's install location. When no directory on PATH
/// holds a Node executable it fails with a named reason instead of falling back to a path that
/// may not exist.
/// </remarks>
internal static class TestNodeRuntime
{
    internal static string ResolveExecutable()
    {
        var probed = 0;
        foreach (var directory in PathDirectories())
        {
            probed++;
            string candidate;
            try { candidate = Path.Combine(directory, "node.exe"); }
            catch (ArgumentException) { continue; }
            if (File.Exists(candidate)) return candidate;
        }

        throw new InvalidOperationException($"test_node_runtime_unavailable:probed=PATH (node.exe in {probed} directories)");
    }

    private static IEnumerable<string> PathDirectories()
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(path)) yield break;
        foreach (var entry in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var directory = entry.Trim().Trim('"');
            if (directory.Length > 0) yield return directory;
        }
    }
}
