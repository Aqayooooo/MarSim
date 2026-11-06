"""Serwer deweloperski MarSim (tryb bez backendu, dane przykładowe): pliki statyczne bez cache (zmiany widać po odświeżeniu).
Uruchomienie z katalogu projektu:  python tools/serve.py [port]
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5173


class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript', '.f32': 'application/octet-stream'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


handler = functools.partial(NoCache, directory=ROOT)
print(f'MarSim (demo): http://localhost:{PORT}', flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler).serve_forever()
