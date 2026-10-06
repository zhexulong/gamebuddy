using System.IO.Compression;
using System.Reflection;

namespace GameBuddy.Setup;

/// <summary>
/// The per-user installer. It is the only thing besides its own uninstaller that
/// writes the product registration, and the only thing that lays a generation
/// payload into the program root. It never needs elevation: everything it owns
/// lives under the current user's LocalApplicationData and current-user registry.
/// </summary>
internal static class Program
{
    private const string EmbeddedPayloadResourceName = "payload.zip";

    // The installed uninstaller runs on its own, so it is installed as the whole
    // framework-dependent application, not just its apphost.
    private static readonly string[] UninstallerExecutableSet =
    [
        "GameBuddy.Setup.exe",
        "GameBuddy.Setup.dll",
        "GameBuddy.Setup.deps.json",
        "GameBuddy.Setup.runtimeconfig.json",
    ];

    private static int Main(string[] args)
    {
        try
        {
            var request = SetupRequest.Parse(args);
            var layout = SetupLayout.Resolve(request.LocalApplicationData);
            if (request.Operation == SetupOperation.Install)
            {
                Install(layout, request);
            }
            else
            {
                Uninstall(layout, request);
            }

            Console.WriteLine(SetupOutcome.Code(SetupFailure.None));
            return 0;
        }
        catch (SetupException exception)
        {
            Console.Error.WriteLine(SetupOutcome.Code(exception.Failure));
            return 1;
        }
        catch (Exception)
        {
            // An unexpected failure is still a failed setup. The runtime's own
            // report would be a stack trace carrying installed paths, so it is
            // replaced by one bounded code.
            Console.Error.WriteLine(SetupOutcome.Code(SetupFailure.PayloadUnavailable));
            return 1;
        }
    }

    private static void Install(SetupLayout layout, SetupRequest request)
    {
        var payload = OpenPayload();
        // The ancestors are established first so a reparse point anywhere on the
        // fixed layout is refused before anything is written.
        layout.EnsureOrdinaryAncestors(layout.ProgramRoot);
        Directory.CreateDirectory(layout.ProgramRoot);
        ExtractPayload(payload, layout.ProgramRoot);
        VerifyInstalledProgramRoot(layout.ProgramRoot);
        InstallUninstaller(layout);
        SetupRegistration.Write(layout, request.DisplayVersion ?? CurrentDisplayVersion());
    }

    private static void Uninstall(SetupLayout layout, SetupRequest request)
    {
        if (SetupLayout.IsRunningFrom(layout.ProgramRoot))
        {
            // The uninstaller cannot delete the directory it is executing from.
            // It stages the removal and hands it to the command processor, which
            // runs after this process has exited.
            ScheduleProgramRootRemoval(layout, request);
        }
        else
        {
            RemoveProgramRoot(layout, request);
        }

        // Registration goes first in every case: a launcher that finds a program
        // root without a registration fails closed, which is the safe direction.
        SetupRegistration.Remove();
    }

    private static void RemoveProgramRoot(SetupLayout layout, SetupRequest request)
    {
        if (!Directory.Exists(layout.ProgramRoot))
        {
            return;
        }

        try
        {
            DeleteTreeIfPresent(layout.ProgramRoot);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new SetupException(SetupFailure.UninstallUnavailable);
        }

        RemoveDisposableRoots(layout, request);
    }

