import assert from "node:assert/strict";
import test from "node:test";

import { collapseWhitespace } from "./source-shape.test-support.js";

/**
 * The normalised shape is the whole deliverable: twenty-two assertions across the Host suite match code across tokens
 * through it, so a regression here would surface as one of those going red on a product that did not change - the very
 * failure the helper exists to remove. The invariant is that the SHAPE does not depend on where the formatter broke the
 * line; the failure messages below name which breakage stopped being invisible.
 */

const ONE_LINE =
  "launchRole(role, launchOperation: RoleLaunchOperation, produceAuthorization: TypedPrivateGameAuthorizationProducer) {";

test("a parameter list the formatter broke after the parenthesis, the commas and before the closing one reads as one line", () => {
  const broken = [
    "  launchRole(",
    "    role,",
    "    launchOperation: RoleLaunchOperation,",
    "    produceAuthorization: TypedPrivateGameAuthorizationProducer,",
    "  ) {",
  ].join("\n");
  assert.ok(
    collapseWhitespace(broken).includes(ONE_LINE),
    "the signature's shape must be the one-line spelling, trailing comma and line breaks gone",
  );
});

test("the shape of a statement does not depend on the width it was formatted at", () => {
  const wide = 'const authorization: InternalAuthorization = (facts) => { if (!active) rejected("stale"); };';
  const narrow = [
    "const authorization: InternalAuthorization = (facts) => {",
    '  if (!active) rejected("stale");',
    "};",
  ].join("\n");
  assert.equal(collapseWhitespace(narrow), collapseWhitespace(wide));
});

test("a string literal keeps the whitespace it really holds, so a pattern over its text still means something", () => {
  const source = 'const a = "two  spaces";\nconst b = 1;';
  assert.ok(collapseWhitespace(source).includes('"two  spaces"'), "data inside a literal is not layout");
});

test("an apostrophe in a comment does not open a literal and swallow the code after it", () => {
  const source = "// the attempt's own facts, NOT the launch authorization\nconst written = true;";
  assert.equal(
    collapseWhitespace(source),
    "// the attempt's own facts, NOT the launch authorization const written = true;",
    "a comment is read before any quote in it: the first version of this helper treated that apostrophe as a string start",
  );
});

test("the shape is a fixpoint, so normalising it again changes nothing", () => {
  const shape = collapseWhitespace("function f(\n  a,\n  b,\n) {\n  return { a, b };\n}");
  assert.equal(collapseWhitespace(shape), shape);
});
