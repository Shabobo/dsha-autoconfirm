export const name = 'dsha-autoconfirm';

/**
 * 宿主半：全部功能在 lib/engine.js（常驻看门狗）。
 * 形状照抄 dsh-session-refresh（apply 无 ctx 依赖，避免 cordis 服务读取陷阱）。
 * 启动失败只记日志，绝不让插件把 DSH host 打挂。
 */
export function apply() {
  import('./engine.js')
    .then((m) => m.start())
    .catch((e) => console.error('[dsha-autoconfirm] 启动失败：', e));
}
