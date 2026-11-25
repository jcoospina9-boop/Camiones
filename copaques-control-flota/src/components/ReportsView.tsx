import { useCallback, useEffect, useState } from 'react';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import { exportReportToExcel, exportReportToPDF } from '../lib/exportReports.ts';
import {
  formatEventLabel,
  formatMinutesAsHours,
  type ReportResponse,
  type User,
  type Vehicle,
} from '../types.ts';

interface ReportsViewProps {
  vehicles: Vehicle[];
  users: User[];
}

function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function ReportsView({ vehicles, users }: ReportsViewProps) {
  const today = toYmd(new Date());
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'custom'>('daily');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [vehicleId, setVehicleId] = useState('');
  const [userId, setUserId] = useState('');
  const [activeTab, setActiveTab] = useState<'vehicles' | 'drivers' | 'stays' | 'events'>('vehicles');

  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const drivers = users.filter((u) => u.role === 'CONDUCTOR');

  function applyPreset(preset: 'daily' | 'weekly' | 'monthly') {
    const now = new Date();
    const end = toYmd(now);
    let start = end;
    if (preset === 'weekly') {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      start = toYmd(d);
    } else if (preset === 'monthly') {
      start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    }
    setPeriod(preset);
    setStartDate(start);
    setEndDate(end);
  }

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ startDate, endDate });
      if (vehicleId) params.set('vehicleId', vehicleId);
      if (userId) params.set('userId', userId);
      const data = await apiFetch<ReportResponse>(`/api/admin/reports?${params.toString()}`);
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al generar reporte.');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, vehicleId, userId]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  return (
    <div className="space-y-5">
      {/* Controls & Presets */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(
              [
                ['daily', 'Diario'],
                ['weekly', 'Semanal (7d)'],
                ['monthly', 'Mensual'],
                ['custom', 'Personalizado'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  if (key === 'custom') setPeriod('custom');
                  else applyPreset(key);
                }}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  period === key
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={!report}
              onClick={() => report && exportReportToPDF(report)}
              className="h-9 px-3.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <FileText className="w-4 h-4 text-red-600" />
              <span>Exportar PDF</span>
            </button>
            <button
              type="button"
              disabled={!report}
              onClick={() => report && exportReportToExcel(report)}
              className="h-9 px-3.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>Exportar Excel</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Desde</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                setPeriod('custom');
                setStartDate(e.target.value);
              }}
              className="w-full h-9 px-3 rounded-lg border border-slate-300 text-sm font-mono tabular-nums"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Hasta</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => {
                setPeriod('custom');
                setEndDate(e.target.value);
              }}
              className="w-full h-9 px-3 rounded-lg border border-slate-300 text-sm font-mono tabular-nums"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Vehículo</label>
            <select
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-slate-300 text-sm bg-white"
            >
              <option value="">Todos los camiones</option>
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
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-slate-300 text-sm bg-white"
            >
              <option value="">Todos los conductores</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.full_name} ({d.username})
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={loadReport}
            disabled={loading}
            className="h-9 px-4 rounded-lg bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{loading ? 'Calculando...' : 'Generar'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Summary KPIs */}
      {report && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Eventos Totales</p>
              <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">
                {report.summary.totalEvents}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Visitas (Entradas)</p>
              <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-700">
                {report.summary.totalVisits}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Jornadas Iniciadas</p>
              <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">
                {report.summary.totalShifts}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Horas Trabajadas</p>
              <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">
                {report.summary.totalWorkedHours} h
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Horas en Puntos</p>
              <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-amber-700">
                {report.summary.totalStayHours} h
              </p>
            </div>
          </div>

          {/* Sub-tabs */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 pt-3 border-b border-slate-200 flex items-center gap-6 overflow-x-auto">
              {(
                [
                  ['vehicles', 'Por Vehículo'],
                  ['drivers', 'Por Conductor'],
                  ['stays', 'Tiempo por Ubicación'],
                  ['events', 'Detalle de Eventos'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveTab(key)}
                  className={`pb-3 text-sm font-semibold border-b-2 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    activeTab === key
                      ? 'border-emerald-800 text-emerald-900'
                      : 'border-transparent text-slate-500 hover:text-emerald-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {activeTab === 'vehicles' && (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                      <th className="py-2.5 px-4">Vehículo</th>
                      <th className="py-2.5 px-4">Placa</th>
                      <th className="py-2.5 px-4 text-right">Jornadas</th>
                      <th className="py-2.5 px-4 text-right">Visitas</th>
                      <th className="py-2.5 px-4 text-right">Salidas</th>
                      <th className="py-2.5 px-4 text-right">Eventos</th>
                      <th className="py-2.5 px-4 text-right">Horas Trabajadas</th>
                      <th className="py-2.5 px-4 text-right">Tiempo en Puntos</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.byVehicle.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-8 text-center text-slate-500">
                          No hay actividad en el período seleccionado.
                        </td>
                      </tr>
                    ) : (
                      report.byVehicle.map((row) => (
                        <tr key={row.key} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4 font-semibold text-slate-900">{row.label}</td>
                          <td className="py-2.5 px-4 font-mono text-slate-600">{row.sublabel}</td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums">{row.shiftsCount}</td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-700 font-semibold">
                            {row.visitsCount}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums">{row.exitsCount}</td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums">{row.totalEvents}</td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold">
                            {formatMinutesAsHours(row.workedMinutes)}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                            {formatMinutesAsHours(row.stayMinutes)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'drivers' && (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                      <th className="py-2.5 px-4">Conductor</th>
                      <th className="py-2.5 px-4">Usuario</th>
                      <th className="py-2.5 px-4 text-right">Jornadas</th>
                      <th className="py-2.5 px-4 text-right">Visitas</th>
                      <th className="py-2.5 px-4 text-right">Eventos</th>
                      <th className="py-2.5 px-4 text-right">Horas Trabajadas</th>
                      <th className="py-2.5 px-4 text-right">Tiempo en Puntos</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.byDriver.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-500">
                          No hay datos de conductores para el período.
                        </td>
                      </tr>
                    ) : (
                      report.byDriver.map((row) => (
                        <tr key={row.key} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4 font-semibold text-slate-900">{row.label}</td>
                          <td className="py-2.5 px-4 font-mono text-slate-600">{row.sublabel}</td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums">{row.shiftsCount}</td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-700 font-semibold">
                            {row.visitsCount}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums">{row.totalEvents}</td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold">
                            {formatMinutesAsHours(row.workedMinutes)}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                            {formatMinutesAsHours(row.stayMinutes)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'stays' && (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                      <th className="py-2.5 px-4">Vehículo</th>
                      <th className="py-2.5 px-4">Conductor</th>
                      <th className="py-2.5 px-4">Ubicación / Geocerca</th>
                      <th className="py-2.5 px-4">Entrada</th>
                      <th className="py-2.5 px-4">Salida</th>
                      <th className="py-2.5 px-4 text-right">Permanencia</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.locationStays.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-500">
                          No hay pares Entrada/Salida registrados en este período.
                        </td>
                      </tr>
                    ) : (
                      report.locationStays.map((s, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4 font-semibold text-slate-900">
                            {s.vehicleCode} · {s.vehiclePlate}
                          </td>
                          <td className="py-2.5 px-4 text-slate-700">{s.driverName}</td>
                          <td className="py-2.5 px-4 text-slate-700 max-w-xs truncate">
                            {s.locationName}
                          </td>
                          <td className="py-2.5 px-4 font-mono tabular-nums text-xs text-slate-600">
                            {s.entryTime}
                          </td>
                          <td className="py-2.5 px-4 font-mono tabular-nums text-xs text-slate-600">
                            {s.exitTime ?? 'En punto'}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                            {formatMinutesAsHours(s.durationMinutes)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'events' && (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                      <th className="py-2.5 px-4">Fecha / Hora</th>
                      <th className="py-2.5 px-4">Vehículo</th>
                      <th className="py-2.5 px-4">Conductor</th>
                      <th className="py-2.5 px-4">Evento</th>
                      <th className="py-2.5 px-4">Dirección</th>
                      <th className="py-2.5 px-4">Observaciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.events.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-500">
                          Sin eventos en este rango.
                        </td>
                      </tr>
                    ) : (
                      report.events.map((ev) => (
                        <tr key={ev.id} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4 font-mono tabular-nums text-xs text-slate-700 whitespace-nowrap">
                            {ev.event_date} {ev.event_time}
                          </td>
                          <td className="py-2.5 px-4 font-semibold text-slate-900 whitespace-nowrap">
                            {ev.vehicle_code_snapshot} · {ev.vehicle_plate_snapshot}
                          </td>
                          <td className="py-2.5 px-4 text-slate-700">{ev.driver_name_snapshot}</td>
                          <td className="py-2.5 px-4 text-slate-800 whitespace-nowrap">
                            {formatEventLabel(ev.event_type)}
                          </td>
                          <td className="py-2.5 px-4 text-xs text-slate-600 max-w-xs truncate">
                            {ev.geofence_name_snapshot ? `${ev.geofence_name_snapshot} — ` : ''}
                            {ev.address}
                          </td>
                          <td className="py-2.5 px-4 text-xs text-slate-500">{ev.notes || '-'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
