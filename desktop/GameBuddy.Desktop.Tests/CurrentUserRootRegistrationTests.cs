using GameBuddy.Desktop.Tests.Fixtures;
using Microsoft.Win32;

namespace GameBuddy.Desktop.Tests;

public sealed class CurrentUserRootRegistrationTests
{
    [Fact]
    public void ReadRegisteredLayout_rejects_missing_marker()
    {
        var missing = DisposableCurrentUserRegistration.CreateMissing();

        Assert.Throws<RootRegistrationUnavailableException>(() => CurrentUserRootRegistration.ReadForTesting(missing));
    }

    [Fact]
    public void ReadRegisteredLayout_rejects_unsupported_schema_version()
    {
        var fixture = DisposableCurrentUserRegistration.CreateForProgramRoot(@"C:\Programs\GameBuddy");
        fixture.WriteValue(CurrentUserRootRegistration.SchemaValueName, "gamebuddy-windows-root-registration/v0");

        Assert.Throws<RootRegistrationUnavailableException>(() => CurrentUserRootRegistration.ReadForTesting(fixture));
    }

    [Fact]
    public void ReadRegisteredLayout_rejects_malformed_values()
    {
        // A marker value that is not a REG_SZ string is malformed.
        var wrongKind = DisposableCurrentUserRegistration.CreateForProgramRoot(@"C:\Programs\GameBuddy");
        wrongKind.WriteRawValue(CurrentUserRootRegistration.ProgramRootValueName, 1, RegistryValueKind.DWord);
        Assert.Throws<RootRegistrationUnavailableException>(() => CurrentUserRootRegistration.ReadForTesting(wrongKind));

        // An empty or relative program root is malformed, not a fallback to a dev root.
        var emptyRoot = DisposableCurrentUserRegistration.CreateForProgramRoot(@"C:\Programs\GameBuddy");
        emptyRoot.WriteValue(CurrentUserRootRegistration.ProgramRootValueName, "   ");
        Assert.Throws<RootRegistrationUnavailableException>(() => CurrentUserRootRegistration.ReadForTesting(emptyRoot));

        var relativeRoot = DisposableCurrentUserRegistration.CreateForProgramRoot(@"C:\Programs\GameBuddy");
        relativeRoot.WriteValue(CurrentUserRootRegistration.ProgramRootValueName, @"Programs\GameBuddy");
        Assert.Throws<RootRegistrationUnavailableException>(() => CurrentUserRootRegistration.ReadForTesting(relativeRoot));

        // A missing required value name is malformed.
        Assert.Throws<RootRegistrationUnavailableException>(() => CurrentUserRootRegistration.ReadForTesting(new ProgramRootLessMarker()));
    }

    [Fact]
    public void ReadRegisteredLayout_reads_only_the_schema_and_program_root()
    {
        var fixture = DisposableCurrentUserRegistration.CreateForProgramRoot(@"C:\Programs\GameBuddy");

        var registration = CurrentUserRootRegistration.ReadForTesting(fixture);

        Assert.Equal(CurrentUserRootRegistration.SchemaVersion, registration.Schema);
        Assert.Equal(@"C:\Programs\GameBuddy", registration.ProgramRoot);
        Assert.Equal(
            [CurrentUserRootRegistration.ProgramRootValueName, CurrentUserRootRegistration.SchemaValueName],
            DisposableCurrentUserRegistration.ExpectedValueNames);
        Assert.Equal(DisposableCurrentUserRegistration.ExpectedValueNames, fixture.ValueNames());
    }

    private sealed class ProgramRootLessMarker : ICurrentUserRegistrationStore
    {
        private readonly DisposableCurrentUserRegistration inner =
            DisposableCurrentUserRegistration.CreateForProgramRoot(@"C:\Programs\GameBuddy");

        public IReadOnlyDictionary<string, CurrentUserRegistrationValue>? ReadValues()
        {
            var values = ((ICurrentUserRegistrationStore)inner).ReadValues()!;
            return values
                .Where(pair => !StringComparer.Ordinal.Equals(pair.Key, CurrentUserRootRegistration.ProgramRootValueName))
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        }
    }
}
