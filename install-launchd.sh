#!/usr/bin/env bash
# 安装 / 卸载 cmux 自动注入 watcher 的 launchd 自启(登录即启动,重启不失效)
#
# 用法:
#   ./install-launchd.sh           # 安装并启动
#   ./install-launchd.sh uninstall # 停止并卸载
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.xinovate.kimi-stats-bar.watch"
PLIST_SRC="$SCRIPT_DIR/launchd/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "${1:-}" = "uninstall" ]; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  rm -f "$PLIST_DST"
  echo "已卸载 launchd 自启: $LABEL"
  exit 0
fi

sed "s|__SCRIPT_PATH__|$SCRIPT_DIR/watch-inject.sh|" "$PLIST_SRC" > "$PLIST_DST"
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "已安装并启动: $LABEL(日志: /tmp/kimi-stats-bar-watch.log)"
echo "卸载: $SCRIPT_DIR/install-launchd.sh uninstall"
