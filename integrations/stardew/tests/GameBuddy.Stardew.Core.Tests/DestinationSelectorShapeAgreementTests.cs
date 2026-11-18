using System.Reflection;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// GATE: <c>a_producer_object_is_refused_by_its_own_selector</c>.
///
/// <para>
/// MEASURED (round42: 5 of 6 plan refusals, round60: 4 of 9, round67's 8 `BRIDGE_FACT` refusals): the companion asked
/// for a destination, copied the object the Mod had just handed it, and the next call was refused
/// <c>destination_selector[one_of:label,ref]</c>. The object it copied was minted by this assembly: a
/// <see cref="BridgeNavigationDestinationSelector"/> always writes BOTH arms (`JsonIgnoreCondition.Never`), so a label
/// selector is on the wire as <c>{"kind":"label","label":"Mine","ref":null}</c> - while every reader of the same closed
/// shape demanded exactly the two keys of the arm that is present. One document produced a value that another document
/// refused, and the difference is the absent arm written out as <c>null</c>.
/// </para>
/// <para>
/// WHAT THIS GATE READS. The producers are found by REFLECTION over the assembly's own closed shape (a record carrying
/// Kind, Label and Ref), so a selector type added tomorrow is examined the moment it exists. The readers are found the
/// same way (a static <c>bool</c> method over a <see cref="JsonElement"/> whose name says it reads a selector) and each
/// is invoked for real, plus the two doors a selector actually arrives through: an <c>execution_request</c> and a
/// <c>program_submit</c> candidate. Every producer arm is serialized by the assembly's own writer and fed to every
/// reader; a refusal names the type, the arm and the reader.
/// </para>
/// </summary>
public sealed class DestinationSelectorShapeAgreementTests
{
    private const string RefHandle = "dr1_AAAAAAAAAAAAAAAAAAAAAA";
    private const string Label = "Mine";

    /// <summary>
    /// The closed selector shape, derived from the assembly: a type that carries Kind, Label and Ref as strings.
    ///
    /// <para>
    /// This is the population the gate exists for - a selector this assembly can MINT. A new one fails the gate until
    /// its bytes are the bytes its readers accept, which is the only way two spellings of one shape stay one shape.
    /// </para>
    /// </summary>
    private static readonly Type[] SelectorTypes = typeof(BridgeProtocol).Assembly.GetTypes()
        .Where(type => type is { IsClass: true, IsAbstract: false, IsNested: false }
            && new[] { "Kind", "Label", "Ref" }.All(name => type.GetProperty(name)?.PropertyType == typeof(string)))
        .OrderBy(type => type.FullName, StringComparer.Ordinal)
        .ToArray();

    /// <summary>One reader of the closed shape: its name, and the refusal it answers, or null when it accepts.</summary>
    private sealed record Reader(string Name, Func<string, string?> Refusal);

    [Fact]
    public void EveryClosedSelectorShapeThisAssemblyMintsIsAcceptedByEveryReaderThatNamesIt()
    {
        SelectorTypes.Should().NotBeEmpty(
            "the assembly declares closed-form destination selectors, so the population is never empty");

        Reader[] readers = Readers();
        readers.Should().HaveCountGreaterThanOrEqualTo(5,
            $"the Mod admits a selector through its wire doors and its journal readers: {string.Join(", ", readers.Select(reader => reader.Name))}");

        var failures = new List<string>();
        var examined = new List<string>();
        foreach (Type type in SelectorTypes)
            foreach (string arm in new[] { "label", "ref" })
            {
                string json = Mint(type, arm);
                examined.Add($"{type.Name}:{arm}:{json}");
                foreach (Reader reader in readers)
                {
                    string? refusal = reader.Refusal(json);
                    if (refusal is null) continue;
                    failures.Add($"a_producer_object_is_refused_by_its_own_selector:{type.Name} ({arm} arm) "
                        + $"-> {reader.Name} refused it ({refusal}); producer bytes: {json}");
                }
            }

        examined.Should().NotBeEmpty("every selector type mints two arms, so the population is never empty");
        failures.Should().BeEmpty(
            $"a selector this assembly writes must be one this assembly reads; examined {examined.Count} produced arms "
            + $"over {SelectorTypes.Length} selector types and {readers.Length} readers");
    }

    /// <summary>
    /// The same question asked of the DOCUMENT the companion actually copies from.
    ///
    /// <para>
    /// `find_destination` answers with a navigation read result, and the selector arrives inside it - under `destination`
    /// when the search resolved, and under `candidates[].destination` when it was ambiguous. Those are the bytes the
    /// model holds in its context, so the gate reads them out of the serialized document rather than minting a record,
    /// which is the difference between proving a record round-trips and proving the published value is admissible.
    /// </para>
    /// </summary>
    [Fact]
    public void TheSelectorInsideThePublishedNavigationResultIsAdmissibleAsAnArgument()
    {
        var resolved = new BridgeNavigationReadResult(
            "resolved",
            "exact_current_locale",
            null,
            null,
            null,
            new BridgeNavigationDestinationSelector("label", Label, null),
            "unknown");
        var candidates = new BridgeNavigationReadResult(
            "candidates",
            "fuzzy_match",
            null,
            null,
            new[]
            {
                new BridgeDestinationSearchCandidate(Label, null, new BridgeNavigationDestinationSelector("ref", null, RefHandle), "unknown"),
            },
            null,
            null);

        string[] published =
        {
            Property(Serialize(resolved), "destination"),
            Property(Serialize(candidates), "candidates", 0, "destination"),
        };

        published.Should().OnlyContain(json => json.Contains("\"kind\"", StringComparison.Ordinal));
        var failures = new List<string>();
        foreach (string selector in published)
            foreach (Reader reader in Readers())
                if (reader.Refusal(selector) is { } refusal)
                    failures.Add($"{reader.Name} refused the published selector ({refusal}): {selector}");

        failures.Should().BeEmpty(
            $"the selector `find_destination` publishes must be the selector `navigate_to_destination` accepts; read {published.Length} published selectors");
    }

