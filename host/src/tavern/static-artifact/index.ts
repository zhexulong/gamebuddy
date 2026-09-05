import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, relative, resolve, sep } from "node:path";

import { readStrictJsonFile } from "../../strict-json-reader.js";
import {
  assertNoWindowsReparse,
  createPublishedWindowsReparseInspector,
  type WindowsReparseInspectorCapability,
} from "../../windows-reparse-inspector/index.js";

const TAVERN_BROWSER_ARTIFACT_MANIFEST = "tavern-browser-artifact-manifest.json" as const;
export const TAVERN_BROWSER_CONTRACT = "tavern_browser_api/v1" as const;

export type TavernStaticArtifactIdentity = Readonly<{
  browserContract: typeof TAVERN_BROWSER_CONTRACT;
  profileId: string;
}>;
type TavernStaticArtifactAsset = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
  mime: "text/javascript" | "text/css" | "image/svg+xml" | "image/png" | "image/webp" | "font/woff2";
}>;
export type VerifiedTavernStaticArtifact = Readonly<{
  root: string;
  identity: TavernStaticArtifactIdentity;
  entryHtml: "index.html";
  assets: ReadonlyMap<string, TavernStaticArtifactAsset>;
}>;
export type StaticTavernArtifactServer = Readonly<{ server: Server; close(): Promise<void> }>;
export type TavernStaticArtifactRequestHandler = Readonly<{
  handle(request: IncomingMessage, response: ServerResponse): void;
}>;

const ASSET_MIMES = new Set<TavernStaticArtifactAsset["mime"]>([
  "text/javascript",
  "text/css",
  "image/svg+xml",
  "image/png",
  "image/webp",
  "font/woff2",
]);
const verifiedEntryHtml = new WeakMap<VerifiedTavernStaticArtifact, Buffer>();
const verifiedInspectors = new WeakMap<VerifiedTavernStaticArtifact, WindowsReparseInspectorCapability | undefined>();

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
});

/** Validates the complete fixed browser artifact before any HTTP listener is created. */
export async function verifyTavernStaticArtifact(
  artifactRoot: string,
  expectedIdentity: TavernStaticArtifactIdentity,
  inspector?: WindowsReparseInspectorCapability,
): Promise<VerifiedTavernStaticArtifact> {
  if (!validIdentity(expectedIdentity)) throw invalid();
  const root = resolve(artifactRoot);
  const activeInspector =
    inspector ?? (process.platform === "win32" ? undefined : await createPublishedWindowsReparseInspector(root));
  try {
    await assertNoWindowsReparse(activeInspector, root);
    const rootDirectory = await verifyDirectory(root, root, activeInspector);
    const manifestPath = resolve(root, TAVERN_BROWSER_ARTIFACT_MANIFEST);
    await assertNoWindowsReparse(activeInspector, manifestPath);
    await verifyRegularFile(manifestPath, root, undefined, activeInspector);
    const manifest = parseManifest(await readStrictJsonFile(manifestPath));
    if (
      manifest.browserContract !== expectedIdentity.browserContract ||
      manifest.profileId !== expectedIdentity.profileId
    )
      throw invalid();

    const assets = new Map<string, TavernStaticArtifactAsset>();
    for (const asset of manifest.assets) {
      if (!validAsset(asset) || assets.has(asset.path)) throw invalid();
      assets.set(asset.path, Object.freeze({ ...asset }));
    }
    const allowed = new Set<string>([TAVERN_BROWSER_ARTIFACT_MANIFEST, manifest.entryHtml, ...assets.keys()]);
    await verifyArtifactTree(root, allowed, rootDirectory, activeInspector);
    const entryHtml = await readVerifiedFile(resolve(root, manifest.entryHtml), root, activeInspector);
    for (const asset of assets.values()) {
      const content = await readVerifiedFile(resolve(root, asset.path), root, activeInspector);
      if (content.length !== asset.bytes || sha256(content) !== asset.sha256) throw invalid();
    }
    const artifact = Object.freeze({
      root,
      identity: Object.freeze({ ...expectedIdentity }),
      entryHtml: "index.html" as const,
      assets,
    });
    // The shell is deliberately retained outside the public artifact shape: the frozen
    // manifest has no HTML hash, and GET / must not re-open a replaceable filesystem path.
    verifiedEntryHtml.set(artifact, Buffer.from(entryHtml));
    verifiedInspectors.set(artifact, activeInspector);
    return artifact;
  } catch {
    throw invalid();
  }
}

/** Creates a closed static dispatcher only after its artifact has passed complete verification. */
export function createTavernStaticArtifactRequestHandler(
  artifact: VerifiedTavernStaticArtifact,
): TavernStaticArtifactRequestHandler {
  return Object.freeze({
    handle(request, response) {
      void serve(artifact, request.method, request.url, response).catch(() => notFound(response));
    },
  });
}

/** Creates a standalone static server only after complete verification. */
export async function createStaticTavernArtifactServer(
  artifactRoot: string,
  expectedIdentity: TavernStaticArtifactIdentity,
  inspector?: WindowsReparseInspectorCapability,
): Promise<StaticTavernArtifactServer> {
  let activeInspector = inspector;
  try {
    activeInspector ??= await createPublishedWindowsReparseInspector(resolve(artifactRoot));
  } catch {
    throw invalid();
  }
  const artifact = await verifyTavernStaticArtifact(artifactRoot, expectedIdentity, activeInspector);
  const handler = createTavernStaticArtifactRequestHandler(artifact);
  const server = createServer((request, response) => handler.handle(request, response));
  return Object.freeze({
    server,
    close: async () =>
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
  });
}

