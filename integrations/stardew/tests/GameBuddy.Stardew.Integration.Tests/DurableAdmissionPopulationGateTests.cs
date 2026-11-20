using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// WHICH REQUESTS ARE DURABLY ADMITTED IS ONE DECLARATION, READ FROM THE REQUEST'S OWN SHAPE.
///
/// <para>
/// <c>BridgeSession.TryExecute</c> spelled the same three action ids three times - to look a durable admission up, to
/// turn a journal answer into a refusal, and to decide whether the request is admitted before dispatch - and
/// <c>MatchesDurableAdmission</c> plus <c>ExecutionAdmission.TryAdmitCandidate</c> held two more copies of it. A
/// hand-written three is the shape this repository deletes: it answers nothing for a catalogue row nobody has listed,
/// and it drifts silently, because a row outside it is admitted in memory and lost with the process.
/// </para>
/// <para>
/// The population is <see cref="FarmhandActionCatalog.Registrations"/> and the answer is
/// <see cref="FarmhandCanonicalRequest.TryCreate"/> - the journal's own statement of which request shapes it can
/// record, which reads the arguments the request carries and therefore the catalogue row that declared them. Every
/// execution registration is driven through the REAL <c>BridgeSession.TryExecute</c> with exactly the arguments its own
/// descriptor declares, and whether the durable journal received an admission is observed from the journal, not
/// described here.
/// </para>
/// </summary>
public sealed class DurableAdmissionPopulationGateTests
{
    private readonly ITestOutputHelper output;

    public DurableAdmissionPopulationGateTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void ADurablyAdmittedActionIsOneWhoseDeclaredRequestTheJournalCanExpress()
    {
        IReadOnlyList<FarmhandActionRegistration> catalogue = FarmhandActionCatalog.Registrations;
        List<FarmhandActionRegistration> executable = catalogue
            .Where(row => row.Kind == FarmhandOperationKind.Execution && row.Descriptor is not null)
            .ToList();
        List<FarmhandActionRegistration> notExecutable = catalogue.Except(executable).ToList();

        var declared = new List<string>();
        var admitted = new List<string>();
        var answered = new List<string>();
        var refused = new List<string>();
        foreach (FarmhandActionRegistration row in executable)
        {
            BridgeExecutionRequest request = ProbeRequest(row);
            bool durablyAdmitted = Drive(row, request, out string reason);
            answered.Add(row.ActionId);
            if (FarmhandCanonicalRequest.TryCreate(request, out _))
                declared.Add(row.ActionId);
            if (durablyAdmitted)
                admitted.Add(row.ActionId);
            else if (!string.Equals(reason, "accepted", StringComparison.Ordinal))
                refused.Add($"{row.ActionId}:{reason}");
        }

        List<string> mutatingWithoutAdmission = executable
            .Where(row => FarmhandActionCatalog.ChangesTheWorld(row.ActionId)
                && !admitted.Contains(row.ActionId, StringComparer.Ordinal))
            .Select(row => row.ActionId)
            .ToList();
        IEnumerable<string> ordered = admitted.OrderBy(id => id, StringComparer.Ordinal);
        string line = $"registrations {catalogue.Count} · executable {executable.Count} · examined {answered.Count} · "
            + $"declared {declared.Count} · durably admitted {admitted.Count} · world-changing without durable admission {mutatingWithoutAdmission.Count}";
        this.output.WriteLine(line);
        this.output.WriteLine($"  admitted:   {string.Join(", ", ordered)}");
        this.output.WriteLine($"  refused:    {string.Join(", ", refused.OrderBy(entry => entry, StringComparer.Ordinal))}");
        this.output.WriteLine($"  not executable here: {string.Join(", ", notExecutable.Select(row => row.ActionId).OrderBy(id => id, StringComparer.Ordinal))}");

        refused.Should().BeEmpty(
            because: $"every registration must reach the admission gate, so its population is measured and not merely listed · {line}");
        declared.Should().NotBeEmpty("the declaration must express something, or this gate agrees with itself");
        admitted.Should().BeEquivalentTo(
            declared,
            because: $"the bridge admits exactly the requests the journal declares it can express, and names any row that drifted · {line}");
    }

