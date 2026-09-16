from __future__ import annotations

import csv
import json
import math
import random
import shutil
import struct
import zlib
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "config" / "app.json").read_text(encoding="utf-8"))
TODAY = date.today()
PNG_WIDTH = 320
PNG_HEIGHT = 240
DUMMY_NOTICE = "DUMMY_PLACEHOLDER_DATA_REPLACE_BEFORE_PRODUCTION"
PNG_PLACEHOLDER = ROOT / "AA_Dev_Files" / "test_kemijoki_shape.png"


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def add_dummy_text_chunk(png_bytes: bytes) -> bytes:
    signature = b"\x89PNG\r\n\x1a\n"
    if not png_bytes.startswith(signature):
        return png_bytes
    marker = png_chunk(b"tEXt", f"Comment\0{DUMMY_NOTICE}".encode("latin-1"))
    pos = len(signature)
    while pos + 8 <= len(png_bytes):
        length = struct.unpack(">I", png_bytes[pos : pos + 4])[0]
        chunk_type = png_bytes[pos + 4 : pos + 8]
        chunk_end = pos + 12 + length
        if chunk_type == b"IHDR":
            return png_bytes[:chunk_end] + marker + png_bytes[chunk_end:]
        pos = chunk_end
    return png_bytes


def write_png(path: Path, width: int, height: int, seed: int, color, mask=None):
    random.seed(seed)
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            wave = (math.sin((x + seed) / 13) + math.cos((y - seed) / 17) + 2) / 4
            noise = random.random() * 0.18
            a = int(105 + 120 * min(1, wave + noise))
            if mask is not None and not mask[y][x]:
                a = 0
            r = int(color[0] * (0.35 + 0.65 * wave))
            g = int(color[1] * (0.35 + 0.65 * wave))
            b = int(color[2] * (0.35 + 0.65 * wave))
            row.extend([r, g, b, a])
        rows.append(bytes(row))
    raw = b"".join(rows)
    data = b"\x89PNG\r\n\x1a\n"
    data += png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    data += png_chunk(b"tEXt", f"Comment\0{DUMMY_NOTICE}".encode("latin-1"))
    data += png_chunk(b"IDAT", zlib.compress(raw, 6))
    data += png_chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def hex_to_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def project_area_rings():
    source = CONFIG.get("projectArea", {}).get("source")
    if not source:
        return []
    path = ROOT / "data" / source
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    rings = []
    for feature in data.get("features", []):
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        if geometry.get("type") == "Polygon":
            rings.extend(coordinates)
        elif geometry.get("type") == "MultiPolygon":
            for polygon in coordinates:
                rings.extend(polygon)
    return rings


def raster_mask(width: int, height: int):
    rings = project_area_rings()
    if not rings:
        return None
    south, west = CONFIG["overlayBounds"][0]
    north, east = CONFIG["overlayBounds"][1]
    north_y = mercator_y(north)
    south_y = mercator_y(south)

    def to_pixel(lon, lat):
        x = (lon - west) / (east - west) * width
        y = (north_y - mercator_y(lat)) / (north_y - south_y) * height
        return x, y

    mask = [bytearray(width) for _ in range(height)]
    for ring in rings:
        points = [to_pixel(lon, lat) for lon, lat, *_ in ring]
        for y in range(height):
            intersections = []
            scan_y = y + 0.5
            for idx, (x1, y1) in enumerate(points):
                x2, y2 = points[(idx + 1) % len(points)]
                if (y1 <= scan_y < y2) or (y2 <= scan_y < y1):
                    intersections.append(x1 + (scan_y - y1) * (x2 - x1) / (y2 - y1))
            intersections.sort()
            for start, end in zip(intersections[0::2], intersections[1::2]):
                x_start = max(0, math.ceil(start - 0.5))
                x_end = min(width - 1, math.floor(end - 0.5))
                for x in range(x_start, x_end + 1):
                    mask[y][x] ^= 1
    return mask


def mercator_y(lat):
    clamped = max(-85.05112878, min(85.05112878, lat))
    radians = math.radians(clamped)
    return math.log(math.tan(math.pi / 4 + radians / 2))


