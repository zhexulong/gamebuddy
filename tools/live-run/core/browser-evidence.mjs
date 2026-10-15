/**
 * The browser half of a Chat live run, as one local evidence directory.
 *
 * Until now no Chat live run ever opened the product's real browser surface: the
 * runner called `/bootstrap`, `/state`, `/messages` and `/events` with `fetch`
 * and never recorded a DOM or a screenshot, so "the reply the API reports is the
 * reply the DOM shows" stayed inferred.
 *
 * Two facts forced the design here:
 *
 * 1. The `boot=<token>` handoff is ONE-TIME. The loop's own `fetch` used to spend
 *    it, which is exactly why a browser opened afterwards got 401 and why every UI
 *    verdict so far came from a manual desktop run. The frontend audit's
 *    prescription is followed literally: **the browser redeems the token first**,
 *    and the loop attaches to the session the browser created by reading its
 *    session cookie over CDP and taking `csrfToken` from the authenticated
 *    `/api/tavern/v1/state` body (reads never send a CSRF header, so a read is all
 *    that is needed to obtain it). `dialogue-web/src/main.tsx` documents the same
 *    path from the product side: "a reload re-selects the same app through the
 *    session cookie".
 *
 * 2. There is no browser automation dependency at the repository root, and the
 *    screenshot lanes that already worked (`fa2-open.ps1` and the fa and fc lanes)
 *    did not use one either: they started Edge/Chrome with
 *    `--remote-debugging-port` and talked raw CDP. This module is that stack,
 *    minimised, over Node's built-in `WebSocket` and `fetch`.
 *
 * The launch URL carries the one-time token, so it is never printed and never put
 * on a command line: the browser is started on `about:blank` and the URL is
 * delivered over CDP `Page.navigate`, which keeps it out of the process list too.
 *
 * Every function here fails SOFT. A missing browser, a refused CDP connection or
 * a page that never authenticates returns a named reason; it never silently
 * passes and it never fails an otherwise good run.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

/** The cookie the composed surface sets; the same name the host's own tests use. */
const SESSION_COOKIE_NAME = "gb_composed_reference_game_session";

const DEFAULT_BROWSER_CANDIDATES = Object.freeze([
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
]);

/**
 * The browser binary this run will use, or `undefined` when the machine has none.
 * `executable` (or `GAMEBUDDY_LIVE_RUN_BROWSER`) wins so a lane can pin one.
 */
export async function findBrowserExecutable({ executable, env = process.env, exists = undefined } = {}) {
  const { existsSync } = await import("node:fs");
  const isFile = typeof exists === "function" ? exists : existsSync;
  const candidates = [executable, env?.GAMEBUDDY_LIVE_RUN_BROWSER, ...DEFAULT_BROWSER_CANDIDATES].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  for (const candidate of candidates) if (isFile(candidate)) return candidate;
  return undefined;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A port nobody else is listening on, obtained by binding and releasing one. A
 * fixed port would collide with whatever else this machine is running; the CDP
 * endpoint is loopback-only and short-lived.
 */
export async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => (typeof port === "number" ? resolve(port) : reject(new Error("free_port_unavailable"))));
    });
  });
}

/** Wait for a CDP HTTP endpoint to answer; a browser that never answers is a named reason. */
async function waitForCdpEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "cdp_endpoint_unreachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return { ok: true, version: await response.json().catch(() => undefined) };
      lastError = `cdp_endpoint_status_${response.status}`;
    } catch (error) {
      lastError = `cdp_endpoint_unreachable:${String(error?.name ?? error)}`;
    }
    await delay(250);
  }
  return { ok: false, reason: lastError };
}

/** The page target CDP will drive, creating one when the browser started without a page. */
async function resolvePageTarget(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const listed = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
      if (listed.ok) {
        const targets = await listed.json();
        const page = targets.find(
          (target) => target?.type === "page" && typeof target.webSocketDebuggerUrl === "string",
        );
        if (page !== undefined) return { ok: true, target: page };
      }
    } catch {
      /* retry */
    }
    try {
      const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: "PUT",
        signal: AbortSignal.timeout(2_000),
      });
      if (created.ok) {
        const target = await created.json();
        if (typeof target?.webSocketDebuggerUrl === "string") return { ok: true, target };
      }
    } catch {
      /* retry */
    }
    await delay(250);
  }
  return { ok: false, reason: "cdp_page_target_unavailable" };
}

