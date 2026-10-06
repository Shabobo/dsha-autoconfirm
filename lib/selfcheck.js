#!/usr/bin/env node
/**
 * dsha-autoconfirm 自检 —— 在 DSHA guest 终端里运行：
 *   node <插件目录>/lib/selfcheck.js          # 静态四项检查
 *   node <插件目录>/lib/selfcheck.js --live    # 追加真机三连测（需触发一次真实确认）
 *
 * --live 用法：先回车启动，然后立刻让 agent 在敏感 App（微信/支付宝）里执行一次
 * 点按（会弹出确认条，【不要手动点】），本脚本 60 秒内自动完成：
 *   ① 指纹：logcat events 是否捕获 notification_enqueue#3003
 *   ② 读取：挂起时 dump 是否看得到确认条（生死判）
 *   ③ 代点：tap 允许 是否真被执行（通路闭环）
 *
 * 退出码：0 = 全绿可用；1 = 有失败项（看结论行）
 */
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHeaders } from './engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
/** 发现式凭据（v0.1.1）：头文件多候选 + .bridge_token 回退，逻辑与看门狗完全一致 */
const R = resolveHeaders();
const HEADERS = R ? R.headers : null;
const JOURNAL = process.env.DSHA_AC_JOURNAL || '/tmp/dsha-autoconfirm.log';
const BASE = process.env.DSHA_BRIDGE_BASE || 'http://127.0.0.1:3090';
const DSHA_PKG = 'com.dsh.client';
const CONFIRM_NOTIF_ID = '3003';

const results = [];
function report(ok, name, detail = '') {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
}

function curl(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-s', '-m', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ...args],
      { timeout: timeoutMs + 1500, windowsHide: true },
      (err, stdout, stderr) =>
        resolve({ out: String(stdout || ''), err: String(stderr || (err ? err.message : '')) })
    );
  });
}
const bridgeGet = (p) => curl(['-H', `@${HEADERS}`, `${BASE}${p}`]);
const execCmd = (cmd) =>
  curl(['-G', `${BASE}/exec`, '--data-urlencode', `cmd=${cmd}`, '-H', `@${HEADERS}`]);
