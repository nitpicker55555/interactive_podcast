"""Research and chat orchestration. Drives the Codex CLI for both modes."""

from __future__ import annotations

import json
import os
import threading
from typing import Optional

from .chat_streaming import stream_chat
from .codex_agent import CodexEvent, stream_codex
from .prompts import build_research_prompt, build_roleplay_system_prompt
from .session_store import ChatTurn, Task, _migrate_manifest_if_needed, store


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
    """After codex finishes, read manifest.json + each person's persona/overview.
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

    manifest = _migrate_manifest_if_needed(manifest)
    people = manifest.get("people") or {}
    if not isinstance(people, dict) or not people:
        return "manifest.json missing people{}"

    persona_texts: dict[str, str] = {}
    overview_texts: dict[str, str] = {}
    missing_files: list[str] = []

    for key, person in people.items():
        if not isinstance(person, dict):
            continue
        person_dir = os.path.join(task.workspace_dir, key)
        # Legacy single-person manifests didn't use subdirs.
        if person.get("_legacy_flat"):
            person_dir = task.workspace_dir

        pages = person.get("pages") or []
        if not isinstance(pages, list) or not pages:
            return f"person {key!r} missing pages[]"

        for p in pages:
            if not isinstance(p, dict):
                continue
            fname = p.get("file")
            if not fname:
                continue
            fp = os.path.join(person_dir, fname)
            if not os.path.exists(fp):
                missing_files.append(f"{key}/{fname}")

        # Avatar: null it out if file missing
        avatar = person.get("avatar")
        if avatar:
            avatar_path = os.path.join(person_dir, avatar)
            if not os.path.exists(avatar_path):
                person["avatar"] = None

        # Persona text (optional but required for role-play)
        pfile = person.get("persona_file")
        if pfile:
            try:
                with open(os.path.join(person_dir, pfile), "r", encoding="utf-8") as f:
                    persona_texts[key] = f.read()
            except OSError:
                pass

        # First page = overview
        first = pages[0].get("file") if isinstance(pages[0], dict) else None
        if first:
            try:
                with open(os.path.join(person_dir, first), "r", encoding="utf-8") as f:
                    overview_texts[key] = f.read()
            except OSError:
                pass

    if missing_files:
        return f"missing page files: {', '.join(missing_files)}"

    if "primary_key" not in manifest or manifest["primary_key"] not in people:
        # Pick the first person as primary if not set
        manifest["primary_key"] = next(iter(people.keys()))

    task.manifest = manifest
    task.persona_texts = persona_texts
    task.overview_texts = overview_texts
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
    """Stream a role-play reply from the OpenAI-compatible endpoint.

    We use direct streaming (token deltas) here instead of codex CLI
    because codex exec --json only emits one final item.completed per
    message, which prevents real character-level streaming.
    """
    task = store.get_task(turn.task_id)
    if task is None or task.manifest is None:
        turn.set_status("error", error="task not found or manifest missing")
        return

    people = (task.manifest or {}).get("people") or {}
    person_key = (turn.person_key or "").strip() or (task.manifest or {}).get("primary_key") or "guest"
    person = people.get(person_key)
    if person is None:
        turn.set_status("error", error=f"unknown person: {person_key!r}")
        return

    with task._chat_lock:  # noqa: SLF001
        system_prompt = build_roleplay_system_prompt(
            person=person,
            persona_text=task.persona_texts.get(person_key, ""),
            overview_text=task.overview_texts.get(person_key, ""),
        )
        history = list(task.chat_history.get(person_key) or [])

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history)
    messages.append({"role": "user", "content": turn.user_message})

    turn.set_status("streaming")
    turn.append({"kind": "turn", "phase": "started"})

    full_reply_parts: list[str] = []
    error: Optional[str] = None
    try:
        for ev in stream_chat(messages):
            kind = ev.get("kind")
            if kind == "delta":
                full_reply_parts.append(ev["text"])
                turn.append({"kind": "delta", "text": ev["text"]})
            elif kind == "done":
                # final concatenated text is what we'll save to history
                pass
            elif kind == "error":
                error = ev.get("text") or "unknown chat error"
                turn.append({"kind": "error", "text": error})
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        turn.append({"kind": "error", "text": error})

    full_reply = "".join(full_reply_parts).strip()
    if not full_reply and not error:
        error = "empty reply from chat endpoint"
        turn.append({"kind": "error", "text": error})

    if error and not full_reply:
        turn.set_status("error", error=error)
        return

    # Append user message + assistant reply to that person's history atomically.
    with task._chat_lock:  # noqa: SLF001
        bucket = task.chat_history.setdefault(person_key, [])
        bucket.append({"role": "user", "content": turn.user_message})
        bucket.append({"role": "assistant", "content": full_reply})

    turn.append({"kind": "message", "status": "completed", "text": full_reply})
    turn.set_status("done")


def start_chat_turn_in_background(turn: ChatTurn) -> threading.Thread:
    thread = threading.Thread(target=_run_chat_turn, args=(turn,), daemon=True)
    thread.start()
    return thread
