/**
 * Cross-language launch parity: the Host's own arm/launch encoder output in front
 * of the real compiled native Guardian.
 *
 * The native live harness (`native/windows-bootstrap-guardian/guardian-live.test.mjs`)
 * drives the compiled Guardian with hand-built JSON: `armBinding()` and `plan()`
 * there are a copy of what the Host believes the native expects, so the native
 * PARSER is proven against hand-written bytes while the Host's ENCODERS —
 * `encodeArmAuthorization` and `encodeNativeRoleLaunchPlan` in
 * `./stardew-guardian-platform.ts` — are proven against nothing. This test closes
 * that gap by driving the composition's real launch path —
 * `createDesktopGuardianGameRuntimePlatform(...).arm(...)`/`.launch(...)`/`.contain(...)`,
 * which run those two production encoders — with the Desktop session replaced by a
 * thin stand-in that performs exactly the Desktop's own steps against the real
 * native child.
 *
 * No Host frame is re-implemented here: every byte the native parses comes out of a
 * production encoder, except the one explicitly-labelled ParseArm control body
 * documented at `parseArmControlBody` (the launch half cannot be reached without an
 * accepted arm, and the Host cannot emit one — see the FINDING below).
 *
 * Route 1 was used (the real factory is reachable from a TypeScript test). The
 * companion `.mjs` harness cannot host it: it is plain JavaScript, and the Host
 * modules it would need are TypeScript with a `.js`-specifier module graph, so a
 * `.mjs` file cannot import them.
 *
 * ---------------------------------------------------------------------------
 * FINDING (recorded so it is not re-discovered in a live run)
 * ---------------------------------------------------------------------------
 * The native REFUSES every arm body the Host can emit, so the launch half can never
 * be reached in a real run today. `GuardianPrivateLaunchIngress.ParseArm`
 * (`native/windows-bootstrap-guardian/GuardianPrivateLaunchIngress.cs:126`)
 * requires the exact key set
 *
 *   token, guardianInstanceId, guardianEpoch, attemptId, revision, leaseName,
 *   playerJobName, aiJobName, approvedExecutable      (nine keys, token injected)
 *
 * and the Host's arm encoder cannot produce it, for two independent reasons:
 *
 *   (1) THE FACT BAG IS THE LAUNCH FACTS. The production arm body is
 *       `{"executable":…,"cwd":…,"arguments":[…],"environment":{…},"approvedExecutable":…}`
 *       (test (a) quotes the exact bytes). Seven of the required keys are absent and
 *       four keys the parser does not know (`executable`, `cwd`, `arguments`,
 *       `environment`) are present. The bag
 *       is the game layer's typed launch facts
 *       (`games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts:2120`
 *       and `:2294`), because the contained runtime hands the SAME authorization to
 *       `platform.arm` and `platform.launch`
 *       (`containment/runtime/core/contained-game-runtime.ts:157`/`:163`).
 *
 *   (2) THE ENCODER'S OWN `executable` KEY IS NEVER ACCEPTED. Even with the right
 *       bag — the arm binding facts the composition already mints — the frame is
 *       still refused, because `encodeArmAuthorization` spreads the whole fact bag
 *       and appends `approvedExecutable` while `ParseArm` accepts
 *       `approvedExecutable` and no `executable` key at all. That single fact makes
 *       the frame one key too wide (`executable` is a launch-plan key), and
 *       ParseArm's `RequireExactKeys` is a count AND membership check. Test (b)
 *       isolates this to that one key: the encoder-shaped body is refused, and the
 *       byte-equal body with only `executable` removed is accepted and arms the
 *       native. No fact bag can avoid it: the encoder requires `facts.executable`
 *       in order to mint `approvedExecutable`, and spreads the bag it was given.
 *
 * In every refusal the native answers nothing on the private pipe, exits 1, and
 * writes `windows_bootstrap_guardian_invalid_request`.
 *
 * The facts the native wants already exist in the composition:
 * `readStardewBootstrapGuardianNativeArmFrame` mints `revision, leaseName,
 * playerJobName, aiJobName` and `consumeStardewBootstrapGuardianOwnerBinding`
 * returns them, but `stardew-guardian-platform.ts:421` reads only the correlation
 * triple out of that arm frame; the frame's other four fields have no production
 * reader, and its `bootstrapId` has no ParseArm reader either (the native takes the
 * attempt identity from the public command).
 *
 * Nothing was weakened or mutated to make the passing halves pass: the arm
 * assertions record the native's own refusals and say what must change. When the
 * arm body is fixed, they must be flipped to the acceptance the launch half and the
 * control body already observe.
 *
 * ---------------------------------------------------------------------------
 * What is replaced, and what stays unreachable
 * ---------------------------------------------------------------------------
 * Replaced by a stand-in: the whole Desktop half — `DesktopHostBootstrapBroker`
 * (the authenticated `hello`, the wire frame's ordinal key sequence, the base64url
 * `privateFrame` decode, the tokenless-arm-body check, the arm/launch/contain
 * transition table, the deadline bounds, the broker's acknowledgement key set) and
 * `GuardianSupervisorLease.RelayResidentAsync` + `GuardianPrivateIngress` (public
 * command to the native's stdin, private-pipe connect, `InjectArmToken` for
 * `arm_attempt` only, frame write, the private `accepted` read, the public-result
 * read). The stand-in mirrors those two relay steps; it is NOT the Desktop.
 *
 * Unreachable from this test, and therefore NOT covered:
 *   - the Host's `GuardianSessionClient` acknowledgement validation
 *     (`bootstrap/wire/desktop-runtime-bootstrap.internal.ts:582`) and
 *     `guardianCommandFrame`'s own key order (`:601`), which the stand-in mirrors
 *     rather than imports (both are module-private);
 *   - the `arm_attempt → launch_role → contain_role` transition table, the
 *     `MaximumDeadline` bound, and the pipe-client PID/session/SID checks of the
 *     real broker;
 *   - the admitted-Guardian image launch itself (`GuardianSupervisor`'s
 *     `STARTUPINFOEX` + job-list creation), so the native here runs directly under
 *     the test process tree rather than inside the Desktop supervisor's Job;
 *   - the native's resident-mode `GUARDIAN_TEST_HOOKS` barriers, which exist only in
 *     the test-variant executable this test does not use.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { DesktopGuardianSession, GuardianAck } from "../../containment/auth/desktop-guardian-session.internal.js";
import type { TypedPrivateGameFacts } from "../../containment/runtime/contract/game-runtime.js";
import { createDesktopGuardianGameRuntimePlatform } from "./stardew-guardian-platform.js";

const hostRoot = fileURLToPath(new URL("../../../", import.meta.url));
const guardianExecutable = resolve(hostRoot, "native", "windows-bootstrap-guardian", ".dist", "win-x64", "GameBuddy.WindowsBootstrapGuardian.exe");
const fixtureExecutable = resolve(hostRoot, "native", "windows-bootstrap-guardian", ".dist", "fixtures", "RoleRootFixture.exe");
const isWindows = process.platform === "win32";
const winOnly = { skip: !isWindows ? "BLOCKED: the native launch parity test needs Windows" : false };

/**
 * The exact arm key set `GuardianPrivateLaunchIngress.ParseArm` requires, quoted
 * from the C# parser. `token` is the relay's injected prefix; the remaining eight
 * keys are what a Host arm body must carry exactly.
 */
