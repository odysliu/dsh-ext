# 网络排查记录：为什么"手表 → Mac"不通而反向正常

2026-11-20 实测（Mac 在 `oLink5` 5GHz，手表在 `oLink` 2.4GHz，同网段 `192.168.0.0/24`）。

## 现象

| 方向 | 结果 |
| --- | --- |
| Mac → 手表 TCP | ✅ 双向数据正常 |
| 手表 → Mac TCP | ❌ 三次握手完成，数据到不了；Mac 侧停在 `SYN_RCVD`，服务端 accept 后 recv 报 `ENOTCONN` |
| 手表 → 路由器 TCP | ✅ HTTP 响应 1035 字节 |
| 手表 → Mac UDP | ❌ 一个包都没到 |

## 根因

手表 ARP 表里，Mac 的 IP 对应的 MAC 是 **`CA:08:35:F8:56:3A`**，而 Mac 的真实 MAC 是 `fc:b2:14:36:79:a1`。

路由器对跨频段客户端做了 **proxy ARP**：手表解析 Mac 时拿到路由器自己的虚拟 MAC，包全发给路由器，而它没有正确转交给 Mac。Mac 侧能通，是因为它从手表发来的帧里学到了手表的真实 MAC。

这也解释了 UDP 完全不通——UDP 同样走这条错误的 ARP 条目。

## 判定方法（可复用）

在设备上直接查 ARP：

```cpp
#include "lwip/etharp.h"
struct netif* nif = netif_default;
struct eth_addr* eth = nullptr;
const ip4_addr_t* found = nullptr;
if (etharp_find_addr(nif, &ip, &eth, &found) >= 0) { /* 打印 eth->addr */ }
```

与 Mac 上 `ifconfig en0 | grep ether` 的 MAC 对比；不一致即命中代理 ARP。

## 规避手段

1. **反向连接（当前采用）**：手表监听 47777，电脑主动拨号（`transport: dial`）。已验证稳定。
2. **静态 ARP**：`configure.mjs --host <ip> --host-mac <mac>` 把 Mac 的真实 MAC 钉死，手表走直连。
3. **路由器侧**：关闭 band steering / 代理 ARP，或让两端在同一频段。

## 已排除

- 不是客户端隔离：Mac → 手表可通（隔离会双向阻断）。
- 不是设备协议/代码：裸 socket 复现，且同一设备访问路由器与外网正常。
- 不是 VPN/TUN：路由表与系统代理都干净。
- 不是电源管理：`WiFi.setSleep(false)` 后现象不变。

## 顺带修掉的固件 bug

- `WiFiServer::begin()` 不带参会默认监听 80 端口（覆盖构造函数的 47777）。
- WiFi 在 12 秒内没连上时，监听 socket 永远不会启动。
- 接受连接后没重置 welcome 超时计时器，连接被立即踢掉。
- 客户端模式下 TCP 建连后每 4 秒重连一次，导致 `welcome` 永远读不到。

## USB 串口传输（公司网络方案）

公司网络对手表不可用：SSID 在 5 GHz，或使用 WPA2-Enterprise，或开启客户端隔离。
手表通过 USB-C 挂在电脑上时，串口是一条完全不依赖网络的通道。

实现要点：

- 固件 `STOPWATCH_SERIAL_TRANSPORT`（默认开）在 `Serial` 上说同一套 NDJSON，
  与 TCP 走同一个 `Link` 状态机；`Channel` 记录当前是哪条通道，写入自动走对应出口。
- 谁先握手谁赢：收到 `hello` 的通道成为活动通道，另一条保持空闲。
- 手表每 2 秒在串口上重发 `hello`，直到收到 `welcome`。**必须无条件发送**：
  `HWCDC::isCDC_Connected()` 只有在主机真的读走 TX FIFO 后才会变真，
  先判断"是否连上"会死锁。
- 串口上的调试输出（`[dsh] ...`）与协议共用一条流，插件只解析 `{` 开头的行。
- 插件 `transport: auto` 每 5 秒复查：有串口就走串口，否则回到 TCP 拨号。
  插线/拔线自动切换，不用改配置。

已知限制：插件占用端口时不能烧写固件，需要先停用插件。
