import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { parseStrictJson } from "../strict-json-reader.js";
import {
  assertNoWindowsReparse,
  type WindowsReparseInspectorCapability,
} from "../windows-reparse-inspector/index.js";

/** The common integrity metadata required for every verified static asset. */
export type StaticArtifactAsset = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
  mime: string;
}>;

export type StaticArtifactManifest<
  Identity extends object,
  Asset extends StaticArtifactAsset,
  EntryHtml extends string,
> = Readonly<{
  identity: Identity;
  entryHtml: EntryHtml;
  assets: readonly Asset[];
}>;

/**
 * A consumer-owned policy supplies identity and publication details; this module
 * owns the filesystem, reparse, stable-read, and integrity mechanics.
 */
export type StaticArtifactVerificationPolicy<
  Identity extends object,
  Asset extends StaticArtifactAsset,
  EntryHtml extends string,
> = Readonly<{
  manifestFileName: string;
  entryHtml: EntryHtml;
  parseManifest(value: unknown): StaticArtifactManifest<Identity, Asset, EntryHtml>;
  matchesExpectedIdentity(identity: Identity): boolean;
  isAllowedAsset(asset: Asset): boolean;
  isAllowedDirectory(relativePath: string): boolean;
}>;

export type VerifiedStaticArtifact<
  Identity extends object,
  Asset extends StaticArtifactAsset,
  EntryHtml extends string,
> = Readonly<{
  root: string;
  identity: Identity;
  entryHtml: EntryHtml;
  assets: ReadonlyMap<string, Asset>;
}>;

type FileIdentity = Readonly<{ dev: bigint; ino: bigint }>;
type VerifiedAssetRead<Asset extends StaticArtifactAsset> = Readonly<{
  asset: Asset;
  body: Buffer;
}>;

const MANIFEST_MAX_BYTES = 65_536;
const verifiedEntryHtml = new WeakMap<object, Buffer>();
const verifiedAssets = new WeakMap<object, ReadonlyMap<string, StaticArtifactAsset>>();
const verifiedInspectors = new WeakMap<object, WindowsReparseInspectorCapability | undefined>();

/** Verifies one complete, policy-shaped static artifact before it is consumed. */
export async function verifyStaticArtifact<
  Identity extends object,
  Asset extends StaticArtifactAsset,
  EntryHtml extends string,
>(
  artifactRoot: string,
  policy: StaticArtifactVerificationPolicy<Identity, Asset, EntryHtml>,
  inspector?: WindowsReparseInspectorCapability,
): Promise<VerifiedStaticArtifact<Identity, Asset, EntryHtml>> {
  const root = resolve(artifactRoot);
  try {
    validatePolicy(policy);
    const rootDirectory = await verifyDirectory(root, root, inspector);
    const manifestPath = resolve(root, policy.manifestFileName);
    await assertNoWindowsReparse(inspector, manifestPath);
    await verifyRegularFile(manifestPath, root, undefined, inspector);
    const manifest = policy.parseManifest(
      parseStrictJson(decodeUtf8(await readVerifiedFile(manifestPath, root, inspector, MANIFEST_MAX_BYTES))),
    );
    if (
      !record(manifest.identity) ||
      !policy.matchesExpectedIdentity(manifest.identity) ||
      manifest.entryHtml !== policy.entryHtml ||
      !safeRelativePath(manifest.entryHtml) ||
      manifest.entryHtml === policy.manifestFileName ||
      !Array.isArray(manifest.assets)
    )
      throw invalid();

    const assets = new Map<string, Asset>();
    for (const asset of manifest.assets) {
      if (
        !validIntegrityMetadata(asset) ||
        !safeRelativePath(asset.path) ||
        asset.path === policy.manifestFileName ||
        asset.path === manifest.entryHtml ||
        assets.has(asset.path) ||
        !policy.isAllowedAsset(asset as Asset)
      )
        throw invalid();
      assets.set(asset.path, Object.freeze({ ...asset }) as Asset);
    }
    const allowed = new Set<string>([policy.manifestFileName, manifest.entryHtml, ...assets.keys()]);
    await verifyArtifactTree(root, allowed, rootDirectory, policy.isAllowedDirectory, inspector);
    const entryHtml = await readVerifiedFile(resolve(root, manifest.entryHtml), root, inspector);
    for (const asset of assets.values()) {
      const content = await readVerifiedFile(resolve(root, asset.path), root, inspector);
      if (content.length !== asset.bytes || sha256(content) !== asset.sha256) throw invalid();
    }

    const retainedAssets = new Map<string, StaticArtifactAsset>();
    for (const [path, asset] of assets) retainedAssets.set(path, asset);
    const artifact = Object.freeze({
      root,
      identity: Object.freeze({ ...manifest.identity }) as Identity,
      entryHtml: manifest.entryHtml,
      assets: new Map(assets),
    }) as VerifiedStaticArtifact<Identity, Asset, EntryHtml>;
    // The entry document is intentionally retained outside the public artifact
    // shape so serving never re-opens a replaceable shell path.
    verifiedEntryHtml.set(artifact, Buffer.from(entryHtml));
    verifiedAssets.set(artifact, retainedAssets);
    verifiedInspectors.set(artifact, inspector);
    return artifact;
  } catch {
    throw invalid();
  }
}

