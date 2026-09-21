# Codex 驾驶舱（codex-desktop）

用鼠标操作一个**真实的编程 agent**：本应用是 Codex CLI harness 的图形化驾驶舱，界面里的每一次「思考 / 工具调用 / 命令输出 / 文件改动」都来自真实运行的 `codex exec` 子进程，而不是另接一个聊天接口。

- 界面语言：简体中文
- 模型：DeepSeek（`deepseek-chat` / `deepseek-reasoner`），无需 OpenAI 账号
- 技术栈：Electron + React 19 + TypeScript + Vite

---

## 1. 环境要求

本机已验证通过的组合（Windows 11 中文版 / AMD64）：

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | v22.23.2 | 需要 ≥ 18，推荐 22 |
| npm | 10.9.8 | |
| codex CLI | **0.154.0** | `npm i -g @openai/codex`，必须能提供 `codex exec --json` |
| 磁盘 | 约 500 MB | Electron 二进制约 200 MB |

不需要 Rust / Python，不需要 OpenAI 登录。

---

## 2. 快速开始

```powershell
cd E:\develop\dsh\codex-desktop

# 1) 安装依赖（.npmrc 已指向 npmmirror，Electron 二进制走 npmmirror 镜像）
npm install

# 2) 如果 Electron 二进制没下下来（node_modules\electron\dist 不存在），单独补下载：
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js

# 3) 启动（开发模式，带热更新）
npm run dev
```

如果你只想跑构建后的产物：

```powershell
npm run build
npm run preview
```

### 首次使用步骤

1. **填 API Key**：点左下角「设置」→ 填 DeepSeek API Key（形如 `sk-...`），模型选 `deepseek-chat`，确认 `base_url` 为 `https://api.deepseek.com/v1`，保存。
2. **验证连通性**：点左下角「环境自检」→ 点「测试连通性」。看到「DeepSeek 连通正常，API Key 有效」即可。
3. **选工作目录**：点左上「选择目录」，选一个本地仓库或任意目录。Codex 只能在这个目录里活动。
4. **建任务**：点「新建任务」，在下方输入框用自然语言描述任务，例如「读一下这个项目的结构，然后给 README 补一段运行说明，并跑一下测试」。
5. **看过程**：中间对话区实时出现「思考 / 命令 / 文件变更」，右侧「活动流」按时间顺序聚合所有工具调用，「Diff 预览」可看统一 diff。
6. **控权限与审批**：权限模式决定 Codex 能做什么（只读 / 工作区写入 / 完全访问）。默认的「审批模式」下，Codex 在动你的文件或跑越界命令**之前会弹出审批卡片**，你可以点「允许一次 / 总是允许 / 拒绝」，拒绝会带回明确反馈。
7. **随时停止**：运行中顶部出现状态条与「停止」按钮。停止只打断当前这一轮，会话上下文保留。
8. **接着聊**：同一个会话里再发一条会**续接上文**（状态条出现「已续接上下文」徽章）。想从零开始就点「新建任务」。详见第 5 节。
9. **（可选）装启动入口**：`npm run install:launcher`，之后任意目录终端里 `codex-desktop .` 即可用当前目录开工。

### 便携版：打成一个 zip，解压到新电脑就能用

```powershell
npm run pack:portable          # 产出 .pack\codex-desktop-portable-<日期>.zip
npm run verify:portable        # 解压到别处 → 从解压出来的副本跑 5 轮对话，验证真的可用
```

包里**自带**这些东西，所以目标机不需要 `npm install`、也不需要全局装 codex：

| 随包内容 | 作用 |
| --- | --- |
| `node_modules/`（含 `electron`） | Electron 运行时，免安装 |
| `node_modules/@openai/codex` + `@openai/codex-win32-x64` | **codex CLI 本体与平台原生二进制**，免全局安装 |
| `out/` | 已构建好的主进程/渲染层产物 |
| `.npmrc` | 万一需要重装依赖，直连国内镜像 |
| `portable.flag` | 便携模式标记，见下 |
| `启动驾驶舱.cmd` / `首次使用.txt` | 给接收方的入口与说明 |
| `launch/` `src/` `docs/` `test/` `scripts/` | 启动器、源码、文档、自测脚本 |

**接收方只需要三步**：解压 → 双击「启动驾驶舱.cmd」→ 在「设置」里填 DeepSeek API Key。

**便携模式**：包内存在 `portable.flag` 时，配置与会话历史写在**应用同目录的 `data/`** 下（而不是 `~/.codex-desktop`），所以整个文件夹拷到哪台机器都带着配置走。若该目录不可写（例如解压到了 `Program Files`），会自动退回 `~/.codex-desktop`，不会崩。

**两个注意点**：

- ⚠️ 便携包**只能在同系统同架构**上用（本包是 Windows x64），因为 `node_modules` 里的 Electron、`@esbuild/win32-x64`、`@rollup/*-win32-*` 都是平台锁定的。跨系统请打源码包：`npm run pack:portable -- --slim`，到目标机 `npm install && npm run build`。
- ⚠️ `data/config.json` 里存着**你的 API Key**，分享给别人前请删除整个 `data/` 目录。

**codex 解析顺序**（`src/core/codexCli.ts`）：环境变量 `CODEX_DESKTOP_CODEX_JS` → **随包携带的** → 全局 npm 安装 → `where codex`。每个候选都会跑一次 `--version` 验证，**不可用就自动试下一个** —— 这样即使压缩包漏了平台原生二进制，应用也能退回全局安装而不是直接不可用。

---

## 3. 为什么需要一个「协议桥」（关键设计）

这是本项目最容易被忽略、但绕不开的一环，全部结论都是在本机实测得到的：

**问题**：codex-cli 0.154.0 已经移除了 `wire_api = "chat"`。只要在 provider 配置里写 `wire_api = "chat"`，codex 会直接拒绝启动：

```
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
```

而 DeepSeek 的经典接口是 OpenAI **Chat Completions**（`/chat/completions`）。也就是说，**在当前版本的 codex 上「直连 DeepSeek」是做不到的**。

**做法**：应用内置一个零依赖的本地协议桥，让 Codex 以为自己在跟标准 Responses 端点说话：

```
codex exec ──POST /v1/responses──▶ 127.0.0.1:<随机端口>/v1 ──▶ api.deepseek.com/v1/chat/completions
             (Responses 协议)         内置桥（双向翻译）              (Chat Completions 协议)
```

桥负责：

- 请求方向：`instructions` + `input[]` → `messages[]`；`tools[]` → Chat `tools[]`；注入 `temperature`（codex 本身没有这个配置项，只有桥能实现）
- 工具名处理：`namespace` 分组工具会被扁平化成 `ns__tool`（Chat 的函数名不允许点号），回程再还原成 `{ name, namespace }`；`web_search` 这类 DeepSeek 无对应能力的内置工具会被丢弃
- 响应方向：Chat SSE → Responses SSE（`response.created` / `output_item.added` / `output_text.delta` / `reasoning_summary_text.delta` / `function_call_arguments.delta` / `output_item.done` / `response.completed`）
- **补报沙箱拒绝**：`codex exec --json` 在只读模式下被拒绝的动作**完全不产生事件**（实测），桥在数据通路上能看见工具回传里的 `rejected: blocked by policy`，于是主动补一条 `denied` 通知给界面。这是「被拒绝要有明确反馈」能落地的原因。

