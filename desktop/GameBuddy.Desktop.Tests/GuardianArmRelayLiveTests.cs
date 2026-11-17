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
            generation.ProgramRoot);
        var operationalRoot = Path.Combine(generation.LocalApplicationData, "GameBuddy", "operational");
        foreach (var path in new[] { Path.Combine(generation.LocalApplicationData, "GameBuddy", "data"), operationalRoot, Path.Combine(generation.LocalApplicationData, "GameBuddy", "presentation") })
            Directory.CreateDirectory(path);
        TestDeploymentManifest.WriteDeploymentManifest(operationalRoot);
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
        // A factory, not a lease: the broker creates the attempt's Guardian and settles it when the attempt
        // ends. This test only owns the ability to create one.
        await host.AttachResidentGuardianFactory(token => guardianSupervisor.StartResidentAsync(image, token), CancellationToken.None);

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

    /// <summary>
    /// Topology A end to end, through the real Desktop broker and two real resident Guardians (ADR-0015
    /// §3, §4.2, §4.3): attempt 1 arms, ends by closing its Host session, and attempt 2 - on a second
    /// authenticated session over the same one-instance pipe - arms a Guardian of its own.
    ///
    /// The ordering IS the claim, and it is read from the OS rather than inferred: the fixture writes its
    /// "attempt 2 is about to arm" marker BEFORE it writes that arm frame, so at the instant this test sees
    /// the marker, attempt 1's pid must already be gone. The launcher can only be in that state if it
    /// settled attempt 1 before it offered the pipe again.
    ///
    /// The record under the operational root is read on both sides of the boundary: it names attempt 1's
    /// exact process while that attempt is armed, names attempt 2's (a different one) while THAT attempt is
    /// armed, and is gone once the Host leaves, because leaving proved the process gone.
    /// </summary>
    [Fact]
    public async Task Two_attempts_run_back_to_back_and_the_first_guardian_is_gone_before_the_second_arms()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        generation.ReplaceHostRuntimeWithFixture();
        var registration = new CurrentUserRootRegistrationRecord(CurrentUserRootRegistration.SchemaVersion, generation.ProgramRoot);
        var operationalRoot = Path.Combine(generation.LocalApplicationData, "GameBuddy", "operational");
        foreach (var path in new[] { Path.Combine(generation.LocalApplicationData, "GameBuddy", "data"), operationalRoot, Path.Combine(generation.LocalApplicationData, "GameBuddy", "presentation") })
            Directory.CreateDirectory(path);
        TestDeploymentManifest.WriteDeploymentManifest(operationalRoot);
        var layout = CurrentUserRootLayout.DeriveForTesting(registration, new LocalApplicationDataProvider(generation.LocalApplicationData));
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);
        await using var runtime = new InstalledHostRuntimeAdmission().Admit(selection);
        await using var supervisor = new RuntimeSupervisor();
        await using var host = await supervisor.StartHostAsync(selection, runtime, layout, CancellationToken.None);
        await File.ReadAllTextAsync(Path.Combine(layout.DataRoot, "desktop-host-runtime-fixture.ready")).WaitAsync(TimeSpan.FromSeconds(10));

        await using var guardianSupervisor = new GuardianSupervisor();
        await using var image = await new InstalledGenerationAdmission(layout).AdmitGuardianAsync(selection, CancellationToken.None);
        Assert.Equal(generation.GuardianExePath, image.VerifiedAbsolutePath, StringComparer.OrdinalIgnoreCase);
        await host.AttachResidentGuardianFactory(token => guardianSupervisor.StartResidentAsync(image, token), CancellationToken.None);

        File.WriteAllText(Path.Combine(layout.DataRoot, "broker-attempt-pair.trigger"), "pair");
        var budget = TimeSpan.FromSeconds(180);
        var firstAck = await PairFileAsync(layout.DataRoot, "attempt1-ack", budget);
        Assert.Equal("armed", Status(firstAck));
        var firstRecord = await PairFileAsync(layout.DataRoot, "attempt1-record", budget);
        var firstPid = Pid(firstRecord);
        output.WriteLine($"attempt-1 pid={firstPid} record={firstRecord.Replace("\n", " ")}");
        Assert.True(Live(firstPid), $"attempt-1 pid {firstPid} must be resident while its attempt is armed");
        // The fixture holds attempt 1 open until this file exists, so the assertion above is about an
        // attempt that is still armed rather than about a record that outlived its own process.
        File.WriteAllText(Path.Combine(layout.DataRoot, "broker-attempt-pair.attempt1-observed"), "observed");

        await PairFileAsync(layout.DataRoot, "attempt2-sent", budget);
        var refused = Path.Combine(layout.DataRoot, "broker-attempt-pair.attempt2-refused");
        Assert.False(File.Exists(refused), $"the second session was refused: {(File.Exists(refused) ? await File.ReadAllTextAsync(refused) : string.Empty)}");
        Assert.False(Live(firstPid), $"attempt-1 pid {firstPid} was still alive when attempt 2 was armed");

        var secondAck = await PairFileAsync(layout.DataRoot, "attempt2-ack", budget);
        Assert.Equal("armed", Status(secondAck));
        var secondRecord = await PairFileAsync(layout.DataRoot, "attempt2-record", budget);
        var secondPid = Pid(secondRecord);
        output.WriteLine($"attempt-2 pid={secondPid} record={secondRecord.Replace("\n", " ")}");
        Assert.NotEqual(firstPid, secondPid);
        Assert.True(Live(secondPid), $"attempt-2 pid {secondPid} must be resident while its attempt is armed");
        // The record follows the attempt that is armed now, and there is only ever one of it.
        var secondBody = await PairFileAsync(layout.DataRoot, "attempt2", budget);
        Assert.Equal(Field(secondBody, "attemptId"), Field(secondRecord, "attemptId"));

        File.WriteAllText(Path.Combine(layout.DataRoot, "desktop-host-runtime-fixture.ready.exit"), "exit");
        Assert.True(await host.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(60)), "the Host session did not end");
        // The Host leaving ends the attempt it was driving: the settlement proves that process gone, and a
        // proven settlement is the one outcome that leaves no record behind.
        Assert.True(await Gone(secondPid, TimeSpan.FromSeconds(60)), $"attempt-2 pid {secondPid} outlived the Host session");
        Assert.False(File.Exists(Path.Combine(operationalRoot, "guardian-attempt", "guardian-attempt.json")), "a settlement that proved the process gone must retire its record");
    }

    private static async Task<string> PairFileAsync(string dataRoot, string name, TimeSpan budget)
    {
        var path = Path.Combine(dataRoot, "broker-attempt-pair." + name);
        var deadline = DateTimeOffset.UtcNow + budget;
        while (true)
        {
            // A harness that failed, or that was refused its second session, says so in its own words;
            // reporting "nothing happened" instead of that would hide the one fact worth reading.
            foreach (var recorded in new[] { "broker-attempt-pair.failed", "broker-attempt-pair.attempt2-refused" })
                if (File.Exists(Path.Combine(dataRoot, recorded))) throw new XunitException($"the fixture stopped before {name}: {await File.ReadAllTextAsync(Path.Combine(dataRoot, recorded))}");
            if (File.Exists(path)) return await File.ReadAllTextAsync(path);
            if (DateTimeOffset.UtcNow >= deadline) throw new XunitException($"the fixture never wrote {Path.GetFileName(path)}");
            await Task.Delay(25);
        }
    }

    private static string? Field(string json, string name)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.TryGetProperty(name, out var value) ? value.ToString() : null;
    }

    private static string? Status(string json) => Field(json, "status");

    private static uint Pid(string record)
    {
        using var document = JsonDocument.Parse(record);
        return document.RootElement.GetProperty("pid").GetUInt32();
    }

    private static bool Live(uint pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(checked((int)pid));
            return !process.HasExited;
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    private static async Task<bool> Gone(uint pid, TimeSpan budget)
    {
        var deadline = DateTimeOffset.UtcNow + budget;
        while (true)
        {
            if (!Live(pid)) return true;
            if (DateTimeOffset.UtcNow >= deadline) return false;
            await Task.Delay(25);
        }
    }

    private sealed class LocalApplicationDataProvider(string path) : ILocalApplicationDataProvider
    {
        public string GetLocalApplicationDataPath() => path;
    }
}
