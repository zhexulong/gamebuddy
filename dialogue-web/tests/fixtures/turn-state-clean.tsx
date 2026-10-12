// The clean counterpart to `turn-state-leak.tsx`: the same turn state is rendered
// through a presentation function, whose type is `string`, so the checker sees no
// closed literal union and reports nothing.
type TurnState = "queued" | "running" | "response_visible" | "stopping" | "completed" | "cancelled" | "failed";

function turnLabel(state: TurnState): string {
  return state === "completed" ? "Done" : "Working";
}

export function TurnClean({ turn }: { turn: { state: TurnState } }) {
  return <p>{turnLabel(turn.state)}</p>;
}
