param(
    [string]$RepoName = "auto-sub",
    [string]$GitHubUser = "lndavid1",
    [switch]$OneShot
)

$ErrorActionPreference = "Continue"
$gitCmd = "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd"
$gitBin = "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\mingw64\bin"
$env:PATH += ";$gitCmd;$gitBin"

$WorkspaceDir = "E:\tool\auto sub"
Set-Location $WorkspaceDir

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  AUTO-SYNC GITHUB: https://github.com/$GitHubUser/$RepoName" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan

# 1. Kiểm tra đăng nhập GitHub qua Git Credential Manager
$accounts = & "$gitBin\git-credential-manager.exe" github list 2>$null
if (-not $accounts) {
    Write-Host "[1/4] Đang mở trình duyệt để xác thực tài khoản GitHub ($GitHubUser)..." -ForegroundColor Yellow
    & "$gitBin\git-credential-manager.exe" github login --browser
}

# 2. Lấy token từ git credential để tự động kiểm tra/khởi tạo repo trên GitHub nếu chưa có
$credInput = "protocol=https`nhost=github.com`n`n"
$credOutput = $credInput | git credential fill 2>$null
$token = $null
foreach ($line in $credOutput) {
    if ($line -match "^password=(.+)$") {
        $token = $Matches[1].Trim()
    }
}

if ($token) {
    $headers = @{
        "Authorization" = "Bearer $token"
        "Accept"        = "application/vnd.github+json"
        "User-Agent"    = "ActionSubGemini-AutoSync"
    }
    try {
        $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$GitHubUser/$RepoName" -Headers $headers -Method Get -ErrorAction Stop
        Write-Host "[2/4] Đã kết nối tới repository: https://github.com/$GitHubUser/$RepoName" -ForegroundColor Green
    } catch {
        Write-Host "[2/4] Đang tự động tạo repository '$RepoName' trên GitHub của $GitHubUser..." -ForegroundColor Yellow
        $body = @{
            name        = $RepoName
            description = "ActionSubGemini - Premiere Pro AI Subtitler & Storyline Unifier"
            private     = $false
            auto_init   = $false
        } | ConvertTo-Json
        try {
            $created = Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Headers $headers -Method Post -Body $body -ContentType "application/json" -ErrorAction Stop
            Write-Host "✓ Đã tạo thành công: $($created.html_url)" -ForegroundColor Green
        } catch {
            Write-Host "⚠️ Không thể tạo repo tự động: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

# 3. Đảm bảo remote origin đúng địa chỉ và thực hiện Commit + Push ngay lập tức
$remoteUrl = "https://github.com/$GitHubUser/$RepoName.git"
git remote set-url origin $remoteUrl 2>$null
if ($LASTEXITCODE -ne 0) {
    git remote add origin $remoteUrl 2>$null
}

function Sync-Now {
    Set-Location $WorkspaceDir
    $changes = git status --porcelain 2>$null
    if ($changes) {
        $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Write-Host "[$ts] Phát hiện thay đổi -> Đang commit & push lên GitHub..." -ForegroundColor Yellow
        git add -A
        git commit -m "Auto-update: $ts" | Out-Null
        git push -u origin main
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[$ts] ✓ Đã đồng bộ thành công lên https://github.com/$GitHubUser/$RepoName" -ForegroundColor Green
        }
    } else {
        # Đẩy các commit local chưa push (nếu có)
        $unpushed = git log origin/main..HEAD --oneline 2>$null
        if ($unpushed -or -not (git rev-parse --verify origin/main 2>$null)) {
            $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            Write-Host "[$ts] Đang đẩy code lên GitHub..." -ForegroundColor Yellow
            git push -u origin main
            if ($LASTEXITCODE -eq 0) {
                Write-Host "[$ts] ✓ Đã đồng bộ thành công lên https://github.com/$GitHubUser/$RepoName" -ForegroundColor Green
            }
        }
    }
}

Write-Host "[3/4] Đang đồng bộ toàn bộ mã nguồn hiện tại..." -ForegroundColor Cyan
Sync-Now

if ($OneShot) {
    exit 0
}

# 4. Theo dõi thay đổi file theo thời gian thực (FileSystemWatcher)
Write-Host "[4/4] Đang bật chế độ tự động cập nhật GitHub mỗi khi có chỉnh sửa file..." -ForegroundColor Green
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
