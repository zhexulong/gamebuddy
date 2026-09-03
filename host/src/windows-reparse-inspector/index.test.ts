import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNoWindowsReparse,
  createPublishedWindowsReparseInspector,
  inspectWindowsPathIdentity,
  inspectWindowsPathIdentityChain,
  inspectWindowsPathSecurity,
  inspectWindowsReparse,
  type WindowsPathObjectIdentity,
  type WindowsPathSecurity,
} from "./index.js";
import { createTestWindowsReparseInspector } from "./index.test-support.js";

const fileIdentity = Object.freeze({
  objectKind: "regular_file" as const,
  isReparsePoint: false,
  volumeIdentity: "0123456789abcdef",
  fileId: "0123456789abcdef0123456789abcdef",
});
const directoryIdentity = Object.freeze({
  objectKind: "directory" as const,
  isReparsePoint: false,
  volumeIdentity: "0123456789abcdef",
  fileId: "fedcba9876543210fedcba9876543210",
});
const ownedDirectorySecurity = Object.freeze({ ...directoryIdentity, currentUserOwner: true });

type Outcome = "regular" | "reparse" | "malformed" | "unavailable" | "timeout" | "nonzero" | "stderr" | "overflow";

for (const outcome of ["regular", "reparse", "malformed", "unavailable", "timeout", "nonzero", "stderr", "overflow"] as const) {
  test(`legacy inspectWindowsReparse preserves ${outcome} child behavior`, async () => {
    const observed: unknown[] = [];
    const capability = createTestWindowsReparseInspector(() => legacyChild(outcome, observed));
    const inspected = inspectWindowsReparse(capability, resolve("absolute", "test-path"));
    if (outcome === "regular" || outcome === "reparse") {
      assert.equal(await inspected, outcome);
      assert.deepEqual(observed, [{ schemaVersion: 1, operation: "inspect", path: resolve("absolute", "test-path") }]);
    } else {
      await assert.rejects(inspected, /windows_reparse_inspection_unavailable/);
    }
  });
}

test("terminal failure waits for delayed close and kills at most once", async () => {
  let killCount = 0;
  const child = syntheticChildBase(() => {
    killCount += 1;
    return true;
  });
  const capability = createTestWindowsReparseInspector(() => child as unknown as ChildProcess);
  const inspected = inspectWindowsReparse(capability, resolve("absolute", "test-path"));
  child.emit("error", new Error("post-spawn failure"));
  child.stdin.emit("error", new Error("secondary stdin failure"));
  child.stdout.write(Buffer.alloc(64 * 1024 + 1));

  assert.equal(killCount, 1);
  assert.equal(await remainsPending(inspected), true);
  child.emit("close", null, "SIGTERM");
  await assert.rejects(inspected, /windows_reparse_inspection_unavailable/);
  assert.equal(killCount, 1);
});

test("kill false waits for close and reports the specific cleanup failure", async () => {
  let killCount = 0;
  const child = syntheticChildBase(() => {
    killCount += 1;
    return false;
  });
  const capability = createTestWindowsReparseInspector(() => child as unknown as ChildProcess);
  const inspected = inspectWindowsReparse(capability, resolve("absolute", "test-path"));
  child.stdin.emit("error", new Error("stdin failed"));

  assert.equal(await remainsPending(inspected), true);
  child.emit("close", 1, null);
  await assert.rejects(inspected, /windows_reparse_inspection_cleanup_failed/);
  assert.equal(killCount, 1);
});

test("a synchronous close emitted by kill settles after the kill result is known", async () => {
  for (const killResult of [true, false]) {
    let killCount = 0;
    let child: ReturnType<typeof syntheticChildBase>;
    child = syntheticChildBase(() => {
      killCount += 1;
      child.emit("close", null, "SIGTERM");
      return killResult;
    });
    const capability = createTestWindowsReparseInspector(() => child as unknown as ChildProcess);
    const inspected = inspectWindowsReparse(capability, resolve("absolute", "test-path"));
    child.emit("error", new Error("post-spawn failure"));

    await assert.rejects(inspected, killResult
      ? /windows_reparse_inspection_unavailable/
      : /windows_reparse_inspection_cleanup_failed/);
    assert.equal(killCount, 1);
  }
});

