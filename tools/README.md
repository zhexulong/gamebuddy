# Local Stardew automation tools

These scripts support repeatable local-co-op smoke preparation without editing game memory, save data, or multiplayer state.

## XInput gate

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-xinput.ps1
```

The probe calls the Windows XInput API for users 0-3. It exits non-zero when no controller endpoint is available. A virtual controller bus driver alone is not an endpoint.

## Window driver

The driver requires a target Stardew/SMAPI PID and verifies the process path and window title before focusing or sending a key. Input is disabled unless `-AllowInput` is supplied.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/drive-stardew-ui.ps1 -ProcessId <pid> -Action Focus
powershell -NoProfile -ExecutionPolicy Bypass -File tools/drive-stardew-ui.ps1 -ProcessId <pid> -Action StartLocalCoop -AllowInput
```

`StartLocalCoop` first runs `check-xinput.ps1` and refuses to send any input unless a real or explicitly provisioned second XInput endpoint exists. The script only navigates the visible Stardew menu; the game itself must perform Farmhand creation and local-co-op state changes.

The scripts do not install drivers, inject a Farmer, edit saves, bypass Steam, or emulate multiplayer packets. A driver-backed virtual XInput device must be provisioned separately and deliberately by the operator.
