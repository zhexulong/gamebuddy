import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../../..");
const HOST_PROTOCOL = path.join(REPOSITORY_DIRECTORY, "host", "src", "protocol.ts");
const STRICT_JSON = path.join(REPOSITORY_DIRECTORY, "host", "src", "strict-bridge-json.ts");
const CONTRACT_PROJECT = path.join(
  REPOSITORY_DIRECTORY,
  "integrations",
  "stardew",
  "tests",
  "stardew-wire-parity-contract",
  "stardew-wire-parity-contract.csproj",
);
const CONTRACT_DLL = path.join(
  path.dirname(CONTRACT_PROJECT),
  "bin",
  "Debug",
  "net6.0",
  "GameBuddy.Stardew.WireParityContract.dll",
);
const SCOPE = Object.freeze({
  integrationId: "stardew",
  saveId: "save_1",
  worldId: "world_1",
  playerId: "player_1",
  companionId: "companion_1",
});
const PROCESS_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;

function fail(caseId) {
  throw new Error(`stardew_action_wire_parity_failed:${caseId}`);
}

async function main() {
  await runProcess("dotnet", ["build", CONTRACT_PROJECT, "--nologo"], "contract_build", 0, null);
  const {
    MAX_MESSAGE_BYTES,
    newEnvelope,
    serializeBounded,
    validateBridgeMessage,
  } = await import(pathToFileURL(HOST_PROTOCOL).href);
  const { parseStrictBridgeJson } = await import(pathToFileURL(STRICT_JSON).href);
  const now = Date.now();

  const request = newEnvelope(
    "execution_request",
    SCOPE,
    {
      requestId: "request_wire_1",
      idempotencyKey: "idempotency_wire_1",
      action: "equip_tool",
      args: { slot: 2 },
      expectedRevision: 7,
      deadlineMs: now + 30_000,
    },
    "correlation_wire_1",
    now,
  );
  const requestBytes = Buffer.from(serializeBounded(request), "utf8");
  assert(requestBytes.byteLength <= MAX_MESSAGE_BYTES, "request_bounded");
  const decodedRequest = await runContract("--decode-execution-request", requestBytes, "decode_execution_request");
  assert(decodedRequest.stdout.toString("utf8").trim() === "accepted|execution_request|request_wire_1|idempotency_wire_1|equip_tool|2|7|" + String(request.payload.deadlineMs), "request_typed_fields");

  const query = newEnvelope(
    "execution_receipt_query",
    SCOPE,
    { requestId: "request_wire_1", idempotencyKey: "idempotency_wire_1" },
    "correlation_query_1",
    now,
  );
  const decodedQuery = await runContract(
    "--decode-execution-receipt-query",
    Buffer.from(serializeBounded(query), "utf8"),
    "decode_execution_receipt_query",
  );
  assert(decodedQuery.stdout.toString("utf8").trim() === "accepted|execution_receipt_query|request_wire_1|idempotency_wire_1", "query_typed_fields");

  const cancel = newEnvelope(
    "cancel_request",
    SCOPE,
    {
      requestId: "request_wire_1",
      executionId: "execution_wire_1",
      cancelId: "cancel_wire_1",
      cancelEpoch: 2,
      reasonCode: "player_requested_stop",
    },
    "correlation_cancel_1",
    now,
  );
  const decodedCancel = await runContract(
    "--decode-cancel-request",
    Buffer.from(serializeBounded(cancel), "utf8"),
    "decode_cancel_request",
  );
  assert(decodedCancel.stdout.toString("utf8").trim() === "accepted|cancel_request|request_wire_1|execution_wire_1|cancel_wire_1|2|player_requested_stop", "cancel_typed_fields");

  const error = newEnvelope(
    "error",
    SCOPE,
    { reasonCode: "execution_rejected" },
    "correlation_error_1",
    now,
  );
  const decodedError = await runContract(
    "--decode-error",
    Buffer.from(serializeBounded(error), "utf8"),
    "decode_error",
  );
  assert(decodedError.stdout.toString("utf8").trim() === "accepted|error|execution_rejected", "error_typed_fields");

  const receiptInput = {
    messageId: "message_wire_1",
    correlationId: "correlation_wire_1",
    timestampMs: now,
    scope: SCOPE,
    executionId: "execution_wire_1",
    requestId: "request_wire_1",
    actionId: "equip_tool",
    state: "succeeded",
    reasonCode: "tool_selected",
    revision: 8,
    evidence: { target: "工具_2" },
  };
  const encodedReceipt = await runContract(
    "--encode-execution-receipt",
    Buffer.from(JSON.stringify(receiptInput), "utf8"),
    "encode_execution_receipt",
  );
  const receipt = parseAndValidate(encodedReceipt.stdout, parseStrictBridgeJson, validateBridgeMessage, now, "receipt");
  assert(receipt.type === "execution_receipt", "receipt_type");
  assert(receipt.payload.executionId === receiptInput.executionId && receipt.payload.requestId === receiptInput.requestId, "receipt_typed_fields");
  assert(receipt.payload.actionId === receiptInput.actionId && receipt.payload.evidence.target === "工具_2", "receipt_unicode_evidence");

  const encodedQuery = await runContract(
    "--encode-execution-receipt-query",
    Buffer.from(JSON.stringify({
      messageId: "message_query_1",
      correlationId: "correlation_query_1",
      timestampMs: now,
      scope: SCOPE,
      requestId: "request_wire_1",
      idempotencyKey: "idempotency_wire_1",
    }), "utf8"),
    "encode_execution_receipt_query",
  );
  const queryMessage = parseAndValidate(encodedQuery.stdout, parseStrictBridgeJson, validateBridgeMessage, now, "query");
  assert(queryMessage.type === "execution_receipt_query" && queryMessage.payload.requestId === "request_wire_1", "query_encoded_fields");

  const encodedCancel = await runContract(
    "--encode-cancel-request",
    Buffer.from(JSON.stringify({
      messageId: "message_cancel_1",
      correlationId: "correlation_cancel_1",
      timestampMs: now,
      scope: SCOPE,
      requestId: "request_wire_1",
      executionId: "execution_wire_1",
      cancelId: "cancel_wire_1",
      cancelEpoch: 2,
      reasonCode: "player_requested_stop",
    }), "utf8"),
    "encode_cancel_request",
  );
  const cancelMessage = parseAndValidate(encodedCancel.stdout, parseStrictBridgeJson, validateBridgeMessage, now, "cancel");
  assert(cancelMessage.type === "cancel_request" && cancelMessage.payload.cancelId === "cancel_wire_1", "cancel_encoded_fields");

  const encodedError = await runContract(
    "--encode-error",
    Buffer.from(JSON.stringify({
      messageId: "message_error_1",
      correlationId: "correlation_error_1",
      timestampMs: now,
      scope: SCOPE,
      reasonCode: "execution_rejected",
    }), "utf8"),
    "encode_error",
  );
  const errorMessage = parseAndValidate(encodedError.stdout, parseStrictBridgeJson, validateBridgeMessage, now, "error");
  assert(errorMessage.type === "error" && errorMessage.payload.reasonCode === "execution_rejected", "error_encoded_fields");

  await expectRejected("malformed_json", Buffer.from("{", "utf8"), "invalid_json");
  await expectRejected("oversize", Buffer.alloc(MAX_MESSAGE_BYTES + 1), "message_too_large");
  await expectRejected("invalid_utf8", Buffer.from([0xff]), "invalid_utf8");
  await expectRejected(
    "invalid_version",
    Buffer.from(JSON.stringify({ ...request, protocolVersion: 2 }), "utf8"),
    "invalid_envelope",
  );
  await expectRejected(
    "invalid_type",
    Buffer.from(JSON.stringify({ ...request, type: "EXECUTION_REQUEST" }), "utf8"),
    "invalid_envelope",
  );
  await expectRejected(
    "invalid_casing",
    Buffer.from(JSON.stringify({
      ...request,
      payload: { RequestId: request.payload.requestId, idempotencyKey: request.payload.idempotencyKey, action: request.payload.action, args: request.payload.args, expectedRevision: request.payload.expectedRevision, deadlineMs: request.payload.deadlineMs },
    }), "utf8"),
    "invalid_envelope",
  );

  for (const caseId of [
    "decode_execution_request",
    "decode_execution_receipt_query",
    "decode_cancel_request",
    "decode_error",
    "encode_execution_receipt",
    "encode_execution_receipt_query",
    "encode_cancel_request",
    "encode_error",
    "malformed_json",
    "oversize",
    "invalid_utf8",
    "invalid_version",
    "invalid_type",
    "invalid_casing",
  ]) console.log(`${caseId}:passed`);
}

