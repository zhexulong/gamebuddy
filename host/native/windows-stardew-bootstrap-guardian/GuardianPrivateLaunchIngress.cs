using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace GameBuddy.WindowsStardewBootstrapGuardian;

internal sealed class GuardianPrivateLaunchIngress : IDisposable
{
    private const int MaxFrameBytes = 64 * 1024;
    private readonly string pipeName;
    private readonly string token;
    private readonly GuardianProtocol.Correlation correlation;
    private readonly HashSet<string> consumedPlans = new(StringComparer.Ordinal);
    private NamedPipeServerStream? server;
    private bool authenticated;
    private bool tokenConsumed;
    private bool closed;

    internal GuardianPrivateLaunchIngress(string pipeName, string token, GuardianProtocol.Correlation correlation)
    {
        if (string.IsNullOrWhiteSpace(pipeName) || pipeName.Contains('\0') || pipeName.Contains('/') || pipeName.Contains('\\')) throw new InvalidDataException("windows_stardew_bootstrap_guardian_private_pipe_invalid");
        if (string.IsNullOrWhiteSpace(token)) throw new InvalidDataException("windows_stardew_bootstrap_guardian_private_token_invalid");
        this.pipeName = pipeName; this.token = token; this.correlation = correlation;
    }

    internal static void ValidateAbi()
    {
        if (IntPtr.Size != 8 || Marshal.SizeOf<SecurityAttributes>() != 24)
            throw new PlatformNotSupportedException("windows_stardew_bootstrap_guardian_pipe_abi_invalid");
    }

    internal async Task<ArmBinding?> ReceiveArmAsync(CancellationToken cancellationToken)
    {
        if (closed || authenticated) return null;
        server = CreateServer();
        try
        {
            await server.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
            // Windows pipe impersonation is available only after the server has
            // read from the client. Keep the bounded frame opaque until the
            // current-SID check succeeds; no arm facts are parsed or used first.
            var frame = await ReadFrameAsync(server, cancellationToken).ConfigureAwait(false);
            ValidateClientSid(server);
            var binding = ParseArm(frame);
            authenticated = true;
            await ReplyAsync("accepted").ConfigureAwait(false);
            return binding;
        }
        catch { return null; }
    }

    internal async Task<LaunchPlan?> ReceiveLaunchPlanAsync(CancellationToken cancellationToken)
    {
        if (closed || !authenticated || server is null || !server.IsConnected) return null;
        try
        {
            var frame = await ReadFrameAsync(server, cancellationToken).ConfigureAwait(false);
            var plan = ParseLaunch(frame);
            await ReplyAsync("accepted").ConfigureAwait(false);
            return plan;
        }
        catch { return null; }
    }

