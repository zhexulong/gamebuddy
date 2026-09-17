import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHAT_LIVE_OUTPUT_ROOT = "D:\\GameBuddy-chat-live-tmp";
const CHAT_LIVE_ENTRY = "dialogue-web-main.js";
const READY_PREFIX = "GameBuddy Dialogue is ready at ";
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 300;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deadlineFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

export class InteractivePlayerSession {
  constructor(options = {}) {
    this.options = options;
    this.root = null;
    this.child = null;
    this.origin = null;
    this.client = null;
    this.history = [];
    this.piSessionId = null;
    this.markerObserved = false;
  }

  async start() {
    this.root = this.options.runtimeRoot ?? (await mkdtemp(join(tmpdir(), "gamebuddy-player-session-")));
    const configPath = join(this.root, "dialogue.json");
    const nonce = randomBytes(18).toString("hex");
    const nonceSha256 = sha256(nonce);

    const identity = {
      playerId: this.options.playerId ?? "alex_player",
      companionId: this.options.companionId ?? "companion_companion",
      continuityId: this.options.continuityId ?? "continuity_interactive",
    };

    const manifest = {
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot: this.root,
      principal: identity,
      bootstrapOperationId: `bootstrap_${randomBytes(8).toString("hex")}`,
      authorityGeneration: 1,
    };

    await writeFile(configPath, JSON.stringify(manifest, null, 2), "utf8");

    const entryPath = join(CHAT_LIVE_OUTPUT_ROOT, CHAT_LIVE_ENTRY);
    this.child = spawn(
      process.execPath,
      [entryPath, `--tavern-narrative-gate-nonce-sha256=${nonceSha256}`, configPath],
      {
        cwd: CHAT_LIVE_OUTPUT_ROOT,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
        env: { ...process.env, GAMEBUDDY_CHAT_LIVE_ARTIFACT: "gamebuddy.chat-live.v1" },
      }
    );

    this.stdout = "";
    this.stderr = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => { this.stdout += chunk; });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (this.options.debug) process.stderr.write(`[SERVER-STDERR] ${chunk}`);
    });

    this.child.on("message", (msg) => {
      if (msg?.schema === "gamebuddy-tavern-narrative-gate-runtime/v1") {
        this.piSessionId = msg.piSessionId;
      } else if (msg?.schema === "gamebuddy-tavern-narrative-gate-marker/v1") {
        this.markerObserved = true;
      }
    });

    const readyUrl = await new Promise((resolveReady, rejectReady) => {
      const startTimer = setTimeout(() => {
        clearInterval(interval);
        rejectReady(new Error(`dialogue_start_timeout. Stderr: ${this.stderr}`));
      }, START_TIMEOUT_MS);

      const interval = setInterval(() => {
        const match = this.stdout.match(new RegExp(`${READY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\S+)`));
        if (match) {
          clearTimeout(startTimer);
          clearInterval(interval);
          resolveReady(match[1]);
        }
      }, 50);

      this.child.once("exit", (code) => {
        clearTimeout(startTimer);
        clearInterval(interval);
        rejectReady(new Error(`dialogue_exited_early:${code}. Stderr: ${this.stderr}`));
      });
      this.child.once("error", (err) => {
        clearTimeout(startTimer);
        clearInterval(interval);
        rejectReady(err);
      });
    });

    const url = new URL(readyUrl);
    this.origin = `${url.protocol}//${url.host}`;
    const bootstrapToken = new URLSearchParams(url.hash.slice(1)).get("boot");
    if (!bootstrapToken) throw new Error("bootstrap_token_missing");

    const bootRes = await deadlineFetch(`${this.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: this.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken }),
    });

    const bootBody = await bootRes.json();
    const cookie = bootRes.headers.get("set-cookie")?.split(";", 1)[0];
    if (!bootRes.ok || !cookie || !bootBody.csrfToken) {
      throw new Error(`bootstrap_failed: ${bootRes.status}`);
    }

    this.client = { cookie, csrf: bootBody.csrfToken };
    return { origin: this.origin, piSessionId: this.piSessionId };
  }

  async sendPlayerTurn(text, locale = "en") {
    if (!this.client) throw new Error("Session not started");
    const startTime = Date.now();

    // 1. Get current state
    const stateRes = await deadlineFetch(`${this.origin}/api/tavern/v1/state`, {
      headers: { Cookie: this.client.cookie, Origin: this.origin },
    });
    const snapshotBefore = await stateRes.json();
    const selectionGeneration = snapshotBefore?.selection?.generation ?? 1;
    const draftRevision = snapshotBefore?.draft?.revision ?? snapshotBefore?.chat?.draft?.revision ?? 0;

    // 2. Submit player message
    const msgRes = await deadlineFetch(`${this.origin}/api/tavern/v1/messages`, {
      method: "POST",
      headers: {
        Origin: this.origin,
        Cookie: this.client.cookie,
        "X-CSRF-Token": this.client.csrf,
        "Idempotency-Key": randomBytes(16).toString("base64url"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiVersion: 1,
        selectionGeneration,
        text,
        locale,
        expectedDraftRevision: draftRevision,
      }),
    });

    if (msgRes.status !== 202) {
      throw new Error(`message_submit_failed: ${msgRes.status}`);
    }

    // 3. Poll for turn completion
    let outcome = "pending";
    let terminalSnapshot = null;
    const deadline = Date.now() + TURN_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const curStateRes = await deadlineFetch(`${this.origin}/api/tavern/v1/state`, {
        headers: { Cookie: this.client.cookie, Origin: this.origin },
      });
      terminalSnapshot = await curStateRes.json();
      const turnState = terminalSnapshot?.turn?.state ?? terminalSnapshot?.chat?.turn?.state;

      if (turnState === "completed") {
        outcome = "completed";
        break;
      }
      if (turnState === "failed") {
        outcome = "failed";
        break;
      }
      if (turnState === "cancelled") {
        outcome = "cancelled";
        break;
      }
    }

    const durationMs = Date.now() - startTime;
    const transcript = terminalSnapshot?.transcript ?? terminalSnapshot?.chat?.transcript ?? [];
    const latestCompanionMessage = [...transcript].reverse().find(
      (m) => m.role === "companion" || m.role === "assistant" || m.sender === "companion" || m.author === "companion" || m.participant === "companion"
    );

    const companionText = latestCompanionMessage?.text ?? latestCompanionMessage?.content ?? "(no text found)";

    const turnRecord = {
      turnIndex: this.history.length + 1,
      playerText: text,
      companionText,
      turnState: outcome,
      durationMs,
      timestamp: new Date().toISOString(),
      rawTurn: terminalSnapshot?.turn ?? terminalSnapshot?.chat?.turn,
    };

    this.history.push(turnRecord);
    return turnRecord;
  }

  getRuntimeRoot() {
    return this.root;
  }

  async close() {
    if (this.child) {
      this.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (this.child.exitCode === null) {
        this.child.kill("SIGKILL");
      }
      this.child = null;
    }
    if (this.root && !this.options.preserveRoot) {
      await rm(this.root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      this.root = null;
    }
  }
}
