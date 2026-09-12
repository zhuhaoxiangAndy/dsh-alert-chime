# dsh-alert-chime

为 **DeepSeek Harness Web GUI** 加提示音：审批弹窗、提问（`ask_user_question`）、
以及"运行结束、等你输入"这三种时刻都会响。

实现方式是 **动态 Cordis 插件**（Host 半边 + Client 半边），不安装依赖、不改
composition、不重建 web 产物。

## 为什么是这个方案

DSH 里没有内建的提示音能力（本机部署的 config 里搜 `notification|beep|sound|audio|chime`
无任何匹配）。社区倒是有现成的（`Abel-86/task-chime`、`Machine-126/dsh-alert-sound`
等），但那条路要先做供应链安全扫描、装进部署的 `node_modules`、改 Cordis
composition、重建 web 产物并重启。动态插件路线一轮 `cordis_define` + `cordis_run`
即可生效，且可随时 `cordis_stop` / `cordis_undefine` 完全撤销。

代价：**DSH 进程重启后需要重新运行一次**（动态包只存在于当前进程）。

## 三个信号从哪里来

Host 半边监听三个已确认存在的事件，Client 半边拿不到这些信息（Client 事件只有
`connection/reset`、`locale/change`、`slots/changed`、`theme/change`）：

| 事件 | 模式 | 含义 |
| --- | --- | --- |
| `approval/request` | waterfall | 权限审批正在等用户点确认 |
| `tools/pre-execute` | waterfall | 待执行的工具是 `ask_user_question`（提问） |
| `agent/status` | emit | 状态进入 `idle` = 本轮跑完，在等用户输入 |

两个 waterfall 监听器都只做记录，并**原样转发 `next()`**：不转发就会截走审批决定，
抛异常则会让审批 fail-closed（直接拒绝）。

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

## 系统提示音兜底用的命令

仅在需要兜底时执行，内容固定、短小，只播放 Windows 自带音频文件：

```powershell
$p = New-Object System.Media.SoundPlayer 'C:\Windows\Media\Windows Notify System Generic.wav'; $p.PlaySync()
```

`approval` / `question` / `idle` / `test` 分别对应
`Windows Notify System Generic.wav` / `ding.wav` / `chimes.wav` / `Windows Notify System Generic.wav`
（这几个文件已在本机确认存在）。可以在面板上按「兜底：关」关闭这条路径。

## 面板

注册在 `tool.view.cordis`（该 Slot 只接受 `key: 'self'`），出现在最新一次
`cordis_run` 卡片里：试听、测试系统音、静音、开关兜底、音量、以及最近 12 条信号日志。

## 文件

| 文件 | 说明 |
| --- | --- |
| `src/host.js` | Host 半边源码。**文件内容就是 `code.host`** 的函数体原文 |
| `src/client.js` | Client 半边源码。**文件内容就是 `code.client`** 的函数体原文 |

两边都是"返回 Cordis Plugin 的普通 JavaScript 函数体"：宿主分别用 `node:vm`
沙箱和浏览器闭包求值，因此没有 TypeScript、没有 `import`/`require`、没有 JSX，
也不能用环境里的 `setTimeout`/`process`/`fetch`（宿主沙箱会 trap，浏览器闭包会遮蔽）。

## 运行方式

```
cordis_define { plugin: { kind: 'new', idPrefix: 'chime' }, code: { host: <src/host.js>, client: <src/client.js> } }
cordis_run    { pluginId, packageId, mode: 'run' }
```

Client 半边需要浏览器侧授权（Run 卡片里点允许）。

## 已知边界

- 动态包只活在当前 DSH 进程里，重启失效；要长期生效需落成正式 preset 插件或安装
  社区插件。
- `agent/status` 依赖事件的作用域过滤只送到本 agent；若发现子代理结束也会响，需要
  再加一层 agent 过滤。
- 静音状态与音量只存在内存中，刷新页面后回到默认值。
