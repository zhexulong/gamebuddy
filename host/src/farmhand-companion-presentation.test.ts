import assert from "node:assert/strict";
import test from "node:test";

import { createCompanionInterruption } from "./companion-interruption.js";
import {
  createFarmhandCompanionPresentationPort,
  createFarmhandPresentationEpochAdmission,
  createFarmhandSystemNoticePresenter,
  stripMagicContextSelfTag,
} from "./farmhand-companion-presentation.js";
import { resolveStopSystemNotice } from "./system-notices.js";

function hostAdmission() {
  const binding = Object.freeze({});
  return Object.freeze({
    hostBinding: binding,
    assertHostCurrent(candidate: object) {
      if (candidate !== binding) throw new Error("stale_host_admission");
    },
  });
}

test("Farmhand presentation port rejects stale local epoch admission before bridge write", async () => {
  const interruption = createCompanionInterruption();
  const epoch = createFarmhandPresentationEpochAdmission(interruption);
  let writes = 0;
  const bridge = {
    state: { snapshot: { revision: 4 } },
    async presentCompanionText() {
      writes += 1;
    },
  };
  const port = createFarmhandCompanionPresentationPort(bridge as never, epoch);
  const admission = hostAdmission();
  interruption.stop("stop_01", "source_01", "player_stop_all");
  await assert.rejects(
    async () =>
      await port.present(
        {
          surface: "game",
          expressionId: "expression_01",
          sessionId: "session_01",
          sourceEventId: "source_01",
          text: "晚安。",
          locale: "zh-CN",
        },
        admission,
      ),
    /stale_interruption_admission/,
  );
  assert.equal(writes, 0);
});

test("Farmhand presentation port binds expression and Host epoch to typed bridge request", async () => {
  const interruption = createCompanionInterruption();
  const epoch = createFarmhandPresentationEpochAdmission(interruption);
  let received: Record<string, unknown> | undefined;
  const bridge = {
    state: { snapshot: { revision: 7 } },
    async presentCompanionText(request: Record<string, unknown>) {
      received = request;
    },
  };
  const port = createFarmhandCompanionPresentationPort(bridge as never, epoch);
  await port.present(
    {
      surface: "game",
      expressionId: "expression_02",
      sessionId: "session_02",
      sourceEventId: "source_02",
      text: "我在这里。",
      locale: "zh-CN",
    },
    hostAdmission(),
  );
  assert.deepEqual(received, {
    expressionId: "expression_02",
    sourceEventId: "source_02",
    text: "我在这里。",
    locale: "zh-CN",
    presentationEpoch: 0,
  });
});

test("a presentation sent late in a long turn succeeds although the world revision moved", async () => {
  const interruption = createCompanionInterruption();
  const epoch = createFarmhandPresentationEpochAdmission(interruption);
  // The live shape: the turn opens on revision 63, eight tool selections publish eight receipts
  // (only the settled ones reach the Host, and a saturated outbound queue drops even those), and the
  // closing line is committed at revision 68. The request may not claim the revision it read at turn
  // start; the Mod's own revision had moved past it, and that was the whole refusal.
  const bridge = {
    state: { snapshot: { revision: 63 } },
    requests: [] as Record<string, unknown>[],
    async presentCompanionText(request: Record<string, unknown>) {
      this.requests.push(request);
    },
  };
  const port = createFarmhandCompanionPresentationPort(bridge as never, epoch);
  const first = bridge.state.snapshot.revision;
  bridge.state = { snapshot: { revision: 68 } };
  await port.present(
    {
      surface: "game",
      expressionId: "expression_late",
      sessionId: "session_late",
      sourceEventId: "source_late",
      text: "干完了，天黑就回屋。",
      locale: "zh-CN",
    },
    hostAdmission(),
  );
  assert.equal(first, 63);
  assert.equal("expectedRevision" in (bridge.requests[0] ?? {}), false);
  assert.equal(bridge.requests[0]?.presentationEpoch, 0);
});

