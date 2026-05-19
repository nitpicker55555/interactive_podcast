"""In-memory task and chat session storage with a simple pub-sub for SSE."""

from __future__ import annotations

import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional


def _resolve_data_root() -> str:
    """Pick a session root OUTSIDE this app's git repo, so codex doesn't get
    confused and treat the parent git repo as its workspace.
    """
    override = os.environ.get("PODCAST_DATA_ROOT")
    if override:
        return override
    return os.path.expanduser("~/.local/state/interactive_podcast")


DATA_ROOT = _resolve_data_root()
SESSIONS_DIR = os.path.join(DATA_ROOT, "sessions")
os.makedirs(SESSIONS_DIR, exist_ok=True)


@dataclass
class Task:
    id: str
    url: str
    status: str = "pending"  # pending | researching | done | error
    thread_id: Optional[str] = None  # codex thread for research
    chat_thread_id: Optional[str] = None  # legacy, unused after openai chat
    # Per-person chat history: {"guest": [...], "host": [...]}
    chat_history: dict[str, list[dict]] = field(default_factory=dict)
    # Per-person persona + overview text loaded from disk, keyed by person_key.
    persona_texts: dict[str, str] = field(default_factory=dict)
    overview_texts: dict[str, str] = field(default_factory=dict)
    manifest: Optional[dict] = None
    error: Optional[str] = None
    events: list[dict] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    _chat_lock: threading.Lock = field(default_factory=threading.Lock)
    _cond: threading.Condition = field(default_factory=threading.Condition)

    @property
    def workspace_dir(self) -> str:
        return os.path.join(SESSIONS_DIR, self.id)

    def append(self, event: dict) -> None:
        with self._cond:
            self.events.append(event)
            self._cond.notify_all()

    def set_status(self, status: str, **kwargs: Any) -> None:
        with self._cond:
            self.status = status
            for k, v in kwargs.items():
                setattr(self, k, v)
            self._cond.notify_all()

    def is_finished(self) -> bool:
        return self.status in ("done", "error")

    def iter_events(self, from_index: int = 0) -> Iterator[dict]:
        idx = from_index
        while True:
            with self._cond:
                while idx >= len(self.events) and not self.is_finished():
                    self._cond.wait(timeout=10)
                if idx < len(self.events):
                    pending = self.events[idx:]
                    idx = len(self.events)
                else:
                    pending = []
                finished = self.is_finished()
            for ev in pending:
                yield ev
            if finished and idx >= len(self.events):
                return


@dataclass
class ChatTurn:
    id: str
    task_id: str
    user_message: str
    person_key: str = "guest"  # which person the user is talking to
    status: str = "pending"  # pending | streaming | done | error
    error: Optional[str] = None
    events: list[dict] = field(default_factory=list)
    _cond: threading.Condition = field(default_factory=threading.Condition)

    def append(self, event: dict) -> None:
        with self._cond:
            self.events.append(event)
            self._cond.notify_all()

    def set_status(self, status: str, **kwargs: Any) -> None:
        with self._cond:
            self.status = status
            for k, v in kwargs.items():
                setattr(self, k, v)
            self._cond.notify_all()

    def is_finished(self) -> bool:
        return self.status in ("done", "error")

    def iter_events(self, from_index: int = 0) -> Iterator[dict]:
        idx = from_index
        while True:
            with self._cond:
                while idx >= len(self.events) and not self.is_finished():
                    self._cond.wait(timeout=10)
                if idx < len(self.events):
                    pending = self.events[idx:]
                    idx = len(self.events)
                else:
                    pending = []
                finished = self.is_finished()
            for ev in pending:
                yield ev
            if finished and idx >= len(self.events):
                return


