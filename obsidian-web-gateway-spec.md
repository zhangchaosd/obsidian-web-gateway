# Obsidian Web Gateway --- 工程开发规格说明书

> 文档状态：MVP Development Spec\
> 版本：v1.0\
> 日期：2026-09-01\
> 目标读者：Coding Agent、软件架构师、Rust/TypeScript 开发者、测试人员

------------------------------------------------------------------------

## 1. 项目概述

### 1.1 项目名称

暂定名称：**Obsidian Web Gateway（OWG）**

项目名称仅为工作名称，后续可以独立命名。

### 1.2 一句话定义

Obsidian Web Gateway 是一个运行于用户 Windows、macOS 或 Linux
主机上的轻量级守护程序，通过 Web UI 安全地查看和编辑本地 Obsidian
Vault，同时保持 Vault 仍然是标准的 Obsidian Markdown 文件目录。

### 1.3 核心原则

本项目**不是重新实现 Obsidian，也不是新的笔记系统**。

它的定位是：

> 为现有 Obsidian Vault 提供一个安全、轻量、跨平台的 Web 访问入口。

必须始终满足：

1.  Obsidian Vault 是唯一真实数据源（Source of Truth）。
2.  不将 Markdown 内容迁移到数据库。
3.  不改变现有 Vault 的目录结构。
4.  用户停止使用本程序后，Vault 仍可被 Obsidian 直接正常打开。
5.  Desktop Obsidian 与 Web Gateway 可以同时访问同一 Vault。
6.  尽量不向 Vault 写入私有元数据。
7.  Web Gateway 自身的数据应存放于独立应用数据目录。
8.  MVP 不追求 Obsidian 插件兼容。
9.  文件安全、冲突检测和防止数据丢失优先于功能数量。

------------------------------------------------------------------------

# 2. 项目目标

## 2.1 主要使用场景

用户已有：

``` text
MyVault/
├── .obsidian/
├── Daily/
├── Projects/
├── attachments/
├── README.md
└── ...
```

在本机运行：

``` bash
obsidian-web \
  --vault "/Users/user/Documents/MyVault" \
  --listen 127.0.0.1:8765
```

然后浏览器访问：

``` text
http://127.0.0.1:8765
```

或者通过反向代理：

``` text
https://notes.example.com
        │
      Caddy
        │
        ▼
127.0.0.1:8765
```

用户可以在浏览器中：

-   浏览 Vault
-   打开 Markdown
-   编辑 Markdown
-   搜索
-   创建文件
-   创建目录
-   重命名
-   移动
-   删除
-   查看图片和附件
-   点击 `[[Wiki Link]]`
-   查看 Backlinks
-   查看 Outline
-   使用移动设备访问

同时 Desktop Obsidian 仍可正常使用。

------------------------------------------------------------------------

# 3. 非目标

MVP 明确不实现：

-   完整 Obsidian Plugin API
-   第三方 Obsidian 插件运行环境
-   Obsidian Canvas 完整兼容
-   Dataview 完整兼容
-   Excalidraw 完整兼容
-   Obsidian Sync 替代品
-   多人实时协同编辑
-   CRDT
-   Google Docs 式多人光标
-   Git 客户端
-   云存储服务
-   SaaS 服务
-   用户账户体系
-   多租户
-   Markdown 数据库存储

不要为了"更像 Obsidian"破坏 MVP 范围。

------------------------------------------------------------------------

# 4. 技术栈

## 4.1 Backend

必须优先使用：

``` text
Rust
```

推荐：

``` text
tokio
axum
tower
tower-http
serde
serde_json
notify
tracing
tracing-subscriber
sha2
uuid
walkdir
ignore
mime_guess
```

搜索可以根据实际 benchmark 在以下方案中选择：

``` text
内存索引
tantivy
自研倒排索引
```

MVP 优先简单可靠。

## 4.2 Frontend

推荐：

``` text
TypeScript
React
Vite
CodeMirror 6
```

状态管理优先保持简单：

``` text
React Context / Zustand
```

Markdown 解析可选：

``` text
unified / remark / rehype
```

或者：

``` text
markdown-it
```

必须支持自定义 Obsidian Wiki Link 解析。

## 4.3 前后端交付

Release 构建时：

``` text
Frontend
   ↓
static assets
   ↓
embed into Rust binary
```

最终用户只需要一个可执行文件：

``` text
obsidian-web
```

或：

``` text
obsidian-web.exe
```

禁止要求用户另外安装 Node.js。

------------------------------------------------------------------------

# 5. 支持平台

第一阶段：

``` text
macOS arm64
macOS x86_64
Windows x86_64
Linux x86_64
Linux arm64
```

最低优先级：

1.  macOS arm64
2.  Windows x86_64
3.  Linux x86_64
4.  其他

CI 应至少构建上述目标。

------------------------------------------------------------------------

# 6. 总体架构

``` text
┌───────────────────────────────────────────────┐
│                    Browser                    │
│                                               │
│ File Tree | Editor | Preview | Backlinks      │
└──────────────────────┬────────────────────────┘
                       │
                 HTTP / WebSocket
                       │
┌──────────────────────▼────────────────────────┐
│             Obsidian Web Gateway              │
│                                               │
│  HTTP API                                     │
│  WebSocket                                    │
│  Authentication                               │
│  Vault Service                                │
│  Search Service                               │
│  WikiLink Resolver                            │
│  Index Service                                │
│  File Watcher                                 │
│  Conflict Detection                          │
│  Atomic Writer                                │
│  Security / Path Sandbox                      │
└──────────────────────┬────────────────────────┘
                       │
                  Filesystem
                       │
┌──────────────────────▼────────────────────────┐
│                Obsidian Vault                 │
│                                               │
│ *.md                                          │
│ attachments                                   │
│ .obsidian                                     │
└──────────────────────▲────────────────────────┘
                       │
                 Obsidian Desktop
```

------------------------------------------------------------------------

# 7. 推荐项目目录

