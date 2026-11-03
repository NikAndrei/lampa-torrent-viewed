"""Mock TorrServer MatriX: /settings, /torrents, /viewed, /stream, /echo. Port 8090."""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HASH = "aaaabbbbccccddddeeeeffff0000111122223333"
FILES = [{"id": i, "path": "Breaking.Bad.S01.1080p/Breaking.Bad.S01E0%d.1080p.mkv" % i, "length": 1500000000} for i in range(1, 6)]
HASH2 = "0123456789abcdef0123456789abcdef01234567"
VIEWED = {(HASH, 1), (HASH, 2), (HASH2, 1), (HASH2, 2), (HASH2, 3)}
LAMPA_DATA = json.dumps({"lampa": True, "movie": {"id": 1396, "name": "Breaking Bad"}})


def b32(h):
    import base64
    return base64.b32encode(bytes.fromhex(h)).decode()


# Ответ Jackett: две раздачи, которые есть в TorrServer (hex и base32 magnet), и одна чужая
JACKETT = {"Results": [
    {"Title": "Breaking Bad S01 1080p", "Tracker": "mock", "Size": 7500000000, "PublishDate": "2024-01-01T00:00:00", "Seeders": 50, "Peers": 5,
     "MagnetUri": "magnet:?xt=urn:btih:" + HASH.upper() + "&dn=bb"},
    {"Title": "Breaking Bad S01 720p", "Tracker": "mock", "Size": 4000000000, "PublishDate": "2023-01-01T00:00:00", "Seeders": 20, "Peers": 2,
     "MagnetUri": "magnet:?xt=urn:btih:" + b32(HASH2) + "&dn=bb720"},
    {"Title": "Breaking Bad S02 1080p", "Tracker": "mock", "Size": 8000000000, "PublishDate": "2024-02-01T00:00:00", "Seeders": 40, "Peers": 4,
     "MagnetUri": "magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff"},
]}
LOG = []


class H(BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Credentials", "true")

    def out(self, code, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        p = self.path
        if p.startswith("/echo"):
            return self.out(200, "MatriX.136", "text/plain")
        if p.startswith("/stream"):
            LOG.append({"stream": p})
            if "&preload" in p or "&stat" in p:
                return self.out(200, json.dumps({"preloaded_bytes": 100, "preload_size": 100}))
            return self.out(404, "", "text/plain")
        if p.startswith("/api/v2.0/indexers"):
            return self.out(200, json.dumps(JACKETT))
        if p.startswith("/mocklog"):
            return self.out(200, json.dumps({"log": LOG, "viewed": sorted(i for h, i in VIEWED)}))
        return self.out(404, "", "text/plain")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode() if n else ""
        try:
            req = json.loads(raw)
        except Exception:
            req = {}
        path = self.path.split("?")[0]
        LOG.append({"path": path, "req": req, "auth": self.headers.get("Authorization")})
        if path == "/settings":
            return self.out(200, json.dumps({"CacheSize": 100000000, "PreloadCache": 50}))
        if path == "/torrents":
            a = req.get("action")
            if a == "get":
                return self.out(200, json.dumps({"hash": HASH, "title": "Breaking Bad S01", "stat": 3, "file_stats": FILES}))
            if a == "list":
                return self.out(200, json.dumps([
                    {"hash": HASH, "title": "Breaking Bad S01", "stat": 5, "data": ""},
                    {"hash": HASH2, "title": "[LAMPA] Breaking Bad S01 720p", "stat": 5, "data": LAMPA_DATA},
                    {"hash": "9" * 40, "title": "Другой сериал (не смотрели)", "stat": 5, "data": ""},
                ]))
            return self.out(200, "", "text/plain")
        if path == "/viewed":
            a = req.get("action")
            h = req.get("hash")
            if a == "list":
                return self.out(200, json.dumps([{"hash": hh, "file_index": i} for hh, i in sorted(VIEWED) if not h or hh == h]))
            if a == "set":
                VIEWED.add((h, req.get("file_index")))
            if a == "rem":
                VIEWED.discard((h, req.get("file_index")))
            return self.out(200, "", "text/plain")
        return self.out(404, "", "text/plain")

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8090), H).serve_forever()
