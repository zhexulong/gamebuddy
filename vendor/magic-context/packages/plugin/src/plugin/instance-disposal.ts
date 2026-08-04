import path from "node:path";

export function isDisposedInstanceDirectory(
    ownDirectory: string,
    disposedDirectory: string,
): boolean {
    return path.resolve(disposedDirectory) === path.resolve(ownDirectory);
}
