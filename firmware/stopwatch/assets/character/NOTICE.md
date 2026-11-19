# 角色素材：DS鲸鱼娘

本目录下的 PNG 与由它们生成的 `src/assets/characters.h` 精灵帧，**不是 MIT**，
按 **CC BY-NC-SA 4.0**（署名 — 非商业性使用 — 相同方式共享）使用。

## 署名

| 角色 | 作者 | 链接 |
| --- | --- | --- |
| 角色原作（原创 OC「溟月」） | 上善无形 | https://www.pixiv.net/users/62155430 |
| DeepSeek 女仆装二次设计 | ZipZipPipe | https://www.pixiv.net/users/18604994 |
| Live2D 模型（绑定 / 动作 / 表情） | 氵六青 | https://space.bilibili.com/11272072 |
| 桌宠插件（本素材来源） | A8Chann | https://github.com/A8Chann/dsh-pet-live2d |

## 说明

- 本目录的帧是用 `tools/bake-live2d/` 在本地把上述 Live2D 模型渲染成 PNG，再经
  `tools/build_sprites.py` 转成 8bpp 精灵；属于**改编作品**，因此同样按 CC BY-NC-SA 4.0 共享。
- 仅限**非商业**用途。商用需分别取得上善无形、ZipZipPipe、氵六青的授权。
- 仓库其余代码仍为 MIT；两者边界就是本目录与 `src/assets/characters.h`。
- Live2D Cubism Core 运行时（`tools/.cache/live2dcubismcore.min.js`）来自 Live2D 官方，
  按 Live2D 的许可使用，**未**提交进仓库。
