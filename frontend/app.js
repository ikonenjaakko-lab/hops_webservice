(function () {
  const e = React.createElement;
  const { useEffect, useMemo, useRef, useState } = React;

  // Runtime paths can be injected by the server/container so the bundle works under different base URLs.
  const runtime = window.__HOPS_RUNTIME__ || {};
  const basePath = (runtime.basePath || "").replace(/\/$/, "");
  const dataBaseUrl = (runtime.dataBaseUrl || `${basePath}/data`).replace(/\/$/, "");
  const tileUrl = runtime.tileUrl || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
  const hillshadeTileUrl = runtime.hillshadeTileUrl || "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}";
  const enableHillshade = runtime.enableHillshade !== false;

  // Variable prefixes map to masks that hide areas where a land-cover-specific layer does not apply.
  const VARIABLE_MASKS = {
    open: "/geojson/mask-non-open.geojson",
    forest: "/geojson/mask-non-forest.geojson",
    bog: "/geojson/mask-non-organic.geojson"
  };
  const SOURCE_OPTIONS = [
    { id: "hops", label: "HOPS" },
    { id: "ecmwf", label: "ECMWF" },
    { id: "hsaf", label: "HSAF" },
    { id: "clms", label: "CLMS" }
  ];
  const sourceLabel = source => SOURCE_OPTIONS.find(option => option.id === source)?.label || String(source || "").toUpperCase();
  const maskForVariable = variable => VARIABLE_MASKS[String(variable || "").split("_")[0]] || null;
  const hasVariableMask = variable => Boolean(maskForVariable(variable));

  // Map selectors show every raster variable; basin plot selectors can exclude thematic-only layers.
  const sourceVariables = (config, source, options = {}) => config.variables.filter(v =>
    (v.source || "hops") === source && (!options.basinTimeseries || v.basinTimeseries !== false)
  );
  const defaultVariable = (config, source, fallbackId, options = {}) => {
    const vars = sourceVariables(config, source, options);
    return vars.some(v => v.id === fallbackId) ? fallbackId : (vars[0]?.id || config.variables[0]?.id);
  };
  const VariableSelect = ({ config, source, value, onChange, includeNone = false, noneLabel = "NONE", basinTimeseries = false }) => {
    const vars = sourceVariables(config, source, { basinTimeseries });
    const grouped = vars.reduce((acc, variable) => {
      const group = variable.group || sourceLabel(source);
      if (!acc[group]) acc[group] = [];
      acc[group].push(variable);
      return acc;
    }, {});
    return e("select", { className: "variable-select", value, onChange: ev => onChange(ev.target.value) },
      includeNone && e("option", { value: "none" }, noneLabel),
      ...Object.entries(grouped).map(([group, groupVars]) =>
        e("optgroup", { key: group, label: group },
          groupVars.map(v => e("option", { key: v.id, value: v.id }, v.label))
        )
      )
    );
  };
  const SourceSelect = ({ value, onChange, ariaLabel }) =>
    e("select", { className: "source-select", value, onChange: ev => onChange(ev.target.value), "aria-label": ariaLabel },
      SOURCE_OPTIONS.map(source => e("option", { key: source.id, value: source.id }, source.label))
    );
  const AllVariableSelect = ({ config, value, onChange, includeNone = false, noneLabel = "NONE" }) =>
    e("select", { className: "variable-select", value, onChange: ev => onChange(ev.target.value) },
      includeNone && e("option", { value: "none" }, noneLabel),
      ...SOURCE_OPTIONS.map(source => e("optgroup", { key: source.id, label: source.label },
        sourceVariables(config, source.id).map(v => e("option", { key: v.id, value: v.id }, v.label))
      ))
  );
  const apiUrl = (path) => `${basePath}${path}`;
  const dataUrl = (path) => `${dataBaseUrl}${path}`;

  // Leaflet masks use latitude/longitude rings, while GeoJSON stores longitude/latitude coordinates.
  const geoJsonOuterRings = (geojson) => {
    const rings = [];
    const addGeometry = (geometry) => {
      if (!geometry) return;
      if (geometry.type === "Polygon") {
        if (geometry.coordinates?.[0]) rings.push(geometry.coordinates[0].map(([lon, lat]) => [lat, lon]));
      } else if (geometry.type === "MultiPolygon") {
        geometry.coordinates.forEach(poly => {
          if (poly?.[0]) rings.push(poly[0].map(([lon, lat]) => [lat, lon]));
        });
      }
    };
    (geojson.features || []).forEach(feature => addGeometry(feature.geometry));
    addGeometry(geojson.geometry);
    return rings;
  };
  const outsideMaskRings = (geojson, bounds) => {
    const [[south, west], [north, east]] = bounds;
    const outer = [[south, west], [south, east], [north, east], [north, west]];
    return [outer, ...geoJsonOuterRings(geojson)];
  };
  const FORECAST_DAYS = 8;
  const HISTORY_DAYS = 17;
  const isoFromDate = d => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };
  const todayISO = () => isoFromDate(new Date());
  const forecastEndISO = () => addDays(todayISO(), FORECAST_DAYS);

  // Work with ISO date strings to avoid timezone drift in the date rail and CSV lookups.
  const addDays = (iso, n) => {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + n);
    return isoFromDate(d);
  };
  const fmt = (n) => Number.isFinite(n) ? n.toFixed(2) : "-";

  function markdown(md) {
    return md
      .replace(/^# (.*)$/gm, "<h1>$1</h1>")
      .replace(/^## (.*)$/gm, "<h2>$1</h2>")
      .replace(/^- (.*)$/gm, "<li>$1</li>")
      .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
      .replace(/\n\n/g, "</p><p>");
  }

  function useConfig() {
    const [config, setConfig] = useState(null);
    useEffect(() => { fetch(apiUrl("/api/config")).then(r => r.json()).then(setConfig); }, []);
    return config;
  }

  function Header({ config, view, setView }) {
    const pages = config.pages.map(p => p.id);
    return e(React.Fragment, null,
      e("header", { className: "topbar" },
        e("div", { className: "brand" },
          config.brandLogo ? e("img", { className: "brand-logo", src: `${basePath}/${config.brandLogo}`, alt: "HOPS" }) : null,
          e("div", { className: "brand-copy" },
            e("h1", null, config.subtitle),
            e("div", { className: "subtitle" }, config.title)
          )
        ),
        e("div", { className: "logos" }, config.logos.map(l => e("div", { key: l.id, className: `logo logo-${l.id}` },
          l.src ? e("img", { src: `${basePath}/${l.src}`, alt: l.label }) : l.label
        )))
      ),
      e("nav", { className: "nav" },
        e("button", { className: view === "main" ? "active" : "", onClick: () => setView("main") }, "Maps"),
        ...config.pages.map(p => e("button", { key: p.id, className: view === p.id ? "active" : "", onClick: () => setView(p.id) }, p.label)),
        e("button", { className: view === "admin" ? "active" : "", onClick: () => setView("admin") }, "Admin")
      )
    );
  }

  function useDateSequence(start) {
    return useMemo(() => Array.from({ length: HISTORY_DAYS + FORECAST_DAYS + 1 }, (_, i) => addDays(start, i)), [start]);
  }

  // Small deterministic placeholder trend used for dummy forecast point markers.
  function hashText(value) {
    return String(value).split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  }

  function forecastTrend(basinId, date) {
    return ((hashText(basinId) + new Date(date + "T00:00:00").getDate()) % 2) === 0 ? "up" : "down";
  }

  function metObservationSource(station) {
    return String(station.dataFile || `${station.id}.csv`).replace(/\.csv$/i, "");
  }

  function rasterSource(config, variable) {
    return config.variables.find(v => v.id === variable)?.source || "hops";
  }

  function metObservationUnit(station) {
    return station.type === "precipitation" ? "mm" : "C";
  }

  function metRowForDate(rows, date) {
    return (rows || []).find(row => row.date === date);
  }

  function metRowsForRange(rows, start, end) {
    return (rows || [])
      .filter(row => row.date >= start && row.date <= end)
      .map(row => ({ date: row.date, observed: Number(row.observed), simulated: Number(row.simulated) }))
      .filter(row => Number.isFinite(row.observed) && Number.isFinite(row.simulated));
  }

  function formatMetValue(value, station) {
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toFixed(station.type === "precipitation" ? 1 : 1)} ${metObservationUnit(station)}` : "-";
  }

  // The meteorological station popup is generated as HTML so Leaflet can own the floating container.
  function metPopupSvg(station, rows) {
    const w = 330, h = 150;
    const left = 34, right = 10, top = 14, bottom = 24;
    if (!rows.length) return `<div class="met-popup-empty">No data for selected range</div>`;
    const values = rows.flatMap(r => [r.observed, r.simulated]);
    const min = Math.min(...values), max = Math.max(...values);
    const x = i => left + (i / Math.max(1, rows.length - 1)) * (w - left - right);
    const y = v => h - bottom - ((v - min) / Math.max(1, max - min)) * (h - top - bottom);
    const obsPts = rows.map((r, i) => `${x(i)},${y(r.observed)}`).join(" ");
    const simPts = rows.map((r, i) => `${x(i)},${y(r.simulated)}`).join(" ");
    const ticks = Array.from({ length: 4 }, (_, i) => min + ((max - min) * i) / 3);
    const xTickCount = Math.min(6, rows.length);
    const xTickIdxs = Array.from({ length: xTickCount }, (_, i) => Math.round((i / Math.max(1, xTickCount - 1)) * (rows.length - 1)));
    const unit = metObservationUnit(station);
    const xAnchor = (idx, pos) => pos === 0 ? "start" : (pos === xTickIdxs.length - 1 ? "end" : "middle");
    return `
      <div class="met-popup-plot">
        <svg class="met-popup-plot-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
          ${ticks.map(t => `<line x1="${left}" y1="${y(t)}" x2="${w - right}" y2="${y(t)}" class="grid" />`).join("")}
          ${xTickIdxs.map(idx => `<line x1="${x(idx)}" y1="${top}" x2="${x(idx)}" y2="${h - bottom}" class="grid x-grid" />`).join("")}
          <line x1="${left}" y1="${h - bottom}" x2="${w - right}" y2="${h - bottom}" class="axis-line" />
          <line x1="${left}" y1="${top}" x2="${left}" y2="${h - bottom}" class="axis-line" />
          <polyline points="${obsPts}" class="obs-line" />
          <polyline points="${simPts}" class="sim-line" />
          ${ticks.map(t => `<text x="${left - 6}" y="${y(t) + 3}" class="tick-label y-tick-label" text-anchor="end">${Math.round(t)} ${unit}</text>`).join("")}
          ${xTickIdxs.map((idx, pos) => `<text x="${x(idx)}" y="${h - bottom + 13}" class="tick-label x-tick-label" text-anchor="${xAnchor(idx, pos)}">${rows[idx]?.date?.slice(5) || ""}</text>`).join("")}
        </svg>
      </div>
    `;
  }

  function createMetPopup(station, selectedDate, sourceRows) {
    const container = document.createElement("div");
    container.className = "met-popup";
    let rangeDays = 30;
    let start = addDays(selectedDate, -rangeDays + 1);
    let end = selectedDate;
    const metRangeLabels = { 30: "1M", 90: "3M", 180: "6M", 365: "1Y" };
    const setRange = days => {
      rangeDays = days;
      start = addDays(end, -days + 1);
      render();
    };
    const render = () => {
      if (new Date(start) > new Date(end)) [start, end] = [end, start];
      const rows = metRowsForRange(sourceRows, start, end);
      container.innerHTML = `
        <div class="met-popup-title">${station.label}</div>
        <div class="met-popup-controls">
          <label>Start <input type="date" data-role="start" value="${start}"></label>
          <label>End <input type="date" data-role="end" value="${end}"></label>
          <div class="met-popup-ranges">
            ${[30, 90, 180, 365].map(days => `<button type="button" data-range="${days}" class="${rangeDays === days ? "active" : ""}">${metRangeLabels[days]}</button>`).join("")}
          </div>
        </div>
        <div class="met-popup-legend"><span class="obs">Observed</span><span class="sim">Simulated</span></div>
        ${metPopupSvg(station, rows)}
      `;
      container.querySelector('[data-role="start"]').addEventListener("change", ev => { start = ev.target.value; rangeDays = null; render(); });
      container.querySelector('[data-role="end"]').addEventListener("change", ev => { end = ev.target.value; start = rangeDays ? addDays(end, -rangeDays + 1) : start; render(); });
      container.querySelectorAll("[data-range]").forEach(button => button.addEventListener("click", () => setRange(Number(button.dataset.range))));
    };
    render();
    return container;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // This overlay behaves like a small draggable/resizable window above the map.
  function openMetPopupOverlay(station, selectedDate, sourceRows) {
    document.querySelectorAll(".met-floating-popup").forEach(el => el.remove());

    const popup = document.createElement("div");
    popup.className = "met-floating-popup";
    popup.style.width = `${Math.min(620, window.innerWidth - 12)}px`;
    popup.style.height = `${Math.min(440, window.innerHeight - 12)}px`;

    const close = document.createElement("button");
    close.className = "met-floating-close";
    close.textContent = "X";
    close.addEventListener("click", () => popup.remove());

    const content = createMetPopup(station, selectedDate, sourceRows);
    const resize = document.createElement("div");
    resize.className = "met-resize-handle";

    popup.append(close, content, resize);
    document.body.appendChild(popup);

    const constrain = (left, top, width = popup.offsetWidth, height = popup.offsetHeight) => {
      const margin = 6;
      const maxLeft = Math.max(margin, window.innerWidth - width - margin);
      const maxTop = Math.max(margin, window.innerHeight - height - margin);
      return {
        left: clamp(left, margin, maxLeft),
        top: clamp(top, margin, maxTop)
      };
    };

    const startPos = constrain(
      (window.innerWidth - popup.offsetWidth) / 2,
      (window.innerHeight - popup.offsetHeight) / 2 + 70
    );
    popup.style.left = `${startPos.left}px`;
    popup.style.top = `${startPos.top}px`;

    popup.addEventListener("pointerdown", ev => {
      if (!ev.target.closest(".met-popup-title")) return;
      ev.preventDefault();
      ev.stopPropagation();
      popup.setPointerCapture?.(ev.pointerId);
      const rect = popup.getBoundingClientRect();
      const currentLeft = parseFloat(popup.style.left) || rect.left;
      const currentTop = parseFloat(popup.style.top) || rect.top;
      const dx = ev.clientX - currentLeft;
      const dy = ev.clientY - currentTop;
      const move = moveEv => {
        const pos = constrain(
          moveEv.clientX - dx,
          moveEv.clientY - dy,
          popup.offsetWidth,
          popup.offsetHeight
        );
        popup.style.left = `${pos.left}px`;
        popup.style.top = `${pos.top}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    resize.addEventListener("pointerdown", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      resize.setPointerCapture?.(ev.pointerId);
      const startX = ev.clientX;
      const startY = ev.clientY;
      const startW = popup.offsetWidth;
      const startH = popup.offsetHeight;
      const left = parseFloat(popup.style.left);
      const top = parseFloat(popup.style.top);
      const move = moveEv => {
        const margin = 6;
        const maxW = window.innerWidth - left - margin;
        const maxH = window.innerHeight - top - margin;
        popup.style.width = `${clamp(startW + moveEv.clientX - startX, 300, maxW)}px`;
        popup.style.height = `${clamp(startH + moveEv.clientY - startY, 230, maxH)}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  // Shared Leaflet map component for the two main maps and the basin detail map.
  function HopsMap({ id, config, date, variable, mode, showRivers, showPoints, showObs, showMask = true, obsType, basins, obsStations, onBasin, masterRef, slaveRef, basinId, passive }) {
    const divRef = useRef(null);
    const mapRef = useRef(null);
    const layersRef = useRef([]);
    const basinViewRef = useRef(null);
    const syncing = useRef(false);
    const basinFitPadding = [18, 18];
    const [metRowsByStation, setMetRowsByStation] = useState({});

    useEffect(() => {
      const mapBounds = !basinId && config.mainMapBounds ? config.mainMapBounds : config.maxBounds;
      const map = L.map(divRef.current, {
        minZoom: basinId || config.mainMapBounds ? 4 : config.minZoom,
        maxBounds: mapBounds,
        maxBoundsViscosity: 0.85,
        zoomControl: !passive,
        dragging: !passive,
        scrollWheelZoom: !passive && !basinId,
        doubleClickZoom: !passive,
        boxZoom: !passive,
        keyboard: !passive,
        tap: !passive,
        touchZoom: !passive,
        zoomSnap: (!basinId && config.mainMapBounds) || basinId ? 0.1 : 1,
        zoomDelta: (!basinId && config.mainMapBounds) || basinId ? 0.25 : 1
      }).setView(config.defaultCenter, config.defaultZoom);
      if (!basinId && config.mainMapBounds) {
        map.fitBounds(config.mainMapBounds, { animate: false, padding: [0, 0] });
        map.setMinZoom(map.getZoom());
      }
      L.tileLayer(tileUrl, {
        className: "base-map-tiles",
        maxZoom: 12,
        subdomains: ["a", "b", "c"],
        attribution: "&copy; OpenStreetMap contributors"
      }).addTo(map);
      if (enableHillshade && hillshadeTileUrl) {
        L.tileLayer(hillshadeTileUrl, {
          className: "hillshade-tiles",
          maxZoom: 12,
          maxNativeZoom: 13,
          opacity: 1
        }).addTo(map);
      }
      if (!map.getPane("variable-mask-pane")) {
        const variableMaskPane = map.createPane("variable-mask-pane");
        variableMaskPane.style.zIndex = 410;
        variableMaskPane.style.pointerEvents = "none";
      }
      if (!map.getPane("river-pane")) {
        const riverPane = map.createPane("river-pane");
        riverPane.style.zIndex = 455;
        riverPane.style.pointerEvents = "none";
      }
      if (basinId) {
        if (!map.getPane("basin-mask-pane")) {
          const maskPane = map.createPane("basin-mask-pane");
          maskPane.style.zIndex = 430;
          maskPane.style.pointerEvents = "none";
        }
        if (!map.getPane("basin-outline-pane")) {
          const outlinePane = map.createPane("basin-outline-pane");
          outlinePane.style.zIndex = 440;
        }
      }
      if (passive) {
        map.getContainer().setAttribute("aria-label", "Map B mirrors Map A");
        map.getContainer().classList.add("passive-map");
      }
      if (basinId) map.scrollWheelZoom.disable();
      mapRef.current = map;
      if (masterRef && !masterRef.current) masterRef.current = map;
      if (slaveRef) slaveRef.current = map;
      return () => map.remove();
    }, [passive, basinId]);

    // Map B is passive; it follows Map A pan/zoom while keeping its own raster layer.
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !masterRef || !slaveRef) return;
      const sync = () => {
        if (syncing.current || masterRef.current !== map || !slaveRef.current) return;
        syncing.current = true;
        slaveRef.current.setView(map.getCenter(), map.getZoom(), { animate: false });
        setTimeout(() => syncing.current = false, 40);
      };
      map.on("moveend zoomend", sync);
      return () => map.off("moveend zoomend", sync);
    }, [masterRef, slaveRef]);

    // Observation rows are fetched lazily only when station markers are enabled for a map.
    useEffect(() => {
      if (!obsStations?.length) return;
      let cancelled = false;
      obsStations.forEach(station => {
        const source = metObservationSource(station);
        if (metRowsByStation[station.id]) return;
        fetch(apiUrl(`/api/met-observations/${encodeURIComponent(source)}`))
          .then(r => r.json())
          .then(d => {
            if (cancelled) return;
            setMetRowsByStation(prev => ({ ...prev, [station.id]: d.rows || [] }));
          })
          .catch(() => {
            if (cancelled) return;
            setMetRowsByStation(prev => ({ ...prev, [station.id]: [] }));
          });
      });
      return () => { cancelled = true; };
    }, [obsStations]);

    // Basin detail maps are fitted to the watershed and then constrained to that same view.
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !basinId) return;
      const lockBasinView = () => {
        const view = basinViewRef.current;
        if (!view) return;
        if (map.getZoom() <= view.zoom) {
          map.setMinZoom(view.zoom);
          map.fitBounds(view.bounds, { maxZoom: view.zoom, animate: false, padding: basinFitPadding });
          map.dragging.disable();
        } else {
          map.dragging.enable();
          map.setMaxBounds(view.bounds.pad(0.02));
        }
      };
      const keepInsideBasin = () => {
        const view = basinViewRef.current;
        if (view && map.getZoom() > view.zoom) map.panInsideBounds(view.bounds.pad(0.02), { animate: false });
      };
      map.on("zoomend", lockBasinView);
      map.on("drag", keepInsideBasin);
      lockBasinView();
      return () => {
        map.off("zoomend", lockBasinView);
        map.off("drag", keepInsideBasin);
      };
    }, [basinId]);

    // Rebuild overlay layers whenever the selected date, raster, masks, or map decorations change.
    useEffect(() => {
      const map = mapRef.current;
      if (!map) return;
      let cancelled = false;
      layersRef.current.forEach(l => map.removeLayer(l));
      layersRef.current = [];
      const selectedBasin = basins.find(b => b.id === basinId);
      const overlayVar = mode === "obs" ? (variable || "temperature") : variable;
      const maskPath = showMask ? maskForVariable(overlayVar) : null;
      const pngSource = rasterSource(config, overlayVar);
      const png = `${dataUrl(`/png/${pngSource}/${overlayVar}/${date}.png`)}?v=${encodeURIComponent(config.rasterVersion || "1")}`;
      const img = L.imageOverlay(png, config.overlayBounds, { opacity: mode === "obs" ? 0.45 : 0.58, crossOrigin: true }).addTo(map);
      layersRef.current.push(img);
      if (maskPath) {
        fetch(dataUrl(maskPath)).then(r => r.json()).then(g => {
          if (cancelled) return;
          const l = L.geoJSON(g, {
            pane: "variable-mask-pane",
            interactive: false,
            style: {
              stroke: false,
              fillColor: "#0b0f12",
              fillOpacity: 0.85
            }
          }).addTo(map);
          layersRef.current.push(l);
        });
      }
      if (!basinId && config.projectArea?.source) {
        fetch(dataUrl(`/${config.projectArea.source}`)).then(r => r.json()).then(g => {
          if (cancelled) return;
          const l = L.geoJSON(g, {
            style: {
              color: "#f8d56b",
              weight: 2,
              opacity: 0.95,
              fillColor: "#f8d56b",
              fillOpacity: 0.04
            }
          }).addTo(map);
          l.bindTooltip(config.projectArea.label || "Project area", { sticky: true });
          layersRef.current.push(l);
        });
      }
      if (showRivers) {
        fetch(dataUrl("/geojson/rivers.geojson")).then(r => r.json()).then(g => {
          if (cancelled) return;
          const l = L.geoJSON(g, { pane: "river-pane", style: { color: "#5fd1ff", weight: 2, opacity: 0.9 } }).addTo(map);
          layersRef.current.push(l);
        });
      }
      if (basinId && selectedBasin) {
        fetch(dataUrl(`/watersheds/${basinId}.geojson`)).then(r => r.json()).then(g => {
          if (cancelled) return;
          const mask = L.polygon(outsideMaskRings(g, config.maxBounds), {
            pane: "basin-mask-pane",
            stroke: false,
            fillColor: "#000000",
            fillOpacity: 0.5,
            fillRule: "evenodd",
            interactive: false
          }).addTo(map);
          const l = L.geoJSON(g, {
            pane: "basin-outline-pane",
            style: {
              color: "#f8d56b",
              weight: 2,
              opacity: 0.95,
              fillOpacity: 0
            }
          }).addTo(map);
          layersRef.current.push(mask);
          layersRef.current.push(l);
          const bounds = l.getBounds();
          map.invalidateSize();
          map.fitBounds(bounds, { animate: false, padding: basinFitPadding });
          basinViewRef.current = { bounds, zoom: map.getZoom() };
          map.setMinZoom(basinViewRef.current.zoom);
          map.setMaxBounds(basinViewRef.current.bounds.pad(0.02));
          map.dragging.disable();
          map.scrollWheelZoom.disable();
        });
      }
      if (showPoints) {
        if (!basinId && config.forecastPoints?.source) {
          fetch(dataUrl(`/${config.forecastPoints.source}`)).then(r => r.json()).then(g => {
            if (cancelled) return;
            (g.features || []).forEach(feature => {
              const geometry = feature.geometry || {};
              if (geometry.type !== "Point" || !geometry.coordinates) return;
              const props = feature.properties || {};
              const id = props.ID || props.id || props.Name || props.name || "forecast-point";
              const label = props.Name || props.name || props.ID || "Forecast point";
              const [lon, lat] = geometry.coordinates;
              const trend = forecastTrend(id, date);
              const marker = L.marker([lat, lon], {
                icon: L.divIcon({
                  html: `<div class="forecast-marker ${trend}"><span class="trend-arrow">${trend === "up" ? "▲" : "▼"}</span></div>`,
                  className: "",
                  iconSize: [22, 22],
                  iconAnchor: [11, 11]
                })
              }).addTo(map);
              marker.bindTooltip(`${label} streamflow ${trend === "up" ? "rising" : "falling"}`);
              marker.on("click", () => onBasin && onBasin(String(id)));
              layersRef.current.push(marker);
            });
          });
        } else {
          basins.forEach(b => {
            const trend = forecastTrend(b.id, date);
            const marker = L.marker([b.lat, b.lon], {
              icon: L.divIcon({
                html: `<div class="forecast-marker ${trend}"><span class="trend-arrow">${trend === "up" ? "▲" : "▼"}</span></div>`,
                className: "",
                iconSize: [22, 22],
                iconAnchor: [11, 11]
              })
            }).addTo(map);
            marker.bindTooltip(`${b.label} streamflow ${trend === "up" ? "rising" : "falling"}`);
            marker.on("click", () => onBasin && onBasin(b.id));
            layersRef.current.push(marker);
          });
        }
      }
      if (showObs) {
        (obsStations || []).filter(station => !obsType || station.type === obsType).forEach(station => {
          const color = station.type === "precipitation" ? "#66d9ef" : "#f1c45b";
          const rows = metRowsByStation[station.id] || [];
          const row = metRowForDate(rows, date);
          const observed = formatMetValue(row?.observed, station);
          const simulated = formatMetValue(row?.simulated, station);
          const marker = L.marker([station.lat, station.lon], {
            icon: L.divIcon({
              html: `<div class="met-marker" style="--met-color:${color}"><span class="met-dot"></span><span class="met-values"><span class="met-value"><b>Obs</b> ${observed}</span><span class="met-value simulated"><b>Sim</b> ${simulated}</span></span></div>`,
              className: "",
              iconSize: [76, 32],
              iconAnchor: [8, 16]
            })
          }).addTo(map);
          marker.bindTooltip(`${station.label}: Observed ${observed}, Simulated ${simulated}`);
          marker.on("click", () => openMetPopupOverlay(station, date, rows));
          layersRef.current.push(marker);
        });
      }
      return () => { cancelled = true; };
    }, [date, variable, mode, showRivers, showPoints, showObs, showMask, obsType, basinId, obsStations, metRowsByStation]);

    return e("div", { id, ref: divRef, className: "map" + (basinId ? " basin-map" : "") });
  }

  // Main comparison view with synchronized HOPS maps and the shared date rail.
  function MainView({ config, openBasin }) {
    const [start, setStart] = useState(addDays(todayISO(), -HISTORY_DAYS));
    const dates = useDateSequence(start);
    const [date, setDate] = useState(todayISO());
    const [sourceA, setSourceA] = useState("hops");
    const [sourceB, setSourceB] = useState("hops");
    const [varA, setVarA] = useState(defaultVariable(config, "hops", "mean_runoff"));
    const [varB, setVarB] = useState(defaultVariable(config, "hops", "soil_state"));
    const [animate, setAnimate] = useState(false);
    const [showRivers, setShowRivers] = useState(true);
    const [showObs, setShowObs] = useState(true);
    const [maskA, setMaskA] = useState(true);
    const [maskB, setMaskB] = useState(true);
    const [obsType, setObsType] = useState("temperature");
    const dateListRef = useRef(null);
    const mapA = useRef(null);
    const mapB = useRef(null);

    useEffect(() => {
      if (!animate) return;
      const t = setInterval(() => setDate(d => dates[(dates.indexOf(d) + 1 + dates.length) % dates.length] || dates[0]), 850);
      return () => clearInterval(t);
    }, [animate, dates]);
    useEffect(() => {
      if (!dateListRef.current) return;
      dateListRef.current.scrollTop = dateListRef.current.scrollHeight;
    }, [dates]);

    const setMapSourceA = source => {
      setSourceA(source);
      setVarA(defaultVariable(config, source, source === "hops" ? "mean_runoff" : null));
    };
    const setMapSourceB = source => {
      setSourceB(source);
      setVarB(defaultVariable(config, source, source === "hops" ? "soil_state" : null));
    };
    const reset = () => { setStart(addDays(todayISO(), -HISTORY_DAYS)); setDate(todayISO()); };
    return e("main", { className: "main-grid" },
        e("section", { className: "panel map-panel" },
          e("div", { className: "panel-head panel-head-map-a" },
          e("div", { className: "control-row" },
            e(SourceSelect, { value: sourceA, onChange: setMapSourceA, ariaLabel: "Map A data source" }),
            e(VariableSelect, { config, source: sourceA, value: varA, onChange: setVarA }),
            hasVariableMask(varA) && e("label", { className: "mask-toggle" }, e("input", { type: "checkbox", checked: maskA, onChange: ev => setMaskA(ev.target.checked) }), "Mask")
          ),
          e("div", { className: "control-row map-a-layer-toggle" },
            e("label", null, e("input", { type: "checkbox", checked: showRivers, onChange: ev => setShowRivers(ev.target.checked) }), "River network")
          )
        ),
        e(HopsMap, { id: "map-a", config, date, variable: varA, showRivers, showPoints: showRivers, showObs: false, showMask: !hasVariableMask(varA) || maskA, basins: config.basins, onBasin: openBasin, masterRef: mapA, slaveRef: mapB })
      ),
      e("aside", { className: "panel date-column" },
        e("div", { className: "date-control-row" },
          e("input", { type: "date", value: start, onChange: ev => { setStart(ev.target.value); setDate(ev.target.value); } }),
          e("div", { className: "reset-animate-row" },
            e("button", { onClick: reset }, "Reset"),
            e("label", { className: "switch-label", title: "Animate dates" },
              e("span", null, "Animate"),
              e("input", { type: "checkbox", checked: animate, onChange: ev => setAnimate(ev.target.checked) }),
              e("span", { className: "switch-track" }, e("span", { className: "switch-thumb" }))
            )
          )
        ),
        e("div", { className: "date-list", ref: dateListRef }, dates.map(d => e("button", { key: d, onClick: () => setDate(d), className: `date-button ${d === date ? "active" : ""} ${d === todayISO() ? "today" : ""} ${d > todayISO() ? "forecast" : ""}` }, d === todayISO() ? "Today" : d)))
      ),
      e("section", { className: "panel map-panel" },
        e("div", { className: "panel-head" },
          e("div", { className: "control-row" },
            e("label", null, e("input", { type: "checkbox", checked: showObs, onChange: ev => setShowObs(ev.target.checked) }), "Met. obs. points"),
            showObs && e("div", { className: "segmented-toggle", role: "group", "aria-label": "Meteorological observation type" },
              e("button", { className: obsType === "temperature" ? "active" : "", onClick: () => setObsType("temperature") }, "Temp"),
              e("button", { className: obsType === "precipitation" ? "active" : "", onClick: () => setObsType("precipitation") }, "Precip")
            )
          ),
          e("div", { className: "control-row" },
            e(SourceSelect, { value: sourceB, onChange: setMapSourceB, ariaLabel: "Map B data source" }),
            e(VariableSelect, { config, source: sourceB, value: varB, onChange: setVarB }),
            hasVariableMask(varB) && e("label", { className: "mask-toggle" }, e("input", { type: "checkbox", checked: maskB, onChange: ev => setMaskB(ev.target.checked) }), "Mask")
          )
        ),
        e(HopsMap, { id: "map-b", config, date, variable: varB, showRivers: false, showPoints: false, showObs, showMask: !hasVariableMask(varB) || maskB, obsType, basins: config.basins, obsStations: config.observationStations, masterRef: mapA, slaveRef: mapB, passive: true })
      )
    );
  }

  function rangeRows(rows, selected, days) {
    const end = rows.findIndex(r => r.date === selected);
    const safeEnd = end >= 0 ? end : rows.length - 1;
    return rows.slice(Math.max(0, safeEnd - days + 1), safeEnd + 1);
  }

  // Hydrological skill metrics for the streamflow plots.
  function metrics(rows, modelId) {
    const obs = rows.map(r => +r.observations);
    const sim = rows.map(r => +r[modelId]);
    const mean = obs.reduce((a, b) => a + b, 0) / obs.length;
    const rmse = Math.sqrt(sim.reduce((a, s, i) => a + Math.pow(s - obs[i], 2), 0) / obs.length);
    const nse = 1 - sim.reduce((a, s, i) => a + Math.pow(s - obs[i], 2), 0) / obs.reduce((a, o) => a + Math.pow(o - mean, 2), 0);
    const meanS = sim.reduce((a, b) => a + b, 0) / sim.length;
    const sd = arr => Math.sqrt(arr.reduce((a, v) => a + Math.pow(v - arr.reduce((x, y) => x + y, 0) / arr.length, 2), 0) / arr.length);
    const r = obs.reduce((a, o, i) => a + (o - mean) * (sim[i] - meanS), 0) / (obs.length * sd(obs) * sd(sim));
    const alpha = sd(sim) / sd(obs);
    const beta = meanS / mean;
    const kge = 1 - Math.sqrt(Math.pow(r - 1, 2) + Math.pow(alpha - 1, 2) + Math.pow(beta - 1, 2));
    return { rmse, nse, kge };
  }

  // SVG plot renderer used for basin averages and streamflow; supports dual axes, bars, markers, and drag zoom.
  function Plot({ rows, series, selected, onPick, onRangeSelect, dualAxis = false, forecastBoundary }) {
    const w = 900, h = 220;
    const padLeft = 44, padRight = dualAxis ? 48 : 18, padTop = 22, padBottom = 30;
    const leftSeries = series.filter(s => (s.axis || "left") === "left");
    const rightSeries = series.filter(s => s.axis === "right");
    const axisExtent = axisSeries => {
      const values = rows.flatMap(r => axisSeries.map(s => +r[s.id]).filter(Number.isFinite));
      if (!values.length) return { min: 0, max: 1 };
      const min = Math.min(...values), max = Math.max(...values);
      return min === max ? { min: min - 1, max: max + 1 } : { min, max };
    };
    const leftExtent = axisExtent(leftSeries.length ? leftSeries : series);
    const rightExtent = axisExtent(rightSeries);
    const barSeries = series.filter(s => s.kind === "bar");
    const barWidth = Math.max(2, Math.min(14, ((w - padLeft - padRight) / Math.max(1, rows.length)) * 0.58));
    const x = i => padLeft + (i / Math.max(1, rows.length - 1)) * (w - padLeft - padRight);
    const yFor = (v, extent) => h - padBottom - ((v - extent.min) / Math.max(1, extent.max - extent.min)) * (h - padTop - padBottom);
    const y = (v, axis = "left") => yFor(v, axis === "right" ? rightExtent : leftExtent);
    const selectedIndex = Math.max(0, rows.findIndex(r => r.date === selected));
    const firstForecastIndex = forecastBoundary ? rows.findIndex(r => r.date >= forecastBoundary) : -1;
    const forecastShadeX = firstForecastIndex >= 0 ? x(firstForecastIndex) : null;
    const leftTicks = Array.from({ length: 5 }, (_, i) => leftExtent.min + ((leftExtent.max - leftExtent.min) * i) / 4);
    const rightTicks = Array.from({ length: 5 }, (_, i) => rightExtent.min + ((rightExtent.max - rightExtent.min) * i) / 4);
    const xTickCount = Math.min(6, rows.length);
    const xTickIdxs = Array.from({ length: xTickCount }, (_, i) => Math.round((i / Math.max(1, xTickCount - 1)) * (rows.length - 1)));
    const shortDate = iso => iso ? iso.slice(5) : "";
    const dragRef = useRef(null);
    const [dragRange, setDragRange] = useState(null);
    const indexFromEvent = (ev, targetEl = ev.currentTarget) => {
      const rect = targetEl.getBoundingClientRect();
      const pct = (ev.clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(rows.length - 1, Math.round(pct * (rows.length - 1))));
    };
    return e("div", {
      className: `plot${dualAxis && rightSeries.length ? " plot-dual-axis" : ""}`,
      onPointerDown: ev => {
        ev.preventDefault();
        ev.currentTarget.setPointerCapture?.(ev.pointerId);
        const startIdx = indexFromEvent(ev);
        dragRef.current = { startIdx };
        setDragRange({ a: startIdx, b: startIdx });
      },
      onPointerMove: ev => {
        if (!dragRef.current) return;
        const idx = indexFromEvent(ev);
        setDragRange({ a: dragRef.current.startIdx, b: idx });
      },
      onPointerUp: ev => {
        if (!dragRef.current) return;
        const endIdx = indexFromEvent(ev);
        const start = dragRef.current.startIdx;
        const delta = Math.abs(endIdx - start);
        dragRef.current = null;
        setDragRange(null);
        ev.currentTarget.releasePointerCapture?.(ev.pointerId);
        if (onRangeSelect && delta >= 2) {
          const a = Math.min(start, endIdx);
          const b = Math.max(start, endIdx);
          onRangeSelect(rows[a].date, rows[b].date);
        } else {
          onPick(rows[endIdx].date);
        }
      },
      onPointerCancel: ev => {
        dragRef.current = null;
        setDragRange(null);
        ev.currentTarget.releasePointerCapture?.(ev.pointerId);
      }
    },
      e("svg", { className: "plot-canvas", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none" },
        forecastShadeX !== null && e("rect", { x: forecastShadeX, y: padTop, width: w - padRight - forecastShadeX, height: h - padTop - padBottom, fill: "#5f6670", opacity: 0.36 }),
        ...leftTicks.map((tick, i) => e("line", { key: `y-grid-${i}`, x1: padLeft, y1: yFor(tick, leftExtent), x2: w - padRight, y2: yFor(tick, leftExtent), stroke: "#24404d", opacity: 0.45, vectorEffect: "non-scaling-stroke" })),
        ...xTickIdxs.map((idx, i) => e("line", { key: `x-grid-${i}`, x1: x(idx), y1: padTop, x2: x(idx), y2: h - padBottom, stroke: "#24404d", opacity: 0.28, vectorEffect: "non-scaling-stroke" })),
        e("line", { x1: padLeft, y1: h - padBottom, x2: w - padRight, y2: h - padBottom, stroke: "#314858", vectorEffect: "non-scaling-stroke" }),
        e("line", { x1: padLeft, y1: padTop, x2: padLeft, y2: h - padBottom, stroke: "#314858", vectorEffect: "non-scaling-stroke" }),
        dualAxis && rightSeries.length && e("line", { x1: w - padRight, y1: padTop, x2: w - padRight, y2: h - padBottom, stroke: "#314858", vectorEffect: "non-scaling-stroke" }),
        ...leftTicks.map((tick, i) => e("line", { key: `y-tick-${i}`, x1: padLeft - 4, y1: yFor(tick, leftExtent), x2: padLeft, y2: yFor(tick, leftExtent), stroke: "#7f96a3", vectorEffect: "non-scaling-stroke" })),
        ...(dualAxis && rightSeries.length ? rightTicks.map((tick, i) => e("line", { key: `yr-tick-${i}`, x1: w - padRight, y1: yFor(tick, rightExtent), x2: w - padRight + 4, y2: yFor(tick, rightExtent), stroke: "#7f96a3", vectorEffect: "non-scaling-stroke" })) : []),
        ...xTickIdxs.map((idx, i) => e("line", { key: `x-tick-${i}`, x1: x(idx), y1: h - padBottom, x2: x(idx), y2: h - padBottom + 4, stroke: "#7f96a3", vectorEffect: "non-scaling-stroke" })),
        ...barSeries.flatMap((s, si) => rows.map((r, i) => {
          const barCount = Math.max(1, barSeries.length);
          const left = x(i) - (barWidth * barCount) / 2 + si * barWidth;
          const valueY = y(+r[s.id], s.axis);
          const baseY = h - padBottom;
          return e("rect", { key: `${s.axis || "left"}-${s.id}-${i}`, x: left, y: Math.min(valueY, baseY), width: barWidth - 1, height: Math.max(1, Math.abs(baseY - valueY)), fill: s.color, opacity: 0.46 });
        })),
        ...series.filter(s => s.kind !== "bar" && s.kind !== "line-markers").map(s => e("polyline", { key: `${s.axis || "left"}-${s.id}`, fill: "none", stroke: s.color, strokeWidth: 2, vectorEffect: "non-scaling-stroke", points: rows.map((r, i) => `${x(i)},${y(+r[s.id], s.axis)}`).join(" ") })),
        ...series.filter(s => s.kind === "line-markers").map(s => e("polyline", { key: `${s.axis || "left"}-${s.id}-line`, fill: "none", stroke: s.color, strokeWidth: 2, vectorEffect: "non-scaling-stroke", points: rows.map((r, i) => `${x(i)},${y(+r[s.id], s.axis)}`).join(" ") })),
        ...series.filter(s => s.kind === "line-markers").flatMap(s => rows.map((r, i) => e("circle", {
          key: `${s.axis || "left"}-${s.id}-marker-${i}`,
          cx: x(i),
          cy: y(+r[s.id], s.axis),
          r: 2.2,
          fill: s.flagField && +r[s.flagField] === 1 ? "#ff4d5f" : s.color,
          stroke: "#102631",
          strokeWidth: 0.9,
          vectorEffect: "non-scaling-stroke"
        }))),
        e("line", { x1: x(selectedIndex), y1: padTop, x2: x(selectedIndex), y2: h - padBottom, stroke: "#ffffff", strokeDasharray: "4 4", vectorEffect: "non-scaling-stroke" })
      ),
      dragRange && e("div", {
        className: "plot-drag-range",
        style: {
          left: `${(Math.min(dragRange.a, dragRange.b) / Math.max(1, rows.length - 1)) * 100}%`,
          width: `${(Math.abs(dragRange.b - dragRange.a) / Math.max(1, rows.length - 1)) * 100}%`
        }
      }),
      e("div", { className: "plot-y-labels" }, leftTicks.map((tick, i) => e("span", { key: i, style: { bottom: `${(i / 4) * 100}%` } }, fmt(tick)))),
      dualAxis && rightSeries.length && e("div", { className: "plot-y-labels plot-y-labels-right" }, rightTicks.map((tick, i) => e("span", { key: i, style: { bottom: `${(i / 4) * 100}%` } }, fmt(tick)))),
      e("div", { className: "plot-x-labels" }, xTickIdxs.map((idx, i) => e("span", { key: i, style: { left: `${((x(idx) - padLeft) / (w - padLeft - padRight)) * 100}%` } }, shortDate(rows[idx]?.date)))),
      e("div", { className: "plot-labels" }, series.map(s => e("span", { key: `${s.axis || "left"}-${s.id}`, style: { color: s.color } }, s.label)))
    );
  }

  // Basin view combines basin-average plots, streamflow plots, a vertical date scrubber, and a focused map.
  function BasinView({ config, basinId, close }) {
    const basin = config.basins.find(b => b.id === basinId) || config.basins[0];
    const [rows, setRows] = useState([]);
    const [date, setDate] = useState(todayISO());
    const [mapSource, setMapSource] = useState("hops");
    const [mapVar, setMapVar] = useState(defaultVariable(config, "hops", "soil_state"));
    const [mapMask, setMapMask] = useState(true);
    const [varASource, setVarASource] = useState("hops");
    const [varBSource, setVarBSource] = useState("hops");
    const [varA, setVarA] = useState(defaultVariable(config, "hops", "mean_runoff", { basinTimeseries: true }));
    const [varB, setVarB] = useState(defaultVariable(config, "hops", "mean_swe", { basinTimeseries: true }));
    const [varAKind, setVarAKind] = useState("line");
    const [varBKind, setVarBKind] = useState("line");
    const [topPlotMode, setTopPlotMode] = useState("basin");
    const [bottomPlotMode, setBottomPlotMode] = useState("streamflow");
    const [bottomVarASource, setBottomVarASource] = useState("hops");
    const [bottomVarBSource, setBottomVarBSource] = useState("hops");
    const [bottomVarA, setBottomVarA] = useState(defaultVariable(config, "hops", "mean_swe"));
    const [bottomVarB, setBottomVarB] = useState(defaultVariable(config, "hops", "mean_runoff"));
    const [bottomVarAKind, setBottomVarAKind] = useState("line");
    const [bottomVarBKind, setBottomVarBKind] = useState("line");
    const [days, setDays] = useState(30);
    const [topShowStreamObservations, setTopShowStreamObservations] = useState(true);
    const [bottomShowStreamObservations, setBottomShowStreamObservations] = useState(true);
    const [topShowStreamStats, setTopShowStreamStats] = useState(true);
    const [bottomShowStreamStats, setBottomShowStreamStats] = useState(true);
    const [topModels, setTopModels] = useState(["hops", "hops_xgb"]);
    const [bottomModels, setBottomModels] = useState(["hops", "hops_xgb"]);
    const [topPlotPct, setTopPlotPct] = useState(52);
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
    const [zoomRange, setZoomRange] = useState(null);
    const plotsRef = useRef(null);
    const scrubberDragRef = useRef(false);
    useEffect(() => { fetch(apiUrl(`/api/timeseries/${basin.id}`)).then(r => r.json()).then(d => setRows(d.rows)); }, [basin.id]);
    const availableYears = useMemo(() => {
      const years = Array.from(new Set(rows.map(r => Number(r.date.slice(0, 4))))).filter(Number.isFinite).sort((a, b) => a - b);
      return years.length ? years : [selectedYear];
    }, [rows, selectedYear]);
    useEffect(() => {
      if (availableYears.length && !availableYears.includes(selectedYear)) setSelectedYear(availableYears[availableYears.length - 1]);
    }, [availableYears, selectedYear]);
    const currentYear = new Date().getFullYear();
    const isCurrentYear = selectedYear === currentYear;
    useEffect(() => {
      if (!isCurrentYear && days !== 365) setDays(365);
      setZoomRange(null);
    }, [selectedYear, days, isCurrentYear]);
    const baseVisible = useMemo(() => {
      if (!rows.length) return [];
      if (isCurrentYear) {
        const endDate = forecastEndISO();
        const endInRows = rows.findIndex(r => r.date === endDate);
        const end = endInRows >= 0 ? endInRows : rows.length - 1;
        return rows.slice(Math.max(0, end - days + 1), end + 1);
      }
      const yearRows = rows.filter(r => Number(r.date.slice(0, 4)) === selectedYear);
      return yearRows;
    }, [rows, days, selectedYear, isCurrentYear]);
    const visible = useMemo(() => {
      if (!zoomRange) return baseVisible;
      return baseVisible.filter(r => r.date >= zoomRange.start && r.date <= zoomRange.end);
    }, [baseVisible, zoomRange]);
    useEffect(() => {
      if (!visible.length) return;
      if (!visible.some(r => r.date === date)) setDate(visible[visible.length - 1].date);
    }, [visible, date]);
    const toggleTopModel = id => setTopModels(m => m.includes(id) ? m.filter(x => x !== id) : [...m, id]);
    const toggleBottomModel = id => setBottomModels(m => m.includes(id) ? m.filter(x => x !== id) : [...m, id]);
    const variableA = varA === "none" ? null : config.variables.find(v => v.id === varA);
    const variableB = varB === "none" ? null : config.variables.find(v => v.id === varB);
    const variableSeries = [
      variableA && { id: variableA.id, label: variableA.label, color: variableA.palette, kind: varAKind, axis: "left" },
      variableB && { id: variableB.id, label: variableB.label, color: variableB.palette, kind: varBKind, axis: "right" }
    ].filter(Boolean);
    const bottomVariableA = bottomVarA === "none" ? null : config.variables.find(v => v.id === bottomVarA);
    const bottomVariableB = bottomVarB === "none" ? null : config.variables.find(v => v.id === bottomVarB);
    const bottomVariableSeries = [
      bottomVariableA && { id: bottomVariableA.id, label: bottomVariableA.label, color: bottomVariableA.palette, kind: bottomVarAKind, axis: "left" },
      bottomVariableB && { id: bottomVariableB.id, label: bottomVariableB.label, color: bottomVariableB.palette, kind: bottomVarBKind, axis: "right" }
    ].filter(Boolean);
    const streamSeriesFor = (showObservations, selectedModels) => [
      showObservations && { id: "observations", label: "Observations", color: "#ffffff", kind: "line-markers", flagField: "observations_flag" },
      ...config.models.filter(m => selectedModels.includes(m.id)).map(m => ({ id: m.id, label: m.label, color: m.color }))
    ].filter(Boolean);
    const streamStatsFor = (showStats, selectedModels) => showStats && e("div", { className: "stats" }, config.models.filter(m => selectedModels.includes(m.id)).map(m => {
      const s = visible.length ? metrics(visible, m.id) : {};
      return e("div", { className: "stat", key: m.id }, e("strong", { style: { color: m.color } }, m.label), e("span", null, `RMSE ${fmt(s.rmse)}`), e("span", null, `NSE ${fmt(s.nse)}`), e("span", null, `KGE ${fmt(s.kge)}`));
    }));
    const topStreamSeries = streamSeriesFor(topShowStreamObservations, topModels);
    const bottomStreamSeries = streamSeriesFor(bottomShowStreamObservations, bottomModels);
    const topStreamStats = streamStatsFor(topShowStreamStats, topModels);
    const bottomStreamStats = streamStatsFor(bottomShowStreamStats, bottomModels);
    const topPlotCollapsed = topPlotMode === "none" || (topPlotMode === "basin" && variableSeries.length === 0);
    const bottomPlotCollapsed = bottomPlotMode === "none" || (bottomPlotMode === "basin" && bottomVariableSeries.length === 0);
    const plotGridRows = topPlotCollapsed && bottomPlotCollapsed
      ? "auto auto auto"
      : topPlotCollapsed
        ? "auto auto minmax(0, 1fr)"
        : bottomPlotCollapsed
          ? "minmax(0, 1fr) auto auto"
          : `minmax(0, ${topPlotPct}fr) auto minmax(0, ${100 - topPlotPct}fr)`;
    const rangeOptions = isCurrentYear ? [30, 90, 180, 365] : [365];
    const rangeLabels = { 30: "1M", 90: "3M", 180: "6M", 365: "1Y" };
    const zoomTimeRange = (start, end) => {
      setZoomRange({ start, end });
    };
    const scrubberIndex = Math.max(0, visible.findIndex(r => r.date === date));
    const scrubberPct = visible.length > 1 ? scrubberIndex / (visible.length - 1) : 1;
    const scrubberTop = `calc(${(scrubberPct * 100).toFixed(4)}% + ${(30 - scrubberPct * 48).toFixed(2)}px)`;
    const pickScrubberDate = ev => {
      if (!visible.length) return;
      const rect = ev.currentTarget.getBoundingClientRect();
      const topPad = 30;
      const bottomPad = 18;
      const usable = Math.max(1, rect.height - topPad - bottomPad);
      const y = Math.max(topPad, Math.min(rect.height - bottomPad, ev.clientY - rect.top));
      const pct = (y - topPad) / usable;
      const idx = Math.max(0, Math.min(visible.length - 1, Math.round(pct * (visible.length - 1))));
      setDate(visible[idx]?.date || date);
    };
    const startScrubberDrag = ev => {
      ev.preventDefault();
      scrubberDragRef.current = true;
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
      pickScrubberDate(ev);
    };
    const moveScrubberDrag = ev => {
      if (scrubberDragRef.current) pickScrubberDate(ev);
    };
    const endScrubberDrag = ev => {
      scrubberDragRef.current = false;
      ev.currentTarget.releasePointerCapture?.(ev.pointerId);
    };
    const resizePlots = ev => {
      if (!plotsRef.current) return;
      const rect = plotsRef.current.getBoundingClientRect();
      const minPanel = 178;
      const y = Math.max(minPanel, Math.min(rect.height - minPanel, ev.clientY - rect.top));
      setTopPlotPct((y / rect.height) * 100);
    };
    const startPlotResize = ev => {
      if (ev.target.closest("button,label,input")) return;
      ev.preventDefault();
      const move = moveEv => resizePlots(moveEv);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    const setBasinSourceA = source => {
      setVarASource(source);
      setVarA(defaultVariable(config, source, source === "hops" ? "mean_runoff" : null, { basinTimeseries: true }));
    };
    const setBasinSourceB = source => {
      setVarBSource(source);
      setVarB(defaultVariable(config, source, source === "hops" ? "mean_swe" : null, { basinTimeseries: true }));
    };
    const setBottomBasinSourceA = source => {
      setBottomVarASource(source);
      setBottomVarA(defaultVariable(config, source, source === "hops" ? "mean_swe" : null));
    };
    const setBottomBasinSourceB = source => {
      setBottomVarBSource(source);
      setBottomVarB(defaultVariable(config, source, source === "hops" ? "mean_runoff" : null));
    };
    const setBasinMapSource = source => {
      setMapSource(source);
      setMapVar(defaultVariable(config, source, source === "hops" ? "soil_state" : null));
    };
    return e("main", { className: "basin-view" },
      e("div", { className: "basin-workspace" },
        e("section", { className: "basin-plots", ref: plotsRef, style: { gridTemplateRows: plotGridRows } },
          e("section", { className: "panel plot-panel" + (topPlotCollapsed ? " plot-panel-collapsed" : "") },
            e("div", { className: "plot-head basin-average-head" + (topPlotMode === "streamflow" || topPlotMode === "none" ? " streamflow-head" : "") },
              e("div", { className: "control-row basin-average-controls basin-average-controls-a" },
                (topPlotMode === "streamflow" || topPlotMode === "none") && e(React.Fragment, null,
                  e("select", { className: "plot-mode-select", value: topPlotMode, onChange: ev => setTopPlotMode(ev.target.value), "aria-label": "Top plot type" },
                    e("option", { value: "none" }, "None"),
                    e("option", { value: "basin" }, "Basin average"),
                    e("option", { value: "streamflow" }, "Streamflow")
                  ),
                  topPlotMode === "streamflow" && e("strong", { className: "streamflow-unit" }, ["m", e("sup", { key: "unit" }, "3"), "/s"])
                ),
                topPlotMode === "basin" && e(React.Fragment, null,
                e(SourceSelect, { value: varASource, onChange: setBasinSourceA, ariaLabel: "Basin variable A data source" }),
                e(VariableSelect, { config, source: varASource, value: varA, onChange: setVarA, includeNone: true, noneLabel: "A = NONE", basinTimeseries: true }),
                varA !== "none" && e("select", { className: "plot-kind-select", value: varAKind, onChange: ev => setVarAKind(ev.target.value), title: "Variable A plot type" },
                  e("option", { value: "line" }, "Line"),
                  e("option", { value: "bar" }, "Bar")
                )
                )
              ),
              topPlotMode === "basin" ? e("select", { className: "plot-mode-select basin-average-title", value: topPlotMode, onChange: ev => setTopPlotMode(ev.target.value), "aria-label": "Top plot type" },
                e("option", { value: "none" }, "None"),
                e("option", { value: "basin" }, "Basin average"),
                e("option", { value: "streamflow" }, "Streamflow")
              ) : e("span", { className: "basin-average-title" }),
              e("div", { className: "control-row basin-average-controls basin-average-controls-b" },
                topPlotMode === "streamflow" && e("div", { className: "stream-controls" },
                  e("div", { className: "models" },
                    e("label", null, e("input", { type: "checkbox", checked: topShowStreamObservations, onChange: ev => setTopShowStreamObservations(ev.target.checked) }), "Obs."),
                    config.models.map(m => e("label", { key: m.id }, e("input", { type: "checkbox", checked: topModels.includes(m.id), onChange: () => toggleTopModel(m.id) }), m.label))
                  ),
                  e("label", { className: "stats-toggle stream-stats-toggle" }, e("input", { type: "checkbox", checked: topShowStreamStats, onChange: ev => setTopShowStreamStats(ev.target.checked) }), "Stats")
                ),
                topPlotMode === "basin" && e(React.Fragment, null,
                varB !== "none" && e("select", { className: "plot-kind-select", value: varBKind, onChange: ev => setVarBKind(ev.target.value), title: "Variable B plot type" },
                  e("option", { value: "line" }, "Line"),
                  e("option", { value: "bar" }, "Bar")
                ),
                e(SourceSelect, { value: varBSource, onChange: setBasinSourceB, ariaLabel: "Basin variable B data source" }),
                e(VariableSelect, { config, source: varBSource, value: varB, onChange: setVarB, includeNone: true, noneLabel: "B = NONE", basinTimeseries: true })
                )
              )
            ),
            visible.length && (topPlotMode === "streamflow"
              ? e(Plot, { rows: visible, series: topStreamSeries, selected: date, onPick: setDate, onRangeSelect: zoomTimeRange, forecastBoundary: todayISO() })
              : topPlotMode === "basin" && variableSeries.length > 0 && e(Plot, { rows: visible, series: variableSeries, selected: date, onPick: setDate, onRangeSelect: zoomTimeRange, dualAxis: true, forecastBoundary: todayISO() })),
            topPlotMode === "streamflow" && topStreamStats
          ),
          e("div", { className: "plot-resizer", onPointerDown: startPlotResize, title: "Drag to resize plots" },
            e("div", { className: "plot-resizer-left" },
              rangeOptions.map(d => e("button", { key: d, className: days === d ? "active" : "", onClick: () => { setDays(d); setZoomRange(null); } }, rangeLabels[d])),
              zoomRange && e("button", { onClick: () => setZoomRange(null) }, "Reset zoom")
            )
          ),
          e("section", { className: "panel plot-panel stream-panel" + (bottomPlotCollapsed ? " plot-panel-collapsed" : "") },
            e("div", { className: "plot-head basin-average-head bottom-plot-head" + (bottomPlotMode === "streamflow" || bottomPlotMode === "none" ? " streamflow-head" : "") },
              e("div", { className: "control-row basin-average-controls basin-average-controls-a" },
                (bottomPlotMode === "streamflow" || bottomPlotMode === "none") && e(React.Fragment, null,
                  e("select", { className: "plot-mode-select", value: bottomPlotMode, onChange: ev => setBottomPlotMode(ev.target.value), "aria-label": "Bottom plot type" },
                    e("option", { value: "none" }, "None"),
                    e("option", { value: "basin" }, "Basin average"),
                    e("option", { value: "streamflow" }, "Streamflow")
                  ),
                  bottomPlotMode === "streamflow" && e("strong", { className: "streamflow-unit" }, ["m", e("sup", { key: "unit" }, "3"), "/s"])
                ),
                bottomPlotMode === "basin" && e(React.Fragment, null,
                  e(SourceSelect, { value: bottomVarASource, onChange: setBottomBasinSourceA, ariaLabel: "Bottom basin variable A data source" }),
                  e(VariableSelect, { config, source: bottomVarASource, value: bottomVarA, onChange: setBottomVarA, includeNone: true, noneLabel: "A = NONE", basinTimeseries: true }),
                  bottomVarA !== "none" && e("select", { className: "plot-kind-select", value: bottomVarAKind, onChange: ev => setBottomVarAKind(ev.target.value), title: "Bottom variable A plot type" },
                    e("option", { value: "line" }, "Line"),
                    e("option", { value: "bar" }, "Bar")
                  )
                )
              ),
              bottomPlotMode === "basin" ? e("select", { className: "plot-mode-select basin-average-title", value: bottomPlotMode, onChange: ev => setBottomPlotMode(ev.target.value), "aria-label": "Bottom plot type" },
                e("option", { value: "none" }, "None"),
                e("option", { value: "basin" }, "Basin average"),
                e("option", { value: "streamflow" }, "Streamflow")
              ) : e("span", { className: "basin-average-title" }),
              bottomPlotMode === "streamflow" ? e("div", { className: "stream-controls" },
                e("div", { className: "models" },
                  e("label", null, e("input", { type: "checkbox", checked: bottomShowStreamObservations, onChange: ev => setBottomShowStreamObservations(ev.target.checked) }), "Obs."),
                  config.models.map(m => e("label", { key: m.id }, e("input", { type: "checkbox", checked: bottomModels.includes(m.id), onChange: () => toggleBottomModel(m.id) }), m.label))
                ),
                e("label", { className: "stats-toggle stream-stats-toggle" }, e("input", { type: "checkbox", checked: bottomShowStreamStats, onChange: ev => setBottomShowStreamStats(ev.target.checked) }), "Stats")
              ) : bottomPlotMode === "basin" && e("div", { className: "control-row basin-average-controls basin-average-controls-b" },
                bottomVarB !== "none" && e("select", { className: "plot-kind-select", value: bottomVarBKind, onChange: ev => setBottomVarBKind(ev.target.value), title: "Bottom variable B plot type" },
                  e("option", { value: "line" }, "Line"),
                  e("option", { value: "bar" }, "Bar")
                ),
                e(SourceSelect, { value: bottomVarBSource, onChange: setBottomBasinSourceB, ariaLabel: "Bottom basin variable B data source" }),
                e(VariableSelect, { config, source: bottomVarBSource, value: bottomVarB, onChange: setBottomVarB, includeNone: true, noneLabel: "B = NONE", basinTimeseries: true })
              )
            ),
            visible.length && (bottomPlotMode === "streamflow"
              ? e(Plot, { rows: visible, series: bottomStreamSeries, selected: date, onPick: setDate, onRangeSelect: zoomTimeRange, forecastBoundary: todayISO() })
              : bottomPlotMode === "basin" && bottomVariableSeries.length > 0 && e(Plot, { rows: visible, series: bottomVariableSeries, selected: date, onPick: setDate, onRangeSelect: zoomTimeRange, dualAxis: true, forecastBoundary: todayISO() })),
            bottomPlotMode === "streamflow" && bottomStreamStats
          )
        ),
        e("aside", { className: "panel basin-date-rail" },
          e("select", { className: "scrubber-year-select", value: selectedYear, onChange: ev => setSelectedYear(Number(ev.target.value)) },
            availableYears.map(year => e("option", { key: year, value: year }, year))
          ),
          e("div", {
            className: "scrubber-track-wrap",
            onPointerDown: startScrubberDrag,
            onPointerMove: moveScrubberDrag,
            onPointerUp: endScrubberDrag,
            onPointerCancel: endScrubberDrag
          },
            e("span", { className: "scrubber-end scrubber-start" }, visible[0]?.date || ""),
            e("div", { className: "scrubber-visual-track" }),
            e("div", { className: "scrubber-visual-handle", style: { top: scrubberTop } }),
            e("div", { className: "scrubber-date-label", style: { top: scrubberTop } }, date),
            e("input", {
              className: "vertical-scrubber",
              type: "range",
              min: 0,
              max: Math.max(0, visible.length - 1),
              step: 1,
              value: scrubberIndex,
              onChange: ev => setDate(visible[Number(ev.target.value)]?.date || date),
              "aria-label": "Selected basin date"
            }),
            e("span", { className: "scrubber-end scrubber-finish" }, visible[visible.length - 1]?.date || "")
          )
        ),
        e("section", { className: "panel map-panel basin-map-panel" },
          e("div", { className: "panel-head" },
            e("strong", null, `${basin.label || basin.name || basin.id} (${basin.id})`),
            e("div", { className: "control-row" },
              e(SourceSelect, { value: mapSource, onChange: setBasinMapSource, ariaLabel: "Basin map data source" }),
              e(VariableSelect, { config, source: mapSource, value: mapVar, onChange: setMapVar }),
              hasVariableMask(mapVar) && e("label", { className: "mask-toggle" }, e("input", { type: "checkbox", checked: mapMask, onChange: ev => setMapMask(ev.target.checked) }), "Mask")
            )
          ),
          e(HopsMap, { id: "basin-map", config, date, variable: mapVar, showRivers: true, showPoints: true, showObs: true, showMask: !hasVariableMask(mapVar) || mapMask, basins: [basin], basinId: basin.id })
        )
      )
    );
  }

  // Markdown pages are intentionally lightweight CMS content loaded from content/pages/*.md.
  function CmsPage({ id }) {
    const [md, setMd] = useState("");
    useEffect(() => { fetch(apiUrl(`/api/pages/${id}`)).then(r => r.json()).then(d => setMd(d.markdown || "# Missing page")); }, [id]);
    return e("main", { className: "panel page", dangerouslySetInnerHTML: { __html: `<p>${markdown(md)}</p>` } });
  }

  function Admin({ config }) {
    return e("main", { className: "page" },
      e("h1", null, "Admin"),
      e("p", null, "This lightweight admin area documents the editable file-based configuration used by the app. Update config/app.json and content/pages/*.md to manage variables, models, basins, and CMS pages."),
      e("div", { className: "admin-grid" },
        e("div", { className: "admin-block" }, e("h2", null, "Variables"), config.variables.map(v => e("p", { key: v.id }, `${v.id}: ${v.label} (${v.unit})`))),
        e("div", { className: "admin-block" }, e("h2", null, "Models"), config.models.map(m => e("p", { key: m.id }, `${m.id}: ${m.label}`))),
        e("div", { className: "admin-block" }, e("h2", null, "Basins"), config.basins.map(b => e("p", { key: b.id }, `${b.id}: ${b.label}`))),
        e("div", { className: "admin-block" }, e("h2", null, "Pages"), config.pages.map(p => e("p", { key: p.id }, `${p.id}: ${p.source}`)))
      )
    );
  }

  // Top-level router: the app keeps page state client-side and swaps between maps, pages, admin, and basin detail.
  function App() {
    const config = useConfig();
    const [view, setView] = useState("main");
    const [basin, setBasin] = useState(null);
    if (!config) return e("div", { className: "page" }, "Loading HOPS v2.0...");
    return e("div", { className: "app" },
      e(Header, { config, view: basin ? "basin" : view, setView: v => { setBasin(null); setView(v); } }),
      basin ? e(BasinView, { config, basinId: basin, close: () => setBasin(null) }) :
      view === "main" ? e(MainView, { config, openBasin: setBasin }) :
      view === "admin" ? e(Admin, { config }) :
      e(CmsPage, { id: view })
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(e(App));
})();
