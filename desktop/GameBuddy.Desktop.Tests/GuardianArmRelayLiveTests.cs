using System.Text.Json;
using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The live arm half of the Desktop guardian path, driven through the real
/// Desktop half instead of a stand-in relay.
///
/// The Host's own arm encoder is proven against the native through a thin
/// stand-in session (`host/src/composition/stardew/stardew-guardian-launch-native-parity.test.ts`);
/// the Host/bootstrap gate composition that the Chat/Tavern live gate uses
/// answers only `hello` and destroys the session on any other frame
/// (`tools/desktop-composition-launch.mjs`), so neither of them ever reaches the
/// real `DesktopHostBootstrapBroker`, `GuardianSupervisorLease.RelayResidentAsync`
/// or the private-pipe token injection. This test closes that gap for the arm
/// exchange: the production-shaped arm body is written to the real broker over
/// the authenticated session, the broker relays it to the real admitted
/// production Guardian image, and the acknowledgement it writes back is asserted
/// to be the native's own `armed` result.
/// </summary>
public sealed class GuardianArmRelayLiveTests(Xunit.Abstractions.ITestOutputHelper output)
{
    [Fact]
    public async Task Published_native_guardian_arms_through_the_real_desktop_broker_and_supervisor()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        generation.ReplaceHostRuntimeWithFixture();
        var registration = new CurrentUserRootRegistrationRecord(
            CurrentUserRootRegistration.SchemaVersion,
            generation.ProgramRoot,
            Path.Combine(generation.LocalApplicationData, "GameBuddy", "data"),
            Path.Combine(generation.LocalApplicationData, "GameBuddy", "operational"),
            Path.Combine(generation.LocalApplicationData, "GameBuddy", "presentation"));
        foreach (var path in new[] { registration.DataRoot, registration.OperationalRoot, registration.PresentationRoot })
            Directory.CreateDirectory(path);
        TestDeploymentManifest.WriteDeploymentManifest(registration.OperationalRoot);
        var layout = CurrentUserRootLayout.DeriveForTesting(registration, new LocalApplicationDataProvider(generation.LocalApplicationData));
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);
        await using var runtime = new InstalledHostRuntimeAdmission().Admit(selection);
        await using var supervisor = new RuntimeSupervisor();
        await using var host = await supervisor.StartHostAsync(selection, runtime, layout, CancellationToken.None);
        await File.ReadAllTextAsync(Path.Combine(layout.DataRoot, "desktop-host-runtime-fixture.ready")).WaitAsync(TimeSpan.FromSeconds(10));

        // The admitted image must be the generation's PUBLISHED production pair,
        // never the test-hook variant: the point of this test is the real native.
        await using var guardianSupervisor = new GuardianSupervisor();
        await using var image = await new InstalledGenerationAdmission(layout).AdmitGuardianAsync(selection, CancellationToken.None);
        Assert.Equal(generation.GuardianExePath, image.VerifiedAbsolutePath, StringComparer.OrdinalIgnoreCase);
        await using var guardian = await guardianSupervisor.StartResidentAsync(image, CancellationToken.None);
        await host.AttachResidentGuardianAsync(guardian, CancellationToken.None);

        File.WriteAllText(Path.Combine(layout.DataRoot, "broker-arm-live.trigger"), "arm");
        var acksPath = Path.Combine(layout.DataRoot, "broker-arm-live.acks.jsonl");
        var deadline = DateTimeOffset.UtcNow.AddSeconds(60);
        while (!File.Exists(acksPath) && DateTimeOffset.UtcNow < deadline) await Task.Delay(25);
        Assert.True(File.Exists(acksPath), "the real Desktop broker never answered the arm/launch/contain exchange");

        // The arm body the broker relayed is the production ParseArm key set: the
        // correlation triple, the four durable arm binding facts, and the approved
        // executable - and nothing from the launch facts bag.
        using var armBody = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(layout.DataRoot, "broker-arm-live.arm-body.json")));
        var armKeys = armBody.RootElement.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray();
        Assert.Equal(
            new[] { "aiJobName", "approvedExecutable", "attemptId", "guardianEpoch", "guardianInstanceId", "leaseName", "playerJobName", "revision" },
            armKeys);
        using var launchBody = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(layout.DataRoot, "broker-arm-live.launch-body.json")));
        Assert.Equal(
            new[] { "arguments", "attemptId", "cwd", "deadlineUnixMs", "environment", "executable", "guardianEpoch", "guardianInstanceId", "planId", "role" },
            launchBody.RootElement.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray());
        Assert.Equal(armBody.RootElement.GetProperty("approvedExecutable").GetString(), launchBody.RootElement.GetProperty("executable").GetString());

        var acks = (await File.ReadAllLinesAsync(acksPath)).Where(line => line.Length > 0).Select(line => JsonDocument.Parse(line)).ToArray();
        try
        {
            Assert.Equal(3, acks.Length);
            foreach (var ack in acks)
            {
                var answer = ack.RootElement;
                Assert.Equal("gamebuddy-desktop-guardian-session/v1", answer.GetProperty("schema").GetString());
                Assert.Equal(1, answer.GetProperty("protocolVersion").GetInt32());
                Assert.Equal(armBody.RootElement.GetProperty("guardianInstanceId").GetString(), answer.GetProperty("guardianInstanceId").GetString());
                Assert.Equal(armBody.RootElement.GetProperty("attemptId").GetString(), answer.GetProperty("attemptId").GetString());
            }
            // The broker's acknowledgement status is the status `RelayResidentAsync`
            // accepted from the native itself, which requires the native's own
            // public result (`armed` / `role_active` / `role_contained`) first.
            Assert.Equal("arm_attempt", acks[0].RootElement.GetProperty("operation").GetString());
            Assert.Equal("armed", acks[0].RootElement.GetProperty("status").GetString());
            Assert.Equal("launch_role", acks[1].RootElement.GetProperty("operation").GetString());
            Assert.Equal("role_active", acks[1].RootElement.GetProperty("status").GetString());
            Assert.Equal("player_host", acks[1].RootElement.GetProperty("role").GetString());
            Assert.Equal("contain_role", acks[2].RootElement.GetProperty("operation").GetString());
            Assert.Equal("role_contained", acks[2].RootElement.GetProperty("status").GetString());
            output.WriteLine($"admitted-guardian-image={image.VerifiedAbsolutePath}");
            output.WriteLine($"arm-body-keys={string.Join(",", armKeys)}");
            foreach (var ack in acks) output.WriteLine($"ack={ack.RootElement.GetRawText()}");
        }
        finally
        {
            foreach (var ack in acks) ack.Dispose();
        }

        File.WriteAllText(Path.Combine(layout.DataRoot, "desktop-host-runtime-fixture.ready.exit"), "exit");
    }

    private sealed class LocalApplicationDataProvider(string path) : ILocalApplicationDataProvider
    {
        public string GetLocalApplicationDataPath() => path;
    }
}
