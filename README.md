# dsh-alert-chime

为 **DeepSeek Harness Web GUI** 加提示音与右下角通知：审批弹窗、提问
（`ask_user_question`）、以及"运行结束、等你输入"这三种时刻，都会响铃并弹一张卡片。

实现方式是 **动态 Cordis 插件**（Host 半边 + Client 半边），不安装依赖、不改
composition、不重建 web 产物。

## 为什么是这个方案

DSH 里没有内建的提示音能力（本机部署的 config 里搜 `notification|beep|sound|audio|chime`
无任何匹配）。社区倒是有现成的（`Abel-86/task-chime`、`Machine-126/dsh-alert-sound`
等），但那条路要先做供应链安全扫描、装进部署的 `node_modules`、改 Cordis
composition、重建 web 产物并重启。动态插件路线一轮 `cordis_define` + `cordis_run`
即可生效，且可随时 `cordis_stop` / `cordis_undefine` 完全撤销。

代价：**DSH 进程重启后需要重新运行一次**（动态包只存在于当前进程）。

## 三个界面

| 位置 | 内容 |
| --- | --- |
| **Windows 通知（消息中心）** | 由 **Host 半边**发出，页面不在屏幕上也能到达。通知本身**静音**，声音仍由下面的铃声负责。署名显示为 DSH |
| `shell.overlay`（右下角固定浮层） | 通知卡栈：最新优先，12 秒自动消失，最多同时 4 张。**点卡片关掉这一张，点页面任何别处关掉全部** |
| `tool.view.cordis`（对话里的 `cordis_run` 卡片内） | 控制面板：试听、测试通知、通知开关、静音、兜底开关、音量、最近 12 条信号日志 |

通知卡内容全部**由编码计算**，不涉及任何模型调用：

```
┌──────────────────────────────┐
│ [DSH]  审批                × │
│ 工作区 · dsh-alert-chime      │
│ 会话 · 提示音插件开发           │
│ 身份 · 主会话 · 14:23:07       │
│ write — 需要写入工作区外文件     │
└──────────────────────────────┘
```

`shell.overlay` 这一层本身是 click-through 的，所以容器保持
`pointer-events:none`，由每张卡片自己 opt-in 回来，不会挡住下层应用。

## 三个信号从哪里来

Host 半边监听三个已确认存在的事件，Client 半边拿不到这些信息（Client 事件只有
`connection/reset`、`locale/change`、`slots/changed`、`theme/change`）：

| 事件 | 模式 | 含义 |
| --- | --- | --- |
| `approval/request` | waterfall | 权限审批正在等用户点确认 |
| `tools/pre-execute` | waterfall | 待执行的工具是 `ask_user_question`（提问） |
| `agent/status` | emit | 状态进入 `idle` = 本轮跑完，在等用户输入 |

两个 waterfall 监听器都只做记录，并**原样转发 `next()`**：不转发就会截走审批决定，
抛异常则会让审批 fail-closed（直接拒绝）。因此两个监听器也必须**完全同步**——这也是
下面身份解析坚持不用异步调用的原因。

## 身份怎么算出来（零 LLM）

| 字段 | 来源 |
| --- | --- |
| 软件 | 常量 `DSH` |
| 工作区 | `workspaceRegistry.list()`，用注册表自己的 `sessionIds` 账户精确匹配；退化路径是 `cwd` 与注册表 `path` 相等，再退化为 `cwd` 的 basename |
| 会话名 | `sessionTitle.get(session)` —— **日志折叠读取** |
| 主会话/子代理 | `header.origin === 'subagent'` 或 `header.delegationDepth > 0` |
| 子代理编号 | 同一 `parentSession` 下、按 `header.createdAt` 排序后的位次；深度同时给出，渲染成 `子代理 L1 #2` |

**刻意不用 `sessionTitle.refresh()`**：那是唯一可能通过 provider 生成标题的路径，
也就是唯一可能调用模型的地方。`get()` 只读已经折叠好的日志。

## 声音怎么发

只有 Client（浏览器）能播放音效，而动态插件的 RPC 方向是 **Client → Host 单向**，
Host 无法主动推消息给页面，所以 Client 每 500ms 轮询一次。

**关键问题**：浏览器会把后台标签页的定时器节流到大约每分钟一次 —— 也就是你切去干别的、
最需要提示音的时候，页面轮询恰好最不可靠。因此设计成"双保险"：

1. 页面正常时：Client 用 Web Audio 合成双音提示音（无音频资源，正弦波），响完立刻
   `chimed` 回报 Host；