    private static void ScheduleProgramRootRemoval(SetupLayout layout, SetupRequest request)
    {
        var removals = string.Join(
            " & ",
            DisposableRootArguments(layout, request)
                .Where(Directory.Exists)
                .Select(path => $"rmdir /s /q \"{path}\" > nul 2>&1")
                .ToArray());
        // ping is the portable stand-in for `timeout`, which needs an interactive
        // console. The short delay lets this process exit so the running
        // uninstaller image is no longer locked when its directory is removed.
        var command = $"/c ping -n 3 127.0.0.1 > nul 2>&1 & {removals}";
        var start = new System.Diagnostics.ProcessStartInfo("cmd.exe", command)
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        };
        try
        {
            System.Diagnostics.Process.Start(start)?.Dispose();
        }
        catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            throw new SetupException(SetupFailure.UninstallUnavailable);
        }
    }

    private static void RemoveDisposableRoots(SetupLayout layout, SetupRequest request)
    {
        foreach (var root in DisposableRootArguments(layout, request).Skip(1))
        {
            DeleteTreeIfPresent(root);
        }
    }

    /// <summary>
    /// The preserve/purge policy: the first entry is the program root, which always
    /// goes. <c>operational</c> and <c>presentation</c> are disposable and always
    /// go. Durable <c>data</c> is preserved unless the caller asks for a purge.
    /// </summary>
    private static IEnumerable<string> DisposableRootArguments(SetupLayout layout, SetupRequest request)
    {
        yield return layout.ProgramRoot;
        yield return layout.OperationalRoot;
        yield return layout.PresentationRoot;
        if (request.PurgeData)
        {
            yield return layout.DataRoot;
        }
    }

    private static void DeleteTreeIfPresent(string path)
    {
        if (!Directory.Exists(path))
        {
            return;
        }

        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        {
            // Never follow a link out of the fixed layout.
            Directory.Delete(path, recursive: false);
            return;
        }

        Directory.Delete(path, recursive: true);
        PruneEmptyParents(Path.GetDirectoryName(path));
    }

    private static void PruneEmptyParents(string? directory)
    {
        while (!string.IsNullOrEmpty(directory) && Directory.Exists(directory))
        {
            try
            {
                if (Directory.EnumerateFileSystemEntries(directory).Any())
                {
                    return;
                }

                Directory.Delete(directory, recursive: false);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                return;
            }

            directory = Path.GetDirectoryName(directory);
        }
    }

    private static void InstallUninstaller(SetupLayout layout)
    {
        var running = Environment.ProcessPath
            ?? throw new SetupException(SetupFailure.UninstallUnavailable);
        var target = layout.UninstallerPath;
        var source = Path.GetDirectoryName(running)
            ?? throw new SetupException(SetupFailure.UninstallUnavailable);
        if (StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(running), Path.GetFullPath(target)))
        {
            // Already executing from the installed uninstaller location: copying a
            // running image onto itself would fail.
            return;
        }

        var targetDirectory = Path.GetDirectoryName(target)!;
        Directory.CreateDirectory(targetDirectory);
        // The framework-dependent app is more than its apphost: the uninstaller
        // must run on its own from the program root, without the Setup that
        // installed it and without any repository checkout.
        foreach (var file in UninstallerExecutableSet)
        {
            var sourceFile = Path.Combine(source, file);
            if (!File.Exists(sourceFile))
            {
                throw new SetupException(SetupFailure.UninstallUnavailable);
            }

            var targetFile = Path.Combine(targetDirectory, file);
            if (StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(sourceFile), Path.GetFullPath(targetFile)))
            {
                continue;
            }

            File.Copy(sourceFile, targetFile, overwrite: true);
        }
    }

    private static Stream OpenPayload()
    {
        var stream = typeof(Program).Assembly.GetManifestResourceStream(EmbeddedPayloadResourceName);
        return stream ?? throw new SetupException(SetupFailure.PayloadUnavailable);
    }

    /// <summary>
    /// Lays the embedded payload into the program root. Generations are immutable:
    /// the payload is the complete set of generations that may remain installed, so
    /// a generation the payload does not contain is removed rather than left to be
    /// selected by a stale pointer.
    /// </summary>
    private static void ExtractPayload(Stream payload, string programRoot)
    {
        var generationsRoot = Path.Combine(programRoot, SetupLayout.GenerationsDirectoryName);
        var staged = new List<string>();
        using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
        {
            foreach (var entry in archive.Entries)
            {
                if (entry.FullName.EndsWith('/'))
                {
                    continue;
                }

                var target = SafeTarget(programRoot, entry.FullName);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                entry.ExtractToFile(target, overwrite: true);
                if (target.StartsWith(generationsRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                {
                    var relative = Path.GetRelativePath(generationsRoot, target);
                    var generation = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)[0];
                    if (!staged.Contains(generation, StringComparer.Ordinal))
                    {
                        staged.Add(generation);
                    }
                }
            }
        }

        if (!Directory.Exists(generationsRoot))
        {
            return;
        }

        foreach (var existing in Directory.GetDirectories(generationsRoot))
        {
            if (!staged.Contains(Path.GetFileName(existing), StringComparer.Ordinal))
            {
                Directory.Delete(existing, recursive: true);
            }
        }
    }

    private static string SafeTarget(string programRoot, string entryName)
    {
        var target = Path.GetFullPath(Path.Combine(programRoot, entryName.Replace('/', Path.DirectorySeparatorChar)));
        if (!target.StartsWith(Path.TrimEndingDirectorySeparator(programRoot) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            throw new SetupException(SetupFailure.PayloadUnavailable);
        }

        return target;
    }

    /// <summary>
    /// The installed program root must be one the launcher can admit. A payload
    /// that is missing its pointer or the generation the pointer names is refused
    /// instead of being registered, so the installer never leaves a machine in a
    /// state where the product entry fails closed for a reason the player cannot act on.
    /// </summary>
    private static void VerifyInstalledProgramRoot(string programRoot)
    {
        var pointer = Path.Combine(programRoot, SetupLayout.PointerFileName);
        if (!File.Exists(pointer))
        {
            throw new SetupException(SetupFailure.PayloadUnavailable);
        }

        string? generation;
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(pointer));
            var root = document.RootElement;
            if (root.ValueKind != System.Text.Json.JsonValueKind.Object ||
                !root.TryGetProperty("schema", out var schema) ||
                !StringComparer.Ordinal.Equals(schema.GetString(), SetupLayout.PointerSchema) ||
                !root.TryGetProperty("generation", out var generationValue))
            {
                throw new SetupException(SetupFailure.PayloadUnavailable);
            }

            generation = generationValue.GetString();
        }
        catch (System.Text.Json.JsonException)
        {
            throw new SetupException(SetupFailure.PayloadUnavailable);
        }

        if (string.IsNullOrWhiteSpace(generation) || generation.Contains("..", StringComparison.Ordinal) ||
            generation.Contains('/', StringComparison.Ordinal) || generation.Contains('\\', StringComparison.Ordinal))
        {
            throw new SetupException(SetupFailure.PayloadUnavailable);
        }

        var generationRoot = Path.Combine(programRoot, SetupLayout.GenerationsDirectoryName, generation);
        if (!Directory.Exists(generationRoot))
        {
            throw new SetupException(SetupFailure.PayloadUnavailable);
        }
    }

    private static string CurrentDisplayVersion()
    {
        var informational = typeof(Program).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            var plus = informational.IndexOf('+');
            return plus < 0 ? informational : informational[..plus];
        }

        return typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0";
    }
}
