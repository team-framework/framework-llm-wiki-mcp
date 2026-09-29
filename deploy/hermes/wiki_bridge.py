"""Private wiki inference endpoint. Reuses Hermes OAuth; exposes no agent tools."""
import hmac
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.environ.get("HERMES_AGENT_PATH", "/home/chaeyn/.hermes/hermes-agent"))
from hermes_cli.auth import resolve_codex_runtime_credentials
from agent.auxiliary_client import _codex_cloudflare_headers
from openai import OpenAI

MODEL = "gpt-6-luna"
EFFORTS = {"none", "low", "medium", "high", "xhigh", "max"}
KEY = os.environ["HERMES_WIKI_KEY"]
if len(KEY) < 32:
    raise ValueError("HERMES_WIKI_KEY requires at least 32 characters")
LOCK = threading.BoundedSemaphore(2)


def answer(body):
    credentials = resolve_codex_runtime_credentials()
    with OpenAI(api_key=credentials["api_key"], base_url=credentials["base_url"],
                default_headers=_codex_cloudflare_headers(credentials["api_key"]),
                timeout=150, max_retries=0) as client:
        timer = threading.Timer(170, client.close)
        timer.daemon = True
        timer.start()
        try:
            parts = []
            # No terminal, filesystem, memory, MCP tools, or persistent conversation.
            with client.responses.stream(
                model=MODEL, instructions=body["instructions"],
                input=[{"role": "user", "content": body["input"]}],
                reasoning={"effort": body.get("reasoning", "low")}, store=False,
            ) as stream:
                for event in stream:
                    if event.type == "response.output_text.delta":
                        parts.append(event.delta)
                        if sum(map(len, parts)) > 60_000:
                            raise ValueError("answer_too_long")
                response = stream.get_final_response()
            if response.status != "completed":
                raise ValueError("incomplete_answer")
            text = "".join(parts) or response.output_text
            if not text.strip():
                raise ValueError("empty_answer")
            usage = response.usage.model_dump() if response.usage else None
            print(json.dumps({"event": "wiki_answer_completed", "model": response.model,
                              "reasoning": body.get("reasoning", "low"),
                              "service_tier": response.service_tier, "usage": usage}), flush=True)
            return {"answer": text, "model": response.model, "reasoning": body.get("reasoning", "low"), "usage": usage}
        finally:
            timer.cancel()


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
            if body.get("reasoning", "low") not in EFFORTS:
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