这些行为都有自动化测试锁定，见第 10 节。

---

## 4. 逐动作审批（审批模式）

应用有两个驱动引擎，设置页「驱动引擎」里切换：

| 引擎 | 审批能力 | 说明 |
| --- | --- | --- |
| **审批模式（app-server）** 默认 | ✅ 允许一次 / 总是允许 / 拒绝 | 常驻 `codex app-server`，走 JSON-RPC。动作执行前由 Codex 主动发起审批请求 |
| 稳定模式（exec） | ❌ 无逐动作审批 | 一次性 `codex exec --json`，权限完全由沙箱模式决定 |

审批模式的实现要点（协议细节见 `docs/PROTOCOL.md`）：

- Codex 通过**服务端→客户端的 JSON-RPC 请求**征询意见：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`
- 三个按钮映射到 codex 的语义：允许一次 → `accept`，总是允许 → `acceptForSession`，拒绝 → `decline`
- **补丁预览**：`turn/diff/updated` 与 `item/fileChange/patchUpdated` 会带来补丁全文，文件变更审批卡片因此可以在应用前把 diff 渲染出来
- **拒绝有明确反馈**：拒绝后 Codex 收到的工具结果是 `Rejected("rejected by user")`，模型据此继续
- **自动回退**：如果 app-server 协议握手阶段就失败（它是 experimental，可能随版本变动），此时还没有任何副作用，应用会自动改用 exec 引擎继续跑，并在对话区提示原因
- 取消任务时，所有还在等待用户决定的审批会被自动拒绝（`cancel`），避免 Codex 一直挂在那里等

本机实测（`npm run test:approval`）：三种按钮语义都会真正影响 codex 的行为 —— 批准则文件被创建，拒绝则文件不存在且模型收到拒绝原因。

---

## 5. 上下文连贯与上下文长度

### 5.1 同一会话内多轮共享上下文

**同一个会话里连续提问会续接上下文**，不是每次从零开始。做法是让应用侧的「会话」绑定 codex 的 thread：

| 引擎 | 续接方式 |
| --- | --- |
| 审批模式（app-server，默认） | app-server **常驻**，thread 一直活着，第二轮直接 `turn/start` 到同一个 thread |
| 稳定模式（exec） | 每轮一个进程，但第二轮用 `codex exec resume <thread-id> <prompt>` 接上同一个 thread |

- thread id 记在会话文件里（`codexThreadId`），**重启应用后依然能续上**：app-server 用 `thread/resume`，exec 用 `resume` 子命令。
- **会话之间不串上下文**：引擎会记住当前 thread 属于哪个会话，换会话就换 thread。
- 运行中点「停止」**不会杀掉常驻进程**，thread 保留，可以接着问。
- 界面提示：状态条出现「已续接上下文」徽章即表示该会话持有 thread。
- 常驻进程空闲 10 分钟自动回收（否则它一直把工作目录当 cwd 占着，Windows 下该目录无法删除/改名）；回收后下次提问自动 `thread/resume`，上下文不丢。

### 5.2 上下文长度（必须配，否则长会话会出错）

codex 不认识 `deepseek-*` 模型，不显式声明就会退回**兜底元数据**（codex 自己会警告 *"this can degrade performance and cause issues"*），压缩时机因此算错：要么过早压缩，要么直接超限报错。

应用会把窗口写进生成配置，让 codex 知道边界：

```toml
model_context_window = 65536          # 设置页「上下文窗口」
model_auto_compact_token_limit = …    # 可选，0 = 由 codex 自行决定
```

- 设置页有 **64K / 128K / 256K** 快捷档位，也可手填。
- **默认 64K 是保守取值**（DeepSeek V3 系历史公开值）。宁可早压缩，也不要在真实请求时超限报错。请按你实际模型的能力调整 —— DeepSeek 文档里 `max_tokens` 允许到 384K，说明新版本上下文可能更长，但官方文档是 JS 渲染的，我没能抓到权威数字，所以没有替你猜大。
- 状态条实时显示 `上下文 12.3K / 62.3K（20%）`，到 85% 变红提醒。数字来自 codex 的用量通知（注意 codex 会在声明值上留余量：声明 65536 时它报的有效窗口是 62259）。
- 状态条的「压缩上下文」按钮可手动触发压缩（`thread/compact/start`）；压缩发生时对话区会出现一条「上下文压缩」卡片。

### 5.3 在任意文件夹启动

跑一次安装脚本（只影响当前用户，不需要管理员）：

```powershell
npm run install:launcher
```

它会创建桌面快捷方式、开始菜单快捷方式、把 `launch\` 加入用户 PATH、并注册资源管理器右键菜单。之后：

```powershell
codex-desktop            # 用上次的工作目录
codex-desktop .          # 用当前目录（像 code 那样）
codex-desktop D:\repo    # 用指定目录
```

也可以直接在资源管理器里**右键文件夹 →「在 Codex 驾驶舱中打开」**。

撤销：`npm run uninstall:launcher`

---

## 6. 个性化设置（二次元风格 / 背景图 / 可替换图片）

入口：**右上角齿轮图标**（顶部状态条右侧）→ 右侧抽屉。分区：视觉风格 / 背景 / 默认图片。底部三个操作：**全部恢复默认 / 取消 / 保存**。

交互规则：面板里的任何改动都会**立即预览**，点「保存」才写入配置；「取消」回滚；「全部恢复默认」把草稿清空并预览，仍需保存才落盘。

### 6.1 视觉风格：二次元（默认）

| 项 | 做法 |
| --- | --- |
| 配色 | 糖果色（樱花粉 `#ff6fb0` / 紫 `#c9b6ff` / 天蓝 `#9fd8ff` / 薄荷 / 奶油黄），浅色为「明亮治愈」，深色为「夜空」变体（仍是鲜艳紫粉，不再是冷灰蓝） |
| 面板/卡片 | 毛玻璃 `backdrop-filter: blur(10px) saturate(1.15)` + 14~18px 大圆角 + 1px 浅色高光描边 + 糖果色柔和投影 |
| 控件 | 按钮/开关/滑块/输入全部圆润（胶囊形），hover 有弹跳放大（`cubic-bezier(.34,1.56,.64,1)`），active 回缩 |
| 标题 | 圆体优先：`YouYuan / 幼圆 → Yuanti SC → Microsoft YaHei UI`；正文仍走系统字体 |
| 细节 | 滚动条渐变圆角、加载指示跳动、空状态柔光、Toast 胶囊化 |
| **底线** | **代码块 / 终端 / diff 一律保持原配色与高对比，不参与萌化**（CSS 里显式钉死，避免圆角与渐变规则漏进去） |

不想萌化时，抽屉里可一键切回「经典」风格（`data-style="classic"`），布局完全不动。

