# StopWatch × DSH：方案与里程碑

> 目标：DSH 会话里需要人工介入时，M5Stack StopWatch 闪烁提醒并显示大肥鱼动画；点屏后能看到待确认内容，并直接批准/否决；太复杂的情况回落到 Web 界面。

## 1. 已确认的技术事实

### 硬件（M5Stack StopWatch）

来源：官方文档、M5Unified / M5GFX 源码。

| 项 | 事实 |
| --- | --- |
| SoC | ESP32-S3R8，16 MB Flash / 8 MB PSRAM，WiFi 4 + BLE 5 |
| 屏幕 | 1.75" 圆形 AMOLED，**466×466**，CO5300，QSPI（`Panel_StopWatch`，memory 480×480，offset x=6） |
| 触摸 | 电容触摸 I2C **0x15**，坐标 0–233（固件内 2× 映射到 466） |
| 音频 | ES8311 codec + AW8737A 功放 + 1 W 喇叭；I2S：MCK 18 / BCK 17 / WS 15 / DOUT 21 |
| 电源 | M5PM1；`M5.Power.setVibration(level)` 控制震动马达 |
| 其他 | BMI270 六轴、RX8130CE RTC、450 mAh、按键 GPIO1/GPIO2 |
| 结论 | M5Unified 已支持 `board_M5StopWatch`，屏幕/触摸/音频/电源都不需要自己写驱动 |

### DSH 侧

| 项 | 事实 |
| --- | --- |
| 人工介入入口 | `approval/request` 瀑布事件，签名 `(req, next) → ApprovalOutcome` |
| 结果词汇 | `allowed-once` / `rejected` / `cancelled` / `unavailable`（无"永久允许"） |
| 监听顺序 | `ctx.on(name, fn, { prepend: true })` 可抢在 Web UI 答案者之前 |
| 请求内容 | `toolName` / `reason` / `displayReason` / `callId` / `signal`，**不含参数** |
| 参数摘要 | `tools/pre-execute` 可拿到 `callId` + `arguments`，用于屏幕展示 |
| 失败关闭 | 没有答案者或答案者失败 = 拒绝；所以插件每条路径都必须 `next()` |
| 插件形态 | bundle（`dsh.bundle.patch`）+ 纯 JS ESM Host 插件，无构建、无原生依赖 |

## 2. 决策（已与需求方确认）

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 传输 | **WiFi + TCP（NDJSON）**，串口留接口 | Node 零原生依赖、Mac/Win 一致、离开电脑也能收到；串口必须插线 |
| 裁决权 | **手表优先，45 s 超时回落 Web UI** | 网页确认卡片无法被程序撤回，两边同时弹会冲突 |
| 首版范围 | **只做权限确认 approval** | 最小闭环，先跑通真实用例 |
| 固件 | **Arduino C++ / M5Unified** | 官方库原生支持该板，动画与音频性能最好 |
| 中文 | **设备端内置字模**（28px 2bpp，GB2312 一级字，759 KB） | 断网可用、协议只传文本 |
| 工具链 | **arduino-cli + ESP32 core，编译验证** | Mac/Windows 同一套命令 |
| 仓库 | **monorepo 推到 `odysliu/dsh-ext`** | 插件、固件、工具、文档同版本演进 |

## 3. 架构

```
DSH Host (macOS / Windows)
  packages/stopwatch-bridge
    ├ approval answerer  (prepend)  ── 判定是否交给手表
    ├ device server      tcp/47777  ── 握手、心跳、帧
    ├ discovery beacon   udp/47778  ── 设备自动找主机
    └ queue                         ── 串行展示、超时、取消、断线回落
        ⇅  WiFi / NDJSON
firmware/stopwatch (ESP32-S3)
    ├ link    WiFi + TCP + JSON + 重连 + NVS 记忆主机
    ├ ui      BOOT → IDLE → ALERT → PROMPT → RESULT
    ├ fish    程序化鲸鱼动画（弹簧缓动，只重绘 320×320 区域）
    ├ text    2bpp 中文字模 + UTF-8 解码 + 逐字 blit
    └ sound   合成 WAV（提示/同意/拒绝）
```

### 为什么不是串口 / BLE

- 串口：必须一直插线，Node 侧要原生模块（`serialport`），安装与升级更脆；但已把传输层抽象出来，后续可加。
- BLE：Node 侧要么原生库，要么只能在浏览器 Web Bluetooth（页面关了就断），跨平台成本高。

### 为什么主机渲染文本而不是推图片

466×466×2 = 434 KB/帧，WiFi 推图会把延迟和功耗拉满；设备端字模只需一次 300–700 KB 的 flash 占用，之后协议只传几十字节文本。

## 4. 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 方案、协议、仓库骨架 | 本次 |
| M1 | Host 插件 + 假设备 + 单测 + 安装到本机 profile，真实 approval 闭环 | ✅ 已完成 |
| M2 | 固件源码 + 字模/音效生成 + 编译通过 | 进行中 |
| M3 | 硬件联调：烧写、触摸校准、亮度/音频、时延与稳定性（**等设备到货**） | 待硬件 |
| M4 | 多会话队列调优、低功耗档、Web 状态面板、CI | 后续 |

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 手表误触"拒绝" | 拒绝按钮二次确认（长按 400 ms）；结果 1.5 s 内可撤销（v2） |
| 局域网端口被滥用 | 可选 token + 仅私网广播 + 文档说明 |
| 圆形屏安全区 | 内容限制在中心 400×400，按钮放在 y≈340 的弦宽内 |
| WiFi 常连耗电 | v1 建议桌面插电；v2 做"亮屏高速轮询 + 息屏休眠" |
| 中文字模体积 | 2bpp、GB2312 一级字 + ASCII，约 0.7 MB，3 MB app 分区足够 |
| 固件无法在到货前验证 | 编译通过 + 逻辑用 host 侧模拟器覆盖；到货后按 M3 清单逐项校准 |

## 6. 硬件到货后的验收清单

1. `M5.begin()` 后屏幕点亮、亮度可调，触摸坐标与像素 1:1；
2. 喇叭能播放提示音，震动马达按 `setVibration` 分级；
3. 手表能通过 UDP 发现主机并建立 TCP，心跳 10 分钟不掉线；
4. 触发一次真实 approval：闪烁 → 点屏 → 同意 → 工具继续执行；
5. 断网/断电重连后自动恢复待机；
6. 待机 1 小时耗电与发热记录（决定 v2 的低功耗策略）。
