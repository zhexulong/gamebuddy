import { win32 } from "node:path";

import {
  inspectWindowsPathIdentityChain,
  type WindowsPathObjectIdentity,
  type WindowsReparseInspectorCapability,
} from "./windows-reparse-inspector/index.js";

const executableFileName = "StardewModdingAPI.exe";
const driveRoot = /^[A-Za-z]:\\$/;
const identityHex64 = /^[a-f0-9]{16}$/;
const identityHex128 = /^[a-f0-9]{32}$/;

declare const admittedStardewInstallationBrand: unique symbol;

/** Opaque proof that one exact installation path passed this slice's identity-chain admission. */
export type AdmittedStardewInstallation = object & {
  readonly [admittedStardewInstallationBrand]: true;
};

type AdmittedInstallationState = Readonly<{
  inspector: WindowsReparseInspectorCapability;
  root: string;
  executable: string;
  identityChain: readonly WindowsPathObjectIdentity[];
}>;

const admittedInstallations = new WeakSet<object>();
const admittedInstallationStates = new WeakMap<object, AdmittedInstallationState>();

/**
 * Admits an exact Windows installation root. This proves neither compatibility nor launch readiness;
 * a later launch authority must inspect the path identity chain again immediately before use.
 */
export async function admitStardewInstallation(
  inspector: WindowsReparseInspectorCapability,
  gameDirectoryCandidate: string,
): Promise<AdmittedStardewInstallation> {
  try {
    const candidateComponentCount = assertStrictInstallationCandidate(gameDirectoryCandidate);
    const executable = win32.join(gameDirectoryCandidate, executableFileName);
    if (win32.dirname(executable) !== gameDirectoryCandidate) throw admissionFailed();

    const firstChain = await inspectWindowsPathIdentityChain(inspector, executable);
    const secondChain = await inspectWindowsPathIdentityChain(inspector, executable);
    const expectedCount = candidateComponentCount + 2; // drive root, candidate components, executable leaf

    assertAdmissibleChain(firstChain, expectedCount);
    assertAdmissibleChain(secondChain, expectedCount);
    assertSingleVolume(firstChain);
    assertSingleVolume(secondChain);
    if (!chainsEqual(firstChain, secondChain)) throw admissionFailed();

    const capability = Object.freeze({}) as AdmittedStardewInstallation;
    admittedInstallations.add(capability);
    admittedInstallationStates.set(capability, Object.freeze({
      inspector,
      root: gameDirectoryCandidate,
      executable,
      identityChain: secondChain,
    }));
    return capability;
  } catch {
    throw admissionFailed();
  }
}

/** Rechecks the exact admitted SMAPI identity without revealing its path. */
export async function recheckAdmittedStardewInstallation(
  installation: AdmittedStardewInstallation,
): Promise<void> {
  try {
    await readFreshAdmittedInstallationState(installation);
  } catch {
    throw admissionFailed();
  }
}

/** Fresh-rereads the exact admitted SMAPI identity and passes only the derived root and executable
 * to a composition-bound callback. A stale, altered, or forged installation never reaches the
 * callback; no identity chain, inspector, or admission surface escapes. */
export async function consumeAdmittedStardewInstallation<T>(
  installation: AdmittedStardewInstallation,
  callback: (root: string, executable: string) => T,
): Promise<T> {
  const state = await readFreshAdmittedInstallationState(installation);
  return callback(state.root, state.executable);
}

async function readFreshAdmittedInstallationState(
  installation: AdmittedStardewInstallation,
): Promise<AdmittedInstallationState> {
  if (typeof installation !== "object" || installation === null) throw admissionFailed();
  const state = admittedInstallationStates.get(installation);
  if (state === undefined || !admittedInstallations.has(installation)) throw admissionFailed();
  const chain = await inspectWindowsPathIdentityChain(state.inspector, state.executable);
  assertAdmissibleChain(chain, state.identityChain.length);
  assertSingleVolume(chain);
  if (!chainsEqual(state.identityChain, chain)) throw admissionFailed();
  return state;
}

function assertStrictInstallationCandidate(candidate: string): number {
  if (process.platform !== "win32" || typeof candidate !== "string") throw admissionFailed();
  if (candidate.length === 0 || candidate.length > 32 * 1024 || candidate.includes("/") || !/^[A-Za-z]:\\/.test(candidate)) {
    throw admissionFailed();
  }
  if (driveRoot.test(candidate)) return 0;

  const components = candidate.slice(3).split("\\");
  if (components.length === 0 || components.length > 511) throw admissionFailed();
  for (const component of components) {
    if (
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      /[\\/:*?<>"|\u0000-\u001f]/.test(component) ||
      component.endsWith(".") ||
      component.endsWith(" ") ||
      isReservedWindowsName(component)
    ) {
      throw admissionFailed();
    }
  }
  if (components.at(-1)?.toLowerCase() === executableFileName.toLowerCase()) throw admissionFailed();
  return components.length;
}

function isReservedWindowsName(component: string): boolean {
  const baseName = component.split(".", 1)[0]?.toUpperCase();
  return baseName !== undefined && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(baseName);
}

function assertAdmissibleChain(chain: readonly WindowsPathObjectIdentity[], expectedCount: number): void {
  if (!Array.isArray(chain) || chain.length !== expectedCount) throw admissionFailed();
  for (let index = 0; index < chain.length; index++) {
    const identity = chain[index];
    if (!validIdentity(identity) || identity.isReparsePoint) throw admissionFailed();
    const expectedKind = index === chain.length - 1 ? "regular_file" : "directory";
    if (identity.objectKind !== expectedKind) throw admissionFailed();
  }
}

function assertSingleVolume(chain: readonly WindowsPathObjectIdentity[]): void {
  const volumeIdentity = chain[0]?.volumeIdentity;
  if (volumeIdentity === undefined || chain.some((identity) => identity.volumeIdentity !== volumeIdentity)) {
    throw admissionFailed();
  }
}

function validIdentity(identity: unknown): identity is WindowsPathObjectIdentity {
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) return false;
  const value = identity as Record<string, unknown>;
  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    Object.hasOwn(value, "objectKind") &&
    Object.hasOwn(value, "isReparsePoint") &&
    Object.hasOwn(value, "volumeIdentity") &&
    Object.hasOwn(value, "fileId") &&
    (value.objectKind === "directory" || value.objectKind === "regular_file") &&
    typeof value.isReparsePoint === "boolean" &&
    typeof value.volumeIdentity === "string" &&
    identityHex64.test(value.volumeIdentity) &&
    typeof value.fileId === "string" &&
    identityHex128.test(value.fileId)
  );
}

function chainsEqual(
  first: readonly WindowsPathObjectIdentity[],
  second: readonly WindowsPathObjectIdentity[],
): boolean {
  return first.every((identity, index) => {
    const replacement = second[index];
    return (
      replacement !== undefined &&
      identity.objectKind === replacement.objectKind &&
      identity.isReparsePoint === replacement.isReparsePoint &&
      identity.volumeIdentity === replacement.volumeIdentity &&
      identity.fileId === replacement.fileId
    );
  });
}

function admissionFailed(): Error {
  return new Error("stardew_installation_admission_failed");
}