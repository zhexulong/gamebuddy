using Microsoft.Win32;

namespace GameBuddy.Desktop.Tests.Fixtures;

// Models what Setup writes: the layout marker with the registration schema
// version and the installed program root. The launcher only ever reads it.
internal sealed class DisposableCurrentUserRegistration : ICurrentUserRegistrationStore
{
    internal static readonly string[] ExpectedValueNames =
    [
        "programRoot",
        "schema",
    ];

    private readonly Dictionary<string, CurrentUserRegistrationValue> values = new(StringComparer.Ordinal);
    private readonly bool exists;

    private DisposableCurrentUserRegistration(bool exists)
    {
        this.exists = exists;
    }

    internal static DisposableCurrentUserRegistration CreateMissing() => new(exists: false);

    internal static DisposableCurrentUserRegistration CreateForProgramRoot(string programRoot)
    {
        var fixture = new DisposableCurrentUserRegistration(exists: true);
        fixture.WriteValue(CurrentUserRootRegistration.SchemaValueName, CurrentUserRootRegistration.SchemaVersion);
        fixture.WriteValue(CurrentUserRootRegistration.ProgramRootValueName, programRoot);
        return fixture;
    }

    internal void WriteValue(string name, string value) =>
        values[name] = new CurrentUserRegistrationValue(value, RegistryValueKind.String);

    internal void WriteRawValue(string name, object value, RegistryValueKind kind) =>
        values[name] = new CurrentUserRegistrationValue(value, kind);

    internal string[] ValueNames() => values.Keys.OrderBy(name => name, StringComparer.Ordinal).ToArray();

    IReadOnlyDictionary<string, CurrentUserRegistrationValue>? ICurrentUserRegistrationStore.ReadValues() =>
        exists ? new Dictionary<string, CurrentUserRegistrationValue>(values, StringComparer.Ordinal) : null;
}
