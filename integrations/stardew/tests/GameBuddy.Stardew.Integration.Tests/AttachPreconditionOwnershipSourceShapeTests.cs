// The gate for one family: an attach precondition that NOTHING in the product creates.
//
// `attach_needs_native_save` was measured in a live run as a fact about the product: the first
// Farmhand binding is written by `HostFarmhandProvisioner.OnSaving` (:180-215), the engine raises
// that only from its own save cycle, and the only thing that ever opened that cycle was
// `HostAutomation.TriggerNativeSaveAfterAttachment` - a fixture switch the Host never writes into the
// Mod's config. The Host waits, the Mod answers `awaiting_save`, and nobody saves. The requirement
// was legitimate (Mod save data lands only with the engine's save) and the TRIGGER was missing.
//
// So the population of this gate is the answers the provisioning surface can give, parsed from the
// source that gives them, and the property is: every answer names the precondition it refused on,
// and that precondition is created by a production path here, by the engine's own lifecycle, by the
// Host's own signed request, or by the player - never by nobody. A code nobody classified, and a
// mechanism nobody declares, are the same failure this file exists to name.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

// MIXED SHAPE AND BEHAVIOUR: the three facts above pin repository text; the falsifier drives the same
// three rules over the pre-fix source, so it pins no file and is a behaviour test in the audit's sense.
[Trait("kind", "source-shape")]
public sealed class AttachPreconditionOwnershipSourceShapeTests
{
    private readonly ITestOutputHelper output;

    public AttachPreconditionOwnershipSourceShapeTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>Who creates the state an attach refusal names. `Player` is the only owner whose answer may be absent.</summary>
    internal enum Owner
    {
        Ours,
        Engine,
        Host,
        Player,
    }

    internal readonly record struct Declaration(Owner Owner, string Mechanism);

    /// <summary>
    /// The declaration, one row per answer the provisioning surface can give.
    ///
    /// `Ours`/`Engine`/`Host` each name a symbol that must exist in the Mod's production sources, so a
    /// row cannot be satisfied by a comment. `Player` names the player's own action, which is the one
    /// class of precondition no production path may create on the player's behalf.
    /// </summary>
    internal static readonly IReadOnlyDictionary<string, Declaration> Declared =
        new Dictionary<string, Declaration>(StringComparer.Ordinal)
        {
            ["invalid_or_unauthorized_request"] = new(Owner.Host, "HasValidSignature"),
            ["request_replayed"] = new(Owner.Host, "ConsumedRequestIds"),
            ["save_persistence_pending"] = new(Owner.Engine, "pendingSaveRequest"),
            ["protocol_mismatch"] = new(Owner.Engine, "protocolVersion"),
            ["host_not_ready"] = new(Owner.Ours, "CompanionSessionHosting"),
            ["companion_profile_not_authorized"] = new(Owner.Host, "AuthorizedCompanionIds"),
            ["cabin_bound_to_other_companion"] = new(Owner.Host, "FarmhandBindingStore"),
            ["cabin_missing"] = new(Owner.Ours, "CompanionCabinProvisioning"),
            ["cabin_busy"] = new(Owner.Engine, "getOnlineFarmers"),
            ["new_binding_requires_empty_expected_id"] = new(Owner.Host, "ExpectedFarmhandId"),
            ["expected_farmhand_mismatch"] = new(Owner.Host, "ExpectedFarmhandId"),
            ["native_farmhand_creation_failed"] = new(Owner.Engine, "CreateFarmhand"),
            ["farmhand_profile_initialization_failed"] = new(Owner.Ours, "PrepareTargetFarmhand"),
            ["farmhand_not_initialized"] = new(Owner.Ours, "PrepareTargetFarmhand"),
            ["save_in_progress"] = new(Owner.Engine, "IsSaving"),
            ["binding_conflict"] = new(Owner.Host, "ReadBindings"),
            ["bound_farmhand_missing"] = new(Owner.Engine, "GetPlayer"),
            ["farmhand_profile_mismatch"] = new(Owner.Ours, "PrepareTargetFarmhand"),
            ["cabin_identity_mismatch"] = new(Owner.Ours, "PrepareTargetFarmhand"),
            ["target_farmhand_busy"] = new(Owner.Engine, "getOnlineFarmers"),
            // The one answer that names a missing SAVE, and therefore the one this gate was written
            // for: the trigger is ours, the save cycle is the engine's, and the binding is only
            // durable once both have happened.
            ["binding_persist_pending"] = new(Owner.Ours, "RequestsNativeSave"),
            ["save_persistence_timeout"] = new(Owner.Engine, "pendingSaveTimedOut"),
            ["save_persistence_failed"] = new(Owner.Engine, "WriteSaveData"),
            ["binding_readback_mismatch"] = new(Owner.Engine, "isCustomized"),
            ["binding_readback_unavailable"] = new(Owner.Host, "ReadBindings"),
            ["binding_store_unavailable"] = new(Owner.Host, "ReadBindings"),
            ["binding_not_persisted"] = new(Owner.Engine, "WriteSaveData"),
            ["manifest_issuance_failed"] = new(Owner.Ours, "IssueManifestForPersistedBinding"),
            ["manifest_publication_failed"] = new(Owner.Ours, "WriteJson"),
            ["manifest_issued"] = new(Owner.Ours, "WriteJson"),
            ["native_lan_endpoint_unavailable"] = new(Owner.Ours, "NativeLanEndpoint"),
            ["publication_cleanup_failed"] = new(Owner.Ours, "DeleteIfOwned"),
            ["provisioning_failed"] = new(Owner.Host, "HandleRequest"),
        };

