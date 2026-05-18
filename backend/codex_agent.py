"""Wrap the Codex CLI as a streaming, JSON-event source.

The wrapper spawns `codex exec --json` and yields parsed events to the caller.
It supports starting a new thread and resuming an existing one.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from dataclasses import dataclass
from queue import Queue
from typing import Iterator, Optional


CODEX_BIN = os.environ.get("CODEX_BIN", "codex")


@dataclass
class CodexEvent:
    raw: dict

    @property
    def type(self) -> str:
        return self.raw.get("type", "")

    @property
    def thread_id(self) -> Optional[str]:
        return self.raw.get("thread_id")

    @property
    def item(self) -> dict:
        return self.raw.get("item") or {}

    @property
    def item_type(self) -> str:
        return self.item.get("type", "")

    @property
    def text(self) -> str:
        return self.item.get("text", "")


def _base_args(workspace_dir: Optional[str]) -> list[str]:
    args = [
        CODEX_BIN,
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "-c", "tools.web_search=true",
        "-c", "service_tier=fast",
        "-c", "model_reasoning_effort=medium",
        "-m", "gpt-5.5",
    ]
    if workspace_dir:
        # `-C` makes the workspace root explicit (codex uses it for relative paths
        # and confirms it's a "trusted" directory).
        args += ["-C", workspace_dir]
    return args


def stream_codex(
    prompt: str,
    *,
    resume_thread_id: Optional[str] = None,
    cwd: Optional[str] = None,
    output_last_message: Optional[str] = None,
) -> Iterator[CodexEvent]:
    """Run codex and yield parsed JSON events line-by-line.

    Args:
        prompt: The user prompt.
        resume_thread_id: If provided, resume an existing thread instead of starting fresh.
        cwd: Working directory. Also passed as -C so codex treats it as the workspace.
        output_last_message: If provided, codex writes the final agent message to this file.
    """
    args = _base_args(cwd)
    if resume_thread_id:
        # subcommand position: codex exec [flags] resume <session_id> <prompt>
        args += ["resume", resume_thread_id]
    if output_last_message:
        args += ["--output-last-message", output_last_message]
    args.append(prompt)

    env = os.environ.copy()
    env.setdefault("CODEX_HOME", os.path.expanduser("~/.codex"))

    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env=env,
        bufsize=1,
        text=True,
    )

    stderr_lines: list[str] = []

    def _drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_lines.append(line.rstrip())

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                yield CodexEvent({"type": "stream.note", "text": line})
                continue
            yield CodexEvent(raw)
    finally:
        proc.wait()
        stderr_thread.join(timeout=1)
        if proc.returncode not in (0, None):
            err = "\n".join(stderr_lines).strip()
            yield CodexEvent(
                {"type": "stream.error", "returncode": proc.returncode, "stderr": err}
            )


def stream_codex_to_queue(
    prompt: str,
    queue: Queue,
    *,
    resume_thread_id: Optional[str] = None,
    cwd: Optional[str] = None,
    output_last_message: Optional[str] = None,
) -> None:
    try:
        for event in stream_codex(
            prompt,
            resume_thread_id=resume_thread_id,
            cwd=cwd,
            output_last_message=output_last_message,
        ):
            queue.put(event)
    except Exception as exc:  # pragma: no cover
        queue.put(CodexEvent({"type": "stream.error", "error": str(exc)}))
    finally:
        queue.put(None)