``` text
obsidian-web/
├── Cargo.toml
├── Cargo.lock
├── README.md
├── LICENSE
│
├── crates/
│   ├── server/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs
│   │       ├── app.rs
│   │       ├── config.rs
│   │       ├── error.rs
│   │       │
│   │       ├── api/
│   │       │   ├── mod.rs
│   │       │   ├── files.rs
│   │       │   ├── tree.rs
│   │       │   ├── search.rs
│   │       │   ├── links.rs
│   │       │   ├── auth.rs
│   │       │   └── system.rs
│   │       │
│   │       ├── vault/
│   │       │   ├── mod.rs
│   │       │   ├── path.rs
│   │       │   ├── reader.rs
│   │       │   ├── writer.rs
│   │       │   ├── operations.rs
│   │       │   └── watcher.rs
│   │       │
│   │       ├── index/
│   │       │   ├── mod.rs
│   │       │   ├── model.rs
│   │       │   ├── parser.rs
│   │       │   ├── search.rs
│   │       │   └── resolver.rs
│   │       │
│   │       ├── security/
│   │       │   ├── mod.rs
│   │       │   ├── auth.rs
│   │       │   └── sandbox.rs
│   │       │
│   │       └── websocket/
│   │           ├── mod.rs
│   │           └── events.rs
│   │
│   └── core/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── models.rs
│           └── errors.rs
│
├── web/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/
│       ├── components/
│       ├── editor/
│       ├── markdown/
│       ├── stores/
│       ├── hooks/
│       ├── pages/
│       └── styles/
│
├── tests/
│   ├── fixtures/
│   ├── integration/
│   └── e2e/
│
└── scripts/
    ├── build.sh
    └── build.ps1
```

Agent 可以合理调整模块，但不得将整个后端堆积在 `main.rs`。

------------------------------------------------------------------------

# 8. CLI 设计

最低要求：

``` bash
obsidian-web --vault <PATH>
```

完整建议：

``` text
--vault <PATH>
--listen <IP:PORT>
--config <PATH>
--log-level <LEVEL>
--read-only
--version
--help
```

示例：

``` bash
obsidian-web \
  --vault "/Users/zc/Documents/MyVault" \
  --listen 127.0.0.1:8765
```

默认：

``` text
listen = 127.0.0.1:8765
```

**不得默认监听 `0.0.0.0`。**

如果用户显式：

``` bash
--listen 0.0.0.0:8765
```

才允许 LAN 访问。

------------------------------------------------------------------------

# 9. 配置文件

建议支持：

``` toml
[vault]
path = "/Users/user/Documents/MyVault"

[server]
listen = "127.0.0.1:8765"

[auth]
enabled = true

[features]
read_only = false
show_hidden_files = false
index_obsidian_directory = false

[logging]
level = "info"
```

优先级：

``` text
CLI > Environment > Config File > Defaults
```

密码、Token 等敏感信息不应以明文自动写入配置文件。

------------------------------------------------------------------------

# 10. Vault 数据模型

## 10.1 FileId

API 中以 Vault 相对路径作为主要标识：

``` text
Projects/Quant.md
```

不要向客户端暴露：

``` text
/Users/user/Documents/MyVault/Projects/Quant.md
```

客户端永远不需要知道 Vault 的真实绝对路径。

## 10.2 IndexedDocument

建议：

``` rust
struct IndexedDocument {
    path: VaultPath,
    filename: String,
    stem: String,
    title: Option<String>,
    aliases: Vec<String>,
    headings: Vec<Heading>,
    tags: Vec<String>,
    links: Vec<WikiLink>,
    embeds: Vec<EmbedLink>,
    modified_at: SystemTime,
    size: u64,
    content_hash: String,
}
```

## 10.3 Heading

``` rust
struct Heading {
    level: u8,
    text: String,
    slug: String,
    line: usize,
}
```

## 10.4 WikiLink

需要至少识别：

``` text
[[Note]]
[[Note|Alias]]
[[Note#Heading]]
[[Note#Heading|Alias]]
```

第二阶段：

``` text
[[Note^block]]
```

## 10.5 Embed

至少支持：

``` text
![[image.png]]
![[folder/image.png]]
```

后续：

``` text
![[Note]]
![[Note#Heading]]
```

------------------------------------------------------------------------

# 11. Vault 初始化

启动流程：

``` text
Validate CLI
    ↓
Resolve Vault Root
    ↓
Canonicalize
    ↓
Security Validation
    ↓
Initial Scan
    ↓
Build Index
    ↓
Start File Watcher
    ↓
Start HTTP Server
```

启动日志：

``` text
Vault: /Users/.../MyVault
Files: 1823
Markdown: 1256
Attachments: 567
Index build: 138 ms
Listening: http://127.0.0.1:8765
```

禁止在日志中输出笔记正文。

------------------------------------------------------------------------

# 12. 文件树 API

建议：

``` http
GET /api/v1/tree
```

返回：

``` json
{
  "entries": [
    {
      "name": "Projects",
      "path": "Projects",
      "type": "directory",
      "children": []
    },
    {
      "name": "README.md",
      "path": "README.md",
      "type": "markdown"
    }
  ]
}
```

大 Vault 后续可改为 lazy loading：

``` http
GET /api/v1/tree?path=Projects
```

MVP 可根据性能测试决定。

------------------------------------------------------------------------

# 13. 文件读取 API

``` http
GET /api/v1/file?path=Projects/Quant.md
```

返回：

``` json
{
  "path": "Projects/Quant.md",
  "content": "# Quant\n...",
  "revision": {
    "mtimeMs": 1788223821000,
    "hash": "sha256:..."
  }
}
```

Hash 应基于文件内容。

------------------------------------------------------------------------

# 14. 文件保存 API

``` http
PUT /api/v1/file
Content-Type: application/json
```

请求：

``` json
{
  "path": "Projects/Quant.md",
  "content": "# Quant\nnew content",
  "baseRevision": {
    "hash": "sha256:..."
  }
}
```

正常：

``` http
200 OK
```

返回新 revision。

如果磁盘文件已被 Obsidian 或其他程序修改：

``` http
409 Conflict
```

返回：

``` json
{
  "error": "revision_conflict",
  "message": "File has been modified externally.",
  "currentRevision": {
    "hash": "sha256:new..."
  }
}
```

客户端必须提示：

``` text
文件已被其他程序修改。

[重新加载]
[查看差异]
[强制覆盖]
```

