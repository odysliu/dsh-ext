# StopWatch 固件

M5Stack StopWatch（ESP32-S3）上的 DSH 确认终端：连 WiFi → 局域网找到电脑 → 收到确认请求时闪烁、摇鱼、响铃、震动 → 点屏批准/否决。

## 硬件要点（来自 M5Unified / M5GFX 源码）

| 项 | 参数 |
| --- | --- |
| 屏幕 | 466×466 圆形 AMOLED，CO5300，QSPI 80 MHz，panel memory 480×480（x 偏移 6） |
| 触摸 | 电容触摸，I2C 0x15，原始坐标 0–233（固件内 2× 映射） |
| 音频 | ES8311 + AW8737A，I2S（MCK 18 / BCK 17 / WS 15 / DOUT 21） |
| 电源 / 震动 | M5PM1，`M5.Power.setVibration(level)` |
| 按键 | GPIO1 / GPIO2 |
| 板卡识别 | M5Unified 自动识别 `board_M5StopWatch`，编译用通用 `esp32s3` 目标即可 |

## 目录

```
stopwatch.ino          启动、主循环
src/config.h           编译期配置（含 secrets.h 可选包含）
src/link.{h,cpp}       WiFi、UDP 发现、TCP + NDJSON、心跳、重连
src/ui.{h,cpp}         BOOT / IDLE / ALERT / PROMPT / RESULT / NOTICE 状态机
src/fish.{h,cpp}       Q 版鲸鱼：程序化绘制，弹簧式上下浮动 + 摆尾 + 气泡
src/text.{h,cpp}       2bpp 中文字模渲染（UTF-8、二分查找字模）
src/sound.*            提示音播放（WAV 内嵌）
src/assets/font_cn.h   生成物：GB2312 一级字 + ASCII，28px 2bpp
src/assets/sounds.h    生成物：提示 / 同意 / 拒绝三个 WAV
```

生成物已提交，正常编译不需要 Python；只有改字体或音效时才需要重新生成：

```bash
python3 tools/genfont.py --font <NotoSansSC-Regular.otf> --out firmware/stopwatch/src/assets/font_cn.h
python3 tools/gensounds.py --out firmware/stopwatch/src/assets/sounds.h
```

## 烧写

```bash
node tools/setup-toolchain.mjs            # 首次：下载 arduino-cli + ESP32 core + M5Unified
node tools/configure.mjs --ssid "家里WiFi" --password "密码"
node tools/flash.mjs                      # 自动找串口；或 --port /dev/cu.usbmodem1101 / COM5
```

编译参数：`esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=huge_app,PSRAM=opi,CDCOnBoot=cdc`。
Windows 与 macOS 的差别只有串口名字（`COM5` vs `/dev/cu.usbmodem*`）。

## 行为

| 状态 | 屏幕 | 触发 |
| --- | --- | --- |
| BOOT | 「正在连接 / WiFi 未配置」 | 上电，未连上主机 |
| IDLE | 大鲸鱼浮动 + 电量/RSSI | 已连接、无待确认 |
| ALERT | 鲸鱼继续浮动，整屏亮度脉冲，提示音 + 震动，底部「有确认请求 · 点一下」 | 收到 `prompt` |
| PROMPT | 标题 + 工具 + 内容 + 拒绝/同意/电脑处理 | 点一下屏幕 |
| RESULT | 「已同意 / 已拒绝 / 超时，转回电脑」 | 做了选择或主机收尾 |
| NOTICE | 「这个确认有点复杂 / 请在电脑上确认」 | 请求太复杂，主机已交回 Web 界面 |

- **拒绝要按两次**（防误触）：第一次变红显示「再点一次」，2.5 秒内再点才生效。
- 提示音最多重复 4 次，间隔 4.2 秒；亮度脉冲只在 ALERT 状态。
- 断线后自动回到 IDLE 并持续重连；重连成功会重新握手。

## 排错

| 现象 | 处理 |
| --- | --- |
| 屏幕显示「WiFi 未配置」 | 先跑 `tools/configure.mjs` 再烧写；`secrets.h` 不会进 git |
| 一直「正在连接」 | 电脑和手表不在同一网段，或 macOS 防火墙拦了 node 的入站连接；也可把电脑 IP 写进 `secrets.h` 后用 `STOPWATCH_HOST_PORT` 直连（v2 会加手输 IP 的界面） |
| 触摸没反应 | 确认 `M5.update()` 在 loop 里每轮都调用（已包含）；屏幕保护贴太厚会影响电容触摸 |
| 声音很轻 | `M5.Speaker.setVolume()` 当前是 140，可调到 200；确认喇叭开孔没有被遮挡 |
| 画面撕裂 | 面板已开 TE 同步，若仍明显可把 `STOPWATCH_FRAME_MS` 调到 40 |

## 功耗

WiFi 常连 + 30 fps 动画，450 mAh 电池大约 2–4 小时。日常建议放在桌面上插电使用；v2 会加入「息屏降帧 + 定时轮询」的省电档。