test("a child that never closes fails at the bounded cleanup deadline and removes listeners", async () => {
  let killCount = 0;
  const child = syntheticChildBase(() => {
    killCount += 1;
    return true;
  });
  const capability = createTestWindowsReparseInspector(() => child as unknown as ChildProcess);
  const inspected = inspectWindowsReparse(capability, resolve("absolute", "test-path"));
  child.emit("error", new Error("post-spawn failure"));

  assert.equal(await remainsPending(inspected), true);
  await assert.rejects(inspected, /windows_reparse_inspection_cleanup_failed/);
  assert.equal(killCount, 1);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stdout.listenerCount("error"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("error"), 0);
});

test("output overflow stops collection, invokes one kill, and drains until close", async () => {
  let killCount = 0;
  const child = syntheticChildBase(() => {
    killCount += 1;
    return true;
  });
  const capability = createTestWindowsReparseInspector(() => child as unknown as ChildProcess);
  const inspected = inspectWindowsReparse(capability, resolve("absolute", "test-path"));
  child.stdout.write(Buffer.alloc(64 * 1024 + 1));
  child.stderr.write("ignored after terminal failure");

  assert.equal(killCount, 1);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(await remainsPending(inspected), true);
  child.emit("close", null, "SIGTERM");
  await assert.rejects(inspected, /windows_reparse_inspection_unavailable/);
  assert.equal(killCount, 1);
});

test("stdin error and post-spawn child error each drain until close", async () => {
  for (const source of ["stdin", "child"] as const) {
    let killCount = 0;
    const child = syntheticChildBase(() => {
      killCount += 1;
      return true;
    });
    const capability = createTestWindowsReparseInspector(() => child as unknown as ChildProcess);
    const inspected = inspectWindowsReparse(capability, resolve("absolute", "test-path"));
    if (source === "stdin") child.stdin.emit("error", new Error("stdin failed"));
    else child.emit("error", new Error("child failed"));

    assert.equal(await remainsPending(inspected), true);
    assert.equal(killCount, 1);
    child.emit("close", null, "SIGTERM");
    await assert.rejects(inspected, /windows_reparse_inspection_unavailable/);
  }
});

for (const source of ["stdout", "stderr"] as const) {
  test(`${source} error is handled, kills once, and waits for delayed close`, async () => {
    let killCount = 0;
    const child = syntheticChildBase(() => {
      killCount += 1;
      return true;
    });
    const capability = createTestWindowsReparseInspector(() => child as unknown as ChildProcess);
    const inspected = inspectWindowsReparse(capability, resolve("absolute", "test-path"));

    assert.doesNotThrow(() => child[source].emit("error", new Error(`${source} failed`)));
    assert.equal(killCount, 1);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stdout.listenerCount("error"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("error"), 0);
    assert.equal(await remainsPending(inspected), true);

    child.emit("close", null, "SIGTERM");
    await assert.rejects(inspected, /windows_reparse_inspection_unavailable/);
    assert.equal(killCount, 1);
  });
}

test("assertNoWindowsReparse keeps the old exact reparse rejection", async () => {
  const capability = createTestWindowsReparseInspector(() => legacyChild("reparse", []));
  await assert.rejects(assertNoWindowsReparse(capability, resolve("absolute", "test-path")), /windows_reparse_inspection_unavailable/);
});

test("legacy operation rejects invalid capabilities and relative paths", async () => {
  await assert.rejects(inspectWindowsReparse(undefined, resolve("absolute", "test-path")), /windows_reparse_inspection_unavailable/);
  const capability = createTestWindowsReparseInspector(() => legacyChild("regular", []));
  await assert.rejects(inspectWindowsReparse(capability, "relative/test-path"), /windows_reparse_inspection_unavailable/);
});

