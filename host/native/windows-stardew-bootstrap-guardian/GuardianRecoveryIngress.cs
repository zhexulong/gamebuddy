using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace GameBuddy.WindowsStardewBootstrapGuardian;

/** Separate recovery-only private session. It never creates, opens, queries, or terminates a Job. */
internal sealed class GuardianRecoveryIngress : IDisposable
{
    private const int MaxFrameBytes = 64 * 1024;
    private readonly string pipeName;
    private readonly string token;
    private NamedPipeServerStream? server;
    private bool authenticated;
    private bool preConsumed;
    private bool postConsumed;
    private bool released;
    private readonly HashSet<GuardianProtocol.Role> classifiedRoles = new();

    internal GuardianRecoveryIngress(string pipeName, string token)
    {
        if (string.IsNullOrWhiteSpace(pipeName) || pipeName.Contains('\0') || pipeName.Contains('/') || pipeName.Contains('\\') || string.IsNullOrWhiteSpace(token)) throw GuardianProtocol.Invalid();
        this.pipeName = pipeName;
        this.token = token;
    }

    internal async Task<PreCasBinding?> ReceivePreCasAsync(CancellationToken cancellationToken)
    {
        if (preConsumed) return null;
        server = CreateServer();
        try
        {
            await server.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
            var frame = await ReadFrameAsync(server, cancellationToken).ConfigureAwait(false);
            ValidateClientSid(server);
            var binding = ParsePreCas(frame);
            authenticated = true;
            preConsumed = true;
            return binding;
        }
        catch { return null; }
    }

    internal async Task<PostCasBinding?> ReceivePostCasAsync(PreCasBinding pre, CancellationToken cancellationToken)
    {
        if (!authenticated || postConsumed || server is null || !server.IsConnected) return null;
        try
        {
            var binding = ParsePostCas(await ReadFrameAsync(server, cancellationToken).ConfigureAwait(false), pre);
            postConsumed = true;
            return binding;
        }
        catch { return null; }
    }

    internal async Task<RecoveryClassification?> ReceiveClassificationAsync(PostCasBinding post, CancellationToken cancellationToken)
    {
        if (!postConsumed || released || server is null || !server.IsConnected) return null;
        try
        {
            using var document = JsonDocument.Parse(await ReadFrameAsync(server, cancellationToken).ConfigureAwait(false));
            var root = document.RootElement;
            GuardianProtocol.RequireExactKeys(root, "operation", "role");
            if (root.GetProperty("operation").GetString() != "classify") throw GuardianProtocol.Invalid();
            var role = root.GetProperty("role").GetString() switch
            {
                "playerHost" => GuardianProtocol.Role.PlayerHost,
                "aiClient" => GuardianProtocol.Role.AiClient,
                _ => throw GuardianProtocol.Invalid(),
            };
            if (!classifiedRoles.Add(role)) throw GuardianProtocol.Invalid();
            return new RecoveryClassification(role, role == GuardianProtocol.Role.PlayerHost ? post.PlayerHostState : post.AiClientState);
        }
        catch { return null; }
    }

    internal async Task<bool> ReceiveReleaseAsync(CancellationToken cancellationToken)
    {
        if (!postConsumed || released || server is null || !server.IsConnected) return false;
        try
        {
            using var document = JsonDocument.Parse(await ReadFrameAsync(server, cancellationToken).ConfigureAwait(false));
            GuardianProtocol.RequireExactKeys(document.RootElement, "operation");
            if (document.RootElement.GetProperty("operation").GetString() != "release") throw GuardianProtocol.Invalid();
            released = true;
            return true;
        }
        catch { return false; }
    }

    internal Task ReplyAsync(string result) => WriteAsync(result);
    private async Task WriteAsync(string value) { await server!.WriteAsync(Encoding.UTF8.GetBytes(value + "\n")).ConfigureAwait(false); await server.FlushAsync().ConfigureAwait(false); }

