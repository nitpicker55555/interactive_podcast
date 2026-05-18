"""In-memory task and chat session storage with a simple pub-sub for SSE."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional


@dataclass
class Task:
    id: str
    url: str
    status: str = "pending"  # pending | researching | done | error
    thread_id: Optional[str] = None  # codex thread for research
    chat_thread_id: Optional[str] = None  # codex thread for role-play
    profile: Optional[dict] = None
    error: Optional[str] = None
    raw_last_message: Optional[str] = None
    events: list[dict] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
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
        """Yield existing events from `from_index` and block for new ones until finished."""
        idx = from_index
        while True:
            with self._cond:
                while idx >= len(self.events) and not self.is_finished():
                    self._cond.wait(timeout=10)
                # snapshot what we can deliver
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
    """One streaming chat reply in progress."""

    id: str
    task_id: str
    user_message: str
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
    """Thread-safe in-memory registry of tasks and chat turns."""

    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}
        self._chat_turns: dict[str, ChatTurn] = {}
        self._lock = threading.Lock()

    def create_task(self, url: str) -> Task:
        task = Task(id=uuid.uuid4().hex, url=url)
        with self._lock:
            self._tasks[task.id] = task
        return task

    def get_task(self, task_id: str) -> Optional[Task]:
        with self._lock:
            return self._tasks.get(task_id)

    def create_chat_turn(self, task_id: str, user_message: str) -> ChatTurn:
        turn = ChatTurn(id=uuid.uuid4().hex, task_id=task_id, user_message=user_message)
        with self._lock:
            self._chat_turns[turn.id] = turn
        return turn

    def get_chat_turn(self, turn_id: str) -> Optional[ChatTurn]:
        with self._lock:
            return self._chat_turns.get(turn_id)


# Singleton used by the Flask app.
store = Store()
