"""Research and chat orchestration. Drives the Codex CLI for both modes."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from typing import Optional

from .codex_agent import CodexEvent, stream_codex
from .prompts import build_research_prompt, build_roleplay_system_prompt
from .session_store import ChatTurn, Task, store


JSON_BLOCK_RE = re.compile(r"```json\s*(\{[\s\S]*?\})\s*```", re.MULTILINE)
JSON_LOOSE_RE = re.compile(r"(\{[\s\S]*\})")


def _classify(event: CodexEvent) -> dict:
    """Translate a CodexEvent into a UI-friendly event dict that we will buffer
    and stream over SSE.

    UI event shapes:
      - {kind: "step",     subkind: "reasoning"|"web_search"|"shell"|"other", text, query, status}
      - {kind: "message",  text}
      - {kind: "thread",   thread_id}
      - {kind: "status",   status: "researching"|"done"|"error"}
      - {kind: "error",    text}
      - {kind: "usage",    input_tokens, output_tokens, ...}
    """
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

    # web_search tool calls — show as a research step
    if item_type == "web_search":
        query = (item.get("action") or {}).get("query") or item.get("query") or ""
        status = "started" if et == "item.started" else "completed"
        return {
            "kind": "step",
            "subkind": "web_search",
            "status": status,
            "query": query,
        }

    # shell commands
    if item_type in ("shell_command", "function_call", "tool_call", "command_execution"):
        cmd = item.get("command") or item.get("name") or ""
        status = "started" if et == "item.started" else "completed"
        return {
            "kind": "step",
            "subkind": "shell",
            "status": status,
            "command": cmd if isinstance(cmd, str) else " ".join(cmd) if isinstance(cmd, list) else str(cmd),
        }

    # reasoning blocks (chain-of-thought summary)
    if item_type == "reasoning":
        if et != "item.completed":
            return {"kind": "step", "subkind": "reasoning", "status": "started"}
        text = item.get("text") or item.get("summary") or ""
        return {"kind": "step", "subkind": "reasoning", "status": "completed", "text": text}

    # agent's visible text response
    if item_type == "agent_message":
        if et != "item.completed":
            return {"kind": "message", "status": "started"}
        return {"kind": "message", "status": "completed", "text": item.get("text", "")}

    # fallback - keep raw for debugging
    return {"kind": "raw", "type": et, "item_type": item_type or "", "raw": raw}


def _extract_profile_json(last_message: str) -> Optional[dict]:
    """Extract the final JSON profile from the agent's last message."""
    if not last_message:
        return None
    m = JSON_BLOCK_RE.search(last_message)
    candidate = m.group(1) if m else None
    if not candidate:
        m2 = JSON_LOOSE_RE.search(last_message)
        candidate = m2.group(1) if m2 else None
    if not candidate:
        return None
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        # Try a more forgiving cleanup: strip trailing commas
        cleaned = re.sub(r",(\s*[}\]])", r"\1", candidate)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            return None


def run_research(task: Task) -> None:
    """Run the research codex session for a Task. Intended to be run in a thread."""
    task.set_status("researching")
    prompt = build_research_prompt(task.url)

    fd, last_msg_path = tempfile.mkstemp(prefix="codex_last_", suffix=".txt")
    os.close(fd)

    last_message_text: Optional[str] = None

    try:
        for event in stream_codex(prompt, output_last_message=last_msg_path):
            ui_event = _classify(event)
            if ui_event.get("kind") == "thread":
                task.thread_id = ui_event.get("thread_id")
            if ui_event.get("kind") == "message" and ui_event.get("status") == "completed":
                last_message_text = ui_event.get("text", "")
            task.append(ui_event)
    except Exception as exc:  # pragma: no cover - defensive
        task.set_status("error", error=f"codex stream failure: {exc!r}")
        return

    # Read last message from file as a fallback (more reliable than parsing events)
    try:
        with open(last_msg_path, "r", encoding="utf-8") as f:
            file_text = f.read().strip()
        if file_text:
            last_message_text = file_text
    except OSError:
        pass
    finally:
        try:
            os.remove(last_msg_path)
        except OSError:
            pass

    if not last_message_text:
        task.set_status("error", error="codex produced no final message")
        return

    task.raw_last_message = last_message_text
    profile = _extract_profile_json(last_message_text)
    if not profile:
        task.set_status("error", error="could not parse a JSON profile from agent output")
        return

    task.set_status("done", profile=profile)


def start_research_in_background(task: Task) -> threading.Thread:
    thread = threading.Thread(target=run_research, args=(task,), daemon=True)
    thread.start()
    return thread


def _run_chat_turn(turn: ChatTurn) -> None:
    task = store.get_task(turn.task_id)
    if task is None or task.profile is None:
        turn.set_status("error", error="task not found or profile missing")
        return

    is_first_turn = task.chat_thread_id is None
    if is_first_turn:
        system_prompt = build_roleplay_system_prompt(task.profile)
        # Mix system prompt + first user message in the very first prompt.
        prompt = f"{system_prompt}\n\n---\n\n用户对你说：\n{turn.user_message}"
        resume_id: Optional[str] = None
    else:
        prompt = turn.user_message
        resume_id = task.chat_thread_id

    turn.set_status("streaming")

    last_message_text: Optional[str] = None
    try:
        for event in stream_codex(prompt, resume_thread_id=resume_id):
            ui_event = _classify(event)
            if ui_event.get("kind") == "thread" and is_first_turn:
                task.chat_thread_id = ui_event.get("thread_id")
            if ui_event.get("kind") == "message" and ui_event.get("status") == "completed":
                last_message_text = ui_event.get("text", "")
            turn.append(ui_event)
    except Exception as exc:  # pragma: no cover - defensive
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
