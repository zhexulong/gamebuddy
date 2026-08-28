using System.Text.Json;
using GameBuddy.Stardew;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using StardewModdingAPI;

internal static class CompanionPresentationPolicyTests
{
    internal static void Run()
    {
        Assert(BridgeProtocol.IsOpaqueId("expression_01"), "opaque expression id must be accepted.");
        Assert(!BridgeProtocol.IsOpaqueId("expression bad"), "unbounded expression id must fail closed.");

        const long generation = 7;
        BridgeScope scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal));
        BridgeSession session = new(
            new ExecutionManager(new SilentMonitor(), () => publication),
            scope,
            "a".PadRight(32, 'a'),
            () => publication,
            () => "en-US");
        BridgeEnvelope<BridgeHello> hello = Hello(scope, "hello_7", "a".PadRight(32, 'a'));
        Assert(session.TryAuthenticate(generation, hello, out BridgeEnvelope<BridgeHelloAck>? acknowledgement, out string authenticationReason)
            && authenticationReason == "accepted" && acknowledgement is not null,
            "test session must authenticate with a locale-bearing acknowledgement.");
        Assert(BridgeProtocol.TrySerialize(acknowledgement!, out string acknowledgementJson, out string acknowledgementSerializationReason)
            && acknowledgementSerializationReason == "accepted",
            "locale-bearing hello acknowledgement must serialize.");
        using (JsonDocument acknowledgementDocument = JsonDocument.Parse(acknowledgementJson))
            Assert(acknowledgementDocument.RootElement.GetProperty("payload").GetProperty("presentationLocale").GetString() == "en-US",
                "hello acknowledgement must serialize the exact Mod-provided presentation locale.");

        BridgeEnvelope<BridgeObserveRequest> observe = new(
            BridgeProtocol.Version, "observe_7", "observe_7", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "observe_request", new BridgeObserveRequest());
        Assert(session.TryObserve(generation, observe, out BridgeEnvelope<BridgeSnapshot>? snapshot, out string observeReason)
            && observeReason == "accepted" && snapshot is not null,
            "authenticated observation must produce a locale-bearing snapshot.");
        Assert(BridgeProtocol.TrySerialize(snapshot!, out string snapshotJson, out string snapshotSerializationReason)
            && snapshotSerializationReason == "accepted",
            "locale-bearing snapshot must serialize.");
        using (JsonDocument snapshotDocument = JsonDocument.Parse(snapshotJson))
            Assert(snapshotDocument.RootElement.GetProperty("payload").GetProperty("presentationLocale").GetString() == "en-US",
                "snapshot must serialize the exact Mod-provided presentation locale.");

        BridgeSession receiptSession = CreateSession(scope, () => "en-US");
        Authenticate(receiptSession, generation, scope);
        BridgePlayerControlFact playerControl = new(PlayerControlProtocol.PlayerInput, "control_01", "source_01", "hello", "en-US", "host_01");
        BridgeEnvelope<BridgePlayerControlReceipt> receipt = PlayerControlReceiptEnvelope(scope, "receipt_01", "control_01", "source_01");
        Assert(!receiptSession.TryAcceptPlayerControlReceipt(generation, receipt, out string unknownReceiptReason)
            && unknownReceiptReason == "invalid_player_control_receipt",
            "a receipt for a control this generation did not issue must fail closed.");
        Assert(receiptSession.TryCreatePlayerControlEvent(generation, playerControl, "player_control_01", out _),
            "an authenticated generation must issue a bounded player-control fact before it can accept its receipt.");
        Assert(receiptSession.TryAcceptPlayerControlReceipt(generation, receipt, out string acceptedReceiptReason)
            && acceptedReceiptReason == "accepted",
            "the exact same-generation pending player-control receipt must be accepted once.");
        Assert(!receiptSession.TryAcceptPlayerControlReceipt(generation, receipt, out string replayReceiptReason)
            && replayReceiptReason == "invalid_player_control_receipt",
            "a consumed player-control receipt must fail closed on replay.");
        BridgePlayerControlFact abandonedControl = playerControl with { ControlId = "control_abandoned", SourceEventId = "source_abandoned" };
        Assert(receiptSession.TryCreatePlayerControlEvent(generation, abandonedControl, "player_control_abandoned", out _),
            "an outbound control must be reservable before queue-admission rollback.");
        Assert(!receiptSession.TryAbandonPlayerControl(generation, "control_forged", abandonedControl.SourceEventId),
            "an unknown control id must not abandon another pending player-control receipt.");
        Assert(receiptSession.TryAbandonPlayerControl(generation, abandonedControl.ControlId, abandonedControl.SourceEventId),
            "the exact same-generation queued-control reservation must be abandonable before pipe admission.");
        Assert(!receiptSession.TryAcceptPlayerControlReceipt(generation,
            PlayerControlReceiptEnvelope(scope, "receipt_abandoned", abandonedControl.ControlId, abandonedControl.SourceEventId), out string abandonedReceiptReason)
            && abandonedReceiptReason == "invalid_player_control_receipt",
            "a control rejected before pipe admission must not accept a later receipt.");
        Assert(receiptSession.TryCreatePlayerControlEvent(generation, playerControl with { ControlId = "control_old", SourceEventId = "source_old" }, "player_control_old", out _),
            "a second pending control must be issuable before reauthentication.");
        BridgeEnvelope<BridgePlayerControlReceipt> oldGenerationReceipt = PlayerControlReceiptEnvelope(scope, "receipt_old", "control_old", "source_old");
        Authenticate(receiptSession, generation + 1, scope);
        Assert(!receiptSession.TryAcceptPlayerControlReceipt(generation, oldGenerationReceipt, out string staleGenerationReason)
            && staleGenerationReason == "unauthenticated",
            "a prior generation must not consume its receipt after reauthentication.");
        Assert(!receiptSession.TryAcceptPlayerControlReceipt(generation + 1, oldGenerationReceipt, out string clearedReceiptReason)
            && clearedReceiptReason == "invalid_player_control_receipt",
            "reauthentication must clear prior generation pending controls.");
        for (int index = 0; index < 64; index++)
        {
            Assert(receiptSession.TryCreatePlayerControlEvent(generation + 1,
                playerControl with { ControlId = $"control_pending_{index}", SourceEventId = $"source_pending_{index}" },
                $"player_control_pending_{index}", out _),
                "bounded pending player-control capacity must accept its declared limit.");
        }
        Assert(!receiptSession.TryCreatePlayerControlEvent(generation + 1,
            playerControl with { ControlId = "control_over_limit", SourceEventId = "source_over_limit" },
            "player_control_over_limit", out _),
            "pending player-control capacity must fail closed above its declared limit.");

        BridgeSession invalidLocaleAtHello = CreateSession(scope, () => string.Empty);
        Assert(!invalidLocaleAtHello.TryAuthenticate(generation, Hello(scope, "hello_invalid_locale", "a".PadRight(32, 'a')),
            out BridgeEnvelope<BridgeHelloAck>? invalidAcknowledgement, out string invalidHelloReason)
            && invalidAcknowledgement is null && invalidHelloReason == "invalid_presentation_locale",
            "invalid native locale must reject hello acknowledgement without a serializable response.");

        BridgeSession throwingLocaleAtHello = CreateSession(scope, () => throw new InvalidOperationException("native_locale_unavailable"));
        Assert(!throwingLocaleAtHello.TryAuthenticate(generation, Hello(scope, "hello_throwing_locale", "a".PadRight(32, 'a')),
            out BridgeEnvelope<BridgeHelloAck>? throwingAcknowledgement, out string throwingHelloReason)
            && throwingAcknowledgement is null && throwingHelloReason == "invalid_presentation_locale",
            "throwing native locale source must reject hello acknowledgement without a serializable response.");
        string observedLocale = "en-US";
        BridgeSession invalidLocaleAfterAuthentication = CreateSession(scope, () => observedLocale);
        Authenticate(invalidLocaleAfterAuthentication, generation, scope);
        observedLocale = string.Empty;
        Assert(!invalidLocaleAfterAuthentication.TryObserve(generation, observe, out BridgeEnvelope<BridgeSnapshot>? invalidSnapshot, out string invalidSnapshotReason)
            && invalidSnapshot is null && invalidSnapshotReason == "invalid_presentation_locale",
            "invalid native locale must reject snapshot without a serializable response.");

        int sends = 0;
        BridgeEnvelope<BridgeCompanionPresentationRequest> valid = PresentationEnvelope(scope, "message_01", "expression_01", "source_01", "Hello.", "en-US", 0, 0);
        Assert(session.TryPresentCompanionText(generation, valid, _ => { sends++; return true; }, out _, out string acceptedReason)
            && acceptedReason == "accepted" && sends == 1, "authenticated exact presentation must send once.");
        Assert(session.TryPresentCompanionText(generation, valid with { CorrelationId = "message_02", MessageId = "message_02" }, _ => { sends++; return true; }, out _, out string replayReason)
            && replayReason == "companion_presentation_replay" && sends == 1, "exact replay must return a receipt without a second native send.");
        Assert(!session.TryPresentCompanionText(generation, valid with { Payload = valid.Payload with { Text = "changed" } }, _ => true, out _, out string conflictReason)
            && conflictReason == "companion_presentation_expression_conflict", "same expression with another fingerprint must fail closed.");
        Assert(!session.TryPresentCompanionText(generation + 1, valid with { Payload = valid.Payload with { ExpressionId = "expression_02" } }, _ => true, out _, out string generationReason)
            && generationReason == "unauthenticated", "wrong bridge generation must fail closed.");
        Assert(!session.TryPresentCompanionText(generation, valid with { Scope = scope with { PlayerId = "other_player" }, Payload = valid.Payload with { ExpressionId = "expression_03" } }, _ => true, out _, out string scopeReason)
            && scopeReason == "invalid_envelope", "wrong scope must fail closed.");
        Assert(!session.TryPresentCompanionText(generation, valid with { Payload = valid.Payload with { ExpressionId = "expression_04", ExpectedRevision = 1 } }, _ => true, out _, out string revisionReason)
            && revisionReason == "invalid_or_stale_companion_presentation", "stale revision must fail closed.");
        session.AdvancePresentationEpoch();
        Assert(!session.TryPresentCompanionText(generation, valid with { Payload = valid.Payload with { ExpressionId = "expression_05" } }, _ => true, out _, out string epochReason)
            && epochReason == "invalid_or_stale_companion_presentation", "stale presentation epoch must fail closed.");

        BridgeEnvelope<BridgeCompanionPresentationRequest> throwing = PresentationEnvelope(scope, "message_06", "expression_06", "source_06", "throws", "en-US", 0, 1);
        int throwingSends = 0;
        Assert(!session.TryPresentCompanionText(generation, throwing, _ => { throwingSends++; throw new InvalidOperationException("after_send"); }, out _, out string throwReason)
            && throwReason == "companion_presentation_send_failed" && throwingSends == 1, "throwing native sender must fail closed after one attempted send.");
        Assert(!session.TryPresentCompanionText(generation, throwing with { CorrelationId = "message_07", MessageId = "message_07" }, _ => { throwingSends++; return true; }, out _, out string throwReplayReason)
            && throwReplayReason == "companion_presentation_send_failed" && throwingSends == 1, "throwing sender replay must preserve failure without a second native send.");

        BridgeEnvelope<BridgeCompanionPresentationRequest> unavailable = PresentationEnvelope(scope, "message_08", "expression_08", "source_08", "unavailable", "en-US", 0, 1);
        int unavailableSends = 0;
        Assert(!session.TryPresentCompanionText(generation, unavailable, _ => { unavailableSends++; return false; }, out _, out string unavailableReason)
            && unavailableReason == "companion_presentation_target_unavailable" && unavailableSends == 1, "unavailable native target must fail closed.");
        Assert(!session.TryPresentCompanionText(generation, unavailable with { CorrelationId = "message_09", MessageId = "message_09" }, _ => { unavailableSends++; return true; }, out _, out string unavailableReplayReason)
            && unavailableReplayReason == "companion_presentation_target_unavailable" && unavailableSends == 1, "unavailable target replay must preserve failure without a second native send.");

        BridgeEnvelope<BridgeSystemNoticeRequest> stopNotice = SystemNoticeEnvelope(
            scope, "notice_message_01", "notice_01", "system.stop.no_active_turn", "No reply is currently being generated.", "en-US");
        int noticeSends = 0;
        Assert(session.TryPresentSystemNotice(generation, stopNotice, _ => { noticeSends++; return true; },
            out BridgeEnvelope<BridgeSystemNoticeReceipt>? stopNoticeReceipt, out string noticeReason)
            && noticeReason == "accepted" && stopNoticeReceipt is not null && noticeSends == 1,
            "authenticated fixed system notice must send once and return a receipt.");
        Assert(session.TryPresentSystemNotice(generation, stopNotice with { CorrelationId = "notice_message_02", MessageId = "notice_message_02" },
            _ => { noticeSends++; return true; }, out _, out string noticeReplayReason)
            && noticeReplayReason == "system_notice_replay" && noticeSends == 1,
            "exact system notice replay must preserve its receipt without a second native send.");
        Assert(!session.TryPresentSystemNotice(generation, stopNotice with { Payload = stopNotice.Payload with { Text = "changed" } },
            _ => true, out _, out string noticeConflictReason)
            && noticeConflictReason == "system_notice_conflict",
            "same notice id with different fixed copy must fail closed.");
        BridgeEnvelope<BridgeSystemNoticeRequest> throwingNotice = SystemNoticeEnvelope(
            scope, "notice_message_throw", "notice_throw", "system.stop.active_turn_cancelled", "Generation stopped.", "en-US");
        int throwingNoticeSends = 0;
        Assert(!session.TryPresentSystemNotice(generation, throwingNotice, _ => { throwingNoticeSends++; throw new InvalidOperationException("after_send"); },
            out _, out string throwingNoticeReason)
            && throwingNoticeReason == "system_notice_send_failed" && throwingNoticeSends == 1,
            "throwing system notice sender must fail closed after one attempted native send.");
        Assert(!session.TryPresentSystemNotice(generation, throwingNotice with { CorrelationId = "notice_message_throw_replay", MessageId = "notice_message_throw_replay" },
            _ => { throwingNoticeSends++; return true; }, out _, out string throwingNoticeReplayReason)
            && throwingNoticeReplayReason == "system_notice_send_failed" && throwingNoticeSends == 1,
            "failed system notice replay must not attempt a second native send.");

        BridgeSession chineseNoticeSession = CreateSession(scope, () => "zh-CN");
        Authenticate(chineseNoticeSession, generation, scope);
        BridgeEnvelope<BridgeSystemNoticeRequest> chineseNotice = SystemNoticeEnvelope(
            scope, "notice_message_zh", "notice_zh", "system.stop.active_turn_cancelled", "已停止生成。", "zh-CN");
        Assert(chineseNoticeSession.TryPresentSystemNotice(generation, chineseNotice, _ => true, out _, out string chineseNoticeReason)
            && chineseNoticeReason == "accepted",
            "the released zh-CN locale must accept the approved Chinese STOP copy.");

        const long reauthenticatedGeneration = generation + 1;
        Authenticate(session, reauthenticatedGeneration, scope);
        Assert(session.TryPresentCompanionText(reauthenticatedGeneration, valid with { CorrelationId = "message_10", MessageId = "message_10" }, _ => { sends++; return true; }, out _, out string acceptedReauthReplayReason)
            && acceptedReauthReplayReason == "companion_presentation_replay" && sends == 1, "accepted presentation replay after reauthentication must preserve the receipt without a second native send.");
        Assert(!session.TryPresentCompanionText(reauthenticatedGeneration, throwing with { CorrelationId = "message_11", MessageId = "message_11" }, _ => { throwingSends++; return true; }, out _, out string throwReauthReplayReason)
            && throwReauthReplayReason == "companion_presentation_send_failed" && throwingSends == 1, "throwing sender replay after reauthentication must preserve failure without a second native send.");
        Assert(!session.TryPresentCompanionText(reauthenticatedGeneration, unavailable with { CorrelationId = "message_12", MessageId = "message_12" }, _ => { unavailableSends++; return true; }, out _, out string unavailableReauthReplayReason)
            && unavailableReauthReplayReason == "companion_presentation_target_unavailable" && unavailableSends == 1, "unavailable target replay after reauthentication must preserve failure without a second native send.");

        FarmhandCapabilityPublication persistentPublication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal));
        BridgeSession persistent = new(
            new ExecutionManager(new SilentMonitor(), () => persistentPublication),
            scope,
            "b".PadRight(32, 'b'),
            () => persistentPublication,
            () => "en-US");
        Authenticate(persistent, 1, scope, "b".PadRight(32, 'b'));
        BridgeEnvelope<BridgeCompanionPresentationRequest> persistentRequest = PresentationEnvelope(scope, "persistent_message_01", "persistent_expression_01", "persistent_source_01", "persistent", "en-US", 0, 0);
        Assert(persistent.TryPresentCompanionText(1, persistentRequest, _ => true, out _, out string persistentReason)
            && persistentReason == "accepted", "a ready authenticated bridge must remain authorized without a fixed wall-clock lease.");
        Assert(persistent.TryPresentCompanionText(1, persistentRequest with { Payload = persistentRequest.Payload with { ExpressionId = "persistent_expression_02" } }, _ => true, out _, out string subsequentReason)
            && subsequentReason == "accepted", "a later valid bridge operation must remain authorized while its authenticated generation and scope stay live.");
    }

    private static BridgeSession CreateSession(BridgeScope scope, Func<string> locale)
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal));
        return new(
            new ExecutionManager(new SilentMonitor(), () => publication),
            scope,
            "a".PadRight(32, 'a'),
            () => publication,
            locale);
    }

    private static void Authenticate(BridgeSession session, long generation, BridgeScope scope, string token = "")
    {
        string helloId = $"hello_{generation}";
        BridgeEnvelope<BridgeHello> hello = Hello(scope, helloId, token.Length == 0 ? "a".PadRight(32, 'a') : token);
        Assert(session.TryAuthenticate(generation, hello, out _, out _), "test session must authenticate.");
    }

    private static BridgeEnvelope<BridgeHello> Hello(BridgeScope scope, string helloId, string token) =>
        new(BridgeProtocol.Version, helloId, helloId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));

    private static BridgeEnvelope<BridgeCompanionPresentationRequest> PresentationEnvelope(BridgeScope scope, string messageId, string expressionId, string sourceEventId, string text, string locale, long revision, long epoch) =>
        new(BridgeProtocol.Version, messageId, messageId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "companion_presentation_request",
            new BridgeCompanionPresentationRequest(expressionId, sourceEventId, text, locale, revision, epoch));

    private static BridgeEnvelope<BridgeSystemNoticeRequest> SystemNoticeEnvelope(
        BridgeScope scope, string messageId, string noticeId, string key, string text, string locale) =>
        new(BridgeProtocol.Version, messageId, messageId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "system_notice_request",
            new BridgeSystemNoticeRequest(noticeId, key, text, locale));

    private static BridgeEnvelope<BridgePlayerControlReceipt> PlayerControlReceiptEnvelope(BridgeScope scope, string messageId, string controlId, string sourceEventId) =>
        new(BridgeProtocol.Version, messageId, controlId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "player_control_receipt",
            new BridgePlayerControlReceipt(controlId, sourceEventId, "accepted"));

    private sealed class SilentMonitor : IMonitor
    {
        public bool IsVerbose => false;
        public void Log(string message, LogLevel level = LogLevel.Trace) { }
        public void LogOnce(string message, LogLevel level = LogLevel.Trace) { }
        public void VerboseLog(string message) { }
        public void VerboseLog(ref StardewModdingAPI.Framework.Logging.VerboseLogStringHandler message) { }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
