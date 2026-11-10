# 局域网与公网访问 / LAN and Internet Access

[简体中文](#简体中文) | [English](#english)

## 简体中文

Codex WebUI 支持局域网和公网两种访问方式，但两条链路使用不同的入口身份验证：

| 方式 | 适用场景 | 入口验证 | 是否在 URL 中携带 WebUI token |
| --- | --- | --- | --- |
| 局域网 | 手机与电脑位于同一可信局域网 | WebUI token / 二维码 | 是 |
| 公网 | 手机从互联网访问家中或办公室电脑 | Cloudflare Tunnel + Cloudflare Access 邮箱白名单 | 否 |

无论使用哪种方式，浏览器进入 WebUI 后仍只能操作映射 token 所允许的项目目录。raw `codex app-server` 永远不会直接暴露到局域网或公网。

## 局域网：token 二维码

安装并激活 [Windows Desktop 桥接器](DESKTOP_BRIDGE.md) 后，让手机和电脑连接同一个局域网，然后运行：

```powershell
codex-webui qr default
```

推荐为每台设备创建独立且限制目录的 token：

```powershell
codex-webui add phone --label "My phone" --cwd "E:\MyProject"
codex-webui qr phone
```

手机扫描终端二维码即可打开。二维码和完整访问链接中含有 bearer token，任何得到它的人都可能在授权目录内读取会话、启动任务和操作文件，因此不得截图公开或提交到仓库。设备丢失或链接泄露时立即运行：

```powershell
codex-webui rotate phone
# 或
codex-webui disable phone
```

## 公网：Cloudflare Tunnel + Access 邮箱白名单

公网模式不开放路由器端口，也不把 WebUI token 放在公网 URL 中。Cloudflare Tunnel 建立出站连接；Cloudflare Access 在请求到达 WebUI 前要求用户登录，并且 WebUI 服务端还会验证 Access 签名、issuer、audience、有效期和邮箱白名单。

完整链路：

```text
公网浏览器
  -> HTTPS / WSS
Cloudflare Access（登录 + 允许邮箱策略）
  -> Cloudflare Tunnel
本机 Codex WebUI
  -> 目录受限 token scope
Desktop bridge / 唯一 app-server
```

### 1. 在 Cloudflare 中准备 Tunnel 和 Access

1. 创建一个 remotely-managed Cloudflare Tunnel，记录 Tunnel UUID。
2. 为公网域名添加 Published application route，把它指向运行 WebUI 的电脑，例如 `http://192.168.1.20:9526`。
3. 在 Cloudflare Zero Trust 中为同一域名创建 Access self-hosted application。
4. 建立 Allow 策略，只允许你的指定邮箱登录。不要创建 Bypass 或 Everyone 策略。

这里的本地 `http://` 只存在于 Tunnel 到本机源站之间；公网浏览器使用 `https://` 和 `wss://`。

### 2. 安装独立 Tunnel connector

如果电脑上已有其他用途的默认 `Cloudflared` 服务，使用项目自带的独立服务安装器，避免覆盖它。先以管理员身份做只读预检：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-cloudflared-ai.ps1 `
  -ExpectedTunnelId "<TUNNEL-UUID>" `
  -ValidateOnly
```

确认后正式安装：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-cloudflared-ai.ps1 `
  -ExpectedTunnelId "<TUNNEL-UUID>"
```

脚本通过隐藏输入读取 Tunnel token，验证它属于指定 Tunnel，并保存到仅 SYSTEM 和 Administrators 可读的 `%ProgramData%\cloudflared-ai\token`。它只管理 `CloudflaredAI` 服务，不修改已有的默认 `Cloudflared` 服务。

### 3. 把允许邮箱写入 WebUI

Cloudflare Access 登录重定向和 Allow 策略已经生效后运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/configure-cloudflare-access.ps1 `
  -PublicUrl "https://codex.example.com" `
  -AllowedEmail "owner@example.com" `
  -TokenScopeId "phone"
```

- `-AllowedEmail` 是 WebUI 服务端允许的唯一登录邮箱，并会转换为小写进行精确匹配。
- `-TokenScopeId` 可选，建议指定一个目录受限 token；公网用户会继承该 token 的目录权限。
- 未指定 `-TokenScopeId` 时使用第一个启用的 token scope，因此公开部署前应明确检查其目录范围。
- 配置只保存 Access team domain、application audience、允许邮箱和可选 scope ID，不保存登录 cookie、JWT 或 Tunnel token。

配置后完全退出并重新打开 Codex Desktop，让其托管的 WebUI 重新加载配置。

### 4. 验证

1. 使用允许邮箱访问公网 URL，应先出现 Cloudflare Access 登录，登录后进入 WebUI。
2. 使用其他邮箱访问，应被 Cloudflare 策略或 WebUI 服务端拒绝。
3. 公网 URL 不应出现 `?token=...`。
4. 局域网二维码访问仍继续使用原来的 WebUI token。

> [!WARNING]
> 这是一个可操作本机 Codex 和授权项目文件的远程控制界面。不要匿名暴露，不要只依赖“很难猜的域名”，也不要把 Tunnel token、WebUI token 或 Access assertion 写入仓库、Issue 或日志。

## English

Codex WebUI supports two access paths:

| Path | Entry authentication | Token in the public URL |
| --- | --- | --- |
| Trusted LAN | Per-device WebUI token and QR code | Yes |
| Internet | Cloudflare Tunnel plus a Cloudflare Access email allowlist | No |

For LAN access, put the phone and computer on the same trusted network and run `codex-webui qr default`. Prefer a separate directory-scoped token for each device.

For internet access, create a remotely managed Cloudflare Tunnel, route a public hostname to the local WebUI origin, and protect the same hostname with a Cloudflare Access self-hosted application. Its Allow policy must contain only the intended email address; do not use Bypass or Everyone.

Install the dedicated connector from an Administrator PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-cloudflared-ai.ps1 `
  -ExpectedTunnelId "<TUNNEL-UUID>"
```

After the Access redirect is active, bind the signed identity to the allowed email and preferably a directory-scoped WebUI token:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/configure-cloudflare-access.ps1 `
  -PublicUrl "https://codex.example.com" `
  -AllowedEmail "owner@example.com" `
  -TokenScopeId "phone"
```

Restart the Desktop-managed WebUI. The server validates the Cloudflare signature, issuer, audience, lifetime, and exact lower-cased email. An unlisted email is rejected even if it can reach the origin. The public URL contains no WebUI token; LAN QR access continues to require one.
