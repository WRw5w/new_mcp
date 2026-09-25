param(
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$profile = if ($env:AIC_LEADERBOARD_CHROME_PROFILE) { $env:AIC_LEADERBOARD_CHROME_PROFILE } else { Join-Path $env:TEMP "aic_leaderboard_chrome_profile" }
$url = if ($env:AIC_LEADERBOARD_SUBMIT_URL) { $env:AIC_LEADERBOARD_SUBMIT_URL } else { "https://reg.aicomp.cn/" }
$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $chrome) {
  throw "Chrome executable not found."
}

if ($Restart) {
  $escapedProfile = [WildcardPattern]::Escape($profile)
  $targets = Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
    Where-Object { $_.CommandLine -like "*$escapedProfile*" }
  foreach ($target in $targets) {
    Stop-Process -Id $target.ProcessId -Force
  }
  Start-Sleep -Seconds 2
}

$args = @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profile",
  "--no-first-run",
  "--new-window",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=CalculateNativeWinOcclusion,MemorySaver",
  $url
)

Start-Process -FilePath $chrome -ArgumentList $args -WindowStyle Normal
Write-Host "AICOMP Chrome started with anti-throttling flags."
