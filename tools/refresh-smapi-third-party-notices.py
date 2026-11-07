"""Generate `assets/smapi/THIRD-PARTY-NOTICES.txt` from the vendored payload itself.

Why this exists: we redistribute SMAPI's Windows payload, and that payload bundles eleven third-party
libraries. SMAPI is LGPL-3.0 and carries its own licence text, but the others are MIT and BSD-2-Clause - and
both of those require the copyright notice to travel with the binary. Before this file, nothing did: the
payload shipped with one licence file and no notices for anything it contains.

The assembly list comes from the payload, not from a list written here, so a library added by a future SMAPI
upgrade cannot be silently left out. Licences are recorded only where a source states them - each entry below
was resolved against nuget.org's registration API or the repository's own licence metadata, and
`audit-bundled-licences.py` re-runs that resolution.

Run: python tools/refresh-smapi-third-party-notices.py
"""

import pathlib
import subprocess
import sys

ROOT = pathlib.Path("assets/smapi")
PAYLOAD = ROOT / "win-x64"
OUTPUT = ROOT / "THIRD-PARTY-NOTICES.txt"

# Resolved from nuget.org's registration API (licenseExpression, or the licence page it points at) and from
# repository licence metadata. `audit-bundled-licences.py` performs that resolution; this table is its result.
ENTRIES = {
    # name -> (package, copyright holder, licence, source). No version: it is read from the assembly, because
    # the version whose licence applies is the one that shipped, not the newest one on the package feed.
    "0Harmony.dll": ("Lib.Harmony", "Andreas Pardeike", "MIT", "https://www.nuget.org/packages/Lib.Harmony"),
    "Markdig.dll": ("Markdig", "Alexandre Mutel", "BSD-2-Clause", "https://www.nuget.org/packages/Markdig"),
    "Mono.Cecil.dll": ("Mono.Cecil", "Jb Evain", "MIT", "https://www.nuget.org/packages/Mono.Cecil"),
    "Mono.Cecil.Mdb.dll": ("Mono.Cecil", "Jb Evain", "MIT", "https://www.nuget.org/packages/Mono.Cecil"),
    "Mono.Cecil.Pdb.dll": ("Mono.Cecil", "Jb Evain", "MIT", "https://www.nuget.org/packages/Mono.Cecil"),
    "MonoMod.Common.dll": (
        "MonoMod",
        "0x0ade and contributors",
        "MIT",
        "https://www.nuget.org/packages/MonoMod",
    ),
    "Newtonsoft.Json.dll": (
        "Newtonsoft.Json",
        "James Newton-King",
        "MIT",
        "https://www.nuget.org/packages/Newtonsoft.Json",
    ),
    "Pathoschild.Http.Client.dll": (
        "Pathoschild.Http.FluentClient",
        "Jesse Plamondon-Willard",
        "MIT",
        "https://www.nuget.org/packages/Pathoschild.Http.FluentClient",
    ),
    "Pintail.dll": ("Pintail", "Nanoray", "MIT", "https://www.nuget.org/packages/Pintail"),
    "System.Net.Http.Formatting.dll": (
        "Microsoft.AspNet.WebApi.Client",
        "Microsoft Corporation",
        "MIT",
        "https://www.nuget.org/packages/Microsoft.AspNet.WebApi.Client",
    ),
    "TMXTile.dll": ("TMXTile", "Jesse Plamondon-Willard", "MIT", "https://github.com/Pathoschild/TMXTile"),
    "VdfConverter.dll": (
        "VdfConverter",
        "Gerhard van Zyl",
        "MIT",
        "https://www.nuget.org/packages/VdfConverter",
    ),
}

# Part of SMAPI itself, so its licence is the SMAPI licence already shipped in SMAPI-LICENSE.txt.
SMAPI_OWN = (
    "StardewModdingAPI.dll",
    # SMAPI's own toolkit assemblies: same repository, same licence.
    "smapi-internal/SMAPI.Toolkit.dll",
    "smapi-internal/SMAPI.Toolkit.CoreInterfaces.dll",
    "Mods/ConsoleCommands/ConsoleCommands.dll",
    "Mods/SaveBackup/SaveBackup.dll",
)

