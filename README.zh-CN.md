# Obsidian Web Gateway

[English](README.md) | **简体中文**

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
OBSIDIAN_WEB_PASSWORD='请设置一个足够长的密码' ./obsidian-web \
  --vault /path/to/MyVault \
  --listen 127.0.0.1:8765
```

Windows PowerShell：

```powershell
$env:OBSIDIAN_WEB_PASSWORD = "请设置一个足够长的密码"
.\obsidian-web.exe --vault "C:\path\to\MyVault"
```

浏览器访问 <http://127.0.0.1:8765>。

认证默认启用。通过 `OBSIDIAN_WEB_PASSWORD` 设置密码，或传递 `--password`。`--no-auth` 仅适合可信的 localhost 环境。OWG 不会自动把密码写入配置文件。

## CLI

```text
obsidian-web --vault <PATH>
  --listen <IP:PORT>       默认：127.0.0.1:8765
  --config <PATH>          TOML 配置文件
  --log-level <LEVEL>      默认：info
  --read-only              服务端强制只读
  --show-hidden-files      显示非保留隐藏文件
  --password <PASSWORD>    建议优先使用环境变量
  --no-auth                关闭登录
  --secure-cookie          在 HTTPS 反向代理后设置 Secure Cookie
```

服务默认只监听本机回环地址。必须显式指定 `0.0.0.0` 才会允许局域网访问。

## 配置

配置优先级：CLI > `OBSIDIAN_WEB_*` 环境变量 > TOML 配置 > 默认值。

```toml
[vault]
path = "/Users/user/Documents/MyVault"

[server]
listen = "127.0.0.1:8765"

[auth]
enabled = true
secure_cookie = false

[features]
read_only = false
show_hidden_files = false

[logging]
level = "info"
```

支持的环境变量包括 `OBSIDIAN_WEB_VAULT`、`OBSIDIAN_WEB_LISTEN`、`OBSIDIAN_WEB_PASSWORD`、`OBSIDIAN_WEB_AUTH_ENABLED`、`OBSIDIAN_WEB_READ_ONLY` 和 `OBSIDIAN_WEB_LOG_LEVEL`。

## 主要功能

- 浏览、搜索和预览现有 Obsidian Vault
- 使用 CodeMirror 编辑 Markdown
- 创建文件与目录、重命名、移动和恢复性删除
- Wiki Link、图片嵌入、Backlinks 和 Outline
- 文件系统监听与 WebSocket 外部修改通知
- SHA-256 revision 冲突检测和显式强制覆盖
- 桌面与移动浏览器响应式界面
- 服务端强制只读模式
- 单可执行文件发布

## 安全

所有文件操作都经过统一 Vault 沙箱。它会拒绝绝对路径、编码后的目录穿越、Windows 特殊路径、保留目录（`.git`、`.obsidian`、`.trash`）、非法 UTF-8 文件名和 symlink 越界。Markdown 必须是 UTF-8，默认编辑上限为 10 MiB。SVG 响应使用严格的 sandbox CSP。

密码通过 Argon2 校验；会话使用随机令牌、HttpOnly `SameSite=Strict` Cookie、登录限速和写操作 CSRF Token。预览 HTML 经过净化，服务端同时设置 CSP、`nosniff`、frame 和 referrer 安全策略。默认不启用 CORS。

通过 HTTPS 反向代理访问时请启用 `--secure-cookie`。不要将未加密的 HTTP 监听端口直接暴露到不可信网络。

## 反向代理

OWG 不负责申请和管理 TLS 证书。可以使用 Caddy：

```caddyfile
notes.example.com {
  reverse_proxy 127.0.0.1:8765
}
```

OWG 应继续监听 `127.0.0.1` 并启用 `--secure-cookie`。如果代理位于另一台主机，请使用 WireGuard、Tailscale 等私有隧道。

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

- 认证和会话保存在当前进程内，没有账户恢复系统。
- 内存索引会在文件变化后重建，当前不持久化。
- 重命名笔记不会自动修改其他笔记中的 Wiki Link。
- Wiki Link 存在歧义时会返回候选项，不会随机选择。
- 只支持 UTF-8 Markdown，默认编辑上限为 10 MiB，暂不支持附件上传。
- Obsidian 插件、Canvas、Dataview、Excalidraw、CRDT、Mermaid、PWA 和 Graph View 不属于当前 MVP。

## 隐私

项目没有遥测、分析、云服务或外部 API 调用。笔记正文不会被记录到日志，也不会存储到 Vault 之外。

## 许可证

本项目采用宽松的 [MIT License](LICENSE)。
