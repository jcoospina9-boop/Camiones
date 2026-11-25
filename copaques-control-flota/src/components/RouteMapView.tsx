import L from 'leaflet';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  Layers,
  LocateFixed,
  MapPin,
  Navigation,
  Pencil,
  PlusCircle,
  RotateCcw,
  Route as RouteIcon,
  Save,
  Trash2,
  Truck,
} from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import {
  formatEventLabel,
  formatMinutesAsHours,
  getColombiaToday,
  type FleetEvent,
  type PlannedRoute,
  type PlannedWaypoint,
  type RouteResponse,
  type Sede,
  type UserRole,
  type Vehicle,
} from '../types.ts';

interface RouteMapViewProps {
  vehicles: Vehicle[];
  sedes: Sede[];
  selectedSedeId: number | null;
  userRole: UserRole;
  onCreateGeofenceFromPoint: (point: { lat: number; lng: number; suggestedName: string }) => void;
}

type TileLayerKey = 'esri' | 'topo' | 'satellite';
type MapMode = 'gps' | 'draw';

const TILE_LAYERS: Record<TileLayerKey, { label: string; url: string; attribution: string }> = {
  esri: {
    label: 'Esri Calles',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
  },
  topo: {
    label: 'Esri Topográfico',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
  },
  satellite: {
    label: 'Satélite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
  },
};

function markerColor(type: FleetEvent['event_type']): string {
  switch (type) {
    case 'INICIO_JORNADA':
      return '#064e3b';
    case 'ENTRADA':
      return '#15803d';
    case 'SALIDA':
      return '#eab308';
    case 'FIN_JORNADA':
      return '#dc2626';
  }
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

async function fetchRoadGeometry(
  points: Array<{ lat: number; lng: number }>,
  signal: AbortSignal
): Promise<{ coords: [number, number][]; distanceKm: number } | null> {
  if (points.length < 2) return null;
  // OSRM works cleanly up to ~25 waypoints; sample if huge
  let sampled = points;
  if (points.length > 25) {
    const step = (points.length - 1) / 24;
    sampled = Array.from({ length: 25 }, (_, i) => points[Math.round(i * step)]);
  }
  const coordsParam = sampled.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coordsParam}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance?: number;
        geometry?: { coordinates?: Array<[number, number]> };
      }>;
    };
    const route = data.routes?.[0];
    const rawCoords = route?.geometry?.coordinates;
    if (!rawCoords || rawCoords.length < 2) return null;
    return {
      coords: rawCoords.map(([lng, lat]) => [lat, lng]),
      distanceKm: route.distance ? Math.round((route.distance / 1000) * 100) / 100 : 0,
    };
  } catch {
    return null;
  }
}

