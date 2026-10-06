namespace GameBuddy.Desktop;

internal sealed class RootLayoutUnavailableException : Exception
{
    internal RootLayoutUnavailableException() : base("GameBuddy root layout is unavailable.")
    {
    }
}

// The launcher-owned pre-launch provisioning step has its own failure, and it is
// deliberately not the layout's: refusing to create a mutable root through a
// reparse boundary is a different event from a registered layout that cannot be
// derived, and the entry names them apart so an operator can tell which one ran.
internal sealed class MutableRootsUnavailableException : Exception
{
    internal MutableRootsUnavailableException() : base("GameBuddy mutable roots are unavailable.")
    {
    }

    internal MutableRootsUnavailableException(Exception innerException)
        : base("GameBuddy mutable roots are unavailable.", innerException)
    {
    }
}

internal sealed class CurrentUserRootLayout
{
    internal string ProgramRoot { get; }
    internal string DataRoot { get; }
    internal string OperationalRoot { get; }
    internal string PresentationRoot { get; }

    private CurrentUserRootLayout(string programRoot, string dataRoot, string operationalRoot, string presentationRoot)
    {
        ProgramRoot = programRoot;
        DataRoot = dataRoot;
        OperationalRoot = operationalRoot;
        PresentationRoot = presentationRoot;
    }

    internal static CurrentUserRootLayout DeriveForCurrentUser() =>
        Derive(CurrentUserRootRegistration.ReadForCurrentUser(), new WindowsLocalApplicationDataProvider());

    internal static CurrentUserRootLayout DeriveForTesting(CurrentUserRootRegistrationRecord registration, ILocalApplicationDataProvider localApplicationDataProvider) =>
        Derive(registration, localApplicationDataProvider);

    internal static CurrentUserRootLayout DeriveForTesting(ICurrentUserRootRegistrationReader reader, ILocalApplicationDataProvider localApplicationDataProvider)
    {
        ArgumentNullException.ThrowIfNull(reader);
        return Derive(reader.Read(), localApplicationDataProvider);
    }

    /// <summary>
    /// The launcher-owned pre-launch provisioning step. The three mutable roots are
    /// ordinary directories derived from the current user's LocalApplicationData and
    /// nothing in the product creates them, so the very first launch must or the
    /// first layout read fails closed. This creates exactly those three, walking each
    /// path with the same boundary validation the derivation uses, so a reparse or
    /// non-ordinary boundary is refused rather than adopted; it is not a second
    /// validator and it adds no hash, signature or attestation chain. It never
    /// creates the program root (Setup installs that), it creates only directories,
    /// and it is idempotent: an existing ordinary directory is left exactly as it is.
    /// </summary>
    internal static void ProvisionMutableRootsForCurrentUser() =>
        ProvisionMutableRoots(CurrentUserRootRegistration.ReadForCurrentUser(), new WindowsLocalApplicationDataProvider());

    internal static void ProvisionMutableRoots(CurrentUserRootRegistrationRecord registration, ILocalApplicationDataProvider localApplicationDataProvider)
    {
        ArgumentNullException.ThrowIfNull(registration);
        ArgumentNullException.ThrowIfNull(localApplicationDataProvider);
        var local = CanonicalLocalApplicationData(registration, localApplicationDataProvider);
        foreach (var mutableRoot in MutableRoots(local))
        {
            try
            {
                EnsureNoReparseBoundary(local, mutableRoot, createMissing: true);
            }
            catch (RootLayoutUnavailableException exception)
            {
                throw new MutableRootsUnavailableException(exception);
            }
        }
    }

