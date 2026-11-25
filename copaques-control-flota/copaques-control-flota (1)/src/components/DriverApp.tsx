import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  LogIn,
  LogOut,
  MapPin,
  Navigation,
  Play,
  RefreshCw,
  Square,
  Truck,
} from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import {
  formatEventLabel,
  type DriverStatusResponse,
  type EventType,
  type FleetEvent,
  type User,
} from '../types.ts';

interface DriverAppProps {
  user: User;
  onLogout: () => void;
}

const QUICK_NOTES = [
  'Carga de material',
  'Descarga en obra',
  'Entrega en cliente',
  'Espera en fila',
  'Carga de combustible',
];

interface GpsReading {
  latitude: number;
  longitude: number;
  accuracy: number;
  capturedAt: string;
}

export function DriverApp({ user, onLogout }: DriverAppProps) {
  const [status, setStatus] = useState<DriverStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notes, setNotes] = useState('');
  const [gps, setGps] = useState<GpsReading | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [elapsedText, setElapsedText] = useState('00:00:00');
  const [logoError, setLogoError] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const data = await apiFetch<DriverStatusResponse>('/api/driver/status');
      setStatus(data);
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Error al cargar estado.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const readCurrentGps = useCallback((): Promise<GpsReading> => {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('Este dispositivo no soporta GPS en el navegador.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const reading: GpsReading = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
            capturedAt: new Date().toLocaleTimeString('es-ES', { hour12: false }),
          };
          setGps(reading);
          setGpsError(null);
          resolve(reading);
        },
        (err) => {
          let msg = 'No se pudo obtener ubicación GPS.';
          if (err.code === err.PERMISSION_DENIED) {
            msg = 'Permiso de GPS denegado. Activa la ubicación para este sitio en tu navegador.';
          } else if (err.code === err.POSITION_UNAVAILABLE) {
            msg = 'Señal GPS no disponible en este momento. Muévete a un área despejada.';
          } else if (err.code === err.TIMEOUT) {
            msg = 'Tiempo agotado al esperar señal GPS. Intenta nuevamente.';
          }
          setGpsError(msg);
          reject(new Error(msg));
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
      );
    });
  }, []);

  useEffect(() => {
    loadStatus();
    readCurrentGps().catch(() => {});
  }, [loadStatus, readCurrentGps]);

  // Live elapsed shift clock
  useEffect(() => {
    if (!status?.shiftActive || !status.shiftStartedAt) {
      setElapsedText('00:00:00');
      return;
    }
    const updateTimer = () => {
      const diffMs = Math.max(0, Date.now() - new Date(status.shiftStartedAt!).getTime());
      const totalSec = Math.floor(diffMs / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      setElapsedText(
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      );
    };
    updateTimer();
    const timer = setInterval(updateTimer, 1000);
    return () => clearInterval(timer);
  }, [status?.shiftActive, status?.shiftStartedAt]);

  // Automatic background geofence detection while on shift
  useEffect(() => {
    if (!status?.shiftActive || !status.hasVehicle || status.activeGeofencesCount === 0) {
      return;
    }

    const runGeofenceCheck = async () => {
      try {
        const pos = await readCurrentGps();
        const res = await apiFetch<{
          triggeredEvents: FleetEvent[];
          currentGeofence: DriverStatusResponse['currentGeofence'];
        }>('/api/driver/geofence-ping', {
          method: 'POST',
          body: JSON.stringify({
            latitude: pos.latitude,
            longitude: pos.longitude,
          }),
        });
        if (res.triggeredEvents.length > 0) {
          await loadStatus();
          const last = res.triggeredEvents[res.triggeredEvents.length - 1];
          setFeedback({
            type: 'ok',
            text: `Geocerca automática: ${formatEventLabel(last.event_type)} en ${last.geofence_name_snapshot ?? last.address}`,
          });
        }
      } catch {
        // Silent background check; manual controls show GPS errors if needed
      }
    };

    const interval = setInterval(runGeofenceCheck, 30000);
    return () => clearInterval(interval);
  }, [status?.shiftActive, status?.hasVehicle, status?.activeGeofencesCount, readCurrentGps, loadStatus]);

  async function registerEvent(eventType: EventType) {
    setFeedback(null);
    setSubmitting(true);
    try {
      const reading = await readCurrentGps();
      const res = await apiFetch<{ event: FleetEvent }>('/api/driver/events', {
        method: 'POST',
        body: JSON.stringify({
          event_type: eventType,
          latitude: reading.latitude,
          longitude: reading.longitude,
          accuracy_meters: reading.accuracy,
          notes: notes.trim(),
        }),
      });
      setNotes('');
      setConfirmFinish(false);
      await loadStatus();
      setFeedback({
        type: 'ok',
        text: `${formatEventLabel(res.event.event_type)} registrado a las ${res.event.event_time} · ${res.event.address}`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'No se pudo registrar el evento.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#f6f9f6] text-slate-900 pb-10">
      {/* Compact Sticky Top Bar */}
      <header className="sticky top-0 z-30 h-14 bg-white text-slate-900 px-4 flex items-center justify-between gap-3 border-b-2 border-[#0e7a2d]">
        <div className="flex items-center gap-3 min-w-0">
          {!logoError ? (
            <img
              src="/assets/aistudio/image_2fcce064.png"
              alt="Copaques"
              referrerPolicy="no-referrer"
              onError={() => setLogoError(true)}
              className="h-9 w-auto object-contain shrink-0 rounded"
            />
          ) : (
            <div className="w-8 h-8 rounded-lg bg-[#0e7a2d] text-white flex items-center justify-center shrink-0">
              <Truck className="w-4 h-4" />
            </div>
          )}
          <div className="min-w-0 border-l border-slate-200 pl-3">
            <p className="text-sm font-bold truncate leading-tight text-[#181a18]">
              {user.vehicle_code ? `${user.vehicle_code} (${user.vehicle_plate})` : 'Sin vehículo'}
            </p>
            <p className="text-xs text-slate-600 truncate leading-tight">{user.full_name}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={onLogout}
          className="min-h-[40px] px-3 rounded-lg bg-[#0e7a2d] hover:bg-[#0b6123] text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>Salir</span>
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-4 pt-5 space-y-5">
        {loading ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-500">
            Cargando estado del camión...
          </div>
        ) : !status?.hasVehicle ? (
          <div className="bg-yellow-50 border border-yellow-300 rounded-2xl p-6 text-emerald-950">
            <h2 className="text-lg font-bold">Camión no asignado</h2>
            <p className="mt-1 text-sm">
              Tu usuario no tiene un camión vinculado actualmente. Solicita a Gerencia que te asigne un vehículo.
            </p>
          </div>
        ) : (
          <>
            {/* Status & GPS Panel */}
            <section className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-slate-500">Estado Actual</p>
                  <div className="mt-1 flex items-center gap-2.5">
                    {status.shiftActive ? (
                      <>
                        <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
                        <span className="text-xl font-bold text-emerald-700">
                          Jornada Activa
                        </span>
                      </>
                    ) : (
                      <>
                        <Clock className="w-6 h-6 text-slate-400 shrink-0" />
                        <span className="text-xl font-bold text-slate-700">
                          Fuera de Jornada
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {status.shiftActive && (
                  <div className="text-right">
                    <p className="text-xs font-medium text-slate-500">Tiempo en Jornada</p>
                    <p className="mt-0.5 text-2xl font-bold font-mono tabular-nums text-slate-900">
                      {elapsedText}
                    </p>
                  </div>
                )}
              </div>

              {status.currentGeofence && (
                <div className="mt-4 pt-3 border-t border-slate-100 flex items-center gap-2 text-sm text-emerald-800 font-medium">
                  <MapPin className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>
                    En geocerca: {status.currentGeofence.name} ({status.currentGeofence.category})
                  </span>
                </div>
              )}

              {/* GPS Bar */}
              <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs">
                {gps ? (
                  <div className="flex items-center gap-2 text-slate-600 font-mono tabular-nums">
                    <Navigation className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>
                      GPS listo ({gps.latitude.toFixed(5)}, {gps.longitude.toFixed(5)} · ±{gps.accuracy} m)
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-amber-700">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>{gpsError || 'Obteniendo ubicación GPS...'}</span>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => readCurrentGps().catch(() => {})}
                  className="min-h-[40px] px-3 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 font-medium flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Actualizar GPS</span>
                </button>
              </div>
            </section>

            {/* Feedback Banner */}
            {feedback && (
              <div
                className={`rounded-2xl p-4 border text-sm font-medium flex items-start gap-3 ${
                  feedback.type === 'ok'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-red-50 border-red-200 text-red-900'
                }`}
              >
                {feedback.type === 'ok' ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                )}
                <span>{feedback.text}</span>
              </div>
            )}

            {/* Primary Driver Controls */}
            <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
              {!status.shiftActive ? (
                <div className="space-y-4">
                  <p className="text-sm text-slate-600">
                    Presiona el botón para comenzar tu día laboral. La fecha, hora y ubicación GPS se guardarán automáticamente.
                  </p>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => registerEvent('INICIO_JORNADA')}
                    className="w-full min-h-[76px] rounded-2xl bg-emerald-800 hover:bg-emerald-900 active:scale-[0.99] text-white text-xl font-bold flex items-center justify-center gap-3 transition-transform disabled:opacity-60 cursor-pointer"
                  >
                    <Play className="w-6 h-6 fill-current" />
                    <span>{submitting ? 'Registrando...' : 'Iniciar Jornada'}</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => registerEvent('ENTRADA')}
                      className="min-h-[84px] rounded-2xl bg-emerald-700 hover:bg-emerald-800 active:scale-[0.99] text-white text-xl font-bold flex items-center justify-center gap-3 transition-transform disabled:opacity-60 cursor-pointer"
                    >
                      <LogIn className="w-7 h-7" />
                      <span>Registrar Entrada</span>
                    </button>

                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => registerEvent('SALIDA')}
                      className="min-h-[84px] rounded-2xl bg-yellow-400 hover:bg-yellow-300 active:scale-[0.99] text-emerald-950 text-xl font-bold flex items-center justify-center gap-3 transition-transform disabled:opacity-60 cursor-pointer border border-yellow-500/40"
                    >
                      <LogOut className="w-7 h-7" />
                      <span>Registrar Salida</span>
                    </button>
                  </div>

                  {/* Optional Observations */}
                  <div className="pt-2 border-t border-slate-100">
                    <label className="block text-sm font-semibold text-slate-800 mb-2">
                      Observaciones opcionales (antes de presionar un botón)
                    </label>
                    <div className="flex flex-wrap gap-2 mb-2.5">
                      {QUICK_NOTES.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setNotes(tag)}
                          className={`min-h-[40px] px-3 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                            notes === tag
                              ? 'bg-emerald-800 text-white border-emerald-800'
                              : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-emerald-50'
                          }`}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      maxLength={300}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Ej. Entrega de 200 bolsas de cemento en Obra Norte..."
                      className="w-full h-12 px-3.5 rounded-xl border border-slate-300 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                  </div>

                  {/* End Shift */}
                  <div className="pt-3 border-t border-slate-100">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => setConfirmFinish(true)}
                      className="w-full min-h-[56px] rounded-xl border-2 border-red-200 bg-red-50 hover:bg-red-100 text-red-800 font-bold text-base flex items-center justify-center gap-2.5 transition-colors disabled:opacity-60 cursor-pointer"
                    >
                      <Square className="w-5 h-5 fill-current" />
                      <span>Finalizar Jornada</span>
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Today's Immutable History */}
            <section className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-slate-900">Historial de Hoy</h2>
                <span className="text-xs text-slate-500 font-mono tabular-nums">
                  {status.todayEvents.length} registro(s)
                </span>
              </div>

              {status.todayEvents.length === 0 ? (
                <p className="text-sm text-slate-500 py-6 text-center">
                  Aún no has registrado movimientos el día de hoy.
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {status.todayEvents.map((ev) => (
                    <div key={ev.id} className="py-3.5 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span
                            className={`font-bold ${
                              ev.event_type === 'INICIO_JORNADA'
                                ? 'text-slate-900'
                                : ev.event_type === 'ENTRADA'
                                  ? 'text-emerald-700'
                                  : ev.event_type === 'SALIDA'
                                    ? 'text-amber-700'
                                    : 'text-red-700'
                            }`}
                          >
                            {formatEventLabel(ev.event_type)}
                          </span>
                          <span aria-hidden="true" className="text-slate-300">·</span>
                          <span className="text-xs text-slate-500">
                            {ev.source === 'GEOCERCA_AUTO' ? 'Geocerca automática' : 'Registro manual'}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-slate-700 break-words">
                          {ev.geofence_name_snapshot ? `${ev.geofence_name_snapshot} — ` : ''}
                          {ev.address}
                        </p>
                        {ev.notes && (
                          <p className="mt-1 text-xs text-slate-500 italic">
                            Nota: {ev.notes}
                          </p>
                        )}
                        <p className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
                          {ev.latitude.toFixed(5)}, {ev.longitude.toFixed(5)}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold font-mono tabular-nums text-slate-900">
                          {ev.event_time}
                        </p>
                        <p className="text-xs font-mono tabular-nums text-slate-400">
                          {ev.event_date}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {/* Confirm End Shift Modal */}
      {confirmFinish && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl p-6 space-y-4 border border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">¿Finalizar Jornada Laboral?</h3>
            <p className="text-sm text-slate-600">
              Se registrará la hora de cierre y tu ubicación GPS actual. Podrás consultar tu historial del día en cualquier momento.
            </p>
            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmFinish(false)}
                className="min-h-[48px] rounded-xl border border-slate-300 text-slate-700 font-semibold text-sm hover:bg-slate-50 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => registerEvent('FIN_JORNADA')}
                className="min-h-[48px] rounded-xl bg-red-600 hover:bg-red-700 text-white font-semibold text-sm cursor-pointer disabled:opacity-60"
              >
                {submitting ? 'Guardando...' : 'Sí, Finalizar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
