#!/usr/bin/env python3
"""Algo-lab autosave server for mockups/algo-lab.html.

  GET  /  -> returns sorting-autosave.json (current lab state)
  POST /  -> writes the payload to sorting-autosave.json; when the payload
             carries a `profile` list (>50 entries), the AppConfig is rebuilt
             and written to %APPDATA%/lol-aram-assistant/config.json plus
             aram-assistant-sorted-latest.json, so every lab click lands in
             the running app.

Battle-PK weights (`elo` / `matches`) are preserved per champion id from the
live config or the rescue snapshots whenever the incoming profile omits them,
so lab edits never reset the app's PK history.

Usage:
  python mockups/autosave_server.py [--port 18998] [--root PATH] [--no-appdata]
"""
import argparse
import http.server
import io
import json
import os

DEFAULT_PORT = 18998
PROFILE_MIN_LEN = 50


def load_json(path):
    try:
        with io.open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def build_weight_reservoir(paths):
    """id -> {elo, matches} merged across sources; later paths win."""
    weights = {}
    for path in paths:
        cfg = load_json(path)
        if not isinstance(cfg, dict):
            continue
        for item in cfg.get("aram_profile") or []:
            if not isinstance(item, dict) or item.get("id") is None:
                continue
            have = weights.setdefault(int(item["id"]), {})
            for key in ("elo", "matches", "secondary_spell"):
                if key in item:
                    have[key] = item[key]
    return weights


def main():
    parser = argparse.ArgumentParser(description="Algo-lab autosave server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--root",
        default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        help="project root that holds the autosave/export JSON files",
    )
    parser.add_argument(
        "--no-appdata",
        action="store_true",
        help="skip writing %%APPDATA%%/lol-aram-assistant/config.json (for tests)",
    )
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    autosave_path = os.path.join(root, "sorting-autosave.json")
    export_path = os.path.join(root, "aram-assistant-sorted-latest.json")
    rescue_paths = [
        os.path.join(root, "aram-assistant-sorted-194rounds.json"),
        os.path.join(root, "aram-assistant-backup.json"),
    ]
    appdata_path = os.path.expandvars(r"%APPDATA%\lol-aram-assistant\config.json")

    class AutosaveHandler(http.server.BaseHTTPRequestHandler):
        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")

        def _send_json(self, status, body):
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))

        def do_OPTIONS(self):
            self.send_response(200)
            self._cors()
            self.end_headers()

        def do_GET(self):
            state = load_json(autosave_path)
            if state is None:
                self.send_response(404)
                self._cors()
                self.end_headers()
                return
            self._send_json(200, json.dumps(state, ensure_ascii=False))

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8", "ignore")
            try:
                payload = json.loads(raw)

                with io.open(autosave_path, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, indent=2)

                profile = payload.get("profile")
                if isinstance(profile, list) and len(profile) > PROFILE_MIN_LEN:
                    # Config template: live config first, then the rescue snapshots.
                    sources = ([] if args.no_appdata else [appdata_path]) + rescue_paths
                    base_cfg = {}
                    for src in sources:
                        cfg = load_json(src)
                        if isinstance(cfg, dict) and cfg:
                            base_cfg = cfg
                            break

                    # Refill elo/matches for entries the lab profile lost, newest source wins.
                    weights = build_weight_reservoir(
                        [s for s in ([appdata_path] + rescue_paths) if os.path.exists(s)][::-1]
                    )
                    for item in profile:
                        if not isinstance(item, dict) or item.get("id") is None:
                            continue
                        have = weights.get(int(item["id"]))
                        if not have:
                            continue
                        for key in ("elo", "matches", "secondary_spell"):
                            if key not in item and key in have:
                                item[key] = have[key]

                    base_cfg["aram_profile"] = profile
                    base_cfg["mayhem_profile"] = [dict(x) for x in profile]

                    with io.open(export_path, "w", encoding="utf-8") as f:
                        json.dump(base_cfg, f, ensure_ascii=False, indent=2)
                    if not args.no_appdata:
                        with io.open(appdata_path, "w", encoding="utf-8") as f:
                            json.dump(base_cfg, f, ensure_ascii=False, indent=2)

                self._send_json(200, '{"ok":true}')
            except Exception as e:
                self._send_json(500, json.dumps({"error": str(e)}))

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), AutosaveHandler)
    print(f"Autosave server listening on http://127.0.0.1:{args.port} (root: {root})")
    server.serve_forever()


if __name__ == "__main__":
    main()