test("strict identity parses exact frozen directory and file identities", { skip: process.platform !== "win32" }, async () => {
  for (const expected of [directoryIdentity, fileIdentity]) {
    const observed: unknown[] = [];
    const capability = createTestWindowsReparseInspector(() => strictChild(identityResponse(expected), observed));
    const actual = await inspectWindowsPathIdentity(capability, "C:\\trusted\\object");
    assert.deepEqual(actual, expected);
    assert.equal(Object.isFrozen(actual), true);
    assert.deepEqual(observed, [{ schemaVersion: 2, operation: "inspect_identity_v2", path: "C:\\trusted\\object" }]);
  }
});

test("strict identity reports a reparse object without following it", { skip: process.platform !== "win32" }, async () => {
  const capability = createTestWindowsReparseInspector(() => strictChild(identityResponse({ ...directoryIdentity, isReparsePoint: true }), []));
  const actual = await inspectWindowsPathIdentity(capability, "C:\\trusted\\junction");
  assert.equal(actual.objectKind, "directory");
  assert.equal(actual.isReparsePoint, true);
});

test("strict path security parses its exact owned-directory result and operation", { skip: process.platform !== "win32" }, async () => {
  const observed: unknown[] = [];
  const capability = createTestWindowsReparseInspector(() => strictChild(securityResponse(ownedDirectorySecurity), observed));
  const actual = await inspectWindowsPathSecurity(capability, "C:\\trusted\\object");
  assert.deepEqual(actual, ownedDirectorySecurity);
  assert.equal(Object.isFrozen(actual), true);
  assert.deepEqual(observed, [{ schemaVersion: 3, operation: "inspect_path_security_v3", path: "C:\\trusted\\object" }]);
});

test("strict path security preserves an explicit foreign-owner verdict for its Host consumer", { skip: process.platform !== "win32" }, async () => {
  const capability = createTestWindowsReparseInspector(() => strictChild(securityResponse({ ...ownedDirectorySecurity, currentUserOwner: false }), []));
  const actual = await inspectWindowsPathSecurity(capability, "C:\\trusted\\object");
  assert.equal(actual.currentUserOwner, false);
});

test("strict path security rejects malformed or mismatched owner responses", { skip: process.platform !== "win32" }, async () => {
  const invalid = [
    '{"schemaVersion":3,"operation":"inspect_path_security_v3","status":"ok","objectKind":"directory","isReparsePoint":false,"volumeIdentity":"0123456789abcdef","fileId":"fedcba9876543210fedcba9876543210"}\n',
    '{"schemaVersion":3,"operation":"inspect_path_security_v3","status":"ok","objectKind":"directory","isReparsePoint":false,"currentUserOwner":"true","volumeIdentity":"0123456789abcdef","fileId":"fedcba9876543210fedcba9876543210"}\n',
    '{"schemaVersion":2,"operation":"inspect_path_security_v3","status":"ok","objectKind":"directory","isReparsePoint":false,"currentUserOwner":true,"volumeIdentity":"0123456789abcdef","fileId":"fedcba9876543210fedcba9876543210"}\n',
    '{"schemaVersion":3,"operation":"inspect_identity_v2","status":"ok","objectKind":"directory","isReparsePoint":false,"currentUserOwner":true,"volumeIdentity":"0123456789abcdef","fileId":"fedcba9876543210fedcba9876543210"}\n',
    '{"schemaVersion":3,"operation":"inspect_path_security_v3","status":"indeterminate"}\n',
  ];
  for (const response of invalid) {
    const capability = createTestWindowsReparseInspector(() => strictChild(response, []));
    await assert.rejects(inspectWindowsPathSecurity(capability, "C:\\trusted\\object"), /windows_reparse_inspection_unavailable/);
  }
});