/** Returns the bytes captured at verification time, never a later shell path. */
export function getVerifiedStaticArtifactEntryHtml<
  Identity extends object,
  Asset extends StaticArtifactAsset,
  EntryHtml extends string,
>(artifact: VerifiedStaticArtifact<Identity, Asset, EntryHtml>): Buffer {
  const body = verifiedEntryHtml.get(artifact);
  if (body === undefined || !verifiedAssets.has(artifact) || !verifiedInspectors.has(artifact)) throw invalid();
  return Buffer.from(body);
}

/** Reads and revalidates one exact published asset through the retained artifact state. */
export async function readVerifiedStaticArtifactAsset<
  Identity extends object,
  Asset extends StaticArtifactAsset,
  EntryHtml extends string,
>(
  artifact: VerifiedStaticArtifact<Identity, Asset, EntryHtml>,
  assetPath: string,
): Promise<VerifiedAssetRead<Asset> | undefined> {
  const assets = verifiedAssets.get(artifact);
  if (assets === undefined || !verifiedInspectors.has(artifact)) throw invalid();
  const asset = assets.get(assetPath) as Asset | undefined;
  if (asset === undefined) return undefined;
  const body = await readVerifiedFile(
    resolve(artifact.root, asset.path),
    artifact.root,
    verifiedInspectors.get(artifact),
  );
  if (body.length !== asset.bytes || sha256(body) !== asset.sha256) throw invalid();
  return Object.freeze({ asset, body });
}

function validatePolicy<
  Identity extends object,
  Asset extends StaticArtifactAsset,
  EntryHtml extends string,
>(policy: StaticArtifactVerificationPolicy<Identity, Asset, EntryHtml>): void {
  if (
    !record(policy) ||
    !safeRelativePath(policy.manifestFileName) ||
    !safeRelativePath(policy.entryHtml) ||
    policy.manifestFileName === policy.entryHtml ||
    typeof policy.parseManifest !== "function" ||
    typeof policy.matchesExpectedIdentity !== "function" ||
    typeof policy.isAllowedAsset !== "function" ||
    typeof policy.isAllowedDirectory !== "function"
  )
    throw invalid();
}

/**
 * Enumerates only policy-allowed files. Every directory and entry is inspected
 * before use, and directory identities reject aliases and cycles.
 */
async function verifyArtifactTree(
  root: string,
  allowed: ReadonlySet<string>,
  rootDirectory: FileIdentity,
  isAllowedDirectory: (relativePath: string) => boolean,
  inspector: WindowsReparseInspectorCapability | undefined,
): Promise<void> {
  const directories = new Set<string>([identityKey(rootDirectory)]);
  await verifyArtifactDirectory(root, root, allowed, directories, isAllowedDirectory, inspector);
}

