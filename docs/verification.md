# 验证记录

硬件到货前能做的验证，以及到货后必须补做的项目。

## 本机已验证

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| Host 插件测试 | `npm test` | 49 个主机用例 + 14 个资产/契约用例通过（详见 [testing.md](testing.md)） |
| 插件安装 | `plugin_manager install_bundle`（link: 本地目录） | `application: applied`，profile `web` 已加载 |
| 设备服务 | `lsof -iTCP:47777 -iUDP:47778` | 两个端口都在监听 |
| 局域网发现 | `tools/fake-device.mjs` 广播发现 | 收到 `{"t":"host"}` 并连上 10.184.47.60:47777 |
| 握手 / 心跳 | 假设备日志 | `hello → welcome`，心跳正常 |
| 真实 approval 链路 | 触发沙箱提权（写工作区外文件） | 插件收到请求并下发到设备；当时判定"内容过长"而回落 Web UI（已按真实 reason 修正阈值） |
| 固件编译 | `arduino-cli compile`（esp32 3.3.4 + M5Unified/M5GFX 0.3.0） | ✅ 通过，0 warning：`Sketch uses 2,800,551 bytes (89%) of 3 MB`，RAM 18% |
| 字模渲染 | `tools/genfont.py --preview` | 28px 中文 + 18px ASCII 可读，759 KB |
| 屏幕排版 | `tools/preview-ui.py` | 四个状态在 466 圆形安全区内，无溢出 |
| 鲸鱼动画 | `tools/preview-fish.py` | 平静 / 开心 / 难过三种表情 |

## 尚未验证（等硬件）

1. `M5.begin()` 后屏幕点亮、亮度可调、触摸坐标与像素一致（CST816 2× 映射）；
2. 喇叭音量与音色（`M5.Speaker.setVolume` 当前 140）、震动强度；
3. 30 fps 动画下的实际帧率与撕裂情况（依赖面板 TE 同步）；
4. 心跳 10 分钟不掉线，断网/断电后自动重连；
5. 待机 / 提醒状态的实际功耗与发热；
6. 拒绝两次点击的触感是否符合预期。

## 编译产物

```
.tools/build/stopwatch.ino.bin           2.0 MB   应用分区镜像
.tools/build/stopwatch.ino.merged.bin     16 MB   整片镜像（含 bootloader + 分区表）
```

`merged.bin` 可以直接用 esptool 烧到 0x0，不依赖 arduino-cli：

```bash
python3 -m esptool --chip esp32s3 -p /dev/cu.usbmodem1101 write_flash 0x0 .tools/build/stopwatch.ino.merged.bin
```

## 编译复现

```bash
node tools/setup-toolchain.mjs          # arduino-cli + esp32 3.3.4 + M5Unified/M5GFX/ArduinoJson
node tools/flash.mjs --compile-only     # 只编译，验证通过后 --port 烧写
```

网络要求：首次需要下载约 1.4 GB（ESP32 工具链 + IDF 预编译库），建议在网络稳定时执行；中断后重跑会重新下载未完成的包。

## 已知限制

- 局域网明文 + 可选 token；不适合不可信网络。
- 只有一次性授权，没有"永久允许"（DSH 本身也不提供）。
- 手表优先模式下，人在电脑前时也要等 45 秒才会看到 Web 界面确认（可用 `timeoutMs` 调整）。
- `approval/request` 的监听顺序依赖 `prepend`；若未来 DSH 改变答案者注册顺序，需要在验收时复测（用假设备即可观察）。
- 手表需要先烧写一次 WiFi 凭据；改 WiFi 需重新烧写（v2 计划加配网页面）。
