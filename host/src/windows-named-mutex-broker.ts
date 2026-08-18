import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MAX_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 1_000;
const NAME_PREFIX = "Local\\GameBuddy.Host.";
const NAME_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
type TerminalOwnership = "held" | "cancelled" | "timeout" | "failed";
type BrokerReply = Readonly<{
  id: string;
  ok: boolean;
  code: string;
  targetId?: string;
  name?: string;
  terminal?: TerminalOwnership | "sealed";
}>;
type BrokerOperation = "acquire" | "release" | "cancel" | "safety_seal";
type Pending = Readonly<{
  op: BrokerOperation;
  name: string;
  targetId?: string;
  resolve: (reply: BrokerReply) => void;
  reject: (error: Error) => void;
}>;

export class WindowsNamedMutexBrokerError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "WindowsNamedMutexBrokerError";
  }
}

export function windowsNamedMutexName(hostOnlyName: string): string {
  if (typeof hostOnlyName !== "string" || !NAME_SUFFIX.test(hostOnlyName))
    throw new WindowsNamedMutexBrokerError("invalid_windows_named_mutex_name");
  return `${NAME_PREFIX}${hostOnlyName}`;
}

export type WindowsNamedMutexAcquireOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;
export type WindowsNamedMutexLeaseAcquisitionDisposition = "acquired" | "abandoned";

export class WindowsNamedMutexLease {
  private released = false;
  private sealed = false;
  private releasePromise: Promise<void> | undefined;
  private readonly lostPromise: Promise<WindowsNamedMutexBrokerError>;
  private lose!: (error: WindowsNamedMutexBrokerError) => void;
  public constructor(
    public readonly name: string,
    public readonly disposition: WindowsNamedMutexLeaseAcquisitionDisposition,
    private readonly releaseLease: () => Promise<void>,
    private readonly safetySealLease: () => Promise<void>,
  ) {
    this.lostPromise = new Promise((resolve) => {
      this.lose = resolve;
    });
  }
  public get lost(): Promise<WindowsNamedMutexBrokerError> {
    return this.lostPromise;
  }
  /** Narrow emergency-only primitive: use only after durable quarantine failed under an abandoned acquisition. */
  public async safetySealAfterAbandonedQuarantineFailure(): Promise<void> {
    if (this.released || this.sealed || this.disposition !== "abandoned")
      throw new WindowsNamedMutexBrokerError("windows_named_mutex_safety_seal_rejected");
    try {
      await this.safetySealLease();
      this.sealed = true;
    } catch (error) {
      if (error instanceof WindowsNamedMutexBrokerError) throw error;
      throw new WindowsNamedMutexBrokerError("windows_named_mutex_safety_seal_failed");
    }
  }
  public release(): Promise<void> {
    if (this.released) return Promise.resolve();
    if (this.sealed) return Promise.reject(new WindowsNamedMutexBrokerError("windows_named_mutex_safety_sealed"));
    if (!this.releasePromise)
      this.releasePromise = (async () => {
        try {
          await this.releaseLease();
        } catch {
          throw new WindowsNamedMutexBrokerError("windows_named_mutex_release_failed");
        }
        this.released = true;
      })();
    return this.releasePromise;
  }
  public close(): Promise<void> {
    return this.release();
  }
  public markSafetySealed(): void {
    this.sealed = true;
  }
  public markLost(error: WindowsNamedMutexBrokerError): void {
    if (!this.released && !this.sealed) this.lose(error);
  }
}

