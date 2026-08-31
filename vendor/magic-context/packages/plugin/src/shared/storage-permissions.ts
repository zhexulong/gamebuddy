/**
 * Process-wide storage permission policy resolved from trusted user config.
 *
 * Storage is shared by OpenCode and Pi, so all writers consult one setting before
 * applying POSIX modes. The default preserves the historical owner-only policy.
 */
let enforcePrivateStoragePermissions = true;

export function setStoragePrivatePermissionEnforcement(enforce: boolean): void {
    enforcePrivateStoragePermissions = enforce;
}

export function shouldEnforcePrivateStoragePermissions(): boolean {
    return enforcePrivateStoragePermissions;
}

/** Test-only reset for suites that exercise both permission policies in one process. */
export function __resetStoragePrivatePermissionEnforcementForTests(): void {
    enforcePrivateStoragePermissions = true;
}
