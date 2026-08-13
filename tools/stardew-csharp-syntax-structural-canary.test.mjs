import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCSharpSyntaxParseClean,
  parseCSharpSyntaxStructure,
} from "./lib/stardew-csharp-syntax-structural-canary.mjs";

const fixture = `
namespace Example;

public interface IRunner { void Run(); }

public class Outer : IRunner
{
    public event System.Action Changed;
    private int value;
    public int Value { get => value; set { value = value; } }
    public struct Nested { public int Count; }
    public Outer() { value = 0; }
    public void Run() { Run(1); }
    public void Run(int amount)
    {
        var data = DataLoader.Fish(Game1.content);
        if (amount > 0)
        {
            this.value += amount;
            Changed?.Invoke();
            this.Run();
        }
        else if (amount == 0)
        {
            value = 2;
        }
        else
        {
            var label = "多字节";
            switch (amount) { default: return; }
        }
        return;
    }
}
`;

function recursivelyHasForbiddenKey(value) {
  const forbidden = new Set([
    "action",
    "primitive",
    "operation",
    "contract",
    "receipt",
    "projection",
    "reuse",
    "semanticFamily",
    "directCall",
    "fieldWrite",
    "stateMutation",
  ]);
  if (Array.isArray(value)) return value.some(recursivelyHasForbiddenKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => forbidden.has(key) || recursivelyHasForbiddenKey(nested));
}

test("extracts only neutral C# syntax facts while retaining overloads, nesting, and guarded syntax", async () => {
  const report = await parseCSharpSyntaxStructure({ source: fixture, relativePath: "fixture.cs" });
  assertCSharpSyntaxParseClean(report);
  assert.equal(report.parse.rootSyntaxKind, "compilation_unit");
  assert.equal(
    report.declarations.filter(
      (item) => item.declarationSyntaxKind === "method_declaration" && item.identifierSyntax === "Run",
    ).length,
    3,
  );
  assert.equal(
    report.declarations.filter(
      (item) =>
        item.declarationSyntaxKind === "method_declaration" && item.identifierSyntax === "Run" && item.bodyLocator,
    ).length,
    2,
  );
  assert.equal(
    report.declarations.filter(
      (item) => item.declarationSyntaxKind === "struct_declaration" && item.identifierSyntax === "Nested",
    ).length,
    1,
  );
  assert.deepEqual(report.controlSyntax.map((item) => item.syntaxKind).sort(), [
    "if_statement",
    "if_statement",
    "return_statement",
    "return_statement",
    "switch_statement",
  ]);
  assert.ok(report.invocationSyntax.some((item) => item.calleeSyntaxKind === "identifier"));
  assert.ok(report.invocationSyntax.some((item) => item.calleeSyntaxKind === "member_access_expression"));
  assert.ok(report.assignmentSyntax.some((item) => item.targetSyntaxKind === "identifier"));
  const memberAccessAssignment = report.assignmentSyntax.find((item) => item.memberAccessAssignmentTargetSyntax);
  assert.ok(memberAccessAssignment);
  assert.equal(memberAccessAssignment.rightSyntaxKind, "identifier");
  assert.equal(typeof memberAccessAssignment.rightSyntaxSha256, "string");
  const contentShapedInvocation = report.invocationSyntax.find(
    (item) => item.argumentSyntaxCount === 1 && item.calleeSyntaxKind === "member_access_expression",
  );
  assert.ok(contentShapedInvocation);
  assert.equal(contentShapedInvocation.argumentsSyntaxKind, "argument_list");
  assert.equal(typeof contentShapedInvocation.argumentsSyntaxSha256, "string");
  const fixtureBytes = Buffer.from(fixture, "utf8");
  assert.ok(
    report.declarations.every(
      (item) => fixtureBytes.subarray(item.locator.startByte, item.locator.endByte).toString("utf8").length > 0,
    ),
  );
  assert.ok(
    report.controlSyntax.every(
      (item) => fixtureBytes.subarray(item.locator.startByte, item.locator.endByte).toString("utf8").length > 0,
    ),
  );
  assert.equal(recursivelyHasForbiddenKey(report), false);
});

test("is deterministic and preserves parse errors for callers to fail closed", async () => {
  const first = await parseCSharpSyntaxStructure({ source: fixture, relativePath: "fixture.cs" });
  const second = await parseCSharpSyntaxStructure({ source: fixture, relativePath: "fixture.cs" });
  assert.deepEqual(first, second);

  const malformed = await parseCSharpSyntaxStructure({ source: "class C { void M( {", relativePath: "malformed.cs" });
  assert.throws(() => assertCSharpSyntaxParseClean(malformed), { code: "csharp_syntax_parse_invalid" });
});
