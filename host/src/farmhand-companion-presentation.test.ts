import assert from "node:assert/strict";
import test from "node:test";

import { createCompanionInterruption } from "./companion-interruption.js";
import {
  createFarmhandCompanionPresentationPort,
  createFarmhandPresentationEpochAdmission,
  createFarmhandSystemNoticePresenter,
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
    expectedRevision: 7,
    presentationEpoch: 0,
  });
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
