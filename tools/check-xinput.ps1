[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class XInputProbe {
    [DllImport("xinput1_4.dll", EntryPoint="XInputGetState")]
    public static extern uint GetState(uint userIndex, IntPtr state);
}
"@

$found = @()
$state = [Runtime.InteropServices.Marshal]::AllocHGlobal(16)
try {
    for ($i = 0; $i -lt 4; $i++) {
        for ($offset = 0; $offset -lt 16; $offset++) {
            [Runtime.InteropServices.Marshal]::WriteByte($state, $offset, 0)
        }
        $rc = [XInputProbe]::GetState($i, $state)
        if ($rc -eq 0) { $found += $i }
    }
}
finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($state)
}
if ($found.Count -eq 0) {
    Write-Error "No XInput controller endpoint is currently available. Local co-op Farmhand join cannot be automated without a real or explicitly provisioned controller endpoint."
    exit 2
}
Write-Output ("XInput user indices available: " + ($found -join ","))
