# TODO

## 暂缓：持久化（用户 2026-08-14 决定先不处理）

当前形态是**动态 Cordis 插件**：只活在当前 DSH 进程里。DSH 重启后，提示音、Windows
系统通知、页面浮层会一起消失。

重启后重挂只要两条命令（源码都在本仓库，几秒钟的事）：

```
cordis_define { plugin: { kind: 'new', idPrefix: 'chime' }, code: { host: <src/host.js>, client: <src/client.js> } }
cordis_run    { pluginId, packageId, mode: 'run' }
```

三条评估过的路线，尚未执行：

| 方案 | 效果 | 代价 |
| --- | --- | --- |
| **A. 只落 Host 半边** | 重启后**系统通知 + 提示音**自动生效（两个主力功能） | 面板与页面浮层仍需手动 run；不碰 DSH 安装目录，升级安全 |
| B. Host + Client 全落 | 重启后三个功能全自动生效 | 要往 DSH 部署目录写客户端 bundle、跑 web 构建；**DSH 升级会被覆盖**，需要重做 |
| C. 保持动态插件 | 零副作用、完全可逆 | 每次重启后手动重挂 |

倾向 **A**。

## 待办

### 1. 让通知归属自己的身份，而不是 Windows PowerShell

现状：通知用的是**已注册的 Windows PowerShell 快捷方式 AUMID**，卡片靠
`<text placement="attribution">DSH</text>` 显示为 DSH，但在 Windows 的**通知设置里会归到
"Windows PowerShell" 名下**。

原因（已实测）：未注册的 AppUserModelID 会被 Windows **静默丢弃**（不报错、不显示），而在
DSH 沙箱里写 `HKCU\Software\Classes\AppUserModelId\...` **被拒绝**（实测
`UnauthorizedAccessException`）。

要做两步：

1. 在**自己的** PowerShell 里（不受沙箱限制）执行一次注册：

   ```powershell
   $k='HKCU:\Software\Classes\AppUserModelId\DSH.AlertChime'
   New-Item -Path $k -Force | Out-Null
   New-ItemProperty -Path $k -Name DisplayName -Value 'DSH' -PropertyType String -Force | Out-Null
   ```

2. 改 `src/host.js`：把写死的 `TOAST_AUMID` 换成"优先用 `DSH.AlertChime`，未注册则回退到
   PowerShell 的身份"。`src/client.js` 的面板可以顺带显示当前用的是哪个身份。

### 2. 子代理的信号是否真能到达（未实测）

`identityOf()` 已按契约实现了"主会话 / 子代理 L<深度> #<序号>"的判定与降级，但**尚未观察到
真实子代理信号**：事件是作用域过滤派发的，能否收到子代理的 `agent/status` 取决于本插件的
Fiber 落在哪个作用域。需要跑一次真的子代理任务来确认。

- 若收不到：决定是接受（只报主会话），还是改注册位置。
- 若能收到：确认序号（按 `createdAt` 排在同级兄弟中的位次）符合直觉。

### 3. 静音与弹窗的关系（未确认）

当前"静音"= **声音、Windows 通知、页面浮层全部关闭**。曾问过是否要拆开（例如静音只关声音、
保留弹窗），未得到答复，故保持现状。若要拆，需要新增一个独立开关。

### 4. 工作副本的位置

源码目前在会话临时目录 `~/.tmp-session/dsh-*/dsh-alert-chime`（DSH 的会话工作区），属于
临时区域。仓库已推到 GitHub，所以内容不会丢，但本地这份建议搬到一个稳定路径（例如
`~/dsh/projects/dsh-alert-chime`）。搬到工作区外需要一次写入授权。

### 5. 推送为什么需要绕行（备查）

`push-repo.ps1`（语法闸 + 提交 + 推送 + 重试）刻意放在仓库**之外**，因为它编码的是本机环境
的特殊绕行，不属于这个项目本身。三处坑，都实测过：

1. git 的 **schannel** TLS 后端报 `SEC_E_NO_CREDENTIALS`，改用 `http.sslBackend=openssl`；
2. `!` 式凭据助手要经 msys `sh.exe`，在沙箱里因**无法创建命名管道**（Win32 error 5）而失败，
   改用 `gh auth token` + `http.extraheader`，**不改动全局 git 配置、令牌不落盘**；
3. 到 `github.com:443` 的连通性**会漂移**（同一批目标在两次测量中出现相反结果），
   用本地 Clash 代理（HTTP 端口）可稳定打通，脚本支持 `-Proxy`。

另外 DSH 自身的模型请求要走代理，需要**带环境变量重启 DSH**（环境变量无法注入到已在运行的
进程）：

```powershell
$env:NODE_USE_ENV_PROXY = '1'
$env:HTTP_PROXY  = 'http://127.0.0.1:<clash-port>'
$env:HTTPS_PROXY = 'http://127.0.0.1:<clash-port>'
$env:NO_PROXY    = 'localhost,127.0.0.1'
```

Node v24.12.0 实测支持该变量（`fetch` 走代理后三个目标全部 200）。
**`NODE_EXTRA_CA_CERTS` 不需要设** —— 走代理时 TLS 验证直接通过，说明代理是隧道模式、没有
MITM，不存在需要额外信任的自签 CA。建议把 Clash 端口固定下来，否则端口一变变量就失效。
