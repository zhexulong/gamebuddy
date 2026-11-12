/**
 * The compiled Host modules this harness reads its facts from, imported once and cached.
 *
 * A live audit talks to the product through the product's own modules rather than through a copy of their rules, so
 * each of these is a path into `host/dist-test`; and because the harness writes through the same store modules a
 * child runtime would, it binds the same Windows stale-lock reclaimer the product's path lock releases through.
 */
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export const HOST_ROOT = resolve(fileURLToPath(new URL("../../../host/", import.meta.url)));

/** The host-owned modules this admission reads its identity and endpoint from. */
export let hostRuntimeIdentityPromise;
export const loadHostRuntimeIdentity = () =>
  (hostRuntimeIdentityPromise ??= import(pathToFileURL(join(HOST_ROOT, "dist-test", "runtime-identity.js")).href));
export let hostProviderCatalogPromise;
export const loadHostProviderCatalog = () =>
  (hostProviderCatalogPromise ??= import(
    pathToFileURL(join(HOST_ROOT, "dist-test", "tavern", "provider-catalog.js")).href
  ));

export let hostConnectionStorePromise;
export const loadHostConnectionStore = () =>
  (hostConnectionStorePromise ??= import(
    pathToFileURL(join(HOST_ROOT, "dist-test", "tavern", "connection-store.js")).href
  ));
export let hostConnectionProbePromise;
export const loadHostConnectionProbe = () =>
  (hostConnectionProbePromise ??= import(
    pathToFileURL(join(HOST_ROOT, "dist-test", "tavern", "connection-probe.js")).href
  ));

/**
 * The product's durable path lock releases through a Windows reclaimer a PROCESS binds (`host/src/path-lock.ts:49`);
 * the runtime binds its own at startup, and a harness that writes through the same store modules before any child
 * exists has to bind the same capability itself - exactly as `tools/live-run/core/persona.mjs` and
 * `tools/live-run/memory/run-memory-live-loop.mjs` do. Without it every product write fails closed with
 * `durable_path_lock_release_failed`.
 */
export let hostPathLockBound = false;
export async function bindHostPathLock() {
  if (hostPathLockBound) return;
  const [{ bindWindowsStaleLockReclaimer }, { createBuildWindowsStaleLockReclaimer }] = await Promise.all([
    import(pathToFileURL(join(HOST_ROOT, "dist-test", "path-lock.js")).href),
    import(pathToFileURL(join(HOST_ROOT, "dist-test", "windows-stale-lock-reclaimer", "index.js")).href),
  ]);
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  hostPathLockBound = true;
}