**顶部快捷切换**：状态条右侧有一个 `🎀 二次元` / `🖥 经典` 按钮，一键在「个性化」与「系统默认」之间来回切。它**只翻转 `stylePreset` 一个字段**，背景图、内置壁纸、头像、框选/缩放参数等全部原样保留——来回切多少次都不会丢设置。实现上是**主进程基于磁盘配置做读-改-写**（`appearance:toggleStyle`），而不是让渲染层拿内存里的副本拼一个新对象整体覆盖，后者一旦渲染层数据比磁盘旧就会把个性化数据清空。

### 6.2 背景：自适应 + 自由编辑

**内置壁纸**：星空 / 樱花 / 云海 三张，内联 SVG（矢量，任意分辨率都清晰，仓库里不放二进制资源）。

**默认自适应**：`cover` 居中铺满，**永不拉伸变形**（数学上取「铺满容器所需比例」的较大者），窗口尺寸变化由 `ResizeObserver` 实时跟随，不露白不错位。

**自由编辑**（抽屉里点「编辑背景」）：

| 控件 | 说明 |
| --- | --- |
| 缩放 | 滑块 50%~300%，保持比例；编辑弹窗右侧是**所见即所得**取景框，框内拖拽即平移 |
| 位置 | 拖拽平移，偏移量按容器比例记录，换窗口尺寸也不跑偏 |
| 框选范围 | 左侧显示整张图，**拖四角改选区、拖选区内部移动**；只显示选区内容 —— 人物、图标、场景都能精确锁定 |
| 实时预览 | 所有调整立即反映到真实背景上 |
| 重置 | 一键回到「自适应铺满」 |

参数（`zoom / offsetX / offsetY / crop{x,y,w,h}`）随背景图一起存进 `appearance.background.transform`。**参数异常自动回退**：任意一项 NaN / 越界 / 宽高为零，都会被净化成默认自适应，绝不会出现「参数坏了整块背景消失」。

### 6.3 头像 / 图标类图片（与背景彻底分开）

**两类图片走完全不同的路径，互不干扰**：

| | 全屏背景 | 头像 / 图标 / Logo |
| --- | --- | --- |
| 作用范围 | 铺满整个窗口 | **只填充自己所属的框架** |
| 渲染方式 | `BackgroundLayer` 全屏定位 + 遮罩 | `FittedImage` 在框架内 cover 居中裁切 |
| 数据位置 | `appearance.background` | `appearance.slots[id]` |
| 设置界面 | 抽屉「全屏背景」区 | 抽屉「头像与图标」区 |
| 可裁剪 | ✅ 缩放/平移/框选 | ✅ 同一套裁剪控件 |

槽位图片有**三重硬约束**保证不会跑出框架，也绝不会变成全屏背景：框架 `overflow: hidden` + 图片绝对定位填满 + `object-fit: cover`（居中、不拉伸）。圆形头像框会把内层一起裁圆。框架尺寸变化（窗口缩放、侧栏折叠）时由 `ResizeObserver` 自动跟随。

| 槽位 | 默认长什么样 | 裁剪框形状 |
| --- | --- | --- |
| 品牌标记 | 左侧栏顶部的机器人内联图标（文字标题保留） | 1:1 方形 |
| 空状态插图 | 未选目录 / 会话为空时显示的 Q 版小吉祥物 | 1:1 方形 |
| Codex 头像 | agent 气泡旁的 `AI` 文字徽标 | **圆形**（所见即所得） |
| 我的头像 | 你的提问气泡旁的 `你` 文字徽标 | **圆形** |
| 窗口 / 任务栏图标 | 系统窗口图标（原先是 Electron 默认） | — |

每个槽位可单独「上传图片 / 粘贴 URL / **裁剪 · 调整** / **重置为默认裁剪** / 恢复默认」。裁剪参数（`zoom / offsetX / offsetY / crop{x,y,w,h}`）存在该槽位的 `transform` 里，重启后恢复；参数异常会净化回默认的 cover 居中。

**不支持逐个替换 20 个内联功能图标**（终端、文件、齿轮等）：它们带尺寸与 `currentColor` 语义，换位图会破坏视觉一致性。

### 6.4 存储、校验与健壮性

- 存储：`~/.codex-desktop/config.json` 的 `appearance`（**不是 localStorage**，原因见 FAQ Q17）。目录可用 `CODEX_DESKTOP_HOME` 重定向。
- 类型校验：读**魔术字节**判真实类型，不信扩展名（`.exe` 改名成 `.png` 会被拒绝）。白名单含 `svg+xml`（内置壁纸要用）。
- 压缩：`<img>` → `<canvas>` → `webp(0.82)`，长边超 2560px 先缩放，零新依赖。GIF 能塞进配额就**原样保留动画**。
- 配额：单张建议 ≤1.5MB，总量超 3.5MB 给黄色警告。
- 失败回退：背景或槽位图 `onError` → 自动回退默认并提示。
- CSP：`img-src` 放开 `https: http:` 才能粘贴远程图片；⚠️ 加载远程图会把 IP 与 Referer 暴露给该主机，因此统一带 `no-referrer`。

---

## 7. 提交文件（附件）与右键菜单

### 7.1 提交文件给 Codex

三种入口，都是把**磁盘上的真实文件**交出去（不是复制一段文本）：

| 入口 | 用法 |
| --- | --- |
| 附件按钮 | 输入框右下角「附件」，多选 |
| 拖拽 | 把文件拖到输入框上（会自动高亮） |
| 粘贴 | 在输入框里 Ctrl+V 粘贴剪贴板中的文件 |
| 侧栏文件树 | 点一下文件名即加入附件；右键还有「交给 Codex 理解」 |

选好的文件在输入框上方变成 chips，显示文件名、体积，以及**这个文件会怎么被模型看到**：

- `已内联`：小文本文件（≤ 40 KB/个，总量 ≤ 120 KB），正文**直接拼进提示词**，模型不需要调工具就看得到；
- `工具读取`：大文本 / 二进制 / 图片，只把**路径**给模型，并附上现成的读取命令示例，由 Codex 用它的命令工具去读。

为什么是「两条腿走路」：codex 只认它自己的工具（shell / apply_patch），**应用没法给它塞一个自定义读文件工具**。所以能内联的就内联（零工具调用、最快最省），内联不了的老老实实给路径 + 读取示例。

**文件放哪**（这条直接影响能不能读得到）：

| 文件位置 | 做法 | 理由 |
| --- | --- | --- |
| 已在工作区内 | **原地引用**，不复制 | 不产生多余副本，codex 本来就能读 |
| 工作区之外 | 复制到 `<APP_DIR>/attachments/<会话 id>/` | 不污染用户仓库；给模型的路径指向副本 |

> 实测提示：附件副本在工作区之外，**只读沙箱**下 codex 去读它时会弹一次审批（这是 codex 的策略，不是 bug）。点「允许一次」即可；同类读取也可以点「总是允许」。小文本文件因为已内联，根本不需要读，也就不弹。

界面上**只显示你的原话**，拼好的附件清单与正文不会灌进气泡；本轮回看时气泡下面会挂上附件 chips，另有一条 notice 说明本轮提交了什么。文件正文里若正好含有内联分隔符，会被打散，避免和应用的标记混淆。

**已提交的会话被删除时，它的附件副本一并清理**；原地引用的工作区文件绝不删除。