强制覆盖必须是用户显式动作。

------------------------------------------------------------------------

# 15. 原子写入

禁止：

``` text
truncate(original)
write(original)
```

标准写入流程：

``` text
Create temp file in same directory
        ↓
Write complete content
        ↓
Flush
        ↓
Sync when appropriate
        ↓
Atomic rename / replace
        ↓
Update index
        ↓
Broadcast event
```

临时文件应尽量在同一文件系统和同一目录。

必须处理 Windows 与 POSIX rename/replace 行为差异。

保存失败时：

**原文件必须保持完整。**

------------------------------------------------------------------------

# 16. 文件操作 API

需要：

``` text
Create File
Create Directory
Rename
Move
Delete
```

建议：

``` http
POST   /api/v1/files
POST   /api/v1/directories
PATCH  /api/v1/path
DELETE /api/v1/path
```

删除默认应设计为可恢复。

优先策略：

``` text
Vault/.trash
```

如果 Obsidian 配置或平台行为允许，可后续支持系统 Trash。

MVP 禁止无确认永久删除。

------------------------------------------------------------------------

# 17. 文件监听

使用 Rust：

``` text
notify
```

监听：

``` text
CREATE
MODIFY
REMOVE
RENAME
```

流程：

``` text
Filesystem Event
      ↓
Debounce
      ↓
Normalize
      ↓
Update Index
      ↓
WebSocket Broadcast
```

必须考虑：

-   Obsidian 保存可能触发多个事件
-   atomic rename
-   编辑器临时文件
-   大量批量修改
-   Git checkout
-   文件同步工具

建议 debounce：

``` text
50–300 ms
```

具体数值通过测试确定，不应依赖"一个 save = 一个 watcher event"的假设。

------------------------------------------------------------------------

# 18. WebSocket

建议：

``` text
GET /api/v1/ws
```

事件统一格式：

``` json
{
  "type": "file.changed",
  "payload": {
    "path": "Projects/Quant.md"
  }
}
```

事件至少：

``` text
file.created
file.changed
file.deleted
file.renamed
index.ready
index.updated
```

rename：

``` json
{
  "type": "file.renamed",
  "payload": {
    "oldPath": "A.md",
    "newPath": "B.md"
  }
}
```

Web 客户端收到当前文件的 `file.changed` 后：

-   如果没有未保存内容：自动重新读取。
-   如果存在未保存内容：显示外部修改提示。
-   禁止静默覆盖用户编辑。

------------------------------------------------------------------------

# 19. Wiki Link Resolver

这是 MVP 的核心能力之一。

例如：

``` text
[[Rust]]
```

Resolver 建立：

``` text
Rust
   ↓
Programming/Rust.md
```

解析依据至少包括：

``` text
filename
stem
frontmatter aliases
relative path
```

如果出现多个候选：

``` text
A/Rust.md
B/Rust.md
```

不得随机选择。

API：

``` http
GET /api/v1/resolve?link=Rust&source=Projects/Test.md
```

返回：

``` json
{
  "status": "resolved",
  "path": "Programming/Rust.md"
}
```

或：

``` json
{
  "status": "ambiguous",
  "candidates": [
    "A/Rust.md",
    "B/Rust.md"
  ]
}
```

尽可能模拟 Obsidian 的链接解析直觉，但 MVP 不要求 100% 内部实现一致。

------------------------------------------------------------------------

# 20. Backlinks

索引建立：

``` text
Source.md
   │
   ├── [[Rust]]
   └── [[Quant]]
```

同时建立 reverse index：

``` text
Rust.md
   ← Source.md
   ← Other.md
```

API：

``` http
GET /api/v1/backlinks?path=Programming/Rust.md
```

返回：

``` json
{
  "items": [
    {
      "path": "Projects/A.md",
      "references": [
        {
          "line": 15,
          "context": "..."
        }
      ]
    }
  ]
}
```

Context 长度应有限制。

------------------------------------------------------------------------

# 21. 搜索

MVP 至少支持：

``` text
文件名搜索
路径搜索
Markdown 正文全文搜索
```

建议 API：

``` http
GET /api/v1/search?q=rust
```

返回：

``` json
{
  "results": [
    {
      "path": "Programming/Rust.md",
      "score": 0.95,
      "matches": [
        {
          "line": 12,
          "snippet": "..."
        }
      ]
    }
  ]
}
```

要求：

-   典型几千个 Markdown 文件时交互响应流畅。
-   不允许每次按键都完整扫描整个磁盘。
-   搜索结果限制数量。
-   API 设置合理输入长度上限。

------------------------------------------------------------------------

# 22. Frontmatter

至少解析 YAML Frontmatter：

``` yaml
---
title: Rust
aliases:
  - Rust Language
tags:
  - programming
  - rust
---
```

MVP 读取：

``` text
title
aliases
tags
```

第一版不要求提供复杂 Properties GUI。

编辑器直接编辑 YAML 即可。

------------------------------------------------------------------------

# 23. Markdown 编辑器

使用：

``` text
CodeMirror 6
```

必须具备：

-   Markdown syntax highlighting
-   Undo / Redo
-   Find
-   Keyboard shortcuts
-   Line numbers 可配置
-   自动保存可配置
-   未保存状态
-   外部修改提示
-   `Ctrl/Cmd + S`

MVP 可以采用：

``` text
Edit / Preview
```

两种模式。

后续再考虑 Live Preview。

------------------------------------------------------------------------

# 24. Markdown Preview

至少支持：

``` text
CommonMark / GFM
Headings
Lists
Task Lists
Tables
Code Blocks
Blockquotes
Links
Images
Wiki Links
Obsidian image embeds
```

建议支持：

``` text
Mermaid
```

但 Mermaid 不是阻塞 MVP 发布的条件。

HTML 默认应进行安全过滤。

禁止未经处理直接执行 Markdown 内任意 script。

------------------------------------------------------------------------

# 25. 附件

浏览器需要能够读取 Vault 内附件。

API 例如：

``` http
GET /api/v1/asset?path=attachments/a.png
```

必须：

-   验证路径
-   检查 Vault sandbox
-   正确 MIME
-   支持 Range（至少为未来 PDF/视频预留）
-   设置合理缓存策略