    private PreCasBinding ParsePreCas(byte[] frame)
    {
        using var document = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = 8, AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow });
        var root = document.RootElement;
        GuardianProtocol.RequireExactKeys(root, "token", "guardianInstanceId", "guardianEpoch", "attemptId", "bindingRevision", "leaseName");
        Authenticate(root);
        return new PreCasBinding(Correlation(root), Opaque(root, "bindingRevision"), Name(root, "leaseName"));
    }

    private static PostCasBinding ParsePostCas(byte[] frame, PreCasBinding pre)
    {
        using var document = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = 8, AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow });
        var root = document.RootElement;
        GuardianProtocol.RequireExactKeys(root, "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId", "bindingRevision", "ownerRecordRevision", "leaseName", "playerJobName", "aiJobName", "playerHostState", "aiClientState");
        if (Correlation(root) != pre.Correlation || Opaque(root, "bindingRevision") != pre.BindingRevision || Name(root, "leaseName") != pre.LeaseName) throw GuardianProtocol.Invalid();
        if (!root.TryGetProperty("ownerRecordRevision", out var revision) || !revision.TryGetInt32(out var ownerRevision) || ownerRevision < 1) throw GuardianProtocol.Invalid();
        var playerJobName = Name(root, "playerJobName"); var aiJobName = Name(root, "aiJobName");
        if (StringComparer.Ordinal.Equals(playerJobName, aiJobName) || StringComparer.Ordinal.Equals(playerJobName, pre.LeaseName) || StringComparer.Ordinal.Equals(aiJobName, pre.LeaseName)) throw GuardianProtocol.Invalid();
        var playerState = State(root, "playerHostState"); var aiState = State(root, "aiClientState");
        return new PostCasBinding(pre.Correlation, Opaque(root, "recoveryInstanceId"), pre.BindingRevision, ownerRevision, pre.LeaseName, playerJobName, aiJobName, playerState, aiState);
    }

    private void Authenticate(JsonElement root)
    {
        var supplied = String(root, "token");
        if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), Encoding.UTF8.GetBytes(token))) throw GuardianProtocol.Invalid();
    }
    private static GuardianProtocol.Correlation Correlation(JsonElement root) => new(Opaque(root, "guardianInstanceId"), Positive(root, "guardianEpoch"), Opaque(root, "attemptId"));
    private static string State(JsonElement root, string name) { var state = String(root, name); return state is "reserved" or "armed" or "active" or "closing" or "contained" ? state : throw GuardianProtocol.Invalid(); }
    private static string Name(JsonElement root, string name) { var value = String(root, name); return value.StartsWith("Local\\", StringComparison.Ordinal) && value.Length <= 140 && value[6..].Length > 0 && value[6..].All(c => char.IsLetterOrDigit(c) || c is '-' or '_') ? value : throw GuardianProtocol.Invalid(); }
    private static string Opaque(JsonElement root, string name) { var value = String(root, name); return Guid.TryParseExact(value, "D", out _) ? value : throw GuardianProtocol.Invalid(); }
    private static int Positive(JsonElement root, string name) => root.TryGetProperty(name, out var value) && value.TryGetInt32(out var result) && result > 0 ? result : throw GuardianProtocol.Invalid();
    private static string String(JsonElement root, string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { } text ? text : throw GuardianProtocol.Invalid();

    private NamedPipeServerStream CreateServer()
    {
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw GuardianProtocol.Invalid();
        using var security = CreateSecurity(sid); var attributes = security.Attributes;
        var handle = CreateNamedPipeW($"\\\\.\\pipe\\{pipeName}", 0x00000003 | 0x40000000 | 0x00080000, 0x00000008, 1, MaxFrameBytes, MaxFrameBytes, 0, ref attributes);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { return new NamedPipeServerStream(PipeDirection.InOut, false, false, new SafePipeHandle(handle, true)); } catch { CloseHandle(handle); throw; }
    }
    private static void ValidateClientSid(NamedPipeServerStream pipe) { var expected = WindowsIdentity.GetCurrent().User?.Value ?? throw GuardianProtocol.Invalid(); string? actual = null; pipe.RunAsClient(() => actual = WindowsIdentity.GetCurrent().User?.Value); if (!StringComparer.OrdinalIgnoreCase.Equals(expected, actual)) throw GuardianProtocol.Invalid(); }
    private static async Task<byte[]> ReadFrameAsync(Stream stream, CancellationToken cancellationToken) { using var data = new MemoryStream(); var one = new byte[1]; while (data.Length < MaxFrameBytes) { if (await stream.ReadAsync(one, cancellationToken).ConfigureAwait(false) == 0) throw GuardianProtocol.Invalid(); if (one[0] == (byte)'\r') throw GuardianProtocol.Invalid(); if (one[0] == (byte)'\n') return data.ToArray(); data.WriteByte(one[0]); } throw GuardianProtocol.Invalid(); }
    private static SecurityReference CreateSecurity(string sid) { if (!ConvertStringSecurityDescriptorToSecurityDescriptorW($"D:P(A;;0x0012019B;;;{sid})", 1, out var descriptor, out _)) throw new Win32Exception(Marshal.GetLastWin32Error()); return new SecurityReference(new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, InheritHandle = 0 }); }
    public void Dispose() => server?.Dispose();
    internal sealed record PreCasBinding(GuardianProtocol.Correlation Correlation, string BindingRevision, string LeaseName);
    internal sealed record PostCasBinding(GuardianProtocol.Correlation Correlation, string RecoveryInstanceId, string BindingRevision, int OwnerRecordRevision, string LeaseName, string PlayerJobName, string AiJobName, string PlayerHostState, string AiClientState);
    internal sealed record RecoveryClassification(GuardianProtocol.Role Role, string State);
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; internal int InheritHandle; }
    private sealed class SecurityReference : IDisposable { internal SecurityAttributes Attributes; internal SecurityReference(SecurityAttributes attributes) => Attributes = attributes; public void Dispose() { if (Attributes.Descriptor != IntPtr.Zero) LocalFree(Attributes.Descriptor); } }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBufferSize, uint inBufferSize, uint defaultTimeout, ref SecurityAttributes attributes);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
