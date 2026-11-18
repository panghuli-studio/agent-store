# Linux 输入法与原生窗口呈现调查（#239）

本轮在测试的 GNOME X11 / 嵌套 GNOME Wayland、默认 WebKit 渲染和真实 IBus CJK 输入下，没有观察到冻结；但 GNOME X11 设置 `WEBKIT_DISABLE_COMPOSITING_MODE=1` 或 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 后，XIM 可以触发原生画面停止呈现。因此“仅无合成器 Xvfb 有问题”的解释不成立，也不能宣称所有 Linux 用户均不受影响。

已用不经过 XIM 的直接 GDK 子窗口原生化复现同一故障。问题位于 GTK3/X11 原生子窗口与这些 WebKit 呈现路径的交互；不是中文字符串、React 状态、Tauri IPC 或输入服务等待导致主循环挂死。生产没有新增规避措施；底层修复与上游工单尚未完成。供维护者提交的 [上游报告草稿](linux-ime-upstream.md) 已准备好。

本记录区分三件事：原生窗口是否刷新、输入是否确实进入窗口、输入法是否确实提交了 CJK 文本。DOM 焦点、JavaScript 计数继续增加、CI 作业成功，都不能单独回答这三个问题。

## 环境与测量方法

GitHub Actions Ubuntu 22.04 VM，Xvfb 1280×900，Mesa 软件 GL（`LIBGL_ALWAYS_SOFTWARE=1`）。测试三种会话：无窗口管理器的 X11、GNOME Shell X11 窗口/合成管理器、以 Xvfb 为宿主的嵌套 GNOME Wayland。后者的原生截图取外层 Xvfb 上的 GNOME 宿主表面，不是 WebKit 内部截图。这里没有测实体 GPU、硬件显示器、KDE、Fcitx 或其他发行版。

