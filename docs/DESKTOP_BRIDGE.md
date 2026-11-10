# Windows Desktop 桥接器使用手册

[简体中文](#简体中文) | [English](#english)

## 简体中文

### 桥接器是做什么的

桥接器让 Codex Desktop 和 Codex WebUI 共享同一个 `codex app-server`。Desktop 继续负责账号登录和会话，WebUI 通过带随机密钥的本机命名管道复用同一条实时消息流，因此手机与桌面端看到的是同一会话状态。

这条链路只支持原生 Windows：

```text
Codex Desktop
  -> codex-webui-bridge.exe
  -> desktop-broker.js
  -> 唯一的 codex app-server
  -> 本机认证命名管道
  -> Codex WebUI
```

桥接器不会修改 Codex Desktop 的 AppX 安装文件，不会读取或改写会话数据库，也不会把 raw app-server 暴露到局域网。浏览器请求仍经过 WebUI token、目录范围和方法白名单校验。

### 包含哪些文件

- `desktop-bridge/launcher.cs`：原生 Windows 启动器源码。
- `server/desktop-broker.js`：在 Desktop 与唯一 app-server 之间转发 JSON-RPC，并向 WebUI 扇出通知。
- `server/desktop-bridge-client.js`：WebUI 的本机命名管道客户端。
- `scripts/install-desktop-bridge.ps1`：构建、安装、激活和停用脚本。

安装后的启动器位于：

```text
%LOCALAPPDATA%\CodexWebUI\desktop-bridge\runtime\windows-v3\codex-webui-bridge.exe
```

### 前置条件

- Windows 10/11 和已登录的 Codex Desktop。
- Node.js 22.13 或更新版本。
- PowerShell 7 或更新版本；命令必须使用 `pwsh`，不要使用 Windows PowerShell 5.1。
- 仓库依赖已经通过 `npm install` 安装。

### 推荐安装流程

在仓库根目录运行：

```powershell
npm install
npm run setup
npm test

# 只构建和安装，不修改 Desktop 启动方式，也不重启 Desktop
pwsh -NoProfile -File scripts/install-desktop-bridge.ps1

# 确认当前任务可以安全结束后再激活
pwsh -NoProfile -File scripts/install-desktop-bridge.ps1 -Activate
```

`-Activate` 会把当前用户的 `CODEX_CLI_PATH` 指向桥接启动器，并保存原值以便停用时恢复。它不会强制结束正在运行的 Desktop；必须完全退出并重新打开 Codex Desktop，新的启动方式才会生效。

Desktop 重新打开后，桥接器会自动启动 WebUI。正常使用时不要再执行 `npm start`，否则可能得到一个不受 Desktop 生命周期管理的重复实例。

生成手机二维码：

```powershell
codex-webui qr default
```

访问地址和二维码等同于远程控制凭证，不要公开分享。

### 如何确认已经生效

1. 完全退出并重新打开 Codex Desktop。
2. 打开 WebUI，页面右上角应显示“Desktop 已接管”或对应的已连接状态。
3. 在手机发送一条消息，Desktop 与手机应显示同一会话和实时回复。
4. 如需检查默认端口是否只有一个监听者：

```powershell
Get-NetTCPConnection -LocalPort 9526 -State Listen
```

运行日志位于：

```text
%LOCALAPPDATA%\CodexWebUI\codex-webui.log
%LOCALAPPDATA%\CodexWebUI\codex-webui.err.log
```

### 生命周期和防重复规则

| 情况 | 行为 |
| --- | --- |
| Desktop 启动，配置端口空闲 | 桥接器自动启动一份 WebUI |
| 端口已有手工或外部实例 | 保留现有实例，不重复启动 |
| Desktop 正常退出 | 只关闭本次由桥接器启动的 WebUI |
| Desktop 异常退出 | Windows Job 尽量清理桥接器拥有的子进程 |
| 已存在的外部 WebUI | 不会因 Desktop 退出而被误关 |

如果要把手工启动的实例切换为 Desktop 生命周期托管，停止该手工实例一次，然后重新打开 Desktop。

### 常用配置

这些都是当前用户或启动 Desktop 时可见的环境变量。修改后需要重新打开 Desktop：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_WEBUI_PORT` | `9526` | WebUI 监听端口 |
| `CODEX_WEBUI_HOST_ADDRESS` | `0.0.0.0` | WebUI 监听地址；多网卡时可指定局域网 IP |
| `CODEX_WEBUI_DATA_DIR` | `%LOCALAPPDATA%\CodexWebUI` | token、上传、日志、随机密钥和桥接运行文件目录 |
| `CODEX_WEBUI_DESKTOP_LIFECYCLE` | `1` | 设为 `0`、`false`、`no` 或 `off` 时禁止 Desktop 自动拉起 WebUI |

示例：把端口改为 `9630`：

```powershell
[Environment]::SetEnvironmentVariable("CODEX_WEBUI_PORT", "9630", "User")
```

随后完全退出并重新打开 Desktop，并用对应地址生成二维码：

```powershell
codex-webui qr default --host http://192.168.1.20:9630
```

### 更新、移动和重新安装

更新代码后可以重新运行安装脚本。安装器会先在临时目录完整构建，再切换到 `windows-v3` 运行目录。

```powershell
pwsh -NoProfile -File scripts/install-desktop-bridge.ps1
```

如果当前启动器正在被 Desktop 使用，而且新构建内容不同，安装器会拒绝覆盖。先完全退出 Desktop，再重新运行安装脚本。如果仓库目录或 Windows Node.js 路径发生变化，也必须重新安装；配置文件保存的是绝对路径。

### 停用并恢复默认 Desktop 启动方式

```powershell
pwsh -NoProfile -File scripts/install-desktop-bridge.ps1 -Disable
```

脚本会恢复激活前保存的用户级 `CODEX_CLI_PATH`。随后完全退出并重新打开 Desktop。停用不会删除 token、上传、日志或模型等运行数据。

### 故障排查

- **提示需要 PowerShell 7：** 安装 PowerShell 7，并使用 `pwsh` 执行脚本。
- **找不到 Node.js 或版本过低：** 安装 Windows Node.js 22.13+，或传入 `-WindowsNodePath "C:\path\to\node.exe"`。
- **提示启动器正在使用：** 完全退出 Codex Desktop，确认后台进程结束后重新安装。
- **页面显示 Desktop 未连接：** 确认执行过 `-Activate`，再完全退出并重开 Desktop；检查 `codex-webui.err.log`。
- **端口已占用：** 桥接器会保留已有监听者。确认它是否是期望的 WebUI；若要改端口，设置 `CODEX_WEBUI_PORT` 后重开 Desktop。
- **移动仓库后失效：** 重新运行安装脚本，更新启动器配置中的绝对路径。
- **只想临时手工运行：** 先设置 `CODEX_WEBUI_DESKTOP_LIFECYCLE=0` 并重开 Desktop，再显式使用 `npm start` 或 `scripts/start-codex-webui.ps1 -Foreground`。

## English

The native Windows Desktop bridge makes Codex Desktop and Codex WebUI share one authoritative `codex app-server`. Desktop keeps ownership of sign-in and conversations, while WebUI connects through an authenticated local named pipe. It does not modify the Desktop AppX package, edit conversation storage, or expose the raw app-server to the LAN.

### Install and activate

Requirements: Windows, a signed-in Codex Desktop, Node.js 22.13+, and PowerShell 7+.

```powershell
npm install
npm run setup
npm test

# Build and install without changing Desktop or restarting it
pwsh -NoProfile -File scripts/install-desktop-bridge.ps1

# Activate only when it is safe to fully restart Desktop
pwsh -NoProfile -File scripts/install-desktop-bridge.ps1 -Activate
```

Fully quit and reopen Codex Desktop. The bridge then starts one WebUI automatically when the configured port is free. Do not also run `npm start`. Generate the phone QR code with:

```powershell
codex-webui qr default
```

The WebUI should show the Desktop-connected status. Logs are stored in `%LOCALAPPDATA%\CodexWebUI\codex-webui.log` and `codex-webui.err.log`.

If another service already listens on the configured port, the bridge preserves it and does not start a duplicate. When Desktop exits, it stops only the WebUI child it started itself.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_WEBUI_PORT` | `9526` | WebUI port |
| `CODEX_WEBUI_HOST_ADDRESS` | `0.0.0.0` | Listen address |
| `CODEX_WEBUI_DATA_DIR` | `%LOCALAPPDATA%\CodexWebUI` | Runtime data, logs, tokens, and bridge files |
| `CODEX_WEBUI_DESKTOP_LIFECYCLE` | `1` | Set to `0`, `false`, `no`, or `off` to disable automatic WebUI startup |

After moving the repository, changing the Windows Node.js path, or updating bridge code, fully quit Desktop and rerun the installer. To restore the previous Desktop launch configuration:

```powershell
pwsh -NoProfile -File scripts/install-desktop-bridge.ps1 -Disable
```

Fully quit and reopen Desktop after activation, deactivation, or environment changes.