    private static CurrentUserRootLayout Derive(CurrentUserRootRegistrationRecord registration, ILocalApplicationDataProvider localApplicationDataProvider)
    {
        var local = CanonicalLocalApplicationData(registration, localApplicationDataProvider);
        // The program root is the one root the installed-layout marker carries,
        // and it must stay inside this user's LocalApplicationData: the marker
        // may never redirect a root outside the fixed per-user layout.
        var programRoot = Canonicalize(registration.ProgramRoot);
        var mutableRoots = MutableRoots(local);
        var dataRoot = mutableRoots[0];
        var operationalRoot = mutableRoots[1];
        var presentationRoot = mutableRoots[2];

        foreach (var boundary in new[] { programRoot, dataRoot, operationalRoot, presentationRoot })
        {
            EnsureNoReparseBoundary(local, boundary, createMissing: false);
        }

        // The program root may be a generation parent (Programs\GameBuddy) or a
        // generation child; either way it must not overlap a mutable root.
        if (Overlaps(programRoot, dataRoot) || Overlaps(programRoot, operationalRoot) || Overlaps(programRoot, presentationRoot) ||
            Overlaps(dataRoot, operationalRoot) || Overlaps(dataRoot, presentationRoot) || Overlaps(operationalRoot, presentationRoot))
        {
            throw new RootLayoutUnavailableException();
        }

        return new CurrentUserRootLayout(programRoot, dataRoot, operationalRoot, presentationRoot);
    }

    private static string CanonicalLocalApplicationData(CurrentUserRootRegistrationRecord registration, ILocalApplicationDataProvider localApplicationDataProvider)
    {
        ArgumentNullException.ThrowIfNull(registration);
        ArgumentNullException.ThrowIfNull(localApplicationDataProvider);

        if (!StringComparer.Ordinal.Equals(registration.Schema, CurrentUserRootRegistration.SchemaVersion))
        {
            throw new RootLayoutUnavailableException();
        }

        var localApplicationData = localApplicationDataProvider.GetLocalApplicationDataPath();
        if (string.IsNullOrWhiteSpace(localApplicationData) || !Path.IsPathFullyQualified(localApplicationData))
        {
            throw new RootLayoutUnavailableException();
        }

        return Canonicalize(localApplicationData);
    }

    // One derivation of the three mutable roots, shared by the derivation and the
    // provisioning step so the two can never disagree about which roots they own.
    private static string[] MutableRoots(string local) =>
    [
        Canonicalize(Path.Combine(local, "GameBuddy", "data")),
        Canonicalize(Path.Combine(local, "GameBuddy", "operational")),
        Canonicalize(Path.Combine(local, "GameBuddy", "presentation")),
    ];

    private static void EnsureNoReparseBoundary(string localApplicationData, string boundary, bool createMissing)
    {
        var relative = Path.GetRelativePath(localApplicationData, boundary);
        if (Path.IsPathFullyQualified(relative) || relative == ".." || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new RootLayoutUnavailableException();
        }

        var current = localApplicationData;
        // The current user's LocalApplicationData is never created here: grouping every
        // boundary under one rule keeps this about the layout's own roots, and a missing
        // LocalApplicationData is a broken environment rather than a missing root.
        EnsureOrdinaryDirectory(current, createMissing: false);
        foreach (var segment in relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            if (string.IsNullOrEmpty(segment))
            {
                continue;
            }

            current = Path.Combine(current, segment);
            EnsureOrdinaryDirectory(current, createMissing);
        }
    }

    /// <summary>
    /// A boundary component is an ordinary directory or the layout is refused. With
    /// <paramref name="createMissing"/> the component is created when it is absent -
    /// ordinary directory creation, nothing else - and is then validated by the same
    /// rule, so a reparse point or a file standing where a directory belongs is still
    /// refused instead of being adopted.
    /// </summary>
    private static void EnsureOrdinaryDirectory(string path, bool createMissing)
    {
        if (!Directory.Exists(path))
        {
            if (!createMissing)
            {
                throw new RootLayoutUnavailableException();
            }

            try
            {
                Directory.CreateDirectory(path);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                throw new RootLayoutUnavailableException();
            }
        }

        if (!Directory.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        {
            throw new RootLayoutUnavailableException();
        }
    }

    private static bool Overlaps(string first, string second) =>
        IsSameOrChild(first, second) || IsSameOrChild(second, first);

    private static bool IsSameOrChild(string candidate, string ancestor) =>
        StringComparer.Ordinal.Equals(candidate, ancestor) ||
        candidate.StartsWith(ancestor + Path.DirectorySeparatorChar, StringComparison.Ordinal);

    private static string Canonicalize(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
        {
            throw new RootLayoutUnavailableException();
        }

        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
    }

    private sealed class WindowsLocalApplicationDataProvider : ILocalApplicationDataProvider
    {
        public string GetLocalApplicationDataPath() => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    }
}
