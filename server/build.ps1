# 构建自包含 relay 二进制：静态导出网页 -> 内嵌 -> 编译。
# 目标服务器无需 Node，单文件即含网页 + 中继。
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

Write-Host "[1/3] building web (static export)..."
Push-Location "$root\web"
npm ci; if (-not $?) { throw "npm ci failed" }
npm run build; if (-not $?) { throw "npm run build failed" }
Pop-Location

Write-Host "[2/3] embedding web into server\web_dist..."
if (Test-Path "$here\web_dist") { Remove-Item -Recurse -Force "$here\web_dist" }
Copy-Item -Recurse "$root\web\out" "$here\web_dist"

Write-Host "[3/3] compiling binaries..."
New-Item -ItemType Directory -Force "$here\dist" | Out-Null
Push-Location $here
$env:GOOS="linux";   $env:GOARCH="amd64"; go build -buildvcs=false -trimpath -ldflags="-s -w" -o dist/vpetllm-relay-linux-amd64 .
$env:GOOS="windows"; $env:GOARCH="amd64"; go build -buildvcs=false -trimpath -ldflags="-s -w" -o dist/vpetllm-relay-windows-amd64.exe .
$env:GOOS=""; $env:GOARCH=""
Pop-Location
Write-Host "done -> server\dist\"