### 7.2 工作区文件树

侧栏「工作区文件」分区：点文件名 = 交给 Codex；点目录 = 展开/收起；顶部可过滤文件名；右上角 ↻ 重新扫描。

扫描是**有界**的，避免大仓库把界面拖死：默认最多 4 层、2000 项，并跳过 `node_modules`、`.git`、`dist`、`out`、`.venv`、`__pycache__`、`target` 等依赖/构建/缓存目录（被跳过的类别会在底部注明）。界面一次最多渲染 600 行。

### 7.3 右键菜单

原生菜单（Electron `Menu.popup`），按**光标下是什么**动态生成：

| 右键位置 | 菜单项 |
| --- | --- |
| 输入框 | 撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选 / 清空输入框 |
| 选中了文本 | 复制选中文本 |
| 消息气泡 | 复制这条消息 / 复制工作目录 |
| 代码块 | 复制代码（取原始源码，不是渲染后的文本） |
| 命令卡片 | 复制命令 / 复制工作目录 |
| 命令输出 | 复制输出 |
| 附件 chip | 复制文件路径 / 在资源管理器中显示 / 移除这个附件 |
| 文件树里的文件 | 交给 Codex 理解 / 复制路径 / 在资源管理器中显示 / 用默认程序打开 |
| 会话历史项 | 复制工作目录 / 在资源管理器中显示工作目录 / 打开工作目录 |
| 工作目录标签 | 复制工作目录路径 / 在资源管理器中显示 |

两个实现要点：

- **编辑类动作走 Electron 内置 role**（`cut`/`copy`/`paste`/`selectAll`/`undo`/`redo`），并按 `editFlags` 置灰（没选中文本时「剪切/复制」是灰的，剪贴板为空时「粘贴」是灰的）。这是唯一能可靠作用到输入框与系统剪贴板的做法。
- **目标识别在渲染层做**：原生菜单拿不到「光标下是哪个元素」，所以渲染层在 **右键 mousedown** 时就认出来并上报主进程（mousedown 严格早于 contextmenu，避免菜单按上一个目标弹出）。上报的正文超过 20 万字符会截断，菜单里会写明「仅前 N 字符」，不会假装复制到了全文。超过 5 秒的旧目标视为过期，只出通用项。

---

## 8. 配置与数据存放位置

应用**不会修改你现有的 `~/.codex/config.toml`**（有测试专门校验这一点）。所有自己的东西都放在：

```
~/.codex-desktop/
├─ config.json              # 设置 + DeepSeek API Key（本机明文，权限 600，绝不进代码/仓库）
├─ codex-home/
│   └─ config.toml          # 应用自动生成：provider 指向本地桥 + 工作区信任项，每次启动重写
├─ sessions/<id>.json       # 会话与事件历史 + codexThreadId（重启后仍可查看并续接上下文）
├─ attachments/<会话 id>/    # 你提交的工作区外文件的副本（会话删除时一并清理）
└─ logs/                    # 预留
```

三种 provider 策略（设置页可切）：

| 模式 | 说明 |
| --- | --- |
| 内置协议桥（默认） | 兼容性最好，DeepSeek 的 `chat/completions` 一定能用；`temperature` 由桥注入 |
| 复用用户 Codex 配置 | `CODEX_HOME` 指回 `~/.codex`，你原有的插件/MCP/skills 全部生效；provider 仍由 `-c` 覆盖注入 |
| 直连 DeepSeek 原生 Responses | 仅当你的账号/模型确实支持 `POST /v1/responses` 时才开启，否则会 404 |

API Key 通过 `env_key`（`DEEPSEEK_API_KEY`）以**环境变量注入子进程**，不会写进 codex 配置，也不会出现在命令行里。

---

## 9. 目录结构

```
codex-desktop/
├─ src/
│  ├─ shared/types.ts           # 全应用类型契约（设置/事件/会话/审批/IPC）
│  ├─ core/                     # 纯 Node 核心，可脱离 Electron 测试
│  │  ├─ bridge/                # Responses↔Chat 协议桥
│  │  │  ├─ tools.ts            # 工具名映射与净化
│  │  │  ├─ translate.ts        # 请求翻译（Responses → Chat）
│  │  │  ├─ stream.ts           # 响应翻译（Chat SSE → Responses SSE）
│  │  │  └─ server.ts           # 本地 HTTP 服务 + 沙箱拒绝嗅探
│  │  ├─ execEngine.ts          # spawn `codex exec --json`，进程树管理
│  │  ├─ appServerEngine.ts     # spawn `codex app-server`，JSON-RPC + 逐动作审批
│  │  ├─ eventParser.ts         # JSONL → 归一化事件
│  │  ├─ codexCli.ts            # 定位 codex.js（避免 .ps1/.cmd 的引号问题）
│  │  ├─ codexHome.ts           # 生成隔离 CODEX_HOME 与 -c 覆盖
│  │  ├─ settings.ts            # ~/.codex-desktop/config.json
│  │  ├─ sessions.ts            # 会话持久化
│  │  ├─ attachments.ts         # 附件：类型嗅探 / 拷贝 / 内联与提示词拼装
│  │  ├─ workspaceFiles.ts      # 工作区文件枚举（有界遍历 + 跳过重目录）
│  │  ├─ contextMenu.ts         # 右键菜单模板（纯函数，可单测）
│  │  ├─ diff.ts                # git diff / 新增文件合成 diff
│  │  └─ envCheck.ts            # 环境自检
│  ├─ main/                     # Electron 主进程
│  │  ├─ index.ts               # 窗口 + IPC + 原生右键菜单
│  │  └─ orchestrator.ts        # 桥 + 引擎 + 会话 + 状态编排
│  ├─ preload/index.ts          # contextBridge 暴露受控 API
│  └─ renderer/                 # React 界面（三栏 + 主题 + diff 面板 + 个性化抽屉）
│     ├─ src/appearance.css     # 背景图层 / 槽位 / 抽屉样式（默认不生效）
│     ├─ src/hooks/useAppearance.ts      # 落成 CSS 变量 + 槽位解析与失败回退
│     ├─ src/components/PersonalizationDrawer.tsx
│     ├─ src/components/WorkspaceFiles.tsx # 侧栏工作区文件树
│     ├─ src/utils/contextTarget.ts        # 右键目标采集与上报
│     └─ src/utils/image.ts     # 魔术字节校验 / canvas 压缩 / 体积估算
├─ launch/                      # 任意文件夹启动（cmd 启动器 + 安装/卸载脚本）
├─ test/                        # 自动化测试 + 真实协议 fixture
├─ scripts/                     # verify-app / verify-launch / verify-appearance（CDP）
└─ docs/PROTOCOL.md             # 两个协议的字段对照与实测记录
```

---

## 10. 测试与验证（可自行复现）

