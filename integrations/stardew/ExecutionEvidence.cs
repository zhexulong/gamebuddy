using System;
using System.Globalization;
using System.Text;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

/// <summary>
/// One `key=value;…` detail string: the ordered field list an execution terminal carries, built from NAMED fields
/// rather than from a format string. The wire format is the Mod's, and it is a map - the Host parses the detail by
/// splitting on `;` and then on `=`, so a field whose value carries either separator turns one field into two and the
/// detail into a different fact. Such a value is REFUSED here instead of being escaped: escaping would change bytes the
/// Host already parses, and a refusal is already a terminal outcome (the router turns a handler's exception into
/// `uncertain/handler_exception/never_retry=true`), which is the honest reading of "the Mod cannot describe what it
/// did".
///
/// WHY A BUILDER AND NOT AN INTERPOLATION. Across the action family the detail string was spelled inline at every
/// terminal - 1,291 of the family's 18,478 code lines carried an interpolated detail when this lane was measured - so
/// the same field was named in a dozen places and nothing could answer "what does this action's evidence carry?". A
/// field could be dropped from one site by deleting a word, and the only reader who would notice is the Host's parser,
/// at run time, on a string that still looks well formed. Here the field names are the call, and
/// <see cref="EvidenceDetail"/> is the one place the `key=value;…` form exists.
///
/// Numbers render through <see cref="CultureInfo.InvariantCulture"/> and booleans as `true`/`false`. The strings this
/// replaced interpolated ints and strings, whose rendering is culture-independent, and the one float carried
/// `string.Create(InvariantCulture, …)`; so this is the same byte stream on every machine, stated once rather than per
/// site.
/// </summary>
internal sealed class EvidenceDetail
{
    private readonly StringBuilder text;

    private EvidenceDetail(string first) => this.text = new StringBuilder(first);

    /// <summary>A detail whose first field is <paramref name="name"/>=<paramref name="value"/>.</summary>
    internal static EvidenceDetail Of(string name, string value) => new(Rendered(name, value));

    internal static EvidenceDetail Of(string name, int value) => new(Rendered(name, value.ToString(CultureInfo.InvariantCulture)));

    internal EvidenceDetail Field(string name, string value)
    {
        this.text.Append(';').Append(Rendered(name, value));
        return this;
    }

    internal EvidenceDetail Field(string name, int value) => this.Field(name, value.ToString(CultureInfo.InvariantCulture));

    internal EvidenceDetail Field(string name, float value) => this.Field(name, value.ToString(CultureInfo.InvariantCulture));

    internal EvidenceDetail Flag(string name, bool value) => this.Field(name, value ? "true" : "false");

    /// <summary>
    /// This detail as it goes out: the request identity the terminal is bound to, then the fields. The `;` between the
    /// two is the only place the identity is joined to a detail, so a site cannot spell the prefix differently.
    /// </summary>
    internal string WithIdentity(EvidenceDetail identity) => $"{identity};{this}";

    public override string ToString() => this.text.ToString();

    /// <summary>
    /// One rendered `name=value`, refusing anything the detail's own parse cannot read back: an empty name, or a `;`/`=`
    /// inside either half. The refusal names the FIELD, because the caller's question is "which field is wrong?".
    /// </summary>
    private static string Rendered(string name, string value)
    {
        if (name.Length == 0)
            throw new ArgumentException("an evidence field must have a name", nameof(name));
        if (name.Contains(';', StringComparison.Ordinal) || name.Contains('=', StringComparison.Ordinal))
            throw new ArgumentException($"evidence field name carries a separator: {name}", nameof(name));
        if (value.Contains(';', StringComparison.Ordinal) || value.Contains('=', StringComparison.Ordinal))
            throw new ArgumentException($"evidence field '{name}' carries a separator: {value}", nameof(value));
        return string.Concat(name, "=", value);
    }
}

/// <summary>
/// How one action names the two positions its requests act on: the slot names its identity uses and the item names
/// its details use. `tailor_clothing` names the sewing machine's two input slots `left_slot`/`right_slot` and their
/// items `left_item`/`right_item`; `dye_clothing_with_item` names the same two positions `garment_slot`/`dye_slot` and
/// `garment_item`/`dye_item`. Those names are the wire, so they cannot be unified - but they can be stated once per
/// action instead of at every terminal, which is what lets each terminal name only the values it observed.
/// </summary>
internal sealed class PairVocabulary
{
    internal PairVocabulary(string slotFirst, string slotSecond, string itemFirst, string itemSecond)
    {
        this.SlotFirst = slotFirst;
        this.SlotSecond = slotSecond;
        this.ItemFirst = itemFirst;
        this.ItemSecond = itemSecond;
    }

    /// <summary>The first slot's name in the identity (`left_slot`).</summary>
    internal string SlotFirst { get; }

    /// <summary>The second slot's name in the identity (`right_slot`).</summary>
    internal string SlotSecond { get; }

    /// <summary>The first item's field name in a detail (`left_item`).</summary>
    internal string ItemFirst { get; }

    /// <summary>The second item's field name in a detail (`right_item`).</summary>
    internal string ItemSecond { get; }
}