最终测量 [44405453905](https://github.com/panghuli-studio/agent-store/actions/runs/44405453905)（源码 `7af9399`）记录的版本：

| 组件 | 版本 |
| --- | --- |
| GNOME Shell / Mutter | 42.9 / 42.9 |
| GTK 3 | 3.24.33-1ubuntu2.2 |
| WebKitGTK | 2.50.4-0ubuntu0.22.04.1 |
| IBus / GTK 模块 | 1.5.26-4 |
| libpinyin | 1.12.1-2ubuntu2 |
| Anthy | 1.5.14-1 |
| Hangul | 1.5.4-1build2 |
| Xvfb | 21.1.4-2ubuntu1.7~22.04.16 |
| 发布包 | Agent Store 0.4.0 amd64 `.deb` |

发布包固定为 `v0.4.0`，下载后验证 SHA-256 `d6c00bdca62956af8d7b4389f29825b22c7709ded8b89427ac812c65bea5bb36`。它是实际发布包，不代表本 PR 的源码重新构建结果。命令面板走真实 Tauri/WebKit；目录地址设为不可连接的本机端口，因此目录离线是测试条件。所有输入、配置和 IBus 设置只存在于 CI 的一次性 HOME。

`test/desktop-linux/ime/probe.py` 是独立于 React、Tauri 的 WebKitGTK 页：真实文本框、每秒递增的可见计数、输入与组合事件日志。`package.py` 用原生键盘打开发布包命令面板并输入相同测试串；WebDriver 只读取 DOM/事件，不注入文字或组合事件。每次先取原生截图，再读取发布包 DOM，避免 WebKit 内部快照促成绘制。

`ime-probe.yml` 分别测未设置 WebKit 渲染开关、同时设置两个现有 CI 开关，并在 GNOME X11 另外单独设置每一个。输入路径是 IBus GTK 模块、IBus XIM（仅 X11 有意义），以及只输入 ASCII 的 simple 对照。日文需选择 Hiragana 并确认转换，韩文需选择 Hangul 模式；只把引擎装上、把 `nihongo` 或 `gksrmf` 输入进去，不算 CJK 覆盖。

原始产物包含版本、GL 渲染器、环境开关、引擎、JSONL 事件、GTK 原生窗口/绘制次数、原生 PNG、截图时间与 OCR 文本。`summary.json` 的 OCR 缺失值表示无法自动判断，不能解释为已证明冻结；最终还要直接检查原图。`package-summary.json` 的 CJK 标记只反映输入事件，不证明原生窗口已呈现。

## 结果

| 会话 / 开关 | IBus GTK 模块 | XIM / 原生子窗口 |
| --- | --- | --- |
| GNOME X11，默认 | 中日韩真实输入、独立页和发布包呈现正常 | 中日韩真实输入、独立页和发布包呈现正常 |
| GNOME Wayland，默认 | 中日韩真实输入、独立页和发布包呈现正常 | XIM 不适用于本次原生 Wayland GTK 输入，ASCII fallback 不算 CJK 覆盖 |
| GNOME X11，禁用两个呈现路径 | 中日韩输入并继续呈现 | XIM 输入/DOM 推进，但原生画面陈旧；直接原生化也复现 |
| GNOME X11，单独禁用合成 | 中日韩输入并继续呈现 | XIM 与直接原生化均复现 |
| GNOME X11，单独禁用 DMABUF | 中日韩输入并继续呈现 | 同样复现，不能只归因于禁用合成 |
| GNOME Wayland，禁用两个路径 | 中日韩输入并继续呈现 | XIM 不适用 |
| 无合成器 X11，默认 | 中日韩输入并继续呈现 | 中日韩输入并继续呈现 |
| 无合成器 X11，禁用两个路径 | 中日韩输入并继续呈现 | 同样复现；此前 headless 结果是这个组合的一例 |

代表性原始 PNG：

- [GNOME X11 默认渲染，原生化后 FRAME 11](linux-ime/native-late-default.png)。
- [同样原生化，禁用 DMABUF 后仍是 FRAME 1](linux-ime/native-late-dmabuf-off.png)；该时刻 DOM 已是 11。
- [GNOME X11 发布包输入“你好”](linux-ime/x11-ibus-chinese.png)、[Wayland 发布包输入“日本語”](linux-ime/wayland-ibus-japanese.png)、[X11 XIM 发布包输入“한글”](linux-ime/x11-xim-korean.png)。

PNG 从 Actions 产物原样复制，未重新截图或改写像素。完整摘要、版本和选定 GTK 原生状态/绘制回调测量保存在 [evidence.json](linux-ime/evidence.json)，避免七天后产物过期只剩结论。

`cjk_commit` 是严格的“CJK 文本 + compositionend”标记，不是所有 IME 提交方式的穷举：发布包的韩文 XIM 路径直接发出可信 `input`（`한` → `한글` → `한글 `），不发 compositionend，故标记为 false；其最终 DOM 与原生截图仍显示真实韩文。不能把该 false 当作输入失败。某些首张 OCR 未读到计数，后两张和原图仍确认计数推进；没有通过放宽匹配把缺失值改成成功。

## 测量陷阱与排除项

- [44401433694](https://github.com/panghuli-studio/agent-store/actions/runs/44401433694) 虽然作业成功，但实际截图仍在 GNOME 概览搜索；DOM 有焦点而窗口未获得原生焦点，测试文字进了桌面搜索。这轮不能作为用户未受影响的证据。后续显式激活原生窗口并记录 `document.hasFocus()`。
- 在首个完整矩阵中，Wayland 默认渲染的 IBus GTK 路径确实提交了“你好”，独立页与发布包原生截图都显示了它。
- GNOME X11 的 XIM 在默认渲染下显示测试页；同时禁用 WebKit 合成与 DMABUF 时，独立页保持白色，页面计数和输入事件仍推进。发布包 DOM 的 `palette=true` 且收到可信输入，但原生截图仍显示未打开面板的主页面。因此仅增加桌面合成器不能解释或消除原 CI 的症状。
- 首个矩阵的日文、韩文实际仍在 Latin 模式，不能据其 ASCII 结果宣称 CJK 用户通过。后续改用引擎的 CJK 模式，保留真实组合与提交记录。

## 原生子窗口分离实验

GTK 3.24.33 的 [XIM 实现](https://github.com/GNOME/gtk/blob/3.24.33/modules/input/gtkimcontextxim.c) 为输入上下文取得客户端 XID；[GDK 的 XID 获取函数](https://github.com/GNOME/gtk/blob/3.24.33/gdk/x11/gdkwindow-x11.c) 在需要时使窗口原生化。此调用链给出了下述可直接控制的触发机制。

独立页在 `native-early` / `native-late` 对照中使用 simple 输入上下文，分别在首次绘制前、首次绘制后使同一 GDK 子窗口原生化；不使用 XIM。窗口原生状态与绘制次数和页面计数一起记录，用来区分 XIM 协议问题与原生子窗口/软件呈现的问题。最终测量确认：默认渲染的 `native-late` 在原生化后，DOM / 原生计数为 7/7、9/9、11/11；禁用 DMABUF 的同一对照为 7/1、9/1、11/1。后者 GTK 窗口 `native=false` → `true`，绘制回调仍从 8 增到 40。因此不是没有调度 JavaScript 或 GTK draw，而是呈现了旧画面。`native-early` 在首次绘制前原生化也可保持白色，提前原生化不是已验证的修复。

这证明原生子窗口是充分触发条件，XIM 只是进入该路径的一种方式；没有声称已经找出并验证某一条 C++ 重绘修补。仍需上游定位具体绘制目标/合成更新的修复点。

## CI 与生产边界

现有截图脚本为了无 GPU 自动化显式禁用了 WebKit 合成，并只需要 ASCII 输入。它们继续在测试进程中设置 simple；这个设置不是用户默认路径的验证，也不能用于生产绕开中文输入。独立的 IME 矩阵补测真实 IBus GTK/XIM 路径和默认渲染，原始截图与输入证据必须一起查看。

生产代码没有强制输入法模块，也没有新增 WebKit 渲染开关。不能从本记录推出所有 Linux 桌面均正常或均冻结。若需给用户发布输入法或呈现路径的规避措施，应将其明确作为规避措施评审；本 PR 不将它冒充底层修复，也不关闭 #239。

## 验证与未完成项

代码只增加诊断、保存证据和更正测试注释。Shell 语法和 diff 检查通过；真实会话、发布包、截图和输入测量全部在 Actions 运行，最终八组作业全部执行成功；是否呈现正常按各组数据判断，而非按作业绿色判断。现有端到端检查也在 Actions 验证，没有在共享宿主跑构建或测试套件。

尚未提交 WebKitGTK 上游工单，也没有底层修复。需由维护者提交已备好的报告并回填链接。#239 保持开放；本 PR 使用 Refs 而非 Closes。
