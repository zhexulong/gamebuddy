import type { DesktopGuardianSession } from "../containment/auth/desktop-guardian-session.internal.js";

type DesktopHostComposition = Readonly<{
  close(): Promise<void>;
}>;

/** Retains the authenticated desktop session until the host lifecycle closes. */
export function createDesktopPrivateHostComposition(session: DesktopGuardianSession): DesktopHostComposition {
  let sessionClosePromise: Promise<void> | undefined;
  return Object.freeze({
    close: () => sessionClosePromise ??= session.close(),
  });
}
