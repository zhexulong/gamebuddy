import { createHash } from "node:crypto";
import {
  type WindowsNamedMutexAcquireOptions,
  type WindowsNamedMutexLeaseAcquisitionDisposition,
  windowsNamedMutexName,
} from "./windows-named-mutex-broker.js";

type PartitionMutexDisposition = WindowsNamedMutexLeaseAcquisitionDisposition;
export type WindowsPartitionMutexLease = Readonly<{
  disposition: WindowsNamedMutexLeaseAcquisitionDisposition;
  release(): Promise<void>;
  /** Required containment operation for an abandoned lease whose durable quarantine cannot be verified. */
  safetySealAfterAbandonedQuarantineFailure(): Promise<void>;
}>;
export type WindowsPartitionMutexBroker = Readonly<{
  acquire(name: string, options?: WindowsNamedMutexAcquireOptions): Promise<WindowsPartitionMutexLease>;
  close(): Promise<void>;
}>;
export type WindowsAuthorityRootMutex = Readonly<{
  /** Lease-aware production composition requires this; legacy short-section consumers may omit it. */
  acquire?(authorityRootIdentity: string): Promise<WindowsPartitionMutexLease>;
  runExclusive<T>(authorityRootIdentity: string, section: (disposition: PartitionMutexDisposition) => T): Promise<T>;
  close(): Promise<void>;
}>;

class WindowsPartitionMutexError extends Error {
  public constructor(
    public readonly code:
      | "async_partition_mutex_section_rejected"
      | "windows_partition_mutex_release_failed"
      | "windows_partition_mutex_containment_failed",
  ) {
    super(code);
    this.name = "WindowsPartitionMutexError";
  }
}

/** Windows-local short-section mutex. FIFO is local to this adapter; only its OS name is shared. */
export function createWindowsAuthorityRootMutex(
  broker: WindowsPartitionMutexBroker,
  options: Readonly<{ timeoutMs?: number }> = {},
): WindowsAuthorityRootMutex {
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0))
    throw new Error("invalid_windows_partition_mutex_timeout");
  let tail = Promise.resolve();
  let poisoned = false;
  const poisonedError = (): WindowsPartitionMutexError =>
    new WindowsPartitionMutexError("windows_partition_mutex_containment_failed");
  const acquire = async (authorityRootIdentity: string): Promise<WindowsPartitionMutexLease> => {
    let admit!: () => void;
    const previous = tail;
    tail = new Promise<void>((resolve) => {
      admit = resolve;
    });
    await previous;
    if (poisoned) {
      admit();
      throw poisonedError();
    }
    try {
      const lease = await broker.acquire(
        authorityRootMutexName(authorityRootIdentity),
        timeoutMs === undefined ? {} : { timeoutMs },
      );
      let terminal = false;
      // An uncertain terminal operation retains this queue position.  No later
      // local request may even begin until an explicit seal succeeds.
      const poison = (): never => {
        poisoned = true;
        // Wake queued callers only so they can observe the deterministic
        // containment failure before any broker acquisition/work is attempted.
        admit();
        throw poisonedError();
      };
      return Object.freeze({
        disposition: lease.disposition,
        async release() {
          if (terminal) return;
          try {
            await lease.release();
          } catch {
            return poison();
          }
          terminal = true;
          admit();
        },
        async safetySealAfterAbandonedQuarantineFailure() {
          if (terminal) throw new Error("windows_partition_mutex_lease_terminal");
          try {
            await lease.safetySealAfterAbandonedQuarantineFailure();
          } catch {
            return poison();
          }
          terminal = true;
          // A successful emergency seal resolves this lease, but the adapter
          // remains poisoned: queued and future callers fail closed.
          admit();
        },
      });
    } catch (error) {
      admit();
      throw error;
    }
  };
  return Object.freeze({
    acquire,
    async runExclusive<T>(
      authorityRootIdentity: string,
      section: (disposition: PartitionMutexDisposition) => T,
    ): Promise<T> {
      const lease = await acquire(authorityRootIdentity);
      let result: T | undefined;
      let sectionError: unknown;
      try {
        result = section(lease.disposition);
        if (isThenable(result)) {
          // Do not assimilate untrusted thenables: even reading `.then` can run
          // arbitrary code. A real Promise gets a rejection observer solely to
          // avoid an unhandled later rejection; no arbitrary thenable is run.
          suppressNativePromiseRejection(result);
          poisoned = true;
          try {
            await lease.safetySealAfterAbandonedQuarantineFailure();
          } catch {
            /* containment remains poisoned; never release */
          }
          throw new WindowsPartitionMutexError("async_partition_mutex_section_rejected");
        }
      } catch (error) {
        sectionError = error;
      }
      // A rejected async section has terminalized by safety seal above. It
      // must never normal-release an unresolved computation.
      if (
        sectionError instanceof WindowsPartitionMutexError &&
        sectionError.code === "async_partition_mutex_section_rejected"
      )
        throw sectionError;
      try {
        await lease.release();
      } catch (error) {
        if (sectionError !== undefined) throw sectionError;
        throw error;
      }
      if (sectionError !== undefined) throw sectionError;
      return result as T;
    },
    async close(): Promise<void> {
      if (poisoned) throw poisonedError();
    },
  });
}

export function authorityRootMutexName(authorityRootIdentity: string): string {
  if (typeof authorityRootIdentity !== "string" || !/^[a-f0-9]{64}$/.test(authorityRootIdentity))
    throw new Error("invalid_authority_root_identity");
  return windowsNamedMutexName(
    `semantic-authority-root-v2-${createHash("sha256").update(`GameBuddy semantic authority mutex v2\\0${authorityRootIdentity}`, "utf8").digest("hex")}`,
  );
}
/** Descriptor-only check: hostile accessors must not run merely to reject async work. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  for (let current: object | null = value as object; current !== null; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "then");
    if (!descriptor) continue;
    return "value" in descriptor ? typeof descriptor.value === "function" : true;
  }
  return false;
}
/** Never assimilates arbitrary thenables or reads their `then` accessor. */
function suppressNativePromiseRejection(value: unknown): void {
  if (!(value instanceof Promise)) return;
  try {
    void Promise.prototype.then.call(value, undefined, () => undefined);
  } catch {
    /* hostile proxies are not observed */
  }
}
