using System.Collections;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
using System.Text.Json;

const string schema = "gamebuddy-desktop-host-bootstrap/v1";
const string rootLayoutSchema = "gamebuddy-windows-root-layout/v1";
const string reportName = "exact-child-bootstrap-report.json";

// The real Host child is node.exe running the bootstrap entry as its first positional
// argument. A fixture that ignored its command line could not observe the launcher's
// script-argument form at all, so it reads its own arguments the way node reads them
// (this process already IS the bootstrap entry) and refuses when the launcher did not
// supply the entry as argument one - which is exactly the shape that makes node
// evaluate the bootstrap frame on standard input as JavaScript instead of parsing it
// as JSON. It never asserts the entry's contents: only that the launcher named it.
var positional = Environment.GetCommandLineArgs().Skip(1).ToArray();
if (positional.Length != 1 ||
    Path.GetExtension(positional[0]) != ".js" ||
    !Path.GetFileName(positional[0]).StartsWith("desktop-host-entry.internal", StringComparison.Ordinal) ||
    positional[0].StartsWith(@"\\?\", StringComparison.Ordinal))
    return;

var input = ReadStandardInputToEnd();
if (input.Length < 2 || input[^1] != '\n' || input.Contains('\r') || input.Contains('\0')) return;

var frameJson = input[..^1];
if (frameJson.Contains('\n')) return;

try
{
    using var document = JsonDocument.Parse(frameJson);
    var frame = document.RootElement;
    if (!ExactProperties(frame, "schema", "protocolVersion", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "rootLayout") ||
        frame.GetProperty("schema").GetString() != schema || frame.GetProperty("protocolVersion").GetInt32() != 1 ||
        !NonEmpty(frame.GetProperty("bootstrapId")) || !NonEmpty(frame.GetProperty("generation")) || !NonEmpty(frame.GetProperty("inventoryDigest")) || !NonEmpty(frame.GetProperty("runtimeAdmissionSha256")) ||
        !ExactProperties(frame.GetProperty("rootLayout"), "schema", "programRoot", "dataRoot", "operationalRoot", "presentationRoot") ||
        frame.GetProperty("rootLayout").GetProperty("schema").GetString() != rootLayoutSchema)
        return;

    using var session = AuthenticateBroker(frame);

    var reportPath = Path.Combine(Path.GetDirectoryName(Environment.ProcessPath!)!, reportName);
    var report = new MemoryStream();
    using (var reportWriter = new Utf8JsonWriter(report))
    {
        reportWriter.WriteStartObject();
        reportWriter.WritePropertyName("frame");
        frame.WriteTo(reportWriter);
        reportWriter.WriteString("executablePath", Environment.ProcessPath);
        reportWriter.WritePropertyName("positionalArguments");
        reportWriter.WriteStartArray();
        foreach (var argument in positional) reportWriter.WriteStringValue(argument);
        reportWriter.WriteEndArray();
        reportWriter.WritePropertyName("environment");
        reportWriter.WriteStartObject();
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            reportWriter.WriteString((string)entry.Key, (string?)entry.Value);
        }
        reportWriter.WriteEndObject();
        reportWriter.WriteEndObject();
    }
    File.WriteAllBytes(reportPath, report.ToArray());

    var acknowledgementBytes = new MemoryStream();
    using (var acknowledgementWriter = new Utf8JsonWriter(acknowledgementBytes))
    {
        acknowledgementWriter.WriteStartObject();
        acknowledgementWriter.WriteString("schema", schema);
        acknowledgementWriter.WriteNumber("protocolVersion", 1);
        acknowledgementWriter.WriteString("status", "accepted");
        acknowledgementWriter.WriteString("bootstrapId", frame.GetProperty("bootstrapId").GetString());
        acknowledgementWriter.WriteString("generation", frame.GetProperty("generation").GetString());
        acknowledgementWriter.WriteString("inventoryDigest", frame.GetProperty("inventoryDigest").GetString());
        acknowledgementWriter.WriteString("runtimeAdmissionSha256", frame.GetProperty("runtimeAdmissionSha256").GetString());
        acknowledgementWriter.WriteString("rootLayoutSchema", rootLayoutSchema);
        // The exit deadline the launcher waits before it treats this child as hung. A test bound rather
        // than the production Host's derived value: this stand-in exists for the frame, the command line
        // and the environment it received, and the exit handshake has its own stand-in. Publishing it is
        // still required - a child that omitted it would be refused as unreadable.
        acknowledgementWriter.WriteNumber("drainDeadlineMs", 5_000);
        acknowledgementWriter.WriteEndObject();
    }
    acknowledgementBytes.WriteByte((byte)'\n');
    using (var stdout = new FileStream(new SafeFileHandle(WindowsNative.GetStdHandle(-11), ownsHandle: true), FileAccess.Write))
    {
        stdout.Write(acknowledgementBytes.ToArray());
        stdout.Flush();
    }
    // Leaving is the launcher's decision, and this child takes the one signal it is given: the close
    // of its authenticated session. That is what the production Host's exit reclamation waits for, so
    // a launcher that arms the child before it terminates it is never left waiting here.
    using (var sessionReader = new StreamReader(session, new UTF8Encoding(false, true), leaveOpen: true))
    {
        try { _ = sessionReader.ReadLine(); } catch (IOException) { }
    }
}
catch (JsonException)
{
}

static NamedPipeClientStream AuthenticateBroker(JsonElement frame)
{
    var bootstrapId = frame.GetProperty("bootstrapId").GetString()!;
    var broker = new NamedPipeClientStream(".", $"GameBuddy.HostGuardian.{bootstrapId}", PipeDirection.InOut);
    broker.Connect(10_000);
    var hello = Encoding.UTF8.GetBytes($"{{\"schema\":\"gamebuddy-desktop-guardian-session/v1\",\"protocolVersion\":1,\"operation\":\"hello\",\"bootstrapId\":\"{bootstrapId}\",\"generation\":\"{frame.GetProperty("generation").GetString()}\",\"inventoryDigest\":\"{frame.GetProperty("inventoryDigest").GetString()}\",\"runtimeAdmissionSha256\":\"{frame.GetProperty("runtimeAdmissionSha256").GetString()}\"}}\n");
    broker.Write(hello);
    broker.Flush();
    using var reader = new StreamReader(broker, new UTF8Encoding(false, true), leaveOpen: true);
    var response = reader.ReadLine();
    using var document = JsonDocument.Parse(response ?? throw new InvalidOperationException());
    var acknowledgement = document.RootElement;
    if (!ExactProperties(acknowledgement, "schema", "protocolVersion", "operation", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256") ||
        acknowledgement.GetProperty("schema").GetString() != "gamebuddy-desktop-guardian-session/v1" || acknowledgement.GetProperty("protocolVersion").GetInt32() != 1 ||
        acknowledgement.GetProperty("operation").GetString() != "hello" || acknowledgement.GetProperty("status").GetString() != "accepted" ||
        acknowledgement.GetProperty("bootstrapId").GetString() != bootstrapId || acknowledgement.GetProperty("generation").GetString() != frame.GetProperty("generation").GetString() ||
        acknowledgement.GetProperty("inventoryDigest").GetString() != frame.GetProperty("inventoryDigest").GetString() || acknowledgement.GetProperty("runtimeAdmissionSha256").GetString() != frame.GetProperty("runtimeAdmissionSha256").GetString())
        throw new InvalidOperationException();
    return broker;
}

static string ReadStandardInputToEnd()
{
    using var stdin = new FileStream(new SafeFileHandle(WindowsNative.GetStdHandle(-10), ownsHandle: false), FileAccess.Read);
    using var bytes = new MemoryStream();
    stdin.CopyTo(bytes);
    return new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true).GetString(bytes.ToArray());
}

static bool NonEmpty(JsonElement value) => value.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(value.GetString());

static bool ExactProperties(JsonElement value, params string[] names) =>
    value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Select(property => property.Name).SequenceEqual(names, StringComparer.Ordinal);

internal static partial class WindowsNative
{
    [LibraryImport("kernel32.dll")]
    internal static partial IntPtr GetStdHandle(int standardHandle);

}
