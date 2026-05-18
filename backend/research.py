"""Research and chat orchestration. Drives the Codex CLI for both modes."""

from __future__ import annotations

import json
import os
import threading
from typing import Optional

from .codex_agent import CodexEvent, stream_codex
from .prompts import build_research_prompt, build_roleplay_system_prompt
from .session_store import ChatTurn, Task, store


def _classify(event: CodexEvent) -> dict:
    """Translate a CodexEvent into a UI-friendly event dict."""
    raw = event.raw
    et = event.type

    if et == "thread.started":
        return {"kind": "thread", "thread_id": raw.get("thread_id")}

    if et == "turn.started":
        return {"kind": "turn", "phase": "started"}

    if et == "turn.completed":
        return {"kind": "usage", **(raw.get("usage") or {})}

    if et == "stream.error":
        return {
            "kind": "error",
            "text": raw.get("stderr") or raw.get("error") or f"exit {raw.get('returncode')}",
        }

    if et == "stream.note":
        return {"kind": "note", "text": raw.get("text", "")}

    item = raw.get("item") or {}
    item_type = item.get("type")

    # web_search tool calls
    if item_type == "web_search":
        query = (item.get("action") or {}).get("query") or item.get("query") or ""
        status = "started" if et == "item.started" else "completed"
        return {
            "kind": "step",
            "subkind": "web_search",
            "status": status,
            "query": query,
        }

    # mcp tool calls (playwright, etc.)
    if item_type in ("mcp_tool_call", "mcp_call"):
        name = item.get("tool") or item.get("name") or ""
        server = item.get("server") or ""
        args = item.get("arguments") or {}
        status = "started" if et == "item.started" else "completed"
        # Truncate args for display
        arg_summary = ""
        if isinstance(args, dict):
            for k, v in args.items():
                arg_summary = str(v)[:120]
                break
        return {
            "kind": "step",
            "subkind": "mcp",
            "status": status,
            "tool": f"{server}.{name}" if server else name,
            "args_summary": arg_summary,
        }

    # shell / function / command calls
    if item_type in ("shell_command", "function_call", "tool_call", "command_execution"):
        cmd = item.get("command") or item.get("name") or ""
        if isinstance(cmd, list):
            cmd = " ".join(cmd)
        status = "started" if et == "item.started" else "completed"
        return {
            "kind": "step",
            "subkind": "shell",
            "status": status,
            "command": str(cmd),
        }

    # reasoning blocks
    if item_type == "reasoning":
        if et != "item.completed":
            return {"kind": "step", "subkind": "reasoning", "status": "started"}
        text = item.get("text") or item.get("summary") or ""
        return {"kind": "step", "subkind": "reasoning", "status": "completed", "text": text}

    # agent visible text
    if item_type == "agent_message":
        if et != "item.completed":
            return {"kind": "message", "status": "started"}
        return {"kind": "message", "status": "completed", "text": item.get("text", "")}

    return {"kind": "raw", "type": et, "item_type": item_type or "", "raw": raw}


def _load_artifacts(task: Task) -> Optional[str]:
    """After codex finishes, read manifest.json + persona/overview files.
    Returns None on success, error string on failure.
    """
    manifest_path = os.path.join(task.workspace_dir, "manifest.json")
    if not os.path.exists(manifest_path):
        return "agent did not produce manifest.json"

    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        return f"manifest.json invalid: {exc}"

    if not isinstance(manifest, dict):
        return "manifest.json must be a JSON object"

    pages = manifest.get("pages") or []
    if not isinstance(pages, list) or not pages:
        return "manifest.json missing pages[]"

    # Verify each page file exists
    missing = []
    for p in pages:
        if not isinstance(p, dict):
            continue
        fname = p.get("file")
        if not fname:
            continue
        fp = os.path.join(task.workspace_dir, fname)
        if not os.path.exists(fp):
            missing.append(fname)
    if missing:
        return f"missing page files: {', '.join(missing)}"

    # Load persona + overview for role-play context
    persona_file = manifest.get("persona_file")
    persona_text = ""
    if persona_file:
        try:
            with open(os.path.join(task.workspace_dir, persona_file), "r", encoding="utf-8") as f:
                persona_text = f.read()
        except OSError:
            pass  # non-fatal

    overview_text = ""
    if pages:
        first_page = pages[0].get("file") if isinstance(pages[0], dict) else None
        if first_page:
            try:
                with open(os.path.join(task.workspace_dir, first_page), "r", encoding="utf-8") as f:
                    overview_text = f.read()
            except OSError:
                pass

    # Avatar: verify it exists if mentioned
    avatar = manifest.get("avatar")
    if avatar:
        avatar_path = os.path.join(task.workspace_dir, avatar)
        if not os.path.exists(avatar_path):
            manifest["avatar"] = None  # agent referenced a file but didn't create it

    task.manifest = manifest
    task.persona_text = persona_text
    task.overview_text = overview_text
    return None


def run_research(task: Task) -> None:
    task.set_status("researching")
    prompt = build_research_prompt(task.url)

    try:
        for event in stream_codex(prompt, cwd=task.workspace_dir):
            ui_event = _classify(event)
            if ui_event.get("kind") == "thread":
                task.thread_id = ui_event.get("thread_id")
            task.append(ui_event)
    except Exception as exc:  # pragma: no cover
        task.set_status("error", error=f"codex stream failure: {exc!r}")
        return

    err = _load_artifacts(task)
    if err:
        task.set_status("error", error=err)
        return

    task.set_status("done")


def start_research_in_background(task: Task) -> threading.Thread:
    thread = threading.Thread(target=run_research, args=(task,), daemon=True)
    thread.start()
    return thread


def _run_chat_turn(turn: ChatTurn) -> None:
    task = store.get_task(turn.task_id)
    if task is None or task.manifest is None:
        turn.set_status("error", error="task not found or manifest missing")
        return

    is_first_turn = task.chat_thread_id is None
    if is_first_turn:
        system_prompt = build_roleplay_system_prompt(
            manifest=task.manifest,
            persona_text=task.persona_text or "",
            overview_text=task.overview_text or "",
        )
        prompt = f"{system_prompt}\n\n---\n\n用户对你说：\n{turn.user_message}"
        resume_id: Optional[str] = None
    else:
        prompt = turn.user_message
        resume_id = task.chat_thread_id

    turn.set_status("streaming")

    last_message_text: Optional[str] = None
    try:
        for event in stream_codex(prompt, resume_thread_id=resume_id, cwd=task.workspace_dir):
            ui_event = _classify(event)
            if ui_event.get("kind") == "thread" and is_first_turn:
                task.chat_thread_id = ui_event.get("thread_id")
            if ui_event.get("kind") == "message" and ui_event.get("status") == "completed":
                last_message_text = ui_event.get("text", "")
            turn.append(ui_event)
    except Exception as exc:  # pragma: no cover
        turn.set_status("error", error=f"codex stream failure: {exc!r}")
        return

    if last_message_text is None:
        turn.set_status("error", error="codex returned no reply")
        return

    turn.set_status("done")


def start_chat_turn_in_background(turn: ChatTurn) -> threading.Thread:
    thread = threading.Thread(target=_run_chat_turn, args=(turn,), daemon=True)
    thread.start()
    return thread