const PARSE_ARM_BODY_KEYS = [
  "approvedExecutable",
  "aiJobName",
  "attemptId",
  "guardianEpoch",
  "guardianInstanceId",
  "leaseName",
  "playerJobName",
  "revision",
] as const;

/** The keys the native wants besides `approvedExecutable`: absent from the production bag. */
const PARSE_ARM_BINDING_KEYS = PARSE_ARM_BODY_KEYS.filter((key) => key !== "approvedExecutable");

/**
 * What the Host encoder emits for a ParseArm-shaped bag: every ParseArm body key
 * plus the fact bag's own `executable`.
 */
const ENCODER_ARM_BODY_KEYS = [...PARSE_ARM_BODY_KEYS, "executable"].sort();

/** The exact key set `GuardianPrivateLaunchIngress.ParseLaunch` requires. */
const PARSE_LAUNCH_KEYS = [
  "arguments",
  "attemptId",
  "cwd",
  "deadlineUnixMs",
  "environment",
  "executable",
  "guardianEpoch",
  "guardianInstanceId",
  "planId",
  "role",
] as const;

const GUID_D = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GuardianSessionBinding = Readonly<{
  bootstrapId: string;
  generation: string;
  inventoryDigest: string;
  runtimeAdmissionSha256: string;
}>;

type Correlation = Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string }>;

/** The four session-binding fields every Desktop guardian frame carries. */
const wireBinding: GuardianSessionBinding = Object.freeze({
  bootstrapId: "a".repeat(64),
  generation: "generation-1",
  inventoryDigest: "b".repeat(64),
  runtimeAdmissionSha256: "c".repeat(64),
});

