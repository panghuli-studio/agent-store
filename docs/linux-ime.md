# Linux 输入法与原生窗口呈现（#239）

## 结论

- 默认 WebKit 渲染下，GNOME X11 和嵌套 GNOME Wayland 里用 IBus 真实输入中日韩文字，桌面客户端都正常呈现，没有冻结。
- 设置 `WEBKIT_DISABLE_COMPOSITING_MODE=1` 或 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 后（任设一个即可），GTK3/X11 的 WebKit 子窗口一旦变成原生窗口，画面就停在旧帧：DOM、JavaScript 计数和 GTK 绘制回调都在推进，窗口却不再呈现新内容。XIM 输入法取窗口 XID 时会让子窗口变成原生窗口，因此是触发这一故障的一条路径；不经 XIM、直接让子窗口变成原生窗口也能复现。故障与中文字符串、React、Tauri IPC 无关，原因也不是缺少桌面合成器。
- 故障已隔离到 GTK3/X11 原生子窗口与 WebKit 呈现路径的交互，具体底层修补尚未定位或验证。按所有者在 #239 的决定，不向 WebKitGTK 上游发布任何内容；调查结论与未修复限制仅记录在本仓库的 #239。归档的报告草稿在 [`c9342a9` 的 `docs/investigations/linux-ime-upstream.md`](https://github.com/panghuli-studio/agent-store/blob/c9342a9c335fab6be1a28bbc2af07b65775c196b/docs/investigations/linux-ime-upstream.md)。

已测范围：GitHub Actions 的 Ubuntu 22.04 虚拟机（Xvfb 虚拟显示，GNOME X11 合成器或嵌套 GNOME Wayland），Mesa 软件 GL，GNOME Shell 42.9，GTK 3.24.33，WebKitGTK 2.50.4，IBus 1.5.26，Agent Store 0.4.0 发布包。实体 GPU、KDE、Fcitx 和其他发行版没有测过，所以既不能说所有 Linux 用户都正常，也不能说都会冻结。

## 对代码的约束

- 生产代码不强制输入法模块，也不设置 WebKit 渲染开关。要给用户发布规避措施，必须作为规避措施单独评审，不能算作修复。
- `test/desktop-linux/` 的截图脚本为了在没有 GPU 的环境里跑，禁用了 WebKit 合成，并把输入法设为 `simple`，因为它们只输入 ASCII。这个设置只在测试里有效，不能代表用户的默认路径，生产代码也不能拿它绕开中文输入。真实输入路径由 `ime-probe.yml` 的矩阵另行覆盖。
- 判断窗口是否正常，要看原生截图。DOM 焦点、JavaScript 计数在增加、CI 作业成功，都不能证明窗口在呈现新内容。

## 证据

调查过程、各组测量和截图在 #239 与 PR #240，最终测量是 Actions 运行 [44405453905](https://github.com/panghuli-studio/agent-store/actions/runs/44405453905)。产物过期后，摘要、版本和原生截图仍可在 [`c9342a9` 的 `docs/investigations/`](https://github.com/panghuli-studio/agent-store/tree/c9342a9c335fab6be1a28bbc2af07b65775c196b/docs/investigations) 查看。
