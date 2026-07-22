#!/usr/bin/env bash
# 构建自包含 relay 二进制：静态导出网页 → 内嵌 → 编译。
# 目标服务器无需 Node，单文件即含网页 + 中继。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"

echo "[1/3] building web (static export)…"
( cd "$root/web" && npm ci && npm run build )

echo "[2/3] embedding web into server/web_dist…"
rm -rf "$here/web_dist"
cp -r "$root/web/out" "$here/web_dist"

echo "[3/3] compiling binaries…"
mkdir -p "$here/dist"
( cd "$here"
  GOOS=linux   GOARCH=amd64 go build -buildvcs=false -trimpath -ldflags="-s -w" -o dist/vpetllm-relay-linux-amd64 .
  GOOS=windows GOARCH=amd64 go build -buildvcs=false -trimpath -ldflags="-s -w" -o dist/vpetllm-relay-windows-amd64.exe .
)
echo "done -> server/dist/"
