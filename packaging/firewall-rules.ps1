# FRAME Console inbound rules. FRAME Console never changes firewall settings itself; an administrator reviews and
# runs this once per PC when the Windows Security prompt was dismissed or standard users cannot allow access.
#   powershell -ExecutionPolicy Bypass -File tools\firewall-rules.ps1                        (Private networks)
#   powershell -ExecutionPolicy Bypass -File tools\firewall-rules.ps1 -Profile Any           (also Public/Domain)
#   powershell -ExecutionPolicy Bypass -File tools\firewall-rules.ps1 -RemoveBlockRules      (also delete the Block
#        rules Windows creates for these two programs when its security prompt is cancelled; Block wins over Allow)
#   powershell -ExecutionPolicy Bypass -File tools\firewall-rules.ps1 -Remove                (remove the Allow rules)
param(
  [int]$ViewerPort = 8889,   # viewer page + WHEP (FrameConsole.exe, TCP)
  [int]$IceUdpPort = 8189,   # WebRTC media (mediamtx.exe, UDP)
  [int]$IceTcpPort = 8189,   # WebRTC media fallback (mediamtx.exe, TCP)
  [int]$DiscoveryPort = 8899, # broadcast list announcements between FRAME PCs (FrameConsole.exe, UDP multicast)
  [ValidateSet('Private', 'Domain', 'Public', 'Any')][string]$Profile = 'Private',
  [switch]$RemoveBlockRules,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root 'FrameConsole.exe'
$mtx = Join-Path $root 'bin\mediamtx.exe'
$names = 'FRAME Console viewer (TCP)', 'FRAME Console WebRTC (UDP)', 'FRAME Console WebRTC (TCP)', 'FRAME Console discovery (UDP)'
Get-NetFirewallRule -DisplayName $names -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { 'Removed FRAME Console rules.'; return }
if ($RemoveBlockRules) {
  $blocked = Get-NetFirewallApplicationFilter | Where-Object { $_.Program -ieq $app -or $_.Program -ieq $mtx } | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }
  $blocked | ForEach-Object { "Removing block rule: $($_.DisplayName) ($($_.Profile))" }
  $blocked | Remove-NetFirewallRule
}
New-NetFirewallRule -DisplayName $names[0] -Direction Inbound -Action Allow -Profile $Profile -Program $app -Protocol TCP -LocalPort $ViewerPort | Out-Null
New-NetFirewallRule -DisplayName $names[1] -Direction Inbound -Action Allow -Profile $Profile -Program $mtx -Protocol UDP -LocalPort $IceUdpPort | Out-Null
New-NetFirewallRule -DisplayName $names[2] -Direction Inbound -Action Allow -Profile $Profile -Program $mtx -Protocol TCP -LocalPort $IceTcpPort | Out-Null
New-NetFirewallRule -DisplayName $names[3] -Direction Inbound -Action Allow -Profile $Profile -Program $app -Protocol UDP -LocalPort $DiscoveryPort | Out-Null
"Added rules for $app (TCP $ViewerPort, UDP $DiscoveryPort) and $mtx (UDP $IceUdpPort, TCP $IceTcpPort) on profile $Profile."
