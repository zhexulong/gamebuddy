import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  admitStardewInstallation,
  recheckAdmittedStardewInstallation,
  type AdmittedStardewInstallation,
} from "./stardew-installation-admission.js";
import { consumeAdmittedStardewInstallation } from "./stardew-installation-admission.core.js";
import { createTestWindowsReparseInspector } from "./windows-reparse-inspector/index.test-support.js";
import type { WindowsPathObjectIdentity } from "./windows-reparse-inspector/index.js";

const candidate = "C:\\Games\\Stardew Valley";
const executable = `${candidate}\\StardewModdingAPI.exe`;
const volumeIdentity = "0123456789abcdef";

function identity(
  objectKind: "directory" | "regular_file",
  fileId: string,
  overrides: Partial<WindowsPathObjectIdentity> = {},
): WindowsPathObjectIdentity {
  return Object.freeze({ objectKind, isReparsePoint: false, volumeIdentity, fileId, ...overrides });
}

function validChain(): readonly WindowsPathObjectIdentity[] {
  return Object.freeze([
    identity("directory", "00000000000000000000000000000001"),
    identity("directory", "00000000000000000000000000000002"),
    identity("directory", "00000000000000000000000000000003"),
    identity("regular_file", "00000000000000000000000000000004"),
  ]);
}

test("equal successive clean chains mint only a frozen, empty, nominal capability", async () => {
  const observed: unknown[] = [];
  const inspector = chainInspector([validChain(), validChain()], observed);

  const admitted = await admitStardewInstallation(inspector, candidate);

  assert.equal(Object.isFrozen(admitted), true);
  assert.deepEqual(Reflect.ownKeys(admitted), []);
  assert.equal(Object.getPrototypeOf(admitted), Object.prototype);
  assert.deepEqual(observed, [chainRequest(executable), chainRequest(executable)]);
  assert.notEqual(admitted, Object.freeze({}) as AdmittedStardewInstallation);
});

test("admission performs exactly two consecutive inspections with no search or fallback", async () => {
  const observed: unknown[] = [];
  const inspector = chainInspector([validChain(), validChain(), validChain()], observed);

  await admitStardewInstallation(inspector, candidate);

  assert.equal(observed.length, 2);
  assert.deepEqual(observed, [chainRequest(executable), chainRequest(executable)]);
});

test("strict candidates reject before invoking the inspector and expose one redacted error", async () => {
  const badCandidates = [
    "",
    "relative\\Stardew Valley",
    ".\\Stardew Valley",
    "C:\\Games\\..\\Stardew Valley",
    "C:\\Games\\.\\Stardew Valley",
    "C:\\Games\\",
    "C:\\Games\\Stardew Valley\\",
    "C:/Games/Stardew Valley",
    "\\\\server\\share\\Stardew Valley",
    "\\\\?\\C:\\Games\\Stardew Valley",
    "\\\\.\\C:\\Games\\Stardew Valley",
    "C:\\Games\\StardewModdingAPI.exe",
    "C:\\Games\\bad|name",
    "C:\\Games\\CON",
    "C:\\Games\\NUL.txt",
  ];
  for (const value of badCandidates) {
    let invoked = false;
    const inspector = chainInspector([validChain(), validChain()], [], () => { invoked = true; });
    await rejectsRedacted(() => admitStardewInstallation(inspector, value));
    assert.equal(invoked, false, value);
  }
});

test("the production platform guard cannot be weakened by the test inspector", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor);
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    const inspector = chainInspector([validChain(), validChain()], []);
    await rejectsRedacted(() => admitStardewInstallation(inspector, candidate));
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("malformed chains, wrong kinds, and reparse objects all fail closed", async () => {
  const malformedLength = validChain().slice(0, 3);
  const wrongAncestor = replace(validChain(), 1, identity("regular_file", "00000000000000000000000000000002"));
  const wrongLeaf = replace(validChain(), 3, identity("directory", "00000000000000000000000000000004"));
  const reparseAncestor = replace(validChain(), 1, identity("directory", "00000000000000000000000000000002", { isReparsePoint: true }));
  const reparseLeaf = replace(validChain(), 3, identity("regular_file", "00000000000000000000000000000004", { isReparsePoint: true }));
  const malformedIdentity = replace(validChain(), 1, Object.freeze({
    objectKind: "directory",
    isReparsePoint: false,
    volumeIdentity,
    fileId: "not-an-id",
  }) as WindowsPathObjectIdentity);
  const mixedVolume = replace(validChain(), 1, identity("directory", "00000000000000000000000000000002", {
    volumeIdentity: "fedcba9876543210",
  }));

  for (const chain of [malformedLength, wrongAncestor, wrongLeaf, reparseAncestor, reparseLeaf, malformedIdentity, mixedVolume]) {
    await rejectsRedacted(() => admitStardewInstallation(chainInspector([chain, chain], []), candidate));
  }
});

