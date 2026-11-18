/**
 * Presence of the two OS objects a Guardian binding owns.
 *
 * A private bootstrap attempt's owner record carries no process identity, only
 * the Guardian's `leaseName` (a named mutex) and `playerJobName` (a named Job
 * Object). Those two names are the only facts that can outlive the Guardian, so
 * they are also the only facts that can prove an attempt's native ownership is
 * gone after an ordinary close or a crash.
 *
 * This module owns the CONTRACT and the decision; it never talks to the OS. The
 * probe is injected by composition, which is where the Windows implementation
 * lives (see `composition/stardew/stardew-guardian-object-presence.ts`), so the
 * game layer stays free of native and platform modules.
 */

/**
 * The three answers the OS can give about one named object, already classified
 * against the exact Win32 result that produced them, plus the one answer that is
 * not about the object at all.
 *
 * `opened` and `not_found` are facts about the object. Everything else the OS can
 * say - access denied because the object's DACL belongs to another principal, a
 * name that resolves to a different object kind, a child that printed something
 * unreadable - is `unclassified`, and `unclassified` is NEVER treated as absence:
 * a Job object that exists but cannot be opened still owns the player's world.
 *
 * `unmeasured` is a different fact from `unclassified`: the probe could not run at
 * all - its own measurement vehicle is unavailable, or the process it needs refuses
 * to start - so neither object was ever asked about. It exists because the two read
 * the same to a player and ask for different things: `unclassified`/`present` means
 * a previous attempt's Guardian objects are still owned by somebody, while
 * `unmeasured` means GameBuddy could not find out whether they are.
 */
export type StardewGuardianNamedObjectAnswer = "opened" | "not_found" | "unclassified" | "unmeasured";

export type StardewGuardianNamedObjectNames = Readonly<{ playerJobName: string; leaseName: string }>;

/**
 * The injected OS probe: one question about both objects, answered as the
 * classified per-object answers above. It throws only for a failure of the probe
 * itself, which the caller turns into `unclassified` like any other refusal.
 */
export type StardewGuardianNamedObjectProbe = (
  names: StardewGuardianNamedObjectNames,
) => Promise<Readonly<{ playerJob: StardewGuardianNamedObjectAnswer; lease: StardewGuardianNamedObjectAnswer }>>;

/**
 * The one presence verdict a reconcile may act on: `absent` releases the held
 * bootstrap pointer, every other verdict leaves it untouched.
 */
export type StardewGuardianObjectPresence = "absent" | "present" | "unverifiable" | "unmeasured";

export type StardewGuardianObjectPresenceVerdict = Readonly<{
  presence: StardewGuardianObjectPresence;
  playerJob: StardewGuardianNamedObjectAnswer;
  lease: StardewGuardianNamedObjectAnswer;
}>;

/**
 * Asks the injected probe about both objects and combines the two answers
 * conservatively.
 *
 * The combination is deliberately asymmetric: `absent` needs BOTH objects to be
 * gone, because the Guardian drops the lease and the player Job at different
 * moments and one absent object proves nothing about the other. `present` needs
 * both to be openable. `unmeasured` is the probe failing to run at all, and it
 * wins over every other pair because a probe that never ran cannot have seen one
 * object present and the other gone. Every other pair - one present and one
 * absent, or any `unclassified` - is `unverifiable`, which releases nothing.
 */
export async function probeStardewGuardianObjects(
  probe: StardewGuardianNamedObjectProbe,
  names: StardewGuardianNamedObjectNames,
): Promise<StardewGuardianObjectPresenceVerdict> {
  let answers: Readonly<{ playerJob: StardewGuardianNamedObjectAnswer; lease: StardewGuardianNamedObjectAnswer }>;
  try {
    answers = await probe(names);
  } catch {
    // A probe that could not answer says nothing about the objects. Reading that
    // as absence is the one mistake that would hand a live player world's
    // ownership away, so a thrown probe is `unmeasured` for both: a fact about the
    // probe, not a verdict about the objects.
    answers = { playerJob: "unmeasured", lease: "unmeasured" };
  }
  const playerJob = normalizeAnswer(answers?.playerJob);
  const lease = normalizeAnswer(answers?.lease);
  return Object.freeze({ presence: combinePresence(playerJob, lease), playerJob, lease });
}

function combinePresence(
  playerJob: StardewGuardianNamedObjectAnswer,
  lease: StardewGuardianNamedObjectAnswer,
): StardewGuardianObjectPresence {
  if (playerJob === "unmeasured" || lease === "unmeasured") return "unmeasured";
  if (playerJob === "not_found" && lease === "not_found") return "absent";
  if (playerJob === "opened" && lease === "opened") return "present";
  return "unverifiable";
}

/** Anything outside the declared answers is unreadable, which is not absence. */
function normalizeAnswer(answer: unknown): StardewGuardianNamedObjectAnswer {
  return answer === "opened" || answer === "not_found" || answer === "unmeasured" ? answer : "unclassified";
}
