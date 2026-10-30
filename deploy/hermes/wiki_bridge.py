"""Private wiki inference endpoint. Reuses Hermes Claude OAuth; exposes no agent tools."""
import hmac
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.environ.get("HERMES_AGENT_PATH", "/home/chaeyn/.hermes/hermes-agent"))
os.environ.setdefault("HERMES_HOME", os.path.expanduser("~/.hermes"))
import hermes_bootstrap  # noqa: F401  Hermes runtime site-packages (anthropic SDK)
from hermes_cli.env_loader import load_hermes_dotenv
from agent.anthropic_adapter import build_anthropic_client, build_anthropic_kwargs, create_anthropic_message
from agent.anthropic_credentials import anthropic_route_is_oauth, resolve_anthropic_token

load_hermes_dotenv()
MODEL = os.environ.get("HERMES_WIKI_MODEL", "claude-opus-5-5")
BASE_URL = "https://api.anthropic.com"
EFFORTS = {"none", "low", "medium", "high", "xhigh", "max"}
KEY = os.environ["HERMES_WIKI_KEY"]
if len(KEY) < 32:
    raise ValueError("HERMES_WIKI_KEY requires at least 32 characters")
LOCK = threading.BoundedSemaphore(2)


def answer(body):
    token = resolve_anthropic_token(model=MODEL)
    if not token:
        raise ValueError("no_claude_credentials")
    effort = body.get("reasoning", "max")
    client = build_anthropic_client(token, BASE_URL, timeout=150)
    timer = threading.Timer(170, client.close)
    timer.daemon = True
    timer.start()
    try:
        # No terminal, filesystem, memory, MCP tools, or persistent conversation.
        kwargs = build_anthropic_kwargs(
            MODEL, [{"role": "system", "content": body["instructions"]}, {"role": "user", "content": body["input"]}],
            None, None, {"enabled": False} if effort == "none" else {"effort": effort},
            is_oauth=anthropic_route_is_oauth(BASE_URL, token, provider="anthropic"), base_url=BASE_URL,
        )
        response = create_anthropic_message(client, kwargs)
        if response.stop_reason not in ("end_turn", "stop_sequence"):
            raise ValueError("incomplete_answer")
        text = "".join(block.text for block in response.content if block.type == "text")
        if len(text) > 60_000:
            raise ValueError("answer_too_long")
        if not text.strip():
            raise ValueError("empty_answer")
        usage = response.usage.model_dump() if response.usage else None
        tier = getattr(response.usage, "service_tier", None)
        print(json.dumps({"event": "wiki_answer_completed", "model": response.model,
                          "reasoning": effort, "service_tier": tier, "usage": usage}), flush=True)
        return {"answer": text, "model": response.model, "reasoning": effort, "usage": usage, "service_tier": tier}
    finally:
        timer.cancel()
        client.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        self.reply(200 if self.path == "/healthz" else 404, {"service": "hermes-wiki", "model": MODEL})

    def do_POST(self):
        if self.path != "/v1/wiki/answer":
            return self.reply(404, {})
        if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + KEY):
            return self.reply(401, {"error": "unauthorized"})
        self.connection.settimeout(10)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 150_000:
                return self.reply(413, {})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict) or not all(isinstance(body.get(k), str) for k in ("instructions", "input")):
                return self.reply(400, {})
            if body.get("reasoning", "max") not in EFFORTS:
                return self.reply(400, {})
        except (ValueError, TimeoutError):
            return self.reply(400, {})
        if not LOCK.acquire(blocking=False):
            return self.reply(429, {"error": "busy"})
        try:
            self.reply(200, answer(body))
        except Exception as error:
            status = getattr(error, "status_code", None)
            print(json.dumps({"event": "wiki_answer_failed", "type": type(error).__name__, "status": status}), flush=True)
            self.reply(429 if status == 429 else 502, {"error": "inference_failed"})
        finally:
            LOCK.release()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("HERMES_WIKI_PORT", "8647"))), Handler).serve_forever()