2. Host 在信号产生后等 1.5 秒，若**没收到回执**，就判定页面没响（隐藏且被节流、
   已关闭、或音频被自动播放策略拦下），改由 Host 调 PowerShell 播放系统提示音。

这样无论页面开着、切走还是关掉，都会响，且**不会重复响**。

轮询拿到的信号如果已经过期（>5 秒），Client 只记进面板日志、不再补响一声，避免
后台节流恢复后突然"迟到地"响一下。

通知卡对每个"新鲜"信号都会弹出，**不只**在音频成功时：如果自动播放策略拦下了铃声，
视觉是页面唯一还能送达的东西。

## 系统提示音兜底用的命令

仅在需要兜底时执行，内容固定、短小，只播放 Windows 自带音频文件：

```powershell
$p = New-Object System.Media.SoundPlayer 'C:\Windows\Media\Windows Notify System Generic.wav'; $p.PlaySync()
```

`approval` / `question` / `idle` / `test` 分别对应
`Windows Notify System Generic.wav` / `ding.wav` / `chimes.wav` / `Windows Notify System Generic.wav`
（这几个文件已在本机确认存在）。可以在面板上按「兜底：关」关闭这条路径。

## 文件

| 文件 | 说明 |
| --- | --- |
| `src/host.js` | Host 半边源码。**文件内容就是 `code.host`** 的函数体原文 |
| `src/client.js` | Client 半边源码。**文件内容就是 `code.client`** 的函数体原文 |
| `scripts/check.mjs` | 按 DSH 真实求值方式做的语法校验，外加 `utf16leBase64` 与 Node `Buffer` 的对照测试 |
| `scripts/toast-e2e.mjs` | 系统通知链路的端到端验证：用同一个编码器生成与插件一致的 `-EncodedCommand` |

两边都是"返回 Cordis Plugin 的普通 JavaScript 函数体"：宿主分别用 `node:vm`
沙箱和浏览器闭包求值，因此没有 TypeScript、没有 `import`/`require`、没有 JSX，
也不能用环境里的 `setTimeout`/`process`/`fetch`（宿主沙箱会 trap，浏览器闭包会遮蔽）。

`node --check src/*.js` 用不了：这两个文件是**函数体**且含顶层 `return`，在脚本里是
语法错误。`scripts/check.mjs` 因此按运行器的方式包一层 async 函数再解析，并使用与
两个真实求值器一致的闭包符号面。

```
node scripts/check.mjs
```

## 验证系统通知链路

`scripts/toast-e2e.mjs` 用 `src/host.js` 里**同一个**编码器（按 region 标记抽取，而不是另写
一份可能各自腐坏）生成与插件**完全一致**的 `-EncodedCommand`。这一步很有必要，因为
**spawn 成功只说明 PowerShell 起来了，说明不了通知真的显示了** —— 编码坏掉同样是
"没报错、也没弹出来"。

```powershell
# 真的弹一条通知，内容与插件一致（含中文与特殊字符），应当没有声音
$b64 = (node scripts/toast-e2e.mjs).Trim()
powershell -NoProfile -NonInteractive -EncodedCommand $b64

# 只做往返校验、不弹通知：把 PowerShell 实际解析到的 XML 文本按 UTF-8 写回文件
$b64 = (node scripts/toast-e2e.mjs --dump).Trim()
powershell -NoProfile -NonInteractive -EncodedCommand $b64
Get-Content toast-roundtrip.txt
```

往返校验正是当初定位编码坑的手段：中文、`·`、单双引号、`&<>` 必须逐字还原。
加 `--show-script` 会先把将要执行的 PowerShell 脚本打到 stderr，便于排查。

## 运行方式

```
cordis_define { plugin: { kind: 'new', idPrefix: 'chime' }, code: { host: <src/host.js>, client: <src/client.js> } }
cordis_run    { pluginId, packageId, mode: 'run' }   # 已有 current 时改版本用 'update'
```

Client 半边需要浏览器侧授权（Run 卡片里点允许；点双勾可授权该插件的后续版本）。

## 已知边界

- 动态包只活在当前 DSH 进程里，重启失效；要长期生效需落成正式 preset 插件或安装
  社区插件。
- 子代理信号是否送达取决于事件的作用域过滤：只有作用域覆盖到的 agent 事件才会到达
  本插件。因此"子代理"这一支的渲染逻辑是按契约实现并做了降级，但实际能不能收到
  子代理事件需要在运行中观察。
- 静音状态与音量只存在内存中，刷新页面后回到默认值。
- 通知卡只在页面可见时才有意义；页面隐藏时由 Host 的系统提示音兜底，没有视觉通道。