test("strict path-chain returns exact root-to-leaf frozen identities", { skip: process.platform !== "win32" }, async () => {
  const observed: unknown[] = [];
  const components = [directoryIdentity, { ...directoryIdentity, fileId: "11111111111111111111111111111111" }, fileIdentity];
  const capability = createTestWindowsReparseInspector(() => strictChild(chainResponse(components), observed));
  const actual = await inspectWindowsPathIdentityChain(capability, "C:\\trusted\\file.txt");
  assert.deepEqual(actual, components);
  assert.equal(Object.isFrozen(actual), true);
  assert.ok(actual.every(Object.isFrozen));
  assert.deepEqual(observed, [{ schemaVersion: 2, operation: "inspect_path_chain_v2", path: "C:\\trusted\\file.txt" }]);
});

test("strict path-chain exposes a reparse ancestor verdict", { skip: process.platform !== "win32" }, async () => {
  const components = [directoryIdentity, { ...directoryIdentity, isReparsePoint: true }, fileIdentity];
  const capability = createTestWindowsReparseInspector(() => strictChild(chainResponse(components), []));
  const actual = await inspectWindowsPathIdentityChain(capability, "C:\\trusted\\file.txt");
  assert.equal(actual[1]?.isReparsePoint, true);
});

test("strict identity fails closed on missing and unsupported helper verdicts", { skip: process.platform !== "win32" }, async () => {
  for (const status of ["missing", "unsupported", "indeterminate"]) {
    const response = `{"schemaVersion":2,"operation":"inspect_identity_v2","status":"${status}"}\n`;
    const capability = createTestWindowsReparseInspector(() => strictChild(response, []));
    await assert.rejects(inspectWindowsPathIdentity(capability, "C:\\trusted\\missing"), /windows_reparse_inspection_unavailable/);
  }
});

test("strict identity rejects malformed response and every extra or missing key", { skip: process.platform !== "win32" }, async () => {
  const invalid = [
    '{"schemaVersion":2,"operation":"inspect_identity_v2","status":"ok","objectKind":"regular_file","isReparsePoint":false,"volumeIdentity":"0123456789abcdef","fileId":"0123456789abcdef0123456789abcdef","extra":true}\n',
    '{"schemaVersion":2,"operation":"inspect_identity_v2","status":"ok","objectKind":"regular_file","isReparsePoint":false,"volumeIdentity":"0123456789abcdef"}\n',
    '{"schemaVersion":1,"operation":"inspect_identity_v2","status":"ok","objectKind":"regular_file","isReparsePoint":false,"volumeIdentity":"0123456789abcdef","fileId":"0123456789abcdef0123456789abcdef"}\n',
    '{"schemaVersion":2,"operation":"inspect_identity_v2","status":"ok","objectKind":"other","isReparsePoint":false,"volumeIdentity":"0123456789abcdef","fileId":"0123456789abcdef0123456789abcdef"}\n',
    '{"schemaVersion":2,"operation":"inspect_identity_v2","status":"ok","objectKind":"regular_file","isReparsePoint":false,"volumeIdentity":"XYZ","fileId":"0123456789abcdef0123456789abcdef"}\n',
    '{ "schemaVersion":2,"operation":"inspect_identity_v2","status":"ok","objectKind":"regular_file","isReparsePoint":false,"volumeIdentity":"0123456789abcdef","fileId":"0123456789abcdef0123456789abcdef"}\n',
    '{"schemaVersion":2,"schemaVersion":2,"operation":"inspect_identity_v2","status":"ok","objectKind":"regular_file","isReparsePoint":false,"volumeIdentity":"0123456789abcdef","fileId":"0123456789abcdef0123456789abcdef"}\n',
    `\ufeff${identityResponse(fileIdentity)}`,
    identityResponse(fileIdentity).trim(),
    `${identityResponse(fileIdentity)}\n`,
    "not-json\n",
  ];
  for (const response of invalid) {
    const capability = createTestWindowsReparseInspector(() => strictChild(response, []));
    await assert.rejects(inspectWindowsPathIdentity(capability, "C:\\trusted\\file.txt"), /windows_reparse_inspection_unavailable/);
  }
});

