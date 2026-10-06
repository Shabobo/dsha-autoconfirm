# dsha-autoconfirm

DSHA「敏感应用逐次确认」的**自动代点看门狗**：确认一弹出，按策略自动点「允许」；支付词命中的留给你手动。
**不动 DSHA 原生代码 → 上游随便升级，插件不用重打。**

## 一、原理（每一步都有 DSHA 源码依据）

```
轮询 /exec "logcat -d -b events"（READ 类，免确认、毫秒级、不读 UI 树）
   │  指纹命中：notification_enqueue(pkg=com.dsh.client, id=3003) ← 看门人进场的唯一外溢事件
   ▼
/app/ui/dump 读确认条文案「⚠ 请求执行：在【pkg】里：点击「X」」
   ▼  policy.json 判定：allow-all 默认全放；命中支付词 → 留给主人手动
/app/ui/tap text=允许 → 原操作放行
```

| 环节 | 源码依据（DSH-APP/DSHA @ main） |
|---|---|
| 看门人进场必发确认通知、ID=3003 | `NotificationIds.java:10`；`HttpShellService.java:2031-2069` |
| 进场不打日志、状态不对外（所以用通知事件当指纹） | `OverlayController`/`HttpShellService` 进场路径无 Log |
| 确认槽唯一 → 挂起期间轮询绝不叠弹窗 | `BridgeConfirmations.java:27-30` |
| 挂起时授权先于树遍历 → dump 快失败，不存在慢路径 | `HttpShellService.java:1096-1099` |
| 敏感判定+确认文案带包名和按钮字 | `HttpShellService.java:1037-1061, 1044-1048` |
| `/exec` 参数 `cmd`、READ 类不弹确认 | `HttpShellService.java:680, 736-741`；`DeviceShellPolicy.java:117` |

## 二、安装（爸妈友好版）

1. **前提（一次性）**：DSHA 设置 → 打开「**ADB 能力**」（指纹通道走 `/exec logcat`，没它看门狗空转）；
2. DSHA 插件管理 → 粘贴本仓库 GitHub 地址 → 安装（也支持 `owner/repo` 简写 / Release 直链，见 `PluginSource.java:27-66`）；
3. 重启 DSH → 跑自检（见下）。

## 三、自检（一句话判决生死）

在 DSHA 终端里（`selfcheck.js` 在插件目录的 `lib/` 下）：

```bash
node <插件目录>/lib/selfcheck.js          # 静态四项：凭据/桥/指纹通道/策略文件
node <插件目录>/lib/selfcheck.js --live    # 真机三连测：指纹 → 生死判 → 代点闭环
```

`--live` 会提示你**让 agent 在微信/支付宝里点一下**（弹出的确认别手动点），60 秒内自动验完：

| 测什么 | 不绿的含义 |
|---|---|
| ⑤ 捕获 `notification_enqueue#3003` | 指纹失效（OEM 阉割 events 缓冲？）→ 改用 `dumpsys window` 备用指纹 |
| ② 挂起时 dump 可见确认条 | **生死判失败**：代点方案不成立 → 走「上游 PR」路线 |
| ③ tap 允许真执行 | 同上 |
| （替代结局）确认在自检期间**被自动处理掉**（你没手动点） | **也判通过**——那就是看门狗抢先代点了，全链 E2E 已跑通 |

## 四、策略配置 `policy.json`（改完即生效，不用重启）

```json
{
  "enabled": true,            // false = 关闭代点（回退手动）
  "mode": "allow-all",        // 默认全放
  "pollMs": 700,              // 指纹轮询间隔
  "tapText": "允许",
  "denyKeywords": ["支付","付款","转账","免密","密码","刷脸","提现","还款","付款码"]
}
```

命中 `denyKeywords` 的确认**不代点**（唯一的手动项）。误拦了就删词，漏了就加词。

## 五、安全边界（自己知道就行）

- 代点 = **把确认闸交给 AI**：`allow-all` 意味着微信/支付宝里的屏幕操作（含截屏、读屏）都不再问你；
- 支付词库是**软护栏不是保证**——关键词看的是按钮文字，真正的动钱大额步骤通常还有指纹/密码兜底；
- 白名单式严格模式可在 `policy.json` 里自行收紧（把 `denyKeywords` 思路反过来即可，本版默认按「跑通优先」）。

## 六、失败回退

| 情况 | 动作 |
|---|---|
| 自检 ②/③ 红 | 停用插件（`enabled:false`），改走**上游 PR**（作者审计文档已建议名单可配置：`docs/audits/build156/assignment-bridge.json:75`） |
| 没有 ADB 想跑 | 用仓库存量脚本 `probe.sh` / `smart-tap.sh`（fire-and-watch 老方案，慢但可用） |
| 本机不是 DSHA（桌面 DSH） | 看门狗检测无桥凭据后待机，不报错 |

## 七、文件

| 文件 | 作用 |
|---|---|
| `package.json` + `cordis.patch.yml` | 插件契约（`dsh.bundle.patch`，loader 行插进 profile 栈） |
| `lib/index.js` | 宿主入口（照抄 session-refresh 形状，零 ctx 服务依赖） |
| `lib/engine.js` | 看门狗：指纹 → 策略 → 代点 |
| `lib/selfcheck.js` | 自检（静态四项 + `--live` 三连测） |
| `policy.json` | 策略配置 |
| `probe.sh` / `smart-tap.sh` / `whitelist.txt` | 无插件环境的手动回退方案 |

## 八、实测记录

| 日期 | 项目 | 结果 |
|---|---|---|
| （待填） | 自检静态四项 | |
| （待填） | --live 三连测 | |
