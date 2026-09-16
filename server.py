from __future__ import annotations

import csv
import json
import mimetypes
import os
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

ROOT = Path(__file__).resolve().parent
FRONTEND = Path(os.getenv("HOPS_FRONTEND_DIR", ROOT / "frontend")).resolve()
DATA_DIR = Path(os.getenv("HOPS_DATA_DIR", ROOT / "data")).resolve()
CONTENT_DIR = Path(os.getenv("HOPS_CONTENT_DIR", ROOT / "content")).resolve()
CONFIG = Path(os.getenv("HOPS_CONFIG_FILE", ROOT / "config" / "app.json")).resolve()
BASE_PATH = os.getenv("HOPS_BASE_PATH", "").strip("/")
BASE_PREFIX = f"/{BASE_PATH}" if BASE_PATH else ""
DATA_BASE_URL = os.getenv("HOPS_DATA_BASE_URL", f"{BASE_PREFIX}/data" if BASE_PREFIX else "/data")
TILE_URL = os.getenv(
    "HOPS_TILE_URL",
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
)
HILLSHADE_TILE_URL = os.getenv(
    "HOPS_HILLSHADE_TILE_URL",
    "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
)
ENABLE_HILLSHADE = os.getenv("HOPS_ENABLE_HILLSHADE", "1").lower() not in ("0", "false", "no")


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def json_response(handler: SimpleHTTPRequestHandler, payload, status=200):
    body = json.dumps(payload, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def text_response(handler: SimpleHTTPRequestHandler, body: str, content_type="text/plain; charset=utf-8", status=200):
    data = body.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def read_csv(path: Path):
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def merge_rows_by_date(*row_sets):
    merged = {}
    for rows in row_sets:
        for row in rows:
            row_date = row.get("date")
            if not row_date:
                continue
            target = merged.setdefault(row_date, {"date": row_date})
            target.update(row)
    return [merged[key] for key in sorted(merged)]


def read_streamflow_rows(basin: str, config):
    streamflow_dir = DATA_DIR / "basins" / "streamflow"
    basin_file_prefix = quote(basin, safe="")
    row_sets = []

    obs_rows = []
    for row in read_csv(streamflow_dir / f"{basin_file_prefix}_obs.csv"):
        obs_rows.append({
            "date": row.get("date"),
            "observations": row.get("observations"),
            "observations_flag": row.get("flag", "0"),
        })
    row_sets.append(obs_rows)

    for model in config.get("models", []):
        model_id = model.get("id")
        if not model_id:
            continue
        filename_id = model_id.replace("_", "-")
        model_rows = []
        for row in read_csv(streamflow_dir / f"{basin_file_prefix}_{filename_id}.csv"):
            model_rows.append({"date": row.get("date"), model_id: row.get("value")})
        row_sets.append(model_rows)

    return merge_rows_by_date(*row_sets)


def strip_base(path: str) -> str:
    if BASE_PREFIX and path == BASE_PREFIX:
        return "/"
    if BASE_PREFIX and path.startswith(BASE_PREFIX + "/"):
        return path[len(BASE_PREFIX) :]
    return path


class HopsHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        clean = strip_base(urlparse(path).path).lstrip("/")
        if clean.startswith("data/"):
            return str(DATA_DIR / clean.removeprefix("data/"))
        if clean.startswith("content/"):
            return str(CONTENT_DIR / clean.removeprefix("content/"))
        if clean in ("", "/"):
            return str(FRONTEND / "index.html")
        candidate = FRONTEND / clean
        return str(candidate if candidate.exists() else FRONTEND / "index.html")

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = strip_base(parsed.path)

        try:
            if path == "/health":
                return json_response(self, {"status": "ok", "service": "hops-v2"})

            if path == "/runtime-config.js":
                payload = {
                    "basePath": BASE_PREFIX,
                    "dataBaseUrl": DATA_BASE_URL,
                    "tileUrl": TILE_URL,
                    "hillshadeTileUrl": HILLSHADE_TILE_URL,
                    "enableHillshade": ENABLE_HILLSHADE,
                }
                return text_response(
                    self,
                    "window.__HOPS_RUNTIME__ = " + json.dumps(payload) + ";\n",
                    "application/javascript; charset=utf-8",
                )

            if path == "/api/config":
                return json_response(self, read_json(CONFIG))

            if path == "/api/dates":
                query = parse_qs(parsed.query)
                start = query.get("start", [""])[0]
                return json_response(self, {"start": start, "count": 30})

            if path.startswith("/api/timeseries/"):
                basin = path.rsplit("/", 1)[-1]
                basin_file = f"{quote(basin, safe='')}.csv"
                config = read_json(CONFIG)
                rows = merge_rows_by_date(
                    read_csv(DATA_DIR / "basins" / "hops" / basin_file),
                    read_csv(DATA_DIR / "basins" / "ecmwf" / basin_file),
                    read_csv(DATA_DIR / "basins" / "hsaf" / basin_file),
                    read_csv(DATA_DIR / "basins" / "clms" / basin_file),
                    read_streamflow_rows(basin, config),
                )
                return json_response(self, {"basin": basin, "rows": rows})

            if path.startswith("/api/met-observations/"):
                station = path.rsplit("/", 1)[-1]
                file_path = DATA_DIR / "metobs" / f"{quote(station, safe='')}.csv"
                return json_response(self, {"station": station, "rows": read_csv(file_path)})

            if path.startswith("/api/pages/"):
                slug = path.rsplit("/", 1)[-1]
                file_path = CONTENT_DIR / "pages" / f"{quote(slug, safe='')}.md"
                if not file_path.exists():
                    return json_response(self, {"error": "Page not found"}, 404)
                return json_response(self, {"id": slug, "markdown": file_path.read_text(encoding="utf-8")})

            return super().do_GET()
        except FileNotFoundError:
            return json_response(self, {"error": "File not found"}, 404)
        except Exception as exc:
            return json_response(self, {"error": str(exc)}, 500)

    def guess_type(self, path):
        if path.endswith(".geojson"):
            return "application/geo+json"
        return mimetypes.guess_type(path)[0] or "application/octet-stream"


def main():
    host = os.getenv("HOPS_HOST", "127.0.0.1")
    port = int(os.getenv("HOPS_PORT", "8000"))
    route = BASE_PREFIX or "/"
    print(f"HOPS v2.0 running at http://{host}:{port}{route}")
    ThreadingHTTPServer((host, port), HopsHandler).serve_forever()


if __name__ == "__main__":
    main()