```powershell
npm run typecheck        # 主进程 + 渲染层类型检查
npm run test:unit        # 协议翻译回归（秒级，用真实抓取的请求体做 fixture）
npm run test:bridge      # 真实 codex ←→ 内置桥 ←→ mock DeepSeek（两个场景）
npm run test:pipeline    # 应用编排层端到端（含会话持久化与取消任务）
npm run test:approval    # 逐动作审批端到端（允许一次 / 拒绝 / 总是允许）
npm run test:continuity  # 上下文连贯与上下文长度（exec resume / 常驻 thread / 重启续接 / 会话隔离）
npm run test:appearance  # 个性化：图片类型识别 / URL 校验 / 体积估算 / 配置净化 / 背景布局数学
npm run test:attachments # 附件纯逻辑：类型嗅探 / 内联与超限 / 拒绝非法输入 / 提示词拼装
npm run test:filetree    # 工作区文件枚举：有界遍历 / 跳过重目录 / 顺序稳定 / 上限截断
npm run test:contextmenu # 右键菜单模板：各位置的菜单项、置灰规则、过期目标、结构不变量
npm run verify:app       # 真的启动 Electron，并用 CDP 断言渲染层挂载成功
npm run verify:launch    # 从别的目录带工作区参数启动，断言界面落在该目录
npm run verify:appearance # 个性化端到端：设背景/槽位 → 重载仍在 → 坏图回退 → 恢复默认
npm run verify:background # 背景可见性（像素采样）+ 自适应/缩放/平移/框选/窗口跟随
npm run verify:slots      # 头像/图标必须留在框架内，且绝不触发全屏背景
npm run verify:conversation # 验收：真实应用里连跑 5 轮对话，断言无任何报错
npm run verify:approval-ui  # 界面级审批：真点三个按钮，断言命令执行/被拒/同命令不再询问
npm run verify:context-ui   # 界面级上下文：直接检查发往上游的 messages 是否带前几轮内容
npm run verify:attach-ui    # 界面级附件：投喂真实文件 → 内联进提示词 + codex 用工具读到内容
npm run verify:contextmenu-ui # 界面级右键：各位置的目标上报 + 真实系统剪贴板往返
npm run pack:portable      # 打包成「解压即用」的 zip（自带 Electron 运行时与 codex）
npm run verify:portable    # 解压到别处 → 从解压副本跑 5 轮对话，验证迁移后可用
npm run diagnose:appserver # app-server 启动体检：入口/cwd、依赖完整性、传输方式、退出码解码
```

本机实测结果：`typecheck` 通过、`test:unit` 29/29、`test:bridge` 15/15、`test:pipeline` 25/25、`test:approval` 22/22、`test:continuity` 19/19、`test:appearance` 58/58、`test:attachments` 57/57、`test:filetree` 26/26、`test:contextmenu` 30/30、`verify:app` 通过、`verify:launch` 4/4、`verify:appearance` 46/46、`verify:background` 27/27、`verify:slots` 21/21、`verify:conversation` 19/19（含头像几何与 5 轮对话）、`verify:approval-ui` 14/14、`verify:context-ui` 17/17、`verify:attach-ui` 26/26、`verify:contextmenu-ui` 29/29、`verify:portable` 12/12。

**右键菜单为什么这样测**：原生菜单不是 DOM，CDP 点不到，而且 `Menu.popup` 在 Windows 上会进入模态消息循环、真弹出来会把主进程卡住。所以「菜单里有哪些项、哪些该灰」由 `test:contextmenu` 用纯函数钉死；`verify:contextmenu-ui` 验证我们自己写的那一半——右键时渲染层有没有正确认出「光标下是什么」并上报；剪贴板则用 `Get-Clipboard` 读系统剪贴板做真实往返。原生菜单本身另有一次真实右键的冒烟检查（断言应用不崩）。


`verify:appearance` 里包含一段**真实鼠标点击**的回归：点齿轮 → 断言抽屉确实在视口内可交互（曾经因为样式块被整段删除而导致「点了没反应」，只断言「按钮存在」是查不出来的）。

`verify:background` 用**像素采样**证明背景真的可见：铺一张纯红背景，截图后在页面里画到 canvas 上取色，断言侧栏/对话区/右面板的像素确实呈红（R 明显大于 G/B）——只看 CSS 属性是证明不了这件事的。

`test:continuity` 会真的驱动 codex 并断言：第二轮的上游请求里能看到第一轮的回复（证明上下文确实续上了）、dispose 掉常驻进程后第三轮仍能续接且 thread id 不变、另一个会话不会串到旧上下文、生成的 `config.toml` 里带上了 `model_context_window`。

其中 `test:bridge` 会真的启动 `codex exec`，并断言：

- Codex 的 `command_execution` 条目真的出现，且命令在本机执行、输出回传（`exit_code=0`）
- 第 2 次上游请求里带回了 `role: "tool"` 的命令输出
- `reasoning_content` 被正确映射成 reasoning 条目
- 只读沙箱下写入被拒绝、文件确实没被创建、且补报了 `denied` 通知

`test:pipeline` 用的是应用自己的编排层，还会校验：生成的 `codex-home/config.toml` 指向本地桥且 TOML 没被 Windows 路径写坏、会话落盘且状态为 `completed`、取消任务后状态为 `cancelled`、**用户真实的 `~/.codex/config.toml` 未被改动**。

---

## 11. 常见问题（FAQ）