test("the compiled native Guardian refuses both arm bodies the Host can emit while the Host's launch bodies are admitted for both roles", { ...winOnly, timeout: 180_000 }, async (t) => {
  for (const executable of [guardianExecutable, fixtureExecutable]) {
    try {
      await access(executable);
    } catch {
      t.skip(`published Guardian/fixture is missing; run the Windows Guardian builder first: ${executable}`);
      return;
    }
  }

  const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-launch-parity-"));
  const natives: NativeResidentGuardian[] = [];
  const openNative = (): NativeResidentGuardian => {
    const native = new NativeResidentGuardian();
    natives.push(native);
    return native;
  };
  try {
    // The production role environment: the exact seven-key allowlist both the Host
    // encoder and the native's `IsAllowedEnvironment` carry.
    const environment = Object.freeze({
      PATH: process.env.PATH ?? "C:\\Windows\\System32",
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      WINDIR: process.env.WINDIR ?? "C:\\Windows",
      TEMP: process.env.TEMP ?? "C:\\Windows\\Temp",
      TMP: process.env.TMP ?? "C:\\Windows\\Temp",
      USERPROFILE: process.env.USERPROFILE ?? "C:\\Users\\Default",
      GAMEBUDDY_STARDEW_LAUNCH_GENERATION: "launch-parity-generation",
    });
    // The typed facts the game layer hands the contained runtime
    // (`stardew-private-bootstrap-composer.core.ts:2120`/`:2294`). The SAME object
    // reaches `platform.arm`, which is why the arm half below sends it there too.
    const productionFacts = (label: string): TypedPrivateGameFacts => Object.freeze({
      executable: fixtureExecutable,
      cwd: root,
      arguments: Object.freeze(["--signal", resolve(root, `${label}.report`), "--exit-after-report"]),
      environment,
    });

    // ---------------------------------------------------------------------
    // (a) the production arm body, exactly as the live path emits it.
    // ---------------------------------------------------------------------
    const productionBinding: Correlation = Object.freeze({ guardianInstanceId: randomUUID(), guardianEpoch: 1, attemptId: randomUUID() });
    const production = hostPlatformFor(openNative(), productionBinding);
    const productionRejection = await rejectionOf(() => production.platform.arm({
      ...productionBinding,
      operationWaitBudgetMs: 60_000,
      authorization: productionFacts("player"),
    }));
    const productionArmBody = production.standIn.hostArmBody;
    assert.ok(productionArmBody !== undefined, "(a) the Host's arm encoder must have produced a body");
    t.diagnostic(`(a) Host-encoded arm body: ${textOf(productionArmBody)}`);
    t.diagnostic(`(a) native private answer: ${quoted(production.standIn.privateAnswer(0))}; public result: ${quoted(production.standIn.publicResults[0])}`);
    assert.notEqual(productionRejection, undefined, "(a) the relay must report the native's refusal instead of accepting the arm");
    assert.equal(
      production.standIn.privateAnswer(0),
      undefined,
      `(a) THE FINDING: the native answered ${quoted(production.standIn.privateAnswer(0))} for the Host-encoded arm body, so the live arm is not admitted`,
    );
    assert.equal(production.standIn.publicResults[0], undefined, "(a) the native must never report its armed result for an arm body it refused");
    assert.equal(production.standIn.acknowledgementCount(), 0, "(a) the stand-in must not have produced a broker acknowledgement for a refused arm");
    assert.equal(await production.native.waitForExit(10_000), true, "(a) the native did not fail closed on the Host-encoded arm body");
    assert.equal(production.native.exitCode, 1, `(a) the native exited ${String(production.native.exitCode)} instead of its fail-closed status`);
    assert.equal(production.native.stderr, "windows_bootstrap_guardian_invalid_request\n", "(a) the native's fail-closed diagnostic is the observation that it refused the Host's arm body");
    const productionArmKeys = Object.keys(JSON.parse(textOf(productionArmBody)) as Record<string, unknown>).sort();
    assert.deepEqual(
      productionArmKeys,
      ["approvedExecutable", "arguments", "cwd", "environment", "executable"],
      "(a) the production arm body is exactly the fact bag the contained runtime passes (`contained-game-runtime.ts:157`) plus the approved executable",
    );
    assert.equal(productionArmKeys.includes("approvedExecutable"), true, "(a) the encoder's own approved executable key IS present, so the refusal is about the key set, not about the executable rule");
    for (const key of PARSE_ARM_BINDING_KEYS) {
      assert.equal(
        productionArmKeys.includes(key),
        false,
        `(a) the divergence's shape (1): the production arm body carries no ${key}, which ParseArm requires`,
      );
    }

    // ---------------------------------------------------------------------
    // (b) divergence (2): with the fact bag corrected, the encoder's own
    // `executable` mirror key still makes the frame one key too wide. Isolated to
    // that single key.
    // ---------------------------------------------------------------------
    const encoderBinding: Correlation = Object.freeze({ guardianInstanceId: randomUUID(), guardianEpoch: 1, attemptId: randomUUID() });
    const encoded = hostPlatformFor(openNative(), encoderBinding);
    const encodedRejection = await rejectionOf(() => encoded.platform.arm({
      ...encoderBinding,
      operationWaitBudgetMs: 60_000,
      authorization: armFrameShapedFacts(encoderBinding),
    }));
    const encodedArmBody = encoded.standIn.hostArmBody;
    assert.ok(encodedArmBody !== undefined, "(b) the Host's arm encoder must have produced a body");
    t.diagnostic(`(b) encoder arm body for a ParseArm-shaped bag: ${textOf(encodedArmBody)}`);
    t.diagnostic(`(b) native private answer: ${quoted(encoded.standIn.privateAnswer(0))}; public result: ${quoted(encoded.standIn.publicResults[0])}`);
    assert.notEqual(encodedRejection, undefined, "(b) the relay must report the native's refusal of this body too");
    assert.equal(
      encoded.standIn.privateAnswer(0),
      undefined,
      `(b) THE FINDING: the native answered ${quoted(encoded.standIn.privateAnswer(0))} even for the arm binding facts it requires, because the encoder appends its own executable key next to the approved executable`,
    );
    assert.equal(await encoded.native.waitForExit(10_000), true, "(b) the native did not fail closed on the encoder-shaped arm body");
    assert.equal(encoded.native.exitCode, 1, `(b) the native exited ${String(encoded.native.exitCode)} instead of its fail-closed status`);
    assert.equal(encoded.native.stderr, "windows_bootstrap_guardian_invalid_request\n", "(b) the native's fail-closed diagnostic for the encoder-shaped arm body");
    const encodedArmKeys = Object.keys(JSON.parse(textOf(encodedArmBody)) as Record<string, unknown>).sort();
    assert.deepEqual(encodedArmKeys, ENCODER_ARM_BODY_KEYS, "(b) the encoder-shaped body carries every ParseArm body key plus its own executable fact");
    for (const key of PARSE_ARM_BODY_KEYS) {
      assert.equal(encodedArmKeys.includes(key), true, `(b) with the arm frame's facts the body does carry ${key}: the remaining divergence is the extra key, not a missing one`);
    }
    // The one-key isolation: the SAME bytes with only `executable` removed are
    // accepted, so that single key is the whole of divergence (2).
    const isolationNative = openNative();
    isolationNative.writePublicCommand("arm_attempt", correlationOf(encodedArmBody));
    await isolationNative.connectPrivate();
    assert.equal(
      await isolationNative.sendArm(withoutKey(encodedArmBody, "executable")),
      "accepted",
      "(b) the byte-equal body minus only the executable key must be accepted: ParseArm's exact-key check is a count and a membership check, and both are satisfied once that key is gone",
    );
    assert.equal(await isolationNative.nextPublicResult(), "armed", "(b) the isolated body must arm the native");
    assert.equal(isolationNative.stderr, "", `(b) the native reported a diagnostic for the isolated body: ${isolationNative.stderr}`);
    t.diagnostic("(b) isolation: same bytes minus the executable key -> accepted/armed; with it -> refused");
    await isolationNative.destroy();

    // ---------------------------------------------------------------------
    // (c) the launch half. The Host's launch bodies cannot be reached without an
    // accepted arm and the Host cannot emit one ((a)+(b)), so the relay arms with
    // the labelled control body: the exact ParseArm key set, whose fields are the
    // composition's own arm frame less its bootstrapId (no ParseArm reader) plus the
    // approved executable. Everything after the arm is the Host's own encoder
    // output.
    // ---------------------------------------------------------------------
    const controlBinding: Correlation = Object.freeze({ guardianInstanceId: randomUUID(), guardianEpoch: 1, attemptId: randomUUID() });
    const control = hostPlatformFor(openNative(), controlBinding);
    control.standIn.controlArmBody = parseArmControlBody(controlBinding);
    await control.platform.arm({ ...controlBinding, operationWaitBudgetMs: 60_000, authorization: productionFacts("player") });
    const controlArmBody = control.standIn.controlArmBody;
    const controlEncodedArmBody = control.standIn.hostArmBody;
    assert.ok(controlArmBody !== undefined, "(c) the labelled control body must exist");
    assert.ok(controlEncodedArmBody !== undefined, "(c) the Host's arm encoder must have produced a body");
    t.diagnostic(`(c) relayed control arm body: ${textOf(controlArmBody)}`);
    t.diagnostic(`(c) the Host encoder's own arm body for this run: ${textOf(controlEncodedArmBody)}`);
    assert.equal(control.standIn.armBodyWasTokenless, true, "(c) the Host's arm body must be tokenless: the supervisor owns the private token, and the token path is what the relay mirrors here");
    assert.equal(
      control.standIn.privateAnswer(0),
      "accepted",
      `(c) the native answered ${quoted(control.standIn.privateAnswer(0))} for the relayed control arm body`,
    );
    assert.equal(control.standIn.publicResults[0], "armed", "(c) the native must report its armed result for the control arm body");
    assert.equal(
      textOf(controlEncodedArmBody).includes('"cwd"'),
      true,
      "(c) the acceptance above belongs to the control body, NOT to the Host encoder's output, which is the production bag refused in (a)",
    );

    const launchBodies: Array<Readonly<{ role: string; frame: Uint8Array }>> = [];
    for (const role of ["player_host", "ai_client"] as const) {
      const label = role === "player_host" ? "player" : "ai";
      await control.platform.launch({
        ...controlBinding,
        deadlineUnixMs: Date.now() + 60_000,
        role,
        authorization: productionFacts(label),
      });
      const body = control.standIn.hostLaunchBodies.at(-1);
      assert.ok(body !== undefined, `(c) the Host's launch encoder must have produced the ${role} frame`);
      launchBodies.push(Object.freeze({ role, frame: body }));
      t.diagnostic(`(c) ${role} Host-encoded launch body: ${textOf(body)}`);
      const decoded = JSON.parse(textOf(body)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(decoded).sort(), [...PARSE_LAUNCH_KEYS], `(c) the ${role} launch frame must be exactly the ten ParseLaunch keys`);
      assert.match(String(decoded.planId), GUID_D, `(c) the ${role} launch frame must carry a GUID D planId`);
      assert.equal(decoded.guardianInstanceId, controlBinding.guardianInstanceId, `(c) the ${role} launch frame must carry the Host's own correlation`);
      assert.equal(decoded.role, role, `(c) the ${role} launch frame must carry the role the Host launched`);
      assert.equal(decoded.executable, fixtureExecutable, `(c) the ${role} launch frame must carry the armed approved executable`);
      assert.deepEqual(Object.keys(decoded.environment as Record<string, unknown>).sort(), Object.keys(environment).sort(), `(c) the ${role} launch frame must carry the exact seven-key role environment`);
      assert.equal(
        control.standIn.nativeAnswers.at(-1),
        "accepted",
        `(c) the native answered ${quoted(control.standIn.nativeAnswers.at(-1))} for the Host-encoded ${role} plan`,
      );
      assert.equal(
        control.standIn.publicResults.at(-1),
        "role_active",
        `(c) the native must admit the Host-encoded ${role} plan and answer role_active; a rejected plan is not a pass`,
      );
      // The plan was admitted, not merely parsed: the role was created inside its
      // Job and resumed, which the fixture reports as its first user code.
      const report = resolve(root, `${label}.report`);
      await waitForFile(report);
      assert.equal(await readFile(report, "utf8"), "member=true\n", `(c) the ${role} role must have run its first user code inside its Job`);
    }
    // The roles are contained through the platform's own relay, so this test leaves
    // no fixture behind and covers the third command the stand-in serves.
    for (const role of ["player_host", "ai_client"] as const) {
      await control.platform.contain({ ...controlBinding, operationWaitBudgetMs: 60_000, role });
    }
    assert.equal(control.standIn.publicResults.at(-2), "role_contained", "(c) the player containment must be the native's own role_contained result");
    assert.equal(control.standIn.publicResults.at(-1), "role_contained", "(c) the AI containment must be the native's own role_contained result");

    // ---------------------------------------------------------------------
    // (d) the falsification: one extra key, or one field mutated, is REFUSED. This
    // is what proves the parity assertions above are not vacuous.
    // ---------------------------------------------------------------------
    // (d1) the arm body. Every probe mints a FRESH control body: the native creates
    // the exact lease/Job names the body carries, so reusing one body across two
    // live natives would collide on those named objects and confound the refusal
    // with a name collision instead of the tampering.
    const armControlBody = parseArmControlBody(Object.freeze({ guardianInstanceId: randomUUID(), guardianEpoch: 1, attemptId: randomUUID() }));
    const armControlNative = openNative();
    armControlNative.writePublicCommand("arm_attempt", correlationOf(armControlBody));
    await armControlNative.connectPrivate();
    assert.equal(await armControlNative.sendArm(armControlBody), "accepted", "(d1 control) the untampered control body must be accepted by a fresh native");
    const armControlResult = await withTimeout(armControlNative.nextPublicResult(), 5_000);
    assert.equal(
      armControlResult,
      "armed",
      `(d1 control) the untampered control body must arm a fresh native; it answered ${quoted(armControlResult)} (exit ${String(armControlNative.exitCode)}, stderr ${JSON.stringify(armControlNative.stderr)})`,
    );
    await armControlNative.destroy();
    for (const mutation of [
      { label: "one extra key", apply: (frame: Uint8Array) => withExtraKey(frame) },
      { label: "a mutated revision", apply: (frame: Uint8Array) => withReplacedString(frame, "revision", "not-a-guid") },
    ]) {
      const body = mutation.apply(parseArmControlBody(Object.freeze({ guardianInstanceId: randomUUID(), guardianEpoch: 1, attemptId: randomUUID() })));
      const native = openNative();
      native.writePublicCommand("arm_attempt", correlationOf(body));
      await native.connectPrivate();
      native.writePrivate(injectArmToken(body, native.token));
      const answer = await withTimeout(native.nextPrivateLine(), 5_000);
      assert.equal(answer, undefined, `(d1) an arm body with ${mutation.label} was answered ${quoted(answer)} instead of being refused`);
      assert.equal(await native.waitForExit(10_000), true, `(d1) the native did not fail closed on an arm body with ${mutation.label}`);
      assert.equal(native.exitCode, 1, `(d1) the native exited ${String(native.exitCode)} for an arm body with ${mutation.label}`);
      assert.equal(native.stderr, "windows_bootstrap_guardian_invalid_request\n", `(d1) the native's own refusal of an arm body with ${mutation.label}`);
      t.diagnostic(`(d1) arm body with ${mutation.label} -> refused: ${native.stderr.trim()}`);
      await native.destroy();
    }

    // (d2) the launch plan. Each probe gets a freshly armed native whose correlation
    // and approved executable come from the captured Host frame, so the refusal can
    // only be the tampering: the untampered frame is proven acceptable first, and
    // every native owns its own consumed-plan set, so an identical planId is not a
    // replay.
    const capturedLaunchBody = launchBodies[0]!.frame;
    const launchProbes = [
      { label: "the untampered frame", frame: capturedLaunchBody, refused: false },
      { label: "one extra key", frame: withExtraKey(capturedLaunchBody), refused: true },
      { label: "a mutated planId", frame: withReplacedString(capturedLaunchBody, "planId", "not-a-guid"), refused: true },
    ] as const;
    for (const probe of launchProbes) {
      const native = openNative();
      const correlation = correlationOf(capturedLaunchBody);
      const armed = hostPlatformFor(native, correlation);
      armed.standIn.controlArmBody = parseArmControlBody(correlation);
      try {
        await armed.platform.arm({ ...correlation, operationWaitBudgetMs: 60_000, authorization: productionFacts("player") });
        assert.equal(armed.standIn.publicResults[0], "armed", `(d2) the native must be armed before the ${probe.label} probe`);
        // Written straight to the native pipe: the platform's encoder would never
        // emit a tampered frame, so this is the direct native probe the recovery
        // parity test also uses for its falsification.
        native.writePublicCommand("launch_role", { ...correlation, role: "player_host" });
        native.writePrivate(probe.frame);
        const answer = await withTimeout(native.nextPrivateLine(), 5_000);
        if (!probe.refused) {
          assert.equal(answer, "accepted", `(d2 control) the untampered Host-encoded launch frame must be accepted by a fresh armed native; it answered ${quoted(answer)}`);
          assert.equal(await native.nextPublicResult(), "role_active", "(d2 control) the untampered Host-encoded launch frame must admit its plan");
          continue;
        }
        assert.equal(answer, undefined, `(d2) a launch frame with ${probe.label} was answered ${quoted(answer)} instead of being refused`);
        assert.equal(await native.waitForExit(10_000), true, `(d2) the native did not fail closed on a launch frame with ${probe.label}`);
        assert.equal(native.exitCode, 1, `(d2) the native exited ${String(native.exitCode)} for a launch frame with ${probe.label}`);
        assert.equal(native.stderr, "windows_bootstrap_guardian_invalid_request\n", `(d2) the native's own refusal of a launch frame with ${probe.label}`);
        t.diagnostic(`(d2) launch frame with ${probe.label} -> refused: ${native.stderr.trim()}`);
      } finally {
        await native.destroy();
      }
    }
  } finally {
    for (const native of natives) await native.destroy();
    await removeRoot(root);
    await killLeftoverFixtureProcesses();
  }
});

