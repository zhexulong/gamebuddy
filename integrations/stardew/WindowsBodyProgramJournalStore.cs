using System.Text;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

/// <summary>
/// Mod-owned, scope-fixed journal on the admitted per-user Stardew data root.
/// The target and its temporary sibling are always on the same volume, and one
/// scope path is held by at most one live writer through the scope lease below.
/// </summary>
internal sealed class WindowsBodyProgramJournalStore : IBodyProgramJournalStore, IDisposable
{
    internal const string SchemaNamespace = "BodyProgramJournal-v1";

    /// <summary>
    /// Named reason this store reports when another live store already holds the
    /// same scope path. Two writers on one scope path would each commit a
    /// complete state replacement, so one of them would silently drop the
    /// other's authority transitions; the second writer fails closed instead.
    /// </summary>
    internal const string ScopeContendedReason = "body_program_journal_scope_contended";

    private const int MaximumPathLength = 240;

    /// <summary>
    /// ERROR_SHARING_VIOLATION as an HRESULT: the operating system's own proof
    /// that an existing handle denies sharing this path. Any other IOException
    /// from the same open is a different failure and is not reported as scope
    /// contention.
    /// </summary>
    private const int SharingViolationHResult = unchecked((int)0x80070020);
    private readonly string canonicalRoot;
    private readonly string targetPath;
    private readonly string leasePath;
    private readonly object lifecycleGate = new();
    private FileStream? scopeLease;
    private bool closed;