/** A minimal CDP connection: request/response by id, no dependency. */
function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("cdp_socket_error")), { once: true });
    socket.addEventListener("close", () => {
      closed = true;
      for (const { reject: rejectCall } of pending.values()) rejectCall(new Error("cdp_socket_closed"));
      pending.clear();
    });
  });
  socket.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (typeof frame?.id !== "number") return;
    const call = pending.get(frame.id);
    if (call === undefined) return;
    pending.delete(frame.id);
    if (frame.error !== undefined) call.reject(new Error(`cdp_error:${frame.error?.message ?? "unknown"}`));
    else call.resolve(frame.result);
  });
  return Object.freeze({
    opened,
    send(method, params = {}, { timeoutMs = 15_000 } = {}) {
      if (closed) return Promise.reject(new Error("cdp_socket_closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`cdp_timeout:${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  });
}

function cookieHeaderFor(cookies, origin) {
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return undefined;
  }
  const match = cookies.find(
    (cookie) => cookie?.name === SESSION_COOKIE_NAME && String(cookie?.domain ?? "").includes(host),
  );
  return match === undefined ? undefined : `${match.name}=${match.value}`;
}

/**
 * One browser evidence session. The returned handle never exposes the launch URL
 * or the session cookie beyond what the caller explicitly asks for.
 */
export async function openBrowserEvidenceSession({
  executable,
  origin,
  launchUrl,
  profileDir,
  port,
  headless = true,
  connectTimeoutMs = 30_000,
  sessionTimeoutMs = 30_000,
}) {
  await mkdir(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=msEdgeFirstRun",
    "--disable-extensions",
    "--window-size=1280,900",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
  const diagnostics = { port, headless, executable };
  const endpoint = await waitForCdpEndpoint(port, connectTimeoutMs);
  if (!endpoint.ok) {
    child.kill();
    return Object.freeze({ ok: false, reason: endpoint.reason, diagnostics });
  }
  const target = await resolvePageTarget(port);
  if (!target.ok) {
    child.kill();
    return Object.freeze({ ok: false, reason: target.reason, diagnostics });
  }
  const cdp = connectCdp(target.target.webSocketDebuggerUrl);
  try {
    await cdp.opened;
  } catch (error) {
    child.kill();
    return Object.freeze({ ok: false, reason: `cdp_connect_failed:${String(error?.message ?? error)}`, diagnostics });
  }
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  // The one-time token travels here and nowhere else: not on the command line
  // (visible in the process list) and not in this process's stdout.
  await cdp.send("Page.navigate", { url: launchUrl });

  const evaluate = async (expression, { timeoutMs = 15_000 } = {}) => {
    const result = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      { timeoutMs },
    );
    if (result?.exceptionDetails !== undefined)
      throw new Error(`page_evaluate_failed:${result.exceptionDetails.text ?? "unknown"}`);
    return result?.result?.value;
  };

  const sessionCookieHeader = async () => {
    const cookies = await cdp.send("Network.getAllCookies");
    return cookieHeaderFor(cookies?.cookies ?? [], origin);
  };

  const close = async () => {
    cdp.close();
    // Chrome/Edge spawn renderer children. Killing the browser process first would
    // orphan them, because a tree kill can only walk a LIVE parent's children -
    // observed on a real run, where six headless children outlived their browser.
    // So the tree kill runs while the parent is still alive, and the direct kill is
    // only the fallback for the case where taskkill is unavailable. This only ever
    // targets the pid this call started.
    if (child.exitCode === null && child.pid !== undefined) {
      await new Promise((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      });
    }
    child.kill();
  };

  return Object.freeze({
    ok: true,
    diagnostics,
    evaluate,
    cookieName: SESSION_COOKIE_NAME,
    async waitForSessionCookie(timeoutMs = sessionTimeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await sessionCookieHeader();
          if (typeof last === "string" && last.length > 0) return { ok: true, cookie: last };
        } catch (error) {
          last = undefined;
          void error;
        }
        await delay(250);
      }
      return { ok: false, reason: "browser_session_cookie_absent" };
    },
    sessionCookieHeader,
    async screenshot(path, { fullPage = false } = {}) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage });
      if (typeof shot?.data !== "string") return { ok: false, reason: "screenshot_unavailable" };
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, Buffer.from(shot.data, "base64"));
      return { ok: true, path };
    },
    async domSnapshot() {
      return evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll("ol.message-list > li"));
        const bubbles = Array.from(document.querySelectorAll(".message-bubble"));
        return {
          shellPresent: document.querySelector('[data-profile="composed-reference-game"]') !== null,
          emptyState: document.querySelector("[data-empty-anchor]") !== null,
          handles: rows.map((row) => row.getAttribute("data-handle")),
          bubbleTexts: bubbles.map((node) => node.textContent ?? ""),
          bodyText: (document.body?.innerText ?? "").slice(0, 4000),
          title: document.title,
        };
      })()`);
    },
    close,
  });
}

/** Emphasis and block markers a Markdown renderer consumes, removed from both sides. */
function stripMarkdownPunctuation(value) {
  return String(value ?? "")
    .replace(/[*_`>#~]/g, "")
    .replace(/\s+/g, "");
}

