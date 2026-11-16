# 依赖安全

使用 `package.json` 固定的 pnpm 12，使工作区安全覆盖规则写入锁文件。网页商店使用 Next 16，已包含原 Next 15 本地补丁修复的水合问题，因此移除旧补丁。开发和构建命令显式使用 webpack，保留 `node:sqlite` 的服务端外部模块配置。ESLint 使用 Next 16 的配置格式；版本保留在 9，因为现有 import、jsx-a11y、react 插件的同伴依赖不接受 ESLint 10。

桌面端的 GTK 3 依赖仍要求 glib 0.18.5。它的 `VariantStrIter` 把 C 函数的可变输出参数作为不可变指针传入（GHSA-wrw7-89jp-8q8g）。`apps/cli-gui/src-tauri/vendor/glib` 保留校验过摘要的官方发布源码和原许可证，只回移 gtk-rs/gtk-rs-core#1343 的两行修复。Cargo 的补丁配置选择该源码。运行 `python3 scripts/security/vendor-glib.py --check` 可重建并核对；`glib-security` 持续集成检查以优化构建验证正向和反向字符串迭代。

GTK 依赖链允许升级到已修复的上游版本后，才移除本地副本。不要在缺少有效补丁和回归验证时屏蔽这个告警。
