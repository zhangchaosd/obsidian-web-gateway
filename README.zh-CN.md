# Obsidian Web Gateway

[English](README.md) | **简体中文**

![Obsidian Web Gateway 界面预览](docs/assets/obsidian-web-gateway-preview.png)

*界面中的 Vault 内容均为虚构演示数据。*

Obsidian Web Gateway（OWG）是一个运行在本机的轻量守护程序，为已有的 Obsidian Vault 提供安全的浏览器访问界面。Vault 始终是普通的 Markdown 文件目录，也是唯一真实数据源。

OWG 不是 Obsidian 替代品、同步服务、托管 SaaS、插件运行环境或多人协作编辑器。它不会上传笔记，也不收集遥测数据。

> 第一次启用写入功能前，请先备份 Vault。原子写入和版本冲突检查可以降低风险，但不能代替备份。

## 下载

每个 [GitHub Release](https://github.com/zhangchaosd/obsidian-web-gateway/releases) 都提供已嵌入 Web UI 的单可执行文件，运行时不需要 Node.js。

| 平台 | x64 | ARM64 |
| --- | --- | --- |
| Linux | `linux-x86_64` | `linux-aarch64` |
| macOS | `macos-x86_64` | `macos-aarch64` |
| Windows | `windows-x86_64` | `windows-aarch64` |

请使用同一 Release 中的 `SHA256SUMS.txt` 校验下载文件。

## 快速开始

下载并解压对应平台的产物，然后运行：

```bash
OBSIDIAN_WEB_USERNAME='me' OBSIDIAN_WEB_PASSWORD='请设置一个足够长的密码' ./obsidian-web \
  --vault /path/to/MyVault \
  --listen 127.0.0.1:8765
```

Windows PowerShell：

```powershell
$env:OBSIDIAN_WEB_PASSWORD = "请设置一个足够长的密码"
.\obsidian-web.exe --vault "C:\path\to\MyVault"
```

浏览器访问 <http://127.0.0.1:8765>。

认证默认启用。通过 `OBSIDIAN_WEB_PASSWORD` 设置密码，或传递 `--password`；同时设置 `OBSIDIAN_WEB_USERNAME` 或 `--username` 后，登录页还会要求输入用户名（未设置时与旧版本一样只需密码）。也可以用 Passkey 代替或配合密码登录，见 [Passkey 登录](#passkey-登录与-bookmarkd-共用)。`--no-auth` 仅适合可信的 localhost 环境；此模式下 OWG 只接受 `localhost`、`*.localhost` 或 IP 地址形式的 `Host` 头，以防御 DNS 重绑定攻击。OWG 不会自动把密码写入配置文件。

## CLI

```text
obsidian-web --vault <PATH>
  --listen <IP:PORT>       默认：127.0.0.1:8765
  --config <PATH>          TOML 配置文件
  --log-level <LEVEL>      默认：info
  --read-only              服务端强制只读
  --show-hidden-files      显示非保留隐藏文件
  --username <NAME>        密码登录时要求的用户名
  --password <PASSWORD>    建议优先使用环境变量
  --passkey-db <PATH>      从 bookmarkd 复制的 Passkey 数据库
  --public-url <URL>       浏览器实际访问的完整 origin；启用 Passkey 时必填
  --data-dir <PATH>        更新设置等状态目录（默认：系统数据目录）
  --no-auth                关闭登录
  --secure-cookie          在 HTTPS 反向代理后设置 Secure Cookie
  --trusted-proxy <CIDR>   仅信任此代理提供的 X-Forwarded-For；可重复指定

obsidian-web update check | install --yes | rollback --yes
```

服务默认只监听本机回环地址。必须显式指定 `0.0.0.0` 才会允许局域网访问。

## 配置

配置优先级：CLI > `OBSIDIAN_WEB_*` 环境变量 > TOML 配置 > 默认值。

```toml
[vault]
path = "/Users/user/Documents/MyVault"

[server]
listen = "127.0.0.1:8765"
trusted_proxies = ["127.0.0.1/32", "::1/128"]
public_url = "https://obsidian.example.com"
# data_dir = "/var/lib/obsidian-web"

[auth]
enabled = true
secure_cookie = false
username = "me"
passkey_db = "/srv/obsidian-web/auth.db"

[features]
read_only = false
show_hidden_files = false

[logging]
level = "info"
```

支持的环境变量包括 `OBSIDIAN_WEB_VAULT`、`OBSIDIAN_WEB_LISTEN`、`OBSIDIAN_WEB_USERNAME`、`OBSIDIAN_WEB_PASSWORD`、`OBSIDIAN_WEB_PASSKEY_DB`、`OBSIDIAN_WEB_PUBLIC_URL`、`OBSIDIAN_WEB_DATA_DIR`、`OBSIDIAN_WEB_AUTH_ENABLED`、`OBSIDIAN_WEB_READ_ONLY`、`OBSIDIAN_WEB_LOG_LEVEL` 和 `OBSIDIAN_WEB_TRUSTED_PROXIES`（以逗号分隔的 IP 或 CIDR）。密码不会从 TOML 文件读取。

## 主要功能

- 显式多标签工作区：左侧导航复用当前标签，只有点击 `+` 才创建新标签
- 文件、搜索结果、Wiki Link 和 Backlinks 遵循“一个文件一个标签”，避免重复编辑器和过期副本
- CodeMirror Markdown 编辑、精致阅读模式、自动保存、行号、字数统计、Outline 和 Backlinks
- 全文搜索、Wiki Link 解析、图片嵌入、任务列表、表格与安全净化的 Markdown 预览
- 创建、重命名、移动和恢复性删除文件与目录，支持拖放文件进出目录
- WebSocket 外部修改通知、SHA-256 revision 冲突检测、并排比较和显式强制覆盖
- 桌面与移动端响应式界面、明暗配色、键盘快捷键和无障碍应用内对话框
- Argon2 登录、CSRF 防护、可信 Caddy/反向代理后的真实客户端限速，以及服务端强制只读模式
- 前端嵌入单一可执行文件，运行时不依赖 Node.js

## 分栏预览与代码复制

桌面端点击 **Split**，左侧编辑 Markdown，右侧预览未保存的草稿。停止输入约 200ms 后更新预览；超过 100,000 字符的笔记使用 500ms 延迟。预览更新不会写入磁盘，保存仍由 Save 或 Autosave 控制。

拖动中间分隔条调整比例，双击恢复等宽；分隔条也支持方向键以及 Home/End。进入分栏时自动收起右侧大纲，手机继续使用 Edit/Preview 切换。左右滚动独立，预览更新保留滚动位置。在 Edit、Preview 和 Split 之间切换时，会按 Markdown 源码行映射恢复对应内容的位置。

鼠标移入预览中的代码块，或用键盘聚焦复制按钮，即可复制该代码块的完整代码。触摸设备直接显示复制按钮。

![分栏实时预览](docs/assets/obsidian-web-gateway-split-preview.png)

## Demo Vault

仓库内置 [`demo-vault`](demo-vault)，包含虚构项目、用户研究、日报、Wiki Link、任务列表、表格和本地 SVG 附件，可用于界面评估和自动截图。仅在本机可信环境中可以免登录启动：

```bash
cargo run -- --vault ./demo-vault --listen 127.0.0.1:8765 --no-auth
```

当服务可通过反向代理或任何不可信网络访问时，请勿使用 `--no-auth`。

## 安全

所有文件操作都经过统一 Vault 沙箱。它会拒绝绝对路径、编码后的目录穿越、Windows 特殊路径、保留目录（`.git`、`.obsidian`、`.trash`）、非法 UTF-8 文件名和 symlink 越界。Markdown 必须是 UTF-8，默认编辑上限为 10 MiB。SVG 响应使用严格的 sandbox CSP。

密码通过 Argon2 校验；会话使用随机令牌、HttpOnly `SameSite=Strict` Cookie、登录限速和写操作 CSRF Token。默认情况下，关闭浏览器即退出登录，服务端 12 小时后失效；在登录页勾选 **Keep me signed in for 30 days** 则改为固定 30 天的会话（使用期间不会自动延长）。会话保存在 `--data-dir` 下的 `sessions.json`（权限 600，只保存令牌哈希），因此重启和更新不会让用户掉线。修改用户名、密码或 Passkey 的 RP ID 会让所有人退出登录；Passkey 被吊销后，用它登录的会话随之失效；重启前删除 `sessions.json` 可让所有浏览器退出登录。预览 HTML 经过净化，服务端同时设置 CSP、`nosniff`、frame 和 referrer 安全策略。默认不启用 CORS。

通过 HTTPS 反向代理访问时请启用 `--secure-cookie`；设置 `https://` 开头的 `--public-url` 时会自动启用。不要将未加密的 HTTP 监听端口直接暴露到不可信网络。

## 反向代理

OWG 不负责申请和管理 TLS 证书。可以使用 Caddy：

```caddyfile
notes.example.com {
  reverse_proxy 127.0.0.1:8765
}
```

启动 OWG 时显式信任本机 Caddy：

```bash
OBSIDIAN_WEB_PASSWORD='请设置一个足够长的密码' ./obsidian-web \
  --vault /path/to/MyVault \
  --listen 127.0.0.1:8765 \
  --secure-cookie \
  --trusted-proxy 127.0.0.1/32
```

Caddy 会为上游请求设置 `X-Forwarded-For`。只有 TCP 对端命中已配置的可信代理时，OWG 才会使用该头进行按客户端 IP 的登录限速，并从右向左严格解析多级代理链；其他来源携带的转发头会被忽略。切勿把 `0.0.0.0/0` 或 `::/0` 配置为可信代理，否则能直连 OWG 的客户端可以伪造限速身份。

OWG 应继续只监听 `127.0.0.1`。如果 Caddy 通过 IPv6 回环连接，再增加 `--trusted-proxy ::1/128`。如果代理位于另一台主机，只信任它的精确私网地址或尽可能窄的网段，并使用 WireGuard、Tailscale 等私有隧道。

## Passkey 登录（与 bookmarkd 共用）

OWG 使用与 [bookmarkd](https://github.com/zhangchaosd/bookmarkd) 相同的验证库和数据库格式，因此在 bookmarkd 注册的 Passkey 可以直接登录 OWG。Passkey 绑定的是域名（RP ID）而不是单个站点：两个服务都必须部署在该 RP ID 或其子域名下，例如 RP ID 为 `zhangchao.dev`，bookmarkd 使用 `https://fav.zhangchao.dev`，OWG 使用 `https://obsidian.zhangchao.dev`。

1. 获取一份一致的 bookmarkd 认证数据库。不要在 bookmarkd 运行时直接复制数据库文件，请使用它的备份命令（同时会清除会话）：

   ```bash
   bookmarkd --config ~/bookmarkd/config.toml backup --include-auth --output /tmp/bookmarkd-auth
   install -m 600 /tmp/bookmarkd-auth/auth.db /srv/obsidian-web/auth.db
   ```

   只需要 `auth.db`，其中已包含 RP ID 和用户句柄（与 `user-id.txt` 中的值相同）。
2. 使用浏览器实际访问的完整 origin 启动 OWG：

   ```bash
   OBSIDIAN_WEB_USERNAME='me' OBSIDIAN_WEB_PASSWORD='请设置一个足够长的密码' ./obsidian-web \
     --vault /path/to/MyVault --listen 127.0.0.1:8765 --trusted-proxy 127.0.0.1/32 \
     --public-url https://obsidian.zhangchao.dev \
     --passkey-db /srv/obsidian-web/auth.db
   ```

   如果数据库无法读取，或 origin 不在其 RP ID 之下，启动会失败并给出明确提示。配置 Passkey 后，密码是可选的。
3. 登录页会显示 **Sign in with a passkey** 按钮。

Passkey 的注册、重命名和吊销都在 bookmarkd 中完成。复制得到的是快照：新增或吊销 Passkey 后需要重新复制。如果两个服务在同一台主机上以同一用户运行，也可以让 `--passkey-db` 直接指向 bookmarkd 正在使用的 `auth.db`（WAL 模式的 SQLite，本身支持多进程共享），这样吊销会立即生效。OWG 使用自己的浏览器会话（`app_id` 为 `obsidian-web`），不会接受 bookmarkd 的会话。不要把数据库放在 NFS/SMB 上。

## 更新

点击 Vault 名称旁的齿轮打开 **About and updates**，可以查看当前版本、检查 GitHub Releases、阅读更新说明并安装。安装时会下载当前平台的压缩包，用 `SHA256SUMS.txt` 校验，确认新程序能运行且版本号正确，然后替换可执行文件（旧版本保留为 `obsidian-web.old`），并以相同参数和 PID 原地重启，systemd 等服务管理器可继续追踪。已登录的浏览器会保持登录状态。请先保存草稿；有未保存草稿时安装按钮不可用。

可选的每日或每周检查只会提示新版本，安装始终需要确认。更新设置保存在 `--data-dir` 下的 `update.json`（默认：Linux 为 `~/.local/share/obsidian-web`，macOS 为 `~/Library/Application Support/obsidian-web`）。运行服务的用户需要对可执行文件所在目录有写权限。

命令行用法：

```bash
./obsidian-web update check
./obsidian-web update install --yes   # 然后重启服务
./obsidian-web update rollback --yes  # 换回 obsidian-web.old
```

Windows 可以检查更新并打开下载链接，但无法替换正在运行的程序，需要手动安装。

## 从源码开发

要求 Rust 1.88+、Node.js 22+ 和 npm。

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

cd web
npm ci
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

`scripts/build.sh` 会先构建前端，再构建 release 二进制。Windows 可使用 `scripts/build.ps1`。

## 自动构建与发版

每次 push 和 pull request 都会运行 Rust、TypeScript、前端和浏览器测试，并为以下目标生成 Artifact：

- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`
- `x86_64-apple-darwin`
- `aarch64-apple-darwin`
- `x86_64-pc-windows-msvc`
- `aarch64-pc-windows-msvc`

推送 `v*` 标签会自动创建 GitHub Release，附带六个平台压缩包和 SHA-256 校验文件。

## 数据安全与备份

写入时先在目标目录创建完整临时文件，flush 和 sync 后再原子替换原文件。保存请求携带 SHA-256 base revision，过期保存会收到 HTTP 409。删除操作只会把文件移动到 `Vault/.trash`，API 不提供永久删除。

推荐使用 Git、Time Machine、Windows File History、NAS Snapshot 或 ZFS/Btrfs Snapshot 建立独立备份。

## 已知限制

- 只有单一登录身份，没有账户或恢复系统。Passkey 在 bookmarkd 中管理。
- 内存索引会在文件变化后重建，当前不持久化。
- 重命名笔记不会自动修改其他笔记中的 Wiki Link。
- Wiki Link 存在歧义时会返回候选项，不会随机选择。
- 只支持 UTF-8 Markdown，默认编辑上限为 10 MiB，暂不支持附件上传。
- Obsidian 插件、Canvas、Dataview、Excalidraw、CRDT、Mermaid、PWA 和 Graph View 不属于当前 MVP。

## 隐私

项目没有遥测、分析或云服务。唯一的外部请求是向 GitHub 检查和下载更新，只在你手动检查、安装或开启定时检查时发生。笔记正文不会被记录到日志，也不会存储到 Vault 之外。

## 许可证

本项目采用宽松的 [MIT License](LICENSE)。
