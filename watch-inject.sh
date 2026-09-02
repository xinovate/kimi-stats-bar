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

# launchd 等最小环境的 PATH 不含这些位置,显式补上
export PATH="/Applications/cmux.app/Contents/Resources/bin:/Library/Frameworks/Python.framework/Versions/3.12/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

for cmd in cmux python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[$(date +%H:%M:%S)] 错误:找不到 $cmd(PATH=$PATH)" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BAR_JS="$SCRIPT_DIR/kimi-stats-bar.js"
INSTANCES_DIR="$HOME/.kimi-code/server/instances"
STATE_FILE="$SCRIPT_DIR/.injected-surfaces"
PID_FILE="$SCRIPT_DIR/.watch.pid"
INTERVAL=4

# 单实例守卫:已有 watcher 在跑就直接退出(SessionStart hook 每次开会话都会拉起一次)
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  exit 0
fi
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

# 不在 cmux 里(cmux socket 只允许 cmux 内部进程连接):直接退出,
# 下次 SessionStart hook 会再试
if ! cmux ping >/dev/null 2>&1; then
  exit 0
fi

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
  local surface="$1" err
  for i in 1 2 3; do
    if err=$(cmux browser "$surface" addinitscript "$(cat "$BAR_JS")" 2>&1 >/dev/null); then
      cmux browser "$surface" reload >/dev/null 2>&1
      echo "[$(date +%H:%M:%S)] 已注入 $surface"
      return 0
    fi
    echo "[$(date +%H:%M:%S)] addinitscript 失败($i/3): $err" >&2
    sleep 2
  done
  echo "[$(date +%H:%M:%S)] 注入失败(3 次): $surface,下轮重试" >&2
  return 1
}

echo "kimi-stats-bar watcher 已启动(每 ${INTERVAL}s 轮询,Ctrl+C 停止)"
cycle=0
while true; do
  cycle=$((cycle + 1))
  PORTS=$(kimi_ports)
  if [ -n "$PORTS" ]; then
    if ! TREE=$(cmux tree --all 2>&1); then
      echo "[$(date +%H:%M:%S)] cmux tree 失败: $TREE" >&2
      sleep "$INTERVAL"; continue
    fi
    # 每分钟报一次心跳,确认轮询活着
    if [ $((cycle % 15)) -eq 1 ]; then
      nb=$(echo "$TREE" | grep -c '\[browser\]' || true)
      echo "[$(date +%H:%M:%S)] 轮询中: ports=$(echo $PORTS | tr '\n' ' ') 浏览器surface=${nb}"
    fi
    # tree 输出形如:├── surface surface:40 [browser] "title" http://127.0.0.1:58627/...
    echo "$TREE" | grep '\[browser\]' | while read -r line; do
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
      # addinitscript 在 surface 内对所有后续导航持久有效(刷新、切会话、换端口都自动恢复),
      # 所以按 surface 记录一次即可;若按 surface+url 记录,每次 SPA 跳转都会被当成
      # 新页面重新注入并 reload,表现为「页面经常自动刷新」
      grep -qx "$surface" "$STATE_FILE" && continue
      echo "[$(date +%H:%M:%S)] 发现待注入: $surface $url"
      if inject "$surface"; then
        echo "$surface" >> "$STATE_FILE"
      fi
    done
  fi
  sleep "$INTERVAL"
done
