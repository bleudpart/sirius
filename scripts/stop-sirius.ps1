[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$FrontendProcessId,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$BackendPort
)

# Leave time for the HTTP 202 response to reach the HUD before stopping its server.
Start-Sleep -Milliseconds 500

$backendProcessIds = @(
    Get-NetTCPConnection -State Listen |
        Where-Object { $_.LocalPort -eq $BackendPort } |
        Select-Object -ExpandProperty OwningProcess -Unique
)

if ($backendProcessIds.Count -eq 0) {
    Write-Output "No backend listener found on port $BackendPort."
} else {
    foreach ($backendProcessId in $backendProcessIds) {
        Write-Output "Stopping backend process $backendProcessId."
        Stop-Process -Id $backendProcessId -ErrorAction Stop
    }
}

$frontendProcess = Get-Process -Id $FrontendProcessId -ErrorAction SilentlyContinue
if ($null -eq $frontendProcess) {
    Write-Output "Frontend process $FrontendProcessId already stopped."
    exit 0
}

Write-Output "Stopping frontend process $FrontendProcessId."
Stop-Process -Id $FrontendProcessId -ErrorAction Stop
