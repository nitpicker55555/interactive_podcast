# Interactive Podcast

输入一个播客链接（如小宇宙 episode 链接），让 Codex agent 自动调研嘉宾的身份、论文、新闻、社交媒体与照片，全程在前端流式呈现，最后还可以以「该嘉宾」的口吻进行 role-play 对话。

## 架构

- **后端**：Flask + SSE（Server-Sent Events）流式推送 codex 输出
- **Agent**：通过 `codex exec --json --search` 调用本机 Codex CLI；URL 直接交给 agent，由 agent 自己使用 `web_search` / shell 工具完成所有调研
- **持久会话**：研究完成后用 `codex exec resume <thread_id>` 进入 role-play 对话
- **前端**：单页 HTML/CSS/JS，无渐变，黑白 + 一个点缀色

## 依赖

- Python 3.10+
- 已登录的 Codex CLI（`~/.codex/auth.json` 存在）
- `codex` 命令可在 PATH 中找到

## 运行

```bash
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env  # 然后填上你的 OpenAI 兼容端点 key
.venv/bin/python app.py
```

打开 http://127.0.0.1:5050

> 在 macOS 上如果用 Python 3.14 安装 pip 报 `pyexpat` 错误，切换到 3.13（`brew install python@3.13`）即可。

## 为什么 research 用 codex、chat 用 OpenAI API

`codex exec --json` 当前只输出 item-level 完成事件（`item.completed`），没有 token-level deltas。所以：

- **research 阶段**用 codex，因为它的核心价值是工具（web_search、playwright MCP、shell），item 级的"分段流式"对调研足够自然。
- **chat 阶段**改用 OpenAI 兼容 API 直接 streaming（`stream=True`），拿到 token-by-token delta，真正逐字到达浏览器。这条路需要在 `.env` 里配 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`。

`fast 模式` 仍然有效：所有 codex 调用都带 `-c service_tier=fast`，按 codex 文档这会把请求里的 service_tier 设为 `priority`。

## 模型设置

- 模型：`gpt-5.5`
- reasoning effort：`medium`
- service tier：`fast`
- 启用 `--search` 使 codex 可直接调用 web search 工具
