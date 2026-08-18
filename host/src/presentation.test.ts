import assert from "node:assert/strict";
import test from "node:test";

import {
  createCompanionPresentationTools,
  type CompanionTextExpression,
  type HostPresentationAdmissionProvider,
  type PresentationProfile,
} from "./presentation.js";
import { type VoiceAudioEpochAdmission, type VoiceExpression, type VoiceSpeechPort } from "./voice.js";

function profile(speech: PresentationProfile["speech"], text = false): PresentationProfile {
  return { locale: "zh-CN", text, speech };
}

function epochAdmission(sourceEventId = "source_event_01"): {
  admissionProvider: HostPresentationAdmissionProvider;
  advance(): void;
} {
  let current = 0;
  const bindings = new WeakSet<object>();
  return {
    admissionProvider: {
      capture() {
        const hostBinding = Object.freeze({ epoch: current });
        bindings.add(hostBinding);
        return Object.freeze({
          surface: "game" as const,
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
    surface: "game",
    sessionId: "session_01",
    admissionProvider: host.admissionProvider,
    textPort: { present() {} },
    speechPort: { enqueue() {} },
    voiceAudioAdmission: audio.admission,
  });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["companion_speak", "companion_text"]);

  const noSurface = createCompanionPresentationTools({
    profile: profile({ voiceProfile: "companion.default" }, true),
    surface: "game",
    sessionId: "session_02",
    admissionProvider: host.admissionProvider,
  });
  assert.deepEqual(noSurface, []);
});

test("unbound presentation admission omits the tool before a port can receive an expression", () => {
  let portCalls = 0;
  const tools = createCompanionPresentationTools({
    profile: profile(null, true),
    surface: "game",
    sessionId: "session_unbound",
    textPort: {
      present() {
        portCalls += 1;
      },
    },
  });
  assert.deepEqual(tools, []);
  assert.equal(portCalls, 0);
});

test("presentation binds source event rather than tool call and rejects only actual mechanism payloads", async () => {
  const host = epochAdmission();
  const expressions: CompanionTextExpression[] = [];
  const [tool] = createCompanionPresentationTools({
    profile: profile(null, true),
    surface: "game",
    sessionId: "session_01",
    admissionProvider: host.admissionProvider,
    textPort: {
      present(expression, admission) {
        admission.assertHostCurrent(admission.hostBinding);
        expressions.push(expression);
      },
    },
  });
  await tool!.execute(
    "tool_call_01",
    { text: "JSON provider capability internal 都是普通技术词。" },
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(expressions[0]?.surface, "game");
  assert.equal(expressions[0]?.surface === "game" ? expressions[0].sourceEventId : undefined, "source_event_01");
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
    surface: "game",
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
    surface: "game",
    sessionId: "session_01",
    admissionProvider: host.admissionProvider,
    speechPort,
    voiceAudioAdmission: audio.admission,
  });
  await tool!.execute("tool_call_01", { line: "只说这句话。" }, undefined, undefined, {} as never);
  assert.deepEqual(
    { sourceEventId: expressions[0]?.sourceEventId, epoch: expressions[0]?.epoch },
    { sourceEventId: "source_event_01", epoch: 0 },
  );

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
    surface: "game",
    sessionId: "session_02",
    admissionProvider: host.admissionProvider,
    speechPort: deferredPort,
    voiceAudioAdmission: audio.admission,
  });
  await deferredTool!.execute("tool_call_02", { line: "稍后播放。" }, undefined, undefined, {} as never);
  audio.advance();
  assert.throws(() => deferred?.(), /stale_audio_epoch/);
});

test("Chat-shaped admission produces a companion_text expression without any sourceEventId", async () => {
  const host = epochAdmission();
  const expressions: CompanionTextExpression[] = [];
  const chatProvider: HostPresentationAdmissionProvider = {
    capture() {
      const hostBinding = host.admissionProvider.capture().admission.hostBinding;
      return Object.freeze({
        surface: "chat" as const,
        admission: {
          hostBinding,
          assertHostCurrent(binding: object) {
            host.admissionProvider.capture().admission.assertHostCurrent(binding);
          },
        },
      });
    },
  };
  const [tool] = createCompanionPresentationTools({
    profile: profile(null, true),
    surface: "chat",
    sessionId: "session_chat",
    admissionProvider: chatProvider,
    textPort: {
      present(expression, admission) {
        admission.assertHostCurrent(admission.hostBinding);
        expressions.push(expression);
      },
    },
  });
  await tool!.execute("tool_call_01", { text: "Chat line." }, undefined, undefined, {} as never);
  assert.equal("sourceEventId" in expressions[0]!, false);
  assert.equal(expressions[0]?.text, "Chat line.");
  await assert.rejects(
    () => tool!.execute("tool_call_02", { text: "Bad tool request: {x:1}" }, undefined, undefined, {} as never),
    /invalid_player_expression/,
  );
});

test("Game/default companion_text rejects a Chat-shaped admission before its port", async () => {
  const host = epochAdmission();
  let portCalls = 0;
  const chatProvider: HostPresentationAdmissionProvider = {
    capture() {
      return Object.freeze({
        surface: "chat" as const,
        admission: host.admissionProvider.capture().admission,
      });
    },
  };
  const [tool] = createCompanionPresentationTools({
    profile: profile(null, true),
    surface: "game",
    sessionId: "session_game_text",
    admissionProvider: chatProvider,
    textPort: {
      present() {
        portCalls += 1;
      },
    },
  });
  await assert.rejects(
    () => tool!.execute("tool_call_01", { text: "Nope." }, undefined, undefined, {} as never),
    /presentation_surface_mismatch/,
  );
  assert.equal(portCalls, 0);
});

test("speech rejects a Chat-shaped admission that omits its source event", async () => {
  const host = epochAdmission();
  const audio = audioAdmission();
  const speechPort: VoiceSpeechPort = {
    enqueue() {
      throw new Error("speech_port_must_not_run");
    },
  };
  const chatProvider: HostPresentationAdmissionProvider = {
    capture() {
      return Object.freeze({
        surface: "chat" as const,
        admission: host.admissionProvider.capture().admission,
      });
    },
  };
  const [tool] = createCompanionPresentationTools({
    profile: profile({ voiceProfile: "plain" }),
    surface: "game",
    sessionId: "session_chat_speech",
    admissionProvider: chatProvider,
    speechPort,
    voiceAudioAdmission: audio.admission,
  });
  await assert.rejects(
    () => tool!.execute("tool_call_01", { line: "Nope." }, undefined, undefined, {} as never),
    /presentation_surface_mismatch/,
  );
});
