import L from 'leaflet';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Calendar, Layers, MapPin, PlusCircle, Route as RouteIcon, Truck } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import {
  formatEventLabel,
  formatMinutesAsHours,
  type FleetEvent,
  type RouteResponse,
  type Vehicle,
} from '../types.ts';

interface RouteMapViewProps {
  vehicles: Vehicle[];
  onCreateGeofenceFromPoint: (point: { lat: number; lng: number; suggestedName: string }) => void;
}

type TileLayerKey = 'streets' | 'osmhot' | 'satellite';

const TILE_LAYERS: Record<TileLayerKey, { label: string; url: string; attribution: string }> = {
  streets: {
    label: 'Mapa Calles',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  },
  osmhot: {
    label: 'OpenStreetMap',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
  },
  satellite: {
    label: 'Satélite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
  },
};

function getLocalToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

export function RouteMapView({ vehicles, onCreateGeofenceFromPoint }: RouteMapViewProps) {
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>(
    vehicles.length > 0 ? String(vehicles[0].id) : ''
  );
  const [selectedDate, setSelectedDate] = useState<string>(getLocalToday());
  const [tileStyle, setTileStyle] = useState<TileLayerKey>('streets');
  const [routeData, setRouteData] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeEventId, setActiveEventId] = useState<number | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const markerByIdRef = useRef<Map<number, L.Marker>>(new Map());

  useEffect(() => {
    if (!selectedVehicleId && vehicles.length > 0) {
      setSelectedVehicleId(String(vehicles[0].id));
    }
  }, [vehicles, selectedVehicleId]);

  const loadRoute = useCallback(async () => {
    if (!selectedVehicleId) return;
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

  useEffect(() => {
    loadRoute();
  }, [loadRoute]);

  // Initialize Leaflet map once with ResizeObserver
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el || mapRef.current) return;

    const map = L.map(el, {
      center: [4.711, -74.0721],
      zoom: 12,
      zoomControl: true,
    });

    const cfg = TILE_LAYERS.streets;
    const baseLayer = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom: 19,
    }).addTo(map);

    const group = L.layerGroup().addTo(map);
    mapRef.current = map;
    tileLayerRef.current = baseLayer;
    layerGroupRef.current = group;

    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(el);
    setTimeout(() => map.invalidateSize(), 100);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      layerGroupRef.current = null;
    };
  }, []);

  // Switch tile provider cleanly
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileLayerRef.current) {
      tileLayerRef.current.remove();
    }
    const cfg = TILE_LAYERS[tileStyle];
    tileLayerRef.current = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom: 19,
    }).addTo(map);
  }, [tileStyle]);

  // Render route polyline, geofences, and numbered markers safely
  useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    if (!map || !group || !routeData) return;

    group.clearLayers();
    markerByIdRef.current.clear();

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

    if (routeData.events.length === 0) {
      if (gfCoords.length > 0) {
        map.fitBounds(L.latLngBounds(gfCoords), { padding: [48, 48], maxZoom: 14 });
      }
      return;
    }

    const latLngs: L.LatLngExpression[] = routeData.events.map((ev) => [ev.latitude, ev.longitude]);
    L.polyline(latLngs, {
      color: '#065f46',
      weight: 3.5,
      opacity: 0.9,
    }).addTo(group);

    routeData.events.forEach((ev, idx) => {
      const bg = markerColor(ev.event_type);
      const icon = L.divIcon({
        className: 'custom-route-pin',
        html: `<div style="width:28px;height:28px;border-radius:9999px;background:${bg};color:#ffffff;border:2px solid #ffffff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,0.3);">${idx + 1}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const marker = L.marker([ev.latitude, ev.longitude], { icon });

      // Build popup safely with DOM nodes (no HTML string interpolation)
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

    const bounds = L.latLngBounds(latLngs);
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
  }, [routeData, onCreateGeofenceFromPoint]);

  function focusEvent(ev: FleetEvent) {
    setActiveEventId(ev.id);
    const map = mapRef.current;
    const marker = markerByIdRef.current.get(ev.id);
    if (map && marker) {
      map.flyTo([ev.latitude, ev.longitude], 15, { duration: 0.4 });
      marker.openPopup();
    }
  }

  return (
    <div className="space-y-5">
      {/* Filter Controls Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-end gap-4">
        <div className="min-w-[220px] flex-1">
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Vehículo / Camión
          </label>
          <div className="relative">
            <Truck className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
            <select
              value={selectedVehicleId}
              onChange={(e) => setSelectedVehicleId(e.target.value)}
              className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-300 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
            >
              {vehicles.length === 0 && <option value="">No hay vehículos registrados</option>}
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
          onClick={() => setSelectedDate(getLocalToday())}
          className="h-10 px-4 rounded-lg border border-slate-200 bg-white hover:bg-emerald-50 text-xs font-semibold text-emerald-900 cursor-pointer whitespace-nowrap shrink-0"
        >
          Hoy
        </button>

        <button
          type="button"
          onClick={loadRoute}
          disabled={loading || !selectedVehicleId}
          className="h-10 px-4 rounded-lg bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-semibold cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
        >
          {loading ? 'Cargando...' : 'Actualizar Mapa'}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Route Summary Metrics */}
      {routeData && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <p className="text-xs text-slate-500">Eventos del día</p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
              {routeData.summary.totalEvents}
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
            <p className="text-xs text-slate-500">Distancia entre puntos</p>
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

      {/* Map + Timeline Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between text-xs text-slate-600">
            <div className="flex items-center gap-2 font-semibold text-slate-900">
              <RouteIcon className="w-4 h-4" />
              <span>Trazado de Recorrido ({TILE_LAYERS[tileStyle].label})</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-slate-900 font-medium">Inicio</span>
              <span className="text-emerald-700 font-medium">Entrada</span>
              <span className="text-amber-700 font-medium">Salida</span>
              <span className="text-red-700 font-medium">Fin</span>
            </div>
          </div>
          <div ref={mapContainerRef} className="w-full h-[500px] min-h-[500px]" />
        </div>

        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl flex flex-col max-h-[545px]">
          <div className="px-4 py-3 border-b border-slate-200">
            <h3 className="text-sm font-bold text-slate-900">Secuencia del Recorrido</h3>
            <p className="text-xs text-slate-500">
              Haz clic en un punto para centrar el mapa
            </p>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {!routeData || routeData.events.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No hay eventos registrados para este camión en la fecha seleccionada.
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
                          suggestedName: ev.address.split(',')[0] || `Zona ${ev.vehicle_code_snapshot}`,
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
        </div>
      </div>

      <div className="text-xs text-slate-500 flex items-center gap-1.5">
        <MapPin className="w-3.5 h-3.5" />
        <span>
          Las zonas azules con línea punteada muestran las geocercas activas configuradas por gerencia.
        </span>
      </div>
    </div>
  );
}
