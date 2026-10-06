/**
 * dsha-autoconfirm 看门狗引擎
 *
 * 架构（真机判决点见 README「自检」）：
 *   轮询 /exec logcat -b events（READ 类，全程不弹确认，毫秒级）
 *     → 命中 notification_enqueue(pkg=com.dsh.client, id=3003)  ← 看门人进场指纹
 *     → /app/ui/dump 读确认条文案（挂起态下小树/快失败，不存在慢路径）
 *     → policy.json 判定（allow-all + 支付词库；命中 → 留给用户手动）
 *     → /app/ui/tap text=允许 代点放行（uiTapText 内部自遍历，无需预读）
 *
 * 源码依据（DSH-APP/DSHA @ main）：
 *   - 确认通知 ID：NotificationIds.java:10  SHELL_CONFIRM = 3003
 *   - 进场必发通知：HttpShellService.java:2031-2069 showConfirmNotification
 *   - /exec 参数：HttpShellService.java:680  getParam(query, "cmd", "")
 *   - 敏感判定+文案：HttpShellService.java:1037-1061 / 1044-1048
 *   - 确认槽唯一（挂起期间新确认静默失败，轮询不叠弹窗）：BridgeConfirmations.java:27-30
 *   - 挂起时授权先于树遍历（dump 快失败）：HttpShellService.java:1096-1099
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TAG = '[dsha-autoconfirm]';

const HEADERS = process.env.DSHA_BRIDGE_HEADERS || '/root/.dsh/.bridge_headers';
const BASE = process.env.DSHA_BRIDGE_BASE || 'http://127.0.0.1:3090';

/** DSHA 包名与确认通知 ID —— 指纹常量 */
const DSHA_PKG = 'com.dsh.client';
const CONFIRM_NOTIF_ID = '3003';

/** 内置默认（policy.json 缺失/损坏时的兜底，与 policy.json 内容一致） */
const DEFAULT_POLICY = {
  enabled: true,
  mode: 'allow-all',
  pollMs: 700,
  tapText: '允许',
  denyKeywords: ['支付', '付款', '转账', '免密', '密码', '刷脸', '提现', '还款', '付款码'],
};

let policy = { ...DEFAULT_POLICY };
let timer = null;
let ticking = false;
let busy = false;
let adbWarned = false;
let seenLines = new Set();
let seenOrder = [];

function log(...args) {
  console.log(TAG, ...args);
}

function loadPolicy() {
  try {
    const p = JSON.parse(readFileSync(path.join(ROOT, 'policy.json'), 'utf8'));
    policy = { ...DEFAULT_POLICY, ...p };
    return true;
  } catch (e) {
    policy = { ...DEFAULT_POLICY };
    log('policy.json 不可用，使用内置默认策略：', e.message);
    return false;
  }
}

/** 桥 HTTP 调用（curl 走宿主原生，-H @文件 用 DSHA 宿主写入的桥凭据） */
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

function trim(s, n = 160) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function remember(line) {
  seenLines.add(line);
  seenOrder.push(line);
  if (seenOrder.length > 60) seenLines.delete(seenOrder.shift());
}

/** 指纹：events 缓冲里 DSHA 专属确认通知的入队事件 */
function isGateEvent(line) {
  return (
    line.includes('notification_enqueue') &&
    line.includes(DSHA_PKG) &&
    new RegExp(`(^|[^0-9])${CONFIRM_NOTIF_ID}([^0-9]|$)`).test(line)
  );
}

/** 看门人进场 → 读文案 → 策略 → 代点 */
async function onGateEntered(rawLine) {
  if (busy) return;
  busy = true;
  try {
    loadPolicy(); // 每次进场重读配置：改 policy.json 不用重启
    if (policy.enabled === false) {
      log('策略已停用（enabled=false），本条转手动：', trim(rawLine));
      return;
    }

    const d = await bridgeGet('/app/ui/dump');
    if (d.out.includes('[ERR]')) {
      // 生死判失败形态：确认挂起时活动窗口仍被算作底下的敏感 App
      log('⚠ dump 被拒（目标窗口非 DSHA）→ 代点通路不成立，本条转手动：', trim(d.out));
      return;
    }
    const confirmLine = d.out.split('\n').find((l) => l.includes('请求执行'));
    if (!confirmLine) {
      log('指纹命中但活动窗口未见确认条（可能已被人工处理），忽略：', trim(rawLine));
      return;
    }

    const hit = (policy.denyKeywords || []).find((k) => k && confirmLine.includes(k));
    if (hit) {
      log(`命中支付词「${hit}」→ 留给主人手动点：`, trim(confirmLine));
      return;
    }

    const tapText = encodeURIComponent(policy.tapText || '允许');
    const t = await bridgeGet(`/app/ui/tap?text=${tapText}`);
    if (t.out.includes('[ERR]')) {
      log('⚠ 代点被拒（生死判失败?）→ 本条转手动：', trim(t.out));
    } else {
      log('✅ 已代点允许：', trim(confirmLine));
    }
  } catch (e) {
    log('处理确认时异常（本条转手动）：', e && e.message);
  } finally {
    busy = false;
  }
}

async function tick() {
  if (ticking || busy) return;
  ticking = true;
  try {
    const r = await execCmd(`logcat -d -b events -t 30`);
    const out = r.out;
    if (out.includes('ADB_REQUIRED') || out.includes('EXIT=124')) {
      if (!adbWarned) {
        adbWarned = true;
        log('❌ /exec 不可用：请在 DSHA 设置里打开「ADB 能力」（一次性），watchdog 暂停升级为低频重试');
      }
      return;
    }
    if (out.includes('unknown buffer') || out.includes('No such')) {
      if (!adbWarned) {
        adbWarned = true;
        log('❌ events 日志缓冲不可用（OEM 阉割?）：指纹通道失效，需改用 dumpsys window 备用指纹（见 README）');
      }
      return;
    }
    adbWarned = false;

    for (const line of out.split('\n')) {
      if (isGateEvent(line) && !seenLines.has(line)) {
        remember(line);
        log('🔔 指纹命中（看门人进场）：', trim(line));
        await onGateEntered(line);
        break; // 一次 tick 处理一条，其余下轮再看
      }
    }
  } catch (e) {
    log('tick 异常：', e && e.message);
  } finally {
    ticking = false;
  }
}

export function start() {
  if (globalThis.__dshaAutoconfirmStarted) {
    log('已在运行，忽略重复启动');
    return;
  }
  globalThis.__dshaAutoconfirmStarted = true;

  if (!existsSync(HEADERS)) {
    log(`桥凭据 ${HEADERS} 不存在 —— 当前环境不是 DSHA guest，看门狗待机（桌面 DSH 上属正常）`);
    return;
  }
  loadPolicy();
  timer = setInterval(tick, Math.max(300, policy.pollMs || 700));
  if (timer.unref) timer.unref();
  log(
    `看门狗启动：指纹=notification_enqueue#${CONFIRM_NOTIF_ID}，poll=${policy.pollMs}ms，mode=${policy.mode}，词库=${(policy.denyKeywords || []).length}条`
  );
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  globalThis.__dshaAutoconfirmStarted = false;
  log('看门狗已停止');
}
