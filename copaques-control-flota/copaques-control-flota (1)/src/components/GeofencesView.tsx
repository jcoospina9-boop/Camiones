import L from 'leaflet';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Edit2, LocateFixed, MapPin, Plus, Power, Trash2 } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import type { Geofence, GeofenceCategory } from '../types.ts';

interface GeofencesViewProps {
  prefillPoint: { lat: number; lng: number; suggestedName: string } | null;
  onClearPrefill: () => void;
}

const CATEGORIES: GeofenceCategory[] = [
  'Planta',
  'Cliente',
  'Obra',
  'Bodega',
  'Proveedor',
  'Otro',
];

type TileLayerKey = 'streets' | 'osmhot' | 'satellite';

const TILE_LAYERS: Record<TileLayerKey, { label: string; url: string; attribution: string }> = {
  streets: {
    label: 'Calles',
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

export function GeofencesView({ prefillPoint, onClearPrefill }: GeofencesViewProps) {
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<GeofenceCategory>('Obra');
  const [latitude, setLatitude] = useState<string>('4.71100');
  const [longitude, setLongitude] = useState<string>('-74.07210');
  const [radiusMeters, setRadiusMeters] = useState<number>(150);
  const [active, setActive] = useState<boolean>(true);
  const [tileStyle, setTileStyle] = useState<TileLayerKey>('streets');

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const tileErrorCountRef = useRef(0);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const previewLayerRef = useRef<L.LayerGroup | null>(null);

  const loadGeofences = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ geofences: Geofence[] }>('/api/admin/geofences');
      setGeofences(res.geofences);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar geocercas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGeofences();
  }, [loadGeofences]);

  // Apply prefill from event / map
  useEffect(() => {
    if (!prefillPoint) return;
    setEditingId(null);
    setName(prefillPoint.suggestedName);
    setCategory('Obra');
    setLatitude(prefillPoint.lat.toFixed(6));
    setLongitude(prefillPoint.lng.toFixed(6));
    setRadiusMeters(150);
    setActive(true);
    if (mapRef.current) {
      mapRef.current.flyTo([prefillPoint.lat, prefillPoint.lng], 15, { duration: 0.4 });
    }
    onClearPrefill();
  }, [prefillPoint, onClearPrefill]);

  // Initialize Leaflet map with ResizeObserver
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el || mapRef.current) return;

    const map = L.map(el, {
      center: [4.711, -74.0721],
      zoom: 12,
    });

    const existingGroup = L.layerGroup().addTo(map);
    const previewGroup = L.layerGroup().addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      setLatitude(e.latlng.lat.toFixed(6));
      setLongitude(e.latlng.lng.toFixed(6));
    });

    mapRef.current = map;
    layerGroupRef.current = existingGroup;
    previewLayerRef.current = previewGroup;

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
      layerGroupRef.current = null;
      previewLayerRef.current = null;
    };
  }, []);

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
      if (tileErrorCountRef.current >= 4 && tileStyle === 'streets') {
        setTileStyle('osmhot');
      }
    });
    layer.addTo(map);
    tileLayerRef.current = layer;
  }, [tileStyle]);

  // Draw saved geofences
  useEffect(() => {
    const group = layerGroupRef.current;
    const map = mapRef.current;
    if (!group || !map) return;

    group.clearLayers();
    const coords: L.LatLngExpression[] = [];

    for (const gf of geofences) {
      coords.push([gf.latitude, gf.longitude]);
      const circle = L.circle([gf.latitude, gf.longitude], {
        radius: gf.radius_meters,
        color: gf.active ? '#16a34a' : '#94a3b8',
        weight: 2,
        fillColor: gf.active ? '#22c55e' : '#94a3b8',
        fillOpacity: gf.active ? 0.15 : 0.08,
      });

      const popupDiv = document.createElement('div');
      const t = document.createElement('strong');
      t.textContent = gf.name;
      const d = document.createElement('div');
      d.className = 'text-xs text-slate-600';
      d.textContent = `${gf.category} · ${gf.radius_meters} m · ${gf.active ? 'Activa' : 'Inactiva'}`;
      popupDiv.appendChild(t);
      popupDiv.appendChild(d);

      circle.bindPopup(popupDiv);
      circle.addTo(group);
    }

    if (coords.length > 0 && !editingId) {
      map.fitBounds(L.latLngBounds(coords), { padding: [40, 40], maxZoom: 14 });
    }
  }, [geofences, editingId]);

  // Draw live editor preview circle
  useEffect(() => {
    const preview = previewLayerRef.current;
    if (!preview) return;
    preview.clearLayers();

    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    L.circle([lat, lng], {
      radius: radiusMeters,
      color: '#eab308',
      weight: 2,
      dashArray: '5 5',
      fillColor: '#facc15',
      fillOpacity: 0.25,
    }).addTo(preview);

    const pinIcon = L.divIcon({
      className: 'gf-preview-pin',
      html: '<div style="width:14px;height:14px;border-radius:9999px;background:#eab308;border:2px solid #064e3b;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    L.marker([lat, lng], { icon: pinIcon }).addTo(preview);
  }, [latitude, longitude, radiusMeters]);

  function resetForm() {
    setEditingId(null);
    setName('');
    setCategory('Obra');
    setRadiusMeters(150);
    setActive(true);
  }

  function startEdit(gf: Geofence) {
    setEditingId(gf.id);
    setName(gf.name);
    setCategory(gf.category);
    setLatitude(gf.latitude.toFixed(6));
    setLongitude(gf.longitude.toFixed(6));
    setRadiusMeters(gf.radius_meters);
    setActive(gf.active === 1);
    mapRef.current?.flyTo([gf.latitude, gf.longitude], 15, { duration: 0.4 });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const payload = {
        name,
        category,
        latitude: Number(latitude),
        longitude: Number(longitude),
        radius_meters: Number(radiusMeters),
        active,
      };

      if (editingId) {
        await apiFetch(`/api/admin/geofences/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/admin/geofences', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      resetForm();
      await loadGeofences();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar geocerca.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(gf: Geofence) {
    try {
      await apiFetch(`/api/admin/geofences/${gf.id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: gf.active === 1 ? false : true }),
      });
      await loadGeofences();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cambiar estado.');
    }
  }

  async function handleDelete(gf: Geofence) {
    try {
      await apiFetch(`/api/admin/geofences/${gf.id}`, { method: 'DELETE' });
      if (editingId === gf.id) resetForm();
      await loadGeofences();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar geocerca.');
    }
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Map Picker */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <MapPin className="w-4 h-4 text-amber-600" />
              <span>Haz clic en el mapa para definir el centro</span>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={tileStyle}
                onChange={(e) => setTileStyle(e.target.value as TileLayerKey)}
                aria-label="Vista del mapa"
                className="h-8 px-2 rounded-md border border-slate-200 text-xs text-slate-700 bg-white"
              >
                {(Object.keys(TILE_LAYERS) as TileLayerKey[]).map((key) => (
                  <option key={key} value={key}>
                    {TILE_LAYERS[key].label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  if (!('geolocation' in navigator) || !mapRef.current) return;
                  navigator.geolocation.getCurrentPosition(
                    (pos) => {
                      setLatitude(pos.coords.latitude.toFixed(6));
                      setLongitude(pos.coords.longitude.toFixed(6));
                      mapRef.current?.flyTo([pos.coords.latitude, pos.coords.longitude], 15, {
                        duration: 0.5,
                      });
                    },
                    () => setError('No se pudo obtener tu ubicación actual.')
                  );
                }}
                className="h-8 px-2.5 rounded-md border border-slate-200 bg-white hover:bg-emerald-50 text-xs font-medium text-emerald-900 flex items-center gap-1 cursor-pointer"
              >
                <LocateFixed className="w-3.5 h-3.5" />
                <span>Mi ubicación</span>
              </button>
              <span className="text-xs text-slate-500">Radio amarillo = vista previa</span>
            </div>
          </div>
          <div ref={mapContainerRef} className="w-full h-[460px]" />
        </div>

        {/* Geofence Form */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold text-slate-900">
              {editingId ? 'Editar Geocerca' : 'Nueva Geocerca'}
            </h3>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                Cancelar edición
              </button>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-3.5">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Nombre</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ej. Planta Central / Obra Edificio Norte"
                className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Categoría</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as GeofenceCategory)}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Latitud</label>
                <input
                  type="number"
                  step="any"
                  required
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Longitud</label>
                <input
                  type="number"
                  step="any"
                  required
                  value={longitude}
                  onChange={(e) => setLongitude(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-slate-700">
                  Radio de acción (metros)
                </label>
                <span className="text-xs font-mono tabular-nums font-bold text-slate-900">
                  {radiusMeters} m
                </span>
              </div>
              <input
                type="range"
                min={30}
                max={2000}
                step={10}
                value={Math.min(radiusMeters, 2000)}
                onChange={(e) => setRadiusMeters(Number(e.target.value))}
                className="w-full accent-emerald-700"
              />
              <input
                type="number"
                min={20}
                max={50000}
                value={radiusMeters}
                onChange={(e) => setRadiusMeters(Number(e.target.value) || 100)}
                className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-300 text-xs font-mono tabular-nums"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 accent-emerald-700"
              />
              <span>Geocerca activa (habilitada para detección automática)</span>
            </label>

            <button
              type="submit"
              disabled={saving}
              className="w-full h-11 rounded-lg bg-emerald-800 hover:bg-emerald-900 text-white text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
            >
              <Plus className="w-4 h-4" />
              <span>
                {saving
                  ? 'Guardando...'
                  : editingId
                    ? 'Guardar Cambios'
                    : 'Crear Geocerca'}
              </span>
            </button>
          </form>
        </div>
      </div>

      {/* Geofences List Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">Geocercas Registradas</h3>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            {geofences.length} total
          </span>
        </div>

        {loading ? (
          <div className="p-6 text-center text-sm text-slate-500">Cargando geocercas...</div>
        ) : geofences.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No hay geocercas configuradas. Haz clic en el mapa superior para crear la primera (ej. Planta Principal).
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-2.5 px-4">Nombre</th>
                  <th className="py-2.5 px-4">Categoría</th>
                  <th className="py-2.5 px-4">Coordenadas</th>
                  <th className="py-2.5 px-4 text-right">Radio</th>
                  <th className="py-2.5 px-4">Estado</th>
                  <th className="py-2.5 px-4 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {geofences.map((gf) => (
                  <tr key={gf.id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-4 font-semibold text-slate-900">{gf.name}</td>
                    <td className="py-2.5 px-4 text-slate-600">{gf.category}</td>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-xs text-slate-500">
                      {gf.latitude.toFixed(5)}, {gf.longitude.toFixed(5)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                      {gf.radius_meters} m
                    </td>
                    <td className="py-2.5 px-4">
                      <span
                        className={`text-xs font-semibold ${
                          gf.active === 1 ? 'text-emerald-700' : 'text-slate-400'
                        }`}
                      >
                        {gf.active === 1 ? 'Activa' : 'Inactiva'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => toggleActive(gf)}
                          title={gf.active === 1 ? 'Desactivar' : 'Activar'}
                          className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                        >
                          <Power className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => startEdit(gf)}
                          title="Editar"
                          className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(gf)}
                          title="Eliminar"
                          className="p-2 rounded-lg text-red-600 hover:bg-red-50 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
