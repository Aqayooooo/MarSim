"""Test dymny prawdziwego serwera po HTTP: zdrowie, plan, start EVA, strumień SSE, powrót, równoległe zapytania."""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"
env = {**os.environ, "MARSIM_DB_DIR": tempfile.mkdtemp(prefix="marsim-smoke-"), "PYTHONIOENCODING": "utf-8"}
ROOT = pathlib.Path(__file__).resolve().parents[1]
server = subprocess.Popen(
    [sys.executable, str(ROOT / "backend" / "server.py"), str(PORT), "--no-live-feeds"],
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)


def call(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method or ("POST" if data is not None else "GET"), headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


try:
    for _ in range(100):
        try:
            if call("/api/health")[0] == 200:
                break
        except OSError:
            time.sleep(0.2)
    print("health", call("/api/health"))
    status, plan = call("/api/plan", {})
    print("plan", status, round(plan["lengthM"]), "m")
    print("start", call("/api/eva/start", {"timeScale": 3000}))

    events = []
    with urllib.request.urlopen(BASE + "/api/stream", timeout=20) as stream:
        while len(events) < 4:
            line = stream.readline().decode("utf-8")
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    print("sse", [(e["t"], e["phase"], e["crewS"]) for e in events])
    assert events[-1]["t"] > events[0]["t"], "czas misji nie płynie w strumieniu"

    # Podczas serii zapytań czas płynie wolniej, aby próba obciążenia nie zużyła całego tlenu.
    assert call("/api/eva/timescale", {"timeScale": 60})[0] == 200
    codes = []

    def hammer(i):
        for k in range(15):
            codes.append(call("/api/state")[0])
            codes.append(call("/api/observations", {"kind": "inne", "x": 100 + 20 * i, "y": 100 + 10 * k, "radiusM": 5})[0])
            codes.append(call("/api/report")[0])

    threads = [threading.Thread(target=hammer, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    print("równolegle:", len(codes), "zapytań, kody", sorted(set(codes)))
    assert len(codes) == 360, f"Nie zakończono wszystkich zapytań: {len(codes)}/360"
    assert set(codes) == {200}

    assert call("/api/eva/timescale", {"timeScale": 3000})[0] == 200
    for _ in range(100):
        if call("/api/state")[1]["phase"] == "atTarget":
            break
        time.sleep(0.2)
    print("return", call("/api/eva/return", {})[0])
    for _ in range(150):
        state = call("/api/state")[1]
        if state["finished"]:
            break
        time.sleep(0.2)
    print("koniec", state["phase"], state["reached"], "t =", state["t"], "O2 Bartek", state["crew"][0]["o2Pct"], "%")
    assert state["finished"]
    assert all(member["o2Pct"] > 0 for member in state["crew"]), "Załoga wróciła bez tlenu"
    print("start po końcu", call("/api/eva/start", {}))
    print("OK")
finally:
    server.terminate()
    out = server.communicate(timeout=10)[0].decode("utf-8", "replace")
    print("--- log serwera ---\n" + out[-1500:])
