"""Internal multilingual embeddings. Markdown never leaves this host."""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import torch
from sentence_transformers import SentenceTransformer

MODEL_ID = "intfloat/multilingual-e5-small"
REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
SCHEMA = "e5-small-480-overlap48-v1"
torch.set_num_threads(int(os.environ.get("EMBED_THREADS", "2")))
model = SentenceTransformer(MODEL_ID, revision=REVISION, device="cpu", trust_remote_code=False,
                            model_kwargs={"use_safetensors": True})
model.max_seq_length = 512
tokenizer = model.tokenizer
lock = threading.Lock()


def pieces(text, mode):
    prefix = "query: " if mode == "query" else "passage: "
    offsets = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)["offset_mapping"]
    if not offsets:
        return [(prefix, 0, len(text))]
    if mode == "query" and len(offsets) > 480:
        raise ValueError("query_too_long")
    result = []
    start = 0
    while start < len(offsets):
        end = min(start + 480, len(offsets))
        left = 0 if start == 0 else offsets[start][0]
        right = len(text) if end == len(offsets) else offsets[end][0]
        chunk = prefix + text[left:right]
        # Prefix, special tokens and round-trip tokenization count toward the model limit.
        while len(tokenizer(chunk, add_special_tokens=True)["input_ids"]) > 512 and end > start + 1:
            end -= 1
            right = offsets[end][0]
            chunk = prefix + text[left:right]
        if len(tokenizer(chunk, add_special_tokens=True)["input_ids"]) > 512:
            raise ValueError("chunk_limit")
        result.append((chunk, left, right))
        if end == len(offsets):
            break
        start = max(start + 1, end - 48)
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, code, body):
        payload = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {})
        self.reply(200, {"model": MODEL_ID, "revision": REVISION, "schema": SCHEMA, "dimensions": 384})

    def do_POST(self):
        if self.path != "/embed":
            return self.reply(404, {})
        self.connection.settimeout(15)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 500_000:
                return self.reply(413, {})
            data = json.loads(self.rfile.read(length))
            texts, mode = data.get("texts"), data.get("mode")
            if mode not in ("query", "passage") or not isinstance(texts, list) or not 1 <= len(texts) <= 16:
                return self.reply(400, {})
            if any(not isinstance(text, str) or len(text) > 100_000 for text in texts):
                return self.reply(400, {})
            prepared = [(i, part, chunk, left, right) for i, text in enumerate(texts)
                        for part, (chunk, left, right) in enumerate(pieces(text, mode))]
            if len(prepared) > 512:
                return self.reply(413, {})
        except (ValueError, TypeError, TimeoutError):
            return self.reply(400, {"error": "invalid_input"})
        if not lock.acquire(blocking=False):
            return self.reply(429, {"error": "busy"})
        try:
            vectors = model.encode([item[2] for item in prepared], normalize_embeddings=True,
                                   batch_size=16, show_progress_bar=False).tolist()
            self.reply(200, {"model": MODEL_ID, "revision": REVISION, "schema": SCHEMA,
                            "vectors": [{"index": item[0], "part": item[1], "start": item[3], "end": item[4], "vector": vector}
                                        for item, vector in zip(prepared, vectors)]})
        except Exception as error:
            print(json.dumps({"event": "embedding_failed", "type": type(error).__name__}), flush=True)
            self.reply(500, {"error": "embedding_failed"})
        finally:
            lock.release()


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
