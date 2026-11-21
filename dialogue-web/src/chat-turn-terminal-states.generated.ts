// GENERATED FILE - do not edit.
// Regenerate: node tools/generate-vocabulary.mjs --contract contracts/chat-turn-terminal-states.v1.json --write
export const TERMINAL_TURN_STATES = ["completed", "cancelled", "failed"] as const;

/** The states in which a Chat turn has settled: nothing further happens to it without a new turn. */
export type ChatTurnTerminalState = (typeof TERMINAL_TURN_STATES)[number];
