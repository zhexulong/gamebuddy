using Microsoft.Win32;

namespace GameBuddy.Desktop;

internal sealed record CurrentUserRootRegistrationRecord(
    string Schema,
    string ProgramRoot,
    string DataRoot,
    string OperationalRoot,
    string PresentationRoot);

internal sealed record CurrentUserRegistrationValue(object Value, RegistryValueKind Kind);

internal interface ICurrentUserRegistrationStore
{
    IReadOnlyDictionary<string, CurrentUserRegistrationValue>? ReadValues();

    void SetString(string name, string value);

    void Delete();
}

internal interface ILocalApplicationDataProvider
{
    string GetLocalApplicationDataPath();
}

// Internal test seam: callers supply registration authority, never a root path.
internal interface ICurrentUserRootRegistrationReader
{
    CurrentUserRootRegistrationRecord Read();
}

internal sealed class RootRegistrationUnavailableException : Exception
{
    internal RootRegistrationUnavailableException() : base("GameBuddy root registration is unavailable.")
    {
    }
}

internal static class CurrentUserRootRegistration
{
    internal const string SchemaVersion = "gamebuddy-windows-root-registration/v1";
    internal const string RegistrySubKey = @"Software\GameBuddy\Registration\v1";

    private static readonly string[] RequiredValueNames =
    [
        "schema",
        "programRoot",
        "dataRoot",
        "operationalRoot",
        "presentationRoot",
    ];

    internal static void CreateForCurrentUser() =>
        Create(new WindowsCurrentUserRegistrationStore(), new WindowsLocalApplicationDataProvider());

    internal static CurrentUserRootRegistrationRecord ReadForCurrentUser() =>
        Read(new WindowsCurrentUserRegistrationStore(), new WindowsLocalApplicationDataProvider());

    internal static void RemoveForCurrentUserAfterCallerPolicy() =>
        new WindowsCurrentUserRegistrationStore().Delete();

    internal static void CreateForTesting(ICurrentUserRegistrationStore store, ILocalApplicationDataProvider localApplicationDataProvider) =>
        Create(store, localApplicationDataProvider);

    internal static CurrentUserRootRegistrationRecord ReadForTesting(ICurrentUserRegistrationStore store, ILocalApplicationDataProvider localApplicationDataProvider) =>
        Read(store, localApplicationDataProvider);

    private static void Create(ICurrentUserRegistrationStore store, ILocalApplicationDataProvider localApplicationDataProvider)
    {
        ArgumentNullException.ThrowIfNull(store);
        var expected = ExpectedRecord(localApplicationDataProvider);
        var values = store.ReadValues();
        if (values is not null && values.Count != 0 && !HasOnlyRequiredNames(values.Keys))
        {
            throw new RootRegistrationUnavailableException();
        }

        if (values is not null)
        {
            foreach (var (name, value) in Values(expected))
            {
                if (values.TryGetValue(name, out var existing) &&
                    (existing.Kind != RegistryValueKind.String || existing.Value is not string existingString || !StringComparer.Ordinal.Equals(existingString, value)))
                {
                    throw new RootRegistrationUnavailableException();
                }
            }
        }

        foreach (var (name, value) in Values(expected))
        {
            store.SetString(name, value);
        }
    }

    private static CurrentUserRootRegistrationRecord Read(ICurrentUserRegistrationStore store, ILocalApplicationDataProvider localApplicationDataProvider)
    {
        ArgumentNullException.ThrowIfNull(store);
        var values = store.ReadValues();
        if (values is null || !HasOnlyRequiredNames(values.Keys))
        {
            throw new RootRegistrationUnavailableException();
        }

        var expected = ExpectedRecord(localApplicationDataProvider);
        foreach (var (name, value) in Values(expected))
        {
            if (!values.TryGetValue(name, out var stored) ||
                stored.Kind != RegistryValueKind.String ||
                stored.Value is not string storedString ||
                !StringComparer.Ordinal.Equals(storedString, value))
            {
                throw new RootRegistrationUnavailableException();
            }
        }

        return expected;
    }

    private static CurrentUserRootRegistrationRecord ExpectedRecord(ILocalApplicationDataProvider localApplicationDataProvider)
    {
        ArgumentNullException.ThrowIfNull(localApplicationDataProvider);
        var localApplicationData = localApplicationDataProvider.GetLocalApplicationDataPath();
        if (string.IsNullOrWhiteSpace(localApplicationData) || !Path.IsPathFullyQualified(localApplicationData))
        {
            throw new RootRegistrationUnavailableException();
        }

        var local = Canonicalize(localApplicationData);
        return new CurrentUserRootRegistrationRecord(
            SchemaVersion,
            Path.Combine(local, "Programs", "GameBuddy"),
            Path.Combine(local, "GameBuddy", "data"),
            Path.Combine(local, "GameBuddy", "operational"),
            Path.Combine(local, "GameBuddy", "presentation"));
    }

    private static bool HasOnlyRequiredNames(IEnumerable<string> valueNames) =>
        valueNames.OrderBy(name => name, StringComparer.Ordinal).SequenceEqual(RequiredValueNames.OrderBy(name => name, StringComparer.Ordinal), StringComparer.Ordinal);

    private static IEnumerable<(string Name, string Value)> Values(CurrentUserRootRegistrationRecord record)
    {
        yield return ("schema", record.Schema);
        yield return ("programRoot", record.ProgramRoot);
        yield return ("dataRoot", record.DataRoot);
        yield return ("operationalRoot", record.OperationalRoot);
        yield return ("presentationRoot", record.PresentationRoot);
    }

    private static string Canonicalize(string path) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));

    private sealed class WindowsLocalApplicationDataProvider : ILocalApplicationDataProvider
    {
        public string GetLocalApplicationDataPath() => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    }

    private sealed class WindowsCurrentUserRegistrationStore : ICurrentUserRegistrationStore
    {
        public IReadOnlyDictionary<string, CurrentUserRegistrationValue>? ReadValues()
        {
            using var key = Registry.CurrentUser.OpenSubKey(RegistrySubKey, writable: false);
            if (key is null)
            {
                return null;
            }

            return key.GetValueNames().ToDictionary(
                name => name,
                name => new CurrentUserRegistrationValue(
                    key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) ?? string.Empty,
                    key.GetValueKind(name)),
                StringComparer.Ordinal);
        }

        public void SetString(string name, string value)
        {
            using var key = Registry.CurrentUser.CreateSubKey(RegistrySubKey, writable: true)
                ?? throw new RootRegistrationUnavailableException();
            key.SetValue(name, value, RegistryValueKind.String);
        }

        public void Delete() => Registry.CurrentUser.DeleteSubKeyTree(RegistrySubKey, throwOnMissingSubKey: false);
    }
}