/**
 * The Host's launch-path operations bound to one real native child.
 *
 * The native child is created but not yet spoken to: the first public command is
 * the one the relay writes, exactly as the Desktop orders it.
 */
function hostPlatformFor(native: NativeResidentGuardian, correlation: Correlation): Readonly<{
  standIn: DesktopSupervisorStandIn;
  native: NativeResidentGuardian;
  platform: ReturnType<typeof createDesktopGuardianGameRuntimePlatform>;
}> {
  const standIn = new DesktopSupervisorStandIn(native, wireBinding, Object.freeze({ ...correlation }));
  return Object.freeze({ standIn, native, platform: createDesktopGuardianGameRuntimePlatform(standIn) });
}

/**
 * The bag (b) uses: the arm binding facts the composition already mints
 * (`readStardewBootstrapGuardianNativeArmFrame`'s fields, less its `bootstrapId`,
 * which has no ParseArm reader) plus the installation executable the encoder needs
 * in order to mint `approvedExecutable`.
 *
 * Not taken from a live owner record: the field names and shapes mirror that
 * contract rather than projecting one. This bag is what makes divergence (2)
 * visible — the encoder turns it into one key ParseArm does not accept.
 */
function armFrameShapedFacts(correlation: Correlation): TypedPrivateGameFacts {
  return Object.freeze({
    ...armBindingFacts(correlation),
    executable: fixtureExecutable,
  });
}

