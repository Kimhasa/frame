# Cost of the window-picker thumbnails in the running FrameConsole.exe (DevTools 9222): the list is opened and closed
# -Cycles times (open, -OpenMs wait, close, 500 ms); FrameConsole's CPU time, private memory, handles and GDI/USER objects
# are read before, after each cycle and 3 s after the last one (cleanup), and the GPU engines' utilization for its
# process is sampled every 0.5 s meanwhile. Writes verification/window-preview/cost-<Label>.json.
#   powershell -File tools\measure-window-preview-cost.ps1 -Label after [-Cycles 5] [-OpenMs 1500]
param([Parameter(Mandatory)] [string]$Label, [int]$Cycles = 5, [int]$OpenMs = 1500)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class Gui { [DllImport("user32.dll")] public static extern uint GetGuiResources(IntPtr process, uint flags); }
'@
$root = Split-Path $PSScriptRoot
$p = Get-Process FrameConsole -ErrorAction Stop | Select-Object -First 1
function Sample($tag) {
  $p.Refresh()
  [pscustomobject]@{ tag = $tag; cpuMs = [math]::Round($p.TotalProcessorTime.TotalMilliseconds); privateMB = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
    handles = $p.HandleCount; gdi = [Gui]::GetGuiResources($p.Handle, 0); user = [Gui]::GetGuiResources($p.Handle, 1); threads = $p.Threads.Count }
}
$gpu = Start-Job -ArgumentList $p.Id, ($Cycles * ($OpenMs + 900) / 1000 + 2) -ScriptBlock {
  param($id, $seconds)
  $samples = @()
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    try { $c = Get-Counter "\GPU Engine(pid_${id}_*)\Utilization Percentage" -ErrorAction Stop; $samples += ,($c.CounterSamples | ForEach-Object { [pscustomobject]@{ engine = ($_.InstanceName -replace '.*engtype_', ''); value = $_.CookedValue } }) } catch {}
    Start-Sleep -Milliseconds 500
  }
  $samples | ForEach-Object { $_ } | Group-Object engine | ForEach-Object { [pscustomobject]@{ engine = $_.Name; max = [math]::Round(($_.Group | Measure-Object value -Maximum).Maximum, 1); mean = [math]::Round(($_.Group | Measure-Object value -Average).Average, 2) } }
}
$samples = @(Sample 'before')
$cycle = @"
import { app, sleep } from './app-flow.mjs';
const a = await app();
await a.evaluate("(document.getElementById('source-row').hidden ? document.getElementById('source-empty-button') : document.getElementById('source-button')).click()");
await sleep($OpenMs);
await a.evaluate("document.querySelector('#source-dialog .dialog-footer [data-close]').click()");
a.close();
"@
$script = Join-Path $PSScriptRoot '.cycle-window-preview.mjs'
Set-Content -Path $script -Value $cycle -Encoding UTF8
Push-Location $root
for ($i = 1; $i -le $Cycles; $i++) { node $script | Out-Null; Start-Sleep -Milliseconds 500; $samples += Sample "cycle $i" }
Pop-Location
Remove-Item $script
Start-Sleep 3
$samples += Sample 'after 3 s'
$engines = @(Receive-Job $gpu -Wait -AutoRemoveJob | Select-Object engine, max, mean)
$result = [pscustomobject]@{ label = $Label; measuredAt = (Get-Date).ToString('o'); cycles = $Cycles; openMs = $OpenMs; windows = $null
  cpuMsPerOpen = [math]::Round(($samples[-2].cpuMs - $samples[0].cpuMs) / $Cycles); samples = $samples; gpuEngines = $engines }
$result | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $root "verification\window-preview\cost-$Label.json") -Encoding UTF8
$samples | Format-Table -AutoSize | Out-String
"CPU per open: $($result.cpuMsPerOpen) ms"
$engines | Where-Object { $_.max -gt 0 } | Format-Table -AutoSize | Out-String