test("replacement between the first and second chain fails for every identity field", async () => {
  const base = validChain();
  const replacements = [
    replace(base, 2, identity("directory", "ffffffffffffffffffffffffffffffff")),
    replace(base, 2, identity("directory", "00000000000000000000000000000003", { volumeIdentity: "fedcba9876543210" })),
    replace(base, 2, identity("directory", "00000000000000000000000000000003", { isReparsePoint: true })),
    replace(base, 3, identity("directory", "00000000000000000000000000000004")),
  ];

  for (const second of replacements) {
    await rejectsRedacted(() => admitStardewInstallation(chainInspector([base, second], []), candidate));
  }
});

test("nonidentical volume and object kind across otherwise valid successive chains fail", async () => {
  const base = validChain();
  const volumeReplacement = replace(base, 3, identity("regular_file", "00000000000000000000000000000004", {
    volumeIdentity: "fedcba9876543210",
  }));
  const kindReplacement = replace(base, 3, identity("directory", "00000000000000000000000000000004"));

  await rejectsRedacted(() => admitStardewInstallation(chainInspector([base, volumeReplacement], []), candidate));
  await rejectsRedacted(() => admitStardewInstallation(chainInspector([base, kindReplacement], []), candidate));
});

test("helper failure, forged inspector, and absent inspector all map to one redacted failure", async () => {
  const failedHelper = createTestWindowsReparseInspector(() => { throw new Error(`missing ${executable}`); });
  await rejectsRedacted(() => admitStardewInstallation(failedHelper, candidate));
  await rejectsRedacted(() => admitStardewInstallation(Object.freeze({}), candidate));
  await rejectsRedacted(() => admitStardewInstallation(undefined as never, candidate));
});

test("controlled-use seam fresh-rereads the same private chain without leaking it", async () => {
  const observed: unknown[] = [];
  const inspector = chainInspector([validChain(), validChain(), validChain()], observed);
  const admitted = await admitStardewInstallation(inspector, candidate);
  await recheckAdmittedStardewInstallation(admitted);
  assert.deepEqual(observed, [chainRequest(executable), chainRequest(executable), chainRequest(executable)]);
});

test("controlled-use seam rejects forged capability and changed identity", async () => {
  await rejectsRedacted(() => recheckAdmittedStardewInstallation(Object.freeze({}) as AdmittedStardewInstallation));
  const base = validChain();
  const changed = replace(base, 2, identity("directory", "ffffffffffffffffffffffffffffffff"));
  const admitted = await admitStardewInstallation(chainInspector([base, base, changed], []), candidate);
  await rejectsRedacted(() => recheckAdmittedStardewInstallation(admitted));
});

test("controlled-use seam fresh-rereads and passes only root/executable to its callback", async () => {
  const observed: unknown[] = [];
  const inspector = chainInspector([validChain(), validChain(), validChain()], observed);
  const admitted = await admitStardewInstallation(inspector, candidate);
  let callbackSeen: unknown;

  const result = await consumeAdmittedStardewInstallation(admitted, (root, executable) => {
    callbackSeen = { root, executable };
    return "callback-result";
  });

  assert.equal(result, "callback-result");
  assert.deepEqual(callbackSeen, { root: candidate, executable });
  assert.deepEqual(observed, [chainRequest(executable), chainRequest(executable), chainRequest(executable)]);
});

test("controlled-use seam rejects forged/absent installation before callback and stays redacted", async () => {
  let called = false;
  await rejectsRedacted(() => consumeAdmittedStardewInstallation(
    Object.freeze({}) as AdmittedStardewInstallation,
    () => { called = true; return undefined; },
  ));
  await rejectsRedacted(() => consumeAdmittedStardewInstallation(
    undefined as never,
    () => { called = true; return undefined; },
  ));
  assert.equal(called, false);
});

