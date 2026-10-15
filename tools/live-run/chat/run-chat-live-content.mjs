#!/usr/bin/env node
/**
 * The content-judging Chat live run.
 *
 * A thin, documented entry point over the ONE harness
 * (`chat/run-chat-live-audit.mjs`) — never a parallel runner. It only supplies the
 * defaults that make the run answerable by a reviewer:
 *
 *  - TWO real player intents (one greeting, one task request) instead of the
 *    content-free `"Please respond naturally."` single-turn probe, so both rungs of
 *    the pacing ladder are actually exercised and the reply can be judged for
 *    relevance and persona rather than only for existence;
 *  - the browser phase on by default, so the run directory carries the rendered
 *    transcript alongside the protocol trace and the content verdicts.
 *
 * Every value here is an environment override the harness already reads, so a
 * caller can replace any of them. Nothing about the trace changes: it stays
 * content-free; the words live in `.live-runs/<run-id>/companion-experience.json`.
 */
process.env.GAMEBUDDY_CHAT_TURNS = process.env.GAMEBUDDY_CHAT_TURNS ?? "2";
process.env.GAMEBUDDY_CHAT_PROMPTS =
  process.env.GAMEBUDDY_CHAT_PROMPTS ?? "你好|帮我把地里的防风草全收了，顺便把土松一遍。";

const { main } = await import("./run-chat-live-audit.mjs");
process.exit(await main(process.argv.slice(2)));
