using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using GameBuddy.Stardew.Core.BodyPrograms;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// The one reader of a `for_each` node's loop document, and the one source of the words it refuses with.
///
/// <para>
/// WHY THE MOD PARSES THIS AT ALL. The Host's compiler writes the document, but a program node can also be authored
/// directly (<c>stardew_submit_action_program</c>), so by the time a `for_each` node reaches the game thread its argument
/// is untrusted text. Expansion against a half-read declaration is the defect this form exists to remove, so nothing is
/// expanded until <see cref="TryParse"/> has answered with a loop the MODEL itself accepts.
/// </para>
/// <para>
/// THE DOCUMENT IS A STRING because that is the one canonical value the wire already carries (a canonical argument is a
/// scalar or a destination selector: <c>host/src/protocol.ts:2566</c> <c>isBodyCanonicalValue</c>). Its length is bounded
/// there too (<c>protocol.ts:2589</c> and <see cref="BodyProgramValidation.TryDecodeRuntimeValue"/> both cap a canonical
/// string at <see cref="MaximumDocumentChars"/> characters), which is why the compiler refuses a document that cannot fit
/// rather than letting the pipe refuse it later.
/// </para>
/// <para>
/// ONE SPELLING PER CONCEPT, taken from the model: the source kinds are <see cref="FarmhandForEachSource"/>'s, the axes
/// and the comparison words are <see cref="FarmhandForEachPredicate"/>'s, the step's argument count is
/// <see cref="FarmhandForEachStep.MaximumArguments"/>, and every bound this file checks is a constant on the record it
/// belongs to. A number repeated here would be a second authority for the same bound.
/// </para>
/// </summary>
public static class FarmhandForEachArguments
{
    /// <summary>The one argument a `for_each` node carries: the loop document, as a canonical string value.</summary>
    public const string LoopArgument = "loop";

    /// <summary>
    /// The one `do` argument the MOD fills per row, and a caller may never declare.
    ///
    /// A row's target identity is minted from the LIVE tile by the family the action's own descriptor declares, which is
    /// why a loop can address a patch no observation ever carried. A caller that wrote one would be stating an id for a
    /// tile it has not seen - true only until the world differs - so it is refused instead of silently overridden.
    /// Mirrors `PLAN_FOR_EACH_ROW_IDENTITY_ARGUMENT` (`host/src/body-program-for-each.ts`).
    /// </summary>
    public const string ExpectedTargetIdArgument = "expectedTargetId";

    /// <summary>
    /// Why a `do` that names the row's own target identity is refused.
    ///
    /// One word on both sides of the boundary: the compiler answers it before submission and this reader answers it on the
    /// game thread, so a caller cannot be taught one code and refused with another.
    /// </summary>
    public const string RowIdentityIsNotTheCallers = "for_each_row_identity_is_not_the_callers";

    /// <summary>
    /// How many characters the loop document may occupy.
    ///
    /// The wire's own bound on ONE canonical string value, spelled once on each side of the boundary
    /// (<c>host/src/protocol.ts:2589</c>, <see cref="BodyProgramValidation.TryDecodeRuntimeValue"/>). Said here so the
    /// compiler can refuse an oversized document with its own name and real numbers instead of shipping something the
    /// pipe will reject as <c>invalid_body_node_admission</c>, which names nothing a caller can fix.
    /// </summary>
    public const int MaximumDocumentChars = 512;

    private const string LoopFault = "for_each_invalid:loop";

    private const string SourceFault = "for_each_invalid:source";

    private const string WhereFault = "for_each_invalid:where";

    private const string EffectFault = "for_each_invalid:do";

    /// <summary>Why a `do` chain with no steps in it is refused: `do: null` is the spelling for a deliberate path.</summary>
    private const string EmptyChain = "for_each_do_empty";

    private const string RulesFault = "for_each_invalid:then";

    private static readonly string[] LoopKeys = { "source", "where", "do", "then" };

