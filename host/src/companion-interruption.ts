export type InterruptionSnapshot = Readonly<{
  epoch: number;
  open: boolean;
}>;

export type StopAdmission = Readonly<{
  accepted: boolean;
  stopId: string;
  sourceEventId: string;
  reasonCode: string;
  previousEpoch: number;
  epoch: number;
}>;

export type CompanionInterruptionOptions = Readonly<{
  /** Maximum number of completed stop IDs retained for idempotency. */
  maxRememberedStops?: number;
}>;

export interface CompanionInterruption {
  capture(): InterruptionSnapshot;
  isCurrent(snapshot: InterruptionSnapshot): boolean;
  assertCurrent(snapshot: InterruptionSnapshot): void;
  /**
   * Synchronously closes admission for the prior epoch. Callers perform all
   * cancellation or teardown described by the returned value themselves.
   */
  stop(stopId: string, sourceEventId: string, reasonCode: string): StopAdmission;
  /** Explicitly admits work in the current, previously closed epoch. */
  open(): InterruptionSnapshot;
  /** Synchronously invalidate current admission without performing work. */
  close(reasonCode: string): void;
}

const DEFAULT_MAX_REMEMBERED_STOPS = 128;
const MAX_IDENTIFIER_LENGTH = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Creates the runtime-local interruption admission boundary. It deliberately
 * owns neither cancellation work nor durable state: callers must fence their
 * own work with a captured snapshot and schedule any returned STOP work.
 */
export function createCompanionInterruption(
  options: CompanionInterruptionOptions = {},
): CompanionInterruption {
  const maxRememberedStops = options.maxRememberedStops ?? DEFAULT_MAX_REMEMBERED_STOPS;
  if (!Number.isSafeInteger(maxRememberedStops) || maxRememberedStops < 1)
    throw new Error("invalid_interruption_dedupe_bound");

  let epoch = 0;
  let open = true;
  const rememberedStops = new Map<string, StopAdmission>();
  const capturedSnapshots = new WeakSet<object>();

  const snapshot = (): InterruptionSnapshot => {
    const binding = Object.freeze({ epoch, open });
    capturedSnapshots.add(binding);
    return binding;
  };

  return Object.freeze({
    capture: snapshot,
    isCurrent(binding: InterruptionSnapshot): boolean {
      return (
        isCapturedSnapshot(binding, capturedSnapshots) &&
        binding.open &&
        open &&
        binding.epoch === epoch
      );
    },
    assertCurrent(binding: InterruptionSnapshot): void {
      if (
        !isCapturedSnapshot(binding, capturedSnapshots) ||
        !binding.open ||
        !open ||
        binding.epoch !== epoch
      ) {
        throw new Error("stale_interruption_admission");
      }
    },
    stop(stopId: string, sourceEventId: string, reasonCode: string): StopAdmission {
      validateIdentifier(stopId, "stop_id");
      validateIdentifier(sourceEventId, "source_event_id");
      validateIdentifier(reasonCode, "reason_code");

      const prior = rememberedStops.get(stopId);
      if (prior !== undefined) {
        // A duplicate is observational only: it must not mutate dedupe order,
        // reopen admission, or schedule STOP work a second time.
        return Object.freeze({ ...prior, accepted: false });
      }

      const previousEpoch = epoch;
      epoch += 1;
      open = false;
      const admission = Object.freeze({
        accepted: true,
        stopId,
        sourceEventId,
        reasonCode,
        previousEpoch,
        epoch,
      });
      rememberedStops.set(stopId, admission);
      if (rememberedStops.size > maxRememberedStops) rememberedStops.delete(rememberedStops.keys().next().value!);
      return admission;
    },
    open(): InterruptionSnapshot {
      if (open) throw new Error("interruption_admission_already_open");
      open = true;
      return snapshot();
    },
    close(reasonCode: string): void {
      validateIdentifier(reasonCode, "reason_code");
      epoch += 1;
      open = false;
    },
  });
}

function isCapturedSnapshot(
  value: InterruptionSnapshot,
  capturedSnapshots: WeakSet<object>,
): value is InterruptionSnapshot {
  return typeof value === "object" && value !== null && capturedSnapshots.has(value);
}

function validateIdentifier(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`invalid_interruption_${name}`);
  }
}
