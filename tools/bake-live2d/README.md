# 把 Live2D 模型烘成精灵帧

手表跑不了 Live2D，所以用无头 Chrome 把模型渲染成 PNG，再交给 `tools/build_sprites.py` 转 8bpp。

## 一次性准备

1. 桌宠模型（含 `lib/live2d-vendor.js`）：放在 `tools/dsh-pet-live2d-main/`（来源见
   [character/NOTICE](../../firmware/stopwatch/assets/character/NOTICE.md)）。
2. Live2D Cubism Core：从官方下载后放到 `tools/.cache/`（不提交）：

   ```bash
   curl -L -o tools/.cache/live2dcubismcore.min.js \
     https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
   ```

## 烘焙

```bash
# 静态服务器（页面要同源加载模型）
(cd . && python3 -m http.server 8765 --bind 127.0.0.1 &)

# 四个状态：待机 / 问号 / 开心兴奋 / 悲伤
node tools/bake-live2d/bake.mjs --states 'idle|问号|开心兴奋|悲伤' \
  --zoom 2.1 --oy -150 --out tools/.cache/live2d-final

cp tools/.cache/live2d-final/idle.png     firmware/stopwatch/assets/character/idle.png
cp tools/.cache/live2d-final/问号.png      firmware/stopwatch/assets/character/alert.png
cp tools/.cache/live2d-final/开心兴奋.png   firmware/stopwatch/assets/character/happy.png
cp tools/.cache/live2d-final/悲伤.png      firmware/stopwatch/assets/character/sad.png

python3 tools/build_sprites.py      # -> src/assets/characters.h + 预览
python3 tools/preview-device.py     # -> 466 实机效果
```

表达式名必须用 `c_0120.model3.json` 里的**中文 Name**（`问号`、`开心兴奋`、`悲伤`…），
用文件名（`question`/`excited`）不会生效。

`--zoom` / `--oy` 控制取景：2.1 / -150 是「头部半身」，1.55 / -20 是「全身带桌子」。
