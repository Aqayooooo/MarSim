"""Serwer deweloperski MarSim (tryb bez backendu, dane przykładowe): pliki statyczne bez cache
i automatyczne odświeżanie strony po zapisaniu pliku interfejsu (jak „Live Server”).
Uruchomienie z katalogu projektu:  python tools/serve.py [port]      bez odświeżania: --no-reload
"""
import functools
import http.server
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
PORT = int(ARGS[0]) if ARGS else 5173
LIVE = '--no-reload' not in sys.argv
WATCH = ['index.html', 'styles.css', 'src', 'data/missions/index.json']

# wstrzykiwane tylko przez ten serwer (GitHub Pages i backend go nie dostają): co 0,7 s pyta o znacznik zmian
SNIPPET = b"""<script>/* live reload (tools/serve.py) */(()=>{let v=null;const tick=async()=>{try{const r=await fetch('/__live',{cache:'no-store'});const n=(await r.json()).v;if(v!==null&&n!==v){location.reload();return}v=n}catch(e){}setTimeout(tick,700)};tick()})();</script>"""


def stamp() -> float:
    """Najnowszy czas modyfikacji plików interfejsu."""
    best = 0.0
    for w in WATCH:
        p = os.path.join(ROOT, w)
        if os.path.isfile(p):
            best = max(best, os.path.getmtime(p))
        for dirpath, _, files in os.walk(p) if os.path.isdir(p) else []:
            for f in files:
                best = max(best, os.path.getmtime(os.path.join(dirpath, f)))
    return best


class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript', '.f32': 'application/octet-stream'}

    def send_head(self):
        from pathlib import Path
        p = Path(self.translate_path(self.path)).resolve()
        root = Path(ROOT).resolve()
        allowed = {"index.html", "styles.css", "data-sources.json"}
        if p == root:
            p = root / "index.html"
        relative = p.relative_to(root) if p.is_relative_to(root) else None
        if relative is None or not p.is_file() or any(part.startswith('.') for part in relative.parts) or not (str(relative) in allowed or relative.parts[0] in ("src", "vendor", "data")):
            self.send_error(404)
            return None
        if relative.parts[0] == "data" and not (len(relative.parts)>1 and relative.parts[1] in ("demo", "missions")):
            self.send_error(404)
            return None
        return super().send_head()

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if LIVE and path == '/__live':
            return self._send(json.dumps({'v': stamp()}).encode(), 'application/json')
        if LIVE and path in ('/', '/index.html'):
            with open(os.path.join(ROOT, 'index.html'), 'rb') as f:
                html = f.read()
            return self._send(html.replace(b'</body>', SNIPPET + b'</body>', 1), 'text/html; charset=utf-8')
        return super().do_GET()

    def _send(self, body: bytes, ctype: str):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


handler = functools.partial(NoCache, directory=ROOT)
print(f'MarSim (demo): http://localhost:{PORT}' + ('  · odświeżanie na żywo' if LIVE else ''), flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler).serve_forever()
