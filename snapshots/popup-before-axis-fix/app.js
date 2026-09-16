(function () {
  const e = React.createElement;
  const { useEffect, useMemo, useRef, useState } = React;
  const runtime = window.__HOPS_RUNTIME__ || {};
  const basePath = (runtime.basePath || "").replace(/\/$/, "");
  const dataBaseUrl = (runtime.dataBaseUrl || `${basePath}/data`).replace(/\/$/, "");
  const tileUrl = runtime.tileUrl || "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
  const apiUrl = (path) => `${basePath}${path}`;
  const dataUrl = (path) => `${dataBaseUrl}${path}`;
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const addDays = (iso, n) => {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
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
          e("h1", null, config.subtitle),
          e("div", { className: "subtitle" }, config.title)
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
    return useMemo(() => Array.from({ length: 30 }, (_, i) => addDays(start, i)), [start]);
  }

  function hashText(value) {
    return String(value).split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  }

  function forecastTrend(basinId, date) {
    return ((hashText(basinId) + new Date(date + "T00:00:00").getDate()) % 2) === 0 ? "up" : "down";
  }

  function metObservationValues(station, date) {
    const day = new Date(date + "T00:00:00").getDate();
    const seed = hashText(station.id) % 11;
    if (station.type === "precipitation") {
      const observed = Math.max(0, Math.round((day + seed) % 18));
      const simulated = Math.max(0, Math.round(observed * 0.86 + (seed % 4)));
      return { observed: `${observed} mm`, simulated: `${simulated} mm` };
    }
    const observed = Math.round(-4 + ((day + seed) % 24));
    const simulated = Math.round(observed + ((seed % 5) - 2));
    return { observed: `${observed} C`, simulated: `${simulated} C` };
  }

  function metObservationNumbers(station, date) {
    const day = new Date(date + "T00:00:00").getDate();
    const seed = hashText(station.id) % 11;
    if (station.type === "precipitation") {
      const observed = Math.max(0, Math.round((day + seed) % 18));
      return { observed, simulated: Math.max(0, Math.round(observed * 0.86 + (seed % 4))) };
    }
    const observed = Math.round(-4 + ((day + seed) % 24));
    return { observed, simulated: Math.round(observed + ((seed % 5) - 2)) };
  }

  function dateRange(start, end) {
    const dates = [];
    let d = new Date(start + "T00:00:00");
    const last = new Date(end + "T00:00:00");
    while (d <= last) {
      dates.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    return dates;
  }

  function metPopupSvg(station, rows, width, height) {
    const w = Math.max(260, width || 330), h = Math.max(120, height || 150);
    const left = 34, right = 10, top = 14, bottom = 24;
    const values = rows.flatMap(r => [r.observed, r.simulated]);
    const min = Math.min(...values), max = Math.max(...values);
    const x = i => left + (i / Math.max(1, rows.length - 1)) * (w - left - right);
    const y = v => h - bottom - ((v - min) / Math.max(1, max - min)) * (h - top - bottom);
    const obsPts = rows.map((r, i) => `${x(i)},${y(r.observed)}`).join(" ");
    const simPts = rows.map((r, i) => `${x(i)},${y(r.simulated)}`).join(" ");
    const ticks = Array.from({ length: 4 }, (_, i) => min + ((max - min) * i) / 3);
    const unit = station.type === "precipitation" ? "mm" : "C";
    return `
      <svg class="met-popup-plot" width="100%" height="100%">
        ${ticks.map(t => `<line x1="${left}" y1="${y(t)}" x2="${w - right}" y2="${y(t)}" class="grid" /><text x="4" y="${y(t) + 3}" class="axis">${Math.round(t)} ${unit}</text>`).join("")}
        <line x1="${left}" y1="${h - bottom}" x2="${w - right}" y2="${h - bottom}" class="axis-line" />
        <line x1="${left}" y1="${top}" x2="${left}" y2="${h - bottom}" class="axis-line" />
        <polyline points="${obsPts}" class="obs-line" />
        <polyline points="${simPts}" class="sim-line" />
        <text x="${left}" y="${h - 6}" class="date">${rows[0]?.date?.slice(5) || ""}</text>
        <text x="${w - right - 34}" y="${h - 6}" class="date">${rows[rows.length - 1]?.date?.slice(5) || ""}</text>
      </svg>
    `;
  }

  function createMetPopup(station, selectedDate) {
    const container = document.createElement("div");
    container.className = "met-popup";
    let start = addDays(selectedDate, -14);
    let end = selectedDate;
    const render = () => {
      if (new Date(start) > new Date(end)) [start, end] = [end, start];
      const rows = dateRange(start, end).map(date => ({ date, ...metObservationNumbers(station, date) }));
      const plotWidth = Math.max(260, container.clientWidth - 16);
      const plotHeight = Math.max(120, container.clientHeight - 92);
      container.innerHTML = `
        <div class="met-popup-title">${station.label}</div>
        <div class="met-popup-controls">
          <label>Start <input type="date" data-role="start" value="${start}"></label>
          <label>End <input type="date" data-role="end" value="${end}"></label>
        </div>
        <div class="met-popup-legend"><span class="obs">Observed</span><span class="sim">Simulated</span></div>
        ${metPopupSvg(station, rows, plotWidth, plotHeight)}
      `;
      container.querySelector('[data-role="start"]').addEventListener("change", ev => { start = ev.target.value; render(); });
      container.querySelector('[data-role="end"]').addEventListener("change", ev => { end = ev.target.value; render(); });
    };
    container.refreshPlot = render;
    render();
    return container;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function openMetPopupOverlay(map, station, selectedDate, latLng) {
    const mapEl = map.getContainer();
    mapEl.querySelectorAll(".met-floating-popup").forEach(el => el.remove());

    const popup = document.createElement("div");
    popup.className = "met-floating-popup";
    popup.style.width = "390px";
    popup.style.height = "300px";

    const close = document.createElement("button");
    close.className = "met-floating-close";
    close.textContent = "X";
    close.addEventListener("click", () => popup.remove());

    const content = createMetPopup(station, selectedDate);
    const resize = document.createElement("div");
    resize.className = "met-resize-handle";

    popup.append(close, content, resize);
    mapEl.appendChild(popup);

    const constrain = (left, top, width = popup.offsetWidth, height = popup.offsetHeight) => {
      const margin = 6;
      const maxLeft = Math.max(margin, mapEl.clientWidth - width - margin);
      const maxTop = Math.max(margin, mapEl.clientHeight - height - margin);
      return {
        left: clamp(left, margin, maxLeft),
        top: clamp(top, margin, maxTop)
      };
    };

    const point = map.latLngToContainerPoint(latLng);
    const startPos = constrain(point.x + 14, point.y - 40);
    popup.style.left = `${startPos.left}px`;
    popup.style.top = `${startPos.top}px`;

    content.querySelector(".met-popup-title").classList.add("draggable");
    content.querySelector(".met-popup-title").addEventListener("pointerdown", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
      const rect = popup.getBoundingClientRect();
      const mapRect = mapEl.getBoundingClientRect();
      const currentLeft = parseFloat(popup.style.left) || (rect.left - mapRect.left);
      const currentTop = parseFloat(popup.style.top) || (rect.top - mapRect.top);
      const dx = ev.clientX - mapRect.left - currentLeft;
      const dy = ev.clientY - mapRect.top - currentTop;
      const move = moveEv => {
        const pos = constrain(
          moveEv.clientX - mapRect.left - dx,
          moveEv.clientY - mapRect.top - dy,
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
        const maxW = mapEl.clientWidth - left - margin;
        const maxH = mapEl.clientHeight - top - margin;
        popup.style.width = `${clamp(startW + moveEv.clientX - startX, 300, maxW)}px`;
        popup.style.height = `${clamp(startH + moveEv.clientY - startY, 230, maxH)}px`;
      };
      const up = () => {
        content.refreshPlot?.();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  function HopsMap({ id, config, date, variable, mode, showRivers, showPoints, showObs, obsType, basins, obsStations, onBasin, masterRef, slaveRef, basinId, passive }) {
    const divRef = useRef(null);
    const mapRef = useRef(null);
    const layersRef = useRef([]);
    const syncing = useRef(false);

    useEffect(() => {
      const map = L.map(divRef.current, {
        minZoom: config.minZoom,
        maxBounds: config.maxBounds,
        maxBoundsViscosity: 0.85,
        zoomControl: !passive,
        dragging: !passive,
        scrollWheelZoom: !passive,
        doubleClickZoom: !passive,
        boxZoom: !passive,
        keyboard: !passive,
        tap: !passive,
        touchZoom: !passive
      }).setView(config.defaultCenter, config.defaultZoom);
      L.tileLayer(tileUrl, { maxZoom: 12 }).addTo(map);
      if (passive) {
        map.getContainer().setAttribute("aria-label", "Map B mirrors Map A");
        map.getContainer().classList.add("passive-map");
      }
      mapRef.current = map;
      if (masterRef && !masterRef.current) masterRef.current = map;
      if (slaveRef) slaveRef.current = map;
      return () => map.remove();
    }, [passive]);

    useEffect(() => {
      const map = mapRef.current;
      if (!map || !masterRef || !slaveRef) return;
      const sync = () => {
        if (syncing.current || masterRef.current !== map || !slaveRef.current) return;
        syncing.current = true;
        slaveRef.current.setView(map.getCenter(), Math.max(config.minZoom, map.getZoom()), { animate: false });
        setTimeout(() => syncing.current = false, 40);
      };
      map.on("moveend zoomend", sync);
      return () => map.off("moveend zoomend", sync);
    }, [masterRef, slaveRef]);

    useEffect(() => {
      const map = mapRef.current;
      if (!map) return;
      layersRef.current.forEach(l => map.removeLayer(l));
      layersRef.current = [];
      const selectedBasin = basins.find(b => b.id === basinId);
      const overlayVar = mode === "obs" ? (variable || "temperature") : variable;
      const png = dataUrl(`/png/${overlayVar}/${date}.png`);
      const img = L.imageOverlay(png, config.overlayBounds, { opacity: mode === "obs" ? 0.45 : 0.58, crossOrigin: true }).addTo(map);
      layersRef.current.push(img);
      if (showRivers) {
        fetch(dataUrl("/geojson/rivers.geojson")).then(r => r.json()).then(g => {
          const l = L.geoJSON(g, { style: { color: "#5fd1ff", weight: 2, opacity: 0.8 } }).addTo(map);
          layersRef.current.push(l);
        });
      }
      if (basinId && selectedBasin) {
        fetch(dataUrl(`/shapefiles/${basinId}.geojson`)).then(r => r.json()).then(g => {
          const l = L.geoJSON(g, { style: { color: "#f8d56b", weight: 2, fillColor: "#f8d56b", fillOpacity: 0.13 } }).addTo(map);
          layersRef.current.push(l);
          map.fitBounds(l.getBounds(), { maxZoom: 8 });
        });
      }
      if (showPoints) {
        basins.forEach(b => {
          const trend = forecastTrend(b.id, date);
          const marker = L.marker([b.lat, b.lon], {
            icon: L.divIcon({
              html: `<div class="forecast-marker ${trend}"><span class="marker-dot"></span><span class="trend-arrow">${trend === "up" ? "▲" : "▼"}</span></div>`,
              className: "",
              iconSize: [42, 24],
              iconAnchor: [8, 12]
            })
          }).addTo(map);
          marker.bindTooltip(`${b.label} streamflow ${trend === "up" ? "rising" : "falling"}`);
          marker.on("click", () => onBasin && onBasin(b.id));
          layersRef.current.push(marker);
        });
      }
      if (showObs) {
        (obsStations || []).filter(station => !obsType || station.type === obsType).forEach(station => {
          const color = station.type === "precipitation" ? "#66d9ef" : "#f1c45b";
          const values = metObservationValues(station, date);
          const marker = L.marker([station.lat, station.lon], {
            icon: L.divIcon({
              html: `<div class="met-marker" style="--met-color:${color}"><span class="met-dot"></span><span class="met-value"><b>Obs</b> ${values.observed}</span><span class="met-value simulated"><b>Sim</b> ${values.simulated}</span></div>`,
              className: "",
              iconSize: [146, 24],
              iconAnchor: [8, 12]
            })
          }).addTo(map);
          marker.bindTooltip(`${station.label}: Observed ${values.observed}, Simulated ${values.simulated}`);
          marker.on("click", () => openMetPopupOverlay(map, station, date, [station.lat, station.lon]));
          layersRef.current.push(marker);
        });
      }
    }, [date, variable, mode, showRivers, showPoints, showObs, obsType, basinId, obsStations]);

    return e("div", { id, ref: divRef, className: "map" + (basinId ? " basin-map" : "") });
  }

  function MainView({ config, openBasin }) {
    const [start, setStart] = useState(addDays(todayISO(), -15));
    const dates = useDateSequence(start);
    const [date, setDate] = useState(todayISO());
    const [varA, setVarA] = useState(config.variables[0].id);
    const [varB, setVarB] = useState(config.variables[3].id);
    const [animate, setAnimate] = useState(false);
    const [showRivers, setShowRivers] = useState(true);
    const [showObs, setShowObs] = useState(true);
    const [obsType, setObsType] = useState("temperature");
    const mapA = useRef(null);
    const mapB = useRef(null);

    useEffect(() => {
      if (!animate) return;
      const t = setInterval(() => setDate(d => dates[(dates.indexOf(d) + 1 + dates.length) % dates.length] || dates[0]), 850);
      return () => clearInterval(t);
    }, [animate, dates]);

    const reset = () => { setStart(addDays(todayISO(), -15)); setDate(todayISO()); };
    return e("main", { className: "main-grid" },
        e("section", { className: "panel map-panel" },
          e("div", { className: "panel-head panel-head-map-a" },
          e("select", { value: varA, onChange: ev => setVarA(ev.target.value) }, config.variables.map(v => e("option", { key: v.id, value: v.id }, v.label))),
          e("div", { className: "control-row map-a-layer-toggle" },
            e("label", null, e("input", { type: "checkbox", checked: showRivers, onChange: ev => setShowRivers(ev.target.checked) }), "River network")
          )
        ),
        e(HopsMap, { id: "map-a", config, date, variable: varA, showRivers, showPoints: showRivers, showObs: false, basins: config.basins, onBasin: openBasin, masterRef: mapA, slaveRef: mapB })
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
        e("div", { className: "date-list" }, dates.map(d => e("button", { key: d, onClick: () => setDate(d), className: `date-button ${d === date ? "active" : ""} ${d === todayISO() ? "today" : ""}` }, d === todayISO() ? "Today" : d)))
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
            e("select", { value: varB, onChange: ev => setVarB(ev.target.value) }, config.variables.map(v => e("option", { key: v.id, value: v.id }, v.label)))
          )
        ),
        e(HopsMap, { id: "map-b", config, date, variable: varB, showRivers: false, showPoints: false, showObs, obsType, basins: config.basins, obsStations: config.observationStations, masterRef: mapA, slaveRef: mapB, passive: true })
      )
    );
  }

  function rangeRows(rows, selected, days) {
    const end = rows.findIndex(r => r.date === selected);
    const safeEnd = end >= 0 ? end : rows.length - 1;
    return rows.slice(Math.max(0, safeEnd - days + 1), safeEnd + 1);
  }

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

  function Plot({ rows, series, selected, onPick }) {
    const w = 900, h = 220;
    const padLeft = 44, padRight = 18, padTop = 22, padBottom = 30;
    const values = rows.flatMap(r => series.map(s => +r[s.id]).filter(Number.isFinite));
    const min = Math.min(...values), max = Math.max(...values);
    const x = i => padLeft + (i / Math.max(1, rows.length - 1)) * (w - padLeft - padRight);
    const y = v => h - padBottom - ((v - min) / Math.max(1, max - min)) * (h - padTop - padBottom);
    const selectedIndex = Math.max(0, rows.findIndex(r => r.date === selected));
    const yTicks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);
    const xTickCount = Math.min(6, rows.length);
    const xTickIdxs = Array.from({ length: xTickCount }, (_, i) => Math.round((i / Math.max(1, xTickCount - 1)) * (rows.length - 1)));
    const shortDate = iso => iso ? iso.slice(5) : "";
    return e("div", { className: "plot", onClick: ev => {
      const rect = ev.currentTarget.getBoundingClientRect();
      const pct = (ev.clientX - rect.left) / rect.width;
      const idx = Math.max(0, Math.min(rows.length - 1, Math.round(pct * (rows.length - 1))));
      onPick(rows[idx].date);
    }},
      e("svg", { className: "plot-canvas", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none" },
        ...yTicks.map((tick, i) => e("line", { key: `y-grid-${i}`, x1: padLeft, y1: y(tick), x2: w - padRight, y2: y(tick), stroke: "#24404d", opacity: 0.45, vectorEffect: "non-scaling-stroke" })),
        ...xTickIdxs.map((idx, i) => e("line", { key: `x-grid-${i}`, x1: x(idx), y1: padTop, x2: x(idx), y2: h - padBottom, stroke: "#24404d", opacity: 0.28, vectorEffect: "non-scaling-stroke" })),
        e("line", { x1: padLeft, y1: h - padBottom, x2: w - padRight, y2: h - padBottom, stroke: "#314858", vectorEffect: "non-scaling-stroke" }),
        e("line", { x1: padLeft, y1: padTop, x2: padLeft, y2: h - padBottom, stroke: "#314858", vectorEffect: "non-scaling-stroke" }),
        ...yTicks.map((tick, i) => e("line", { key: `y-tick-${i}`, x1: padLeft - 4, y1: y(tick), x2: padLeft, y2: y(tick), stroke: "#7f96a3", vectorEffect: "non-scaling-stroke" })),
        ...xTickIdxs.map((idx, i) => e("line", { key: `x-tick-${i}`, x1: x(idx), y1: h - padBottom, x2: x(idx), y2: h - padBottom + 4, stroke: "#7f96a3", vectorEffect: "non-scaling-stroke" })),
        ...series.map(s => e("polyline", { key: s.id, fill: "none", stroke: s.color, strokeWidth: 2, vectorEffect: "non-scaling-stroke", points: rows.map((r, i) => `${x(i)},${y(+r[s.id])}`).join(" ") })),
        e("line", { x1: x(selectedIndex), y1: padTop, x2: x(selectedIndex), y2: h - padBottom, stroke: "#ffffff", strokeDasharray: "4 4", vectorEffect: "non-scaling-stroke" })
      ),
      e("div", { className: "plot-y-labels" }, yTicks.map((tick, i) => e("span", { key: i, style: { bottom: `${(i / 4) * 100}%` } }, fmt(tick)))),
      e("div", { className: "plot-x-labels" }, xTickIdxs.map((idx, i) => e("span", { key: i, style: { left: `${((x(idx) - padLeft) / (w - padLeft - padRight)) * 100}%` } }, shortDate(rows[idx]?.date)))),
      e("div", { className: "plot-labels" }, series.map(s => e("span", { key: s.id, style: { color: s.color } }, s.label)))
    );
  }

  function BasinView({ config, basinId, close }) {
    const basin = config.basins.find(b => b.id === basinId) || config.basins[0];
    const [rows, setRows] = useState([]);
    const [date, setDate] = useState(todayISO());
    const [mapVar, setMapVar] = useState(config.variables[0].id);
    const [varA, setVarA] = useState(config.variables[0].id);
    const [varB, setVarB] = useState("runoff");
    const [days, setDays] = useState(30);
    const [models, setModels] = useState(["hops", "hops_xgb"]);
    const [topPlotPct, setTopPlotPct] = useState(52);
    const plotsRef = useRef(null);
    useEffect(() => { fetch(apiUrl(`/api/timeseries/${basin.id}`)).then(r => r.json()).then(d => setRows(d.rows)); }, [basin.id]);
    const visible = useMemo(() => {
      if (!rows.length) return [];
      const todayIndex = rows.findIndex(r => r.date === todayISO());
      const end = todayIndex >= 0 ? todayIndex : rows.length - 1;
      return rows.slice(Math.max(0, end - days + 1), end + 1);
    }, [rows, days]);
    useEffect(() => {
      if (!visible.length) return;
      if (!visible.some(r => r.date === date)) setDate(visible[visible.length - 1].date);
    }, [visible, date]);
    const toggleModel = id => setModels(m => m.includes(id) ? m.filter(x => x !== id) : [...m, id]);
    const variableSeries = [config.variables.find(v => v.id === varA), varB === "none" ? null : config.variables.find(v => v.id === varB)].filter(Boolean).map(v => ({ id: v.id, label: v.label, color: v.palette }));
    const streamSeries = [{ id: "observations", label: "Observations", color: "#ffffff" }, ...config.models.filter(m => models.includes(m.id)).map(m => ({ id: m.id, label: m.label, color: m.color }))];
    const scrubberIndex = Math.max(0, visible.findIndex(r => r.date === date));
    const scrubberPct = visible.length > 1 ? scrubberIndex / (visible.length - 1) : 1;
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
    return e("main", { className: "basin-view" },
      e("div", { className: "basin-workspace" },
        e("section", { className: "basin-plots", ref: plotsRef, style: { gridTemplateRows: `minmax(0, ${topPlotPct}fr) auto minmax(0, ${100 - topPlotPct}fr)` } },
          e("section", { className: "panel plot-panel" },
            e("div", { className: "plot-head" },
              e("strong", null, "Variable A + B"),
              e("div", { className: "control-row" },
                e("select", { value: varA, onChange: ev => setVarA(ev.target.value) }, config.variables.map(v => e("option", { key: v.id, value: v.id }, v.label))),
                e("select", { value: varB, onChange: ev => setVarB(ev.target.value) }, e("option", { value: "none" }, "B = NONE"), ...config.variables.map(v => e("option", { key: v.id, value: v.id }, v.label)))
              )
            ),
            visible.length && e(Plot, { rows: visible, series: variableSeries, selected: date, onPick: setDate })
          ),
          e("div", { className: "plot-resizer", onPointerDown: startPlotResize, title: "Drag to resize plots" },
            [30, 90, 180, 365].map((d, i) => e("button", { key: d, className: days === d ? "active" : "", onClick: () => setDays(d) }, ["1M", "3M", "6M", "1Y"][i])),
            e("div", { className: "models" }, config.models.map(m => e("label", { key: m.id }, e("input", { type: "checkbox", checked: models.includes(m.id), onChange: () => toggleModel(m.id) }), m.label)))
          ),
          e("section", { className: "panel plot-panel stream-panel" },
            e("div", { className: "plot-head" }, e("strong", null, "Streamflow"), e("span", { style: { color: "var(--muted)" } }, "Observations always shown")),
            visible.length && e(Plot, { rows: visible, series: streamSeries, selected: date, onPick: setDate }),
            e("div", { className: "stats" }, config.models.filter(m => models.includes(m.id)).map(m => {
              const s = visible.length ? metrics(visible, m.id) : {};
              return e("div", { className: "stat", key: m.id }, e("strong", { style: { color: m.color } }, m.label), e("span", null, `RMSE ${fmt(s.rmse)}`), e("span", null, `NSE ${fmt(s.nse)}`), e("span", null, `KGE ${fmt(s.kge)}`));
            }))
          )
        ),
        e("aside", { className: "panel basin-date-rail" },
          e("div", { className: "scrubber-date-label", style: { top: `calc(14px + ${scrubberPct} * (100% - 28px))` } }, date),
          e("div", { className: "scrubber-track-wrap" },
            e("span", { className: "scrubber-end scrubber-start" }, visible[0]?.date || ""),
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
            e("strong", null, "Basin Map"),
            e("select", { value: mapVar, onChange: ev => setMapVar(ev.target.value) }, config.variables.map(v => e("option", { key: v.id, value: v.id }, v.label)))
          ),
          e(HopsMap, { id: "basin-map", config, date, variable: mapVar, showRivers: true, showPoints: true, showObs: true, basins: [basin], basinId: basin.id })
        )
      )
    );
  }

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