export function RouteMapView({
  vehicles,
  sedes,
  selectedSedeId,
  onCreateGeofenceFromPoint,
}: RouteMapViewProps) {
  const [mode, setMode] = useState<MapMode>('gps');
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>(
    vehicles.length > 0 ? String(vehicles[0].id) : ''
  );
  const [selectedDate, setSelectedDate] = useState<string>(getColombiaToday());
  const [tileStyle, setTileStyle] = useState<TileLayerKey>('esri');
  const [snapToRoads, setSnapToRoads] = useState<boolean>(true);
  const [routeData, setRouteData] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeEventId, setActiveEventId] = useState<number | null>(null);

  // Interactive route digitizer ("Trazar Ruta en Mapa") state
  const [draftPoints, setDraftPoints] = useState<PlannedWaypoint[]>([]);
  const [draftDistanceKm, setDraftDistanceKm] = useState<number>(0);
  const [draftName, setDraftName] = useState('');
  const [savingDraft, setSavingDraft] = useState(false);
  const [plannedRoutes, setPlannedRoutes] = useState<PlannedRoute[]>([]);
  const [activePlannedRouteId, setActivePlannedRouteId] = useState<number | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const tileErrorCountRef = useRef(0);
  const gpsLayerRef = useRef<L.LayerGroup | null>(null);
  const draftLayerRef = useRef<L.LayerGroup | null>(null);
  const markerByIdRef = useRef<Map<number, L.Marker>>(new Map());
  const modeRef = useRef<MapMode>(mode);
  modeRef.current = mode;

  const activeSede = useMemo(
    () => sedes.find((s) => s.id === selectedSedeId) ?? sedes[0] ?? null,
    [sedes, selectedSedeId]
  );

  // Sync selectedVehicleId when vehicles list changes (e.g. sede switched)
  useEffect(() => {
    if (vehicles.length === 0) {
      setSelectedVehicleId('');
      setRouteData(null);
      return;
    }
    const exists = vehicles.some((v) => String(v.id) === selectedVehicleId);
    if (!exists) {
      setSelectedVehicleId(String(vehicles[0].id));
    }
  }, [vehicles, selectedVehicleId]);

  const loadRoute = useCallback(async () => {
    if (!selectedVehicleId) {
      setRouteData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<RouteResponse>(
        `/api/admin/route?vehicleId=${encodeURIComponent(selectedVehicleId)}&date=${encodeURIComponent(selectedDate)}`
      );
      setRouteData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar recorrido.');
    } finally {
      setLoading(false);
    }
  }, [selectedVehicleId, selectedDate]);

  const loadPlannedRoutes = useCallback(async () => {
    try {
      const qs = selectedSedeId ? `?sedeId=${selectedSedeId}` : '';
      const res = await apiFetch<{ routes: PlannedRoute[] }>(`/api/admin/planned-routes${qs}`);
      setPlannedRoutes(res.routes);
    } catch {
      // ignore non-fatal planned route load errors
    }
  }, [selectedSedeId]);

  useEffect(() => {
    loadRoute();
  }, [loadRoute]);

  useEffect(() => {
    loadPlannedRoutes();
  }, [loadPlannedRoutes]);

  // Initialize Leaflet map once with ResizeObserver & click handler for digitizer
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el || mapRef.current) return;

    const initialCenter: [number, number] = activeSede
      ? [activeSede.latitude, activeSede.longitude]
      : [6.2442, -75.5812];

    const map = L.map(el, {
      center: initialCenter,
      zoom: 12,
      zoomControl: true,
    });

    const gpsGroup = L.layerGroup().addTo(map);
    const draftGroup = L.layerGroup().addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      if (modeRef.current !== 'draw') return;
      const lat = Math.round(e.latlng.lat * 1000000) / 1000000;
      const lng = Math.round(e.latlng.lng * 1000000) / 1000000;
      setDraftPoints((prev) => [
        ...prev,
        { lat, lng, label: `Punto ${prev.length + 1}` },
      ]);
      setActivePlannedRouteId(null);
    });

    mapRef.current = map;
    gpsLayerRef.current = gpsGroup;
    draftLayerRef.current = draftGroup;

    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(el);
    const raf = requestAnimationFrame(() => map.invalidateSize());
    const t1 = setTimeout(() => map.invalidateSize(), 120);
    const t2 = setTimeout(() => map.invalidateSize(), 350);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      gpsLayerRef.current = null;
      draftLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch tile provider cleanly with automatic fallback on tile errors
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileLayerRef.current) {
      tileLayerRef.current.remove();
    }
    tileErrorCountRef.current = 0;
    const cfg = TILE_LAYERS[tileStyle];
    const layer = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom: 19,
    });
    layer.on('tileerror', () => {
      tileErrorCountRef.current += 1;
      if (tileErrorCountRef.current >= 4) {
        if (tileStyle === 'esri') setTileStyle('topo');
      }
    });
    layer.addTo(map);
    tileLayerRef.current = layer;
  }, [tileStyle]);

  // Render GPS Route mode layers
  useEffect(() => {
    const map = mapRef.current;
    const group = gpsLayerRef.current;
    if (!map || !group) return;

    group.clearLayers();
    markerByIdRef.current.clear();

    if (mode !== 'gps' || !routeData) return;

    const controller = new AbortController();

    // Active geofences overlay
    const gfCoords: L.LatLngExpression[] = [];
    for (const gf of routeData.geofences) {
      gfCoords.push([gf.latitude, gf.longitude]);
      const circle = L.circle([gf.latitude, gf.longitude], {
        radius: gf.radius_meters,
        color: '#15803d',
        weight: 1.5,
        dashArray: '4 4',
        fillColor: '#22c55e',
        fillOpacity: 0.1,
      });
      const gfPopup = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = gf.name;
      const meta = document.createElement('div');
      meta.className = 'text-xs text-slate-600 mt-0.5';
      meta.textContent = `${gf.category} · Radio ${gf.radius_meters} m`;
      gfPopup.appendChild(title);
      gfPopup.appendChild(meta);
      circle.bindPopup(gfPopup);
      circle.addTo(group);
    }

    // Combine chronological events + GPS breadcrumbs
    const traceWaypoints = [
      ...routeData.events.map((ev) => ({
        recorded_at: ev.recorded_at,
        lat: ev.latitude,
        lng: ev.longitude,
      })),
      ...(routeData.routePoints ?? []).map((pt) => ({
        recorded_at: pt.recorded_at,
        lat: pt.latitude,
        lng: pt.longitude,
      })),
    ].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));

    if (traceWaypoints.length === 0) {
      map.invalidateSize();
      if (gfCoords.length > 0) {
        map.fitBounds(L.latLngBounds(gfCoords), { padding: [48, 48], maxZoom: 13 });
      } else if (routeData.vehicle?.sede_lat && routeData.vehicle?.sede_lng) {
        map.setView([routeData.vehicle.sede_lat, routeData.vehicle.sede_lng], 13);
      } else if (activeSede) {
        map.setView([activeSede.latitude, activeSede.longitude], 13);
      }
      return () => controller.abort();
    }

    // Render subtle dots for continuous GPS breadcrumbs
    for (const pt of routeData.routePoints ?? []) {
      const dot = L.circleMarker([pt.latitude, pt.longitude], {
        radius: 4,
        color: '#065f46',
        weight: 1.5,
        fillColor: '#34d399',
        fillOpacity: 0.9,
      });
      const pDiv = document.createElement('div');
      pDiv.className = 'text-xs text-slate-700 font-mono';
      pDiv.textContent = `GPS ${pt.recorded_at.slice(11, 19)} · ${pt.latitude.toFixed(5)}, ${pt.longitude.toFixed(5)}`;
      dot.bindPopup(pDiv);
      dot.addTo(group);
    }

    // Draw straight GPS trace immediately so user always sees the line
    const directLatLngs: [number, number][] = traceWaypoints.map((w) => [w.lat, w.lng]);
    const mainPolyline = L.polyline(directLatLngs, {
      color: '#065f46',
      weight: 4,
      opacity: 0.85,
    }).addTo(group);

    // Numbered markers for all events
    routeData.events.forEach((ev, idx) => {
      const bg = markerColor(ev.event_type);
      const icon = L.divIcon({
        className: 'custom-route-pin',
        html: `<div style="width:28px;height:28px;border-radius:9999px;background:${bg};color:#ffffff;border:2px solid #ffffff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,0.35);">${idx + 1}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const marker = L.marker([ev.latitude, ev.longitude], {
        icon,
        zIndexOffset: 500 + idx,
      });

      const container = document.createElement('div');
      container.className = 'text-sm space-y-1 min-w-[210px]';

      const headerEl = document.createElement('div');
      headerEl.className = 'font-bold text-slate-900';
      headerEl.textContent = `#${idx + 1} · ${formatEventLabel(ev.event_type)}`;
      container.appendChild(headerEl);

      const timeEl = document.createElement('div');
      timeEl.className = 'text-xs font-mono text-slate-600';
      timeEl.textContent = `${ev.event_date} ${ev.event_time} · ${ev.source === 'GEOCERCA_AUTO' ? 'Geocerca Auto' : 'Manual'}`;
      container.appendChild(timeEl);

      const addrEl = document.createElement('div');
      addrEl.className = 'text-xs text-slate-700';
      addrEl.textContent = ev.geofence_name_snapshot
        ? `${ev.geofence_name_snapshot} — ${ev.address}`
        : ev.address;
      container.appendChild(addrEl);

      if (ev.notes) {
        const noteEl = document.createElement('div');
        noteEl.className = 'text-xs text-slate-500 italic';
        noteEl.textContent = `Nota: ${ev.notes}`;
        container.appendChild(noteEl);
      }

      const coordsEl = document.createElement('div');
      coordsEl.className = 'text-[11px] font-mono text-slate-400';
      coordsEl.textContent = `${ev.latitude.toFixed(5)}, ${ev.longitude.toFixed(5)}`;
      container.appendChild(coordsEl);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mt-2 w-full px-2.5 py-1.5 rounded bg-emerald-800 text-white text-xs font-medium cursor-pointer';
      btn.textContent = 'Crear geocerca aquí';
      btn.addEventListener('click', () => {
        onCreateGeofenceFromPoint({
          lat: ev.latitude,
          lng: ev.longitude,
          suggestedName: ev.address.split(',')[0] || `Punto ${ev.vehicle_code_snapshot}`,
        });
      });
      container.appendChild(btn);

      marker.bindPopup(container);
      marker.addTo(group);
      markerByIdRef.current.set(ev.id, marker);
    });

    map.invalidateSize();
    const bounds = L.latLngBounds(directLatLngs);
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });

    // Optionally snap trace to actual road geometry via OSRM
    if (snapToRoads && traceWaypoints.length >= 2) {
      fetchRoadGeometry(traceWaypoints, controller.signal).then((road) => {
        if (!road || controller.signal.aborted) return;
        mainPolyline.setLatLngs(road.coords);
      });
    }

    return () => controller.abort();
  }, [mode, routeData, snapToRoads, activeSede, onCreateGeofenceFromPoint]);

  // Render Interactive Route Digitizer ("Trazar Ruta en Mapa") layers
  useEffect(() => {
    const map = mapRef.current;
    const group = draftLayerRef.current;
    if (!map || !group) return;

    group.clearLayers();
    if (mode !== 'draw') return;

    const controller = new AbortController();

    if (draftPoints.length === 0) {
      setDraftDistanceKm(0);
      if (activeSede) {
        map.invalidateSize();
        map.setView([activeSede.latitude, activeSede.longitude], 13);
      }
      return () => controller.abort();
    }

    const directCoords: [number, number][] = draftPoints.map((p) => [p.lat, p.lng]);
    let straightKm = 0;
    for (let i = 1; i < draftPoints.length; i++) {
      straightKm += haversineKm(draftPoints[i - 1], draftPoints[i]);
    }
    setDraftDistanceKm(Math.round(straightKm * 100) / 100);

    const traceLine = L.polyline(directCoords, {
      color: '#0e7a2d',
      weight: 4,
      opacity: 0.9,
      dashArray: snapToRoads ? undefined : '6 6',
    }).addTo(group);

    draftPoints.forEach((pt, idx) => {
      const bg =
        idx === 0
          ? '#064e3b'
          : idx === draftPoints.length - 1
            ? '#dc2626'
            : '#eab308';
      const fg = idx > 0 && idx < draftPoints.length - 1 ? '#064e3b' : '#ffffff';

      const icon = L.divIcon({
        className: 'custom-draft-pin',
        html: `<div style="width:28px;height:28px;border-radius:9999px;background:${bg};color:${fg};border:2px solid #ffffff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,0.35);cursor:grab;">${idx + 1}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const marker = L.marker([pt.lat, pt.lng], {
        icon,
        draggable: true,
        zIndexOffset: 600 + idx,
      });

      marker.on('dragend', () => {
        const pos = marker.getLatLng();
        setDraftPoints((prev) =>
          prev.map((item, i) =>
            i === idx
              ? {
                  ...item,
                  lat: Math.round(pos.lat * 1000000) / 1000000,
                  lng: Math.round(pos.lng * 1000000) / 1000000,
                }
              : item
          )
        );
      });

      const popup = document.createElement('div');
      popup.className = 'text-xs space-y-1.5 min-w-[170px]';
      const title = document.createElement('div');
      title.className = 'font-bold text-slate-900';
      title.textContent = `Punto #${idx + 1}`;
      const coords = document.createElement('div');
      coords.className = 'font-mono text-[11px] text-slate-500';
      coords.textContent = `${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}`;
      const gfBtn = document.createElement('button');
      gfBtn.type = 'button';
      gfBtn.className = 'w-full px-2 py-1 rounded bg-emerald-800 text-white text-xs font-medium cursor-pointer';
      gfBtn.textContent = 'Crear geocerca aquí';
      gfBtn.addEventListener('click', () => {
        onCreateGeofenceFromPoint({
          lat: pt.lat,
          lng: pt.lng,
          suggestedName: pt.label || `Punto Ruta ${idx + 1}`,
        });
      });
      popup.appendChild(title);
      popup.appendChild(coords);
      popup.appendChild(gfBtn);

      marker.bindPopup(popup);
      marker.addTo(group);
    });

    if (snapToRoads && draftPoints.length >= 2) {
      fetchRoadGeometry(draftPoints, controller.signal).then((road) => {
        if (!road || controller.signal.aborted) return;
        traceLine.setLatLngs(road.coords);
        if (road.distanceKm > 0) {
          setDraftDistanceKm(road.distanceKm);
        }
      });
    }

    return () => controller.abort();
  }, [mode, draftPoints, snapToRoads, activeSede, onCreateGeofenceFromPoint]);

  function focusEvent(ev: FleetEvent) {
    setActiveEventId(ev.id);
    const map = mapRef.current;
    const marker = markerByIdRef.current.get(ev.id);
    if (map && marker) {
      map.flyTo([ev.latitude, ev.longitude], 15, { duration: 0.4 });
      marker.openPopup();
    }
  }

  function centerOnMyLocation() {
    if (!('geolocation' in navigator) || !mapRef.current) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        mapRef.current?.flyTo([pos.coords.latitude, pos.coords.longitude], 14, { duration: 0.5 });
      },
      () => {
        setError('No se pudo obtener tu ubicación actual para centrar el mapa.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function handleSavePlannedRoute() {
    if (draftPoints.length < 2) {
      setError('Haz clic en el mapa para marcar al menos 2 puntos antes de guardar la ruta.');
      return;
    }
    const nameToSave = draftName.trim() || `Ruta ${activeSede?.name || 'Copaques'} (${draftPoints.length} pts)`;
    setSavingDraft(true);
    setError(null);
    try {
      const res = await apiFetch<{ route: PlannedRoute }>('/api/admin/planned-routes', {
        method: 'POST',
        body: JSON.stringify({
          name: nameToSave,
          sede_id: selectedSedeId || activeSede?.id || null,
          vehicle_id: selectedVehicleId ? Number(selectedVehicleId) : null,
          waypoints: draftPoints,
          distance_km: draftDistanceKm,
        }),
      });
      setDraftName('');
      setActivePlannedRouteId(res.route.id);
      await loadPlannedRoutes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar la ruta trazada.');
    } finally {
      setSavingDraft(false);
    }
  }

  function loadSavedPlannedRoute(r: PlannedRoute) {
    try {
      const pts = JSON.parse(r.waypoints_json) as PlannedWaypoint[];
      if (Array.isArray(pts) && pts.length > 0) {
        setMode('draw');
        setDraftPoints(pts);
        setActivePlannedRouteId(r.id);
        setTimeout(() => {
          if (mapRef.current && pts.length > 0) {
            mapRef.current.invalidateSize();
            mapRef.current.fitBounds(
              L.latLngBounds(pts.map((p) => [p.lat, p.lng] as [number, number])),
              { padding: [48, 48], maxZoom: 15 }
            );
          }
        }, 50);
      }
    } catch {
      setError('No se pudieron leer los puntos de la ruta guardada.');
    }
  }

  async function deleteSavedPlannedRoute(id: number) {
    try {
      await apiFetch(`/api/admin/planned-routes/${id}`, { method: 'DELETE' });
      if (activePlannedRouteId === id) {
        setActivePlannedRouteId(null);
      }
      await loadPlannedRoutes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar ruta.');
    }
  }

  return (
    <div className="space-y-5">
      {/* Mode Switch + Filter Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setMode('gps')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                mode === 'gps'
                  ? 'bg-white text-emerald-950 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Navigation className="w-3.5 h-3.5" />
              <span>Recorrido Real (GPS)</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('draw')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                mode === 'draw'
                  ? 'bg-white text-emerald-950 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Pencil className="w-3.5 h-3.5" />
              <span>Trazar / Digitar Ruta en Mapa</span>
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={snapToRoads}
              onChange={(e) => setSnapToRoads(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 accent-emerald-700"
            />
            <span>Ajustar trazo a carreteras</span>
          </label>
        </div>

        {mode === 'gps' ? (
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-[220px] flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Vehículo / Camión {activeSede && selectedSedeId ? `(${activeSede.name})` : ''}
              </label>
              <div className="relative">
                <Truck className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                <select
                  value={selectedVehicleId}
                  onChange={(e) => setSelectedVehicleId(e.target.value)}
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-300 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
                >
                  {vehicles.length === 0 && <option value="">No hay vehículos en esta sede</option>}
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.code} · {v.plate} {v.assigned_driver_name ? `(${v.assigned_driver_name})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="w-48">
              <label className="block text-xs font-medium text-slate-600 mb-1">Fecha</label>
              <div className="relative">
                <Calendar className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-300 text-sm text-slate-900 bg-white font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
              </div>
            </div>

            <div className="w-44">
              <label className="block text-xs font-medium text-slate-600 mb-1">Vista del Mapa</label>
              <div className="relative">
                <Layers className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                <select
                  value={tileStyle}
                  onChange={(e) => setTileStyle(e.target.value as TileLayerKey)}
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-300 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
                >
                  {(Object.keys(TILE_LAYERS) as TileLayerKey[]).map((key) => (
                    <option key={key} value={key}>
                      {TILE_LAYERS[key].label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              type="button"
              onClick={centerOnMyLocation}
              className="h-10 px-3.5 rounded-lg border border-slate-200 bg-white hover:bg-emerald-50 text-xs font-semibold text-emerald-900 flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <LocateFixed className="w-3.5 h-3.5" />
              <span>Mi ubicación</span>
            </button>

            <button
              type="button"
              onClick={() => setSelectedDate(getColombiaToday())}
              className="h-10 px-4 rounded-lg border border-slate-200 bg-white hover:bg-emerald-50 text-xs font-semibold text-emerald-900 cursor-pointer whitespace-nowrap shrink-0"
            >
              Hoy
            </button>

            <button
              type="button"
              onClick={loadRoute}
              disabled={loading || !selectedVehicleId}
              className="h-10 px-4 rounded-lg bg-[#0e7a2d] hover:bg-[#0b6123] text-white text-xs font-semibold cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              {loading ? 'Cargando...' : 'Actualizar Mapa'}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Nombre de la ruta a trazar
              </label>
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={`Ej. Ruta Despacho ${activeSede?.name || 'Norte'}`}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
              />
            </div>

            <div className="w-44">
              <label className="block text-xs font-medium text-slate-600 mb-1">Vista del Mapa</label>
              <select
                value={tileStyle}
                onChange={(e) => setTileStyle(e.target.value as TileLayerKey)}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm text-slate-900 bg-white"
              >
                {(Object.keys(TILE_LAYERS) as TileLayerKey[]).map((key) => (
                  <option key={key} value={key}>
                    {TILE_LAYERS[key].label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={() => setDraftPoints((prev) => prev.slice(0, -1))}
              disabled={draftPoints.length === 0}
              className="h-10 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 flex items-center gap-1.5 cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Deshacer punto</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setDraftPoints([]);
                setActivePlannedRouteId(null);
              }}
              disabled={draftPoints.length === 0}
              className="h-10 px-3 rounded-lg border border-slate-200 bg-white hover:bg-red-50 text-xs font-semibold text-red-700 flex items-center gap-1.5 cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Limpiar</span>
            </button>

            <button
              type="button"
              onClick={handleSavePlannedRoute}
              disabled={savingDraft || draftPoints.length < 2}
              className="h-10 px-4 rounded-lg bg-[#0e7a2d] hover:bg-[#0b6123] text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{savingDraft ? 'Guardando...' : 'Guardar Ruta'}</span>
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Helpful date jumper when selected date has no GPS events/points */}
      {mode === 'gps' &&
        routeData &&
        routeData.events.length === 0 &&
        (routeData.routePoints?.length ?? 0) === 0 &&
        routeData.availableDates.length > 0 && (
          <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-amber-900 font-medium">
              No hay puntos GPS registrados para <strong>{routeData.vehicle.code}</strong> el{' '}
              <span className="font-mono">{selectedDate}</span>. Fechas recientes con recorrido:
            </p>
            <div className="flex flex-wrap gap-2">
              {routeData.availableDates.slice(0, 5).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setSelectedDate(d)}
                  className="px-2.5 py-1 rounded-md bg-white border border-amber-300 hover:bg-amber-100 text-xs font-mono font-semibold text-amber-950 cursor-pointer"
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}

      {/* Route Summary Metrics */}
      {mode === 'gps' && routeData && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <p className="text-xs text-slate-500">Eventos del día</p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
              {routeData.summary.totalEvents}
              {routeData.summary.gpsPointsCount > 0 && (
                <span className="text-xs font-normal text-slate-500">
                  {' '}
                  (+{routeData.summary.gpsPointsCount} GPS)
                </span>
              )}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <p className="text-xs text-slate-500">Entradas</p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums text-emerald-700">
              {routeData.summary.entriesCount}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <p className="text-xs text-slate-500">Salidas</p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums text-amber-700">
              {routeData.summary.exitsCount}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <p className="text-xs text-slate-500">Distancia recorrida</p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
              {routeData.summary.distanceKm} km
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <p className="text-xs text-slate-500">Duración jornada</p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
              {formatMinutesAsHours(routeData.summary.shiftDurationMinutes)}
            </p>
          </div>
        </div>
      )}

      {mode === 'draw' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <p className="text-xs text-slate-500">Puntos marcados</p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
              {draftPoints.length}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <p className="text-xs text-slate-500">Distancia estimada del trazo</p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums text-emerald-800">
              {draftDistanceKm} km
            </p>
          </div>
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3.5 col-span-2 sm:col-span-1 flex items-center text-xs text-emerald-900 font-medium">
            Haz clic en cualquier punto del mapa para ir marcando y trazando la ruta. Arrastra un pin para ajustarlo.
          </div>
        </div>
      )}

      {/* Map + Timeline / Waypoints Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <div className="flex items-center gap-2 font-semibold text-slate-900">
              <RouteIcon className="w-4 h-4 text-emerald-700" />
              <span>
                {mode === 'gps'
                  ? `Trazado de Recorrido (${TILE_LAYERS[tileStyle].label})`
                  : `Modo Trazador Interactivo (${TILE_LAYERS[tileStyle].label})`}
              </span>
            </div>
            {mode === 'gps' ? (
              <div className="flex items-center gap-3">
                <span className="text-slate-900 font-medium">Inicio</span>
                <span className="text-emerald-700 font-medium">Entrada</span>
                <span className="text-amber-700 font-medium">Salida</span>
                <span className="text-red-700 font-medium">Fin</span>
              </div>
            ) : (
              <span className="text-emerald-800 font-semibold">
                Clic en el mapa = agregar punto · Arrastrar = mover
              </span>
            )}
          </div>
          <div
            ref={mapContainerRef}
            className={`w-full h-[500px] min-h-[500px] ${mode === 'draw' ? 'cursor-crosshair' : ''}`}
          />
        </div>

        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl flex flex-col max-h-[545px]">
          {mode === 'gps' ? (
            <>
              <div className="px-4 py-3 border-b border-slate-200">
                <h3 className="text-sm font-bold text-slate-900">Secuencia del Recorrido</h3>
                <p className="text-xs text-slate-500">
                  Haz clic en un punto para centrar el mapa
                </p>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
                {!routeData || routeData.events.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500 space-y-2">
                    <p>No hay eventos registrados para este camión en la fecha seleccionada.</p>
                    <button
                      type="button"
                      onClick={() => setMode('draw')}
                      className="text-xs font-semibold text-emerald-800 hover:underline cursor-pointer"
                    >
                      ¿Quieres trazar una ruta manualmente en el mapa?
                    </button>
                  </div>
                ) : (
                  routeData.events.map((ev, idx) => (
                    <div
                      key={ev.id}
                      onClick={() => focusEvent(ev)}
                      className={`p-3.5 cursor-pointer transition-colors ${
                        activeEventId === ev.id ? 'bg-slate-100' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-900">
                          #{idx + 1} · {formatEventLabel(ev.event_type)}
                        </span>
                        <span className="text-xs font-mono tabular-nums font-semibold text-slate-700">
                          {ev.event_time}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-600 leading-snug">
                        {ev.geofence_name_snapshot ? `${ev.geofence_name_snapshot} — ` : ''}
                        {ev.address}
                      </p>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-[11px] font-mono tabular-nums text-slate-400">
                          {ev.latitude.toFixed(5)}, {ev.longitude.toFixed(5)}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCreateGeofenceFromPoint({
                              lat: ev.latitude,
                              lng: ev.longitude,
                              suggestedName:
                                ev.address.split(',')[0] || `Zona ${ev.vehicle_code_snapshot}`,
                            });
                          }}
                          className="text-[11px] font-semibold text-slate-700 hover:text-slate-950 flex items-center gap-1 cursor-pointer"
                        >
                          <PlusCircle className="w-3.5 h-3.5" />
                          <span>Crear geocerca</span>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-slate-200">
                <h3 className="text-sm font-bold text-slate-900">Puntos Trazados y Rutas Guardadas</h3>
                <p className="text-xs text-slate-500">
                  Edita puntos o carga una ruta guardada
                </p>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
                {draftPoints.length === 0 ? (
                  <div className="p-5 text-center text-xs text-slate-500">
                    Haz clic sobre el mapa para colocar el Punto #1 y empezar el trazo.
                  </div>
                ) : (
                  draftPoints.map((pt, idx) => (
                    <div
                      key={`${pt.lat}-${pt.lng}-${idx}`}
                      className="p-3 flex items-center justify-between gap-2 hover:bg-slate-50"
                    >
                      <button
                        type="button"
                        onClick={() => mapRef.current?.flyTo([pt.lat, pt.lng], 15, { duration: 0.4 })}
                        className="text-left min-w-0 flex-1 cursor-pointer"
                      >
                        <p className="text-xs font-bold text-slate-900">
                          Punto #{idx + 1}
                        </p>
                        <p className="text-[11px] font-mono text-slate-500">
                          {pt.lat.toFixed(5)}, {pt.lng.toFixed(5)}
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setDraftPoints((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="p-1.5 rounded text-red-600 hover:bg-red-50 cursor-pointer"
                        title="Quitar punto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}

                {plannedRoutes.length > 0 && (
                  <div className="p-3 bg-slate-50">
                    <p className="text-xs font-bold text-slate-700 mb-2">
                      Rutas Guardadas ({plannedRoutes.length})
                    </p>
                    <div className="space-y-1.5">
                      {plannedRoutes.map((r) => (
                        <div
                          key={r.id}
                          className={`p-2 rounded-lg border text-xs flex items-center justify-between gap-2 ${
                            activePlannedRouteId === r.id
                              ? 'bg-emerald-50 border-emerald-300'
                              : 'bg-white border-slate-200'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => loadSavedPlannedRoute(r)}
                            className="text-left min-w-0 flex-1 cursor-pointer"
                          >
                            <p className="font-semibold text-slate-900 truncate">{r.name}</p>
                            <p className="text-[11px] text-slate-500 font-mono">
                              {r.distance_km} km {r.sede_name ? `· ${r.sede_name}` : ''}
                            </p>
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteSavedPlannedRoute(r.id)}
                            className="p-1 text-red-600 hover:bg-red-50 rounded cursor-pointer"
                            title="Eliminar ruta"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="text-xs text-slate-500 flex items-center gap-1.5">
        <MapPin className="w-3.5 h-3.5" />
        <span>
          Las zonas verdes con línea punteada muestran las geocercas activas. Los camiones en jornada envían puntos GPS continuos para trazar el recorrido real.
        </span>
      </div>
    </div>
  );
}
