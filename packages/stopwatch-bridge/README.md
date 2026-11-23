# @dsh-ext/stopwatch-bridge

把 DeepSeek Harness 会话里的**权限确认**转发到 M5Stack StopWatch：手表闪烁 + 大肥鱼动画 + 提示音 + 震动，点屏幕就能同意或否决；内容太复杂或 45 秒没作答，自动回落 Web 界面。

## 行为

| 情况 | 手表 | DSH |
| --- | --- | --- |
| 设备已连接、内容放得下 | `prompt`：显示命令/原因，三个按钮（拒绝 / 同意 / 电脑） | 等待手表作答 |
| 手表点「同意」 | 显示「已同意」 | 工具继续执行（`allowed-once`） |
| 手表点「拒绝」 | 显示「已拒绝」 | 工具被拒绝（`rejected`） |
| 手表点「电脑」 | 提示交给电脑 | 立刻回到 Web 界面（`next()`） |
| 内容太长/多段 | 提示「这个确认有点复杂」 | 立刻回到 Web 界面 |
| 45 秒没答 | 超时提示 | 交回 Web 界面 |
| 设备断线/未连接 | — | 交回 Web 界面 |
| `mode: notify` | 只镜像提示，不可作答 | 依然在 Web 界面确认 |

任何异常路径都会 `next()`，不会让会话卡住。

## 语音输入

按住**右键**录音 → 松手自动识别 → 文字显示在手表上 → 再按右键发送到当前对话；按**左键**清空。

语音识别用 DSH 自带的 `ctx.speechToText`（本地 SenseVoice）。**这个服务默认没启用**：

1. 打开 DSH 设置 → 插件，启用 **语音输入 / voice input** 官方 bundle（会一起挂上 `speech-to-text` 与 SenseVoice provider）；
2. 第一次识别会下载约 300 MB 模型，手表上会提示「识别模型未就绪」；在设置里点一次「准备/下载」后即可；
3. 之后每次录音约 0.8–2 秒出字（取决于时长）。

未启用时手表会显示「语音识别未启用」，其余功能不受影响。

音频格式：16 kHz / 单声道 / 16-bit PCM，设备流式分片（每片约 32 ms），主机拼成 WAV 后交给识别服务。单段上限 60 秒。

## 配置

写在 profile 的 `cordis.patch.yml`：

```yaml
- id: stopwatch-bridge
  name: '@dsh-ext/stopwatch-bridge'
  config:
    port: 47777
    discoveryPort: 47778
    mode: remote          # remote | notify
    timeoutMs: 45000      # 手表持有决定的时长，之后回落 Web 界面
    token: ''             # 非空时设备必须带同一 token
    deniedTools: []       # 这些工具的确认永远留在 Web 界面
    allowedTools: []      # 非空时只有这些工具推到手表
    sound: true
    vibration: true
    voice: true           # 关闭后手表只提示、不上传音频
    language: zh
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `47777` | 手表连接的 TCP 端口 |
| `discoveryPort` | `47778` | 局域网发现 UDP 端口 |
| `host` | `0.0.0.0` | 监听地址；改成 `127.0.0.1` 会让手表连不上 |
| `token` | `''` | 共享密钥，空表示不校验（可信局域网） |
| `mode` | `remote` | `remote` 手表可裁决；`notify` 只提醒 |
| `timeoutMs` | `45000` | 5 000–600 000 |
| `maxWidthPx` / `maxLines` | `420` / `6` | 手表屏幕能放下的排版预算，超出即判定"太复杂" |
| `deniedTools` / `allowedTools` | `[]` | 工具白/黑名单 |
| `sound` / `vibration` | `true` | 手表提示音与震动 |
| `releaseFile` | `<repo>/.tools/flash.lock` | 烧写哨兵：文件存在时插件主动放开串口，烧完自动重连；`tools/flash.mjs` 会自己写入和删除，一般不用改 |

## 工作原理

1. 插件用 `ctx.on('approval/request', …, { prepend: true })` 抢在 Web UI 的答案者之前拿到请求；
2. `tools/pre-execute` 里按 `callId` 缓存工具调用摘要（比如具体命令），供屏幕显示；
3. 把摘要 + 原因按 15 格 × 5 行排版，放不下就判定为"太复杂"；
4. 通过 TCP 发给手表，等待 `decision`；超时/断线/取消都会 `next()`。

## 排错

- **手表没反应 / 从来不提醒**：当前会话的审批策略必须是 `ask`。如果策略是 `never`（设置 → 权限，或 `/permission`），DSH 会直接拒绝需要审批的操作，根本不会产生确认请求。
- **手表连不上**：确认电脑与手表在同一局域网、`port` 未被占用、macOS 防火墙允许 `node` 接受传入连接；也可在手表上直接填电脑 IP。
- **看不到插件日志**：插件只在连接、拒绝、回落时写日志；`ctx.logger` 输出在 DSH 进程日志里。
- **想先不接硬件**：`node tools/fake-device.mjs` 可以模拟一块手表。

## 安全

协议是局域网明文 + 可选 token。确认请求不会离开本机所在的网络；如果网络不可信，请设置 `token`，并在路由器上限制设备所在网段。