def write_geojson():
    (ROOT / "data" / "geojson").mkdir(parents=True, exist_ok=True)
    rivers_path = ROOT / "data" / "geojson" / "rivers.geojson"
    if not rivers_path.exists():
        rivers = {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "properties": {"name": "Kemijoki"}, "geometry": {"type": "LineString", "coordinates": [[24.0, 68.0], [25.1, 67.2], [25.7, 66.5], [26.0, 65.7]]}},
                {"type": "Feature", "properties": {"name": "Ounasjoki"}, "geometry": {"type": "LineString", "coordinates": [[23.6, 68.3], [24.2, 67.4], [25.0, 66.7]]}},
                {"type": "Feature", "properties": {"name": "Kitinen"}, "geometry": {"type": "LineString", "coordinates": [[27.6, 68.0], [27.2, 67.2], [26.5, 66.6]]}},
            ],
        }
        rivers_path.write_text(json.dumps(rivers, indent=2), encoding="utf-8")
    shp = ROOT / "data" / "watersheds"
    shp.mkdir(parents=True, exist_ok=True)
    for basin in CONFIG["basins"]:
        lon, lat = basin["lon"], basin["lat"]
        dx = basin.get("extentLon", 1.0)
        dy = basin.get("extentLat", 0.55)
        poly = [[lon - dx, lat - dy], [lon - dx * 0.35, lat + dy], [lon + dx * 0.8, lat + dy * 0.64], [lon + dx * 1.1, lat - dy * 0.82], [lon - dx, lat - dy]]
        fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": basin, "geometry": {"type": "Polygon", "coordinates": [poly]}}]}
        basin_path = shp / f"{basin['id']}.geojson"
        if not basin_path.exists():
            basin_path.write_text(json.dumps(fc, indent=2), encoding="utf-8")