**Q1. `npm install` 后启动报「找不到 Electron」/ `node_modules\electron\dist` 不存在**
Electron 二进制没下下来（国内网络常见）。执行：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
node node_modules/electron/install.js
Test-Path node_modules\electron\dist\electron.exe   # 应输出 True
```

**Q2. 报 ``wire_api = "chat"` is no longer supported`**
说明你想让 codex 直连某个 Chat 协议端点。这是 codex 0.154.0 的行为，不是本应用的 bug。保持默认「内置协议桥」即可，不要手改 `codex-home/config.toml`（每次启动会被重写）。

**Q3. 命令输出里混进一大段 PowerShell 报错**
本机实测过这种情况：你的 PowerShell 会在启动时加载 profile，如果 PATH 里有被写坏的条目（例如含中文乱码的路径），`Conda.psm1` 的 `Invoke-Expression` 会抛 `Unexpected token`，这段噪音会出现在每条命令的输出里。它不影响 Codex 工作，但会污染界面。修法：把 PATH 里那条非法路径删掉，或改用不带 Conda 初始化的 shell。

**Q4. 界面上出现「Model metadata for `deepseek-chat` not found」**
Codex 不认识第三方模型名，只是提示会用兜底元数据。应用已把它降级成「提示」而不是「错误」，可以忽略。

**Q5. 「Diff 预览」说不是 Git 仓库**
Diff 视图依赖 `git diff`。在所选目录执行 `git init` 即可；Codex 的改动本身已经正常写盘，不受影响。

**Q6. 提示「沙箱拒绝了该动作」**
说明当前权限模式不允许这个动作（例如只读模式下写文件）。这是设计内的保护。想让它执行，把权限模式调到「工作区写入」或「完全访问」后重跑该任务。拒绝原因会显示在对话区的红色提示条里。

**Q7. 一直提示任务在运行 / 想强行中断**
点顶部状态条的「停止」。应用在 Windows 上用 `taskkill /T /F` 结束整棵进程树，避免 powershell 子进程残留。

**Q8. `deepseek-reasoner` 能用工具调用吗？**
`deepseek-reasoner` 的工具调用支持与其版本相关。如果它在工具调用上报错，换回 `deepseek-chat`（默认值）即可。

**Q9. API Key 安全吗？**
只写在 `~/.codex-desktop/config.json`（权限 600），通过环境变量传给子进程，不进入代码仓库、不出现在命令行、不经过任何第三方服务器（桥只监听 `127.0.0.1`）。

**Q10. 怎么确认它真的在驱动 codex 而不是调聊天接口？**
运行 `npm run test:bridge`：它启动真实 `codex exec` 子进程，断言命令真的在本机执行并回传输出。另外 `~/.codex-desktop/codex-home/config.toml` 里的 `base_url` 指向本机桥，桥再转发到 DeepSeek——链路是可见、可查的。

**Q11. 审批卡片怎么用？点了「拒绝」会怎样？**
默认就是审批模式：Codex 在跑越界命令或改文件前会弹出卡片，卡片上会显示完整命令 / 受影响文件与理由。
- **允许一次** → 只放行这一次
- **总是允许** → 本会话内同类动作不再询问
- **拒绝** → 动作不执行，Codex 收到 `rejected by user` 并继续往下走（不会静默失败）

文件变更类的审批可以直接在右侧 Diff 面板看补丁全文再决定。
如果想关掉审批、只要沙箱控制，把「驱动引擎」切到「稳定模式（exec）」即可。

**Q12. 审批模式启动失败 / 提示自动回退到稳定模式？**
`app-server` 在 codex 里标注为 experimental，协议可能随版本变动。握手失败时应用还没执行任何动作，会安全回退到 exec 引擎并提示原因，任务不会白白失败。想避免回退就在设置里固定用「稳定模式（exec）」。

**Q13. 同一个会话里再问一次，它还记得前面说过什么吗？**
记得。见第 5.1 节：审批模式下 app-server 常驻共享 thread，稳定模式下用 `codex exec resume` 续接，重启应用后也能续上（`thread/resume`）。状态条上的「已续接上下文」徽章表示当前会话持有 thread。不同会话之间不会串上下文。

**Q14. 长会话会不会因为上下文超限报错？**
会，如果 `model_context_window` 没配对。默认已填 64K。如果你的模型支持更长上下文，去设置页调到 128K/256K；反之如果遇到上游报上下文超限，把它调小并点「压缩上下文」。状态条会显示当前占用百分比（85% 变红）。

**Q15. 桌面快捷方式 / 右键菜单 / `codex-desktop` 命令是怎么来的？**
由 `npm run install:launcher` 创建（只写当前用户的 PATH 与 HKCU 注册表，不需要管理员）。撤销用 `npm run uninstall:launcher`。注意 PATH 改动要**新开一个终端**才生效。

**Q16. 为什么关掉应用后，某个工作目录还是删不掉？**
常驻的 codex app-server 把工作目录当 cwd，Windows 会锁住它。应用空闲 10 分钟会自动回收进程，退出应用（`before-quit`）也会回收。如果急着删目录，先退出应用即可。

**Q17. 背景图/头像存在哪？为什么不用 localStorage？**
存在 `~/.codex-desktop/config.json` 的 `appearance` 里。不用 localStorage 的原因：dev 模式是 `http://localhost:5173`、构建后是 `file://`，**两者是不同 origin，localStorage 不互通**，你在开发时设的图打包后会全丢；而且 localStorage 约 5MB 上限，和图片抢配额容易 `QuotaExceededError`。顺带一提：配置目录可以用环境变量 `CODEX_DESKTOP_HOME` 重定向（便携安装/自动化测试用）。

**Q18. 传了一张图，提示「无法识别为图片」？**
我读的是文件**魔术字节**而不是扩展名。如果你把一个非图片文件改成 `.png`，就会被拒绝——这是故意的。另外入口上限 5MB，超了会直接提示实际大小。

**Q22. 背景图为什么看不见？（已修复，附根因）**
根因是**遮挡层叠加太厚**，实测：面板背景 alpha 0.74~0.76（只剩 24% 透过）、上面还有一层 `opacity 0.55` 的全屏渐变（渐变自身 58%~88% 不透明）、再叠 `backdrop-filter: blur(12px)`，净透过率只有 **12%~16% 且被糊掉**；加上默认主题是冷灰蓝，整体就偏冷偏暗。修复：面板 alpha 降到 **0.38/0.42**、遮罩默认 **0.22**、模糊 **10px**，净透过率约 **0.49**，并把默认风格换成二次元糖果色。`npm run verify:background` 会用像素采样验证这件事。

**Q23. 背景只能整图铺满，想放大/挪位置/只显示某一块？**
抽屉里点「编辑背景」：左边**框选范围**（拖四角改大小、拖选区移动，用来锁定人物/图标/场景），右边**所见即所得**取景框（拖拽平移 + 50%~300% 缩放滑块）。改完点保存，参数会写进配置，重启后仍在。点内置壁纸再点编辑会自动转成可编辑副本。

**Q24. 调坏了背景参数怎么办？**
点编辑弹窗里的「重置为自适应铺满」。另外任何异常参数（NaN、越界、宽高为零）在保存和读取时都会被净化回默认自适应，不会出现「参数坏了背景整块消失」。

**Q25. 点了齿轮没反应 / 个性化面板打不开？（已修复）**
根因是**样式被整段删除**：重写 `appearance.css` 做二次元主题时，把抽屉的布局规则（`.drawer-root { position: fixed; inset: 0; z-index: 70 }`、`.drawer { position: absolute; right: 0; width: 420px }` 等）一起删掉了。于是抽屉虽然渲染了，但没有定位，按普通流排到 `.app` 内容之后——落在视口下方（实测 `rect.y = 827`，正好等于窗口高度），所以「点了没反应」。**表现形式**是能查到 `.drawer-root` 元素、`display: block`，但 `inViewport: false`。

已经恢复该样式块，并在文件里加了醒目注释。`npm run verify:appearance` 现在会**真实点击齿轮**（CDP 鼠标事件）并断言：抽屉在视口内、`z-index=70`、宽度≈420、命中测试落在抽屉内、三个分区标题齐全、点遮罩能关闭。之前只断言了「齿轮按钮存在」，没断言「点开能用」，这个盲区已经补上。

**Q26. 切换风格会把我的个性化设置清掉吗？**
不会。顶部 `🎀/🖥` 按钮只翻转 `stylePreset`，且在主进程里基于**磁盘上的最新配置**做读-改-写，所以背景图、壁纸、头像、框选参数都原样保留。测试里专门做了断言：切到经典再切回来，背景源、3 个槽位、遮罩/模糊数值全部不变。

**Q28. 应用里一发任务就报「进程已退出 code = 4294967295」、然后回退到稳定模式？（已修复）**这是**最隐蔽的一个 bug**，根因在 `src/core/codexCli.ts`：

它把 `nodePath` 设成了 `process.execPath`。在 Electron 里 `process.execPath` 是 **`electron.exe`**，于是应用实际执行的是：

```
electron.exe  <codex>/bin/codex.js  app-server  …
```

