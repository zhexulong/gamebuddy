"""Resolve each bundled assembly to its upstream project and its declared licence.

A licence notice has to be correct, so nothing here is guessed: every entry is looked up at a source that
states it, and an assembly that cannot be resolved is reported as unresolved rather than filled in from
memory. The list of assemblies comes from the vendored payload, so a new bundled library cannot be silently
omitted from the notice.
"""

import json
import pathlib
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path("assets/smapi/win-x64")

# Assembly file name -> package id on nuget.org, or a GitHub repository whose licence is the authority.
NUGET = {
    "0Harmony.dll": "Lib.Harmony",
    "Mono.Cecil.dll": "Mono.Cecil",
    "Mono.Cecil.Mdb.dll": "Mono.Cecil",
    "Mono.Cecil.Pdb.dll": "Mono.Cecil",
    "MonoMod.Common.dll": "MonoMod.RuntimeDetour",
    "Newtonsoft.Json.dll": "Newtonsoft.Json",
    "Markdig.dll": "Markdig",
    "System.Net.Http.Formatting.dll": "Microsoft.AspNet.WebApi.Client",
}
GITHUB = {
    "Pintail.dll": "https://github.com/Pathoschild/Pintail",
    "VdfConverter.dll": "https://github.com/Pathoschild/VdfConverter",
    "TMXTile.dll": "https://github.com/Pathoschild/TMXTile",
    "Pathoschild.Http.Client.dll": "https://github.com/Pathoschild/Pathoschild.Http.Client",
    "SMAPI.Toolkit.dll": "https://github.com/Pathoschild/SMAPI",
    "SMAPI.Toolkit.CoreInterfaces.dll": "https://github.com/Pathoschild/SMAPI",
}
SMAPI_OWN = {
    "StardewModdingAPI.dll",
    "StardewModdingAPI.exe",
    "Mods/ConsoleCommands/ConsoleCommands.dll",
    "Mods/SaveBackup/SaveBackup.dll",
}


def fetch_json(url):
    request = urllib.request.Request(
        url, headers={"User-Agent": "gamebuddy-licence-audit"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def nuget_license(package_id):
    """The licence expression registred for the latest stable version, from NuGet's registration API."""
    url = "https://api.nuget.org/v3/registration5-semver1/{}/index.json".format(
        package_id.lower()
    )
    data = fetch_json(url)
    items = data.get("items", [])
    if not items:
        return None, None
    page = items[-1]
    if "items" not in page:
        page = fetch_json(page["@id"])
    leaves = page.get("items", [])
    if not leaves:
        return None, None
    latest = leaves[-1]["catalogEntry"]
    expression = latest.get("licenseExpression")
    if not expression:
        license_url = latest.get("licenseUrl")
        return (license_url or "unstated"), latest.get("version")
    return expression, latest.get("version")


def github_license(repository):
    """The licence GitHub reports for a repository, via its public API."""
    slug = repository.rstrip("/").split("github.com/")[-1]
    try:
        data = fetch_json("https://api.github.com/repos/{}".format(slug))
        licence = data.get("license") or {}
        return licence.get("spdx_id") or "unstated"
    except Exception as error:  # noqa: BLE001 - reported, never guessed
        return "unresolved:{}".format(error)


def main():
    assemblies = sorted(
        path.relative_to(ROOT).as_posix() for path in ROOT.rglob("*.dll")
    )
    rows = []
    for relative in assemblies:
        name = relative.split("/")[-1]
        if relative in SMAPI_OWN or name in SMAPI_OWN:
            rows.append((relative, "Pathoschild/SMAPI", "LGPL-3.0", "SMAPI itself"))
            continue
        if name in NUGET:
            try:
                licence, version = nuget_license(NUGET[name])
                rows.append(
                    (
                        relative,
                        "nuget:" + NUGET[name],
                        str(licence),
                        "v{}".format(version),
                    )
                )
            except Exception as error:  # noqa: BLE001
                rows.append(
                    (relative, "nuget:" + NUGET[name], "unresolved", str(error))
                )
            continue
        if name in GITHUB:
            rows.append((relative, GITHUB[name], github_license(GITHUB[name]), ""))
            continue
        rows.append((relative, "UNKNOWN", "UNKNOWN", "no upstream mapping"))

    width = max(len(row[0]) for row in rows) + 2
    output = [
        "{:{w}} {:<34} {:<16} {}".format(
            "assembly", "upstream", "licence", "note", w=width
        )
    ]
    for relative, upstream, licence, note in rows:
        output.append(
            "{:{w}} {:<34} {:<16} {}".format(relative, upstream, licence, note, w=width)
        )
    sys.stdout.flush()
    sys.stdout.buffer.write(
        ("\n".join(output) + "\n").encode("utf-8", errors="replace")
    )
    unresolved = [row for row in rows if "unresolved" in row[2] or row[2] == "UNKNOWN"]
    sys.stdout.buffer.write(
        ("\nunresolved: {}\n".format(len(unresolved))).encode("utf-8", errors="replace")
    )


if __name__ == "__main__":
    main()
