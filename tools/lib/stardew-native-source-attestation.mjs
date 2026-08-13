import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function collectCSharpSources(root) {
  const pending = [path.resolve(root)];
  const sourceFiles = {};
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".cs")) {
        const text = await readFile(absolute, "utf8");
        const relativePath = path.relative(root, absolute).split(path.sep).join("/");
        sourceFiles[relativePath] = Object.freeze({ text, sha256: sha256(Buffer.from(text, "utf8")) });
      }
    }
  }
  return Object.freeze(sourceFiles);
}

export function sourceManifestSha256(sourceFiles) {
  return sha256(
    JSON.stringify(
      Object.entries(sourceFiles)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([relativePath, source]) => ({ relativePath, sha256: source.sha256 })),
    ),
  );
}

export async function fileSha256(filePath) {
  return sha256(await readFile(path.resolve(filePath)));
}