test("Farmhand system notice presenter binds fixed copy without relying on a cached bridge revision", async () => {
  let received: Record<string, unknown> | undefined;
  const presenter = createFarmhandSystemNoticePresenter({
    state: { snapshot: { revision: 12 } },
    async presentCompanionText() {},
    async presentSystemNotice(request: Record<string, unknown>) {
      received = request;
    },
  });
  await presenter(resolveStopSystemNotice("active_turn_cancelled", "zh-TW"), "stop_notice_01");
  assert.deepEqual(received, {
    noticeId: "stop_notice_01",
    key: "system.stop.active_turn_cancelled",
    text: "Generation stopped.",
    locale: "zh-TW",
  });
});

test("Farmhand presentation port strips Magic Context's §N§ self-tag before the player sees it", async () => {
  const interruption = createCompanionInterruption();
  const epoch = createFarmhandPresentationEpochAdmission(interruption);
  const writes: Record<string, unknown>[] = [];
  const presented: string[] = [];
  const bridge = {
    state: { snapshot: { revision: 3 } },
    async presentCompanionText(request: Record<string, unknown>) {
      writes.push(request);
    },
  };
  const port = createFarmhandCompanionPresentationPort(bridge as never, epoch, (text) => {
    presented.push(text);
  });
  // A real Game run presented this verbatim: the model mimicked the `§N§` self-tag
  // Magic Context puts on the prompt. It is prompt notation, never companion
  // speech, and the bubble is the last Host boundary before the player sees it.
  await port.present(
    {
      surface: "game",
      expressionId: "expression_selftag",
      sessionId: "session_selftag",
      sourceEventId: "source_selftag",
      text: "§43§ 已经进屋了，被窝那边我去占着。",
      locale: "zh-CN",
    },
    hostAdmission(),
  );
  assert.equal(writes[0]?.text, "已经进屋了，被窝那边我去占着。");
  // The companion-language hook sees the same clean text the bubble does.
  assert.deepEqual(presented, ["已经进屋了，被窝那边我去占着。"]);
  // Ordinary text with no marker is passed through byte for byte.
  await port.present(
    {
      surface: "game",
      expressionId: "expression_clean",
      sessionId: "session_clean",
      sourceEventId: "source_clean",
      text: "我在这里。",
      locale: "zh-CN",
    },
    hostAdmission(),
  );
  assert.equal(writes[1]?.text, "我在这里。");
});

test("stripMagicContextSelfTag removes every §N§ marker and leaves clean text untouched", () => {
  // A leading tag the model mimicked (the real form), a tag mid-text where the
  // delta lane joined two pieces, and several markers in one piece.
  assert.equal(stripMagicContextSelfTag("§43§ 已经进屋了。"), "已经进屋了。");
  assert.equal(stripMagicContextSelfTag("利索。§43§ 已经进屋了。"), "利索。已经进屋了。");
  assert.equal(stripMagicContextSelfTag("§1§ 早。§2§ 晚安。"), "早。晚安。");
  // No marker: returned byte for byte, so ordinary prose is never re-written here.
  assert.equal(stripMagicContextSelfTag("我在这里。"), "我在这里。");
});

test("Farmhand presentation port rejects a Chat-shaped expression that omits the source event", async () => {
  const interruption = createCompanionInterruption();
  const epoch = createFarmhandPresentationEpochAdmission(interruption);
  let writes = 0;
  const bridge = {
    state: { snapshot: { revision: 9 } },
    async presentCompanionText() {
      writes += 1;
    },
  };
  const port = createFarmhandCompanionPresentationPort(bridge as never, epoch);
  await assert.rejects(
    async () =>
      await port.present(
        {
          surface: "chat",
          expressionId: "expression_chat",
          sessionId: "session_chat",
          text: "Chat bubble only.",
          locale: "zh-CN",
        },
        hostAdmission(),
      ),
    /farmhand_presentation_source_event_required/,
  );
  assert.equal(writes, 0);
});
