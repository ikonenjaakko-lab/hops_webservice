# HOPS Hydrological Prediction, Comparison & Visualisation System (v2.0)

Modernized mock implementation of the HOPS hydrological forecast visualization and comparison service.

## What is included

- React frontend served from `frontend/`
- Leaflet dual-map main view with synchronized pan/zoom
- Basin detail view with map, linked time controls, dual-variable plot, streamflow plot, and RMSE/NSE/KGE statistics
- Config-driven variables, models, basins, logos, and CMS pages
- File-based dummy data under `data/`
- Markdown CMS pages under `content/pages/`
- Admin/config page for editing guidance and live configuration inspection
- Python server with FastAPI-compatible API shape and no mandatory third-party dependency

## Run locally

```powershell
python .\scripts\generate_dummy_data.py
python .\server.py
```

Open:

```text
http://127.0.0.1:8000
```

If you install FastAPI later, the same folder can be migrated to `uvicorn` without changing frontend API calls.

Health check:

```text
http://127.0.0.1:8000/health
```

## Environment variables

The app does not require hardcoded local paths. These variables are read at runtime:

```text
HOPS_HOST=127.0.0.1
HOPS_PORT=8000
HOPS_BASE_PATH=
HOPS_FRONTEND_DIR=frontend
HOPS_CONFIG_FILE=config/app.json
HOPS_CONTENT_DIR=content
HOPS_DATA_DIR=data
HOPS_DATA_BASE_URL=/data
HOPS_TILE_URL=https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png
```

`HOPS_BASE_PATH` supports reverse-proxy or OpenShift Route prefixes, for example `/hops`.

`HOPS_DATA_DIR` can point to a mounted persistent volume. `HOPS_DATA_BASE_URL` can later point to a public object storage prefix or CDN, while API basin timeseries can continue to read from the mounted data directory.

## Run with a container

Build:

```powershell
podman build -t hops-v2 -f .\Containerfile .
```

Run:

```powershell
podman run --rm -p 8000:8000 --env HOPS_HOST=0.0.0.0 hops-v2
```

Run with mounted data:

```powershell
podman run --rm -p 8000:8000 --env HOPS_HOST=0.0.0.0 --volume ${PWD}\data:/mnt/hops-data:Z --env HOPS_DATA_DIR=/mnt/hops-data hops-v2
```

## OpenShift notes

- A starter manifest is available at `deploy/openshift.yaml`; replace `PROJECT` and image naming with your project namespace or registry path.
- Build from `Containerfile` using OpenShift Builds, Shipwright, Tekton, or an external registry.
- Expose container port `8000`.
- Configure readiness/liveness probes against `/health`.
- Set `HOPS_HOST=0.0.0.0`.
- Set `HOPS_BASE_PATH` only if the application is served below a subpath instead of route root.
- Mount operational PNG/CSV/GeoJSON data as a PVC at a path such as `/mnt/hops-data` and set `HOPS_DATA_DIR=/mnt/hops-data`.
- If static PNG/GeoJSON layers are moved to object storage, set `HOPS_DATA_BASE_URL` to that object storage or CDN URL.
- Keep `config/app.json` and `content/pages/*.md` in the image for simple deployments, or mount them from ConfigMaps for operational editing.
- The frontend uses same-origin API calls and runtime configuration from `/runtime-config.js`, so route hostnames do not need to be compiled into the frontend.

## Data layout

```text
data/
  png/hops/{variable}/{date}.png
  png/ecmwf/{variable}/{date}.png
  png/hsaf/{variable}/{date}.png
  png/clms/{variable}/{date}.png
  basins/hops/{basin}.csv
  basins/ecmwf/{basin}.csv
  basins/hsaf/{basin}.csv
  basins/clms/{basin}.csv
  basins/streamflow/{basin}_obs.csv
  basins/streamflow/{basin}_{model}.csv
  metobs/fmi_tempc_{station_id}.csv
  metobs/fmi_precip_{station_id}.csv
  watersheds/{basin}.geojson
  geojson/rivers.geojson
config/
  app.json
content/
  pages/*.md
```

## Extending

- Add variables in `config/app.json`; place PNGs in `data/png/{source}/{id}/{yyyy-mm-dd}.png`
- Add basin-average CSV columns in `data/basins/{source}/{basin}.csv`
- Add streamflow observation data in `data/basins/streamflow/{basin}_obs.csv`; use `flag` value `1` for unreliable observations
- Add streamflow model data in `data/basins/streamflow/{basin}_{model}.csv`
- Add basins in `config/app.json`; add basin GeoJSON and timeseries file using the basin id
- Add meteorological observation stations in `config/app.json`; add station CSV files in `data/metobs/fmi_tempc_{station_id}.csv` or `data/metobs/fmi_precip_{station_id}.csv`
- Edit CMS text in `content/pages/*.md`
