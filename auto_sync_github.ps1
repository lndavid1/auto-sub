param(
    [string]$RepoName = "auto-sub",
    [string]$GitHubUser = "lndavid1"
)

$ErrorActionPreference = "Continue"
$gitCmd = "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd"
$gitBin = "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\mingw64\bin"
$env:PATH += ";$gitCmd;$gitBin"

$WorkspaceDir = "E:\tool\auto sub"
Set-Location $WorkspaceDir

$tokenFile = Join-Path $WorkspaceDir ".git\gh_token.txt"
$deviceFile = Join-Path $WorkspaceDir ".git\device_flow.json"
$clientId = "178c6fc778ccc68e1d6a"

$token = $null
if (Test-Path $tokenFile) {
    $token = (Get-Content $tokenFile -Raw).Trim()
}

if (-not $token -and (Test-Path $deviceFile)) {
    $df = Get-Content $deviceFile -Raw | ConvertFrom-Json
    $interval = if ($df.interval) { [int]$df.interval + 1 } else { 6 }
    Write-Host "Đang chờ bạn nhập mã [$($df.user_code)] tại $($df.verification_uri) ..." -ForegroundColor Yellow

    for ($i = 0; $i -lt 150; $i++) {
        Start-Sleep -Seconds $interval
        try {
            $poll = Invoke-RestMethod -Uri "https://github.com/login/oauth/access_token" -Method Post -Headers @{ Accept = "application/json" } -Body @{
                client_id   = $clientId
                device_code = $df.device_code
                grant_type  = "urn:ietf:params:oauth:grant-type:device_code"
            }
            if ($poll.access_token) {
                $token = $poll.access_token
                Set-Content -Path $tokenFile -Value $token -NoNewline
                Write-Host "✓ Đã xác thực GitHub thành công!" -ForegroundColor Green
                break
            } elseif ($poll.error -eq "slow_down") {
                $interval += 5
            } elseif ($poll.error -ne "authorization_pending") {
                Write-Host "Lỗi xác thực: $($poll.error)" -ForegroundColor Red
                break
            }
        } catch {
            Start-Sleep -Seconds 3
        }
    }
}

if (-not $token) {
    Write-Host "Chưa có token xác thực GitHub." -ForegroundColor Red
    exit 1
}

# Cấu hình remote chứa token trong local .git/config để push tự động không cần hỏi lại
$authedRemote = "https://${GitHubUser}:${token}@github.com/${GitHubUser}/${RepoName}.git"
git remote set-url origin $authedRemote 2>$null

# Tạo repository trên GitHub nếu chưa tồn tại
$headers = @{
    "Authorization" = "Bearer $token"
    "Accept"        = "application/vnd.github+json"
    "User-Agent"    = "ActionSubGemini-AutoSync"
}
try {
    $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$GitHubUser/$RepoName" -Headers $headers -Method Get -ErrorAction Stop
    Write-Host "✓ Đã kết nối tới repo: https://github.com/$GitHubUser/$RepoName" -ForegroundColor Green
} catch {
    Write-Host "Đang tạo repository '$RepoName' trên GitHub của $GitHubUser..." -ForegroundColor Yellow
    $body = @{
        name        = $RepoName
        description = "ActionSubGemini - Premiere Pro AI Subtitler & Storyline Unifier"
        private     = $false
        auto_init   = $false
    } | ConvertTo-Json
    try {
        $created = Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Headers $headers -Method Post -Body $body -ContentType "application/json" -ErrorAction Stop
        Write-Host "✓ Đã tạo repo mới: $($created.html_url)" -ForegroundColor Green
    } catch {
        Write-Host "⚠️ Lưu ý khi tạo repo: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Sync-Now {
    Set-Location $WorkspaceDir
    $changes = git status --porcelain 2>$null
    if ($changes) {
        $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        git add -A
        git commit -m "Auto-update: $ts" | Out-Null
    }
    git push -u origin main
    if ($LASTEXITCODE -eq 0) {
        $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Write-Host "[$ts] ✓ Đã đồng bộ lên https://github.com/$GitHubUser/$RepoName" -ForegroundColor Green
    }
}

Sync-Now

Write-Host "Đang theo dõi thay đổi file theo thời gian thực..." -ForegroundColor Cyan
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $WorkspaceDir
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $true

$lastChangeTime = [DateTime]::MinValue
$pendingSync = $false

while ($true) {
    $result = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All, 2000)
    if (-not $result.TimedOut) {
        $relName = $result.Name
        if ($relName -notmatch "^\.git(\\|$)" -and $relName -notmatch "\.tmp$") {
            $lastChangeTime = Get-Date
            $pendingSync = $true
        }
    }
    if ($pendingSync -and ((Get-Date) - $lastChangeTime).TotalSeconds -ge 2) {
        $pendingSync = $false
        Sync-Now
    }
}