    /// <summary>
    /// The named reason a write failed closed for. Only a lost scope lease has a
    /// name here; a successful write and every other failure both leave it null,
    /// so the returned boolean stays the verdict and this is only the one case a
    /// caller cannot otherwise tell apart from a generic persistence failure.
    /// </summary>
    internal string? ScopeContentionReason { get; private set; }

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
        this.leasePath = Path.Combine(scopeDirectory, ".journal.lock");
    }

    internal void Close()
    {
        lock (this.lifecycleGate)
        {
            this.closed = true;
            this.scopeLease?.Dispose();
            this.scopeLease = null;
        }
    }

    /// <summary>
    /// The disposable-surface twin of <see cref="Close"/>. The scope lease is a
    /// real retained handle, so the store is a disposable resource; the Mod
    /// lifecycle still closes it by name at its own close point.
    /// </summary>
    public void Dispose() => this.Close();

    public BodyProgramJournalReadResult Read()
    {
        lock (this.lifecycleGate)
        {
            if (this.closed)
                return new(BodyProgramJournalReadStatus.ReadFailed, null);
            return this.ReadCore();
        }
    }

    private BodyProgramJournalReadResult ReadCore()
    {
        try
        {
            string? directory = Path.GetDirectoryName(this.targetPath);
            if (directory is null)
                return new(BodyProgramJournalReadStatus.ReadFailed, null);
            if (!IsNonReparseDirectoryTree(this.canonicalRoot, directory, out bool directoryAbsent))
                return new(BodyProgramJournalReadStatus.ReadFailed, null);
            if (directoryAbsent)
                return new(BodyProgramJournalReadStatus.Empty, null);

            if (!TryGetSafeTarget(this.targetPath, out bool targetExists))
                return new(BodyProgramJournalReadStatus.ReadFailed, null);
            if (!targetExists)
                return new(BodyProgramJournalReadStatus.Empty, null);

            using FileStream stream = new(
                this.targetPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 4096,
                options: FileOptions.SequentialScan);
            using StreamReader reader = new(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            return new(BodyProgramJournalReadStatus.Present, reader.ReadToEnd());
        }
        catch (FileNotFoundException)
        {
            return ReadAbsentOrFailed();
        }
        catch (DirectoryNotFoundException)
        {
            return ReadAbsentOrFailed();
        }
        catch
        {
            return new(BodyProgramJournalReadStatus.ReadFailed, null);
        }
    }

    private BodyProgramJournalReadResult ReadAbsentOrFailed()
    {
        string? directory = Path.GetDirectoryName(this.targetPath);
        if (directory is null || !IsNonReparseDirectoryTree(this.canonicalRoot, directory, out bool directoryAbsent))
            return new(BodyProgramJournalReadStatus.ReadFailed, null);
        if (directoryAbsent || (TryGetSafeTarget(this.targetPath, out bool targetExists) && !targetExists))
            return new(BodyProgramJournalReadStatus.Empty, null);
        return new(BodyProgramJournalReadStatus.ReadFailed, null);
    }

    public bool TryWrite(string encodedState)
    {
        ArgumentNullException.ThrowIfNull(encodedState);
        lock (this.lifecycleGate)
        {
            if (this.closed)
                return false;
            return this.TryWriteCore(encodedState);
        }
    }

    private bool TryWriteCore(string encodedState)
    {
        string? temporaryPath = null;
        try
        {
            string directory = Path.GetDirectoryName(this.targetPath)!;
            if (!EnsureNonReparseDirectoryTree(this.canonicalRoot, directory))
                return false;
            if (!this.TryHoldScopeLease(out bool contended))
            {
                this.ScopeContentionReason = contended ? ScopeContendedReason : null;
                return false;
            }
            this.ScopeContentionReason = null;
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

            // The commit point. The temp was created as a literal sibling of the
            // target, so the rename below cannot cross a volume boundary: the
            // same-volume precondition is a property of how the temp is named,
            // not a probe that could fail. The preflight is deliberately
            // immediately before the path-based commit and is not claimed to be
            // a binding: Windows exposes no atomic "non-reparse path + replace"
            // operation through this API, so a reparse substitution landing
            // between the check and the rename is the one residual race. It is
            // recorded here rather than hidden, and it is left open because
            // closing it needs handle-relative NtCreateFile opens, a native
            // boundary this store does not own.
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

    /// <summary>
    /// Fails closed when another live store already holds this exact scope path,
    /// and holds that path for this store's write lifetime once it does. The
    /// guard is the operating system's own refusal of a second
    /// <see cref="FileShare.None"/> handle on the scope's lease file: the file's
    /// existence is never the lock, only a live retained handle is, so a lease
    /// file left behind by a crashed process is not a permanent refusal and no
    /// staleness rule has to be guessed here. Reads and the restart fence are
    /// deliberately unaffected: a reopened store may always read the committed
    /// target, and only a second writer is refused.
    /// </summary>
    private bool TryHoldScopeLease(out bool contended)
    {
        contended = false;
        if (this.scopeLease is not null)
            return true;
        try
        {
            if (!TryGetSafeTarget(this.leasePath, out _))
                return false;
            this.scopeLease = new FileStream(
                this.leasePath,
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None,
                bufferSize: 1,
                options: FileOptions.None);
            return true;
        }
        catch (IOException exception) when (exception.HResult == SharingViolationHResult)
        {
            contended = true;
            return false;
        }
        catch
        {
            return false;
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

            FileAttributes attributes;
            try
            {
                attributes = File.GetAttributes(path);
            }
            catch (FileNotFoundException)
            {
                return true;
            }
            catch (DirectoryNotFoundException)
            {
                return true;
            }

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

    private static bool IsNonReparseDirectoryTree(string fullRoot, string directory, out bool directoryAbsent)
    {
        directoryAbsent = false;
        try
        {
            string root = Path.GetFullPath(fullRoot);
            string fullDirectory = Path.GetFullPath(directory);
            if (!IsPathWithinRoot(root, fullDirectory)
                || !TryGetNonReparseDirectoryState(root, out bool rootExists)
                || !rootExists)
                return false;

            string current = root;
            string relative = fullDirectory[root.Length..].TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            foreach (string segment in relative.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.Combine(current, segment);
                if (!TryGetNonReparseDirectoryState(current, out bool exists))
                    return false;
                if (!exists)
                {
                    directoryAbsent = true;
                    return true;
                }
            }

            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryGetNonReparseDirectoryState(string path, out bool exists)
    {
        exists = false;
        try
        {
            DirectoryInfo directory = new(path);
            if (directory.LinkTarget is not null)
                return false;

            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
                return false;
            exists = true;
            return true;
        }
        catch (FileNotFoundException)
        {
            return true;
        }
        catch (DirectoryNotFoundException)
        {
            return true;
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