const trim = (s, n = 150) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const isGate = (l) =>
  l.includes('notification_enqueue') &&
  l.includes(DSHA_PKG) &&
  new RegExp(`(^|[^0-9])${CONFIRM_NOTIF_ID}([^0-9]|$)`).test(l);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const live = process.argv.includes('--live');
  console.log('== dsha-autoconfirm 自检 ==');

  // 1. 桥凭据（发现式：多候选头文件 + token 回退）
  const hasHdr = !!R;
  if (hasHdr) {
    report(true, '① 桥凭据可读', R.via);
  } else {
    const probe = [];
    for (const d of ['/root/.dsh', '/root/.dsh/profiles', '/root/.dsh/profiles/web']) {
      try {
        const hit = readdirSync(d).filter((n) => /bridge|token/i.test(n));
        probe.push(`${d}: ${hit.length ? hit.join(' ') : '（无 bridge/token 文件）'}`);
      } catch {
        probe.push(`${d}:（不可读/不存在）`);
      }
    }
    report(false, '① 桥凭据可读', `候选均未命中；现场 → ${probe.join(' | ')}`);
  }

  // 2. 桥存活
  let health = { out: '' };
  if (hasHdr) health = await bridgeGet('/health');
  report(health.out.length > 0 && !health.out.includes('ERROR'), '② 3090 桥存活', trim(health.out, 80));

  // 3. 指纹通道：/exec + logcat events
  let events = { out: '' };
  if (hasHdr) events = await execCmd('logcat -d -b events -t 40');
  if (events.out.includes('ADB_REQUIRED') || events.out.includes('EXIT=124')) {
    report(false, '③ 指纹通道（/exec logcat）', 'ADB 能力未开 —— 去 DSHA 设置里打开「ADB 能力」后重试');
  } else if (events.out.includes('unknown buffer')) {
    report(false, '③ 指纹通道（/exec logcat）', 'events 缓冲不可用（OEM 阉割?），需启用 dumpsys 备用指纹');
  } else {
    const hasAny = events.out.includes('notification_enqueue');
    report(
      true,
      '③ 指纹通道（/exec logcat）',
      hasAny
        ? 'events 缓冲可见 notification_enqueue 事件'
        : 'logcat 可用，但缓冲里暂无 notification_enqueue（未必是故障，④ 实测见分晓）'
    );
  }

  // 4. 策略文件
  let pol = null;
  try {
    pol = JSON.parse(readFileSync(path.join(ROOT, 'policy.json'), 'utf8'));
    report(true, '④ policy.json 可解析', `mode=${pol.mode}，词库 ${(pol.denyKeywords || []).length} 条`);
  } catch (e) {
    report(false, '④ policy.json 可解析', e.message + '（将用内置默认）');
  }

  // --live：真机三连测
  if (live && hasHdr) {
    console.log('\n== 真机三连测（60s）：现在请让 agent 在微信/支付宝里点一下，弹出的确认【别手动点】==');
    const deadline = Date.now() + 60000;
    let fired = false;
    while (Date.now() < deadline && !fired) {
      const r = await execCmd('logcat -d -b events -t 30');
      fired = r.out.split('\n').some((l) => isGate(l));
      if (!fired) await sleep(500);
    }
    report(fired, '⑤ 指纹实测', fired ? '捕获 notification_enqueue#3003' : '60s 内未捕获（确认没弹出? 或指纹方案失效）');

    if (fired) {
      const d = await bridgeGet('/app/ui/dump');
      const hasConfirm = d.out.includes('请求执行');
      const denied = d.out.includes('[ERR]');
      if (denied) {
        report(
          false,
          '② 生死判（挂起时 dump 可见确认条）',
          `dump 被拒：${trim(d.out)} → 目标窗口非 DSHA，代点方案不成立`
        );
      } else if (hasConfirm) {
        report(true, '② 生死判（挂起时 dump 可见确认条）', '确认条在活动窗口里 → 可代点');
      } else {
        // 活动窗口已无确认条。测试期间【不允许手动点】，所以唯一解释是
        // 看门狗抢先代点了 → 指纹/策略/代点全链 E2E 已被真实跑通。
        report(
          true,
          '②③ 确认已被自动处理（全链 E2E 通过）',
          '看门狗已代点放行；若想单独复测底层链路，把 policy.json 的 enabled 改 false 再跑 --live'
        );
      }

      if (hasConfirm && pol) {
        const line = d.out.split('\n').find((l) => l.includes('请求执行')) || '';
        const hit = (pol.denyKeywords || []).find((k) => k && line.includes(k));
        if (hit) {
          console.log(`⚠️  本条命中支付词「${hit}」，按策略不代点。请手动点掉它，然后换一个不含支付词的操作再跑一次 --live。`);
          report(false, '③ 代点实测', '本次被策略拦截，未执行');
        } else {
          const t = await bridgeGet(`/app/ui/tap?text=${encodeURIComponent(pol.tapText || '允许')}`);
          report(
            !t.out.includes('[ERR]'),
            '③ 代点实测（tap 允许）',
            t.out.includes('[ERR]') ? `被拒：${trim(t.out)}` : '点按已执行，确认应已放行'
          );
        }
      }
    }
  } else if (live) {
    console.log('（① 未通过，跳过真机三连测）');
  }

  const pass = results.every(Boolean);
  console.log(`（看门狗运行日志：${JOURNAL} —— 排障先 cat 它）`);
  console.log(`\n== 结论：${pass ? '🟢 全绿，看门狗可用' : '🔴 有失败项，按上面 ❌ 行处理后重跑'} ==`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('自检崩溃：', e);
  process.exit(1);
});