def write_timeseries():
    out = ROOT / "data" / "basins"
    out.mkdir(parents=True, exist_ok=True)
    locked_legacy_files = []
    for old_csv in out.glob("*.csv"):
        try:
            old_csv.unlink()
        except PermissionError:
            locked_legacy_files.append(str(old_csv.relative_to(ROOT)))
    old_metadata = out / "_dummy_metadata.json"
    if old_metadata.exists():
        old_metadata.unlink()
    for source_dir in ("hops", "ecmwf", "hsaf", "clms", "streamflow", "ext"):
        path = out / source_dir
        if path.exists():
            shutil.rmtree(path)
    start = date(2024, 1, 1)
    end = max(TODAY + timedelta(days=30), date(2026, 12, 31))
    total_days = (end - start).days + 1
    dates = [start + timedelta(days=i) for i in range(total_days)]
    source_ids = ["hops", "ecmwf", "hsaf", "clms"]
    variables_by_source = {
        source: [variable for variable in CONFIG["variables"] if variable.get("source", "hops") == source and variable.get("basinTimeseries") is not False]
        for source in source_ids
    }
    streamflow_columns = ["date", "observations", "flag"] + [m["id"] for m in CONFIG["models"]]
    metadata = {
        "notice": DUMMY_NOTICE,
        "description": "All basin average and streamflow CSV files are generated placeholders.",
        "basinAverageSources": {
            source: [variable["id"] for variable in variables]
            for source, variables in variables_by_source.items()
        },
        "streamflowColumns": streamflow_columns,
    }
    if locked_legacy_files:
        metadata["lockedLegacyFilesNotRemoved"] = locked_legacy_files
    (out / "_dummy_metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    for source in [*source_ids, "streamflow"]:
        (out / source).mkdir(parents=True, exist_ok=True)
    for bidx, basin in enumerate(CONFIG["basins"]):
        streamflow_values = []
        for i, d in enumerate(dates):
            seasonal = math.sin((i + bidx * 18) / 365 * math.tau)
            obs = 210 + 80 * seasonal + 18 * math.sin(i / 9)
            streamflow_values.append({
                "date": d.isoformat(),
                "observations": round(obs, 2),
                "models": {
                    model["id"]: round(obs * (0.94 + midx * 0.025) + math.sin(i / (5 + midx)) * 12, 2)
                    for midx, model in enumerate(CONFIG["models"])
                },
            })
        with (out / "streamflow" / f"{basin['id']}_obs.csv").open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["date", "observations", "flag"])
            writer.writeheader()
            for row in streamflow_values:
                writer.writerow({"date": row["date"], "observations": row["observations"], "flag": 0})
        for model in CONFIG["models"]:
            filename_id = model["id"].replace("_", "-")
            with (out / "streamflow" / f"{basin['id']}_{filename_id}.csv").open("w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=["date", "value"])
                writer.writeheader()
                for row in streamflow_values:
                    writer.writerow({"date": row["date"], "value": row["models"][model["id"]]})
        for source, variables in variables_by_source.items():
            fields = ["date", *[variable["id"] for variable in variables]]
            with (out / source / f"{basin['id']}.csv").open("w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=fields)
                writer.writeheader()
                for i, d in enumerate(dates):
                    seasonal = math.sin((i + bidx * 18) / 365 * math.tau)
                    row = {"date": d.isoformat()}
                    for vidx, variable in enumerate(variables):
                        row[variable["id"]] = dummy_variable_value(variable, i, bidx, vidx, seasonal)
                    writer.writerow(row)


def met_observation_value(station, day_index, station_index, seasonal):
    wave = math.sin((day_index + station_index * 9) / 13)
    if station["type"] == "precipitation":
        observed = max(0, 4 + 4 * math.sin(day_index / 9 + station_index) + 2 * wave)
        simulated = max(0, observed * (0.86 + station_index * 0.02) + math.sin(day_index / 5) * 1.4)
    else:
        observed = -2 + 16 * seasonal + 2.5 * wave
        simulated = observed + math.sin(day_index / 7 + station_index) * 1.8
    return round(observed, 2), round(simulated, 2)


def met_observation_filename(station):
    if station.get("dataFile"):
        return station["dataFile"]
    prefix = "fmi_precip" if station["type"] == "precipitation" else "fmi_tempc"
    station_number = station.get("number") or station["id"]
    return f"{prefix}_{station_number}.csv"


def write_met_observations():
    out = ROOT / "data" / "metobs"
    out.mkdir(parents=True, exist_ok=True)
    start = date(2024, 1, 1)
    end = max(TODAY + timedelta(days=30), date(2026, 12, 31))
    total_days = (end - start).days + 1
    fields = ["date", "observed", "simulated"]
    metadata = {
        "notice": DUMMY_NOTICE,
        "description": "Meteorological observation comparison CSV files are generated placeholders.",
        "columns": fields,
    }
    (out / "_dummy_metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    for sidx, station in enumerate(CONFIG["observationStations"]):
        filename = met_observation_filename(station)
        with (out / filename).open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            for i in range(total_days):
                d = start + timedelta(days=i)
                seasonal = math.sin((i + sidx * 12) / 365 * math.tau)
                observed, simulated = met_observation_value(station, i, sidx, seasonal)
                writer.writerow({"date": d.isoformat(), "observed": observed, "simulated": simulated})


def dummy_variable_value(variable, day_index, basin_index, variable_index, seasonal):
    wave = math.sin((day_index + basin_index * 11 + variable_index * 7) / 31)
    snow = max(0, seasonal)
    vid = variable["id"]
    if "air_temp" in vid:
        return round(-2 + 16 * seasonal + 2 * wave, 2)
    if "precip" in vid:
        return round(max(0, 4 + 4 * math.sin(day_index / 9 + variable_index)), 2)
    if "fraction" in vid:
        return round(max(0, min(100, 50 + 48 * snow + 7 * wave)), 2)
    if "freeze_thaw" in vid or vid == "soil_state":
        return round(1 if seasonal < -0.08 else 0, 2)
    if "runoff" in vid:
        return round(max(0, 9 + 5 * seasonal + 2 * wave), 2)
    if "frost_depth" in vid:
        return round(max(0, 85 * (1 - max(0, seasonal)) + 8 * wave), 2)
    if "thaw_depth" in vid:
        return round(max(0, 35 + 75 * max(0, seasonal) + 6 * wave), 2)
    if "snow_depth" in vid:
        return round(max(0, 80 * snow + 10 * wave), 2)
    if "swe" in vid:
        return round(max(0, 120 * snow + 12 * wave), 2)
    if "deficit" in vid:
        return round(max(0, 50 - 25 * seasonal + 7 * wave), 2)
    if "volume" in vid:
        return round(max(0, 65 + 24 * seasonal + 9 * wave), 2)
    return round(max(0, 50 + 30 * seasonal + 6 * wave), 2)


def write_pngs():
    png_root = ROOT / "data" / "png"
    if png_root.exists():
        for old_png in png_root.rglob("*.png"):
            old_png.unlink()
        for old_dir in sorted((p for p in png_root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            if not any(old_dir.iterdir()):
                old_dir.rmdir()
    dates = [TODAY + timedelta(days=i - 17) for i in range(45)]
    placeholder = add_dummy_text_chunk(PNG_PLACEHOLDER.read_bytes()) if PNG_PLACEHOLDER.exists() else None
    mask = None if placeholder else raster_mask(PNG_WIDTH, PNG_HEIGHT)
    for vidx, variable in enumerate(CONFIG["variables"]):
        rgb = hex_to_rgb(variable["palette"])
        source = variable.get("source", "hops")
        for didx, d in enumerate(dates):
            path = ROOT / "data" / "png" / source / variable["id"] / f"{d.isoformat()}.png"
            if placeholder:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(placeholder)
            else:
                write_png(path, PNG_WIDTH, PNG_HEIGHT, vidx * 1000 + didx, rgb, mask)
    (png_root / "_dummy_metadata.json").write_text(json.dumps({
        "notice": DUMMY_NOTICE,
        "description": "All PNG rasters generated by this script are placeholders.",
        "source": str(PNG_PLACEHOLDER.relative_to(ROOT)) if placeholder else "procedural fallback",
        "variableDirectories": [f"{variable.get('source', 'hops')}/{variable['id']}" for variable in CONFIG["variables"]],
    }, indent=2), encoding="utf-8")


def main():
    write_geojson()
    write_timeseries()
    write_met_observations()
    write_pngs()
    print("Generated dummy HOPS data in data/")


if __name__ == "__main__":
    main()