function parseAndValidate(output, parseStrictBridgeJson, validateBridgeMessage, now, caseId) {
  const text = output.toString("utf8");
  assert(text.length > 0 && !text.includes("\n"), `${caseId}_single_frame`);
  const parsed = parseStrictBridgeJson(text);
  assert(validateBridgeMessage(parsed, SCOPE, now) === null, `${caseId}_validated`);
  return parsed;
}

async function expectRejected(caseId, input, expectedReason) {
  const result = await runContract("--decode-execution-request", input, caseId, 1);
  assert(result.stdout.byteLength === 0, `${caseId}_stdout_empty`);
  assert(result.stderr.toString("utf8").trim() === expectedReason, `${caseId}_reason`);
}

function assert(condition, caseId) {
  if (!condition) fail(caseId);
}

function runContract(command, input, caseId, expectedCode = 0) {
  return runProcess("dotnet", [CONTRACT_DLL, command, "-"], caseId, expectedCode, input);
}

function runProcess(executable, args, caseId, expectedCode = 0, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: REPOSITORY_DIRECTORY,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    const append = (target) => (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", append(stdout));
    child.stderr.on("data", append(stderr));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, PROCESS_TIMEOUT_MS);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.once("error", () => finish(reject, new Error(`stardew_action_wire_parity_failed:${caseId}`)));
    child.once("close", (code, signal) => {
      const result = {
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (timedOut || outputBytes > MAX_PROCESS_OUTPUT_BYTES || code !== expectedCode || signal !== null) {
        finish(reject, new Error(`stardew_action_wire_parity_failed:${caseId}`));
        return;
      }
      finish(resolve, result);
    });
    if (input === null) child.stdin.end();
    else child.stdin.end(input);
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