    private NamedPipeServerStream CreateServer()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("windows_stardew_bootstrap_guardian_current_sid_missing");
        using var security = CreateSecurity(sid);
        var attributes = security.Attributes;
        var handle = CreateNamedPipeW($"\\\\.\\pipe\\{pipeName}", PipeAccessDuplex | FileFlagOverlapped | FileFlagFirstPipeInstance,
            PipeTypeByte | PipeReadModeByte | PipeWait | PipeRejectRemoteClients, 1, MaxFrameBytes, MaxFrameBytes, 0, ref attributes);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "windows_stardew_bootstrap_guardian_private_pipe_create_failed");
        try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, new SafePipeHandle(handle, true)); }
        catch { CloseHandle(handle); throw; }
    }

    private static SecurityReference CreateSecurity(string sid)
    {
        // PIPE_ACCESS_DUPLEX requires read/write plus synchronize; never publish ACL mutation rights.
        var sddl = $"D:P(A;;0x0012019B;;;{sid})";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out var descriptor, out _)) throw new Win32Exception(Marshal.GetLastWin32Error(), "windows_stardew_bootstrap_guardian_private_pipe_security_failed");
        return new SecurityReference(new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, InheritHandle = 0 });
    }

    private static void ValidateClientSid(NamedPipeServerStream pipe)
    {
        var expected = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("windows_stardew_bootstrap_guardian_current_sid_missing");
        string? actual = null;
        pipe.RunAsClient(() => actual = WindowsIdentity.GetCurrent().User?.Value);
        if (!StringComparer.OrdinalIgnoreCase.Equals(expected, actual)) throw new UnauthorizedAccessException("windows_stardew_bootstrap_guardian_private_client_sid_invalid");
    }

    private async Task ReplyAsync(string value)
    {
        await server!.WriteAsync(Encoding.UTF8.GetBytes(value + "\n")).ConfigureAwait(false);
        await server.FlushAsync().ConfigureAwait(false);
    }

    private static async Task<byte[]> ReadFrameAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var data = new MemoryStream();
        var one = new byte[1];
        while (data.Length < MaxFrameBytes)
        {
            var read = await stream.ReadAsync(one, cancellationToken).ConfigureAwait(false);
            if (read == 0) throw new EndOfStreamException();
            if (one[0] == (byte)'\r') throw GuardianProtocol.Invalid();
            if (one[0] == (byte)'\n') return data.ToArray(); // exactly the first LF-delimited frame
            data.WriteByte(one[0]);
        }
        throw GuardianProtocol.Invalid();
    }

    private ArmBinding ParseArm(byte[] frame)
    {
        using var document = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = 8, AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow });
        var root = document.RootElement;
        GuardianProtocol.RequireExactKeys(root, "token", "guardianInstanceId", "guardianEpoch", "attemptId", "revision", "leaseName", "playerJobName", "aiJobName");
        AuthenticateArm(root);
        if (String(root, "guardianInstanceId") != correlation.InstanceId || Int(root, "guardianEpoch") != correlation.Epoch || String(root, "attemptId") != correlation.AttemptId) throw GuardianProtocol.Invalid();
        var binding = new ArmBinding(String(root, "revision"), String(root, "leaseName"), String(root, "playerJobName"), String(root, "aiJobName"));
        if (!Guid.TryParseExact(binding.Revision, "D", out _) || !IsJobName(binding.LeaseName) || !IsJobName(binding.PlayerJobName) || !IsJobName(binding.AiJobName) || new[] { binding.LeaseName, binding.PlayerJobName, binding.AiJobName }.Distinct(StringComparer.Ordinal).Count() != 3) throw GuardianProtocol.Invalid();
        return binding;
    }

    private LaunchPlan ParseLaunch(byte[] frame)
    {
        using var document = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = 8, AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow });
        var root = document.RootElement;
        GuardianProtocol.RequireExactKeys(root, "guardianInstanceId", "guardianEpoch", "attemptId", "planId", "role", "deadlineUnixMs", "executable", "cwd", "arguments", "environment");
        if (String(root, "guardianInstanceId") != correlation.InstanceId || Int(root, "guardianEpoch") != correlation.Epoch || String(root, "attemptId") != correlation.AttemptId) throw GuardianProtocol.Invalid();
        var planId = String(root, "planId");
        if (!Guid.TryParseExact(planId, "D", out _) || !consumedPlans.Add(planId)) throw GuardianProtocol.Invalid();
        var deadline = root.GetProperty("deadlineUnixMs").GetInt64();
        if (deadline <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) throw GuardianProtocol.Invalid();
        var role = String(root, "role") switch { "player_host" => GuardianProtocol.Role.PlayerHost, "ai_client" => GuardianProtocol.Role.AiClient, _ => throw GuardianProtocol.Invalid() };
        var executable = String(root, "executable"); var cwd = String(root, "cwd");
        if (!Path.IsPathFullyQualified(executable) || !Path.IsPathFullyQualified(cwd) || executable.Contains('\0') || cwd.Contains('\0') || executable.Length > 32767 || cwd.Length > 32767) throw GuardianProtocol.Invalid();
        var arguments = root.GetProperty("arguments").ValueKind == JsonValueKind.Array ? root.GetProperty("arguments").EnumerateArray().Select(value => value.ValueKind == JsonValueKind.String ? value.GetString()! : throw GuardianProtocol.Invalid()).ToArray() : throw GuardianProtocol.Invalid();
        if (arguments.Length > 128 || arguments.Any(value => value.Length == 0 || value.Length > 4096 || value.Contains('\0'))) throw GuardianProtocol.Invalid();
        if (root.GetProperty("environment").ValueKind != JsonValueKind.Object) throw GuardianProtocol.Invalid();
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in root.GetProperty("environment").EnumerateObject())
        {
            var environmentValue = item.Value.ValueKind == JsonValueKind.String ? item.Value.GetString()! : throw GuardianProtocol.Invalid();
            if (!IsAllowedEnvironment(item.Name) || environmentValue.Contains('\0') || !environment.TryAdd(item.Name, environmentValue)) throw GuardianProtocol.Invalid();
        }
        if (environment.Count == 0) throw GuardianProtocol.Invalid();
        return new LaunchPlan(correlation, planId, role, deadline, executable, cwd, arguments, environment);
    }

    private void AuthenticateArm(JsonElement root)
    {
        if (tokenConsumed) throw GuardianProtocol.Invalid();
        var supplied = String(root, "token");
        if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), Encoding.UTF8.GetBytes(token))) throw GuardianProtocol.Invalid();
        tokenConsumed = true;
    }

    private static string String(JsonElement root, string name) => root.GetProperty(name).ValueKind == JsonValueKind.String ? root.GetProperty(name).GetString()! : throw GuardianProtocol.Invalid();
    private static int Int(JsonElement root, string name) => root.GetProperty(name).TryGetInt32(out var value) ? value : throw GuardianProtocol.Invalid();
    private static bool IsJobName(string value) => value.StartsWith("Local\\", StringComparison.Ordinal) && value.Length > 6 && value.Length <= 140 && value[6..].All(c => char.IsLetterOrDigit(c) || c is '-' or '_');
    private static bool IsAllowedEnvironment(string name) => name is "PATH" or "SystemRoot" or "WINDIR" or "TEMP" or "TMP" or "USERPROFILE";
    public void Dispose() { closed = true; server?.Dispose(); server = null; }

    internal sealed record ArmBinding(string Revision, string LeaseName, string PlayerJobName, string AiJobName);
    internal sealed record LaunchPlan(GuardianProtocol.Correlation Correlation, string PlanId, GuardianProtocol.Role Role, long DeadlineUnixMs, string Executable, string WorkingDirectory, IReadOnlyList<string> Arguments, IReadOnlyDictionary<string, string> Environment);

    private const uint PipeAccessDuplex = 0x00000003;
    private const uint FileFlagOverlapped = 0x40000000;
    private const uint FileFlagFirstPipeInstance = 0x00080000;
    private const uint PipeTypeByte = 0x00000000;
    private const uint PipeReadModeByte = 0x00000000;
    private const uint PipeWait = 0x00000000;
    private const uint PipeRejectRemoteClients = 0x00000008;
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; internal int InheritHandle; }
    private sealed class SecurityReference : IDisposable { internal SecurityAttributes Attributes; internal SecurityReference(SecurityAttributes attributes) => Attributes = attributes; public void Dispose() { if (Attributes.Descriptor != IntPtr.Zero) LocalFree(Attributes.Descriptor); } }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBufferSize, uint inBufferSize, uint defaultTimeout, ref SecurityAttributes attributes);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
