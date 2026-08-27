#!/bin/bash
# kimi-stats-bar 注入器:把统计条注入 cmux 内嵌浏览器里的 kimi web 页面
#
# 用法:
#   ./inject.sh              # 新开一个浏览器 pane 并注入
#   ./inject.sh surface:N    # 注入到已有浏览器 surface
#
# 注意:cmux 的 addinitscript 是累加的,同一 surface 重复注入会叠版本;
# 脚本内有 window.__kimiStatsBar 守卫,只有第一个生效。改了脚本想生效,
# 请 tab close 后重开 surface 再注入。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BAR_JS="$SCRIPT_DIR/kimi-stats-bar.js"
TOKEN_FILE="$HOME/.kimi-code/server.token"
INSTANCES_DIR="$HOME/.kimi-code/server/instances"

# 1. 找 kimi web server 端口(取心跳最新的实例)
PORT=$(python3 - "$INSTANCES_DIR" <<'EOF'
import glob, json, os, sys
files = glob.glob(os.path.join(sys.argv[1], '*.json'))
best = max(files, key=os.path.getmtime) if files else None
print(json.load(open(best))['port'] if best else '')
EOF
)
if [ -z "$PORT" ]; then
  echo "错误:没有找到运行中的 kimi web server,请先运行 kimi web(或 TUI 里 /web)" >&2
  exit 1
fi

if [ ! -f "$TOKEN_FILE" ]; then
  echo "错误:找不到 $TOKEN_FILE" >&2
  exit 1
fi
TOKEN=$(cat "$TOKEN_FILE")

# 2. 定位浏览器 surface
SURFACE="${1:-}"
if [ -z "$SURFACE" ]; then
  OUT=$(cmux browser open "http://127.0.0.1:$PORT/#token=$TOKEN")
  echo "$OUT"
  SURFACE=$(echo "$OUT" | grep -oE 'surface:[0-9]+')
  sleep 3  # 等页面加载,addinitscript 在加载中容易超时
fi

# 3. 注入并刷新(务必用多行原文件 + 位置参数;--script 单行形式有静默不生效的问题)
for i in 1 2 3; do
  if cmux browser "$SURFACE" addinitscript "$(cat "$BAR_JS")" >/dev/null 2>&1; then
    break
  fi
  echo "addinitscript 超时,重试 ($i/3)…" >&2
  sleep 2
done
cmux browser "$SURFACE" reload >/dev/null
echo "已注入到 $SURFACE 并刷新。"
