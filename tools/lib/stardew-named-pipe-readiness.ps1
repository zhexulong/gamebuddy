Set-StrictMode -Version Latest

function Test-GameBuddyNamedPipeListening([Parameter(Mandatory = $true)][string]$PipeName) {
    # FileSystem Test-Path does not enumerate the Windows named-pipe namespace.
    # This namespace lookup is observational: unlike a client connection, it
    # cannot consume the bridge's single named-pipe server generation before
    # the authenticated Host opens it.
    try {
        $names = [System.IO.Directory]::GetFiles('\\.\pipe\')
        return $names | ForEach-Object { [IO.Path]::GetFileName($_) } | Where-Object { $_ -ceq $PipeName } | Select-Object -First 1 | ForEach-Object { $true }
    } catch [System.IO.IOException] {
        return $false
    } catch [System.UnauthorizedAccessException] {
        return $false
    }
}
