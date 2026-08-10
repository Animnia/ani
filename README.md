# ani

[![test](https://github.com/Animnia/ani/actions/workflows/test.yml/badge.svg)](https://github.com/Animnia/ani/actions/workflows/test.yml)

一个极简的个人 Agent：**DeepSeek 大脑，QQ/Telegram 身体，pi 的灵魂**。

- 零 npm 依赖 —— 只用 Node.js 24+ 内置能力（原生 TS、fetch、WebSocket、readline）
- 单一可执行入口：`node ani.ts`
- 全部数据在项目内：`data/`（会话、记忆、定时任务、收件箱、日志）；也可用 `ANI_CONFIG=/path/to/ani.json` 把配置+全部状态重定向到任意目录（便携/多实例）

## 设计哲学（学自 pi）

**核心越薄越好。** agent loop 只有一件事：流式调用模型 → 执行工具 → 循环。其他一切（人设、记忆、技能、定时任务、频道、MCP）都是 loop 外面的普通模块或工具，可改可删可扩展。

```
消息进来(QQ/TG/CLI) → Router → 会话(JSONL) → agent loop → 工具执行 → 回复
```

复杂度只长在**工具**里，不长在框架里。想加能力？加一个 `ToolDef` 或一个 skill 目录，不改核心。

## 一句话安装

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/Animnia/ani/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Animnia/ani/main/install.ps1 | iex
```

安装器会：检测/安装 Node.js ≥ 24（winget 或官方压缩包，可选 `ANI_NODE_MIRROR` 镜像，如 `https://registry.npmmirror.com/-/binary/node`）→ 拉取 ani 到 `~/.ani` → 创建 `ani` 命令并加入 PATH → 生成 `ani.json` 配置模板。装完编辑 `ani.json` 填入密钥，新开终端运行 `ani`。重新运行安装命令即可升级。

装完可以跑 `ani doctor` 自检：Node 版本、配置、DeepSeek 连通、代理、QQ/Telegram 凭据、浏览器，逐项 ✓/✗ 报告。

以后升级只需 `ani update`（有 .git 走 `git pull --ff-only`，否则 tarball 覆盖安装；`ani.json` 和 `data/` 不受影响），升级后重启 ani 生效。`ani status` 查看运行状态：daemon 是否在跑、频道与已配对主人、定时任务、记忆量——多设备运维时定位

## 手动安装

```bash
# 1. 需要 Node.js >= 24（原生运行 .ts，无需构建）
node --version   # v24+

# 2. 获取代码 + 配置
git clone https://github.com/Animnia/ani.git && cd ani
cp ani.example.json ani.json   # 填入 deepseek apiKey / 频道 token

# 3. 启动
node ani.ts            # 频道 + 定时任务 + 终端聊天
node ani.ts --no-cli   # 纯守护进程模式
```

## 配置 ani.json

```jsonc
{
  "model": "deepseek-v4-flash",       // 或 deepseek-v4-pro
  "deepseek": { "apiKey": "sk-...", "baseUrl": "https://api.deepseek.com" },
  "thinking": "enabled",              // "disabled" 更快更便宜
  "proxy": "http://127.0.0.1:6850",   // 仅用于 useProxy:true 的服务
  "channels": {
    "telegram": { "enabled": true, "token": "...", "useProxy": true,  "owners": [] },
    "qq":       { "enabled": true, "appId": "...", "clientSecret": "...", "useProxy": false, "owners": [] }
  },
  "mcpServers": {                      // 标准 MCP 配置（stdio 或 http）
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/"] }
  },
  "maxContextChars": 600000            // 会话超过此长度自动压缩（LLM 摘要）
}
```

## 安全：主人配对

ani 能完全控制你的电脑，所以**只有 owners 名单里的人能跟它说话**。
陌生人发消息时，ani 回复一个 6 位配对码（30 分钟有效），你在终端批准：

```
/approve ABC123                  # 运行中的 ani 终端里
node ani.ts approve ABC123       # 或另开一个终端（守护进程会热加载配置）
```

## 功能一览

| 能力 | 实现 |
|---|---|
| 完全掌控本机 | `shell` 工具（cmd/powershell，带超时、输出截断）+ 文件五件套（read/write/edit/list/grep） |
| 人设 | 项目根目录 `PERSONA.md`，改了下条消息生效 |
| 长期记忆 | `data/memory/MEMORY.md`（注入系统提示）+ 每日笔记 + memory_write/search/read 工具 |
| 用户资料 | `data/memory/USER.md`：主人是谁、偏好、习惯——agent 用 `user_profile` 工具主动维护，越用越懂你；注入每轮系统提示 |
| Skills | pi 式渐进披露：`skills/*/SKILL.md` 扫描进提示词，agent 按需读取；兼容 `~/.agents/skills`；`/skills on\|off <名>` 启停 |
| MCP | `mcpServers` 配置，工具以 `mcp_<server>_<tool>` 挂载；stdio + streamable-HTTP |
| 定时任务 | `cron_manage` 工具：`@every 30m` / `@daily 09:30` / 5 段 cron；结果推送到任意聊天。时刻按**服务器本地时区**解释 |
| 联网 | `web_search`（Tavily API，需 `tavily.apiKey` 或环境变量 `TAVILY_API_KEY`，免费额度 tavily.com 申请）+ `fetch_url`（HTML→文本，直连失败自动走代理） |
| 浏览器 | `browser` 工具：CDP 驱动**真实 Chrome/Edge**（有头、持久 profile、去自动化标记）——网站看到的是回访真人，基本不触发人机验证 |
| 文件收发 | 收到文件存 `data/inbox/<chat>/`；`send_file` 工具发到 QQ/TG（图片/文档） |
| Markdown 渲染 | TG 自动转 HTML 渲染（**粗体**、代码块、链接等），发送失败自动回退纯文本；QQ 需平台 markdown 权限，开 `channels.qq.markdown=true` 后同样生效（失败回退） |
| 掉线提醒 | ani 不在线期间发到 Telegram 的消息，重启后逐聊通知“错过了 N 条，请重发”并跳过旧消息（防止过期指令被延迟执行）；QQ 网关不补发离线消息，属平台限制 |
| 终端体验 | 彩色输出、思考过程（dim）与回答的流式 markdown 渲染、键入 `/` 按 Tab 预览命令 |

## CLI 命令

键入 `/` 即实时预览可用命令（Tab 补全）。

| 命令 | 作用 |
|---|---|
| `/help` | 列出全部命令 |
| `/new` | 开启全新会话（旧会话归档在 `sessions/*.archive.jsonl`，不丢） |
| `/status` | 当前会话：消息数、上下文占用、token 用量（真实 API 统计）、压缩次数 |
| `/chats` | 列出已知会话（QQ/TG/CLI） |
| `/approve <code>` | 批准配对码（仅 CLI） |
| `/model` | 查看当前模型（改 ani.json 热更新） |
| `/skills [on\|off <名>]` | 查看 / 启用 / 禁用技能（每次对话自动重扫，新 skill 即刻被发现） |
| `/show <memory\|user\|persona>` | 查看长期记忆 / 用户资料 / 人设文件的位置与内容 |
| `/quit` | 退出（仅 CLI） |

**QQ/Telegram 聊天里同样可用** `/new` `/status` `/chats` `/model` `/skills` `/show` `/help`（仅主人）。未匹配的 `/` 开头文本（如 Linux 路径）照常发给 AI。

## 常驻后台运行

一条命令管生命周期（跨平台）：

```bash
ani daemon start     # 后台启动（日志在 data/daemon.out.log）
ani daemon status    # 是否在跑
ani daemon restart   # 重启（ani update 之后用这条）
ani daemon stop      # 停止
```

同一配置同时只允许一个实例（`data/ani.lock` 持锁），重复 start 会提示已在运行的 pid。不配频道时 daemon 会启动即退出并说明原因。

## 查看与修改配置

```bash
ani config                       # 交互式向导（编号选择、即时保存、密钥脱敏显示）
ani config show                  # 打印配置（密钥打码）
ani config set model deepseek-v4-pro   # 单键修改（类型安全：拒绝未知键、自动转型）
```

所有修改只动 ani.json，未知字段（如 `_note` 注释键）原样保留；daemon 在跑时会提示 restart 生效。

## 升级

```bash
ani update           # git 安装 → git pull --ff-only；压缩包安装 → 覆盖最新 tarball
ani daemon restart   # 升级后重启生效
```

**升级永远不动你的东西**：`ani.json`、`data/`（记忆/会话/定时任务/日志）既不进 git 也不进 tarball，配置加载自动补新字段的默认值。

## 使用速查

真实会话一瞥（CLI；QQ/TG 里只有最终回复）：

```
you> 现在几点？顺便记住我喜欢深夜写代码
 ✓ shell(echo %date% %time%) → 2026/08/10 周一 6:38
 ✓ memory_write → Appended to MEMORY.md
ani> 现在是 2026年8月10日（周一）早上 6:38。
     嗯？六点半还没睡？看来这就是你说的"深夜写代码"了😂 已记下。
```

跟 ani 说话即可，例如：

```
定时任务：「每天早上 8 点给我发早报」        → 它会用 cron_manage 建任务并触发 daily-briefing skill
记忆：    「记住我咖啡豆快喝完了，周五提醒我买」 → memory_write + cron
文件：    「把 C:/reports 下最新的 pdf 发给我」  → shell + send_file
浏览器：  「打开某网站帮我看看 XXX」           → browser 工具（真实 Chrome，登录态持久）
```

**自定义 skill**：在 `skills/<名字>/SKILL.md` 写 frontmatter（name + description）+ 步骤说明，ani 启动即发现，任务匹配时自动加载。`~/.agents/skills` 下的共享 skill 也会被收编。

## 目录结构

```
ani.ts              入口
src/
  core/             agent loop、DeepSeek provider、会话、压缩、配置、网络(带代理)、日志、配对
  channels/         telegram.ts（长轮询+代理）、qq.ts（WS 网关+REST）
  tools/            shell/files/memory/web/browser/cron/messaging/mcp
skills/             技能目录（自带 daily-briefing 示例）
data/               运行时数据（gitignore）
tests/              node:test 全套测试（严格超时）
```

## 测试

```bash
npm test                    # 全部（含真实网络集成测试 + e2e）
node --test "tests/net.test.ts"      # 单跑某个
```

集成测试需要网络 + 有效的 `ani.json`（DeepSeek key、Telegram 代理、QQ 网关）。QQ/TG 的**消息收发**测试需要你真人给 bot 发条消息——没有真人协助这部分无法自动化，属预期。

## 排障速查

| 症状 | 原因 / 处置 |
|---|---|
| bot 不回消息 | 先 `ani status` 看 daemon 是否在跑；再看 `data/ani.log`（daemon 模式看你自己重定向的日志）。未配对账号只会收到配对码 |
| 配对码没收到/失效 | 码 30 分钟过期，重新发消息即可；QQ 首条是主动推送（沙箱有配额），收不到就换 TG 配对 |
| `ani is already running (pid N)` | 单实例锁。想重开：先停旧的（`taskkill /PID N /F` 或 `kill N`）；pid 已死就删 `data/ani.lock` |
| 日志反复 `Conflict: terminated by other getUpdates` | 另一个 ani 实例在轮询同一 TG token——一 token 只能一实例，停掉另一边 |
| QQ 每 ~30 分钟一次 `closed (code 4009)` 后秒级恢复 | **正常现象**：沙箱 token 30 分钟过期，QQ 踢掉旧会话，ani 自动刷新重连 |
| QQ 更频繁地掉线重连 | 另一设备用同一凭据登录了（会话互抢）。同一 bot 同时只能一个 ani |
| Telegram 一直 poll error | 代理不通：`ani doctor` 的 proxy 项会报。配 `proxy` 为 `http://127.0.0.1:<端口>` |
| DeepSeek 400 tool 相关 | 理论上不会发生（会话压缩保证工具链完整，有 fuzz 守护）；真遇到请提 issue 附 `data/ani.log` |
| 想从零重来 | 停 daemon → 删 `data/`（记忆在 `data/memory/`，要留就备份）→ 重启 |

## 已知取舍

- **纯文本**：DeepSeek 无图片输入；收到的图片存本地，agent 可用本地工具处理。
- **QQ 主动消息**受平台限制（需要近期 msg_id），cron 推送到 QQ 前请先跟 bot 说句话。
- Telegram 在国内必须代理（`useProxy: true` 已默认）；QQ/DeepSeek 直连。
- **多设备**：可以在多台设备上各装一份 ani，但**同一个 bot token 不要两端同时运行**（Telegram 长轮询会互踢 409，QQ 网关会互抢会话）。建议：一台主力机常开，其他设备用时再启动；或给不同设备配不同的 bot。
- **群聊**：群里 @ani 的回复所有成员可见。ani 有群聊隐私守卫（不在群里泄露记忆/文件/个人数据），敏感事请私聊。
