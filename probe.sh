#!/bin/bash
# probe.sh —— dsha-autoconfirm 的 5 分钟关键验证（一次性，不轮询，绝不刷屏）
#
# 【用法】
#   1. 让 DSHA 的 agent 在微信里做一次点按 → 屏幕上弹出确认（悬浮条/弹窗，先别点）
#   2. 立刻在 DSHA 终端（guest shell）运行本脚本
#   3. 把「===== 判读 =====」的输出发回电脑
#
# 【它验证什么】确认挂起期间，无障碍 dump 的活动窗口是不是 DSHA 的确认悬浮条。
#   ✅ 看到「请求执行」→ 悬浮条在活动窗口树里 → smart-tap 代点方案成立
#   ❌ [ERR] 或只见微信内容 → 方案不成立，改走上游 PR / 改源码路线
#
# 【安全】单次 dump。若此刻前台是微信且无确认挂起，这一下可能触发一次
#   「读屏确认」——正因如此绝不做循环版 probe。

HDR="${BRIDGE_HEADERS:-/root/.dsh/.bridge_headers}"
BASE="${BRIDGE_BASE:-127.0.0.1:3090}"

if [ ! -f "$HDR" ]; then
  echo "找不到桥凭据 $HDR（应由宿主写入；仅在 DSHA guest 终端里有效）"
  exit 1
fi

out="$(curl -s -m 5 -H @"$HDR" "http://$BASE/app/ui/dump" 2>&1)"
code=$?

echo "===== dump 原始返回 (exit=$code) ====="
printf '%s\n' "$out"
echo "===== 判读 ====="

if printf '%s' "$out" | grep -q "请求执行"; then
  echo "✅ 方案可行：确认悬浮条出现在无障碍活动窗口里，代点允许可成立。"
  echo "   --- 确认条上的可点节点（应含 允许/拒绝）："
  printf '%s\n' "$out" | grep -E "允许|拒绝" || echo "   （没抓到允许字样——把上面原始返回全贴给本鱼再判）"
elif printf '%s' "$out" | grep -q "\[ERR\]"; then
  echo "❌ 方案不成立：确认挂起期间读屏被拒（活动窗口不是 DSHA 自己）。"
  echo "   → 代点会死循环，放弃 smart-tap，走提 PR / 改源码路线。"
else
  echo "⚠️  活动窗口里看不到确认条（返回的是别的窗口内容）。"
  echo "   → 悬浮条没进无障碍树，代点不可行。先检查悬浮确认是否开启"
  echo "     （DSHA 设置里确认方式要选「悬浮条」；只剩通知栏的话通知栏属于"
  echo "     com.android.systemui，在敏感名单里，同样死路）。"
fi
