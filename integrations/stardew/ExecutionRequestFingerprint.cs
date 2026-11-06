using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Text;
using System.Text.Json;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

/// <summary>
/// The identity material one <c>execution_request</c> is remembered under.
///
/// <para>
/// <see cref="BridgeSession.TryExecute"/> consults it twice: a request that arrives with an
/// already-remembered <c>idempotencyKey</c> is answered with the stored receipt only when the
/// material is IDENTICAL, and the same holds for a repeated <c>requestId</c>. A difference is a
/// conflict (<c>idempotency_key_conflict</c> / <c>request_id_conflict</c>) - two different intents
/// cannot share one identity. So the material's only job is to answer "is this the same request?".
/// </para>
/// <para>
/// It must therefore be BOTH complete and stable, and both are properties of HOW it is derived
/// rather than of the strings it produces. COMPLETE: it is rendered from
/// <see cref="BridgeExecutionArgs"/>'s own property set, so an action that gains an argument is
/// covered without anyone remembering to edit a hash - the alternative, a hand-picked subset,
/// silently omitted <c>chestId</c> (which container), <c>text</c> (which chat line),
/// <c>quantity</c> (how many), the tailoring slots, <c>tool</c>, <c>buildingType</c>,
/// <c>colorSelection</c> and the level-up pair, and
/// <c>ExecutionRequestFingerprintCoverageTests</c> exists to keep it that way. STABLE: the fields
/// are emitted in ordinal name order and nested values in the same order, never in dictionary
/// iteration order, and every value is formatted invariantly - so two identical requests can never
/// disagree, which would refuse an honest retry as a conflict.
/// </para>
/// <para>
/// Values are length-prefixed because an argument's own text can contain any separator: without
/// the length, one message could be spelled to collide with another's field layout.
/// </para>
/// </summary>
internal static class ExecutionRequestFingerprint
{
    /// <summary>How far into a nested selector the render walks. The wire holds one level of
    /// selector; the limit only stops a future self-referencing argument from recursing forever.</summary>
    private const int MaximumDepth = 4;

    /// <summary>
    /// Every argument the request carries, in ordinal name order. Derived from the wire type, which
    /// is why a new argument needs no edit here - and why excluding one is loud rather than silent.
    /// </summary>
    private static readonly PropertyInfo[] ArgumentProperties = typeof(BridgeExecutionArgs)
        .GetProperties(BindingFlags.Public | BindingFlags.Instance)
        .Where(property => !string.Equals(property.Name, nameof(BridgeExecutionArgs.AdditionalProperties), StringComparison.Ordinal))
        .OrderBy(property => property.Name, StringComparer.Ordinal)
        .ToArray();

    internal static string Of(BridgeExecutionRequest request)
    {
        var material = new StringBuilder();
        Append(material, "requestId", request.RequestId, depth: 0);
        Append(material, "action", request.Action, depth: 0);
        Append(material, "expectedRevision", request.ExpectedRevision, depth: 0);
        foreach (PropertyInfo property in ArgumentProperties)
        {
            Append(material, property.Name, property.GetValue(request.Args), depth: 0);
        }

        // Undeclared wire members are refused by the acceptance layer before this point, and are
        // rendered here anyway so the material can never be narrower than the request it names.
        if (request.Args.AdditionalProperties is { Count: > 0 } additional)
        {
            foreach (KeyValuePair<string, JsonElement> pair in additional.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            {
                Append(material, "undeclared." + pair.Key, pair.Value, depth: 0);
            }
        }

        return material.ToString();
    }

    private static void Append(StringBuilder material, string name, object? value, int depth)
    {
        string rendered = Render(value, depth);
        material
            .Append(name)
            .Append('#')
            .Append(rendered.Length.ToString(CultureInfo.InvariantCulture))
            .Append(':')
            .Append(rendered)
            .Append('\n');
    }

    private static string Render(object? value, int depth) => value switch
    {
        null => "~",
        string text => text,
        bool flag => flag ? "true" : "false",
        JsonElement element => element.GetRawText(),
        Enum member => member.ToString(),
        float single => single.ToString("R", CultureInfo.InvariantCulture),
        double real => real.ToString("R", CultureInfo.InvariantCulture),
        decimal exact => exact.ToString(CultureInfo.InvariantCulture),
        IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
        _ when depth >= MaximumDepth => value.GetType().Name,
        IEnumerable sequence => RenderSequence(sequence, depth),
        _ => RenderObject(value, depth),
    };

    private static string RenderSequence(IEnumerable sequence, int depth)
    {
        var rendered = new StringBuilder("[");
        int index = 0;
        foreach (object? item in sequence)
        {
            string element = Render(item, depth + 1);
            rendered.Append(index++).Append('#').Append(element.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(element).Append(';');
        }

        return rendered.Append(']').ToString();
    }

    private static string RenderObject(object value, int depth)
    {
        var rendered = new StringBuilder("{");
        foreach (PropertyInfo property in value.GetType()
                     .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                     .OrderBy(property => property.Name, StringComparer.Ordinal))
        {
            string member = Render(property.GetValue(value), depth + 1);
            rendered.Append(property.Name).Append('#').Append(member.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(member).Append(';');
        }

        return rendered.Append('}').ToString();
    }
}
