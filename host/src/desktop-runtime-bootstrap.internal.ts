/**
 * Fixed artifact-relative Desktop bootstrap entry. Desktop integration supplies
 * authenticated inputs later; this entry has no runtime ingress of its own.
 */
export const DESKTOP_RUNTIME_BOOTSTRAP_ENTRY = Object.freeze({
  schema: "gamebuddy-desktop-runtime-bootstrap-entry/v1",
  entry: "desktop-runtime-bootstrap.internal.js",
});
