# 依赖安全

使用 `package.json` 固定的 pnpm 12，使工作区安全覆盖规则写入锁文件。网页商店使用 Next 16，已包含原 Next 15 本地补丁修复的水合问题，因此移除旧补丁。开发和构建命令显式使用 webpack，保留 `node:sqlite` 的服务端外部模块配置。ESLint 使用 Next 16 的配置格式；版本保留在 9，因为现有 import、jsx-a11y、react 插件的同伴依赖不接受 ESLint 10。

桌面端的 GTK 3 依赖仍要求 glib 0.18.5。它的 `VariantStrIter` 把 C 函数的可变输出参数作为不可变指针传入（GHSA-wrw7-89jp-8q8g）。`apps/cli-gui/src-tauri/vendor/glib` 保留校验过摘要的官方发布源码和原许可证，只回移 gtk-rs/gtk-rs-core#1343 的两行修复。Cargo 的补丁配置选择该源码。运行 `python3 scripts/security/vendor-glib.py --check` 可重建并核对；`glib-security` 持续集成检查以优化构建验证正向和反向字符串迭代。

GTK 依赖链允许升级到已修复的上游版本后，才移除本地副本。不要在缺少有效补丁和回归验证时屏蔽这个告警。

## Rust 依赖与编译器

`serde_with` 和 `time` 的已发布安全修复要求 Rust 1.88，桌面项目的最低版本同步为 1.88。开发、发布和 Linux 测试镜像统一固定 Rust 1.98.1。保持现有桌面 API 和 GLib 源码补丁。

序列化依赖更新为 `serde_with 3.24.0` 和 `time 0.3.55`。完整 Linux 桌面作业的有界时间预算为 75 分钟，覆盖编译器升级后的冷构建及全部原生验收。

Rust 锁文件同时固定 `plist 1.10.3` / `quick-xml 0.42.0`、`rust_decimal 1.43.0` 和 `tokio 1.54.1`，去除旧 rkyv 0.7 依赖。更新后的锁文件经 RustSec 0.23.0 检查，没有已知漏洞或不健全实现条目；旧 GTK/总线生态的停止维护提示保留为架构维护事项。