MVP 图片至少：

``` text
png
jpg
jpeg
gif
webp
svg
```

SVG 必须考虑脚本/XSS 风险，不能把不可信 SVG 当成无风险图片。

------------------------------------------------------------------------

# 26. Web UI

桌面布局建议：

``` text
┌──────────────┬─────────────────────────────┬───────────────┐
│ Sidebar      │ Editor / Preview            │ Context       │
│              │                             │               │
│ Files        │ # Document                  │ Backlinks     │
│ Search       │                             │ Outline       │
│              │ Markdown...                 │ Properties    │
│              │                             │               │
└──────────────┴─────────────────────────────┴───────────────┘
```

左侧：

``` text
File Tree
Search
```

中央：

``` text
Editor
Preview
```

右侧：

``` text
Outline
Backlinks
```

右栏可折叠。

------------------------------------------------------------------------

# 27. Mobile UI

必须 Responsive。

手机：

``` text
┌─────────────────────────┐
│ ☰   Note Title      ⋮   │
├─────────────────────────┤
│                         │
│ Markdown / Preview      │
│                         │
└─────────────────────────┘
```

File Tree 使用 Drawer。

目标：

-   iPhone Safari
-   Android Chrome

不得要求安装 App。

PWA 可作为后续功能。

------------------------------------------------------------------------

# 28. 安全模型

安全是 P0。

整个程序必须假设：

``` text
HTTP 请求参数完全不可信
Markdown 内容可能不可信
文件名可能不可信
Vault 中可能存在 symlink
```

------------------------------------------------------------------------

# 29. Path Traversal 防护

必须拒绝：

``` text
../../etc/passwd
..\..\Windows\System32
%2e%2e/
双重 URL 编码
混合 slash
Unicode / normalization 绕过
```

所有文件访问必须经过统一：

``` rust
VaultPathResolver
```

禁止 API handler 自己：

``` rust
vault_root.join(user_input)
```

后直接访问。

标准逻辑：

``` text
Parse relative Vault path
        ↓
Reject absolute path
        ↓
Normalize safely
        ↓
Resolve/canonicalize existing ancestor as appropriate
        ↓
Validate target remains inside canonical Vault root
        ↓
Validate symlink policy
        ↓
Filesystem operation
```

对"创建新文件"这类目标尚不存在、无法直接 canonicalize 的情况，必须
canonicalize 已存在的父目录，再验证最终目标。

------------------------------------------------------------------------

# 30. Symlink 策略

默认：

> 不允许通过 Vault 内 symlink 访问 Vault 外文件。

例如：

``` text
Vault/private -> ~/.ssh
```

请求：

``` text
private/id_rsa
```

必须拒绝。

建议：

``` http
403 Forbidden
```

测试必须覆盖该攻击。

------------------------------------------------------------------------

# 31. 隐藏目录

默认：

``` text
.obsidian
.git
.trash
```

不出现在普通 File Tree。

`.obsidian`：

-   不作为普通笔记索引
-   不允许通过常规文件 API 随意编辑

后续如果需要配置读取，使用独立、受限 API。

`.git` 永远不应通过普通 Web 文件接口暴露。

------------------------------------------------------------------------

# 32. 身份认证

即使默认监听 localhost，也应设计 Auth Layer。

MVP 可采用：

``` text
Password Login
Session Cookie
```

要求：

-   Password 使用安全密码哈希。
-   Session token 使用 CSPRNG。
-   Cookie：

``` text
HttpOnly
SameSite=Strict 或合理安全值
Secure（HTTPS 环境）
```

需要考虑反向代理 TLS termination。

禁止将长期认证 Token 放入 URL Query。

------------------------------------------------------------------------

# 33. CSRF / CORS

默认：

``` text
CORS = same origin only
```

写操作需要 CSRF 防护，或者采用能够明确证明安全的 same-site/session
设计。

不得默认：

``` text
Access-Control-Allow-Origin: *
```

------------------------------------------------------------------------

# 34. HTTP Security Headers

至少评估并设置：

``` text
Content-Security-Policy
X-Content-Type-Options
Referrer-Policy
frame-ancestors
```

避免 Markdown 中嵌入内容导致 XSS。

------------------------------------------------------------------------

# 35. 反向代理

典型：

``` text
Internet
    │
  HTTPS
    │
  Caddy
    │
127.0.0.1:8765
    │
Obsidian Web Gateway
```

Caddy 示例可放 README，但程序本身不负责申请证书。

应用必须正确处理：

``` text
X-Forwarded-For
X-Forwarded-Proto
```

但只能在明确配置 trusted proxy 后信任代理头，避免客户端伪造。

------------------------------------------------------------------------

# 36. 外部服务器场景

如果 Vault 在 Mac/Windows，而公网 Caddy 在另一台服务器：

``` text
Browser
   │
Internet
   │
Server / Caddy
   │
Private Tunnel
   │
Mac / Windows
   │
Obsidian Web Gateway
   │
Vault
```

可使用：

``` text
WireGuard
Tailscale
SSH Reverse Tunnel
frp
Cloudflare Tunnel
```

这些属于部署层，不纳入 MVP 核心程序。

程序默认不主动建立第三方 Tunnel。

------------------------------------------------------------------------

# 37. Read-only 模式

支持：

``` bash
obsidian-web --vault ... --read-only
```

该模式：

允许：

``` text
read
search
preview
backlinks
```

拒绝：

``` text
write
rename
move
delete
create
upload
```

服务端必须强制，不得只在前端隐藏按钮。

------------------------------------------------------------------------

# 38. 冲突模型

目标不是实现多人协同，而是避免：

``` text
Web 与 Obsidian 同时编辑造成静默覆盖
```

采用：

``` text
Optimistic Concurrency Control
```

读取：

``` text
content + revision hash
```

保存：

``` text
content + base revision hash
```

服务端：

``` text
current hash == base hash
    → save

current hash != base hash
    → 409
```

MVP 必须完成。

------------------------------------------------------------------------

# 39. Web 编辑状态

客户端每个打开文档维护：

``` typescript
type DocumentState = {
  path: string
  content: string
  savedContent: string
  baseHash: string
  dirty: boolean
  externalChangeDetected: boolean
}
```

