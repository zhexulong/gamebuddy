using GameBuddy.Desktop.Tests.Fixtures;

namespace GameBuddy.Desktop.Tests;

public sealed class InstalledLauncherIntegrationTests
{
    [Fact]
    public async Task Launcher_uses_only_the_registered_root_for_admission_and_owns_guardian_control_eof()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        foreach (var directory in new[]
        {
            Path.Combine(generation.LocalApplicationData, "GameBuddy", "data"),
            Path.Combine(generation.LocalApplicationData, "GameBuddy", "operational"),
            Path.Combine(generation.LocalApplicationData, "GameBuddy", "presentation"),
        }) Directory.CreateDirectory(directory);
        var reader = new FixtureRegistrationReader(generation.LocalApplicationData);
        await using var supervisor = new GuardianSupervisor();
        Environment.SetEnvironmentVariable("GAMEBUDDY_ROOT", Path.Combine(generation.LocalApplicationData, "ambient-root-sentinel"));
        try
        {
            var result = await Program.RunForTestingAsync(reader, new FixtureLocalApplicationData(generation.LocalApplicationData), supervisor, CancellationToken.None);

            Assert.Equal(DesktopLaunchResult.GuardianStarted, result);
            Assert.Equal(1, reader.ReadCount);
        }
        finally
        {
            Environment.SetEnvironmentVariable("GAMEBUDDY_ROOT", null);
        }
    }

    private sealed class FixtureRegistrationReader(string localApplicationData) : ICurrentUserRootRegistrationReader
    {
        internal int ReadCount { get; private set; }

        public CurrentUserRootRegistrationRecord Read()
        {
            ReadCount++;
            return new CurrentUserRootRegistrationRecord(
                CurrentUserRootRegistration.SchemaVersion,
                Path.Combine(localApplicationData, "Programs", "GameBuddy"),
                Path.Combine(localApplicationData, "GameBuddy", "data"),
                Path.Combine(localApplicationData, "GameBuddy", "operational"),
                Path.Combine(localApplicationData, "GameBuddy", "presentation"));
        }
    }

    private sealed class FixtureLocalApplicationData(string path) : ILocalApplicationDataProvider
    {
        public string GetLocalApplicationDataPath() => path;
    }
}
