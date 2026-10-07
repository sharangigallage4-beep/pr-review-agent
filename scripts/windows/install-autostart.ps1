<#
.SYNOPSIS
  Makes the PR Review Assistant UI start by itself when you sign in to Windows.

.DESCRIPTION
  Creates a shortcut to start-ui.cmd in YOUR Startup folder (no administrator rights, nothing
  system-wide). Run it again to refresh the shortcut, or run with -Remove to undo it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1 -Remove
#>
param([switch]$Remove)

$link = Join-Path ([Environment]::GetFolderPath('Startup')) 'PR Review Assistant.lnk'

if ($Remove) {
  if (Test-Path $link) { Remove-Item $link; Write-Host "Removed: $link" } else { Write-Host 'Nothing to remove.' }
  return
}

$target = Join-Path $PSScriptRoot 'start-ui.cmd'
if (-not (Test-Path $target)) { throw "Cannot find $target" }

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$shortcut.WindowStyle = 7   # start minimized
$shortcut.Description = 'PR Review Assistant (web UI)'
$shortcut.Save()

Write-Host "Done. The UI will start when you sign in to Windows: $link"
Write-Host 'To undo it: run this script again with -Remove.'
