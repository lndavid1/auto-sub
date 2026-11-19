$ErrorActionPreference = "SilentlyContinue"
$gitCmd = "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd"
$gitBin = "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\mingw64\bin"
$env:PATH += ";$gitCmd;$gitBin"

Set-Location "E:\tool\auto sub"

# 1. Đồng bộ ngay lập tức sang thư mục CEP Extension của Premiere Pro
$cepExtDir = "$env:APPDATA\Adobe\CEP\extensions\ActionSubGemini"
if (Test-Path "E:\tool\auto sub\ActionSubGemini") {
    if (-not (Test-Path $cepExtDir)) {
        New-Item -ItemType Directory -Path $cepExtDir -Force *>$null
    }
    Copy-Item -Path "E:\tool\auto sub\ActionSubGemini\*" -Destination $cepExtDir -Recurse -Force *>$null
}

# 2. Tự động Commit vào Git
$status = git status --porcelain 2>$null
if ($status) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    git add -A *>$null
    git commit -m "Auto-update: $timestamp" *>$null
}

# 3. Tự động Push lên GitHub nếu đã có token
$tokenFile = "E:\tool\auto sub\.git\gh_token.txt"
if (Test-Path $tokenFile) {
    $token = (Get-Content $tokenFile -Raw).Trim()
    if ($token) {
        git push -u origin main *>$null
        if ($LASTEXITCODE -ne 0) {
            $headers = @{
                "Authorization" = "Bearer $token"
                "Accept"        = "application/vnd.github+json"
                "User-Agent"    = "ActionSubGemini-AutoSync"
            }
            $body = @{
                name        = "auto-sub"
                description = "ActionSubGemini - Premiere Pro AI Subtitler & Storyline Unifier"
                private     = $false
            } | ConvertTo-Json
            Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Headers $headers -Method Post -Body $body -ContentType "application/json" *>$null
            git push -u origin main *>$null
        }
    }
}

Write-Output "{}"