/**
 * The labelled control arm body: the exact eight-key ParseArm set, whose fields are
 * the same arm binding facts, plus the approved executable. It is built here, not
 * by the Host encoder, because the Host cannot emit a ParseArm body at all
 * (findings (a) and (b)); it exists so the launch half — which IS the Host's own
 * encoder output — can be observed. The relay's token prefix is added by
 * `injectArmToken`, exactly as the supervisor adds it.
 */
function parseArmControlBody(correlation: Correlation): Uint8Array {
  return Buffer.from(JSON.stringify({
    ...armBindingFacts(correlation),
    approvedExecutable: fixtureExecutable,
  }), "utf8");
}

/** The arm-frame facts the native's ParseArm wants and the launch facts do not carry. */
function armBindingFacts(correlation: Correlation): Readonly<{
  guardianInstanceId: string;
  guardianEpoch: number;
  attemptId: string;
  revision: string;
  leaseName: string;
  playerJobName: string;
  aiJobName: string;
}> {
  return Object.freeze({
    ...correlation,
    revision: randomUUID(),
    leaseName: `Local\\LaunchParity-Lease-${randomUUID()}`,
    playerJobName: `Local\\LaunchParity-Player-${randomUUID()}`,
    aiJobName: `Local\\LaunchParity-Ai-${randomUUID()}`,
  });
}