test("strict chain rejects count mismatches, non-directory ancestors, and extra keys", { skip: process.platform !== "win32" }, async () => {
  const invalid = [
    chainResponse([directoryIdentity, fileIdentity]),
    chainResponse([fileIdentity, directoryIdentity, fileIdentity]),
    chainResponse([directoryIdentity, { ...directoryIdentity, volumeIdentity: "1111111111111111" }, fileIdentity]),
    '{"schemaVersion":2,"operation":"inspect_path_chain_v2","status":"ok","components":[],"extra":true}\n',
  ];
  for (const response of invalid) {
    const capability = createTestWindowsReparseInspector(() => strictChild(response, []));
    await assert.rejects(inspectWindowsPathIdentityChain(capability, "C:\\trusted\\file.txt"), /windows_reparse_inspection_unavailable/);
  }
});

test("strict path security rejects invalid Windows paths before helper invocation", { skip: process.platform !== "win32" }, async () => {
  let invoked = false;
  const capability = createTestWindowsReparseInspector(() => {
    invoked = true;
    return strictChild(securityResponse(ownedDirectorySecurity), []);
  });
  for (const path of ["\\\\server\\share\\directory", "\\\\?\\C:\\directory", "relative\\directory", "C:\\trusted\\..\\directory", "C:\\trusted\\\\directory"]) {
    await assert.rejects(inspectWindowsPathSecurity(capability, path), /windows_reparse_inspection_unavailable/);
  }
  assert.equal(invoked, false);
});

test("strict identity rejects UNC, device, relative, dot-segment, and empty-component paths before helper invocation", { skip: process.platform !== "win32" }, async () => {
  let invoked = false;
  const capability = createTestWindowsReparseInspector(() => {
    invoked = true;
    return strictChild(identityResponse(fileIdentity), []);
  });
  for (const path of ["\\\\server\\share\\file", "\\\\?\\C:\\file", "\\\\.\\C:\\file", "relative\\file", "C:\\trusted\\..\\file", "C:\\trusted\\\\file"]) {
    await assert.rejects(inspectWindowsPathIdentity(capability, path), /windows_reparse_inspection_unavailable/);
  }
  assert.equal(invoked, false);
});

test("strict identity fails closed on unavailable, timeout, stderr, nonzero, and overflow helpers", { skip: process.platform !== "win32" }, async () => {
  for (const outcome of ["unavailable", "timeout", "stderr", "nonzero", "overflow"] as const) {
    const capability = createTestWindowsReparseInspector(() => legacyChild(outcome, []));
    await assert.rejects(inspectWindowsPathIdentity(capability, "C:\\trusted\\file.txt"), /windows_reparse_inspection_unavailable/);
  }
});

test("strict identity is explicitly unavailable on non-Windows", { skip: process.platform === "win32" }, async () => {
  let invoked = false;
  const capability = createTestWindowsReparseInspector(() => {
    invoked = true;
    return strictChild(identityResponse(fileIdentity), []);
  });
  await assert.rejects(inspectWindowsPathIdentity(capability, "/absolute/path"), /windows_reparse_inspection_unavailable/);
  await assert.rejects(inspectWindowsPathSecurity(capability, "/absolute/path"), /windows_reparse_inspection_unavailable/);
  await assert.rejects(inspectWindowsPathIdentityChain(capability, "/absolute/path"), /windows_reparse_inspection_unavailable/);
  assert.equal(invoked, false);
});