    /// <summary>
    /// THE FLOOR THIS CHANGE FOUND. These three are what the bridge durably admitted when the list was hand-written,
    /// not what decides admission now - the declaration does, and the arms above keep the bridge from listing them
    /// again. What is asserted here is the one loss the declaration cannot notice by itself: a journal that stops being
    /// able to express a shape it used to express takes that shape's actions back to an in-memory receipt without
    /// anything failing, and the population arm would follow it down because both sides read the same declaration.
    /// </summary>
    [Fact]
    public void TheActionsThatWereDurablyAdmittedWhenTheListWasWrittenStillAre()
    {
        foreach (string actionId in new[] { "navigate_to_destination", "express_emote", "face_direction" })
        {
            FarmhandActionRegistration row = FarmhandActionCatalog.Registrations
                .Single(candidate => string.Equals(candidate.ActionId, actionId, StringComparison.Ordinal));
            Drive(row, ProbeRequest(row), out string reason).Should().BeTrue(
                $"`{actionId}` is durably admitted by the declaration this change introduced, and losing it returns the "
                + $"action to a receipt a restart cannot recover (the dispatch was answered `{reason}`)");
        }
    }

    /// <summary>
    /// The seam must hold no action id: a fourth copy of the list would pass the population gate above only until the
    /// catalogue grew, and the next reader would find the same three ids again in the same method.
    /// </summary>
    [Fact]
    public void TheDurableAdmissionSeamNamesNoActionId()
    {
        string source = File.ReadAllText(Path.Combine(
            AppContext.BaseDirectory,
            "../../../../../../../",
            "integrations",
            "stardew",
            "BridgeSession.cs"));
        string tryExecute = MethodBody(source, "internal bool TryExecute(");
        string matchesAdmission = MethodBody(source, "private static bool MatchesDurableAdmission(");

        foreach (string actionId in new[] { "navigate_to_destination", "express_emote", "face_direction" })
        {
            tryExecute.Should().NotContain(
                $"\"{actionId}\"",
                because: "the admission population is the request's declared shape, not a list of ids in the dispatch method");
            matchesAdmission.Should().NotContain(
                $"\"{actionId}\"",
                because: "the durable tuple's canonical form is built by the journal's own factory, not re-spelled per action");
        }

        tryExecute.Should().Contain("FarmhandCanonicalRequest.TryCreate(request", because: "one predicate decides all three durable decisions");
        matchesAdmission.Should().Contain("FarmhandCanonicalRequest.TryCreate(request", because: "and the same predicate decides the tuple match");
    }