    /// <summary>
    /// Reads one `{ type: "loop", ... }` wire value as the canonical string an argument declares.
    ///
    /// <para>
    /// THE ONE PLACE THE LOOP DISCRIMINATOR IS UNDERSTOOD. On the wire a loop is tagged by `type` like every other
    /// runtime value (<c>host/src/protocol.ts:4617</c>), which is what stops it being mistaken for a string that holds
    /// the same JSON. A canonical argument, however, is a scalar or a destination selector on the frozen wire
    /// (<c>isBodyCanonicalValue</c>), so the tag is dropped HERE, at the one boundary that knows it, and every reader
    /// after this point sees the document as the string it is. A second place that understood `type: "loop"` would be a
    /// second spelling of where a loop lives.
    /// </para>
    /// </summary>
    public static bool TryCanonicalize(JsonElement value, out string? document)
    {
        document = null;
        if (value.ValueKind != JsonValueKind.Object) return false;
        using var buffer = new System.IO.MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (JsonProperty property in value.EnumerateObject())
                if (!string.Equals(property.Name, "type", StringComparison.Ordinal)) property.WriteTo(writer);
            writer.WriteEndObject();
        }
        string text = System.Text.Encoding.UTF8.GetString(buffer.ToArray());
        // Bounded at the boundary rather than later: the same document travels back to the Host in this node's admission
        // challenge, where a canonical string longer than this is refused with a code that names nothing a caller can fix.
        if (text.Length is < 2 or > MaximumDocumentChars) return false;
        document = text;
        return true;
    }

    /// <summary>
    /// Reads one node's canonical arguments into the loop the expansion runs.
    ///
    /// <paramref name="arguments"/> is exactly what the admitted node carries: one entry, <see cref="LoopArgument"/>. An
    /// argument the form does not declare is refused by name, because a caller that can add a field the Mod ignores has
    /// written a declaration nobody will honour.
    /// </summary>
    public static bool TryParse(
        IReadOnlyDictionary<string, BodyProgramCanonicalValue>? arguments,
        out FarmhandForEachLoop? loop,
        out string reasonCode)
    {
        loop = null;
        if (arguments is null)
        {
            reasonCode = LoopFault;
            return false;
        }
        string? unexpected = arguments.Keys.FirstOrDefault(key => !string.Equals(key, LoopArgument, StringComparison.Ordinal));
        if (unexpected is not null)
        {
            reasonCode = $"for_each_unknown_key:{unexpected}";
            return false;
        }
        if (!arguments.TryGetValue(LoopArgument, out BodyProgramCanonicalValue? value)
            || value is null
            || value.Kind != BodyProgramArgumentKind.String
            || value.CanonicalValue is not { } document)
        {
            reasonCode = LoopFault;
            return false;
        }
        return TryParseDocument(document, out loop, out reasonCode);
    }

    /// <summary>
    /// Reads one loop document.
    ///
    /// Separate from <see cref="TryParse"/> because the document is also the thing a submission can be checked against
    /// before any node is admitted: the grammar is the same text either way, and the reader is the same reader.
    /// </summary>
    public static bool TryParseDocument(string? document, out FarmhandForEachLoop? loop, out string reasonCode)
    {
        loop = null;
        if (string.IsNullOrWhiteSpace(document) || document.Length > MaximumDocumentChars)
        {
            reasonCode = LoopFault;
            return false;
        }
        JsonDocument parsed;
        try
        {
            parsed = JsonDocument.Parse(document);
        }
        catch (JsonException)
        {
            reasonCode = LoopFault;
            return false;
        }
        using (parsed)
        {
            JsonElement root = parsed.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                reasonCode = LoopFault;
                return false;
            }
            foreach (JsonProperty property in root.EnumerateObject())
            {
                if (Array.IndexOf(LoopKeys, property.Name) >= 0) continue;
                reasonCode = $"for_each_unknown_key:{property.Name}";
                return false;
            }
            if (!TryReadSource(root, out FarmhandForEachSource? source, out reasonCode)) return false;
            IReadOnlyList<FarmhandForEachPredicate>? where = null;
            if (root.TryGetProperty("where", out JsonElement whereElement) && !TryReadPredicates(whereElement, out where, out reasonCode))
                return false;
            FarmhandForEachEffect? effect = null;
            // `do` is REQUIRED and absence is not a path: only an explicit null states "leave this row alone", and a
            // field nobody wrote must not read as a decision somebody made.
            if (!root.TryGetProperty("do", out JsonElement doElement))
            {
                reasonCode = EffectFault;
                return false;
            }
            if (!TryReadEffect(doElement, out effect, out reasonCode)) return false;
            IReadOnlyList<FarmhandForEachRule>? then = null;
            if (root.TryGetProperty("then", out JsonElement thenElement) && !TryReadRules(thenElement, out then, out reasonCode))
                return false;

            var candidate = new FarmhandForEachLoop(source!, where, effect, then);
            if (candidate.IsValid)
            {
                loop = candidate;
                reasonCode = "accepted";
                return true;
            }
            // The model is the acceptance gate, and it names WHICH part failed rather than a bare "invalid".
            reasonCode = !source!.IsValid ? SourceFault
                : where is not null && where.Any(predicate => !predicate.IsValid) ? WhereFault
                : effect is not null && !effect.IsValid ? EffectFault
                : RulesFault;
            return false;
        }
    }

    private static bool TryReadSource(JsonElement root, out FarmhandForEachSource? source, out string reasonCode)
    {
        source = null;
        reasonCode = SourceFault;
        if (!root.TryGetProperty("source", out JsonElement element) || element.ValueKind != JsonValueKind.Object) return false;
        string? kind = null;
        foreach (JsonProperty property in element.EnumerateObject())
        {
            if (property.Name is not (FarmhandForEachSource.AreaKind or FarmhandForEachSource.FamilyKind or FarmhandForEachSource.QueryKind))
            {
                reasonCode = $"for_each_unknown_key:{property.Name}";
                return false;
            }
            // Exactly one source: two spellings of where the rows come from is a plan nobody wrote.
            if (kind is not null) return false;
            kind = property.Name;
        }
        // THE TWO SOURCES WHOSE ROW SOURCING DOES NOT EXIST YET ARE REFUSED BY NAME. Narrowing them into the rectangle
        // the caller did not write would answer "every dry crop" with "the tiles in some box", which is the measured
        // defect this form exists to remove.
        if (kind is FarmhandForEachSource.FamilyKind or FarmhandForEachSource.QueryKind)
        {
            reasonCode = $"for_each_source_unavailable:{kind}";
            return false;
        }
        if (kind is not FarmhandForEachSource.AreaKind) return false;

        JsonElement area = element.GetProperty(FarmhandForEachSource.AreaKind);
        if (area.ValueKind != JsonValueKind.Object) return false;
        int? x = null;
        int? y = null;
        int? width = null;
        int? height = null;
        foreach (JsonProperty property in area.EnumerateObject())
        {
            int? read = TryReadInteger(property.Value);
            if (read is null) return false;
            switch (property.Name)
            {
                case "x" when x is null: x = read; break;
                case "y" when y is null: y = read; break;
                case "w" when width is null: width = read; break;
                case "h" when height is null: height = read; break;
                // A repeated or undeclared member: the rectangle is exactly {x,y,w,h}.
                default: return false;
            }
        }
        if (x is null || y is null || width is null || height is null) return false;
        var candidate = new FarmhandForEachSource(FarmhandForEachSource.AreaKind, x.Value, y.Value, width.Value, height.Value);
        if (!candidate.IsValid) return false;
        source = candidate;
        reasonCode = "accepted";
        return true;
    }

    private static bool TryReadPredicates(
        JsonElement element,
        out IReadOnlyList<FarmhandForEachPredicate>? predicates,
        out string reasonCode)
    {
        predicates = null;
        reasonCode = WhereFault;
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > FarmhandForEachRule.MaximumPredicates) return false;
        var read = new List<FarmhandForEachPredicate>(element.GetArrayLength());
        foreach (JsonElement entry in element.EnumerateArray())
        {
            if (!TryReadPredicate(entry, out FarmhandForEachPredicate? predicate, out reasonCode)) return false;
            read.Add(predicate!);
        }
        if (read.Any(predicate => !predicate.IsValid))
        {
            reasonCode = WhereFault;
            return false;
        }
        predicates = read.AsReadOnly();
        reasonCode = "accepted";
        return true;
    }

    private static bool TryReadPredicate(JsonElement element, out FarmhandForEachPredicate? predicate, out string reasonCode)
    {
        predicate = null;
        reasonCode = WhereFault;
        if (element.ValueKind != JsonValueKind.Object) return false;
        List<string> names = element.EnumerateObject().Select(property => property.Name).ToList();
        bool col = names.Contains(FarmhandForEachPredicate.ColOperator, StringComparer.Ordinal);
        bool row = names.Contains(FarmhandForEachPredicate.RowOperator, StringComparer.Ordinal);
        if (col || row)
        {
            // A position guard is ONE axis. Two axes, or an axis beside a field test, is two predicates and the caller
            // should write two: folding them would hide the second from the refusal that names it.
            if (col && row || names.Any(name => name is not (FarmhandForEachPredicate.ColOperator or FarmhandForEachPredicate.RowOperator)))
            {
                reasonCode = $"for_each_where_unrecognised:{(col && row ? FarmhandForEachPredicate.ColOperator : names.First(name => name is not (FarmhandForEachPredicate.ColOperator or FarmhandForEachPredicate.RowOperator)))}";
                return false;
            }
            string axis = col ? FarmhandForEachPredicate.ColOperator : FarmhandForEachPredicate.RowOperator;
            if (!TryReadStride(element.GetProperty(axis), axis, out FarmhandForEachStride? stride, out reasonCode)) return false;
            predicate = new FarmhandForEachPredicate(null, FarmhandForEachComparison.In, Array.Empty<FarmhandForEachValue>())
            {
                Axis = axis,
                Stride = stride,
            };
            reasonCode = "accepted";
            return true;
        }

        // `List<string>.Contains` compares with `EqualityComparer<string>.Default`, which is ordinal for a string.
        if (!names.Contains("field"))
        {
            reasonCode = $"for_each_where_unrecognised:{(names.Count == 0 ? "empty" : names[0])}";
            return false;
        }
        if (!element.TryGetProperty("field", out JsonElement fieldElement) || fieldElement.ValueKind != JsonValueKind.String)
        {
            reasonCode = "for_each_where_unrecognised:field";
            return false;
        }
        string? comparison = null;
        foreach (string name in names)
        {
            if (name == "field") continue;
            if (name is not (FarmhandForEachPredicate.EqOperator or FarmhandForEachPredicate.LtOperator or FarmhandForEachPredicate.GtOperator))
            {
                reasonCode = $"for_each_where_unrecognised:{name}";
                return false;
            }
            // Two comparison words on one field is a predicate nobody can read: which one ordered the value?
            if (comparison is not null) return false;
            comparison = name;
        }
        if (comparison is null)
        {
            reasonCode = "for_each_where_unrecognised:field";
            return false;
        }
        if (!TryReadValue(element.GetProperty(comparison), out FarmhandForEachValue? value))
        {
            reasonCode = WhereFault;
            return false;
        }
        FarmhandForEachComparison kind = comparison switch
        {
            FarmhandForEachPredicate.EqOperator => FarmhandForEachComparison.Eq,
            FarmhandForEachPredicate.LtOperator => FarmhandForEachComparison.Lt,
            _ => FarmhandForEachComparison.Gt,
        };
        predicate = new FarmhandForEachPredicate(fieldElement.GetString(), kind, new[] { value! });
        if (!predicate.IsValid)
        {
            predicate = null;
            return false;
        }
        reasonCode = "accepted";
        return true;
    }

    private static bool TryReadStride(JsonElement element, string axis, out FarmhandForEachStride? stride, out string reasonCode)
    {
        stride = null;
        reasonCode = WhereFault;
        if (element.ValueKind != JsonValueKind.Object)
        {
            reasonCode = $"for_each_where_unrecognised:{axis}";
            return false;
        }
        int? every = null;
        int? offset = null;
        foreach (JsonProperty property in element.EnumerateObject())
        {
            int? read = TryReadInteger(property.Value);
            switch (property.Name)
            {
                case FarmhandForEachStride.EveryOperator when every is null && read is not null: every = read; break;
                case FarmhandForEachStride.OffsetOperator when offset is null && read is not null: offset = read; break;
                // An undeclared member, a repeated one, or an operand that is not a whole number.
                default:
                    reasonCode = property.Name is FarmhandForEachStride.EveryOperator or FarmhandForEachStride.OffsetOperator
                        ? WhereFault
                        : $"for_each_where_unrecognised:{property.Name}";
                    return false;
            }
        }
        if (every is null || offset is null)
        {
            // `every: n, offset: k` is one statement; half of it claims nothing.
            reasonCode = $"for_each_where_unrecognised:{axis}";
            return false;
        }
        var candidate = new FarmhandForEachStride(every.Value, offset.Value);
        if (!candidate.IsValid)
        {
            // An offset at or past the stride claims no index at all, so the rule could never match: refused, not run dead.
            reasonCode = WhereFault;
            return false;
        }
        stride = candidate;
        reasonCode = "accepted";
        return true;
    }

    private static bool TryReadEffect(JsonElement element, out FarmhandForEachEffect? effect, out string reasonCode)
    {
        effect = null;
        reasonCode = EffectFault;
        if (element.ValueKind == JsonValueKind.Null)
        {
            // `do: null` is a STATEMENT - this row is a deliberate path - and the model carries it as an absent effect.
            reasonCode = "accepted";
            return true;
        }
        // ONE SHAPE INTERNALLY: a single object is the chain of length one, so the step reader has one caller shape and a
        // chain of four is the same grammar written four times rather than a second form beside it.
        if (element.ValueKind == JsonValueKind.Array) return TryReadSteps(element, out effect, out reasonCode);
        if (!TryReadStep(element, 0, out FarmhandForEachStep? only, out reasonCode)) return false;
        effect = new FarmhandForEachEffect(only!);
        reasonCode = "accepted";
        return true;
    }

    /// <summary>
    /// A chain, read in the order the caller wrote it, bounded by the model's own step count.
    ///
    /// AN EMPTY CHAIN AND AN OVERLONG ONE ARE TWO FACTS. `do: []` claims nothing about a row it matched - `do: null` is the
    /// spelling for "leave this row alone" - and a chain past <see cref="FarmhandForEachEffect.MaximumSteps"/> is refused
    /// with its own length, because a bound nobody can see is a bound the caller cannot stay under.
    /// </summary>
    private static bool TryReadSteps(JsonElement element, out FarmhandForEachEffect? effect, out string reasonCode)
    {
        effect = null;
        int count = element.GetArrayLength();
        if (count == 0)
        {
            reasonCode = EmptyChain;
            return false;
        }
        if (count > FarmhandForEachEffect.MaximumSteps)
        {
            reasonCode = $"for_each_too_many_steps:{count}:{FarmhandForEachEffect.MaximumSteps}";
            return false;
        }
        var steps = new FarmhandForEachStep[count];
        for (int index = 0; index < count; index++)
        {
            if (!TryReadStep(element[index], index, out FarmhandForEachStep? step, out reasonCode)) return false;
            steps[index] = step!;
        }
        effect = new FarmhandForEachEffect(steps);
        reasonCode = "accepted";
        return true;
    }

    /// <summary>
    /// One step: `{ action, &lt;argument&gt;: &lt;scalar&gt; }`, the same object a lone `do` has always been.
    ///
    /// EVERY REFUSAL NAMES THE STEP IT IS ABOUT. A chain is read by position, so "a step is wrong" is not actionable:
    /// `for_each_do_step_unrecognised:&lt;step&gt;` says which one is not a step, and the same code with the argument's name
    /// says which part of it. A step that is not an object at all used to answer a code that named nothing a caller could
    /// fix, which is the defect class this reader keeps closing.
    /// </summary>
    private static bool TryReadStep(JsonElement element, int index, out FarmhandForEachStep? step, out string reasonCode)
    {
        step = null;
        reasonCode = $"for_each_do_step_unrecognised:{index}";
        if (element.ValueKind != JsonValueKind.Object) return false;
        if (!element.TryGetProperty("action", out JsonElement actionElement)
            || actionElement.ValueKind != JsonValueKind.String
            || actionElement.GetString() is not { Length: > 0 } action)
            return false;
        Dictionary<string, string>? arguments = null;
        foreach (JsonProperty property in element.EnumerateObject())
        {
            if (property.Name == "action") continue;
            // THE ROW'S IDENTITY IS THE MOD'S. `expectedTargetId` is minted per row from the live tile by the family the
            // action declares; a caller that wrote one has declared an id for a tile it has not seen, and the pass would
            // either have to override it (a declaration nobody honours) or dispatch it (a lie the moment the world
            // differs). Both are refused here by name.
            if (string.Equals(property.Name, ExpectedTargetIdArgument, StringComparison.Ordinal))
            {
                reasonCode = RowIdentityIsNotTheCallers;
                return false;
            }
            if (!BodyProgramValidation.IsIdentifier(property.Name) || !TryReadScalarText(property.Value, out string? text))
            {
                reasonCode = $"for_each_do_step_unrecognised:{index}:{property.Name}";
                return false;
            }
            arguments ??= new Dictionary<string, string>(StringComparer.Ordinal);
            if (arguments.Count >= FarmhandForEachStep.MaximumArguments || !arguments.TryAdd(property.Name, text!))
            {
                reasonCode = $"for_each_too_many_arguments:{index}:{FarmhandForEachStep.MaximumArguments}";
                return false;
            }
        }
        var candidate = new FarmhandForEachStep(action, arguments is null ? null : new System.Collections.ObjectModel.ReadOnlyDictionary<string, string>(arguments));
        if (!candidate.IsValid) return false;
        step = candidate;
        reasonCode = "accepted";
        return true;
    }

    private static bool TryReadRules(JsonElement element, out IReadOnlyList<FarmhandForEachRule>? rules, out string reasonCode)
    {
        rules = null;
        reasonCode = RulesFault;
        if (element.ValueKind != JsonValueKind.Array) return false;
        // The loop's own rule is one of them, which is why the count is checked against the total rather than the array.
        int total = element.GetArrayLength() + 1;
        if (total > FarmhandForEachLoop.MaximumRules)
        {
            reasonCode = $"for_each_too_many_rules:{total}";
            return false;
        }
        var read = new List<FarmhandForEachRule>(element.GetArrayLength());
        foreach (JsonElement entry in element.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object) return false;
            foreach (JsonProperty property in entry.EnumerateObject())
                if (property.Name is not ("where" or "do"))
                {
                    reasonCode = $"for_each_unknown_key:{property.Name}";
                    return false;
                }
            // A rule that names no effect at all is not a path: only an explicit null is.
            if (!entry.TryGetProperty("do", out JsonElement doElement)) return false;
            IReadOnlyList<FarmhandForEachPredicate>? where = null;
            if (entry.TryGetProperty("where", out JsonElement whereElement) && !TryReadPredicates(whereElement, out where, out reasonCode))
                return false;
            if (!TryReadEffect(doElement, out FarmhandForEachEffect? effect, out reasonCode)) return false;
            var rule = new FarmhandForEachRule(where, effect);
            if (!rule.IsValid) return false;
            read.Add(rule);
        }
        rules = read.AsReadOnly();
        reasonCode = "accepted";
        return true;
    }

    /// <summary>A whole number, the only numeric shape the wire's canonical form has.</summary>
    private static int? TryReadInteger(JsonElement element) =>
        element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out int value) ? value : null;

    private static bool TryReadValue(JsonElement element, out FarmhandForEachValue? value)
    {
        value = null;
        switch (element.ValueKind)
        {
            case JsonValueKind.String when element.GetString() is { Length: >= 1 and <= 128 } text:
                value = FarmhandForEachValue.Of(text);
                return true;
            case JsonValueKind.Number when element.TryGetInt64(out long number):
                value = FarmhandForEachValue.Of((double)number);
                return true;
            case JsonValueKind.True:
                value = FarmhandForEachValue.Of(true);
                return true;
            case JsonValueKind.False:
                value = FarmhandForEachValue.Of(false);
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// One `do` argument, as the declared string the wire arguments already are.
    ///
    /// Numbers and flags become their own words instead of a JSON rendering of them, so the string an action receives is
    /// the same one a flat request would have carried.
    /// </summary>
    private static bool TryReadScalarText(JsonElement element, out string? text)
    {
        text = element.ValueKind switch
        {
            JsonValueKind.String => element.GetString(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Number when element.TryGetInt64(out long number) => number.ToString(CultureInfo.InvariantCulture),
            _ => null,
        };
        return text is { Length: >= 1 and <= 128 };
    }
}
