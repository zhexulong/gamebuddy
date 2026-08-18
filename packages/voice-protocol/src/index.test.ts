import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_NDJSON_FRAME_BYTES,
  createBoundedUtf8NdjsonDecoder,
  encodeVoiceGatewayMessage,
  parseVoiceGatewayRequest,
  parseVoiceGatewayResponse,
} from "./index.js";

const decoder = () => createBoundedUtf8NdjsonDecoder({ maxRecordBytes: MAX_NDJSON_FRAME_BYTES, maxBufferedBytes: MAX_NDJSON_FRAME_BYTES });

test("bounded fatal UTF-8 NDJSON decoder accepts fragmented multibyte and coalesced records", () => {
  const framer = decoder();
  const frame = new TextEncoder().encode('{"type":"health","requestId":"health_01","text":"农场"}\n');
  const split = frame.indexOf(0xe5) + 1;
  assert.deepEqual(framer.push(frame.subarray(0, split)), []);
  assert.deepEqual(framer.push(frame.subarray(split)), ['{"type":"health","requestId":"health_01","text":"农场"}']);
  assert.deepEqual(framer.push(new TextEncoder().encode('{"a":1}\n{"b":2}\n')), ['{"a":1}', '{"b":2}']);
  framer.finish();
});

test("NDJSON decoder rejects malformed UTF-8, CRLF, empty, oversize and incomplete frames then resets", () => {
  for (const bytes of [new Uint8Array([0xc3, 0x28, 0x0a]), new TextEncoder().encode("\r\n"), new Uint8Array([0x0a]), new Uint8Array(MAX_NDJSON_FRAME_BYTES)]) {
    const framer = decoder();
    assert.throws(() => framer.push(bytes));
    assert.deepEqual(framer.push(new TextEncoder().encode("{}\n")), ["{}"]);
  }
  const trailing = decoder();
  trailing.push(new TextEncoder().encode("{}"));
  assert.throws(() => trailing.finish(), /incomplete_trailing_data/);
  assert.deepEqual(trailing.push(new TextEncoder().encode("{}\n")), ["{}"]);
});

test("outbound encoding accepts only valid request or response variants", () => {
  assert.equal(
    encodeVoiceGatewayMessage({ type: "accepted", requestId: "request_01", value: true }),
    '{"type":"accepted","requestId":"request_01","value":true}\n',
  );
  assert.throws(
    () => encodeVoiceGatewayMessage({ type: "accepted", requestId: "request_01", extra: true } as never),
    /invalid_voice_gateway_message/,
  );
});

test("strict wire validators reject unknown keys and validate every variant", () => {
  assert.notEqual(parseVoiceGatewayRequest('{"type":"events","requestId":"events_01","sessionId":"session_01"}'), null);
  assert.equal(parseVoiceGatewayRequest('{"type":"events","requestId":"events_01","sessionId":"session_01","extra":true}'), null);
  assert.notEqual(parseVoiceGatewayResponse('{"type":"accepted","requestId":"request_01","value":true}'), null);
  assert.equal(parseVoiceGatewayResponse('{"type":"accepted","requestId":"request_01","value":true,"reasonCode":"ignored"}'), null);
  assert.notEqual(parseVoiceGatewayResponse('{"type":"error","requestId":null,"reasonCode":"bad_request"}'), null);
  assert.notEqual(parseVoiceGatewayResponse('{"type":"events","requestId":"request_01","events":[{"type":"partial_transcript","sessionId":"session_01","inputId":"input_01","text":"ok"}],"next":1}'), null);
  assert.equal(parseVoiceGatewayResponse('{"type":"events","requestId":"request_01","events":[{"type":"partial_transcript","sessionId":"session_01","inputId":"input_01","text":"ok","extra":true}],"next":1}'), null);
});
