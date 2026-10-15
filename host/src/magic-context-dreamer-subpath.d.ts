/**
 * The vendored package (`vendor/magic-context`, submodule) publishes `./dreamer`
 * in its `exports` map without a `types` condition, and its declaration build
 * (`tsconfig.declarations.json`) lists only the `./tavern` and `./memory` entries,
 * so the subpath resolves to plain JavaScript and strict mode refuses it with
 * TS7016.
 *
 * The declaration is deliberately empty: it asserts nothing about the module's
 * members, so it cannot drift from the package. The one consumer states the
 * surface it uses itself (`DreamerSubpath` in
 * `composition/companion-session-reflection.ts`). Delete this file once the
 * package publishes declarations for `./dreamer`.
 */
declare module "@cortexkit/pi-magic-context/dreamer";
