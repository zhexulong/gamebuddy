using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// <see cref="RouteReenteringBodyProgramExecutor"/> projects a node's canonical
/// arguments onto the wire argument shape by hand, so a missing case is a SILENT
/// drop: the handler reads a null member and refuses by name while the program
/// author supplied a legal argument. `equip_tool` was exactly that — the mapping
/// had no `tool` case, so every program equip reached
/// <c>RequestLocalEquipTool</c> with a null tool and ended
/// <c>invalid_tool_selector</c> by construction; the executor's own tests only
/// ever exercised machine_inspect and navigate_to_destination, so nothing failed.
///
/// These tests close the projection over the whole catalog: every argument any
/// registration declares is carried through the real mapping (a real grant, the
/// real router, the registration's own descriptor) and must arrive at the handler
/// with its canonical value. A newly declared argument that the mapping forgets
/// fails here, and so does one that has no wire member to carry it.
/// </summary>
public sealed class BodyProgramArgumentProjectionTests
{
    private const int IntegerSentinel = 7;
    private const string StringSentinelPrefix = "projection-";
    private const string DestinationLabel = "Town";

    private sealed class RecordingHandler : IFarmhandActionHandler
    {
        public BridgeExecutionArgs? Seen { get; private set; }

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            this.Seen = request.Args;
            string executionId = ledger is IDispatchExecutionLedger dispatchLedger
                && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
                ? boundExecutionId
                : "exec_unbound";
            return ledger.RememberTerminal(request.RequestId, executionId, ExecutionState.Succeeded, "recorded", "recorded=true");
        }
    }

    private sealed class StubLedger : IExecutionLedger, IDispatchExecutionLedger
    {
        private readonly Dictionary<string, LocalExecutionReceipt> receipts = new(StringComparer.Ordinal);
        private string? boundExecutionId;

        public long CurrentRevision { get; set; } = 1;

        public bool IsBodyBusy { get; set; }

        public bool TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode)
        {
            this.boundExecutionId = executionId;
            reasonCode = "bound";
            return true;
        }

        public bool TryGetBoundExecutionId(string requestId, out string executionId)
        {
            executionId = this.boundExecutionId!;
            return this.boundExecutionId is not null;
        }

        public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt) => this.receipts.TryGetValue(requestId, out receipt!);

        public void BindAction(string requestId, string actionId) { }

        public LocalExecutionReceipt Remember(LocalExecutionReceipt receipt) => this.receipts[receipt.RequestId] = receipt;

        public LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence, BridgeLocalObservation? observation = null)
        {
            var receipt = new LocalExecutionReceipt(executionId, requestId, state, reasonCode, ++this.CurrentRevision, evidence, Observation: observation);
            this.receipts[requestId] = receipt;
            return receipt;
        }

        public void AddTrace(LocalExecutionReceipt receipt) { }
    }

    public static TheoryData<string> DeclaredArgumentNames()
    {
        var data = new TheoryData<string>();
        foreach (string name in DeclaredArgumentNamesInCatalog())
            data.Add(name);
        return data;
    }

    private static IReadOnlyList<string> DeclaredArgumentNamesInCatalog() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor is not null)
            .SelectMany(registration => registration.Descriptor!.Arguments)
            .Select(argument => argument.Name)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

    private static IEnumerable<FarmhandActionRegistration> RegistrationsDeclaring(string argumentName) =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor is not null)
            .Where(registration => registration.Descriptor!.Arguments.Any(argument => string.Equals(argument.Name, argumentName, StringComparison.Ordinal)));

    /// <summary>The wire member name the projection must fill, derived from the catalog's argument name.</summary>
    private static string WireMemberName(string argumentName) =>
        char.ToUpperInvariant(argumentName[0]) + argumentName.Substring(1);

    [Fact]
    public void EveryDeclaredArgumentHasAWireMemberToCarryIt()
    {
        string[] missing = DeclaredArgumentNamesInCatalog()
            .Where(argumentName => typeof(BridgeExecutionArgs).GetProperty(WireMemberName(argumentName)) is null)
            .ToArray();

        missing.Should().BeEmpty(
            "an argument the catalog declares with no BridgeExecutionArgs member can never reach a handler, "
            + "however legal the program node carrying it: " + string.Join(", ", missing));
    }

    [Theory]
    [MemberData(nameof(DeclaredArgumentNames))]
    public void DeclaredArgumentArrivesAtTheHandlerWithItsCanonicalValue(string argumentName)
    {
        PropertyInfo wireMember = typeof(BridgeExecutionArgs).GetProperty(WireMemberName(argumentName))!;
        var covered = new List<string>();
        foreach (FarmhandActionRegistration registration in RegistrationsDeclaring(argumentName))
        {
            FarmhandActionArgument declared = registration.Descriptor!.Arguments
                .First(argument => string.Equals(argument.Name, argumentName, StringComparison.Ordinal));
            BodyProgramCanonicalValue canonical = CanonicalValue(declared);
            var router = new FarmhandActionRouter();
            var handler = new RecordingHandler();
            router.Register(registration, handler);
            NodeExecutionBinding binding = Binding(registration.ActionId);
            var grant = new HostAdmissionGrant(
                "program",
                "node",
                NodeAttempt: 1,
                AdmissionAttempt: 1,
                StopEpoch: 0,
                CatalogRevision: 7,
                new BodyProgramPolicyIdentity("policy-a", 1),
                registration.ActionId,
                new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal) { [argumentName] = canonical },
                new Dictionary<string, string>(StringComparer.Ordinal),
                DeadlineMs: 1000,
                GrantId: "grant-projection-1",
                AttachmentGeneration: "attachment_01",
                PolicyRevision: "host-policy_01",
                ExecutionBinding: binding);

            BodyProgramTerminalResult? terminal = new RouteReenteringBodyProgramExecutor(router, new StubLedger()).Execute(grant, binding);

            terminal.Should().NotBeNull($"{registration.ActionId} declares `{argumentName}`, so the node must dispatch");
            terminal!.Outcome.Should().Be(BodyProgramNodeOutcome.Succeeded);
            handler.Seen.Should().NotBeNull();
            wireMember.GetValue(handler.Seen).Should().Be(
                ExpectedValue(wireMember, declared, argumentName),
                $"{registration.ActionId} declares `{argumentName}` and the program node carried it; the handler must receive it, not null");
            covered.Add(registration.ActionId);
        }

        covered.Should().NotBeEmpty($"`{argumentName}` is declared by the catalog");
    }

    /// <summary>
    /// The reported defect as its own case: `tool` is a closed enum, so a program
    /// equip node always carried a well-formed selector — and the mapping dropped
    /// it, so the handler refused `invalid_tool_selector` with null evidence.
    /// </summary>
    [Fact]
    public void EquipToolProgramNodeDeliversItsToolSelectorToTheHandler()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .First(candidate => string.Equals(candidate.ActionId, "equip_tool", StringComparison.Ordinal));
        var router = new FarmhandActionRouter();
        var handler = new RecordingHandler();
        router.Register(registration, handler);
        NodeExecutionBinding binding = Binding("equip_tool");
        var grant = new HostAdmissionGrant(
            "program",
            "equip",
            NodeAttempt: 1,
            AdmissionAttempt: 1,
            StopEpoch: 0,
            CatalogRevision: 7,
            new BodyProgramPolicyIdentity("policy-a", 1),
            "equip_tool",
            new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
            {
                ["tool"] = new(BodyProgramArgumentKind.String, "pickaxe"),
            },
            new Dictionary<string, string>(StringComparer.Ordinal),
            DeadlineMs: 1000,
            GrantId: "grant-equip-1",
            AttachmentGeneration: "attachment_01",
            PolicyRevision: "host-policy_01",
            ExecutionBinding: binding);

        BodyProgramTerminalResult? terminal = new RouteReenteringBodyProgramExecutor(router, new StubLedger()).Execute(grant, binding);

        terminal.Should().NotBeNull();
        terminal!.Outcome.Should().Be(BodyProgramNodeOutcome.Succeeded);
        handler.Seen.Should().NotBeNull();
        handler.Seen!.Tool.Should().Be("pickaxe", "a closed-enum tool selector the program node carried is exactly what the handler resolves");
    }

    /// <summary>
    /// An integer the wire's int32 member cannot hold fails the projection closed. It must not reach a
    /// handler as `null`: every handler reads `Args.Slot ?? 0`, so a dropped out-of-range slot would
    /// act on slot 0 rather than refuse.
    /// </summary>
    [Fact]
    public void OutOfRangeIntegerArgumentFailsClosedBeforeAnyHandlerRuns()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .First(candidate => string.Equals(candidate.ActionId, "cut_grass", StringComparison.Ordinal));
        var router = new FarmhandActionRouter();
        var handler = new RecordingHandler();
        router.Register(registration, handler);
        NodeExecutionBinding binding = Binding("cut_grass");
        var grant = new HostAdmissionGrant(
            "program",
            "cut",
            NodeAttempt: 1,
            AdmissionAttempt: 1,
            StopEpoch: 0,
            CatalogRevision: 7,
            new BodyProgramPolicyIdentity("policy-a", 1),
            "cut_grass",
            new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
            {
                ["slot"] = new(BodyProgramArgumentKind.Integer, "2147483648"),
            },
            new Dictionary<string, string>(StringComparer.Ordinal),
            DeadlineMs: 1000,
            GrantId: "grant-range-1",
            AttachmentGeneration: "attachment_01",
            PolicyRevision: "host-policy_01",
            ExecutionBinding: binding);

        BodyProgramTerminalResult? terminal = new RouteReenteringBodyProgramExecutor(router, new StubLedger()).Execute(grant, binding);

        terminal.Should().NotBeNull();
        terminal!.Outcome.Should().Be(BodyProgramNodeOutcome.Failed);
        terminal.Facts.Should().BeEmpty();
        handler.Seen.Should().BeNull("an unprojectable argument must not reach the native dispatch at all");
    }

    private static BodyProgramCanonicalValue CanonicalValue(FarmhandActionArgument declared) => declared.Type switch
    {
        "integer" => new BodyProgramCanonicalValue(BodyProgramArgumentKind.Integer, IntegerSentinel.ToString(System.Globalization.CultureInfo.InvariantCulture)),
        "string" => new BodyProgramCanonicalValue(BodyProgramArgumentKind.String, StringSentinelPrefix + declared.Name),
        "destination_selector" => new BodyProgramCanonicalValue(BodyProgramArgumentKind.DestinationSelector, null, new BodyProgramDestinationSelector("label", DestinationLabel, null)),
        _ => throw new InvalidOperationException($"The projection tests have no canonical value for declared argument type `{declared.Type}`; extend them rather than letting the argument go uncovered."),
    };

    /// <summary>The expected wire value, typed as the member itself: `x`/`y` are the only floats.</summary>
    private static object? ExpectedValue(PropertyInfo wireMember, FarmhandActionArgument declared, string argumentName) => declared.Type switch
    {
        "integer" => wireMember.PropertyType == typeof(float?) ? IntegerSentinel : (object)(int?)IntegerSentinel,
        "string" => StringSentinelPrefix + argumentName,
        "destination_selector" => new BridgeNavigationDestinationSelector("label", DestinationLabel, null),
        _ => throw new InvalidOperationException($"The projection tests have no expected wire value for declared argument type `{declared.Type}`."),
    };

    private static NodeExecutionBinding Binding(string actionId) =>
        new("program", "node", NodeAttempt: 1, RequestId: $"req_{actionId}", IdempotencyKey: $"idem_{actionId}", ExecutionId: $"exec_{actionId}");
}
