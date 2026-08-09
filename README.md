# ani

一个极简的个人 Agent：**DeepSeek 大脑，QQ/Telegram 身体，pi 的灵魂**。

- 零 npm 依赖 —— 只用 Node.js 24+ 内置能力（原生 TS、fetch、WebSocket、readline）
- 单一可执行入口：`node ani.ts`
- 全部数据在项目内：`data/`（会话、记忆、定时任务、收件箱、日志）

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
| Skills | pi 式渐进披露：`skills/*/SKILL.md` 扫描进提示词，agent 按需读取；兼容 `~/.agents/skills` |
| MCP | `mcpServers` 配置，工具以 `mcp_<server>_<tool>` 挂载；stdio + streamable-HTTP |
| 定时任务 | `cron_manage` 工具：`@every 30m` / `@daily 09:30` / 5 段 cron；结果推送到任意聊天 |
| 联网 | `web_search`（Bing 直连 / DuckDuckGo 走代理）+ `fetch_url`（HTML→文本，直连失败自动走代理） |
| 浏览器 | `browser` 工具：CDP 驱动**真实 Chrome/Edge**（有头、持久 profile、去自动化标记）——网站看到的是回访真人，基本不触发人机验证 |
| 文件收发 | 收到文件存 `data/inbox/<chat>/`；`send_file` 工具发到 QQ/TG（图片/文档） |

## CLI 命令

```
/help /reset /approve CODE /chats /model /quit
```

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

## 已知取舍

- **纯文本**：DeepSeek 无图片输入；收到的图片存本地，agent 可用本地工具处理。
- **QQ 主动消息**受平台限制（需要近期 msg_id），cron 推送到 QQ 前请先跟 bot 说句话。
- Telegram 在国内必须代理（`useProxy: true` 已默认）；QQ/DeepSeek 直连。
