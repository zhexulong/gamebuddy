namespace GameBuddy.Desktop.Tests;

public sealed class HostBootstrapSupervisorTests
{
    [Fact]
    public void Supervisor_source_binds_only_the_admitted_runtime_and_fixed_bootstrap_entry_to_CreateProcess()
    {
        var source = File.ReadAllText(SupervisorSource());

        Assert.Contains("WindowsNative.ToExtendedLengthPath(runtime.RuntimePath)", source, StringComparison.Ordinal);
        Assert.Contains("new StringBuilder(Quote(WindowsNative.ToExtendedLengthPath(runtime.BootstrapPath)))", source, StringComparison.Ordinal);
        Assert.Contains("WindowsNative.CreateProcess(runtimePath, commandLine", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Process.Start", source, StringComparison.Ordinal);
        Assert.DoesNotContain("PATH", source, StringComparison.Ordinal);
        Assert.DoesNotContain("new GuardianSupervisor", source, StringComparison.Ordinal);
        Assert.DoesNotContain("StartResidentAsync", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Runtime_lease_source_exposes_only_the_guardian_lease_attach_seam()
    {
        var source = File.ReadAllText(SupervisorSource());
        var leaseSource = source[source.IndexOf("internal sealed class RuntimeSupervisorLease", StringComparison.Ordinal)..];

        Assert.Contains("AttachResidentGuardianAsync(GuardianSupervisorLease guardian", leaseSource, StringComparison.Ordinal);
        Assert.DoesNotContain("new GuardianSupervisor", leaseSource, StringComparison.Ordinal);
        Assert.DoesNotContain("StartResidentAsync", leaseSource, StringComparison.Ordinal);
    }

    [Fact]
    public void Supervisor_source_uses_exact_two_handle_list_and_authenticates_child_before_the_single_frame()
    {
        var source = File.ReadAllText(SupervisorSource());
        var authentication = source.IndexOf("VerifyCreatedProcessBeforeFrame(process, processInformation.ProcessId, runtime.RuntimePath)", StringComparison.Ordinal);
        var write = source.IndexOf("HostBootstrapPipeIo.WriteOneFrameAsync(parentStdinWriter, frame", StringComparison.Ordinal);

        Assert.True(authentication >= 0 && authentication < write);
        Assert.Contains("Marshal.AllocHGlobal(checked(IntPtr.Size * 2))", source, StringComparison.Ordinal);
        Assert.Contains("childStdinReader.DangerousGetHandle()", source, StringComparison.Ordinal);
        Assert.Contains("childStdoutWriter.DangerousGetHandle()", source, StringComparison.Ordinal);
        Assert.Contains("WindowsNative.GetProcessId(process) != expectedProcessId", source, StringComparison.Ordinal);
        Assert.Contains("WindowsNative.OpenProcessToken(child", source, StringComparison.Ordinal);
        Assert.Contains("WindowsNative.EqualSid(currentSid, childSid)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Supervisor_source_requires_the_acknowledged_exact_child_to_remain_unsignaled_before_leasing()
    {
        var source = File.ReadAllText(SupervisorSource());
        var acknowledgement = source.IndexOf("var ack = await ReadOneAcknowledgementAsync", StringComparison.Ordinal);
        var exitCodeCheck = source.IndexOf("if (!WindowsNative.GetExitCodeProcess(process, out _) ||", acknowledgement, StringComparison.Ordinal);
        var activeCheck = source.IndexOf("WindowsNative.WaitForSingleObject(process, 0) != WindowsNative.WaitTimeout", acknowledgement, StringComparison.Ordinal);
        var transfer = source.IndexOf("var locks = runtime.TransferLocks()", acknowledgement, StringComparison.Ordinal);

        Assert.True(acknowledgement >= 0 && exitCodeCheck > acknowledgement && activeCheck > exitCodeCheck && transfer > activeCheck);
        Assert.DoesNotContain("exitCode != WindowsNative.StillActive", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Supervisor_source_releases_all_pipe_endpoints_when_second_pipe_setup_fails()
    {
        var source = File.ReadAllText(SupervisorSource());
        var secondPipe = source.IndexOf("WindowsNative.CreatePipe(out parentStdoutReader, out childStdoutWriter", StringComparison.Ordinal);
        var cleanup = source.IndexOf("catch\n        {\n            childStdinReader.Dispose();", secondPipe, StringComparison.Ordinal);

        var parentStdoutCleanup = source.IndexOf("parentStdoutReader?.Dispose();", cleanup, StringComparison.Ordinal);
        var childStdoutCleanup = source.IndexOf("childStdoutWriter?.Dispose();", parentStdoutCleanup, StringComparison.Ordinal);

        Assert.True(secondPipe >= 0 && cleanup > secondPipe && parentStdoutCleanup > cleanup && childStdoutCleanup > parentStdoutCleanup);
        Assert.Contains("parentStdoutReader = null!;", source, StringComparison.Ordinal);
        Assert.Contains("childStdoutWriter = null!;", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Supervisor_source_releases_the_first_sid_when_second_sid_read_fails()
    {
        var source = File.ReadAllText(SupervisorSource());

        Assert.Contains("var currentSid = IntPtr.Zero;", source, StringComparison.Ordinal);
        Assert.Contains("var childSid = IntPtr.Zero;", source, StringComparison.Ordinal);
        Assert.Contains("currentSid = ReadTokenUserSid(currentToken);", source, StringComparison.Ordinal);
        Assert.Contains("childSid = ReadTokenUserSid(childToken);", source, StringComparison.Ordinal);
        Assert.Contains("if (currentSid != IntPtr.Zero) Marshal.FreeHGlobal(currentSid);", source, StringComparison.Ordinal);
        Assert.Contains("if (childSid != IntPtr.Zero) Marshal.FreeHGlobal(childSid);", source, StringComparison.Ordinal);
        Assert.Contains("var buffer = Marshal.AllocHGlobal(checked((int)required));", source, StringComparison.Ordinal);
        Assert.Contains("finally\n        {\n            Marshal.FreeHGlobal(buffer);", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Supervisor_source_uses_one_bounded_strict_frame_and_ack_with_redacted_lease()
    {
        var source = File.ReadAllText(SupervisorSource());

        Assert.Contains("private const int MaxWireBytes = 32_768", source, StringComparison.Ordinal);
        Assert.Contains("writer.WriteString(\"schema\", \"gamebuddy-desktop-host-bootstrap/v1\")", source, StringComparison.Ordinal);
        Assert.Contains("writer.WritePropertyName(\"rootLayout\")", source, StringComparison.Ordinal);
        Assert.Contains("ValidateOneWireDocument(bytes)", source, StringComparison.Ordinal);
        Assert.Contains("ExactPropertiesInOrder(ack", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ProcessId { get", source, StringComparison.Ordinal);
        Assert.DoesNotContain("RuntimePath { get", source[source.IndexOf("internal sealed class RuntimeSupervisorLease", StringComparison.Ordinal)..], StringComparison.Ordinal);
        Assert.DoesNotContain("BootstrapPath { get", source[source.IndexOf("internal sealed class RuntimeSupervisorLease", StringComparison.Ordinal)..], StringComparison.Ordinal);
    }

    [Fact]
    public void Supervisor_source_uses_synchronous_pipe_workers_that_cancel_and_drain_before_timeout_failure()
    {
        var source = File.ReadAllText(SupervisorSource());

        Assert.Contains("internal static class HostBootstrapPipeIo", source, StringComparison.Ordinal);
        Assert.Contains("isAsync: false", source, StringComparison.Ordinal);
        Assert.DoesNotContain("isAsync: true", source, StringComparison.Ordinal);
        Assert.Contains("TaskCreationOptions.LongRunning", source, StringComparison.Ordinal);
        Assert.Contains("WindowsNative.CancelSynchronousIo(worker)", source, StringComparison.Ordinal);
        Assert.Contains("endpoint?.Dispose()", source, StringComparison.Ordinal);
        Assert.Contains("await Task.Factory.StartNew", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Supervisor_source_terminates_waits_and_then_disposes_a_host_after_bootstrap_or_authentication_failure()
    {
        var source = File.ReadAllText(SupervisorSource());
        var authentication = source.IndexOf("await broker.AuthenticateHostAsync(process, timeout.Token)", StringComparison.Ordinal);
        var cleanup = source.IndexOf("if (process is not null)", authentication, StringComparison.Ordinal);
        var launched = source.IndexOf("if (launched)", cleanup, StringComparison.Ordinal);
        var terminate = source.IndexOf("WindowsNative.TerminateProcess(process, 1)", launched, StringComparison.Ordinal);
        var wait = source.IndexOf("WindowsNative.WaitForSingleObject(process, 30_000)", terminate, StringComparison.Ordinal);
        var dispose = source.IndexOf("process.Dispose()", wait, StringComparison.Ordinal);

        Assert.True(authentication >= 0 && cleanup > authentication && launched > cleanup && terminate > launched && wait > terminate && dispose > wait);
    }

    [Fact]
    public void Supervisor_source_deletes_an_initialized_attribute_list_only_after_second_stage_initialization()
    {
        var source = File.ReadAllText(SupervisorSource());

        var initialized = source.IndexOf("attributeListInitialized = true;", StringComparison.Ordinal);
        var delete = source.IndexOf("if (attributeListInitialized) WindowsNative.DeleteProcThreadAttributeList(attributeList);", StringComparison.Ordinal);
        Assert.True(initialized >= 0 && delete > initialized);
    }

    [Fact]
    public void Runtime_admission_source_uses_the_pointer_bound_sidecar_runtime_digest_without_a_desktop_digest_authority()
    {
        var source = File.ReadAllText(RuntimeAdmissionSource());

        Assert.Contains("!InstalledGenerationPaths.ValidDigest(value.GetProperty(\"runtimeSha256\").GetString())", source, StringComparison.Ordinal);
        Assert.Contains("var runtimeSha256 = value.GetProperty(\"runtimeSha256\").GetString()!;", source, StringComparison.Ordinal);
        Assert.Contains("AdmitFile(selection.GenerationRoot, RuntimePath, runtimeSha256)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("private const string RuntimeSha256", source, StringComparison.Ordinal);
    }

    private static string SupervisorSource() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "RuntimeSupervisor.cs"));
    private static string RuntimeAdmissionSource() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "InstalledHostRuntimeAdmission.cs"));
}