test("controlled-use seam rejects changed identity before callback with zero callback runs", async () => {
  const base = validChain();
  const changed = replace(base, 2, identity("directory", "ffffffffffffffffffffffffffffffff"));
  const admitted = await admitStardewInstallation(chainInspector([base, base, changed], []), candidate);
  let called = false;
  await rejectsRedacted(() => consumeAdmittedStardewInstallation(
    admitted,
    () => { called = true; return undefined; },
  ));
  assert.equal(called, false);
});

test("production source exposes no owner launch helper or raw launch input callback", async () => {
  const source = await readFile(new URL("./stardew-installation-admission.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /test-support|export function (?:read|get).*Admitted/);
  assert.doesNotMatch(source, /StardewOwnedPlayerHostPhaseAOwner|LaunchPlayerHostInput|consumePlayerHostLaunch/);
  assert.doesNotMatch(source, /launchFreshAdmittedStardewPlayerHost|executable:\s*state|cwd:\s*state/);
  assert.doesNotMatch(source, /export function launchOwnedPlayerHost/);
  assert.doesNotMatch(source, /consumeAdmittedStardewInstallation/);
  assert.match(source, /stardew-installation-admission\.core\.js/);
  const coreSource = await readFile(new URL("./stardew-installation-admission.core.js", import.meta.url), "utf8");
  assert.match(coreSource, /export (?:async )?function consumeAdmittedStardewInstallation/);
  assert.match(coreSource, /later launch authority must inspect the path identity chain again/);
});

test("neutral admission core is imported only by the public facade, the private composer core, and the admission test", async () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const leaves = (await readdir(sourceRoot, { recursive: true }))
    .map((leaf) => leaf.replaceAll("\\", "/"))
    .filter((leaf) => leaf.endsWith(".ts"));
  const coreImporters: string[] = [];
  const controlledUseInFiles: string[] = [];
  for (const leaf of leaves) {
    const source = await readFile(join(sourceRoot, leaf), "utf8");
    if (/from\s+["'][^"']*stardew-installation-admission\.core\.js["']/.test(source)) {
      coreImporters.push(leaf);
    }
    if (source.includes("consumeAdmittedStardewInstallation")) {
      controlledUseInFiles.push(leaf);
    }
  }
  assert.deepEqual(coreImporters.sort(), [
    "stardew-installation-admission.test.ts",
    "stardew-installation-admission.ts",
    "stardew-private-bootstrap-composer.core.ts",
  ]);
  // The callback/raw-root/executable controlled use is declared only in the
  // neutral core and imported only by the private composer core and the
  // dedicated admission test adapter; no general production caller reaches it.
  assert.deepEqual(controlledUseInFiles.sort(), [
    "stardew-installation-admission.core.ts",
    "stardew-installation-admission.test.ts",
    "stardew-private-bootstrap-composer.core.ts",
  ]);
});

function chainInspector(
  chains: readonly (readonly WindowsPathObjectIdentity[])[],
  observed: unknown[],
  onInvoke: () => void = () => undefined,
) {
  let index = 0;
  return createTestWindowsReparseInspector(() => {
    onInvoke();
    const chain = chains[index++];
    if (chain === undefined) throw new Error("unexpected_inspection");
    return strictChild(chainResponse(chain), observed);
  });
}

function replace(
  chain: readonly WindowsPathObjectIdentity[],
  index: number,
  value: WindowsPathObjectIdentity,
): readonly WindowsPathObjectIdentity[] {
  const copy = [...chain];
  copy[index] = value;
  return Object.freeze(copy);
}

function chainRequest(path: string): object {
  return { schemaVersion: 2, operation: "inspect_path_chain_v2", path };
}

function chainResponse(components: readonly WindowsPathObjectIdentity[]): string {
  return `${JSON.stringify({ schemaVersion: 2, operation: "inspect_path_chain_v2", status: "ok", components })}\n`;
}

function strictChild(response: string, observed: unknown[]): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  child.stdin.on("data", (input: Buffer) => {
    observed.push(JSON.parse(input.toString("utf8")));
    child.stdout.end(response);
    child.stderr.end();
    queueMicrotask(() => child.emit("close", 0, null));
  });
  return child as unknown as ChildProcess;
}

async function rejectsRedacted(operation: () => Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "stardew_installation_admission_failed");
    assert.equal(error.message.includes("Stardew"), false);
    assert.equal(error.message.includes(volumeIdentity), false);
    return true;
  });
}
