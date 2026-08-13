# Stardew companion live fixtures

These frozen schema-v1 fixtures define only scripted player intent. They cannot select tools/actions, carry evidence between scenarios, or specify companion wording. `phrases.zh-CN.v1.json` is human-reviewed zh-CN input; `silence` markers are runner control tokens, not player text.

The P6 runner writes redacted summary/timeline artifacts. Fixture runs are `deterministic_fixture`; they are never live closure.
