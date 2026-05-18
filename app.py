"""Flask entry point for the interactive_podcast app."""

from __future__ import annotations

import json
import mimetypes
import os
from typing import Iterator

from flask import Flask, Response, jsonify, render_template, request, send_from_directory, stream_with_context, abort

from backend.research import (
    start_chat_turn_in_background,
    start_research_in_background,
)
from backend.session_store import store


app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["JSON_AS_ASCII"] = False


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _safe_join(base: str, name: str) -> str:
    """Prevent path traversal: ensure resolved path stays under base."""
    base = os.path.abspath(base)
    full = os.path.abspath(os.path.join(base, name))
    if not (full == base or full.startswith(base + os.sep)):
        abort(400)
    return full


@app.route("/")
def index() -> str:
    return render_template("index.html")


@app.post("/api/research")
def api_research():
    body = request.get_json(silent=True) or {}
    url = (body.get("url") or "").strip()
    if not url:
        return jsonify({"error": "url is required"}), 400
    task = store.create_task(url)
    start_research_in_background(task)
    return jsonify({"task_id": task.id})


@app.get("/api/stream/<task_id>")
def api_stream(task_id: str):
    task = store.get_task(task_id)
    if task is None:
        return jsonify({"error": "task not found"}), 404

    @stream_with_context
    def gen() -> Iterator[str]:
        yield _sse({"kind": "snapshot", "status": task.status, "url": task.url})
        for ev in task.iter_events():
            yield _sse(ev)
        yield _sse(
            {
                "kind": "final",
                "status": task.status,
                "error": task.error,
                "has_manifest": task.manifest is not None,
            }
        )

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@app.get("/api/result/<task_id>")
def api_result(task_id: str):
    task = store.get_task(task_id)
    if task is None:
        return jsonify({"error": "task not found"}), 404
    return jsonify(
        {
            "task_id": task.id,
            "url": task.url,
            "status": task.status,
            "error": task.error,
            "manifest": task.manifest,
        }
    )


@app.get("/api/page/<task_id>/<path:filename>")
def api_page(task_id: str, filename: str):
    """Return raw markdown for a page."""
    task = store.get_task(task_id)
    if task is None:
        return jsonify({"error": "task not found"}), 404
    full = _safe_join(task.workspace_dir, filename)
    if not os.path.exists(full):
        return jsonify({"error": "page not found"}), 404
    # Only allow .md files via this endpoint
    if not full.endswith(".md"):
        return jsonify({"error": "not a markdown file"}), 400
    with open(full, "r", encoding="utf-8") as f:
        text = f.read()
    return Response(text, mimetype="text/markdown; charset=utf-8")


@app.get("/api/asset/<task_id>/<path:filename>")
def api_asset(task_id: str, filename: str):
    """Serve binary assets (e.g. the avatar image) from the task workspace."""
    task = store.get_task(task_id)
    if task is None:
        return jsonify({"error": "task not found"}), 404
    full = _safe_join(task.workspace_dir, filename)
    if not os.path.exists(full):
        return jsonify({"error": "asset not found"}), 404
    # Don't expose .md or .json via this endpoint — those have dedicated routes.
    if full.endswith(".md") or full.endswith(".json"):
        return jsonify({"error": "use /api/page or /api/result"}), 400
    mt, _ = mimetypes.guess_type(full)
    return send_from_directory(task.workspace_dir, filename, mimetype=mt or "application/octet-stream")


@app.post("/api/chat/<task_id>")
def api_chat(task_id: str):
    task = store.get_task(task_id)
    if task is None:
        return jsonify({"error": "task not found"}), 404
    if task.status != "done" or task.manifest is None:
        return jsonify({"error": "task is not ready for chat"}), 400

    body = request.get_json(silent=True) or {}
    message = (body.get("message") or "").strip()
    if not message:
        return jsonify({"error": "message is required"}), 400

    turn = store.create_chat_turn(task.id, message)
    start_chat_turn_in_background(turn)
    return jsonify({"turn_id": turn.id})


@app.get("/api/chat/stream/<turn_id>")
def api_chat_stream(turn_id: str):
    turn = store.get_chat_turn(turn_id)
    if turn is None:
        return jsonify({"error": "turn not found"}), 404

    @stream_with_context
    def gen() -> Iterator[str]:
        yield _sse({"kind": "snapshot", "status": turn.status})
        for ev in turn.iter_events():
            yield _sse(ev)
        yield _sse({"kind": "final", "status": turn.status, "error": turn.error})

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@app.get("/api/health")
def api_health():
    return jsonify({"ok": True})


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5050"))
    app.run(host=host, port=port, debug=True, threaded=True, use_reloader=False)