/**
 * The Desktop half's thin stand-in: the broker's wire decode plus the supervisor's
 * relay, and nothing else.
 *
 * It performs only the steps `DesktopHostBootstrapBroker.TryParseCommand`
 * (@ :235-261) and `GuardianSupervisorLease.RelayResidentAsync` (@ :217-259) /
 * `GuardianPrivateIngress` (@ :342-369) perform: build the wire command frame in the
 * broker's ordinal key order with a base64url `privateFrame`, decode it back with
 * the broker's own rules (including the tokenless arm-body check), write the public
 * command to the native's stdin, connect to the private pipe, inject the arm token
 * into the Host's arm body (arm only — a launch plan is written verbatim), write the
 * frame, read the native's private answer, then read the native's public result and
 * require the exact expected one. It builds no Host frame. What it deliberately does
 * not do is listed in this file's header.
 */
class DesktopSupervisorStandIn implements DesktopGuardianSession {
  /** The native's own private-pipe answers, in order; `undefined` is "refused, pipe closed". */
  public readonly nativeAnswers: Array<string | undefined> = [];
  /** The native's own public results, in order; `undefined` is "no result was written". */
  public readonly publicResults: Array<string | undefined> = [];
  /** The exact arm bytes the Host's own encoder handed this session. */
  public hostArmBody: Uint8Array | undefined;
  /** The exact launch bytes the Host's own encoder handed this session, in order. */
  public readonly hostLaunchBodies: Uint8Array[] = [];
  /** The broker's own arm-body rule: the Host's body must not carry a token. */
  public armBodyWasTokenless = false;
  /** Set only by the labelled ParseArm control documented on `parseArmControlBody`. */
  public controlArmBody: Uint8Array | undefined;
  /** The acknowledgements this stand-in wrote back to the Host, in order. */
  public readonly acknowledgements: GuardianAck[] = [];

  public constructor(
    private readonly native: NativeResidentGuardian,
    public readonly binding: GuardianSessionBinding,
    public readonly correlation: Correlation,
  ) {}

  public acknowledgementCount(): number { return this.acknowledgements.length; }

  public privateAnswer(index: number): string | undefined { return this.nativeAnswers[index]; }

  public async arm(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; operationWaitBudgetMs: number; privateFrame: Uint8Array }>): Promise<GuardianAck> {
    // The wire hop: the broker receives the private bytes as an unpadded base64url
    // string and decodes them back with `TryDecodeFrame` (@ :446-453).
    const wireFrame = this.commandFrame("arm_attempt", input, { operationWaitBudgetMs: input.operationWaitBudgetMs, privateFrame: input.privateFrame });
    const body = decodePrivateFrame(wireFrame.privateFrame as string);
    this.hostArmBody = body;
    this.armBodyWasTokenless = isTokenlessArmBody(body);
    assert.equal(this.armBodyWasTokenless, true, "the broker refuses an arm body that carries a token of its own");
    // The supervisor's relay. The native creates its private pipe only after the
    // public command arrives, and `RelayResidentAsync` writes the public command
    // first, so this stand-in does too.
    this.native.writePublicCommand("arm_attempt", this.correlation);
    await this.native.connectPrivate();
    const relayedBody = this.controlArmBody ?? body;
    this.native.writePrivate(injectArmToken(relayedBody, this.native.token));
    const answer = await this.native.nextPrivateLine();
    this.nativeAnswers.push(answer);
    if (answer !== "accepted") throw new Error(`the native did not accept the relayed arm body: ${answer ?? "the native closed the private pipe"}`);
    const result = await this.native.nextPublicResult();
    this.publicResults.push(result);
    if (result !== "armed") throw new Error(`the native answered ${result ?? "nothing"} instead of its armed result`);
    return this.acknowledge("arm_attempt", "armed");
  }

  public async launch(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; role: string; privateFrame: Uint8Array }>): Promise<GuardianAck> {
    const wireFrame = this.commandFrame("launch_role", input, { deadlineUnixMs: input.deadlineUnixMs, role: input.role, privateFrame: input.privateFrame });
    // A launch plan is relayed verbatim: only the arm body gets a token injected
    // (`RelayResidentAsync` @ :233-235).
    const body = decodePrivateFrame(wireFrame.privateFrame as string);
    this.hostLaunchBodies.push(body);
    this.native.writePublicCommand("launch_role", { ...this.correlation, role: input.role });
    this.native.writePrivate(body);
    const answer = await this.native.nextPrivateLine();
    this.nativeAnswers.push(answer);
    if (answer !== "accepted") throw new Error(`the native did not accept the Host-encoded launch plan: ${answer ?? "the native closed the private pipe"}`);
    const result = await this.native.nextPublicResult();
    this.publicResults.push(result);
    if (result !== "role_active") throw new Error(`the native answered ${result ?? "nothing"} instead of its role_active result`);
    return this.acknowledge("launch_role", "role_active", input.role);
  }

  public async contain(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; operationWaitBudgetMs: number; role: string }>): Promise<GuardianAck> {
    this.commandFrame("contain_role", input, { operationWaitBudgetMs: input.operationWaitBudgetMs, role: input.role });
    this.native.writePublicCommand("contain_role", { ...this.correlation, role: input.role });
    const result = await this.native.nextPublicResult();
    this.publicResults.push(result);
    if (result !== "role_contained") throw new Error(`the native answered ${result ?? "nothing"} instead of its role_contained result`);
    return this.acknowledge("contain_role", "role_contained", input.role);
  }

  public async recover(): Promise<never> { throw new Error("the launch parity test never drives a recovery"); }

  public async close(): Promise<void> {}

  /**
   * The broker's command frame: the exact ordinal key sequence
   * `TryParseCommand`'s `ExactObject` compares (@ :242-244), with the private bytes
   * as an unpadded base64url string as the wire's `guardianCommandFrame` writes them.
   * The key order is part of the relay's contract and is mirrored, not invented: the
   * bounded wait (or the launch deadline) precedes the correlation, and the role
   * precedes the private frame.
   */
  private commandFrame(operation: string, input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string }>, extra: Readonly<{ operationWaitBudgetMs?: number; deadlineUnixMs?: number; role?: string; privateFrame?: Uint8Array }>): Record<string, unknown> {
    return Object.freeze({
      schema: "gamebuddy-desktop-guardian-session/v1",
      protocolVersion: 1,
      operation,
      ...this.binding,
      ...(extra.deadlineUnixMs === undefined ? { operationWaitBudgetMs: extra.operationWaitBudgetMs } : { deadlineUnixMs: extra.deadlineUnixMs }),
      guardianInstanceId: input.guardianInstanceId,
      guardianEpoch: input.guardianEpoch,
      attemptId: input.attemptId,
      ...(extra.role === undefined ? {} : { role: extra.role }),
      ...(extra.privateFrame === undefined ? {} : { privateFrame: Buffer.from(extra.privateFrame).toString("base64url") }),
    });
  }

  /** The exact acknowledgement key set `WriteAcknowledgementAsync` writes (@ :283-291). */
  private acknowledge(operation: string, status: string, role?: string): GuardianAck {
    const acknowledgement = Object.freeze({
      schema: "gamebuddy-desktop-guardian-session/v1",
      protocolVersion: 1,
      operation,
      status,
      ...this.binding,
      guardianInstanceId: this.correlation.guardianInstanceId,
      guardianEpoch: this.correlation.guardianEpoch,
      attemptId: this.correlation.attemptId,
      ...(role === undefined ? {} : { role }),
    }) as unknown as GuardianAck;
    this.acknowledgements.push(acknowledgement);
    return acknowledgement;
  }
}