async function verifyArtifactDirectory(
  root: string,
  directory: string,
  allowed: ReadonlySet<string>,
  directories: Set<string>,
  isAllowedDirectory: (relativePath: string) => boolean,
  inspector: WindowsReparseInspectorCapability | undefined,
): Promise<void> {
  await assertNoWindowsReparse(inspector, directory);
  const directoryStat = await verifyDirectory(directory, root, inspector);
  if (!directories.has(identityKey(directoryStat))) throw invalid();
  for (const entry of await readdir(directory)) {
    const full = resolve(directory, entry);
    if (!contained(full, root) && full !== root) throw invalid();
    await assertNoWindowsReparse(inspector, full);
    const stat = await lstat(full, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw invalid();
    const key = relative(root, full).split(sep).join("/");
    if (stat.isDirectory()) {
      if (!isAllowedDirectory(key)) throw invalid();
      const childKey = identityKey(stat);
      if (directories.has(childKey)) throw invalid();
      directories.add(childKey);
      await verifyArtifactDirectory(root, full, allowed, directories, isAllowedDirectory, inspector);
    } else {
      if (!allowed.has(key)) throw invalid();
      await verifyRegularFile(full, root, stat, inspector);
    }
  }
}

async function verifyDirectory(
  path: string,
  root: string,
  inspector: WindowsReparseInspectorCapability | undefined,
): Promise<FileIdentity> {
  await assertNoWindowsReparse(inspector, path);
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
  identityKey(stat);
  const physical = await realpath(path);
  const physicalRoot = await realpath(root);
  if (physical !== physicalRoot && !physical.startsWith(`${physicalRoot}${sep}`)) throw invalid();
  return stat;
}

async function verifyRegularFile(
  path: string,
  root: string,
  expectedStat?: FileIdentity & { isFile(): boolean; isSymbolicLink(): boolean },
  inspector?: WindowsReparseInspectorCapability,
): Promise<void> {
  await assertNoWindowsReparse(inspector, path);
  const stat = expectedStat ?? (await lstat(path, { bigint: true }));
  if (!contained(path, root) || !stat.isFile() || stat.isSymbolicLink()) throw invalid();
  identityKey(stat);
}

async function readVerifiedFile(
  path: string,
  root: string,
  inspector: WindowsReparseInspectorCapability | undefined,
  maxBytes?: number,
): Promise<Buffer> {
  if (!contained(path, root)) throw invalid();
  await assertNoWindowsReparse(inspector, path);
  const parent = dirname(path);
  await assertNoWindowsReparse(inspector, parent);
  const physicalParent = await realpath(parent);
  const physicalRoot = await realpath(root);
  if (physicalParent !== physicalRoot && !physicalParent.startsWith(`${physicalRoot}${sep}`)) throw invalid();
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw invalid();
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened) || !opened.isFile()) throw invalid();
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
    if (maxBytes !== undefined && opened.size > BigInt(maxBytes)) throw invalid();
    const body = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (bytesRead === 0) throw invalid();
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      !sameFile(opened, after) ||
      !sameFile(opened, pathAfter) ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      pathAfter.isSymbolicLink()
    )
      throw invalid();
    return body;
  } finally {
    await handle.close();
  }
}

function validIntegrityMetadata(value: unknown): value is StaticArtifactAsset {
  if (!record(value)) return false;
  return (
    typeof value.path === "string" &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    typeof value.mime === "string" &&
    /^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+$/.test(value.mime)
  );
}

function safeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\") || value.endsWith("/")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("."));
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    throw invalid();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function contained(path: string, root: string): boolean {
  const relation = relative(root, path);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`);
}

function identityKey(stat: FileIdentity): string {
  // Without a stable identity Node cannot prove distinct paths identify
  // distinct directories, so an unavailable identity fails closed.
  if (stat.dev === 0n || stat.ino === 0n) throw invalid();
  return `${stat.dev}:${stat.ino}`;
}

function sameFile(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function invalid(): Error {
  return new Error("invalid_static_artifact");
}