/**
 * What the DOM must satisfy for one run, checked against the durable transcript.
 * Each entry is an assertion with a name, so a failure names the defect.
 */
export function assertRenderedTranscript(dom, transcript, { expectedPlayerTexts = [] } = {}) {
  const results = [];
  const handles = Array.isArray(dom?.handles) ? dom.handles : [];
  const bubbleTexts = Array.isArray(dom?.bubbleTexts) ? dom.bubbleTexts : [];
  const expected = Array.isArray(transcript) ? transcript : [];
  const expectedHandles = expected.map((message) => message?.handle).filter((handle) => typeof handle === "string");

  results.push({
    assertion: "chat_surface_mounted",
    ok: dom?.shellPresent === true,
    detail:
      dom?.shellPresent === true
        ? "the composed reference shell is in the document"
        : "the shell element was not found",
  });
  results.push({
    assertion: "rendered_message_count_matches_state",
    ok: handles.length === expectedHandles.length,
    detail: `DOM rows ${handles.length} vs /state transcript ${expectedHandles.length}`,
  });
  results.push({
    assertion: "rendered_handle_order_matches_state",
    ok:
      handles.length === expectedHandles.length && handles.every((handle, index) => handle === expectedHandles[index]),
    detail: `DOM ${JSON.stringify(handles.slice(0, 6))} vs /state ${JSON.stringify(expectedHandles.slice(0, 6))}`,
  });
  results.push({
    assertion: "no_empty_bubble",
    ok: bubbleTexts.every((text) => text.trim().length > 0),
    detail: `${bubbleTexts.filter((text) => text.trim().length === 0).length} empty bubble(s)`,
  });
  results.push({
    assertion: "no_preview_bubble_after_terminal",
    ok: handles.every((handle) => !String(handle).endsWith("_preview")),
    detail: handles.filter((handle) => String(handle).endsWith("_preview")).join(", ") || "no preview handle rendered",
  });
  // The renderer is a Markdown renderer, so its textContent has the emphasis
  // markers stripped. Comparing both sides with those markers removed is what
  // makes "the reply the API reports is the reply the DOM shows" checkable.
  const mismatchedText = [];
  expected.forEach((message, index) => {
    const rendered = stripMarkdownPunctuation(bubbleTexts[index] ?? "");
    const durable = stripMarkdownPunctuation(typeof message?.text === "string" ? message.text : "");
    if (rendered !== durable)
      mismatchedText.push({
        index,
        handle: message?.handle ?? null,
        rendered: rendered.slice(0, 80),
        durable: durable.slice(0, 80),
      });
  });
  results.push({
    assertion: "rendered_text_matches_state_text",
    ok: mismatchedText.length === 0,
    detail:
      mismatchedText.length === 0
        ? `${expected.length} rendered bubble(s) match their durable text`
        : JSON.stringify(mismatchedText.slice(0, 3)),
  });
  const bodyText = typeof dom?.bodyText === "string" ? dom.bodyText : "";
  for (const pattern of [
    { assertion: "no_macro_residue_in_dom", test: /\{\{/ },
    { assertion: "no_reasoning_leak_in_dom", test: /<thinking>/i },
    { assertion: "no_transport_marker_in_dom", test: /<\|/ },
    { assertion: "no_debug_marker_in_dom", test: /\[DEBUG-/ },
  ]) {
    results.push({
      assertion: pattern.assertion,
      ok: !pattern.test.test(bodyText),
      detail: `pattern ${String(pattern.test)}`,
    });
  }
  // The player's own words must reach the DOM too: a companion-only render would
  // pass every check above while the conversation was one-sided.
  const missing = expectedPlayerTexts.filter(
    (text) => typeof text === "string" && text.length > 0 && !bodyText.includes(text),
  );
  results.push({
    assertion: "player_messages_rendered",
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `${expectedPlayerTexts.length} player message(s) present`
        : `missing: ${JSON.stringify(missing)}`,
  });
  return Object.freeze({
    passed: results.every((result) => result.ok),
    results: Object.freeze(results.map((result) => Object.freeze(result))),
  });
}
