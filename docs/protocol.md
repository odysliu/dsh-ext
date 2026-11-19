# StopWatch 设备协议 v1

主机（DSH 插件）与手表（ESP32-S3 固件）之间的全部通信。两端都在本仓库里，协议保持刻意的小：一行一个 JSON 对象，UTF-8，`\n` 结尾，单行上限 8 KB。

## 端口

| 用途 | 方向 | 端口 | 传输 |
| --- | --- | --- | --- |
| 设备服务 | 手表 → 主机（TCP 连接） | 47777 | TCP |
| 局域网发现 | 手表广播 → 主机单播回复 | 47778 | UDP |

主机默认同时监听 TCP 47777 与 UDP 47778；两个端口都可以在插件 `config` 里改。

## 连接与握手

手表不知道主机 IP 时，先向 `255.255.255.255:47778` 广播：

```json
{"t":"discover","proto":1}
```

每一台运行插件的电脑回 unicast：

```json
{"t":"host","proto":1,"name":"odys-mac","port":47777,"token":""}
```

手表记住最近一次成功的主机地址（NVS），下次直接连；连不上再回到广播发现。**同一时刻只保留一条连接**，新连接会让旧连接收到 `{"t":"bye","reason":"replaced"}` 后关闭。

握手：

```json
{"t":"hello","proto":1,"id":"a1b2c3","name":"stopwatch","fw":"0.1.0","token":"","battery":87}
{"t":"welcome","proto":1,"server":"dsh-stopwatch","host":"odys-mac"}
```

- `proto` 不匹配 → 主机回 `{"t":"error","code":"bad-proto"}` 并断开。
- `token` 非空且与主机配置不符 → `{"t":"error","code":"bad-token"}` 并断开。
- 5 秒内没有 `hello` → 主机断开。

## 心跳

主机每 8 秒发 `{"t":"ping","ts":<ms>}`，手表回 `{"t":"pong","ts":<ms>}`。主机 30 秒收不到任何帧即判定离线；手表 20 秒收不到 ping 即重连。

## 确认请求

主机 → 手表：

```json
{
  "t": "prompt",
  "id": "p_7f3a",
  "seq": 1,
  "total": 2,
  "tool": "bash",
  "title": "需要确认",
  "lines": ["命令 npm run build", "写入工作区以外的文件"],
  "timeoutMs": 45000,
  "buttons": [
    { "id": "allow", "label": "同意" },
    { "id": "deny", "label": "拒绝" },
    { "id": "delegate", "label": "电脑" }
  ]
}
```

- `lines` 已由主机按**像素宽度**预折行（全角 28 px、ASCII 18 px，默认上限 420 px），最多 6 行；手表按行原样绘制，不再折行。
- `seq/total` 用于显示"还有几个在排队"。
- `timeoutMs` 只用于手表画倒计时环，真正超时由主机裁决。

手表 → 主机：

```json
{"t":"decision","id":"p_7f3a","value":"allow","latencyMs":3210}
```

`value` 取值：

| 值 | 含义 | 主机返回给 DSH |
| --- | --- | --- |
| `allow` | 同意这一次 | `allowed-once` |
| `deny` | 拒绝 | `rejected` |
| `delegate` | 我去电脑上处理 | 交回 Web 界面（`next()`） |

主机在请求结束时（无论谁裁决）都发一条收尾消息，让手表回到待机：

```json
{"t":"close","id":"p_7f3a","outcome":"allowed-once","text":"已同意"}
```

`outcome` ∈ `allowed-once | rejected | cancelled | timeout | offline | delegated`。`text` 可直接显示 1.5 秒。

## 复杂请求 / 通知

内容超出屏幕能力（太长、多段、被策略排除的工具）时，主机**不**下发 `prompt`，只发一条通知并立即把请求交回 Web 界面：

```json
{"t":"notice","kind":"delegate","text":"这个确认有点复杂","lines":["请到电脑上处理"],"ttlMs":4000}
```

普通提示（连上、断开、会话完成）用同样的 `notice`，`kind` 为 `info|warn|delegate`。

## 状态上报

手表每 60 秒（或电量变化 ≥ 5%）上报一次：

```json
{"t":"status","battery":87,"rssi":-52,"uptime":1234}
```

主机据此在日志里显示设备状态；`battery < 15` 时手表自己进入省电（降低亮度与动画帧率）。

## 错误

```json
{"t":"error","code":"bad-token","message":"token mismatch"}
```

`code` ∈ `bad-proto | bad-token | bad-json | too-long | unknown-type`。主机收到后记录并断开；手表收到后显示 2 秒错误提示并重连。

## 兼容性

- 新增字段一律可选，旧端忽略未知字段。
- `proto` 只在破坏性变更时递增。
- 所有时间单位为毫秒；`ts` 是发送端本地单调时钟，仅用于往返延迟估算。
