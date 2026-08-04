import { afterEach, describe, expect, it, mock } from "bun:test";
import {
    closeDatabase,
    getChannel2NudgeClaimedAt,
    getChannel2NudgeState,
    openDatabase,
    setChannel2NudgeState,
} from "../../features/magic-context/storage";
import { maybeDeliverChannel2 } from "./channel2-delivery";

function useTempDataHome(prefix: string): void {
    const { mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A minimal stand-in for the in-process client OpenCode hands the plugin
 * (`input.client`). `promptAsync` is the delivery primitive; `messages` backs
 * resolvePromptContext (empty by default).
 */
function fakeClient(promptAsync: (input: unknown) => Promise<unknown>) {
    return { session: { promptAsync, messages: async () => ({ data: [] }) } };
}

afterEach(() => {
    closeDatabase();
    mock.restore();
});

describe("maybeDeliverChannel2", () => {
    it("no-ops when no pending intent exists", async () => {
        useTempDataHome("ch2-noop-");
        const db = openDatabase()!;
        const delivered = await maybeDeliverChannel2("ses-noop", {
            db,
            client: fakeClient(async () => ({})),
        });
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, "ses-noop")).toBe("");
    });

    it("no-ops (keeps pending) when no client is wired", async () => {
        useTempDataHome("ch2-noclient-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-noclient", "pending");
        const delivered = await maybeDeliverChannel2("ses-noclient", {
            db,
            // No client (e.g. a context with no client available).
            reclaimableTokens: 30_000,
            usableTokens: 60_000,
        });
        expect(delivered).toBe(false);
        // Intent stays pending: delivery is simply unavailable, not consumed.
        expect(getChannel2NudgeState(db, "ses-noclient")).toBe("pending");
    });

    it("does NOT deliver and leaves pending when the baseline is unknown", async () => {
        useTempDataHome("ch2-unknown-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-unknown", "pending");
        const delivered = await maybeDeliverChannel2("ses-unknown", {
            db,
            client: fakeClient(async () => ({})),
            // No reclaimable/usable measurement at this event.
        });
        // Unknown pressure must never burn the one-shot cap NOR cancel the
        // intent — a later final-stop with a real measurement decides.
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, "ses-unknown")).toBe("pending");
    });

    it("cancels (re-armable) when the full trigger predicate no longer holds", async () => {
        useTempDataHome("ch2-stale-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-stale", "pending");
        // 11k reclaimable >= 10k floor but < usable/3 (44k/3 ≈ 14.7k): the
        // audit repro — floor-only validation delivered this stale nudge and
        // permanently burned the one-per-session cap.
        const delivered = await maybeDeliverChannel2("ses-stale", {
            db,
            client: fakeClient(async () => ({})),
            reclaimableTokens: 11_000,
            usableTokens: 44_000,
        });
        expect(delivered).toBe(false);
        // Cancelled to '' (re-armable), NOT 'delivered' — cap preserved.
        expect(getChannel2NudgeState(db, "ses-stale")).toBe("");
    });

    it("boot-heals only stale claimed leases, not fresh live claims", () => {
        useTempDataHome("ch2-ttl-heal-");
        let db = openDatabase()!;
        setChannel2NudgeState(db, "ses-fresh-claim", "claimed");
        setChannel2NudgeState(db, "ses-stale-claim", "claimed");
        db.prepare(
            "UPDATE session_meta SET channel2_nudge_claimed_at = ? WHERE session_id = ?",
        ).run(Date.now() - 180_000, "ses-stale-claim");

        closeDatabase();
        db = openDatabase()!;

        expect(getChannel2NudgeState(db, "ses-fresh-claim")).toBe("claimed");
        expect(getChannel2NudgeClaimedAt(db, "ses-fresh-claim")).toBeGreaterThan(0);
        expect(getChannel2NudgeState(db, "ses-stale-claim")).toBe("pending");
        expect(getChannel2NudgeClaimedAt(db, "ses-stale-claim")).toBe(0);
    });

    it("cache-hit openDatabase heals stale claimed leases for long-lived processes", () => {
        useTempDataHome("ch2-cache-heal-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-cache-heal", "claimed");
        db.prepare(
            "UPDATE session_meta SET channel2_nudge_claimed_at = ? WHERE session_id = ?",
        ).run(Date.now() - 180_000, "ses-cache-heal");

        const cached = openDatabase()!;

        expect(cached).toBe(db);
        expect(getChannel2NudgeState(db, "ses-cache-heal")).toBe("pending");
        expect(getChannel2NudgeClaimedAt(db, "ses-cache-heal")).toBe(0);
    });

    it("delivers via the in-process client and consumes the one-shot cap", async () => {
        useTempDataHome("ch2-deliver-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-go", "pending");

        const promptAsync = mock(async () => ({}));
        const delivered = await maybeDeliverChannel2("ses-go", {
            db,
            client: fakeClient(promptAsync),
            reclaimableTokens: 30_000,
            usableTokens: 60_000,
        });

        expect(delivered).toBe(true);
        expect(promptAsync).toHaveBeenCalledTimes(1);
        const callArg = promptAsync.mock.calls[0]![0] as {
            path: { id: string };
            body: { noReply: boolean; parts: Array<{ text: string; synthetic?: boolean }> };
        };
        expect(callArg.path.id).toBe("ses-go");
        expect(callArg.body.noReply).toBe(false);
        expect(callArg.body.parts[0]!.text).toContain("<system-reminder>");
        expect(callArg.body.parts[0]!.text).toContain("ctx_reduce");
        // synthetic: true — skips OpenCode's queued-message wrapper (issue #129
        // flip-bust) + TUI render, while still driving the run loop + model. Must
        // NOT be ignored (that would strip it from the model).
        expect(callArg.body.parts[0]!.synthetic).toBe(true);
        expect((callArg.body.parts[0] as { ignored?: boolean }).ignored).not.toBe(true);
        // One-shot cap consumed.
        expect(getChannel2NudgeState(db, "ses-go")).toBe("delivered");
    });

    it("treats a lost post-send confirm CAS as unconfirmed without reverting to pending", async () => {
        useTempDataHome("ch2-confirm-lost-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-confirm-lost", "pending");

        const promptAsync = mock(async () => {
            // Simulate a sibling process consuming/cancelling the claim after the
            // send returns but before this process can confirm claimed→delivered.
            setChannel2NudgeState(db, "ses-confirm-lost", "");
        });
        const delivered = await maybeDeliverChannel2("ses-confirm-lost", {
            db,
            client: fakeClient(promptAsync),
            reclaimableTokens: 30_000,
            usableTokens: 60_000,
        });

        expect(promptAsync).toHaveBeenCalledTimes(1);
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, "ses-confirm-lost")).toBe("");
    });

    it("preserves a sibling's delivered claim when token confirmation is no longer ours", async () => {
        useTempDataHome("ch2-duplicate-window-");
        const db = openDatabase()!;
        const sessionId = "ses-duplicate-window";
        setChannel2NudgeState(db, sessionId, "pending");

        const sessionLog = mock(() => {});
        const promptAsync = mock(async () => {
            db.prepare(
                "UPDATE session_meta SET channel2_nudge_state = 'delivered', channel2_nudge_claimed_at = 0 WHERE session_id = ?",
            ).run(sessionId);
        });
        mock.module("../../shared/logger", () => ({ sessionLog }));

        const { maybeDeliverChannel2: deliver } = await import("./channel2-delivery");
        const delivered = await deliver(sessionId, {
            db,
            client: fakeClient(promptAsync),
            reclaimableTokens: 30_000,
            usableTokens: 60_000,
        });

        expect(promptAsync).toHaveBeenCalledTimes(1);
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, sessionId)).toBe("delivered");
        expect(
            sessionLog.mock.calls.some(
                (call) =>
                    call[0] === sessionId &&
                    typeof call[1] === "string" &&
                    call[1].includes("confirmation was not ours"),
            ),
        ).toBe(true);
    });

    it("does not stale-confirm when a healed mid-send claim is re-delivered elsewhere", async () => {
        useTempDataHome("ch2-healed-mid-send-");
        const db = openDatabase()!;
        const sessionId = "ses-healed-mid-send";
        setChannel2NudgeState(db, sessionId, "pending");

        const secondPromptAsync = mock(async () => ({}));
        const firstPromptAsync = mock(async () => {
            // Simulate boot healing a stale claim while the original promptAsync is
            // still in flight, then a sibling process delivering the rewound intent.
            db.prepare(
                "UPDATE session_meta SET channel2_nudge_state = 'pending', channel2_nudge_claimed_at = 0, channel2_nudge_claim_token = '' WHERE session_id = ?",
            ).run(sessionId);
            const secondDelivered = await maybeDeliverChannel2(sessionId, {
                db,
                client: fakeClient(secondPromptAsync),
                reclaimableTokens: 30_000,
                usableTokens: 60_000,
            });
            expect(secondDelivered).toBe(true);
        });

        const delivered = await maybeDeliverChannel2(sessionId, {
            db,
            client: fakeClient(firstPromptAsync),
            reclaimableTokens: 30_000,
            usableTokens: 60_000,
        });

        expect(firstPromptAsync).toHaveBeenCalledTimes(1);
        expect(secondPromptAsync).toHaveBeenCalledTimes(1);
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, sessionId)).toBe("delivered");
    });

    it("leaves a stale claim healable when claimed→pending CAS throws on send failure", async () => {
        useTempDataHome("ch2-revert-throw-");
        const db = openDatabase()!;
        const sessionId = "ses-revert-throw";
        setChannel2NudgeState(db, sessionId, "pending");

        const originalPrepare = db.prepare.bind(db);
        (db as unknown as { prepare: typeof db.prepare }).prepare = (sql: string) => {
            const statement = originalPrepare(sql);
            if (
                sql ===
                "UPDATE session_meta SET channel2_nudge_state = ?, channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ? AND channel2_nudge_state = 'claimed' AND channel2_nudge_claim_token = ?"
            ) {
                return {
                    ...statement,
                    run: (...args: unknown[]) => {
                        if (
                            args[0] === "pending" &&
                            args[1] === 0 &&
                            args[2] === "" &&
                            args[3] === sessionId
                        ) {
                            throw new Error("SQLITE_BUSY: database is locked");
                        }
                        return statement.run(
                            ...(args as [unknown, unknown, unknown, unknown, unknown]),
                        );
                    },
                } as typeof statement;
            }
            return statement;
        };
        const promptAsync = mock(async () => {
            throw new Error("transient network failure");
        });

        const { maybeDeliverChannel2: deliver } = await import("./channel2-delivery");
        const delivered = await deliver(sessionId, {
            db,
            client: fakeClient(promptAsync),
            reclaimableTokens: 30_000,
            usableTokens: 60_000,
        });

        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, sessionId)).toBe("claimed");
        expect(getChannel2NudgeClaimedAt(db, sessionId)).toBeGreaterThan(0);

        db.prepare(
            "UPDATE session_meta SET channel2_nudge_claimed_at = ? WHERE session_id = ?",
        ).run(Date.now() - 180_000, sessionId);

        const cached = openDatabase()!;
        expect(cached).toBe(db);
        expect(getChannel2NudgeState(db, sessionId)).toBe("pending");
        expect(getChannel2NudgeClaimedAt(db, sessionId)).toBe(0);
    });

    it("reverts claimed→pending on send failure (cap not burned)", async () => {
        useTempDataHome("ch2-fail-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-fail", "pending");

        const promptAsync = mock(async () => {
            throw new Error("transient network failure");
        });
        const delivered = await maybeDeliverChannel2("ses-fail", {
            db,
            client: fakeClient(promptAsync),
            reclaimableTokens: 30_000,
            usableTokens: 60_000,
        });

        expect(delivered).toBe(false);
        // Reverted to pending so a later event retries — the single nudge isn't lost.
        expect(getChannel2NudgeState(db, "ses-fail")).toBe("pending");
    });

    it("a second delivery attempt after success is a no-op (one nudge per lifetime)", async () => {
        useTempDataHome("ch2-twice-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-twice", "delivered");
        const delivered = await maybeDeliverChannel2("ses-twice", {
            db,
            client: fakeClient(async () => ({})),
        });
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, "ses-twice")).toBe("delivered");
    });
});
