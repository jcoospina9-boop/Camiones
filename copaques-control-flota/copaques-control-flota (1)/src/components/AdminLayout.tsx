import { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  MapPin,
  PlusCircle,
  RefreshCw,
  Search,
  Truck,
} from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import {
  formatEventLabel,
  type DashboardResponse,
  type FleetEvent,
  type User,
  type Vehicle,
} from '../types.ts';
import { DocsAndBackupView } from './DocsAndBackupView.tsx';
import { FleetUsersView } from './FleetUsersView.tsx';
import { GeofencesView } from './GeofencesView.tsx';
import { ReportsView } from './ReportsView.tsx';
import { RouteMapView } from './RouteMapView.tsx';

interface AdminLayoutProps {
  user: User;
  onLogout: () => void;
}

type AdminSection =
  | 'dashboard'
  | 'map'
  | 'history'
  | 'geofences'
  | 'reports'
  | 'fleet'
  | 'backup';

const NAV_ITEMS: Array<{ id: AdminSection; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: 'Panel Principal', icon: LayoutDashboard },
  { id: 'map', label: 'Mapa de Recorridos', icon: MapIcon },
  { id: 'history', label: 'Historial y Consultas', icon: History },
  { id: 'geofences', label: 'Geocercas', icon: MapPin },
  { id: 'reports', label: 'Reportes (PDF / Excel)', icon: FileSpreadsheet },
  { id: 'fleet', label: 'Flota y Usuarios', icon: Truck },
  { id: 'backup', label: 'Respaldos y Docs', icon: BookOpen },
];