MIT_TEXT = """MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE."""

BSD_TEXT = """BSD 2-Clause License

Redistribution and use in source and binary forms, with or without modification, are
permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of
   conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of
   conditions and the following disclaimer in the documentation and/or other materials
   provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS
OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE."""



def assembly_version(path: pathlib.Path) -> str:
    """The file version the assembly itself carries.

    Windows version resources append a revision field (13.0.4.30916); the notice states the package version a
    reader can match against the feed, so the trailing build field is dropped when there are four parts.
    """
    script = (
        "$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo('{0}'); "
        "Write-Output ($v.FileVersion)"
    ).format(str(path).replace("'", "''"))
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True
    )
    raw = (result.stdout or "").strip()
    parts = raw.split(".")
    if len(parts) == 4:
        parts = parts[:3]
    return ".".join(parts)


def main() -> int:
    libraries = sorted(
        path.relative_to(PAYLOAD).as_posix() for path in PAYLOAD.rglob("*.dll")
    )

    missing = [
        library
        for library in libraries
        if library not in SMAPI_OWN and library.split("/")[-1] not in ENTRIES
    ]
    if missing:
        sys.stdout.buffer.write(
            (
                "cannot write notices: no licence entry for\n  "
                + "\n  ".join(missing)
                + "\n\n"
                "Resolve each one with tools/sandbox/audit-bundled-licences.py and add it to ENTRIES. "
                "Writing the file with an unknown library would be worse than shipping none.\n"
            ).encode("utf-8", errors="replace")
        )
        return 1

    lines = [
        "Third-party libraries included with the GameBuddy SMAPI payload",
        "",
        "The files under `win-x64/` are the unmodified SMAPI release payload, extracted from the official",
        "`SMAPI-4.5.2-installer.zip`. SMAPI itself is distributed under the GNU Lesser General Public",
        "License, version 3; its full text and source location are in `SMAPI-LICENSE.txt` in this folder.",
        "",
        "The directories below `Mods/` and the SMAPI assemblies themselves are part of SMAPI.",
        "",
        "Every other assembly is a separate library with its own licence, listed here with the copyright",
        "holder its own metadata names. GameBuddy ships them unmodified, as part of that payload.",
        "",
        "  assembly                                   project / assembly version       licence        copyright",
        "  " + "-" * 112,
    ]
    for library in libraries:
        if library in SMAPI_OWN:
            # Named here so the document covers the whole payload: a reader (and the gate) can ask "is every
            # bundled assembly accounted for?" without knowing which ones belong to SMAPI.
            version = assembly_version(PAYLOAD / library.replace("/", "/"))
            label = "SMAPI {}".format(version) if version else "SMAPI"
            lines.append(
                "  {:<42} {:<33} {:<14} {}".format(library, label, "LGPL-3.0", "see SMAPI-LICENSE.txt")
            )
            continue
        name = library.split("/")[-1]
        project, holder, licence, _ = ENTRIES[name]
        version = assembly_version(PAYLOAD / library.replace("/", "/"))
        label = "{} {}".format(project, version) if version else project
        lines.append(
            "  {:<42} {:<33} {:<14} {}".format(library, label, licence, holder)
        )

    lines += [
        "",
        "Source locations, one per project:",
    ]
    for name in sorted(ENTRIES):
        project, _, licence, url = ENTRIES[name]
        lines.append("  {:<40} {:<14} {}".format(project, licence, url))

    lines += [
        "",
        "=" * 116,
        "MIT License (applies to every library listed above as MIT)",
        "",
        "Copyright notices are per library, as named in the table above.",
        "",
        MIT_TEXT,
        "",
        "=" * 116,
        "BSD 2-Clause License (Markdig)",
        "",
        "Copyright (c) Alexandre Mutel. All rights reserved.",
        "",
        BSD_TEXT,
        "",
    ]

    OUTPUT.write_text("\n".join(lines), encoding="utf-8")
    sys.stdout.buffer.write(
        (
            "wrote {} ({} libraries, {} payload assemblies)\n".format(
                OUTPUT, len(ENTRIES), len(libraries)
            )
        ).encode("utf-8", errors="replace")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
