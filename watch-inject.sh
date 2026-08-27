#!/bin/bash
# kimi-stats-bar 自动注入 watcher:轮询 cmux,发现打开 kimi web 的浏览器
# surface 就自动注入统计条,实现 "/web 后进去就有 bar"。
#
# 用法:
#   ./watch-inject.sh          # 前台运行,Ctrl+C 停止
#   nohup ./watch-inject.sh >/dev/null 2>&1 &   # 后台常驻
#
# 已注入的 surface 记录在脚本旁的 .injected-surfaces,不重复注入。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BAR_JS="$SCRIPT_DIR/kimi-stats-bar.js"
INSTANCES_DIR="$HOME/.kimi-code/server/instances"
STATE_FILE="$SCRIPT_DIR/.injected-surfaces"
INTERVAL=4

touch "$STATE_FILE"

kimi_ports() {
  # 所有有心跳的 kimi web server 端口(可能多实例)
  python3 - "$INSTANCES_DIR" <<'EOF'
import glob, json, os, sys
for f in glob.glob(os.path.join(sys.argv[1], '*.json')):
    try:
        print(json.load(open(f))['port'])
    except Exception:
        pass
EOF
}

inject() {
  local surface="$1"
  for i in 1 2 3; do
    if cmux browser "$surface" addinitscript "$(cat "$BAR_JS")" >/dev/null 2>&1; then
      cmux browser "$surface" reload >/dev/null 2>&1
      echo "[$(date +%H:%M:%S)] 已注入 $surface"
      return 0
    fi
    sleep 2
  done
  echo "[$(date +%H:%M:%S)] 注入失败(3 次超时): $surface,下轮重试" >&2
  return 1
}

echo "kimi-stats-bar watcher 已启动(每 ${INTERVAL}s 轮询,Ctrl+C 停止)"
while true; do
  PORTS=$(kimi_ports)
  if [ -n "$PORTS" ]; then
    # tree 输出形如:├── surface surface:40 [browser] "title" http://127.0.0.1:58627/...
    cmux tree --all 2>/dev/null | grep '\[browser\]' | while read -r line; do
      surface=$(echo "$line" | grep -oE 'surface:[0-9]+' | head -1)
      url=$(echo "$line" | grep -oE 'https?://[^ ]+' | head -1)
      if [ -z "$surface" ] || [ -z "$url" ]; then continue; fi
      # 只注入 kimi web 页面:host 是本机且端口属于某个 kimi web server
      case "$url" in
        http://127.0.0.1:*|http://localhost:*) ;;
        *) continue ;;
      esac
      port=$(echo "$url" | sed -E 's|https?://[^:/]+:([0-9]+).*|\1|')
      echo "$PORTS" | grep -qx "$port" || continue
      # 已注入过(ref+url 组合)就跳过
      grep -qx "$surface $url" "$STATE_FILE" && continue
      if inject "$surface"; then
        echo "$surface $url" >> "$STATE_FILE"
      fi
    done
  fi
  sleep "$INTERVAL"
done
