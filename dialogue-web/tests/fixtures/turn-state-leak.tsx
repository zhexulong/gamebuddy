// A planted dynamic leak: `{turn.state}` renders the raw turn-state union into
// the DOM, which the static string scan cannot see. `enum.5` proves the checker
// flags it. This file is a fixture, never a shipped component.
type TurnState = "queued" | "running" | "response_visible" | "stopping" | "completed" | "cancelled" | "failed";

export function TurnLeak({ turn }: { turn: { state: TurnState } }) {
  return <p>{turn.state}</p>;
}
