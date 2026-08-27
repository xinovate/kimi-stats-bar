#!/usr/bin/env bash
# 生成油猴版:kimi-stats-bar.user.js = 油猴头部 + kimi-stats-bar.js
# 改了 kimi-stats-bar.js 后重跑一次本脚本即可。
set -euo pipefail
cd "$(dirname "$0")"
{
cat <<'EOF'
// ==UserScript==
// @name         kimi-stats-bar
// @namespace    https://github.com/xinovate/kimi-stats-bar
// @version      1.0.0
// @updateURL    https://raw.githubusercontent.com/xinovate/kimi-stats-bar/main/kimi-stats-bar.user.js
// @downloadURL  https://raw.githubusercontent.com/xinovate/kimi-stats-bar/main/kimi-stats-bar.user.js
// @description  Kimi Code Web 会话统计条(油猴版:Chrome / Edge / Firefox / Safari,配合 Tampermonkey 等扩展)
// @match        http://127.0.0.1/*
// @match        http://localhost/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
//
// 由 build-userscript.sh 生成,正文与 kimi-stats-bar.js 相同,请勿直接改本文件。
EOF
cat kimi-stats-bar.js
} > kimi-stats-bar.user.js
echo "built kimi-stats-bar.user.js ($(wc -l < kimi-stats-bar.user.js) lines)"