这会让**子进程启动一整套 Chromium**。Chromium 去抢父进程（我们的应用）已经占用的 userData/Cache 目录，失败后直接退出——Windows 上退出码就是 `-1`（`4294967295`），而且 **stderr 全是空的**，所以非常难自查。子进程自己的日志里能看到：

```
ERROR:net\disk_cache\cache_util_win.cc:25] Unable to move the cache: 拒绝访问。(0x5)
ERROR:gpu\disk_cache\gpu_disk_cache.cc:737] Gpu Cache Creation failed: -2
```

**为什么之前几轮排查都没抓到**：我在纯 `node` 进程里做探针，父进程不是 Electron，子 electron.exe 能独占 profile 目录，于是**一切正常**——只有「父进程也是 Electron」时才复现。这也解释了为什么它只在真实应用里出现。

**修复**：给 codex 子进程加 `ELECTRON_RUN_AS_NODE=1`，让 electron.exe 以**纯 Node 模式**运行，完全不初始化 Chromium（`codexChildNodeEnv()`）。两个引擎都加上了，同时也修了 `--version` 探测那次调用（它同样会用 electron.exe）。

**回归测试**：`npm run verify:conversation` 会启动真实应用、**连续 5 轮对话**，并断言每轮都收到回复且界面上没有任何报错（含此前的 `-1` 退出与回退提示）。两个引擎都跑：

```powershell
npm run verify:conversation                    # 审批模式（默认）
$env:CONV_ENGINE='exec'; npm run verify:conversation   # 稳定模式
```

顺带修掉的第二个问题：`exec` 引擎下 JSONL 的 `turn.completed` 会**早于**进程退出到达，而主进程要等进程 close 才把「运行中」置否。渲染层原先按轮次状态推断「是否在运行」，于是出现「界面显示空闲、主进程仍在跑」的分歧——用户按 Enter 会被主进程以「已有任务正在运行」拒绝，看着像莫名报错。现在**运行状态以主进程的 `RunStatus` 为唯一权威**，不再从轮次状态推断。

**Q29. 设了头像/图标之后，那张图铺满了整个屏幕？（已修复）**
和 Q25 是**同一类错误**：重写 `appearance.css` 做二次元主题时，把「可替换图片槽位」整段样式删掉了。后果是 `.brand-mark-img` 的 `width/height:100%` 与 `object-fit:cover` 全部失效，图片按**原始尺寸**渲染。实测数据：

```
设置前：.brand-mark-img  渲染 800×600，父容器 .brand-mark 只有 30×30，overflow: visible
                       computed width: 800px（= 图片原始尺寸），objectFit: fill
设置后：.brand-mark .fit-img  渲染 30×30，object-fit: cover，父容器 overflow: hidden
```

30×30 的框里塞一张 800×600 的图、父容器又不裁剪，于是整张图溢出来铺满屏幕。**注意它其实不是背景层**——`data-has-bg` 始终是 `null`、`.app-bg` 根本不存在，只是看起来像而已。

修复分三层：
1. **样式**：框架 `overflow:hidden` + 图片绝对定位填满 + `object-fit:cover` 居中，三重约束。
2. **组件**：新增 `FittedImage`，槽位图片统一走它渲染，杜绝再漏。
3. **回归测试**：`npm run verify:slots` 会用 **800×600 的大图**做槽位，断言渲染尺寸等于框架尺寸（而不是 800×600）、`object-fit` 是 `cover`、父容器 `overflow:hidden`、**页面上没有任何铺满视口的图片**、以及 `data-has-bg` 仍为空。`verify:conversation` 里也加了真实头像的几何断言（实测 800×600 的头像渲染成 23×23、圆形、裁剪正确）。

> 教训记在这里：两次事故都源于**在一个大 CSS 文件里同时维护「布局/尺寸」和「主题装饰」**，改主题时误删布局。现在的应对是给每个区块加醒目注释 + 用**计算后几何**（而不是"类名存在"）做断言——只断言类名是查不出这类问题的。

**Q27. `app-server` 子进程退出码是 4294967295（-1），是不是启动失败？**
先给结论：**这个码表示进程自己调用了 `exit(-1)`，不是被本应用杀掉的**（原因见 Q28：是子 electron.exe 启动 Chromium 失败后自杀）。本机实测对照过：

| 情形 | 父进程看到的 code |
| --- | --- |
| 被本应用 `taskkill /T /F` 结束 | **1** |
| 子进程自己 `process.exit(-1)` | **4294967295**（无符号表示；有符号就是 -1） |
| 子进程自己 `process.exit(0)` | 0 |

另外三个容易误判的点，都已实测澄清：

1. **`codex app-server` 默认走 stdio，不监听任何端口**（`--listen` 默认 `stdio://`），所以**不存在「端口被占用」这回事**；本应用也没有传 `--listen`。本应用唯一 bind 端口的是内置协议桥，它用 `bind 127.0.0.1:0` 让系统分配，冲突概率≈0。
2. **app-server 不是本项目的入口文件**，而是第三方包 `@openai/codex` 的原生二进制（经 `bin/codex.js` 启动）。所以无法、也不应该在它源码里加 `console.error`——那属于改全局 npm 包，升级即被覆盖。
3. **「app-server 的 package.json」指的是 `@openai/codex` 的包**，本机体检结果是完整的（`package.json` ✓、`bin/codex.js` ✓、`@openai/codex-win32-x64` 平台包 ✓、5 个原生二进制 ✓）。

**自查方式**：直接跑

```powershell
npm run diagnose:appserver
```

它会依次检查 ①入口路径与 cwd（用应用真实的解析逻辑）②依赖完整性 ③传输方式与端口 ④现场起一次并**解码退出码**、打印 stderr。想看应用运行时更啰嗦的引擎日志，设 `CODEX_DESKTOP_DEBUG=1` 再启动。

如果体检显示「进程自行 exit(-1) 且 stderr 为空」，那基本是原生二进制/运行时层面的问题，建议重装：

```powershell
npm i -g @openai/codex --registry=https://registry.npmmirror.com
```

顺带一提，本应用现在会在**握手失败时把完整诊断**（入口路径 / cwd / CODEX_HOME / 退出码 / stderr 末尾 / 是否由应用主动结束）一起写进提示，而不是只丢一句「握手失败」。另外 `thread/start` 的超时在「复用用户 Codex 配置」时放宽到 180s —— 因为用户自己的 `config.toml` 里 MCP server 的 `startup_timeout_sec` 常见是 120s，用原来的 60s 会把「启动慢」误判成「握手失败」并把进程杀掉。

**Q19. GIF 传上去不动了？**
如果 GIF 原图能塞进 1.5MB 配额，会**原样保留**（动画还在）；超过配额才会重编码成静态首帧并提示你。

**Q20. 粘贴的图片 URL 显示不出来？**
先看提示：坏地址会在粘贴时就被拦下（会先试加载一次）。如果当时能加载、后来失效，界面会显示「图片加载失败，已回退到默认图」并自动用回程序默认图，不会留破图。另外远程图片需要放宽 CSP 的 `img-src`，本应用已放开 `https:` 与 `http:`；加载远程图片会把你的 IP 暴露给该主机，所以统一带了 `no-referrer`。