internal sealed partial class ExecutionManager
{
    /// <summary>
    /// One request's terminal seam. `RememberTerminal` takes the request identity, the execution identity, the state,
    /// the reason code and the evidence at every one of its 841 call sites in the family (measured across the 50 files
    /// when this lane was measured), and every site respelled the `$"{identity};…"` prefix and the `ExecutionState.` it
    /// had already decided. This type holds the first four facts once and offers the SHAPES the family actually uses, so
    /// a site says what it observed and nothing else.
    ///
    /// THE SHAPES THAT REMAINED DISTINCT, and why each is its own method rather than one `Write(state, code, evidence)`:
    /// <list type="bullet">
    /// <item><b>the four states</b> - `Rejected`, `Uncertain`, `Succeeded`, `PartiallySucceeded`. Collapsing them into
    /// one call with a state argument moves the enumeration back to every site.</item>
    /// <item><b>a slot refusal</b> - `inventory_slots` plus one or both items, with `none`/`same_slot` for the slot that
    /// has no item. The two spellings (one item, both items) are the left and right halves of the same fact.</item>
    /// <item><b>a pair refusal</b> - the two items the request named, optionally with one more field (`published_kind`
    /// on `target_not_found`, `reason` on the two branch refusals, `native_branch` on an in-place combination).</item>
    /// <item><b>a live-target refusal</b> - `live=` before the pair, because that is where the wire order puts it.</item>
    /// <item><b>a native exception</b> - the pair, the exception's type, `native_call_ran_unknown=true`, and for a dye
    /// the colour it had before the call. It is `Uncertain` in both actions: the call ran and its outcome is unknown.</item>
    /// </list>
    /// A single-site detail (the dyeable flag, the in-place branch, the two `reason=` refusals) is NOT given a shape
    /// here: it has no second caller to collapse with, and a method named after one caller is a second name for the
    /// call site. Those go through the state methods with an <see cref="EvidenceDetail"/>.
    /// </summary>
    internal sealed class TerminalRecorder
    {
        private readonly ExecutionManager owner;
        private readonly string requestId;
        private readonly string executionId;
        private readonly EvidenceDetail identity;

        internal TerminalRecorder(ExecutionManager owner, string requestId, string executionId, EvidenceDetail identity)
        {
            this.owner = owner;
            this.requestId = requestId;
            this.executionId = executionId;
            this.identity = identity;
        }

        internal LocalExecutionReceipt Rejected(string reasonCode, EvidenceDetail detail) =>
            this.Write(ExecutionState.Rejected, reasonCode, detail);

        internal LocalExecutionReceipt Uncertain(string reasonCode, EvidenceDetail detail) =>
            this.Write(ExecutionState.Uncertain, reasonCode, detail);

        internal LocalExecutionReceipt Succeeded(string reasonCode, EvidenceDetail detail) =>
            this.Write(ExecutionState.Succeeded, reasonCode, detail);

        internal LocalExecutionReceipt PartiallySucceeded(string reasonCode, EvidenceDetail detail) =>
            this.Write(ExecutionState.PartiallySucceeded, reasonCode, detail);

        internal LocalExecutionReceipt SlotRejected(string reasonCode, PairVocabulary pair, int inventorySlots, string first) =>
            this.Rejected(reasonCode, EvidenceDetail.Of("inventory_slots", inventorySlots).Field(pair.ItemFirst, first));

        internal LocalExecutionReceipt SlotRejected(string reasonCode, PairVocabulary pair, int inventorySlots, string first, string second) =>
            this.Rejected(reasonCode, EvidenceDetail.Of("inventory_slots", inventorySlots).Field(pair.ItemFirst, first).Field(pair.ItemSecond, second));

        internal LocalExecutionReceipt PairRejected(string reasonCode, PairVocabulary pair, string first, string second) =>
            this.Rejected(reasonCode, EvidenceDetail.Of(pair.ItemFirst, first).Field(pair.ItemSecond, second));

        internal LocalExecutionReceipt PairRejected(string reasonCode, PairVocabulary pair, string first, string second, string fieldName, string fieldValue) =>
            this.Rejected(reasonCode, EvidenceDetail.Of(pair.ItemFirst, first).Field(pair.ItemSecond, second).Field(fieldName, fieldValue));

        internal LocalExecutionReceipt LiveTargetRejected(string reasonCode, PairVocabulary pair, string live, string first, string second) =>
            this.Rejected(reasonCode, EvidenceDetail.Of("live", live).Field(pair.ItemFirst, first).Field(pair.ItemSecond, second));

        internal LocalExecutionReceipt NativeExceptionUncertain(string reasonCode, PairVocabulary pair, string first, string second, Exception nativeException) =>
            this.Uncertain(reasonCode, EvidenceDetail.Of(pair.ItemFirst, first).Field(pair.ItemSecond, second)
                .Field("native_exception", nativeException.GetType().Name).Flag("native_call_ran_unknown", true));

        internal LocalExecutionReceipt NativeExceptionUncertain(string reasonCode, PairVocabulary pair, string first, string second, string colourBefore, Exception nativeException) =>
            this.Uncertain(reasonCode, EvidenceDetail.Of(pair.ItemFirst, first).Field(pair.ItemSecond, second)
                .Field("colour_before", colourBefore).Field("native_exception", nativeException.GetType().Name).Flag("native_call_ran_unknown", true));

        private LocalExecutionReceipt Write(ExecutionState state, string reasonCode, EvidenceDetail detail) =>
            this.owner.RememberTerminal(this.requestId, this.executionId, state, reasonCode, detail.WithIdentity(this.identity));
    }
}