/** One real resident-mode native child, its public control streams and its private pipe. */
class NativeResidentGuardian {
  public readonly token = randomUUID();
  public readonly pipeName = `GameBuddyLaunchParity-${randomUUID()}`;
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly publicResults: string[] = [];
  private readonly publicWaiters: Array<(line: string | undefined) => void> = [];
  private readonly privateLines: string[] = [];
  private readonly privateWaiters: Array<(line: string | undefined) => void> = [];
  private socket: net.Socket | undefined;
  private privateBuffered = "";
  private privateEnded = false;
  private stderrText = "";

  public constructor() {
    this.child = spawn(guardianExecutable, [], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GAMEBUDDY_GUARDIAN_MODE: "resident",
        GAMEBUDDY_GUARDIAN_CONTROL_PIPE: this.pipeName,
        GAMEBUDDY_GUARDIAN_CONTROL_TOKEN: this.token,
      },
    });
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderrText += chunk.toString("utf8"); });
    readLines(
      this.child.stdout,
      (line) => {
        // The public answer is the native's own `{"schemaVersion":1,"result":"…"}`.
        let result: string | undefined;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          result = typeof parsed.result === "string" ? parsed.result : undefined;
        } catch { result = undefined; }
        this.deliverPublic(result ?? line);
      },
      () => { this.deliverPublic(undefined); },
    );
  }

  public get stderr(): string { return this.stderrText; }
  public get exitCode(): number | null { return this.child.exitCode; }

  /** The native's public control pipe is the child's stdin, built as `GuardianRelayCommand.ToNativeFrame` does (@ GuardianSupervisor.cs:396-400). */
  public writePublicCommand(operation: string, input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; role?: string }>): void {
    const role = input.role === undefined ? "" : `,"role":"${input.role}"`;
    this.child.stdin.write(`{"schemaVersion":1,"operation":"${operation}","guardianInstanceId":"${input.guardianInstanceId}","guardianEpoch":${input.guardianEpoch},"attemptId":"${input.attemptId}"${role}}\n`);
  }

  /**
   * The private ingress pipe. The native creates its single pipe instance inside
   * `ReceiveArmAsync`, so a client connects only after the public arm command; the
   * Desktop's own `GuardianPrivateIngress.ConnectAsync` retries the same way.
   */
  public async connectPrivate(): Promise<void> {
    if (this.socket !== undefined) return;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (this.child.exitCode !== null) throw new Error(`the native Guardian exited before its private launch pipe: ${this.stderrText}`);
      const socket = net.createConnection({ path: `\\\\.\\pipe\\${this.pipeName}` });
      const connected = await new Promise<boolean>((resolveConnect) => {
        socket.once("connect", () => resolveConnect(true));
        socket.once("error", () => resolveConnect(false));
      });
      if (connected) {
        this.socket = socket;
        socket.on("data", (chunk: Buffer) => { this.receivePrivate(chunk.toString("utf8")); });
        socket.on("close", () => { this.endPrivate(); });
        socket.on("error", () => { this.endPrivate(); });
        return;
      }
      socket.destroy();
      await delay(25);
    }
    throw new Error("the native Guardian private launch pipe was never connectable");
  }

  /** The relay writes the frame, then the LF that terminates it. */
  public writePrivate(frame: Uint8Array): void {
    const socket = this.socket;
    if (socket === undefined) throw new Error("the native Guardian private launch pipe is not connected");
    socket.write(Buffer.concat([Buffer.from(frame), Buffer.from("\n", "utf8")]));
  }

  /** One arm exchange against a native already sent its public arm command. */
  public async sendArm(body: Uint8Array): Promise<string | undefined> {
    this.writePrivate(injectArmToken(body, this.token));
    return await this.nextPrivateLine();
  }

  public nextPrivateLine(): Promise<string | undefined> {
    const line = this.privateLines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.privateEnded) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolveLine) => { this.privateWaiters.push(resolveLine); });
  }

  public nextPublicResult(): Promise<string | undefined> {
    const result = this.publicResults.shift();
    if (result !== undefined) return Promise.resolve(result);
    return new Promise<string | undefined>((resolveResult) => { this.publicWaiters.push(resolveResult); });
  }

  public async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null) return true;
    return await new Promise<boolean>((resolveExit) => {
      const timer = setTimeout(() => { resolveExit(false); }, timeoutMs);
      this.child.once("exit", () => { clearTimeout(timer); resolveExit(true); });
    });
  }

  public async destroy(): Promise<void> {
    this.socket?.destroy();
    if (this.child.exitCode === null) this.child.kill();
    await this.waitForExit(5_000);
  }

  private deliverPublic(line: string | undefined): void {
    const waiter = this.publicWaiters.shift();
    if (waiter !== undefined) { waiter(line); return; }
    if (line !== undefined) this.publicResults.push(line);
  }

  private receivePrivate(text: string): void {
    this.privateBuffered += text;
    for (;;) {
      const index = this.privateBuffered.indexOf("\n");
      if (index < 0) break;
      const line = this.privateBuffered.slice(0, index);
      this.privateBuffered = this.privateBuffered.slice(index + 1);
      const waiter = this.privateWaiters.shift();
      if (waiter === undefined) this.privateLines.push(line);
      else waiter(line);
    }
  }

  private endPrivate(): void {
    if (this.privateEnded) return;
    this.privateEnded = true;
    while (this.privateWaiters.length > 0) this.privateWaiters.shift()?.(undefined);
  }
}