**Q21. 改了背景后感觉界面变糊/看不清字？**
调高「遮罩强度」（面板里实时可调，越大文字越清晰），或把「背景模糊」调大。面板改成半透明是为了透出背景，遮罩强度就是为对比度准备的。

**Q22. 提交了文件，但模型说读不到内容？**
先看 chip 上的标记：`已内联` 表示正文已经拼进提示词了，模型一定能看到；`工具读取` 表示只给了路径（大文件/二进制/图片），要靠 Codex 自己用命令去读。若 Codex 读取时报乱码，多半是 PowerShell 的编码问题——应用给出的读取示例里已经带了 `-Encoding UTF8`。
另外只读模式下读工作区外的附件会先弹一次审批，批准后才会真正执行；只读沙箱下读工作区内的文件不需要审批。

**Q23. 右键没有菜单，或菜单项不对？**
菜单是按「光标下是什么」生成的。若右键的是纯空白区域（没有任何 `data-ctx` 标记），应用不会弹菜单。若某类位置缺项，多半是渲染层上报的目标类型不对——`npm run test:contextmenu` 会把每种位置的菜单语义直接测出来。跨过 5 秒的旧目标会被当成过期，只出通用项。

**Q24. 提交的文件会不会留在我电脑上？会不会动我的仓库？**
工作区内的文件**原地引用**，不复制、不修改。工作区外的文件会复制一份到 `~/.codex-desktop/attachments/<会话 id>/`，删除该会话时一并清理；原地引用的文件永远不会被删除。你的仓库里不会多出任何文件。

---

## 12. 交付状态（对照最初需求）

| # | 需求 | 状态 |
| --- | --- | --- |
| 1 | 子进程调 `codex exec --json`，解析事件流并实时渲染 | ✅ 已完成并有端到端测试 |
| 2 | 工作区选择，任务在所选目录执行 | ✅ `-C <dir>`，含最近使用列表 |
| 3 | 自然语言任务，全程可视化 | ✅ |
| 4 | 审批按钮 + 权限模式切换 + 拒绝反馈 | ✅ 已完成：默认审批模式下逐动作「允许一次 / 总是允许 / 拒绝」；权限模式三档；拒绝有明确反馈（`npm run test:approval` 22/22） |
| 5 | Diff 预览 | ✅ 对话区内联卡片 + 右侧专用 Diff 面板（含未跟踪新文件的合成 diff） |
| 6 | 复用/自建配置、模型选择、API Key、temperature | ✅ 三种 provider 策略；temperature 由桥注入 |
| 7 | 不依赖 OpenAI 账号，全程 DeepSeek | ✅ |
| 8 | 中文界面，三栏布局 + 工具活动流 + diff 面板 | ✅ |
| 9 | 流式输出 + 运行状态指示 | ✅ 含当前工具名与耗时 |
| 10 | 会话保存/加载/重启后可见 | ✅ `~/.codex-desktop/sessions/*.json` |
| 11 | 深浅色主题 | ✅ |
| 12 | 先勘察环境、给方案确认再写代码 | ✅ |
| 13 | 新建子目录、不动其他文件、国内源 | ✅ 只在 `codex-desktop/` 内；源码仓库之外的文件未改动 |
| 14 | 小步实现、先跑通最小版本 | ✅ M1→M2 已跑通验证 |
| 15 | API Key 只存本地、直连官方接口 | ✅ |
| 16 | 启动命令、首次步骤、FAQ、自测 | ✅ 本文档 + 五层测试；⚠️ 真实 DeepSeek Key 的端到端验收待你提供 Key 后完成（此前全部用 mock 上游验证协议正确性） |

### 后续追加的能力（不在最初清单里）

| 能力 | 状态 |
| --- | --- |
| 多轮上下文连贯（同会话共享 codex thread，重启后续接） | ✅ `npm run test:continuity` 19/19 |
| 上下文长度治理（声明 `model_context_window` + 自动/手动压缩 + 占用可视化） | ✅ 同上，含状态条百分比与压缩按钮 |
| 任意文件夹启动（PATH 命令 / 桌面与开始菜单快捷方式 / 右键菜单） | ✅ `npm run verify:launch` 4/4 |
| 个性化设置（背景图 + 5 个可替换图片槽位 + 抽屉面板） | ✅ `npm run test:appearance` 58/58、`npm run verify:appearance` 23/23 |
| 二次元萌系风格（糖果色 + 毛玻璃 + 圆润控件 + 内置星空/樱花/云海壁纸） | ✅ `npm run verify:background` 27/27（含像素采样） |
| 顶部快捷切换「个性化 / 系统默认」（不清除个性化数据） | ✅ `npm run verify:appearance` 46/46 |
| 压缩包迁移（自带 Electron 运行时与 codex + 便携模式） | ✅ `npm run verify:portable` 12/12（解压后 5 轮对话 13/13） |
| 背景自适应与自由编辑（缩放 / 平移 / 框选 / 实时预览 / 重置 / 参数持久化） | ✅ 同上 |
| 背景可见性根因修复（面板 alpha 0.76→0.42、遮罩 0.55→0.22） | ✅ 像素级证明背景确实透出 |
| **提交文件（附件）**：按钮/拖拽/粘贴 + 小文本内联 + 大文件交给工具读取 | ✅ 见第 7 节；`npm run test:attachments` 57/57、`npm run verify:attach-ui` 26/26 |
| **工作区文件树**：有界扫描 + 过滤 + 点击即交给 Codex | ✅ `npm run test:filetree` 26/26 |
| **右键菜单**：复制/粘贴/全选等编辑动作 + 按目标动态生成的应用动作 | ✅ 见第 7.3 节；`npm run test:contextmenu` 30/30、`npm run verify:contextmenu-ui` 29/29 |

### 尚未完成 / 已知限制

1. **真实 DeepSeek 端到端验收**：本机没有任何可用凭据，全部端到端测试使用 mock 上游来验证「codex ↔ 桥 ↔ 编排层」这段协议与流程的正确性。拿到真实 Key 后，第 2 节的「测试连通性」+ 发一个任务即可完成验收。
2. **`app-server` 协议是 experimental**：逐动作审批依赖它，未来 codex 升级可能需要跟进。已实现握手失败自动回退。
3. **打包（`npm run dist`）未验证**：electron-builder 需要额外下载 winCodeSign/NSIS 二进制，本机未跑过。开发/使用用第 2 节的 `npm run dev` 或 `npm run build && npm run preview`。
4. **两种引擎的拒绝反馈来源不同**：exec 引擎下只读沙箱拒绝不产生事件，应用靠桥嗅探补报；审批模式下则由 Codex 主动征询。两者界面表现一致，但底层机制不同。
5. **附件不会让文本模型「看见」图片**：DeepSeek 的文本模型没有视觉能力，图片只能把路径交给 Codex，由它用工具处理（界面里已如实标注）。若换成支持视觉的模型，需要改桥的请求翻译（把图片转成 `image_url`）。
6. **只读模式下读工作区外的附件会弹一次审批**：附件副本放在应用数据目录（为了不污染仓库），codex 认为越过工作区边界的命令需要批准。小文本文件因为已内联不需要读，不受影响；也可以点「总是允许」（按命令记住）。
