using Microsoft.Win32;

namespace GameBuddy.Desktop.Tests.Fixtures;

internal sealed class DisposableCurrentUserRegistration : IDisposable, ICurrentUserRegistrationStore
{
    internal static readonly string[] ExpectedValueNames =
    [
        "dataRoot",
        "operationalRoot",
        "presentationRoot",
        "programRoot",
        "schema",
    ];

    private readonly Dictionary<string, CurrentUserRegistrationValue> values = new(StringComparer.Ordinal);
    private bool exists;

    private DisposableCurrentUserRegistration(bool exists)
    {
        this.exists = exists;
    }

    internal static DisposableCurrentUserRegistration Create() => new(exists: true);

    internal static DisposableCurrentUserRegistration CreateMissing() => new(exists: false);

    internal void WriteRaw(string schema) => WriteValue("schema", schema);

    internal void WriteExtraValue() => WriteValue("unexpected", "unexpected");

    internal void WriteValue(string name, string value)
    {
        exists = true;
        values[name] = new CurrentUserRegistrationValue(value, RegistryValueKind.String);
    }

    internal string[] ValueNames() => values.Keys.OrderBy(name => name, StringComparer.Ordinal).ToArray();

    IReadOnlyDictionary<string, CurrentUserRegistrationValue>? ICurrentUserRegistrationStore.ReadValues() =>
        exists ? new Dictionary<string, CurrentUserRegistrationValue>(values, StringComparer.Ordinal) : null;

    void ICurrentUserRegistrationStore.SetString(string name, string value)
    {
        exists = true;
        values[name] = new CurrentUserRegistrationValue(value, RegistryValueKind.String);
    }

    void ICurrentUserRegistrationStore.Delete()
    {
        exists = false;
        values.Clear();
    }

    public void Dispose()
    {
        exists = false;
        values.Clear();
    }
}