/**
 * `GuardianPrivateIngress.InjectToken` (@ GuardianSupervisor.cs:362-367): one
 * tokenless `{...}` body becomes `{"token":"...",...}`. The supervisor refuses a
 * body that already carries a token, a newline or a NUL, which is what keeps the
 * Host's own encoder from inventing one.
 */
function injectArmToken(body: Uint8Array, token: string): Buffer {
  const text = textOf(body);
  if (body.length < 2 || !text.startsWith("{") || !text.endsWith("}") || text.includes("\n") || text.includes("\r") || text.includes("\u0000") || text.includes('"token"')) {
    throw new Error("the supervisor stand-in refuses a body that is not a tokenless JSON object");
  }
  return Buffer.from(`{"token":"${token}",${text.slice(1)}`, "utf8");
}

/** The broker's `ValidTokenlessArmBody` (@ :454). */
function isTokenlessArmBody(body: Uint8Array): boolean {
  const text = textOf(body);
  return body.length > 2 && text.startsWith("{") && text.endsWith("}") && !text.includes('"token"');
}

/** The broker's `TryDecodeFrame` (@ :446-453) for the unpadded base64url the wire writes. */
function decodePrivateFrame(encoded: string): Uint8Array {
  assert.ok(typeof encoded === "string" && encoded.length > 0 && !encoded.includes("="), "the wire's privateFrame must be an unpadded base64url string");
  return new Uint8Array(Buffer.from(encoded, "base64url"));
}

/** The correlation a Host-encoded body carries, so a probe can reuse it exactly. */
function correlationOf(body: Uint8Array): Correlation {
  const parsed = JSON.parse(textOf(body)) as Record<string, unknown>;
  const { guardianInstanceId, guardianEpoch, attemptId } = parsed;
  if (typeof guardianInstanceId !== "string" || typeof guardianEpoch !== "number" || typeof attemptId !== "string") {
    throw new Error("the Host-encoded body carries no correlation");
  }
  return Object.freeze({ guardianInstanceId, guardianEpoch, attemptId });
}

/** The falsification's first mutation: valid JSON, one key the native does not accept. */
function withExtraKey(frame: Uint8Array): Uint8Array {
  const text = textOf(frame);
  if (!text.startsWith("{")) throw new Error("expected the Host encoder's JSON object frame");
  return Buffer.from(`{"unexpected":"1",${text.slice(1)}`, "utf8");
}

/**
 * The falsification's second mutation: one field of the Host's own frame replaced,
 * re-serialized so nothing else changes.
 */
function withReplacedString(frame: Uint8Array, key: string, value: string): Uint8Array {
  const parsed = JSON.parse(textOf(frame)) as Record<string, unknown>;
  if (!Object.hasOwn(parsed, key)) throw new Error(`the Host encoder's frame has no ${key}`);
  parsed[key] = value;
  return Buffer.from(JSON.stringify(parsed), "utf8");
}

/** The one-key isolation's mutation: remove exactly one key from a Host-encoded body. */
function withoutKey(frame: Uint8Array, key: string): Uint8Array {
  const parsed = JSON.parse(textOf(frame)) as Record<string, unknown>;
  if (!Object.hasOwn(parsed, key)) throw new Error(`the Host encoder's frame has no ${key}`);
  delete parsed[key];
  return Buffer.from(JSON.stringify(parsed), "utf8");
}

/** Reads LF-delimited lines from one stream and reports the terminal disconnect. */
function readLines(stream: Readable, onLine: (line: string) => void, onEnd: () => void): void {
  let buffered = "";
  stream.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      onLine(line);
    }
  });
  stream.once("end", onEnd);
  stream.once("error", onEnd);
}

/** Runs one Host operation and returns its rejection instead of throwing it. */
async function rejectionOf(operation: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function textOf(frame: Uint8Array): string { return Buffer.from(frame).toString("utf8"); }
function quoted(value: string | undefined): string { return value === undefined ? "<no answer>" : JSON.stringify(value); }

/** Bounds a private-pipe read so a native that neither answers nor exits is reported, not hung on. */
async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(undefined), milliseconds); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try { await access(path); return; } catch { await delay(25); }
  }
  throw new Error(`fixture first-user-code report never appeared: ${path}`);
}

async function removeRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await rm(root, { recursive: true, force: true }); return; } catch { await delay(50); }
  }
}

/**
 * Removes role processes an aborted probe could leave behind. The Player Job is
 * deliberately non-kill-on-close, so a crashed native cannot abort its role; the
 * native live harness cleans up the same way and scopes it to the fixture image.
 */
async function killLeftoverFixtureProcesses(): Promise<void> {
  await new Promise<void>((resolveKill) => {
    const child = spawn("taskkill", ["/f", "/im", "RoleRootFixture.exe"], { windowsHide: true, shell: false, stdio: "ignore" });
    child.once("exit", () => resolveKill());
    child.once("error", () => resolveKill());
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
