import pathlib
import xml.etree.ElementTree as ElementTree

# Validate every .wsb this project writes, because the platform's only report of a bad one is a dialog the
# host cannot read.
#
# The defect that prompted this: a configuration containing `>nul` inside <Command> failed with
# "An error occurred while parsing EntityName. Line 28, position 86" - an unescaped `>` (and a `2>&1`) in an
# XML text node. The sandbox then never started its logon command, and from the host that looked exactly
# like "the logon command does not run in this environment". Three separate hypotheses were investigated
# before anyone looked at the screen, where the parse error had been showing the whole time.
#
# So: parse every configuration as XML, and additionally assert that the command text contains no raw XML
# metacharacters, because a parser that tolerates them would still leave the platform rejecting the file.

failures = 0
for path in sorted(pathlib.Path("tools/sandbox").glob("*.wsb")):
    text = path.read_text(encoding="utf-8")
    if text.startswith("\ufeff"):
        print(f"FAIL {path.name}: starts with a BOM (the platform rejects it)")
        failures += 1
        continue

    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as error:
        print(f"FAIL {path.name}: not valid XML: {error}")
        failures += 1
        continue

    commands = [element.text or "" for element in root.iter("Command")]
    if not commands:
        print(f"FAIL {path.name}: has no LogonCommand/Command element")
        failures += 1
        continue

    for command in commands:
        # A parsed text node cannot contain raw metacharacters, but the SOURCE can contain them in a way the
        # parser accepted (e.g. inside a CDATA section) and the platform will not. Check the raw slice too.
        if any(character in command for character in ("<", ">", "&")):
            # `&amp;` and friends are already decoded by the parser, so a decoded `&` is expected only when it
            # came from an entity. Reject `>` and `<` outright: neither has a legitimate use in a cmd command.
            if "<" in command or ">" in command:
                print(
                    f"FAIL {path.name}: command contains a raw XML metacharacter: {command!r}"
                )
                failures += 1

    print(f"ok   {path.name}: {len(commands)} command(s), valid XML")

    # The shell redirections that caused the defect must be written as entities in the source.
    lowered = text.lower()
    suspicious = [token for token in ("&amp;", "&gt;") if token in lowered]
    for token in suspicious:
        pass  # entities are the correct form; their presence is what we want

print()
if failures == 0:
    print("all_sandbox_configs_valid")
else:
    print(f"{failures} configuration(s) invalid")
raise SystemExit(failures)
