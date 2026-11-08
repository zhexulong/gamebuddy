# Checking for and installing a GameBuddy update

GameBuddy can tell you whether a newer release exists, and can download and start its own installer. Both are
commands you run; nothing updates itself in the background.

## Check

```
"%LOCALAPPDATA%\Programs\GameBuddy\GameBuddy.Desktop.exe" --check-update "https://github.com/zhexulong/gamebuddy/releases/latest/download/release-manifest.json"
```

It prints one line:

| Output | Meaning |
|---|---|
| `update:up_to_date:0.1.0` | you already have the newest release |
| `update:available:0.2.0` then `update:download:<url>` | a newer release exists, and this is its installer |
| `update:manifest_unusable:<reason>` | the release description could not be trusted, so nothing will be installed |
| `update:source_unavailable:<reason>` | the manifest could not be fetched |
| `update:installed_version_unknown` | this installation has no release record, so there is nothing to compare |

## Install

```
"%LOCALAPPDATA%\Programs\GameBuddy\GameBuddy.Desktop.exe" --apply-update "https://github.com/zhexulong/gamebuddy/releases/latest/download/release-manifest.json"
```

What it does, in this order, and stops at the first step that fails:

1. reads the manifest and refuses it unless the download URL is on the repository the manifest itself names;
2. downloads the installer **without following redirects** - a redirect is where a pinned address stops meaning
   what it says;
3. checks the installer's size and SHA-256 against the manifest, which catches a truncated download from a dropped
   connection and a stale file served from an edge cache;
4. writes it to a temporary name beside its final path and renames only after the check passes, so a half-written
   file is never executable;
5. refuses anything that is not strictly newer than what you have, so an old release cannot be replayed at you;
6. starts the installer **after GameBuddy exits** - the installer refuses to replace a running product - and prints
   the path it staged, so you can see exactly which bytes will run.

Output is `update:staged:<path>`, `update:version:<version>`, `update:installing`, or a refusal:
`update:not_newer`, `update:installer_digest_mismatch:<reason>`, `update:download_failed:<reason>`,
`update:staging_failed:<reason>`, `update:manifest_unusable:<reason>`.

## What protects you, and what does not

The installer is **not code-signed** yet. What vouches for the bytes is HTTPS to `github.com` plus the SHA-256 the
manifest carries; there is no publisher identity attested by the file itself, so Windows SmartScreen may warn on
first run and you should compare the checksum in the release notes before running anything:

```
certutil -hashfile GameBuddy.Setup.exe SHA256
```

What that does protect you from: a truncated or corrupted download, a file swapped between download and execution,
a manifest pointing at some other host, and a replay of an older release.

## Going back

If an update turns out badly, the previous release is still on disk:

```
"%LOCALAPPDATA%\Programs\GameBuddy\GameBuddy.Desktop.exe" --rollback
```

It prints `rollback:restored` and the next launch starts that generation. Running it again steps forward, so a
rollback is not a one-way door.