async function serve(
  artifact: VerifiedTavernStaticArtifact,
  method: string | undefined,
  rawUrl: string | undefined,
  response: ServerResponse,
): Promise<void> {
  if (method !== "GET" || rawUrl === undefined || rawUrl.includes("?") || rawUrl.includes("#") || rawUrl.includes("%"))
    return notFound(response);
  let path: string;
  try {
    path = decodeURIComponent(rawUrl);
  } catch {
    return notFound(response);
  }
  if (path === "/") {
    const body = verifiedEntryHtml.get(artifact);
    if (body === undefined) throw invalid();
    return send(response, 200, "text/html; charset=utf-8", "no-store", body);
  }
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    path.split("/").some((part) => part === "." || part === ".." || part.startsWith("."))
  )
    return notFound(response);
  const assetPath = path.slice(1);
  const asset = artifact.assets.get(assetPath);
  if (asset === undefined) return notFound(response);
  const body = await readVerifiedFile(
    resolve(artifact.root, asset.path),
    artifact.root,
    verifiedInspectors.get(artifact),
  );
  if (body.length !== asset.bytes || sha256(body) !== asset.sha256) return notFound(response);
  return send(response, 200, asset.mime, "public, max-age=31536000, immutable", body);
}

function send(response: ServerResponse, status: number, mime: string, cacheControl: string, body: Buffer): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": mime,
    "Cache-Control": cacheControl,
    "Content-Length": String(body.length),
  });
  response.end(body);
}
function notFound(response: ServerResponse): void {
  response.writeHead(404, { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Length": "0" });
  response.end();
}

type FileIdentity = Readonly<{ dev: bigint; ino: bigint }>;

/**
 * Enumerates the fixed artifact shape from lstat results only. On Windows,
 * lstat marks directory junctions and symbolic links as symbolic links; those
 * are rejected before readdir can traverse them. Directory identities are
 * also unique, so an implementation which exposes an alias without that flag
 * cannot introduce a cycle into the verified tree.
 */
async function verifyArtifactTree(
  root: string,
  allowed: ReadonlySet<string>,
  rootDirectory: FileIdentity,
  inspector: WindowsReparseInspectorCapability | undefined,
): Promise<void> {
  const directories = new Set<string>([identityKey(rootDirectory)]);
  await verifyArtifactDirectory(root, root, allowed, directories, inspector);
}
async function verifyArtifactDirectory(
  root: string,
  directory: string,
  allowed: ReadonlySet<string>,
  directories: Set<string>,
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
      if (key !== "assets") throw invalid();
      const childKey = identityKey(stat);
      if (directories.has(childKey)) throw invalid();
      directories.add(childKey);
      await verifyArtifactDirectory(root, full, allowed, directories, inspector);
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
function parseManifest(value: unknown): {
  browserContract: typeof TAVERN_BROWSER_CONTRACT;
  profileId: string;
  entryHtml: "index.html";
  assets: TavernStaticArtifactAsset[];
} {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "browserContract", "profileId", "entryHtml", "assets"]) ||
    value.schemaVersion !== 1 ||
    value.browserContract !== TAVERN_BROWSER_CONTRACT ||
    typeof value.profileId !== "string" ||
    !validProfileId(value.profileId) ||
    value.entryHtml !== "index.html" ||
    !Array.isArray(value.assets)
  )
    throw invalid();
  return value as never;
}
function validAsset(value: unknown): value is TavernStaticArtifactAsset {
  if (
    !record(value) ||
    !exactKeys(value, ["path", "sha256", "bytes", "mime"]) ||
    typeof value.path !== "string" ||
    !validAssetPath(value.path) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    typeof value.mime !== "string" ||
    !ASSET_MIMES.has(value.mime as TavernStaticArtifactAsset["mime"])
  )
    return false;
  const extension = value.path.slice(value.path.lastIndexOf(".") + 1);
  return (
    (
      {
        js: "text/javascript",
        css: "text/css",
        svg: "image/svg+xml",
        png: "image/png",
        webp: "image/webp",
        woff2: "font/woff2",
      } as const
    )[extension as "js" | "css" | "svg" | "png" | "webp" | "woff2"] === value.mime
  );
}
function validIdentity(value: TavernStaticArtifactIdentity): boolean {
  return value.browserContract === TAVERN_BROWSER_CONTRACT && validProfileId(value.profileId);
}
function validProfileId(value: string): boolean {
  return /^[a-z][a-z0-9._-]{0,127}$/.test(value);
}
function validAssetPath(value: string): boolean {
  return (
    /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|webp|woff2)$/.test(value) &&
    !value.includes("..") &&
    !value.includes("\\\\")
  );
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
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
  // Without a stable identity Node cannot prove distinct paths identify distinct
  // directories, so an unavailable identity fails closed instead of permitting an alias.
  if (stat.dev === 0n || stat.ino === 0n) throw invalid();
  return `${stat.dev}:${stat.ino}`;
}
function sameFile(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function invalid(): Error {
  return new Error("invalid_tavern_static_artifact");
}
