using Microsoft.Win32;

namespace GameBuddy.Desktop;

// The installed-layout marker is deliberately this small: the registration
// schema version and the installed program root. The mutable roots (data,
// operational, presentation) are derived from the current user's
// LocalApplicationData on every read, so the marker can never redirect them.
internal sealed record CurrentUserRootRegistrationRecord(
    string Schema,
    string ProgramRoot);

internal sealed record CurrentUserRegistrationValue(object Value, RegistryValueKind Kind);

// Read-only by construction: the launcher has no way to create, change or
// remove the registration. Setup and the uninstaller are its only writers.
internal interface ICurrentUserRegistrationStore
{
    IReadOnlyDictionary<string, CurrentUserRegistrationValue>? ReadValues();
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
    internal const string SchemaValueName = "schema";
    internal const string ProgramRootValueName = "programRoot";

    internal static CurrentUserRootRegistrationRecord ReadForCurrentUser() =>
        Read(new WindowsCurrentUserRegistrationStore());

    internal static CurrentUserRootRegistrationRecord ReadForTesting(ICurrentUserRegistrationStore store) =>
        Read(store);

    private static CurrentUserRootRegistrationRecord Read(ICurrentUserRegistrationStore store)
    {
        ArgumentNullException.ThrowIfNull(store);
        var values = store.ReadValues();
        if (values is null)
        {
            throw new RootRegistrationUnavailableException();
        }

        var schema = ReadRequiredString(values, SchemaValueName);
        var programRoot = ReadRequiredString(values, ProgramRootValueName);
        if (!StringComparer.Ordinal.Equals(schema, SchemaVersion) || !Path.IsPathFullyQualified(programRoot))
        {
            throw new RootRegistrationUnavailableException();
        }

        return new CurrentUserRootRegistrationRecord(SchemaVersion, programRoot);
    }

    private static string ReadRequiredString(IReadOnlyDictionary<string, CurrentUserRegistrationValue> values, string name)
    {
        if (!values.TryGetValue(name, out var stored) ||
            stored.Kind != RegistryValueKind.String ||
            stored.Value is not string text ||
            string.IsNullOrWhiteSpace(text))
        {
            throw new RootRegistrationUnavailableException();
        }

        return text;
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
    }
}