    /// <summary>
    /// The body of one declared method, read from the declaration to the first line that closes it, so an assertion is
    /// about that method and not about the file.
    /// </summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThan(0, $"`{declaration}` must exist");
        int end = source.IndexOf("\n    }\n", start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start);
        return source[start..end];
    }

    /// <summary>
    /// One request carrying exactly the arguments the row's own descriptor declares: the same wire shape
    /// <c>FarmhandExecutionAcceptance.TryValidate</c> admits, built from the declaration rather than from a list here.
    /// The enum-valued arguments take the row's own first published member, so the request is one the row's acceptance
    /// facts accept.
    /// </summary>
    private static BridgeExecutionRequest ProbeRequest(FarmhandActionRegistration row)
    {
        IReadOnlyList<FarmhandActionArgument> declared = row.Descriptor?.Arguments ?? Array.Empty<FarmhandActionArgument>();
        bool declares(string name) => declared.Any(argument => string.Equals(argument.Name, name, StringComparison.Ordinal));
        string? firstEnum(string name) => declared
            .FirstOrDefault(argument => string.Equals(argument.Name, name, StringComparison.Ordinal))?.Enum is { Count: > 0 } members
                ? members[0]
                : null;
        return new BridgeExecutionRequest(
            $"req_durable_population_{row.ActionId}",
            $"idem_durable_population_{row.ActionId}",
            row.ActionId,
            new BridgeExecutionArgs
            {
                X = declares("x") ? 0f : null,
                Y = declares("y") ? 0f : null,
                Slot = declares("slot") ? 0 : null,
                ChestId = declares("chestId") ? "probe_chest" : null,
                ExpectedQualifiedItemId = declares("expectedQualifiedItemId")
                    ? row.Descriptor?.Acceptance?.ExactExpectedQualifiedItemId ?? "probe_item"
                    : null,
                ExpectedTargetId = declares("expectedTargetId") ? "probe_target" : null,
                Destination = declares("destination") ? new BridgeNavigationDestinationSelector("label", "Farm", null) : null,
                Emote = declares("emote") ? firstEnum("emote") ?? FarmhandActionCatalog.EmoteEnum[0] : null,
                Direction = declares("direction") ? firstEnum("direction") ?? FarmhandActionCatalog.DirectionEnum[0] : null,
                Tool = declares("tool") ? firstEnum("tool") ?? FarmhandActionCatalog.ToolEnum[0] : null,
                ResponseKey = declares("responseKey") ? "probe_response" : null,
                Quantity = declares("quantity") ? 1 : null,
                Text = declares("text") ? "probe" : null,
                BuildingType = declares("buildingType") ? "probe_building" : null,
                LeftSlot = declares("leftSlot") ? 0 : null,
                RightSlot = declares("rightSlot") ? 0 : null,
                ColorSelection = declares("colorSelection") ? 0 : null,
                Choice = declares("choice") ? FarmhandActionCatalog.LevelUpChoiceEnum[0] : null,
                ExpectedSkill = declares("expectedSkill") ? 0 : null,
                ExpectedLevel = declares("expectedLevel") ? 1 : null,
                Charge = declares("charge") ? ToolCharge.Minimum : null,
            },
            ExpectedRevision: 0,
            DeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 3_000);
    }

    /// <summary>
    /// One row through the real bridge entry: a real <see cref="ExecutionManager"/> over a real
    /// <see cref="FarmhandExecutionJournal"/>, the real router, the real session. The answer is whether that journal
    /// holds an admission for the request once the dispatch is over.
    /// </summary>
    private static bool Drive(FarmhandActionRegistration row, BridgeExecutionRequest request, out string reason)
    {
        BridgeScope scope = new(
            $"save-durable-population",
            $"world-durable-population",
            $"player-durable-population",
            $"companion-durable-population",
            $"session-durable-population");
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { row.ActionId });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(new FakeModGlobalDataPersistence()),
            executionScope: scope);
        var router = new FarmhandActionRouter();
        router.Register(row, new SucceededProbeHandler());
        const string token = "durable_admission_population_token_0123456789";
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "msg_durable_population",
            "corr_durable_population",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(token)), out _, out string authReason).Should().BeTrue(authReason);

        long window = FarmhandActionDeadlineAdmission.WindowMs(row.ActionId);
        BridgeExecutionRequest fresh = request with
        {
            ExpectedRevision = executions.Revision,
            DeadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + Math.Max(1_000, Math.Min(30_000, window / 2)),
        };
        session.TryExecute(
            1,
            new BridgeEnvelope<BridgeExecutionRequest>(
                BridgeProtocol.Version,
                $"msg_{request.RequestId}",
                $"corr_{request.RequestId}",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                scope,
                "execution_request",
                fresh),
            out _,
            out reason);
        return executions.TryGetDurableAdmission(request.RequestId, request.IdempotencyKey, out _, out _);
    }

    /// <summary>
    /// Stands in for a handler whose native effect succeeded: the admission seam is the subject, not the native call.
    /// The execution id is the one the bridge bound before routing, so the receipt matches its journalled tuple.
    /// </summary>
    private sealed class SucceededProbeHandler : IFarmhandActionHandler
    {
        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatch
                && dispatch.TryGetBoundExecutionId(request.RequestId, out string bound)
                ? bound
                : request.RequestId;
            return ledger.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                "probe_native_ok",
                "native_dispatched=true");
        }
    }

    private sealed class FakeModGlobalDataPersistence : IModGlobalDataPersistence
    {
        private FarmhandExecutionJournalState? state;

        public FarmhandExecutionJournalState? Read(string key) => this.state;

        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            this.state = value;
            return true;
        }
    }
}