export function AdminLayout({ user, onLogout }: AdminLayoutProps) {
  const [section, setSection] = useState<AdminSection>('dashboard');
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loadingDash, setLoadingDash] = useState(true);
  const [logoError, setLogoError] = useState(false);

  // History / Queries state
  const [historyEvents, setHistoryEvents] = useState<FleetEvent[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [filterVehicleId, setFilterVehicleId] = useState('');
  const [filterUserId, setFilterUserId] = useState('');
  const [filterEventType, setFilterEventType] = useState('');
  const [filterSearch, setFilterSearch] = useState('');

  // Prefill geofence creation from map/history
  const [geofencePrefill, setGeofencePrefill] = useState<{
    lat: number;
    lng: number;
    suggestedName: string;
  } | null>(null);

  const loadCoreData = useCallback(async () => {
    try {
      const [dashRes, vehRes, usrRes] = await Promise.all([
        apiFetch<DashboardResponse>('/api/admin/dashboard'),
        apiFetch<{ vehicles: Vehicle[] }>('/api/admin/vehicles'),
        apiFetch<{ users: User[] }>('/api/admin/users'),
      ]);
      setDashboard(dashRes);
      setVehicles(vehRes.vehicles);
      setUsers(usrRes.users);
    } finally {
      setLoadingDash(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const params = new URLSearchParams();
      if (filterStartDate) params.set('startDate', filterStartDate);
      if (filterEndDate) params.set('endDate', filterEndDate);
      if (filterVehicleId) params.set('vehicleId', filterVehicleId);
      if (filterUserId) params.set('userId', filterUserId);
      if (filterEventType) params.set('eventType', filterEventType);
      if (filterSearch.trim()) params.set('search', filterSearch.trim());
      params.set('limit', '300');

      const res = await apiFetch<{ events: FleetEvent[]; total: number }>(
        `/api/admin/events?${params.toString()}`
      );
      setHistoryEvents(res.events);
      setHistoryTotal(res.total);
    } finally {
      setLoadingHistory(false);
    }
  }, [filterStartDate, filterEndDate, filterVehicleId, filterUserId, filterEventType, filterSearch]);

  useEffect(() => {
    loadCoreData();
  }, [loadCoreData]);

  useEffect(() => {
    if (section === 'history') {
      loadHistory();
    }
  }, [section, loadHistory]);

  function handleCreateGeofenceFromPoint(point: {
    lat: number;
    lng: number;
    suggestedName: string;
  }) {
    setGeofencePrefill(point);
    setSection('geofences');
  }

  const currentNav = NAV_ITEMS.find((n) => n.id === section)!;

  return (
    <div className="min-h-screen bg-[#f6f9f6] text-slate-900 flex flex-col lg:flex-row">
      {/* Left Sidebar (Desktop) / Top Navigation Drawer */}
      <aside className="lg:w-64 bg-[#0a521f] text-emerald-50 shrink-0 flex flex-col border-b lg:border-b-0 lg:border-r border-[#084118]">
        <div className="p-3.5 border-b border-[#084118]">
          <div className="bg-white rounded-xl px-3 py-2 flex items-center justify-center">
            {!logoError ? (
              <img
                src="/assets/aistudio/image_2fcce064.png"
                alt="Copaques - Materiales para construcción"
                referrerPolicy="no-referrer"
                onError={() => setLogoError(true)}
                className="h-11 w-auto object-contain"
              />
            ) : (
              <span className="text-lg font-bold tracking-tight text-[#181a18]">copaques</span>
            )}
          </div>
          <p className="mt-2 text-center text-[11px] font-medium text-emerald-100/90 truncate">
            Control de Flota · Gerencia
          </p>
        </div>

        <nav className="p-3 flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible flex-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={`px-3 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2.5 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-[#facc15] text-[#0a421a] font-semibold'
                    : 'text-emerald-50/90 hover:bg-[#0e6b2a] hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="hidden lg:block p-4 border-t border-[#084118]">
          <p className="text-xs font-semibold text-white truncate">{user.full_name}</p>
          <p className="text-[11px] text-emerald-200 font-mono truncate">{user.username}</p>
          <button
            type="button"
            onClick={onLogout}
            className="mt-3 w-full h-9 rounded-lg bg-[#084118] hover:bg-[#063313] text-white text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Cerrar Sesión</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-emerald-950 truncate">{currentNav.label}</h1>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={loadCoreData}
              className="h-9 px-3 rounded-lg border border-slate-200 bg-white hover:bg-emerald-50 text-xs font-semibold text-emerald-900 flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Actualizar</span>
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="lg:hidden h-9 px-3 rounded-lg bg-emerald-800 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Salir</span>
            </button>
          </div>
        </header>

        <main className="p-6 flex-1 max-w-[1400px] w-full mx-auto">
          {section === 'dashboard' && (
            <div className="space-y-6">
              {loadingDash || !dashboard ? (
                <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                  Cargando indicadores de la flota...
                </div>
              ) : (
                <>
                  {/* KPIs */}
                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                    <div className="bg-white border border-slate-200 rounded-xl p-4">
                      <p className="text-xs text-slate-500">Vehículos Activos</p>
                      <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">
                        {dashboard.kpis.activeVehiclesCount}
                        <span className="text-sm font-normal text-slate-400">
                          {' '}
                          / {dashboard.kpis.totalVehicles}
                        </span>
                      </p>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-4">
                      <p className="text-xs text-slate-500">Jornadas en Curso</p>
                      <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-700">
                        {dashboard.kpis.activeShiftsCount}
                      </p>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-4">
                      <p className="text-xs text-slate-500">Eventos Hoy</p>
                      <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">
                        {dashboard.kpis.eventsTodayCount}
                      </p>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-4">
                      <p className="text-xs text-slate-500">Entradas Hoy</p>
                      <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-amber-700">
                        {dashboard.kpis.entriesTodayCount}
                      </p>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-4">
                      <p className="text-xs text-slate-500">Geocercas Activas</p>
                      <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">
                        {dashboard.kpis.activeGeofencesCount}
                      </p>
                    </div>
                  </div>

                  {/* Empty Onboarding Banner when no trucks exist */}
                  {dashboard.fleetStatus.length === 0 && (
                    <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <h2 className="text-base font-bold text-slate-900">
                          Comienza registrando tus camiones y conductores
                        </h2>
                        <p className="mt-1 text-sm text-slate-600">
                          Crea cada vehículo de la distribuidora y asigna su usuario conductor para que inicien jornada desde su teléfono.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSection('fleet')}
                        className="h-10 px-4 rounded-lg bg-emerald-800 hover:bg-emerald-900 text-white text-sm font-semibold cursor-pointer"
                      >
                        Ir a Flota y Usuarios
                      </button>
                    </div>
                  )}

                  {/* Fleet Status + Recent Movements */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                    <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
                      <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
                        <h2 className="text-sm font-bold text-slate-900">
                          Estado Actual de Camiones
                        </h2>
                        <span className="text-xs font-mono text-slate-500">{dashboard.today}</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-sm">
                          <thead>
                            <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                              <th className="py-2.5 px-4">Camión</th>
                              <th className="py-2.5 px-4">Conductor</th>
                              <th className="py-2.5 px-4">Estado</th>
                              <th className="py-2.5 px-4">Último Movimiento</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {dashboard.fleetStatus.length === 0 ? (
                              <tr>
                                <td colSpan={4} className="py-8 text-center text-slate-500">
                                  Aún no hay camiones activos.
                                </td>
                              </tr>
                            ) : (
                              dashboard.fleetStatus.map((v) => (
                                <tr key={v.id} className="hover:bg-slate-50">
                                  <td className="py-2.5 px-4 font-semibold text-slate-900 whitespace-nowrap">
                                    {v.code} ·{' '}
                                    <span className="font-mono text-slate-600">{v.plate}</span>
                                  </td>
                                  <td className="py-2.5 px-4 text-slate-700">
                                    {v.driver_name || (
                                      <span className="text-xs text-slate-400">Sin asignar</span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-4 whitespace-nowrap">
                                    <span
                                      className={`text-xs font-semibold ${
                                        v.shiftActive ? 'text-emerald-700' : 'text-slate-500'
                                      }`}
                                    >
                                      {v.shiftActive ? 'En Jornada' : 'Fuera de Jornada'}
                                    </span>
                                    {v.currentGeofence && (
                                      <span className="block text-[11px] text-slate-500">
                                        En: {v.currentGeofence.name}
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-4 text-xs text-slate-600">
                                    {v.lastEvent ? (
                                      <div>
                                        <span className="font-semibold text-slate-800">
                                          {formatEventLabel(v.lastEvent.event_type)}
                                        </span>{' '}
                                        <span className="font-mono tabular-nums text-slate-500">
                                          · {v.lastEvent.event_date} {v.lastEvent.event_time}
                                        </span>
                                        <p className="text-slate-500 truncate max-w-[220px]">
                                          {v.lastEvent.address}
                                        </p>
                                      </div>
                                    ) : (
                                      <span className="text-slate-400">Sin registros</span>
                                    )}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
                      <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
                        <h2 className="text-sm font-bold text-slate-900">Últimos Movimientos</h2>
                        <button
                          type="button"
                          onClick={() => setSection('history')}
                          className="text-xs font-semibold text-slate-700 hover:text-slate-950 cursor-pointer"
                        >
                          Ver historial
                        </button>
                      </div>
                      <div className="divide-y divide-slate-100 max-h-[520px] overflow-y-auto">
                        {dashboard.recentEvents.length === 0 ? (
                          <p className="p-8 text-center text-sm text-slate-500">
                            No hay movimientos registrados todavía.
                          </p>
                        ) : (
                          dashboard.recentEvents.map((ev) => (
                            <div key={ev.id} className="p-3.5 hover:bg-slate-50">
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <span className="font-bold text-slate-900">
                                  {ev.vehicle_code_snapshot} · {formatEventLabel(ev.event_type)}
                                </span>
                                <span className="font-mono tabular-nums text-slate-500">
                                  {ev.event_date} {ev.event_time}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-slate-600 truncate">
                                {ev.driver_name_snapshot} · {ev.address}
                              </p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {section === 'map' && (
            <RouteMapView
              vehicles={vehicles}
              onCreateGeofenceFromPoint={handleCreateGeofenceFromPoint}
            />
          )}

          {section === 'history' && (
            <div className="space-y-5">
              {/* Filter Bar */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Desde</label>
                  <input
                    type="date"
                    value={filterStartDate}
                    onChange={(e) => setFilterStartDate(e.target.value)}
                    className="w-full h-9 px-3 rounded-lg border border-slate-300 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Hasta</label>
                  <input
                    type="date"
                    value={filterEndDate}
                    onChange={(e) => setFilterEndDate(e.target.value)}
                    className="w-full h-9 px-3 rounded-lg border border-slate-300 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Vehículo</label>
                  <select
                    value={filterVehicleId}
                    onChange={(e) => setFilterVehicleId(e.target.value)}
                    className="w-full h-9 px-2.5 rounded-lg border border-slate-300 text-xs bg-white"
                  >
                    <option value="">Todos</option>
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.code} · {v.plate}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Conductor</label>
                  <select
                    value={filterUserId}
                    onChange={(e) => setFilterUserId(e.target.value)}
                    className="w-full h-9 px-2.5 rounded-lg border border-slate-300 text-xs bg-white"
                  >
                    <option value="">Todos</option>
                    {users
                      .filter((u) => u.role === 'CONDUCTOR')
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.full_name}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Evento</label>
                  <select
                    value={filterEventType}
                    onChange={(e) => setFilterEventType(e.target.value)}
                    className="w-full h-9 px-2.5 rounded-lg border border-slate-300 text-xs bg-white"
                  >
                    <option value="">Todos</option>
                    <option value="INICIO_JORNADA">Inicio de Jornada</option>
                    <option value="ENTRADA">Entrada</option>
                    <option value="SALIDA">Salida</option>
                    <option value="FIN_JORNADA">Fin de Jornada</option>
                  </select>
                </div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={filterSearch}
                    onChange={(e) => setFilterSearch(e.target.value)}
                    placeholder="Buscar dirección o nota..."
                    className="w-full h-9 pl-8 pr-3 rounded-lg border border-slate-300 text-xs"
                  />
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between text-xs text-slate-600">
                  <span className="font-bold text-slate-900">
                    Registro Permanente de Eventos ({historyTotal} total)
                  </span>
                  <span>Los registros históricos son inmutables</span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                        <th className="py-2.5 px-4">Fecha / Hora</th>
                        <th className="py-2.5 px-4">Vehículo</th>
                        <th className="py-2.5 px-4">Conductor</th>
                        <th className="py-2.5 px-4">Evento</th>
                        <th className="py-2.5 px-4">Ubicación / Dirección</th>
                        <th className="py-2.5 px-4">Observaciones</th>
                        <th className="py-2.5 px-4 text-right">Geocerca</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {loadingHistory ? (
                        <tr>
                          <td colSpan={7} className="py-8 text-center text-slate-500">
                            Consultando historial...
                          </td>
                        </tr>
                      ) : historyEvents.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-8 text-center text-slate-500">
                            No se encontraron eventos con los filtros seleccionados.
                          </td>
                        </tr>
                      ) : (
                        historyEvents.map((ev) => (
                          <tr key={ev.id} className="hover:bg-slate-50">
                            <td className="py-2.5 px-4 font-mono tabular-nums text-xs text-slate-700 whitespace-nowrap">
                              {ev.event_date} {ev.event_time}
                            </td>
                            <td className="py-2.5 px-4 font-semibold text-slate-900 whitespace-nowrap">
                              {ev.vehicle_code_snapshot} ·{' '}
                              <span className="font-mono text-xs text-slate-500">
                                {ev.vehicle_plate_snapshot}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 text-slate-700 whitespace-nowrap">
                              {ev.driver_name_snapshot}
                            </td>
                            <td className="py-2.5 px-4 whitespace-nowrap">
                              <span
                                className={`text-xs font-bold ${
                                  ev.event_type === 'ENTRADA'
                                    ? 'text-emerald-700'
                                    : ev.event_type === 'SALIDA'
                                      ? 'text-amber-700'
                                      : ev.event_type === 'FIN_JORNADA'
                                        ? 'text-red-700'
                                        : 'text-slate-900'
                                }`}
                              >
                                {formatEventLabel(ev.event_type)}
                              </span>
                              <span className="block text-[11px] text-slate-400">
                                {ev.source === 'GEOCERCA_AUTO' ? 'Geocerca Auto' : 'Manual'}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 text-xs text-slate-700 max-w-xs">
                              <p className="truncate">
                                {ev.geofence_name_snapshot ? `${ev.geofence_name_snapshot} — ` : ''}
                                {ev.address}
                              </p>
                              <p className="font-mono tabular-nums text-[11px] text-slate-400">
                                {ev.latitude.toFixed(5)}, {ev.longitude.toFixed(5)}
                              </p>
                            </td>
                            <td className="py-2.5 px-4 text-xs text-slate-600 max-w-[200px] truncate">
                              {ev.notes || '-'}
                            </td>
                            <td className="py-2.5 px-4 text-right whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() =>
                                  handleCreateGeofenceFromPoint({
                                    lat: ev.latitude,
                                    lng: ev.longitude,
                                    suggestedName:
                                      ev.address.split(',')[0] || `Zona ${ev.vehicle_code_snapshot}`,
                                  })
                                }
                                className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 hover:text-slate-950 cursor-pointer"
                              >
                                <PlusCircle className="w-3.5 h-3.5" />
                                <span>Crear geocerca</span>
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {section === 'geofences' && (
            <GeofencesView
              prefillPoint={geofencePrefill}
              onClearPrefill={() => setGeofencePrefill(null)}
            />
          )}

          {section === 'reports' && <ReportsView vehicles={vehicles} users={users} />}

          {section === 'fleet' && (
            <FleetUsersView vehicles={vehicles} users={users} onRefresh={loadCoreData} />
          )}

          {section === 'backup' && <DocsAndBackupView />}
        </main>
      </div>
    </div>
  );
}