切换文件时如果 dirty：

不能静默丢弃。

至少提供：

``` text
Save
Discard
Cancel
```

------------------------------------------------------------------------

# 40. 自动保存

MVP 可以提供：

``` text
autosave = true/false
```

如果开启：

``` text
停止输入 N ms
    ↓
revision check
    ↓
atomic save
```

建议默认 debounce：

``` text
1000–2000 ms
```

最终数值可配置。

发生冲突后必须停止自动覆盖。

------------------------------------------------------------------------

# 41. 大文件保护

防止意外打开巨大文件。

默认：

``` text
Markdown editable limit: 10 MB
```

超过限制：

``` text
File too large for browser editing.
```

配置可调整。

附件使用流式传输，不应全部加载进 Rust 内存。

------------------------------------------------------------------------

# 42. 编码

MVP：

``` text
UTF-8
```

遇到非 UTF-8 Markdown：

不得破坏原文件。

返回明确错误：

``` text
unsupported_encoding
```

后续再考虑其他编码。

------------------------------------------------------------------------

# 43. 日志

使用：

``` text
tracing
```

级别：

``` text
error
warn
info
debug
trace
```

默认：

``` text
info
```

禁止记录：

``` text
完整 Markdown 正文
Password
Session token
Authorization header
```

允许：

``` text
path
operation
duration
result
```

敏感路径是否输出应考虑 debug 与隐私。

------------------------------------------------------------------------

# 44. 错误格式

统一：

``` json
{
  "error": "revision_conflict",
  "message": "File has been modified externally.",
  "requestId": "..."
}
```

HTTP status 正确使用：

``` text
400 invalid request
401 unauthenticated
403 forbidden
404 not found
409 conflict
413 too large
415 unsupported media/encoding
500 internal error
```

不得所有错误都返回 200。

------------------------------------------------------------------------

# 45. 性能目标

测试 Vault：

``` text
5,000 Markdown
5,000 attachments
~1 GB total
```

建议目标：

``` text
Cold startup index < 5s
Warm normal startup < 2s（如未来实现持久缓存）
File open API < 100ms
Filename search < 100ms
Typical content search < 300ms
Save < 100ms excluding slow filesystem
Idle memory < 200MB
```

以上为工程目标，不是绝对 SLA。

必须 benchmark，而不是为了达标做不安全优化。

------------------------------------------------------------------------

# 46. 测试策略

至少包含：

``` text
Rust Unit Tests
Rust Integration Tests
Frontend Unit Tests
E2E Tests
Security Tests
```

------------------------------------------------------------------------

# 47. 必测安全案例

必须自动测试：

``` text
../
../../
absolute path
URL encoded traversal
double encoded traversal
Windows path traversal
symlink escape
rename outside vault
move outside vault
delete outside vault
asset traversal
invalid UTF-8 path/input handling
XSS Markdown
malicious SVG
CSRF
unauthenticated write
read-only write attempt
```

这些属于 release blocker。

------------------------------------------------------------------------

# 48. 文件一致性测试

场景：

### Case A

Web：

``` text
read A.md
edit
save
```

结果：

``` text
Desktop Obsidian immediately sees content.
```

### Case B

Web 打开 A.md。

Desktop Obsidian 修改 A.md。

Web 收到：

``` text
file.changed
```

### Case C

Web 有未保存修改。

Desktop 修改文件。

Web 不得自动覆盖。

### Case D

Web 基于旧 revision 保存。

返回：

``` text
409
```

### Case E

保存过程中模拟失败。

原文件内容必须完整。

------------------------------------------------------------------------

# 49. Watcher 测试

测试：

``` text
vim save
VS Code save
Obsidian save
atomic rename save
cp
mv
rm
git checkout
大量文件批量创建
```

确保 index 最终一致。

Watcher event 数量本身不是业务语义。

------------------------------------------------------------------------

# 50. MVP 功能列表

## P0

必须完成：

-   [ ] CLI
-   [ ] Vault root
-   [ ] Web Server
-   [ ] Embedded frontend
-   [ ] File Tree
-   [ ] Markdown Read
-   [ ] Markdown Edit
-   [ ] Markdown Preview
-   [ ] Atomic Save
-   [ ] Revision Conflict Detection
-   [ ] Create
-   [ ] Rename
-   [ ] Move
-   [ ] Recoverable Delete
-   [ ] Filesystem Watcher
-   [ ] WebSocket
-   [ ] Wiki Links
-   [ ] Image Embed
-   [ ] Search
-   [ ] Authentication
-   [ ] Path Sandbox
-   [ ] Symlink Protection
-   [ ] Responsive UI
-   [ ] Read-only mode

## P1

MVP 后尽快：

-   [ ] Backlinks
-   [ ] Outline
-   [ ] Tags
-   [ ] Frontmatter properties display
-   [ ] Mermaid
-   [ ] Upload attachments
-   [ ] Drag & Drop
-   [ ] Command Palette
-   [ ] Recent files
-   [ ] Daily Notes shortcut
-   [ ] Dark mode
-   [ ] Theme preference

## P2

后续：

-   [ ] Graph View
-   [ ] Templates
-   [ ] Block Reference
-   [ ] Note Embed
-   [ ] PDF Preview
-   [ ] PWA
-   [ ] Persistent index cache
-   [ ] Git status display
-   [ ] Basic Canvas viewer

## 明确暂不实现

-   [ ] Obsidian Plugin API
-   [ ] Arbitrary community plugins
-   [ ] Full Dataview
-   [ ] Collaborative CRDT

------------------------------------------------------------------------

# 51. 开发阶段

## Phase 0 --- Skeleton

目标：

``` text
cargo run -- --vault tests/fixtures/basic
```

浏览器打开：

``` text
http://127.0.0.1:8765
```

看到 Web UI。

验收：

-   Rust server 可启动。
-   React build 可嵌入 binary。
-   `/api/v1/system` 正常。
-   CI 可编译。

------------------------------------------------------------------------

# 52. Phase 1 --- Vault Read

实现：

``` text
VaultPath
Sandbox
Tree
Read
Asset
```

验收：

