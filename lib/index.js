import { appendFileSync } from 'node:fs';

export const name = 'dsha-autoconfirm';

/**
 * 宿主半：全部功能在 lib/engine.js（常驻看门狗）。
 * 形状照抄 dsh-session-refresh（apply 无 ctx 依赖，避免 cordis 服务读取陷阱）。
 * 启动失败只记日志，绝不让插件把 DSH host 打挂。
 *
 * v0.1.2 装载探针：apply() 第一行就写 journal ——
 *   journal 有「apply() 被调用」 = cordis 真加载了本插件；
 *   连这行都没有         = loader 行没生效（未重启 DSH / 未装载）；
 *   有 apply 但没「启动」 = engine 动态 import 失败（错误也会记进 journal）。
 */
const JOURNAL = process.env.DSHA_AC_JOURNAL || '/tmp/dsha-autoconfirm.log';
const stamp = () => new Date().toISOString().slice(11, 19);

function journal(line) {
  try {
    appendFileSync(JOURNAL, `${stamp()} ${line}\n`);
  } catch {
    /* journal 写不进去不影响主流程 */
  }
}

export function apply() {
  journal('apply() 被 cordis 调用（装载探针 v0.1.2）');
  import('./engine.js')
    .then((m) => m.start())
    .catch((e) => {
      console.error('[dsha-autoconfirm] 启动失败：', e);
      journal(`❌ engine 动态加载失败：${e && e.message}`);
    });
}
