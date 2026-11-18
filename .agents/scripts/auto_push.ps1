$ErrorActionPreference = "SilentlyContinue"
$gitCmd = "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd"
$gitBin = "C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\mingw64\bin"
$env:PATH += ";$gitCmd;$gitBin"

Set-Location "E:\tool\auto sub"

$status = git status --porcelain 2>$null
if ($status) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    git add -A *>$null
    git commit -m "Auto-update: $timestamp" *>$null
}

# Push to GitHub if authenticated
$accounts = & "$gitBin\git-credential-manager.exe" github list 2>$null
if ($accounts) {
    git push -u origin main *>$null
    if ($LASTEXITCODE -ne 0) {
        # Auto-create repo on GitHub if it doesn't exist yet
        $credOutput = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
        $token = $null
        foreach ($line in $credOutput) {
            if ($line -match "^password=(.+)$") { $token = $Matches[1].Trim() }
        }
        if ($token) {
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

# Output empty JSON object required by Antigravity PostToolUse hook contract
Write-Output "{}"
