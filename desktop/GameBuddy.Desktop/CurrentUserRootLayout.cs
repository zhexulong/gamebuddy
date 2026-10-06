namespace GameBuddy.Desktop;

internal sealed class RootLayoutUnavailableException : Exception
{
    internal RootLayoutUnavailableException() : base("GameBuddy root layout is unavailable.")
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

    private static CurrentUserRootLayout Derive(CurrentUserRootRegistrationRecord registration, ILocalApplicationDataProvider localApplicationDataProvider)
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

        var local = Canonicalize(localApplicationData);
        // The program root is the one root the installed-layout marker carries,
        // and it must stay inside this user's LocalApplicationData: the marker
        // may never redirect a root outside the fixed per-user layout.
        var programRoot = Canonicalize(registration.ProgramRoot);
        var dataRoot = Canonicalize(Path.Combine(local, "GameBuddy", "data"));
        var operationalRoot = Canonicalize(Path.Combine(local, "GameBuddy", "operational"));
        var presentationRoot = Canonicalize(Path.Combine(local, "GameBuddy", "presentation"));

        foreach (var boundary in new[] { programRoot, dataRoot, operationalRoot, presentationRoot })
        {
            EnsureNoReparseBoundary(local, boundary);
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

    private static void EnsureNoReparseBoundary(string localApplicationData, string boundary)
    {
        var relative = Path.GetRelativePath(localApplicationData, boundary);
        if (Path.IsPathFullyQualified(relative) || relative == ".." || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new RootLayoutUnavailableException();
        }

        var current = localApplicationData;
        EnsureOrdinaryDirectory(current);
        foreach (var segment in relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            if (string.IsNullOrEmpty(segment))
            {
                continue;
            }

            current = Path.Combine(current, segment);
            EnsureOrdinaryDirectory(current);
        }
    }

    private static void EnsureOrdinaryDirectory(string path)
    {
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
