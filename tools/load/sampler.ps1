# Resource sampler for tools/load: one JSON line per interval with cumulative CPU time and memory of the watched
# processes, NIC byte counters and NVIDIA GPU utilisation. The control file (JSON, re-read every interval) lists:
#   gen: PIDs of the load generator (node, its MediaMTX instances), browser: root PIDs whose trees are the browser sampler,
#   targetPids / targetTree: target PIDs (tree = the PID and all its descendants), targetNames + targetPathLike: name/path filter.
# Rates are computed by the caller from consecutive lines; this script only reads counters. lib/resources.mjs runs it as
# an inline -Command script block (no script-file execution policy change needed).
param([int]$IntervalMs = 2000, [string]$Control = '')
$ErrorActionPreference = 'SilentlyContinue'
$nvsmi = (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source

function Describe($p, $group) {
  @{ g = $group; id = $p.Id; name = $p.ProcessName; path = $p.Path; cpuMs = [math]::Round($p.TotalProcessorTime.TotalMilliseconds); ws = $p.WorkingSet64; priv = $p.PrivateMemorySize64; threads = $p.Threads.Count; handles = $p.HandleCount }
}

# Non-empty values only (@($null) has one element in PowerShell 5.1).
function L($v) { @($v | Where-Object { $_ }) }

function Tree($roots, $all) {
  $set = @{}
  foreach ($r in $roots) { $set[[int]$r] = $true }
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($w in $all) { if ($set.ContainsKey([int]$w.ParentProcessId) -and -not $set.ContainsKey([int]$w.ProcessId)) { $set[[int]$w.ProcessId] = $true; $grew = $true } }
  }
  @($set.Keys)
}

while ($true) {
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $c = @{}
  if ($Control -and (Test-Path $Control)) { try { $c = Get-Content $Control -Raw | ConvertFrom-Json } catch {} }
  $all = $null
  if ((L $c.targetTree).Count -or (L $c.browser).Count) { $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId) }
  $groups = @{}
  foreach ($id in (L $c.gen) + @($PID)) { $groups[[int]$id] = 'g' }
  if ($all) { foreach ($id in (Tree (L $c.browser) $all)) { if (-not $groups.ContainsKey([int]$id)) { $groups[[int]$id] = 'b' } } }
  $targetIds = L $c.targetPids
  if ($all -and (L $c.targetTree).Count) { $targetIds += Tree (L $c.targetTree) $all }
  foreach ($id in $targetIds) { if (-not $groups.ContainsKey([int]$id)) { $groups[[int]$id] = 't' } }
  $procs = @()
  foreach ($id in @($groups.Keys)) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { $procs += Describe $p $groups[$id] } }
  if ((L $c.targetNames).Count) {
    $likes = L $c.targetPathLike
    foreach ($p in @(Get-Process -Name (L $c.targetNames) -ErrorAction SilentlyContinue)) {
      if ($groups.ContainsKey([int]$p.Id)) { continue }
      $path = $p.Path
      if ($likes.Count -and -not ($likes | Where-Object { $path -like $_ })) { continue }
      $procs += Describe $p 't'
    }
  }
  $nics = @(Get-NetAdapterStatistics | ForEach-Object { @{ name = $_.Name; rx = $_.ReceivedBytes; tx = $_.SentBytes } })
  $gpu = $null
  if ($nvsmi) {
    $line = & $nvsmi --query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,memory.used --format=csv,noheader,nounits | Select-Object -First 1
    if ($line) { $v = $line -split ',\s*'; $gpu = @{ util = [int]$v[0]; enc = [int]$v[1]; dec = [int]$v[2]; memMB = [int]$v[3] } }
  }
  $out = @{ t = $t0; self = $PID; procs = $procs; nics = $nics; gpu = $gpu; ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0 }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Depth 4 -Compress))
  [Console]::Out.Flush()
  $rest = $IntervalMs - ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0)
  if ($rest -gt 0) { Start-Sleep -Milliseconds $rest }
}