test("published constructor remains fixed and rejects unavailable roots without fallback", async () => {
  await assert.rejects(createPublishedWindowsReparseInspector("relative/path"), /windows_reparse_inspection_unavailable/);
  if (process.platform === "win32") {
    await assert.rejects(createPublishedWindowsReparseInspector(resolve("missing-artifact-root")), /windows_reparse_inspection_unavailable/);
  } else {
    const capability = await createPublishedWindowsReparseInspector(resolve("missing-artifact-root"));
    await assert.rejects(inspectWindowsReparse(capability, resolve("any-path")), /windows_reparse_inspection_unavailable/);
  }
});

test("native security operation remains a strict handle-derived current-user owner check", async () => {
  const source = await readFile(
    resolve(fileURLToPath(new URL("../..", import.meta.url)), "native", "windows-reparse-inspector", "Program.cs"),
    "utf8",
  );
  assert.match(source, /StrictSecuritySchemaVersion = 3/);
  assert.match(source, /InspectPathSecurityOperation = "inspect_path_security_v3"/);
  assert.match(source, /FileReadAttributes \| ReadControl/);
  assert.match(source, /GetSecurityInfo\(fileHandle, SeFileObject, OwnerSecurityInformation/);
  assert.match(source, /OpenProcessToken\(NativeMethods\.GetCurrentProcess\(\), TokenQuery/);
  assert.match(source, /EqualSid\(ownerSid, tokenUser\.UserSid\)/);
  assert.match(source, /LocalFree\(securityDescriptor\)/);
  assert.doesNotMatch(source, /PowerShell|powershell/);
});

test("public policy entry does not expose test-only capability minting or filesystem fallback", async () => {
  const source = await readFile(
    resolve(fileURLToPath(new URL("../..", import.meta.url)), "src", "windows-reparse-inspector", "index.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /__testOnly|test-support|\blstat\(absolutePath|customInspect/);
});

function identityResponse(identity: WindowsPathObjectIdentity): string {
  return `${JSON.stringify({ schemaVersion: 2, operation: "inspect_identity_v2", status: "ok", ...identity })}\n`;
}

function securityResponse(security: WindowsPathSecurity): string {
  return `${JSON.stringify({ schemaVersion: 3, operation: "inspect_path_security_v3", status: "ok", ...security })}\n`;
}

function chainResponse(components: readonly WindowsPathObjectIdentity[]): string {
  return `${JSON.stringify({ schemaVersion: 2, operation: "inspect_path_chain_v2", status: "ok", components })}\n`;
}

function strictChild(response: string, observed: unknown[]): ChildProcess {
  const child = syntheticChildBase();
  child.stdin.on("data", (input: Buffer) => {
    observed.push(JSON.parse(input.toString("utf8")));
    child.stdout.end(response);
    child.stderr.end();
    queueMicrotask(() => child.emit("close", 0, null));
  });
  return child as unknown as ChildProcess;
}

function legacyChild(outcome: Outcome, observed: unknown[]): ChildProcess {
  if (outcome === "unavailable") throw new Error("spawn unavailable");
  const child = syntheticChildBase(() => {
    if (outcome === "timeout") queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  child.stdin.on("data", (input: Buffer) => {
    observed.push(JSON.parse(input.toString("utf8")));
    if (outcome === "timeout") return;
    if (outcome === "overflow") child.stdout.end(Buffer.alloc(64 * 1024 + 1));
    else if (outcome === "malformed") child.stdout.end('{"schemaVersion":1,"result":"other"}\n');
    else child.stdout.end(`{"schemaVersion":1,"result":"${outcome}"}\n`);
    if (outcome === "stderr") child.stderr.end("unexpected");
    else child.stderr.end();
    queueMicrotask(() => child.emit("close", outcome === "nonzero" ? 1 : 0, null));
  });
  return child as unknown as ChildProcess;
}

async function remainsPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  return await Promise.race([
    promise.then(
      () => false,
      () => false,
    ),
    new Promise<typeof marker>((resolvePending) => setTimeout(() => resolvePending(marker), 25)),
  ]) === marker;
}

function syntheticChildBase(onKill: () => boolean = () => true): EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(): boolean;
} {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: onKill,
  });
}
