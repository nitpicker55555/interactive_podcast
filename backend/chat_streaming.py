"""OpenAI-compatible streaming chat client used for role-play.

We use direct API streaming (token-level deltas) here because codex CLI
exec --json only emits item.completed events, which makes "live" UX
impossible. Research keeps using codex (for its tools); chat goes
straight to a streaming OpenAI-compatible endpoint.
"""

from __future__ import annotations

import os
from typing import Iterator, Optional

from dotenv import load_dotenv
from openai import OpenAI


# Load .env once at import time. override=True so the project's .env wins over
# any pre-existing OPENAI_API_KEY in the shell environment (we want this app to
# use its dedicated proxy endpoint, not whatever key the user has globally).
_ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
load_dotenv(_ENV_PATH, override=True)


_client: Optional[OpenAI] = None


def get_client() -> OpenAI:
    global _client
    if _client is None:
        api_key = os.environ.get("OPENAI_API_KEY")
        base_url = os.environ.get("OPENAI_BASE_URL")
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY not set. Put it in .env (see .env.example) or export it."
            )
        _client = OpenAI(api_key=api_key, base_url=base_url)
    return _client


def get_default_model() -> str:
    return os.environ.get("OPENAI_CHAT_MODEL", "gpt-4.1")


def stream_chat(
    messages: list[dict],
    *,
    model: Optional[str] = None,
    temperature: float = 0.85,
) -> Iterator[dict]:
    """Stream a chat completion. Yields dicts:

      {"kind": "delta", "text": "...partial..."}
      {"kind": "done",  "text": "...full accumulated..."}
      {"kind": "error", "text": "...message..."}
    """
    client = get_client()
    mdl = model or get_default_model()

    accumulated: list[str] = []
    try:
        stream = client.chat.completions.create(
            model=mdl,
            messages=messages,
            temperature=temperature,
            stream=True,
        )
        for chunk in stream:
            try:
                choice = chunk.choices[0]
            except (IndexError, AttributeError):
                continue
            delta = getattr(choice, "delta", None)
            if delta is None:
                continue
            piece = getattr(delta, "content", None) or ""
            if piece:
                accumulated.append(piece)
                yield {"kind": "delta", "text": piece}
        full = "".join(accumulated)
        yield {"kind": "done", "text": full}
    except Exception as exc:  # noqa: BLE001
        yield {"kind": "error", "text": f"{type(exc).__name__}: {exc}"}