    /// <summary>
    /// The readers this gate drives, derived from the assembly and from the two doors a selector arrives through.
    ///
    /// <para>
    /// A private reader is a real reader: the journal's is what decides whether a program read back from disk still holds
    /// the destination it was given. Its signature is read by reflection, and a reader whose parameters this gate cannot
    /// drive is reported as a gap rather than skipped, because a skipped reader is a green gate over an unread fact.
    /// </para>
    /// </summary>
    private static Reader[] Readers()
    {
        var readers = new List<Reader>
        {
            new("execution_request.navigate_to_destination.args.destination", ExecutionRequestRefusal),
            new("program_submit.nodes[].arguments.destination", ProgramSubmitRefusal),
        };

        MethodInfo[] jsonSelectors = typeof(BridgeProtocol).Assembly.GetTypes()
            .SelectMany(type => type.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
            .Where(method => method.ReturnType == typeof(bool)
                && method.GetParameters().Length is 1 or 2
                && method.GetParameters()[0].ParameterType == typeof(JsonElement)
                && method.Name.Contains("Selector", StringComparison.Ordinal))
            .OrderBy(method => $"{method.DeclaringType!.Name}.{method.Name}", StringComparer.Ordinal)
            .ToArray();

        jsonSelectors.Should().NotBeEmpty("the assembly reads the closed selector shape somewhere, so the population is never empty");
        foreach (MethodInfo method in jsonSelectors)
        {
            string name = $"{method.DeclaringType!.Name}.{method.Name}";
            ParameterInfo[] parameters = method.GetParameters();
            if (parameters.Length == 1 || (parameters[1].IsOut && parameters[1].ParameterType.GetElementType()?.Name == nameof(BodyProgramDestinationSelector)))
                readers.Add(new Reader(name, json => Accepts(method, json) ? null : "refused"));
            else
                readers.Add(new Reader(name, _ => $"this gate cannot drive {name}({string.Join(", ", parameters.Select(parameter => parameter.ParameterType.Name))})"));
        }
        return readers.ToArray();
    }

    private static bool Accepts(MethodInfo method, string json)
    {
        ParameterInfo[] parameters = method.GetParameters();
        using JsonDocument document = JsonDocument.Parse(json);
        object?[] arguments = new object?[parameters.Length];
        arguments[0] = document.RootElement;
        return (bool)method.Invoke(null, arguments)!;
    }

    private static string? ExecutionRequestRefusal(string selectorJson) =>
        BridgeProtocol.TryDeserializeExecutionRequest(
            Envelope("execution_request",
                "{\"requestId\":\"req_nav_1\",\"idempotencyKey\":\"req_nav_1\",\"action\":\"navigate_to_destination\","
                + "\"args\":{\"destination\":" + selectorJson + "},\"expectedRevision\":1,\"deadlineMs\":5000}"),
            out _,
            out string reason)
            ? null
            : reason;

    private static string? ProgramSubmitRefusal(string selectorJson) =>
        BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(
            Envelope("program_submit",
                "{\"programId\":\"prog_1\",\"nodes\":[{\"nodeId\":\"n01\",\"actionId\":\"navigate_to_destination\","
                + "\"arguments\":{\"destination\":{\"type\":\"destination_selector\",\"destination\":" + selectorJson + "}},"
                + "\"dependsOn\":[],\"bindings\":{}}]}"),
            out _,
            out string reason)
            ? null
            : reason;

    private static string Envelope(string type, string payload) =>
        "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,"
        + "\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\",\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},"
        + "\"type\":\"" + type + "\",\"payload\":" + payload + "}";

    /// <summary>One arm of one selector type, written by the assembly's own writer.</summary>
    private static string Mint(Type type, string arm) =>
        Serialize(arm == "label"
            ? Activator.CreateInstance(type, "label", Label, null)!
            : Activator.CreateInstance(type, "ref", null, RefHandle)!);

    private static string Serialize(object selector) => JsonSerializer.Serialize(selector, selector.GetType(), BridgeProtocol.JsonOptions);

    /// <summary>One nested value out of a serialized document, by the property path a reader would walk.</summary>
    private static string Property(string document, params object[] path)
    {
        using JsonDocument parsed = JsonDocument.Parse(document);
        JsonElement current = parsed.RootElement;
        foreach (object step in path) current = step is int index ? current[index] : current.GetProperty((string)step);
        return current.GetRawText();
    }
}
