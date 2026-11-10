/**
 * The one exhaustiveness assertion in this build.
 *
 * A `switch` over a union with a `default: return assertNever(x)` is the only shape in which adding a
 * member to that union is a compile error rather than a silent fall-through to the default branch -
 * and this module exists so that shape has one spelling. A local copy per file (`exhaustive`,
 * `assertKnownPhase`, ...) reads as the same fact spelled twice, and the two copies then disagree
 * about what a new member means: `game-presentation.ts` guarded `outcome` with a local helper that
 * returned the message *string* it was handed, so the boolean reader had to write `exhaustive(x);
 * return false;` to use it.
 *
 * The return type is `never`, so the caller never needs a value after the call, and the parameter is
 * `never`, so the call compiles only while every member of the union has its own branch.
 *
 * `tools/check-switch-exhaustiveness.mjs` is the other half: this helper makes a *new* member a
 * compile error, and that gate makes sure every switch over a union actually has the call.
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled union member: ${JSON.stringify(value)}`);
}
