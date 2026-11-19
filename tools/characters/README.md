# 角色设计工具（备用）

这里是我用来画候选形象的工具：`artkit.py` 是 4 倍超采样的矢量画布，`characters.py` 是四个原创角色，`sheet.py` / `onscreen.py` 出对比图。

```bash
python3 tools/characters/sheet.py      # 三档表情对比
python3 tools/characters/onscreen.py   # 466 圆屏实机尺寸
```

真正上设备的是 `tools/build_sprites.py`：把 `firmware/stopwatch/assets/character/*.png` 转成 4bpp 精灵帧。自己找的图直接走那条路，不需要这里的代码。
