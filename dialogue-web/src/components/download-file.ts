/**
 * Saves the Host's own bytes through the browser's download surface: one object URL, one click on
 * an anchor carrying the Host's own file name, and the URL released on a later task so the download
 * has already begun reading it.
 *
 * Both downloads on the Characters surface - her card and a library item's lorebook - go through
 * here, so the file name is always the Host's and there is one place that knows how a file leaves
 * the browser.
 */
export function downloadFile(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
