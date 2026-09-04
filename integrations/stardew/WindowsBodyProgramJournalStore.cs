using System.Text;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

/// <summary>
/// Mod-owned, scope-fixed journal on the admitted per-user Stardew data root.
/// The target and its temporary sibling are always on the same volume.
/// </summary>
internal sealed class WindowsBodyProgramJournalStore : IBodyProgramJournalStore
{
    internal const string SchemaNamespace = "BodyProgramJournal-v1";
    private const int MaximumPathLength = 240;
    private readonly string canonicalRoot;
    private readonly string targetPath;

    internal WindowsBodyProgramJournalStore(string canonicalRoot, BridgeScope scope)
    {
        ArgumentNullException.ThrowIfNull(canonicalRoot);
        ArgumentNullException.ThrowIfNull(scope);

        if (!scope.IsValid || !Path.IsPathFullyQualified(canonicalRoot))
            throw new ArgumentException("The journal root and scope must already be admitted.", nameof(canonicalRoot));

        string fullRoot;
        try
        {
            fullRoot = Path.GetFullPath(canonicalRoot);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new ArgumentException("The journal root is not a valid canonical path.", nameof(canonicalRoot), exception);
        }

        string suppliedRoot = canonicalRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (suppliedRoot.Length == 0)
            suppliedRoot = Path.GetPathRoot(fullRoot)!;
        if (!string.Equals(fullRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), suppliedRoot, StringComparison.OrdinalIgnoreCase)
            || !Directory.Exists(fullRoot)
            || (File.GetAttributes(fullRoot) & FileAttributes.ReparsePoint) != 0)
            throw new ArgumentException("The journal root is not an admitted canonical directory.", nameof(canonicalRoot));

        string scopeDirectory = Path.Combine(
            fullRoot,
            SchemaNamespace,
            scope.IntegrationId,
            scope.SaveId,
            scope.WorldId,
            scope.PlayerId,
            scope.CompanionId);
        string candidate = Path.Combine(scopeDirectory, "journal.json");
        if (candidate.Length > MaximumPathLength)
            throw new ArgumentException("The journal path is too long.", nameof(scope));

        this.canonicalRoot = fullRoot;
        this.targetPath = candidate;
    }

    public string? Read()
    {
        try
        {
            string? directory = Path.GetDirectoryName(this.targetPath);
            if (directory is null || !IsNonReparseDirectoryTree(this.canonicalRoot, directory) || !TryGetSafeTarget(this.targetPath, out _))
                return null;

            using FileStream stream = new(
                this.targetPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 4096,
                options: FileOptions.SequentialScan);
            using StreamReader reader = new(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            return reader.ReadToEnd();
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
        catch
        {
            return null;
        }
    }

    public bool TryWrite(string encodedState)
    {
        ArgumentNullException.ThrowIfNull(encodedState);
        string? temporaryPath = null;
        try
        {
            string directory = Path.GetDirectoryName(this.targetPath)!;
            if (!EnsureNonReparseDirectoryTree(this.canonicalRoot, directory))
                return false;
            temporaryPath = Path.Combine(directory, $".journal.{Guid.NewGuid():N}.tmp");

            using (FileStream stream = new(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 4096,
                options: FileOptions.WriteThrough))
            using (StreamWriter writer = new(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), 4096, leaveOpen: true))
            {
                writer.Write(encodedState);
                writer.Flush();
                stream.Flush(flushToDisk: true);
            }

            // This check is deliberately immediately before the path-based commit. Windows does
            // not expose an atomic "non-reparse path + replace" operation through this API; the
            // remaining rename/reparse race is therefore an explicit evidence gap, not hidden by
            // claiming that the preflight is a binding.
            if (!TryGetSafeTarget(this.targetPath, out bool targetExists))
                return false;

            if (targetExists)
                File.Replace(temporaryPath, this.targetPath, destinationBackupFileName: null);
            else
                File.Move(temporaryPath, this.targetPath);

            temporaryPath = null;
            return true;
        }
        catch
        {
            return false;
        }
        finally
        {
            if (temporaryPath is not null)
            {
                try { File.Delete(temporaryPath); }
                catch { /* A stale temp is never an authority. */ }
            }
        }
    }

    private static bool TryGetSafeTarget(string path, out bool exists)
    {
        exists = false;
        try
        {
            FileInfo file = new(path);
            if (file.LinkTarget is not null)
                return false;
            if (!file.Exists)
                return !new DirectoryInfo(path).Exists;

            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                return false;
            exists = true;
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool EnsureNonReparseDirectoryTree(string fullRoot, string directory)
    {
        try
        {
            string root = Path.GetFullPath(fullRoot);
            string current = root;
            string fullDirectory = Path.GetFullPath(directory);
            if (!IsPathWithinRoot(root, fullDirectory))
                return false;

            string relative = fullDirectory[root.Length..].TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            foreach (string segment in relative.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.Combine(current, segment);
                if (!Directory.Exists(current))
                {
                    // Create one level only. Directory.CreateDirectory(directory) could create
                    // several unchecked ancestors before the tree validation runs.
                    Directory.CreateDirectory(current);
                }

                if (!Directory.Exists(current) || (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    return false;
            }

            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsNonReparseDirectoryTree(string fullRoot, string directory)
    {
        try
        {
            string root = Path.GetFullPath(fullRoot);
            string current = Path.GetFullPath(directory);
            if (!IsPathWithinRoot(root, current))
                return false;
            while (true)
            {
                if (!Directory.Exists(current) || (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    return false;
                if (string.Equals(current.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                    return true;
                current = Path.GetDirectoryName(current)!;
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool IsPathWithinRoot(string root, string candidate)
    {
        string normalizedRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string normalizedCandidate = candidate.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return normalizedCandidate.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase)
            || string.Equals(candidate.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
    }
}