export class WindowsNamedMutexBroker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly lateAcquireReplies = new Set<string>();
  private readonly leases = new Set<WindowsNamedMutexLease>();
  private readonly ownedOrPendingNames = new Set<string>();
  // A release has been sent but not yet proved successful.  `fail` must never
  // reap the sidecar while this remains true: it may still own the mutex.
  private readonly unprovenReleases = new Set<string>();
  private closed = false;
  private closing = false;
  private safetySealed = false;
  private containmentUncertain = false;
  private closePromise: Promise<void> | undefined;
  private reapPromise: Promise<void> | undefined;
  private reapStarted = false;
  private stdinEnded = false;
  private failed: WindowsNamedMutexBrokerError | undefined;
  public get isLive(): boolean {
    return (
      !this.closed &&
      !this.safetySealed &&
      !this.containmentUncertain &&
      this.hasUsableChild() &&
      this.failed === undefined
    );
  }
  /** An observed exit is terminal: never write or register work against that sidecar. */
  private hasUsableChild(): boolean {
    const child = this.child as
      | (ChildProcessWithoutNullStreams & { exitCode?: number | null; signalCode?: NodeJS.Signals | null })
      | undefined;
    return (
      child !== undefined &&
      !child.killed &&
      (child.exitCode === undefined || child.exitCode === null) &&
      (child.signalCode === undefined || child.signalCode === null)
    );
  }

  public async acquire(name: string, options: WindowsNamedMutexAcquireOptions = {}): Promise<WindowsNamedMutexLease> {
    if (process.platform !== "win32") throw new WindowsNamedMutexBrokerError("windows_named_mutex_required");
    if (!name.startsWith(NAME_PREFIX) || !NAME_SUFFIX.test(name.slice(NAME_PREFIX.length)))
      throw new WindowsNamedMutexBrokerError("invalid_windows_named_mutex_name");
    const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS)
      throw new WindowsNamedMutexBrokerError("invalid_windows_named_mutex_timeout");
    if (options.signal?.aborted) throw new WindowsNamedMutexBrokerError("windows_named_mutex_cancelled");
    if (this.safetySealed) throw new WindowsNamedMutexBrokerError("windows_named_mutex_broker_safety_sealed");
    if (this.containmentUncertain)
      throw new WindowsNamedMutexBrokerError("windows_named_mutex_broker_containment_uncertain");
    if (this.closing) throw new WindowsNamedMutexBrokerError("windows_named_mutex_broker_closed");
    if (this.ownedOrPendingNames.has(name)) throw new WindowsNamedMutexBrokerError("windows_named_mutex_already_owned");
    this.ownedOrPendingNames.add(name);
    try {
      this.start();
      const sent = this.cancellableRequest(name, timeoutMs, options.signal);
      const reply = await sent.reply;
      if (!reply.ok || reply.code === "timeout")
        throw new WindowsNamedMutexBrokerError(
          reply.code === "timeout" ? "windows_named_mutex_timeout" : `windows_named_mutex_${reply.code}`,
        );
      if (reply.code !== "acquired" && reply.code !== "abandoned")
        throw new WindowsNamedMutexBrokerError("windows_named_mutex_invalid_reply");
      let lease!: WindowsNamedMutexLease;
      lease = new WindowsNamedMutexLease(
        name,
        reply.code,
        async () => this.releaseLease(lease),
        async () => this.safetySealLease(lease, sent.id),
      );
      this.leases.add(lease);
      return lease;
    } catch (error) {
      this.ownedOrPendingNames.delete(name);
      throw error;
    }
  }

  public close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeImpl();
    return this.closePromise;
  }
  private async closeImpl(): Promise<void> {
    if (this.safetySealed) throw new WindowsNamedMutexBrokerError("windows_named_mutex_broker_safety_sealed");
    if (this.containmentUncertain)
      throw new WindowsNamedMutexBrokerError("windows_named_mutex_broker_containment_uncertain");
    if (this.closed) return;
    this.closing = true;
    await Promise.allSettled([...this.leases].map((lease) => lease.release()));
    if (this.containmentUncertain)
      throw new WindowsNamedMutexBrokerError("windows_named_mutex_broker_containment_uncertain");
    if (!this.failed) this.beginReap();
    await this.reapPromise;
    // A failed sidecar/protocol/reap path is terminal containment, not a
    // successful close. Keep `closed` false so it cannot be mistaken for a
    // reusable successfully-closed broker; the memoized close promise still
    // makes every later close observe the same terminal result without any
    // second release, reap, kill, or restart.
    if (this.failed) throw this.failed;
    this.closed = true;
  }
  private async releaseLease(lease: WindowsNamedMutexLease): Promise<void> {
    await this.releaseHeld(lease.name);
    this.leases.delete(lease);
    this.ownedOrPendingNames.delete(lease.name);
  }
  /** A release is safe only when the sidecar proves the terminal released state. */
  private async releaseHeld(name: string): Promise<void> {
    if (this.containmentUncertain) throw new WindowsNamedMutexBrokerError("windows_named_mutex_release_failed");
    // A lease which still believes it owns a mutex cannot safely treat an
    // unavailable sidecar as a normal release failure: no terminal release
    // proof exists, so block every cleanup path first.
    if (!this.isLive) {
      this.enterContainmentUncertain();
      throw new WindowsNamedMutexBrokerError("windows_named_mutex_release_failed");
    }
    // Register before sendRequest. A sidecar error can reject the request
    // before this async frame resumes; fail() observes this state and contains
    // rather than beginning its normal reap path.
    this.unprovenReleases.add(name);
    try {
      const reply = await this.sendRequest("release", name, 0).reply;
      if (!reply.ok || reply.code !== "released") throw new Error("invalid_release_reply");
      this.unprovenReleases.delete(name);
    } catch {
      // The sidecar may still retain the native mutex. This irreversible state
      // intentionally forbids reaping, termination, or another release attempt.
      this.enterContainmentUncertain();
      throw new WindowsNamedMutexBrokerError("windows_named_mutex_release_failed");
    }
  }
  private async safetySealLease(lease: WindowsNamedMutexLease, targetId: string): Promise<void> {
    // This transition is deliberately local and synchronous: once sealing starts,
    // acquire rejects, and the sidecar cannot see a seal beside a sibling/pending request.
    if (!this.leases.has(lease) || this.leases.size !== 1 || this.pending.size !== 0)
      throw new WindowsNamedMutexBrokerError("windows_named_mutex_safety_seal_rejected");
    lease.markSafetySealed();
    this.safetySealed = true;
    let reply: BrokerReply | undefined;
    try {
      reply = await this.sendRequest("safety_seal", lease.name, 0, targetId).reply;
    } catch {
      /* an uncertain seal is poison, never a release opportunity */
    } finally {
      this.leases.delete(lease);
      this.ownedOrPendingNames.delete(lease.name);
    }
    if (
      !reply ||
      !reply.ok ||
      reply.code !== "safety_sealed" ||
      reply.targetId !== targetId ||
      reply.name !== lease.name ||
      reply.terminal !== "sealed"
    )
      throw new WindowsNamedMutexBrokerError("windows_named_mutex_safety_seal_failed");
  }

  private cancellableRequest(
    name: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Readonly<{ id: string; reply: Promise<BrokerReply> }> {
    const sent = this.sendRequest("acquire", name, timeoutMs);
    if (!signal) return sent;
    return Object.freeze({
      id: sent.id,
      reply: new Promise<BrokerReply>((resolve, reject) => {
        let aborting = false;
        const abort = () => {
          if (aborting) return;
          aborting = true;
          void this.cancelAcquire(sent.id, name).then(
            () => reject(new WindowsNamedMutexBrokerError("windows_named_mutex_cancelled")),
            reject,
          );
        };
        signal.addEventListener("abort", abort, { once: true });
        sent.reply
          .then(
            (reply) => {
              if (!aborting) resolve(reply);
            },
            (error) => {
              if (!aborting) reject(error);
            },
          )
          .finally(() => signal.removeEventListener("abort", abort));
      }),
    });
  }
  private async cancelAcquire(id: string, name: string): Promise<void> {
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      this.lateAcquireReplies.add(id);
      pending.reject(new WindowsNamedMutexBrokerError("windows_named_mutex_cancelled"));
    }
    const reply = await this.sendRequest("cancel", name, 0, id).reply;
    if (
      !reply.ok ||
      reply.code !== "cancelled" ||
      reply.targetId !== id ||
      reply.name !== name ||
      !reply.terminal ||
      reply.terminal === "failed"
    )
      throw new WindowsNamedMutexBrokerError("windows_named_mutex_cancel_failed");
    if (reply.terminal === "held") {
      try {
        await this.releaseHeld(name);
      } catch {
        throw new WindowsNamedMutexBrokerError("windows_named_mutex_cancel_failed");
      }
    }
  }
  private sendRequest(
    op: BrokerOperation,
    name: string,
    timeoutMs: number,
    targetId?: string,
  ): Readonly<{ id: string; reply: Promise<BrokerReply> }> {
    // The sole post-local-seal exception requires the still-live sidecar that
    // began the seal. Containment or an observed child exit leaves no possible
    // acknowledgement path, so never register a request that cannot settle.
    if (op === "safety_seal" && (this.containmentUncertain || !this.hasUsableChild()))
      throw new WindowsNamedMutexBrokerError("windows_named_mutex_safety_seal_failed");
    if (
      !this.isLive &&
      !(this.safetySealed && op === "safety_seal" && this.hasUsableChild() && this.failed === undefined)
    )
      throw this.safetySealed
        ? new WindowsNamedMutexBrokerError("windows_named_mutex_broker_safety_sealed")
        : this.containmentUncertain
          ? new WindowsNamedMutexBrokerError("windows_named_mutex_broker_containment_uncertain")
          : (this.failed ?? new WindowsNamedMutexBrokerError("windows_named_mutex_broker_closed"));
    const id = randomUUID();
    const reply = new Promise<BrokerReply>((resolve, reject) =>
      this.pending.set(id, { op, name, targetId, resolve, reject }),
    );
    const payload =
      op === "cancel" || op === "safety_seal" ? { id, op, name, timeoutMs, targetId } : { id, op, name, timeoutMs };
    const handleWriteFailure = () => {
      // `ChildProcess.stdin.write` can fail either through its callback or by
      // throwing synchronously. In both cases every registered request must
      // settle. A release failure enters containment before its caller can
      // escape; a safety seal remains terminal and rejects its pending ack.
      if (op === "release") this.enterContainmentUncertain();
      else this.fail(new WindowsNamedMutexBrokerError("windows_named_mutex_broker_exit"));
    };
    try {
      this.child!.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (error) handleWriteFailure();
      });
    } catch {
      handleWriteFailure();
    }
    return Object.freeze({ id, reply });
  }
  private start(): void {
    if (this.isLive) return;
    if (this.closed || this.safetySealed)
      throw new WindowsNamedMutexBrokerError(
        this.safetySealed ? "windows_named_mutex_broker_safety_sealed" : "windows_named_mutex_broker_closed",
      );
    const asset = fileURLToPath(new URL("./windows-named-mutex-broker.ps1", import.meta.url));
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", asset],
      { stdio: "pipe", windowsHide: true },
    );
    this.child = child;
    createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false }).on("line", (line) =>
      this.handleLine(line),
    );
    this.attachChildTerminalListeners(child);
  }
  /** Only an actual process exit can acknowledge the normal close/reap path. */
  private attachChildTerminalListeners(child: ChildProcessWithoutNullStreams): void {
    child.once("error", () => this.fail(new WindowsNamedMutexBrokerError("windows_named_mutex_broker_exit")));
    child.once("exit", () => this.fail(new WindowsNamedMutexBrokerError("windows_named_mutex_broker_exit"), true));
  }
  private handleLine(line: string): void {
    try {
      if (line.length > 4096) throw new Error();
      const value = JSON.parse(line) as Partial<BrokerReply>;
      if (typeof value.id !== "string" || typeof value.ok !== "boolean" || typeof value.code !== "string")
        throw new Error();
      const pending = this.pending.get(value.id);
      if (!pending) {
        if (
          this.lateAcquireReplies.delete(value.id) &&
          value.targetId === undefined &&
          value.name === undefined &&
          value.terminal === undefined &&
          ["acquired", "abandoned", "timeout", "cancelled", "acquire_failed"].includes(value.code)
        )
          return;
        throw new Error();
      }
      const bound = pending.op === "cancel" || pending.op === "safety_seal";
      if (bound !== (value.targetId !== undefined || value.name !== undefined || value.terminal !== undefined))
        throw new Error();
      if (
        bound &&
        (typeof value.targetId !== "string" ||
          typeof value.name !== "string" ||
          value.targetId !== pending.targetId ||
          value.name !== pending.name ||
          (pending.op === "cancel" && !["held", "cancelled", "timeout", "failed"].includes(value.terminal ?? "")) ||
          (pending.op === "safety_seal" && value.terminal !== "sealed"))
      )
        throw new Error();
      this.pending.delete(value.id);
      pending.resolve(
        Object.freeze({
          id: value.id,
          ok: value.ok,
          code: value.code,
          ...(bound ? { targetId: value.targetId, name: value.name, terminal: value.terminal } : {}),
        }),
      );
    } catch {
      // Once a lease may still be held, malformed or unsolicited sidecar output
      // is indistinguishable from a sidecar that retains a native mutex. Never
      // let protocol cleanup terminate it. Pre-acquire protocol failures retain
      // the ordinary failure/reap behavior.
      if (this.leases.size !== 0 || this.unprovenReleases.size !== 0) this.enterContainmentUncertain();
      else this.fail(new WindowsNamedMutexBrokerError("windows_named_mutex_protocol_error"));
    }
  }
  private beginReap(): void {
    if (this.reapPromise || this.safetySealed || this.containmentUncertain) return;
    this.reapStarted = true;
    const child = this.child;
    this.reapPromise = (async () => {
      let reapSettled = false;
      const onStdinError = (error: unknown) => {
        // `stdin.end()` may report asynchronously through the stream rather
        // than by throwing. The consumer remains installed after reap settles:
        // a deferred pipe error must not become unhandled, but must also never
        // revise the already memoized close result or restart cleanup.
        if (reapSettled) return;
        const terminal =
          error instanceof WindowsNamedMutexBrokerError
            ? error
            : new WindowsNamedMutexBrokerError("windows_named_mutex_broker_close_failed");
        this.fail(terminal);
      };
      try {
        if (!child) return;
        if (child.exitCode !== null || child.signalCode !== null) {
          // An already-observed exit is only the normal close acknowledgement
          // after stdin-ended has been proven. `closing`/reap-started alone is
          // not enough to turn an unexpected exit into successful close.
          if (!this.stdinEnded) this.failed ??= new WindowsNamedMutexBrokerError("windows_named_mutex_broker_exit");
          return;
        }
        // Install before end(): stream errors can be emitted after end() has
        // returned, and must remain inside the typed broker boundary.
        if (typeof child.stdin.on === "function" && !child.stdin.destroyed) {
          child.stdin.on("error", onStdinError);
          // A closed/destroyed stream has no later error source. Until then,
          // including after reap settles, retain the final error consumer.
          if (typeof child.stdin.once === "function" && typeof child.stdin.removeListener === "function")
            child.stdin.once("close", () => child.stdin.removeListener("error", onStdinError));
        }
        child.stdin.end();
        // This checkpoint is deliberately after stdin.end() returns. An exit
        // before it is not provably the normal close acknowledgement.
        this.stdinEnded = true;
        if (!(await this.waitForExit(child, CLOSE_TIMEOUT_MS))) {
          child.kill();
          if (!(await this.waitForExit(child, CLOSE_TIMEOUT_MS)))
            this.failed ??= new WindowsNamedMutexBrokerError("windows_named_mutex_broker_close_failed");
        }
      } catch (error) {
        // Reaping is terminal once started. Never let a child API or wait
        // exception escape as an ordinary dependency failure.
        const terminal =
          error instanceof WindowsNamedMutexBrokerError
            ? error
            : new WindowsNamedMutexBrokerError("windows_named_mutex_broker_close_failed");
        this.failed ??= terminal;
      } finally {
        // Do not remove the final error consumer here. A pipe can report an
        // error after both wait checkpoints have settled; its close listener
        // removes it only when the stream can no longer produce that error.
        reapSettled = true;
      }
    })();
  }
  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }
  private rejectPendingSafetySeal(): void {
    // A safety seal is intentionally terminal containment, not a recoverable
    // request. Its local seal has already blocked every normal cleanup path,
    // so its pending protocol request must still be settled if the sidecar
    // fails before producing its bound terminal acknowledgement.
    for (const [id, pending] of this.pending) {
      if (pending.op !== "safety_seal") continue;
      this.pending.delete(id);
      pending.reject(new WindowsNamedMutexBrokerError("windows_named_mutex_safety_seal_failed"));
    }
  }
  private enterContainmentUncertain(): void {
    if (this.safetySealed) {
      this.rejectPendingSafetySeal();
      return;
    }
    if (this.containmentUncertain) return;
    this.containmentUncertain = true;
    const error = new WindowsNamedMutexBrokerError("windows_named_mutex_broker_containment_uncertain");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const lease of this.leases) lease.markLost(error);
  }
  private fail(error: Error, actualChildExit = false): void {
    // Child-process events and test seams can surface ordinary Error instances.
    // The public broker boundary must still expose only its typed terminal
    // error, never leak a dependency-specific exception through close().
    const terminal =
      error instanceof WindowsNamedMutexBrokerError
        ? error
        : new WindowsNamedMutexBrokerError(
            typeof error.message === "string" && error.message.length > 0
              ? error.message
              : "windows_named_mutex_broker_exit",
          );
    // A sidecar exit is the expected final acknowledgement after close() has
    // ended stdin and begun normal reap. It must not poison a successful close;
    // unexpected exits remain terminal through the ordinary path below.
    if (
      this.reapStarted &&
      this.stdinEnded &&
      actualChildExit &&
      terminal.code === "windows_named_mutex_broker_exit" &&
      this.leases.size === 0 &&
      this.unprovenReleases.size === 0 &&
      this.pending.size === 0
    )
      return;
    if (this.safetySealed) {
      this.rejectPendingSafetySeal();
      return;
    }
    if (this.failed || this.containmentUncertain) return;
    // Pre-acquire failures retain their ordinary failure/reap behavior. Once
    // any lease may remain held (or its release is still unproved), an exit can
    // destroy the only remaining opportunity to establish native release state.
    if (this.leases.size !== 0 || this.unprovenReleases.size !== 0) {
      this.enterContainmentUncertain();
      return;
    }
    this.failed = terminal;
    for (const pending of this.pending.values()) pending.reject(terminal);
    this.pending.clear();
    for (const lease of this.leases) lease.markLost(terminal);
    this.beginReap();
  }
}
