using GameBuddy.Desktop.Tests.Fixtures;

namespace GameBuddy.Desktop.Tests;

public sealed class CurrentUserRootRegistrationTests
{
    [Fact]
    public async Task ReadRegisteredLayout_rejects_missing_or_unknown_schema()
    {
        await using var roots = await DisposableRootFixture.CreateAsync();
        using var missing = DisposableCurrentUserRegistration.CreateMissing();
        Assert.Throws<RootRegistrationUnavailableException>(() => CurrentUserRootRegistration.ReadForTesting(missing, roots));

        using var unknown = DisposableCurrentUserRegistration.Create();
        unknown.WriteRaw("gamebuddy-windows-root-registration/v0");
        Assert.Throws<RootRegistrationUnavailableException>(() => CurrentUserRootRegistration.ReadForTesting(unknown, roots));
    }

    [Fact]
    public async Task CreateThenRead_is_idempotent_and_contains_only_fixed_v1_fields()
    {
        await using var roots = await DisposableRootFixture.CreateAsync();
        using var fixture = DisposableCurrentUserRegistration.Create();

        CurrentUserRootRegistration.CreateForTesting(fixture, roots);
        CurrentUserRootRegistration.CreateForTesting(fixture, roots);
        var registration = CurrentUserRootRegistration.ReadForTesting(fixture, roots);

        Assert.Equal(CurrentUserRootRegistration.SchemaVersion, registration.Schema);
        Assert.Equal(DisposableCurrentUserRegistration.ExpectedValueNames, fixture.ValueNames());
    }

    [Fact]
    public async Task ReadRegisteredLayout_rejects_extra_or_changed_values()
    {
        await using var roots = await DisposableRootFixture.CreateAsync();
        using var fixture = DisposableCurrentUserRegistration.Create();
        CurrentUserRootRegistration.CreateForTesting(fixture, roots);
        fixture.WriteExtraValue();
        Assert.Throws<RootRegistrationUnavailableException>(() => CurrentUserRootRegistration.ReadForTesting(fixture, roots));

        using var changed = DisposableCurrentUserRegistration.Create();
        CurrentUserRootRegistration.CreateForTesting(changed, roots);
        changed.WriteValue("dataRoot", @"C:\foreign");
        Assert.Throws<RootRegistrationUnavailableException>(() => CurrentUserRootRegistration.ReadForTesting(changed, roots));
    }
}
