#!/bin/bash
# smart-tap.sh —— dsha-autoconfirm 主角：fire-and-watch 点按包装
#
# 原理：后台发起 /app/ui/tap（需要确认时它会阻塞、屏幕弹确认条），
#       同时轮询 /app/ui/dump 找「⚠ 请求执行：在【包名】里：…」的确认条，
#       包名命中白名单 → 代点「允许」→ 被卡住的操作自动放行。
#
# 为什么观察期不会刷屏（源码依据，见 README）：
#   - 确认槽全局唯一（BridgeConfirmations.begin: current!=null → null），
#     挂起期间再发的确认请求直接静默失败，不会叠第二个弹窗；
#   - 确认条属于 DSHA 自己（非敏感）→ 观察期的 dump/tap 走屏幕授权直通，
#     不会再触发「要不要允许读屏」的递归确认。
#
# 【用法】
#   smart-tap.sh <控件文字> [前台包名提示]
#   例：smart-tap.sh 设置 com.android.settings
#       smart-tap.sh 开始游戏 com.tencent.mm
#
#   包名提示给全 → 事前就做白名单判定（不命中直接走普通调用，等你手动确认）；
#   不给提示 → 事中从确认文案【】里提取判定，不命中立即放弃代点并报告。
#
# 【退出码】0=操作成功  1=用法/环境错  2=不在白名单（转手动）  3=代点失败/超时

set -u
TEXT="${1:-}"
HINT="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WL="$HERE/whitelist.txt"
HDR="${BRIDGE_HEADERS:-/root/.dsh/.bridge_headers}"
BASE="${BRIDGE_BASE:-127.0.0.1:3090}"
INTERVAL="${ST_INTERVAL:-0.3}"     # 轮询间隔（秒）
MAX_WAIT="${ST_MAX_WAIT:-55}"      # 观察上限（桥确认 60s 超时，留 5s 余量）

[ -n "$TEXT" ] || { echo "用法: smart-tap.sh <控件文字> [前台包名提示]" >&2; exit 1; }
[ -f "$HDR" ] || { echo "找不到桥凭据 $HDR（须在 DSHA guest 里运行）" >&2; exit 1; }

dump()   { curl -s -m 5 -H @"$HDR" "http://$BASE/app/ui/dump"; }
tap()    { curl -s -m 8 -G "http://$BASE/app/ui/tap" --data-urlencode "text=$1" -H @"$HDR"; }

# 白名单判定：子串命中 / all / 未配置(=拒绝代点)
whitelisted() {
  local pkg="${1:-}" line
  [ -f "$WL" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"; line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -z "$line" ] && continue
    [ "$line" = "all" ] && return 0
    [ -n "$pkg" ] && case "$pkg" in *"$line"*) return 0 ;; esac
  done < "$WL"
  return 1
}

# ---- 事前判定（给了包名提示才走）----
if [ -n "$HINT" ] && ! whitelisted "$HINT"; then
  echo "[$HINT] 不在白名单 → 普通调用，确认请手动点" >&2
  exec curl -s -m 70 -G "http://$BASE/app/ui/tap" --data-urlencode "text=$TEXT" -H @"$HDR"
fi

# ---- 发起操作（后台）----
TMP="$(mktemp)"   # 操作结果
curl -s -m 70 -G "http://$BASE/app/ui/tap" --data-urlencode "text=$TEXT" -H @"$HDR" >"$TMP" &
ACTION_PID=$!

# ---- 观察期 ----
sleep 0.3         # 让操作的确认先占槽，避免自己的读屏抢单
deadline=$(( $(date +%s) + MAX_WAIT ))
mode="watch"      # watch | bail
last_dump=""

while [ "$(date +%s)" -lt "$deadline" ]; do
  kill -0 "$ACTION_PID" 2>/dev/null || break    # 操作已返回（多半本来就不需要确认）

  out="$(dump)"
  last_dump="$out"

  case "$out" in
    *"请求执行"*)
      pkg="$(printf '%s' "$out" | sed -n 's/.*【\([^】]*\)】.*/\1/p' | head -1)"
      if whitelisted "$pkg"; then
        sleep 0.1
        tap "允许" >/dev/null 2>&1
        echo "auto-allow → 【$pkg】" >&2
      else
        echo "确认属于【${pkg:-未知}】，不在白名单 → 转手动，请在屏幕上点允许" >&2
        mode="manual"
        break
      fi
      ;;
    *"[ERR]"*)
      :   # 挂起期间活动窗口不是 DSHA → 读屏被静默拒（预期内，继续等悬浮条进入活动窗口）
      ;;
  esac
  sleep "$INTERVAL"
done

wait "$ACTION_PID" 2>/dev/null
result="$(cat "$TMP" 2>/dev/null)"; rm -f "$TMP"

# ---- 收尾判读 ----
if [ -n "$result" ] && ! printf '%s' "$result" | grep -q "\[ERR\]"; then
  printf '%s\n' "$result"
  exit 0
fi

if [ "$mode" = "manual" ]; then
  echo "RESULT: $result"
  exit 2
fi

# 失败：给诊断（本鱼要看这两段）
echo "AUTO-ALLOW FAILED（代点没成功，操作结果如下）" >&2
echo "RESULT: $result" >&2
echo "LAST_DUMP: $last_dump" >&2
exit 3