-   浏览 Vault 文件树。
-   打开 Markdown。
-   显示图片。
-   `../../` 无法逃逸。
-   symlink 无法逃逸。
-   不暴露绝对 Vault 路径。

此阶段不得实现写入前先跳过安全模型。

------------------------------------------------------------------------

# 53. Phase 2 --- Editing

实现：

``` text
CodeMirror
PUT file
Revision
Atomic Write
Dirty State
```

验收：

-   Web 编辑 Markdown。
-   Obsidian 可立即读取修改。
-   保存失败不损坏原文件。
-   外部修改产生 409。
-   Web 不静默覆盖。

------------------------------------------------------------------------

# 54. Phase 3 --- Watcher

实现：

``` text
notify
debounce
WebSocket
incremental index update
```

验收：

Desktop Obsidian 修改文件：

``` text
< 1s
```

Web 感知变化。

批量修改后 index 最终一致。

------------------------------------------------------------------------

# 55. Phase 4 --- Obsidian Semantics

实现：

``` text
Wiki Link
Alias
Heading
Embed
Backlink
Frontmatter
```

验收：

``` text
[[Note]]
[[Note|Alias]]
[[Note#Heading]]
![[image.png]]
```

可正确工作。

------------------------------------------------------------------------

# 56. Phase 5 --- Search

实现：

``` text
Filename
Path
Content
```

验收：

5000 个 Markdown 的测试 Vault 下达到性能目标附近，并保证搜索不会阻塞所有
API 请求。

------------------------------------------------------------------------

# 57. Phase 6 --- Authentication & Hardening

实现：

``` text
Login
Session
CSRF
Security Headers
Rate Limits
Request Limits
```

进行 security test。

所有安全 blocker 修复后才允许标记 MVP release。

------------------------------------------------------------------------

# 58. Phase 7 --- Release

生成：

``` text
obsidian-web-darwin-arm64
obsidian-web-darwin-x86_64
obsidian-web-windows-x86_64.exe
obsidian-web-linux-x86_64
obsidian-web-linux-arm64
```

Release 包含：

``` text
binary
README
LICENSE
checksums
```

最终 binary 不依赖 Node.js。

------------------------------------------------------------------------

# 59. CI/CD

建议 GitHub Actions：

``` text
lint
test
frontend-test
cargo-test
security-tests
build
release
```

Rust：

``` bash
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

Frontend：

``` bash
npm ci
npm run typecheck
npm test
npm run build
```

Agent 可以根据选择的 package manager 调整，但 lockfile 必须提交。

------------------------------------------------------------------------

# 60. README 必须包含

README 至少：

``` text
What is it?
What it is NOT
Quick Start
CLI
Configuration
Security
Reverse Proxy
Backup Warning
Development
Build
Testing
Known Limitations
```

必须明确提醒：

> 在首次使用写入功能前备份 Vault。

------------------------------------------------------------------------

# 61. Backup 原则

程序本身 MVP 不负责完整备份。

但设计必须保证：

``` text
Vault remains ordinary files.
```

建议用户：

``` text
Git
NAS Snapshot
Time Machine
Windows File History
ZFS/Btrfs Snapshot
```

程序不得把"自动备份存在"作为安全写入的前提。

------------------------------------------------------------------------

# 62. API Versioning

所有 API：

``` text
/api/v1/
```

WebSocket：

``` text
/api/v1/ws
```

避免未来无法演进。

------------------------------------------------------------------------

# 63. API 最小集合

``` text
GET    /api/v1/system
POST   /api/v1/auth/login
POST   /api/v1/auth/logout

GET    /api/v1/tree
GET    /api/v1/file
PUT    /api/v1/file

POST   /api/v1/files
POST   /api/v1/directories
PATCH  /api/v1/path
DELETE /api/v1/path

GET    /api/v1/asset
GET    /api/v1/search
GET    /api/v1/resolve
GET    /api/v1/backlinks

