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

    private CurrentUserRootLayout(CurrentUserRootRegistrationRecord registration)
    {
        ProgramRoot = registration.ProgramRoot;
        DataRoot = registration.DataRoot;
        OperationalRoot = registration.OperationalRoot;
        PresentationRoot = registration.PresentationRoot;
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

        var localApplicationData = localApplicationDataProvider.GetLocalApplicationDataPath();
        if (string.IsNullOrWhiteSpace(localApplicationData) || !Path.IsPathFullyQualified(localApplicationData))
        {
            throw new RootLayoutUnavailableException();
        }

        var local = Canonicalize(localApplicationData);
        var expected = new[]
        {
            Path.Combine(local, "Programs", "GameBuddy"),
            Path.Combine(local, "GameBuddy", "data"),
            Path.Combine(local, "GameBuddy", "operational"),
            Path.Combine(local, "GameBuddy", "presentation"),
        };
        var actual = new[]
        {
            Canonicalize(registration.ProgramRoot),
            Canonicalize(registration.DataRoot),
            Canonicalize(registration.OperationalRoot),
            Canonicalize(registration.PresentationRoot),
        };

        if (!StringComparer.Ordinal.Equals(registration.Schema, CurrentUserRootRegistration.SchemaVersion) ||
            !actual.SequenceEqual(expected, StringComparer.Ordinal))
        {
            throw new RootLayoutUnavailableException();
        }

        for (var index = 0; index < actual.Length; index++)
        {
            EnsureNoReparseBoundary(local, actual[index]);
            for (var other = index + 1; other < actual.Length; other++)
            {
                if (Overlaps(actual[index], actual[other]))
                {
                    throw new RootLayoutUnavailableException();
                }
            }
        }

        return new CurrentUserRootLayout(new CurrentUserRootRegistrationRecord(
            registration.Schema,
            actual[0],
            actual[1],
            actual[2],
            actual[3]));
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
