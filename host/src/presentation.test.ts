import assert from "node:assert/strict";
import test from "node:test";

import {
  createCompanionPresentationTools,
  type CompanionTextExpression,
  type HostPresentationAdmissionProvider,
  type PresentationProfile,
} from "./presentation.js";
import {
  type VoiceAudioEpochAdmission,
  type VoiceExpression,
  type VoiceSpeechPort,
} from "./voice.js";

function profile(speech: PresentationProfile["speech"], text = false): PresentationProfile {
  return { locale: "zh-CN", text, speech };
}

function epochAdmission(sourceEventId = "source_event_01"): { admissionProvider: HostPresentationAdmissionProvider; advance(): void } {
  let current = 0;
  const bindings = new WeakSet<object>();
  return {
    admissionProvider: {
      capture() {
        const hostBinding = Object.freeze({ epoch: current });
        bindings.add(hostBinding);
        return Object.freeze({
          sourceEventId,
          admission: Object.freeze({
            hostBinding,
            assertHostCurrent(binding: object) {
              if (!bindings.has(binding) || (binding as { epoch?: unknown }).epoch !== current)
                throw new Error("stale_host_admission");
            },
          }),
        });
      },
    },
    advance() {
      current += 1;
    },
  };
}

function audioAdmission(): { admission: VoiceAudioEpochAdmission; advance(): void } {
  let current = 0;
  return {
    admission: {
      capture() {
        return Object.freeze({ epoch: current });
      },
      assertCurrent(binding) {
        if ((binding as { epoch?: unknown }).epoch !== current) throw new Error("stale_audio_epoch");
      },
      epoch(binding) {
        return (binding as { epoch: number }).epoch;
      },
    },
    advance() {
      current += 1;
    },
  };
}

test("presentation tools are materialized only for configured, admitted surfaces", () => {
  const host = epochAdmission();
  const audio = audioAdmission();
  const tools = createCompanionPresentationTools({
    profile: profile({ voiceProfile: "companion.default" }, true),
    sessionId: "session_01",
    admissionProvider: host.admissionProvider,
    textPort: { present() {} },
    speechPort: { enqueue() {} },
    voiceAudioAdmission: audio.admission,
  });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["companion_speak", "companion_text"]);

  const noSurface = createCompanionPresentationTools({
    profile: profile({ voiceProfile: "companion.default" }, true),
    sessionId: "session_02",
    admissionProvider: host.admissionProvider,
  });
  assert.deepEqual(noSurface, []);
});

test("unbound presentation admission omits the tool before a port can receive an expression", () => {
  let portCalls = 0;
  const tools = createCompanionPresentationTools({
    profile: profile(null, true),
    sessionId: "session_unbound",
    textPort: { present() { portCalls += 1; } },
  });
  assert.deepEqual(tools, []);
  assert.equal(portCalls, 0);
});

test("presentation binds source event rather than tool call and rejects only actual mechanism payloads", async () => {
  const host = epochAdmission();
  const expressions: CompanionTextExpression[] = [];
  const [tool] = createCompanionPresentationTools({
    profile: profile(null, true),
    sessionId: "session_01",
    admissionProvider: host.admissionProvider,
    textPort: {
      present(expression, admission) {
        admission.assertHostCurrent(admission.hostBinding);
        expressions.push(expression);
      },
    },
  });
  await tool!.execute("tool_call_01", { text: "JSON provider capability internal 都是普通技术词。" }, undefined, undefined, {} as never);
  assert.equal(expressions[0]?.sourceEventId, "source_event_01");
  await assert.rejects(
    () => tool!.execute("bad", { text: 'tool_request: {"name":"x"}' }, undefined, undefined, {} as never),
    /invalid_player_expression/,
  );
  await assert.rejects(
    () => tool!.execute("bad", { text: "I will call a tool now." }, undefined, undefined, {} as never),
    /invalid_player_expression/,
  );
});

test("deferred text commit is rejected after host interruption advances", async () => {
  const host = epochAdmission();
  let deferred: (() => void) | undefined;
  const [tool] = createCompanionPresentationTools({
    profile: profile(null, true),
    sessionId: "session_01",
    admissionProvider: host.admissionProvider,
    textPort: {
      present(_expression, admission) {
        deferred = () => admission.assertHostCurrent(admission.hostBinding);
      },
    },
  });
  await tool!.execute("tool_call_01", { text: "我先在这里等。" }, undefined, undefined, {} as never);
  host.advance();
  assert.throws(() => deferred?.(), /stale_host_admission/);
});

test("speech requires distinct current Host and audio epoch assertions at enqueue", async () => {
  const host = epochAdmission();
  const audio = audioAdmission();
  const expressions: VoiceExpression[] = [];
  const speechPort: VoiceSpeechPort = {
    enqueue(expression, admission) {
      admission.assertHostCurrent(admission.hostBinding);
      admission.assertAudioCurrent(admission.audioBinding);
      expressions.push(expression);
    },
  };
  const [tool] = createCompanionPresentationTools({
    profile: profile({ voiceProfile: "plain" }),
    sessionId: "session_01",
    admissionProvider: host.admissionProvider,
    speechPort,
    voiceAudioAdmission: audio.admission,
  });
  await tool!.execute("tool_call_01", { line: "只说这句话。" }, undefined, undefined, {} as never);
  assert.deepEqual({ sourceEventId: expressions[0]?.sourceEventId, epoch: expressions[0]?.epoch }, { sourceEventId: "source_event_01", epoch: 0 });

  let deferred: (() => void) | undefined;
  const deferredPort: VoiceSpeechPort = {
    enqueue(_expression, admission) {
      deferred = () => {
        admission.assertHostCurrent(admission.hostBinding);
        admission.assertAudioCurrent(admission.audioBinding);
      };
    },
  };
  const [deferredTool] = createCompanionPresentationTools({
    profile: profile({ voiceProfile: "plain" }),
    sessionId: "session_02",
    admissionProvider: host.admissionProvider,
    speechPort: deferredPort,
    voiceAudioAdmission: audio.admission,
  });
  await deferredTool!.execute("tool_call_02", { line: "稍后播放。" }, undefined, undefined, {} as never);
  audio.advance();
  assert.throws(() => deferred?.(), /stale_audio_epoch/);
});