GET    /api/v1/ws
```

Agent 应为 API 建立统一 request/response model。

------------------------------------------------------------------------

# 64. System API

``` http
GET /api/v1/system
```

示例：

``` json
{
  "version": "0.1.0",
  "vault": {
    "name": "MyVault"
  },
  "features": {
    "readOnly": false,
    "search": true,
    "backlinks": true
  }
}
```

禁止返回：

``` text
/Users/xxx/...
C:\Users\xxx\...
```

------------------------------------------------------------------------

# 65. 并发

Backend 必须支持并发请求。

不要用一个全局大 Mutex 包住整个 Vault。

建议：

``` text
immutable/read-mostly index
fine-grained synchronization
async HTTP
blocking filesystem work isolated when necessary
```

不要在 Tokio async executor 上执行长时间
CPU/阻塞任务而导致整个服务卡顿。

------------------------------------------------------------------------

# 66. Index 一致性

Index 是：

``` text
Derived State
```

不是 Source of Truth。

任何时候 index 损坏：

``` text
delete/rebuild index
```

都必须能从 Vault 完整恢复。

未来即使引入 SQLite/Tantivy：

> 也只能用于缓存和索引，绝不能成为笔记正文的唯一存储。

------------------------------------------------------------------------

# 67. `.obsidian` 兼容原则

MVP 不需要理解所有 `.obsidian` 配置。

可以选择性读取：

``` text
attachmentFolderPath
newFileLocation
useMarkdownLinks
```

但第一版不是必须。

禁止未经明确功能需求修改：

``` text
.obsidian/*
```

------------------------------------------------------------------------

# 68. 文件重命名与 Wiki Links

MVP 重命名：

``` text
A.md → B.md
```

不要求自动修改所有：

``` text
[[A]]
```

因为这涉及 Obsidian link-update semantics。

但 UI 必须明确：

``` text
Rename file only
```

P1 可实现：

``` text
Update internal links on rename
```

实现前必须有完整测试，避免误改正文/code block。

------------------------------------------------------------------------

# 69. Markdown Parser 原则

不要通过简单 regex 完成全部 Markdown 解析。

特别：

``` text
code fences
inline code
escaped brackets
frontmatter
links
```

必须避免将代码块中的：

``` text
[[Example]]
```

误认为真实 Wiki Link。

优先使用 AST parser + 自定义 extension。

------------------------------------------------------------------------

# 70. XSS 安全

例如笔记：

``` html
<script>alert(1)</script>
```

不得执行。

包括：

``` text
javascript:
data:
SVG scripts
event handlers
iframe
object
embed
```

Preview 渲染必须经过 sanitizer 和明确 allowlist。

这是 P0 Security Requirement。

------------------------------------------------------------------------

# 71. 请求限制

建议默认：

``` text
JSON request body limit
Markdown save size limit
Upload size limit
Search query length limit
WebSocket message limit
```

避免单个请求造成 OOM。

------------------------------------------------------------------------

# 72. Rate Limit

登录接口至少需要 rate limit：

``` text
per IP / per session
```

例如：

``` text
5 failed attempts / minute
```

具体策略可配置。

正常 localhost 使用不能因此明显受影响。

------------------------------------------------------------------------

# 73. 可观测性

`/api/v1/system` 不应暴露敏感信息。

日志可包含 request ID。

未来可选：

``` text
/health
```

用于反向代理：

``` http
GET /health
```

返回：

``` text
200 OK
```

不需要认证，但不得包含 Vault 信息。

------------------------------------------------------------------------

# 74. 进程退出

收到：

``` text
SIGTERM
SIGINT
```

执行：

``` text
Stop accepting new requests
Finish active save where possible
Close WebSocket
Flush logs
Exit
```

不能在写文件中间粗暴破坏数据。

Windows 需要相应退出处理。

------------------------------------------------------------------------

# 75. 单实例

同一个 Vault 是否允许多个 Gateway：

MVP 建议：

``` text
允许启动，但发出 warning
```

或者实现 application lock。

如果实现 lock，不得妨碍 Obsidian Desktop。

锁只能锁 Gateway 自己的 metadata/lock file，不能独占整个 Vault。

------------------------------------------------------------------------

# 76. 应用数据目录

不要污染 Vault。

例如：

macOS：

``` text
~/Library/Application Support/obsidian-web/
```

Windows：

``` text
%APPDATA%\obsidian-web\
```

Linux：

``` text
$XDG_DATA_HOME/obsidian-web/
```

存储：

``` text
config
auth state
index cache
logs（如果启用文件日志）
```

不要存储唯一笔记正文。

------------------------------------------------------------------------

# 77. UX 原则

优先：

``` text
Fast
Predictable
Keyboard-friendly
Safe
```

不要为了视觉效果牺牲编辑可靠性。

关键状态必须明显：

``` text
Saved
Saving
Unsaved
Conflict
Disconnected
Read-only
```

------------------------------------------------------------------------

# 78. 网络断开

如果 WebSocket 断开：

UI 显示：

``` text
Disconnected
```

重新连接后：

``` text
re-fetch current revision
```

如果本地存在 dirty content：

不得直接覆盖。

------------------------------------------------------------------------

# 79. 浏览器刷新

如果有未保存内容：

尽可能：

``` text
beforeunload warning
```

可选使用浏览器本地临时 draft：

``` text
sessionStorage / IndexedDB
```

但 draft 只是灾难恢复，不是 Source of Truth。

------------------------------------------------------------------------

# 80. 可访问性

基本要求：

``` text
Keyboard navigation
Focus states
ARIA labels
Reasonable contrast
```

不能只靠鼠标操作核心功能。

------------------------------------------------------------------------

# 81. 快捷键

MVP：

``` text
Cmd/Ctrl + S       Save
Cmd/Ctrl + P       Quick Open
Cmd/Ctrl + F       Find in file
Cmd/Ctrl + Shift+F Global Search
```

不得覆盖浏览器关键快捷键而导致异常体验，需实际测试。

------------------------------------------------------------------------

# 82. Quick Open

建议：

``` text
Cmd/Ctrl + P
```

弹出：

``` text
Search filename / path
```

利用内存索引即时返回。

这是非常高价值的 Obsidian-like 功能。

------------------------------------------------------------------------

# 83. Outline

解析：

``` markdown
# A
## B
### C
```

右栏展示。

点击滚动到对应 heading。

P1，但 parser 在 MVP 索引阶段应尽量保留 heading 数据，避免后续重构。

------------------------------------------------------------------------

# 84. Dark Mode

P1。

建议：

``` text
System
Light
Dark
```

前端偏好存在 browser local storage。

不需要修改 Obsidian theme。

------------------------------------------------------------------------

# 85. 未来 Graph

索引的数据结构从一开始保留：

``` text
Document → WikiLinks
```

未来：

``` text
nodes = notes
edges = wikilinks
```

即可构建 Graph。

MVP 不实现 Graph UI，但不要把 link index 设计成无法扩展。

------------------------------------------------------------------------

# 86. 未来 Agent / API

架构上保持 API 可复用。

未来可以增加：

``` text
MCP
REST automation
AI search
```

但 MVP 不接入任何 AI API。

用户笔记不得自动上传第三方服务。

------------------------------------------------------------------------

# 87. Privacy

默认：

``` text
No telemetry
No analytics
No cloud
No external API calls
```

如果未来增加 telemetry：

必须：

``` text
opt-in
documented
disable-able
no note content
```

------------------------------------------------------------------------

# 88. 依赖原则

尽量减少重量级依赖。

任何处理：

``` text
Markdown HTML
Authentication
Crypto
Path
```

的库必须选择成熟实现。

不要自己实现密码哈希或加密算法。

------------------------------------------------------------------------

# 89. Code Quality

Rust：

``` text
#![forbid(unsafe_code)]
```

除非未来某个经过审计的底层需求确实必须使用 unsafe。

业务代码禁止：

``` text
unwrap()
expect()
```

处理外部输入时尤其如此。

测试代码可合理使用。

------------------------------------------------------------------------

# 90. Error Handling

推荐：

``` text
thiserror
anyhow（应用边界）
```

领域错误：

``` text
VaultError
PathError
ConflictError
AuthError
IndexError
```

API 层统一映射 HTTP status。

------------------------------------------------------------------------

# 91. Agent 开发规则

Coding Agent 开发本项目时必须遵守：

1.  先阅读完整 Spec。
2.  不擅自扩大 MVP 范围。
3.  每个 Phase 完成后运行测试。
4.  不以 TODO 代替核心功能。
5.  不 mock 掉文件安全逻辑作为最终实现。
6.  不为了通过测试删除安全检查。
7.  修改公共 API 时同步更新文档。
8.  新增依赖前说明用途。
9.  任何文件写入功能必须有失败/冲突测试。
10. Security Test failure = Release Blocker。
11. Source of Truth 永远是 Vault 文件。
12. 不得把用户笔记上传第三方服务。
13. 不修改 `.obsidian`，除非明确需求。
14. 保持单二进制发布目标。
15. 优先正确性，再优化性能。

------------------------------------------------------------------------

# 92. Agent 推荐执行顺序

Agent 不要一次生成整个系统。

按顺序：

``` text
1. Initialize workspace
2. Implement VaultPath
3. Security tests
4. Read-only filesystem API
5. React shell
6. File Tree
7. Markdown reader
8. Markdown editor
9. Revision model
10. Atomic writer
11. Conflict tests
12. File operations
13. Watcher
14. WebSocket
15. Index
16. Wiki links
17. Search
18. Authentication
19. Security hardening
20. E2E
21. Release build
```

尤其：

> `VaultPath + Sandbox` 必须先于所有写接口。

------------------------------------------------------------------------

# 93. Definition of Done --- MVP

只有全部满足才能称为 MVP：

### Functional

-   [ ] 可浏览真实 Obsidian Vault
-   [ ] 可编辑 Markdown
-   [ ] 可预览 Markdown
-   [ ] 可创建/重命名/移动/删除
-   [ ] Wiki Links 可导航
-   [ ] 图片可显示
-   [ ] 可全文搜索
-   [ ] Desktop Obsidian 修改能被 Web 感知
-   [ ] Web 修改能被 Desktop Obsidian 感知
-   [ ] 手机浏览器可正常使用

### Data Safety

-   [ ] Atomic write
-   [ ] Revision conflict detection
-   [ ] External modification handling
-   [ ] Failed write does not corrupt original
-   [ ] Dirty document cannot silently disappear

### Security

-   [ ] Authentication
-   [ ] Path traversal protected
-   [ ] Symlink escape protected
-   [ ] XSS protected
-   [ ] CSRF considered/protected
-   [ ] Read-only enforced server-side
-   [ ] `.git` not exposed
-   [ ] Absolute host path not exposed

### Engineering

-   [ ] Rust tests pass
-   [ ] Frontend tests pass
-   [ ] E2E pass
-   [ ] Security tests pass
-   [ ] cargo fmt pass
-   [ ] cargo clippy pass
-   [ ] TypeScript typecheck pass
-   [ ] Release binaries produced
-   [ ] README complete

------------------------------------------------------------------------

# 94. 最终验收场景

准备真实 Vault 副本：

``` text
TestVault/
├── .obsidian/
├── Daily/
│   └── 2026-09-01.md
├── Projects/
│   ├── Quant.md
│   └── Rust.md
├── attachments/
│   └── architecture.png
└── Home.md
```

Home.md：

``` markdown
# Home

See [[Projects/Rust|Rust Notes]].

![[attachments/architecture.png]]
```

执行：

``` bash
obsidian-web \
  --vault ./TestVault \
  --listen 127.0.0.1:8765
```

验收：

1.  浏览器打开 Home.md。
2.  图片正确显示。
3.  点击 Rust Notes 打开 Rust.md。
4.  编辑 Rust.md 并保存。
5.  Desktop Obsidian 看到新内容。
6.  Desktop Obsidian 修改 Rust.md。
7.  Web 自动感知。
8.  Web 保持 dirty 时 Desktop 再修改，出现冲突提示。
9.  搜索能找到修改后的正文。
10. 手机浏览器可打开并编辑。
11. `../../` 攻击失败。
12. symlink escape 攻击失败。
13. 未登录写入失败。
14. read-only 模式所有写入失败。
15. 杀死/模拟失败写入不会产生 0 字节原文件。

全部通过后，MVP 才算验收。

------------------------------------------------------------------------

# 95. 最终产品形态

理想用户体验：

``` bash
obsidian-web --vault ~/Documents/MyVault
```

输出：

``` text
Obsidian Web Gateway v0.1.0

Vault: MyVault
Indexed: 1,823 files
Listening: http://127.0.0.1:8765

Press Ctrl+C to stop.
```

然后用户可以：

``` text
Desktop Obsidian
        │
        ├─────────────┐
        │             │
        ▼             ▼
      Vault      Obsidian Web Gateway
                        │
                        ▼
                     Browser
```

整个生命周期中：

> Vault 始终只是一个标准 Obsidian Vault。

这条原则优先级高于任何 Web 功能。

------------------------------------------------------------------------

# 96. 项目成功标准

项目成功不是"复制了多少 Obsidian 功能"，而是：

> 用户可以放心地把已有 Obsidian Vault
> 交给这个程序，在任何浏览器中安全、快速地访问和编辑，并且随时可以停止使用
> Web Gateway，继续用原来的 Obsidian，数据没有发生任何平台绑定。

因此所有架构决策均应优先考虑：

``` text
Data Ownership
Compatibility
Safety
Simplicity
Performance
```

而不是：

``` text
Feature Count
```

------------------------------------------------------------------------

## 附录 A：首个开发任务

Agent 收到本文档后，第一个任务应为：

> 初始化 Rust workspace 与 React/TypeScript 前端，建立可运行的 server
> skeleton；随后实现经过单元测试的 `VaultPath` / `VaultSandbox`，覆盖
> POSIX、Windows 风格路径、path traversal 与 symlink
> escape。安全路径层验收通过后，再开始实现文件读取 API。

不要第一步就实现编辑器。

------------------------------------------------------------------------

## 附录 B：首个里程碑验收命令

最终项目应逐步形成类似：

``` bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

cd web
npm run typecheck
npm test
npm run build
```

以及：

``` bash
cargo run --release -- \
  --vault ./tests/fixtures/basic \
  --listen 127.0.0.1:8765
```

浏览器访问后完成 Phase 0/1 的人工验收。

------------------------------------------------------------------------

**End of Specification**