    /// <summary>The answer words whose code is not a literal at the construction site, each with its producer.</summary>
    internal static readonly IReadOnlyDictionary<string, string> DerivedAnswerProducers =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["hostState"] = "GetHostState",
            ["target.RefusalReason"] = "TargetFarmhand.Refused",
        };

    /// <summary>Every (state, code) answer the given provisioning source can give, derived from that source.</summary>
    internal static IReadOnlyList<(string State, string Code)> AnswersIn(string source)
    {
        var answers = new List<(string State, string Code)>();
        foreach (Match match in Regex.Matches(source, @"new\(""(?<state>[a-z_]+)"",\s*""(?<code>[a-z_]+)"""))
            answers.Add((match.Groups["state"].Value, match.Groups["code"].Value));
        // `TargetFarmhand.Refused("<code>")` is the same answer in one argument.
        foreach (Match match in Regex.Matches(source, @"Refused\(""(?<code>[a-z_]+)""\)"))
            answers.Add(("rejected", match.Groups["code"].Value));
        // `GetHostState()`'s own refusals become the code of the `rejected` answer that carries them;
        // `ready` is the state that admits a request, not an answer to one.
        string hostState = TryBodyOf(source, "private string GetHostState()") ?? string.Empty;
        foreach (Match match in Regex.Matches(hostState, @"return ""(?<code>[a-z_]+)"";"))
            if (match.Groups["code"].Value != "ready")
                answers.Add(("rejected", match.Groups["code"].Value));
        return answers.Distinct().OrderBy(answer => answer.Code, StringComparer.Ordinal).ToArray();
    }

    /// <summary>The rule, over any provisioning source, so a planted source drives the same comparison.</summary>
    internal static IReadOnlyList<string> FindingsFor(
        string source,
        IReadOnlyDictionary<string, Declaration> declared,
        Func<string, bool> symbolExists)
    {
        var findings = new List<string>();
        var answers = AnswersIn(source);
        foreach (Match match in Regex.Matches(source, @"new\(""rejected"",\s*(?<expr>[A-Za-z_][\w\.]*)\s*[,)]"))
        {
            string expression = match.Groups["expr"].Value;
            if (!DerivedAnswerProducers.TryGetValue(expression, out string? producer))
                findings.Add($"unparsed_answer:{expression} carries a code this gate cannot read, so its precondition is unchecked");
            else if (TryBodyOf(source, producer) is null)
                findings.Add($"unparsed_answer:{expression} is answered from '{producer}', which this source does not declare");
        }

        foreach ((string State, string Code) in answers)
        {
            if (!declared.TryGetValue(Code, out Declaration declaration))
            {
                findings.Add($"unexplained_precondition:{Code} ({State}) is not classified: say who creates it");
                continue;
            }
            if (declaration.Mechanism.Trim().Length == 0)
            {
                findings.Add($"unexplained_precondition:{Code} declares no mechanism");
                continue;
            }
            if (declaration.Owner != Owner.Player && !symbolExists(declaration.Mechanism))
            {
                findings.Add(
                    $"unexplained_precondition:{Code} claims {declaration.Owner} creates it via '{declaration.Mechanism}', " +
                    "and no production source declares that mechanism");
            }
        }

        foreach (string code in declared.Keys.Where(code => answers.All(answer => answer.Code != code)))
            findings.Add($"stale_declaration:{code} is classified but the surface can no longer answer it");

        return findings;
    }

    /// <summary>
    /// The save trigger's own findings: the site that opens the engine's save menu must be armed by the
    /// production provisioning config and must consult the binding's own request, not a fixture switch.
    /// </summary>
    internal static IReadOnlyList<string> TriggerFindingsFor(string fixturesSource, string provisionerSource)
    {
        var findings = new List<string>();
        int site = fixturesSource.IndexOf("new SaveGameMenu()", StringComparison.Ordinal);
        if (site < 0)
        {
            findings.Add("save_trigger_missing: no source opens the engine's SaveGameMenu, so no save can ever be requested");
            return findings;
        }
        string trigger = EnclosingMethod(fixturesSource, site);
        if (!trigger.Contains("RequestsNativeSave", StringComparison.Ordinal))
        {
            findings.Add("save_trigger_not_armed_by_the_binding: the trigger never consults the binding's own request");
        }
        else
        {
            // The trigger asks one question, and the answer belongs to the owner of the binding: a
            // request that does not read the production option is a request armed by something else.
            Match declaration = Regex.Match(provisionerSource, @"RequestsNativeSave\s*=>[^;]*;");
            if (!declaration.Success)
                findings.Add("save_request_has_no_owner: nothing declares why the binding requests a save");
            else if (!declaration.Value.Contains("TriggerNativeSaveAfterBinding", StringComparison.Ordinal))
                findings.Add("save_trigger_reads_no_production_option: the request is armed by something other than the Host's own provisioning config");
        }
        if (trigger.Contains("HostAutomation is not { Enable: true }", StringComparison.Ordinal))
            findings.Add("save_trigger_gated_by_a_fixture: a binding that is waiting for its save is skipped unless the fixture is armed");
        return findings;
    }

    /// <summary>The two config facts, from the config source: one production option, and no fixture twin of it.</summary>
    internal static IReadOnlyList<string> ConfigFindingsFor(string configSource)
    {
        var findings = new List<string>();
        string provisioning = BodyOf(configSource, "public sealed class HostFarmhandProvisioningConfig");
        if (!Regex.IsMatch(provisioning, @"public bool TriggerNativeSaveAfterBinding \{ get; init; \} = true;"))
            findings.Add("production_option_missing: HostFarmhandProvisioningConfig does not arm the binding save by default");
        string automation = BodyOf(configSource, "public sealed class HostAutomationConfig");
        if (automation.Contains("TriggerNativeSaveAfterAttachment", StringComparison.Ordinal))
            findings.Add("fixture_twin_of_a_production_step: HostAutomation still offers its own switch for the same save");
        return findings;
    }

    private static string? TryBodyOf(string source, string marker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0) return null;
        int open = source.IndexOf('{', start);
        if (open < 0) return null;
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}')
            {
                depth--;
                if (depth == 0) return source.Substring(open, index - open + 1);
            }
        }
        return null;
    }

    private static string BodyOf(string source, string marker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0) throw new InvalidOperationException($"declaration_not_found:{marker}");
        int open = source.IndexOf('{', start);
        if (open < 0) throw new InvalidOperationException($"declaration_body_not_found:{marker}");
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}')
            {
                depth--;
                if (depth == 0) return source.Substring(open, index - open + 1);
            }
        }
        throw new InvalidOperationException($"declaration_body_unclosed:{marker}");
    }

    /// <summary>The method whose body holds <paramref name="index"/>, from its own declaration down.</summary>
    private static string EnclosingMethod(string source, int index)
    {
        int declaration = source.LastIndexOf("private ", index, StringComparison.Ordinal);
        if (declaration < 0) throw new InvalidOperationException("enclosing_method_not_found");
        int open = source.IndexOf('{', declaration);
        int depth = 0;
        for (int cursor = open; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}')
            {
                depth--;
                if (depth == 0) return source.Substring(declaration, cursor - declaration + 1);
            }
        }
        throw new InvalidOperationException("enclosing_method_unclosed");
    }

    private static string RepositoryRoot()
    {
        string? directory = AppContext.BaseDirectory;
        while (directory is not null && !Directory.Exists(Path.Combine(directory, "integrations")))
            directory = Path.GetDirectoryName(directory);
        return directory ?? throw new InvalidOperationException("repository_root_not_found");
    }

    private static string ReadRepositoryFile(params string[] relative) =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), Path.Combine(relative)));

    private static string ReadFixturesPartials()
    {
        string directory = Path.Combine(RepositoryRoot(), "integrations", "stardew");
        return string.Join(
            "\n",
            Directory.GetFiles(directory, "ModEntry.Fixtures*.cs").OrderBy(file => file, StringComparer.Ordinal).Select(File.ReadAllText));
    }

    /// <summary>Whether the Mod's own production sources declare <paramref name="symbol"/> (tests excluded).</summary>
    private static Func<string, bool> ProductionSymbols()
    {
        string root = Path.Combine(RepositoryRoot(), "integrations", "stardew");
        string[] sources = Directory
            .GetFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .ToArray();
        string text = string.Join("\n", sources.Select(File.ReadAllText));
        return symbol => Regex.IsMatch(text, $@"\b{Regex.Escape(symbol)}\b");
    }

    [Fact]
    public void EveryAttachPrecondition_IsCreatedByANamedOwner()
    {
        var findings = FindingsFor(
            ReadRepositoryFile("integrations", "stardew", "HostFarmhandProvisioner.cs"),
            Declared,
            ProductionSymbols());
        var answers = AnswersIn(ReadRepositoryFile("integrations", "stardew", "HostFarmhandProvisioner.cs"));
        int ours = answers.Count(answer => Declared.TryGetValue(answer.Code, out Declaration row) && row.Owner == Owner.Ours);
        int engine = answers.Count(answer => Declared.TryGetValue(answer.Code, out Declaration row) && row.Owner == Owner.Engine);
        int host = answers.Count(answer => Declared.TryGetValue(answer.Code, out Declaration row) && row.Owner == Owner.Host);
        int player = answers.Count(answer => Declared.TryGetValue(answer.Code, out Declaration row) && row.Owner == Owner.Player);
        int unexplained = findings.Count(finding => finding.StartsWith("unexplained_precondition:", StringComparison.Ordinal));

        this.output.WriteLine(
            $"preconditions examined {answers.Count} · created by us {ours} · engine {engine} · host-controlled {host} · " +
            $"player-only {player} · unexplained {unexplained}");
        // Fail on zero: a reader that parsed nothing agrees with itself.
        answers.Count.Should().BeGreaterThan(0, "the provisioning surface answers something");
        findings.Should().BeEmpty();
    }

    [Fact]
    public void TheSaveTrigger_IsArmedByTheProductionProvisioningConfig()
    {
        var findings = TriggerFindingsFor(
            ReadFixturesPartials(),
            ReadRepositoryFile("integrations", "stardew", "HostFarmhandProvisioner.cs"));
        this.output.WriteLine($"save trigger findings {findings.Count}: {string.Join(" | ", findings)}");
        findings.Should().BeEmpty();
    }

    [Fact]
    public void TheProductionOption_HasNoFixtureTwin()
    {
        var findings = ConfigFindingsFor(ReadRepositoryFile("integrations", "stardew", "ModConfig.cs"));
        this.output.WriteLine($"config findings {findings.Count}: {string.Join(" | ", findings)}");
        findings.Should().BeEmpty();
    }

    /// <summary>
    /// The falsifier: the pre-fix shape, expressed as the code it really was, is reported by name.
    ///
    /// A gate that cannot be made red on purpose is decoration, so these are the three shapes that
    /// shipped: an answer whose precondition nothing creates, a trigger armed only by the fixture, and
    /// two config options for one save.
    /// </summary>
    [Fact]
    public void ThePreFixShape_IsReportedByName()
    {
        const string ProvisionerBefore = @"
            internal void OnSaving() { }
            private FarmhandProvisioningResult CompletePendingSave()
            {
                return new(""awaiting_save"", ""binding_persist_pending"", farmhand.UniqueMultiplayerID);
            }
            private FarmhandProvisioningResult HandleRequest()
            {
                if (request is null) return new(""rejected"", ""invalid_or_unauthorized_request"");
                return new(""rejected"", laterReason);
            }
            ";
        var planted = FindingsFor(
            ProvisionerBefore,
            Declared,
            symbol => symbol is not ("RequestsNativeSave" or "HasValidSignature"));
        this.output.WriteLine($"planted provisioner -> {string.Join(" | ", planted)}");
        planted.Should().Contain(finding => finding.StartsWith("unexplained_precondition:binding_persist_pending", StringComparison.Ordinal));
        planted.Should().Contain(finding => finding.StartsWith("unparsed_answer:laterReason", StringComparison.Ordinal));
        planted.Should().Contain(finding => finding.StartsWith("stale_declaration:", StringComparison.Ordinal));

        const string FixturesBefore = @"
            private void TryTriggerNativeAutomationSave()
            {
                if (!this.hostRoleConfigured || this.config.HostAutomation is not { Enable: true } || this.hostFarmhandProvisioner is null)
                {
                    this.hostAutomationSaveMenuOpened = false;
                    return;
                }
                bool attachmentSavePending = this.config.HostAutomation.TriggerNativeSaveAfterAttachment && this.hostFarmhandProvisioner.IsAwaitingSave;
                if (!attachmentSavePending) return;
                Game1.activeClickableMenu = new SaveGameMenu();
            }
            ";
        var trigger = TriggerFindingsFor(FixturesBefore, ProvisionerBefore);
        this.output.WriteLine($"planted trigger -> {string.Join(" | ", trigger)}");
        trigger.Should().Contain("save_trigger_not_armed_by_the_binding: the trigger never consults the binding's own request");
        trigger.Should().Contain("save_trigger_gated_by_a_fixture: a binding that is waiting for its save is skipped unless the fixture is armed");

        const string ConfigBefore = @"
            public sealed class HostFarmhandProvisioningConfig
            {
                public bool Enable { get; init; }
            }

            public sealed class HostAutomationConfig
            {
                public bool Enable { get; init; }
                public bool TriggerNativeSaveAfterAttachment { get; init; }
            }
            ";
        var config = ConfigFindingsFor(ConfigBefore);
        this.output.WriteLine($"planted config -> {string.Join(" | ", config)}");
        config.Should().Contain("production_option_missing: HostFarmhandProvisioningConfig does not arm the binding save by default");
        config.Should().Contain("fixture_twin_of_a_production_step: HostAutomation still offers its own switch for the same save");
    }
}
