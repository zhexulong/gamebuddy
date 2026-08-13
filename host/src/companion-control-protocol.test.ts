import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_PROTOCOL_VERSION,
  ControlProtocolError,
  ControlRequestFramer,
  MAX_CONTROL_IDENTIFIER_BYTES,
  MAX_CONTROL_LINE_BYTES,
  MAX_CONTROL_TEXT_BYTES,
  decodeControlRequestLine,
  encodeControlRequest,
  validateControlRequest,
} from "./companion-control-protocol.js";

const encoder = new TextEncoder();
const validHello = { type: "hello", protocolVersion: CONTROL_PROTOCOL_VERSION, launchToken: "a".repeat(16) } as const;
const validInput = {
  type: "player_input",
  requestId: "request_01",
  runtimeInstanceId: "runtime_01",
  sourceEventId: "source_01",
  text: "Please stop explaining JSON and tell me about Game Actions.",
  locale: "en-US",
} as const;
const validStop = {
  type: "stop_all",
  requestId: "request_02",
  runtimeInstanceId: "runtime_01",
  stopId: "stop_01",
  sourceEventId: "source_02",
  playerText: "Stop, I will take it from here.",
  locale: "en-US",
} as const;

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof ControlProtocolError && error.code === code);
}

test("control codec round-trips exactly the three v1 request variants", () => {
  for (const request of [validHello, validInput, validStop, { ...validStop, playerText: undefined, locale: undefined }]) {
    const encoded = encodeControlRequest(request);
    assert.ok(encoded.endsWith("\n"));
    assert.deepEqual(decodeControlRequestLine(encoded.slice(0, -1)), validateControlRequest(request));
  }
});

test("ordinary player text always remains player_input, even when it asks to stop", () => {
  const request = decodeControlRequestLine(JSON.stringify({ ...validInput, text: "stop all actions please" }));
  assert.equal(request.type, "player_input");
  assert.equal(request.text, "stop all actions please");
  assert.equal(decodeControlRequestLine(JSON.stringify(validStop)).type, "stop_all");
});

test("control codec enforces exact own keys and all request pairings", () => {
  const cases: unknown[] = [
    { ...validHello, unexpected: true },
    { type: "hello", protocolVersion: 1 },
    { ...validInput, text: undefined },
    { ...validInput, locale: undefined },
    { ...validStop, playerText: "", locale: "en-US" },
    { ...validStop, stopId: "bad id" },
    { ...validInput, requestId: "" },
    { ...validInput, runtimeInstanceId: "a".repeat(MAX_CONTROL_IDENTIFIER_BYTES + 1) },
    { ...validInput, sourceEventId: "source.01" },
    { ...validInput, text: "x".repeat(MAX_CONTROL_TEXT_BYTES + 1) },
    { ...validInput, locale: "e" },
    { ...validInput, locale: "en_US" },
    { ...validHello, protocolVersion: 2 },
    { ...validHello, launchToken: "short" },
    [],
    null,
  ];
  for (const value of cases) expectCode(() => validateControlRequest(value), "invalid_control_request");
});

test("control codec rejects malformed JSON, duplicate keys, nested duplicates, and multiline records", () => {
  for (const line of ["", "{", `${JSON.stringify(validInput)}\n${JSON.stringify(validStop)}`]) {
    expectCode(() => decodeControlRequestLine(line), "invalid_control_json");
  }
  for (const line of ["[]", "null", '{"type":"unknown"}']) {
    expectCode(() => decodeControlRequestLine(line), "invalid_control_request");
  }
  expectCode(
    () => decodeControlRequestLine('{"type":"player_input","type":"stop_all","requestId":"x"}'),
    "duplicate_control_json_key",
  );
  expectCode(
    () => decodeControlRequestLine('{"type":"hello","protocolVersion":1,"launchToken":"aaaaaaaaaaaaaaaa","metadata":{"x":1,"x":2}}'),
    "duplicate_control_json_key",
  );
});

test("control codec applies UTF-8 byte bounds to records and player text", () => {
  expectCode(() => decodeControlRequestLine("x".repeat(MAX_CONTROL_LINE_BYTES + 1)), "control_line_too_large");
  const tooLargeText = { ...validInput, text: "界".repeat(Math.floor(MAX_CONTROL_TEXT_BYTES / 3) + 1) };
  expectCode(() => validateControlRequest(tooLargeText), "invalid_control_request");
  const nearLine = JSON.stringify({ ...validInput, text: "x".repeat(MAX_CONTROL_LINE_BYTES) });
  assert.ok(encoder.encode(nearLine).byteLength > MAX_CONTROL_LINE_BYTES);
  expectCode(() => decodeControlRequestLine(nearLine), "control_line_too_large");
});

test("framer buffers partial data, supports chunked UTF-8 and CRLF, and emits multiple records", () => {
  const framer = new ControlRequestFramer();
  const first = JSON.stringify({ ...validInput, text: "你好" });
  const bytes = encoder.encode(`${first}\r\n${JSON.stringify(validStop)}\n`);
  const splitInsideCharacter = bytes.indexOf(0xe5) + 1;
  assert.deepEqual(framer.push(bytes.subarray(0, splitInsideCharacter)), []);
  const requests = framer.push(bytes.subarray(splitInsideCharacter));
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.type, "player_input");
  assert.equal(requests[1]?.type, "stop_all");
  framer.finish();
});

test("framer rejects invalid UTF-8, oversized partial lines, and incomplete close frames", () => {
  expectCode(() => new ControlRequestFramer().push(Uint8Array.of(0xc3, 0x28, 0x0a)), "invalid_control_encoding");
  const oversized = new ControlRequestFramer();
  expectCode(() => oversized.push(encoder.encode("x".repeat(MAX_CONTROL_LINE_BYTES + 1))), "control_line_too_large");
  const incomplete = new ControlRequestFramer();
  assert.deepEqual(incomplete.push(encoder.encode(JSON.stringify(validHello))), []);
  expectCode(() => incomplete.finish(), "incomplete_control_frame");
});