class Store:
    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}
        self._chat_turns: dict[str, ChatTurn] = {}
        self._lock = threading.Lock()

    def create_task(self, url: str) -> Task:
        task = Task(id=uuid.uuid4().hex, url=url)
        os.makedirs(task.workspace_dir, exist_ok=True)
        with self._lock:
            self._tasks[task.id] = task
        return task

    def get_task(self, task_id: str) -> Optional[Task]:
        with self._lock:
            task = self._tasks.get(task_id)
        if task is not None:
            return task
        # Try to reconstruct from disk so completed tasks survive a Flask
        # restart (chat picks up where it left off — except chat history,
        # which is in-memory only by design).
        return self._maybe_load_from_disk(task_id)

    def _maybe_load_from_disk(self, task_id: str) -> Optional[Task]:
        if not all(c.isalnum() for c in task_id):
            return None
        workspace = os.path.join(SESSIONS_DIR, task_id)
        manifest_path = os.path.join(workspace, "manifest.json")
        if not os.path.exists(manifest_path):
            return None
        try:
            import json
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except (OSError, ValueError):
            return None

        manifest = _migrate_manifest_if_needed(manifest)
        persona_texts: dict[str, str] = {}
        overview_texts: dict[str, str] = {}
        people = (manifest or {}).get("people") or {}
        for key, person in people.items():
            person_dir = os.path.join(workspace, key)
            pfile = person.get("persona_file")
            if pfile:
                try:
                    with open(os.path.join(person_dir, pfile), "r", encoding="utf-8") as f:
                        persona_texts[key] = f.read()
                except OSError:
                    pass
            pages = person.get("pages") or []
            if pages and isinstance(pages[0], dict) and pages[0].get("file"):
                try:
                    with open(os.path.join(person_dir, pages[0]["file"]), "r", encoding="utf-8") as f:
                        overview_texts[key] = f.read()
                except OSError:
                    pass

        task = Task(
            id=task_id,
            url=(manifest.get("podcast_episode") or {}).get("url") or "",
            status="done",
            manifest=manifest,
            persona_texts=persona_texts,
            overview_texts=overview_texts,
        )
        with self._lock:
            self._tasks.setdefault(task.id, task)
            return self._tasks[task.id]

    def create_chat_turn(
        self,
        task_id: str,
        user_message: str,
        person_key: str = "guest",
    ) -> ChatTurn:
        turn = ChatTurn(
            id=uuid.uuid4().hex,
            task_id=task_id,
            user_message=user_message,
            person_key=person_key,
        )
        with self._lock:
            self._chat_turns[turn.id] = turn
        return turn

    def get_chat_turn(self, turn_id: str) -> Optional[ChatTurn]:
        with self._lock:
            return self._chat_turns.get(turn_id)


def _migrate_manifest_if_needed(manifest: dict) -> dict:
    """Convert legacy single-guest manifests to the new multi-person shape.

    Legacy shape (only guest, flat):
        {"guest": {...}, "avatar": "...", "social": {...}, "pages": [...],
         "persona_file": "...", "podcast_episode": {...}}

    New shape:
        {"primary_key": "guest", "people": {"guest": {...}, "host": {...}},
         "podcast_episode": {...}}

    Files in legacy layout were flat (avatar.jpeg, 01-overview.md). We mark
    the migrated guest with `_legacy_flat: true` so the file resolver falls
    back to the workspace root for that person.
    """
    if not isinstance(manifest, dict):
        return manifest
    if "people" in manifest and isinstance(manifest["people"], dict):
        return manifest

    if "guest" in manifest and isinstance(manifest["guest"], dict):
        guest = {
            "role": "guest",
            **manifest["guest"],
            "avatar": manifest.get("avatar"),
            "social": manifest.get("social") or {},
            "pages": manifest.get("pages") or [],
            "persona_file": manifest.get("persona_file"),
            "_legacy_flat": True,
        }
        return {
            "primary_key": "guest",
            "people": {"guest": guest},
            "podcast_episode": manifest.get("podcast_episode") or {},
        }
    return manifest


store = Store()
