import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  CloudOff,
  LogIn,
  LogOut,
  MapPin,
  Navigation,
  Play,
  RefreshCw,
  Square,
  Truck,
  UploadCloud,
  Utensils,
  Wifi,
} from 'lucide-react';
import { ApiError, apiFetch, setAuthToken } from '../lib/api.ts';
import {
  enqueueOfflineEvent,
  enqueueOfflineGpsPoint,
  generateClientUuid,
  getColombiaDateParts,
  loadCachedAvailableVehicles,
  loadOfflineQueue,
  removeSyncedItems,
  saveCachedAvailableVehicles,
  type OfflineDriverQueue,
  type PendingDriverEvent,
  type SyncOfflineResponse,
} from '../lib/offlineQueue.ts';
import {
  formatEventLabel,
  getColombiaToday,
  type DriverAvailableVehicle,
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

interface DisplayDriverEvent {
  key: string;
  event_uuid: string;
  event_type: EventType;
  sourceLabel: string;
  locationText: string;
  notes: string;
  latitude: number;
  longitude: number;
  event_time: string;
  event_date: string;
  recorded_at: string;
  pending: boolean;
}

export function DriverApp({ user, onLogout }: DriverAppProps) {
  const [status, setStatus] = useState<DriverStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [pendingQueue, setPendingQueue] = useState<OfflineDriverQueue>(() =>
    loadOfflineQueue(user.id)
  );
  const [cachedVehicles, setCachedVehicles] = useState<DriverAvailableVehicle[]>(() =>
    loadCachedAvailableVehicles(user.id)
  );
  const [selectedVehicleId, setSelectedVehicleId] = useState<number | null>(
    user.vehicle_id ?? null
  );
  const [notes, setNotes] = useState('');
  const [gps, setGps] = useState<GpsReading | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err' | 'warn'; text: string } | null>(
    null
  );
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [elapsedText, setElapsedText] = useState('00:00:00');
  const [lunchElapsedText, setLunchElapsedText] = useState('00:00:00');
  const [logoError, setLogoError] = useState(false);

  const syncingRef = useRef(false);
  const lastRefreshRef = useRef<number>(Date.now());

  useEffect(() => {
    setPendingQueue(loadOfflineQueue(user.id));
    setCachedVehicles(loadCachedAvailableVehicles(user.id));
  }, [user.id]);

  const loadStatus = useCallback(async () => {
    try {
      const data = await apiFetch<DriverStatusResponse>('/api/driver/status');
      setStatus(data);
      saveCachedAvailableVehicles(user.id, data.availableVehicles);
      setCachedVehicles(data.availableVehicles);
    } catch (err) {
      if (err instanceof ApiError) {
        setFeedback({ type: 'err', text: err.message });
      } else {
        setIsOnline(false);
      }
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  const keepSessionAlive = useCallback(async (force = false) => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const now = Date.now();
    if (!force && now - lastRefreshRef.current < 30 * 60 * 1000) return;
    try {
      const res = await apiFetch<{ user: User; token?: string }>('/api/auth/refresh', {
        method: 'POST',
      });
      if (res.token) {
        setAuthToken(res.token);
      }
      lastRefreshRef.current = now;
    } catch {
      // Ignore transient offline errors; cookie lasts 180 days
    }
  }, []);

  const syncOfflineQueue = useCallback(
    async (manual = false) => {
      if (syncingRef.current) return;
      const currentQueue = loadOfflineQueue(user.id);
      if (currentQueue.events.length === 0 && currentQueue.gpsPoints.length === 0) {
        if (manual) {
          setFeedback({ type: 'ok', text: 'Todo está al día. No hay registros pendientes.' });
        }
        return;
      }
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (manual) {
          setFeedback({
            type: 'warn',
            text: 'Sigues sin señal de internet. Los registros se enviarán solos al recuperar conexión.',
          });
        }
        return;
      }

      syncingRef.current = true;
      setSyncing(true);
      try {
        const snapshotPoints = currentQueue.gpsPoints.slice(0, 1000);
        const snapshotEvents = currentQueue.events.slice(0, 200);
        const sentPointTimestamps = new Set(snapshotPoints.map((p) => p.recorded_at));

        const res = await apiFetch<SyncOfflineResponse>('/api/driver/sync-offline', {
          method: 'POST',
          body: JSON.stringify({
            events: snapshotEvents,
            gpsPoints: snapshotPoints,
          }),
        });

        const handledUuids = [
          ...res.syncedEventUuids,
          ...res.rejectedEvents.map((r) => r.event_uuid),
        ];

        const updatedQueue = removeSyncedItems(
          user.id,
          handledUuids,
          res.syncedPointsCount > 0 ? sentPointTimestamps : new Set()
        );
        setPendingQueue(updatedQueue);
        await loadStatus();

        if (res.rejectedEvents.length > 0) {
          setFeedback({
            type: 'warn',
            text: `Sincronización completada (${res.syncedEventsCount} evento(s), ${res.syncedPointsCount} punto(s) GPS). ${res.rejectedEvents.length} registro(s) fueron omitidos por secuencia horaria.`,
          });
        } else if (res.syncedEventsCount > 0 || res.syncedPointsCount > 0 || manual) {
          setFeedback({
            type: 'ok',
            text: `Sincronización exitosa: ${res.syncedEventsCount} registro(s) y ${res.syncedPointsCount} punto(s) GPS enviados al servidor.`,
          });
        }
      } catch (err) {
        if (err instanceof ApiError) {
          setFeedback({ type: 'err', text: err.message });
        } else {
          setIsOnline(false);
          if (manual) {
            setFeedback({
              type: 'warn',
              text: 'No se pudo conectar al servidor. Tus datos siguen guardados en el equipo.',
            });
          }
        }
      } finally {
        syncingRef.current = false;
        setSyncing(false);
      }
    },
    [user.id, loadStatus]
  );

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      keepSessionAlive(true);
      syncOfflineQueue(false);
    };
    const handleOffline = () => {
      setIsOnline(false);
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        keepSessionAlive(false);
      }
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    const keepAliveTimer = setInterval(() => {
      keepSessionAlive(true);
    }, 6 * 60 * 60 * 1000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(keepAliveTimer);
    };
  }, [syncOfflineQueue, keepSessionAlive]);

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
    loadStatus().then(() => {
      syncOfflineQueue(false);
    });
    readCurrentGps().catch(() => {});
  }, [loadStatus, syncOfflineQueue, readCurrentGps]);

  // Retry syncing queued items automatically every 20s when signal is available
  useEffect(() => {
    const hasPending = pendingQueue.events.length > 0 || pendingQueue.gpsPoints.length > 0;
    if (!hasPending || !isOnline) return;
    const timer = setInterval(() => {
      syncOfflineQueue(false);
    }, 20000);
    return () => clearInterval(timer);
  }, [pendingQueue.events.length, pendingQueue.gpsPoints.length, isOnline, syncOfflineQueue]);

  const availableVehiclesList = useMemo(
    () => status?.availableVehicles ?? cachedVehicles,
    [status?.availableVehicles, cachedVehicles]
  );

  // Pick a sensible default idle vehicle when off-shift
  useEffect(() => {
    if (availableVehiclesList.length === 0) return;
    const isSelectable = (v: DriverAvailableVehicle) =>
      !v.inUseByDriverName || v.inUseByUserId === user.id;

    const currentValid = availableVehiclesList.find(
      (v) => v.id === selectedVehicleId && isSelectable(v)
    );
    if (currentValid) return;

    const defaultPref =
      availableVehiclesList.find((v) => v.id === user.vehicle_id && isSelectable(v)) ??
      availableVehiclesList.find(isSelectable) ??
      null;
    setSelectedVehicleId(defaultPref ? defaultPref.id : null);
  }, [availableVehiclesList, selectedVehicleId, user.id, user.vehicle_id]);

  // Combine server shift state with locally queued offline events
  const effectiveShift = useMemo(() => {
    let active = status?.shiftActive ?? false;
    let startedAt = status?.shiftStartedAt ?? null;
    let onLunch = status?.onLunch ?? false;
    let lunchStartedAt = status?.lunchStartedAt ?? null;
    let vehicleId: number | null = status?.activeVehicle?.id ?? null;
    let vehicleCode: string | null = status?.activeVehicle?.code ?? null;
    let vehiclePlate: string | null = status?.activeVehicle?.plate ?? null;
    const serverLatestRecordedAt = status?.todayEvents?.[0]?.recorded_at ?? '';

    const sortedPending = [...pendingQueue.events].sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
    );

    for (const ev of sortedPending) {
      if (serverLatestRecordedAt && ev.recorded_at <= serverLatestRecordedAt) {
        continue;
      }
      if (ev.event_type === 'INICIO_JORNADA') {
        active = true;
        startedAt = ev.recorded_at;
        onLunch = false;
        lunchStartedAt = null;
        vehicleId = ev.vehicle_id ?? vehicleId;
        vehicleCode = ev.vehicle_code ?? vehicleCode;
        vehiclePlate = ev.vehicle_plate ?? vehiclePlate;
      } else if (ev.event_type === 'INICIO_ALMUERZO') {
        onLunch = true;
        lunchStartedAt = ev.recorded_at;
      } else if (ev.event_type === 'FIN_ALMUERZO') {
        onLunch = false;
        lunchStartedAt = null;
      } else if (ev.event_type === 'FIN_JORNADA') {
        active = false;
        startedAt = null;
        onLunch = false;
        lunchStartedAt = null;
        vehicleId = null;
        vehicleCode = null;
        vehiclePlate = null;
      }
    }

    return {
      shiftActive: active,
      shiftStartedAt: startedAt,
      onLunch,
      lunchStartedAt,
      vehicleId,
      vehicleCode,
      vehiclePlate,
    };
  }, [
    status?.shiftActive,
    status?.shiftStartedAt,
    status?.onLunch,
    status?.lunchStartedAt,
    status?.activeVehicle,
    status?.todayEvents,
    pendingQueue.events,
  ]);

  // Merge pending offline events with server events for today's history
  const mergedTodayEvents = useMemo<DisplayDriverEvent[]>(() => {
    const todayStr = getColombiaToday();
    const byUuid = new Map<string, DisplayDriverEvent>();

    for (const ev of status?.todayEvents ?? []) {
      byUuid.set(ev.event_uuid, {
        key: `srv-${ev.id}`,
        event_uuid: ev.event_uuid,
        event_type: ev.event_type,
        sourceLabel:
          ev.source === 'GEOCERCA_AUTO' ? 'Geocerca automática' : 'Registro manual',
        locationText: `${ev.geofence_name_snapshot ? `${ev.geofence_name_snapshot} — ` : ''}${ev.address}`,
        notes: ev.notes,
        latitude: ev.latitude,
        longitude: ev.longitude,
        event_time: ev.event_time,
        event_date: ev.event_date,
        recorded_at: ev.recorded_at,
        pending: false,
      });
    }

    for (const pev of pendingQueue.events) {
      if (pev.event_date !== todayStr && status?.todayEvents?.length) {
        // Still show pending events so the driver never loses visibility of unsynced work
      }
      if (!byUuid.has(pev.event_uuid)) {
        byUuid.set(pev.event_uuid, {
          key: `off-${pev.event_uuid}`,
          event_uuid: pev.event_uuid,
          event_type: pev.event_type,
          sourceLabel: 'Pendiente de sincronizar (sin señal)',
          locationText: `Coordenadas guardadas sin señal (${pev.latitude.toFixed(5)}, ${pev.longitude.toFixed(5)})`,
          notes: pev.notes,
          latitude: pev.latitude,
          longitude: pev.longitude,
          event_time: pev.event_time,
          event_date: pev.event_date,
          recorded_at: pev.recorded_at,
          pending: true,
        });
      }
    }

    return Array.from(byUuid.values()).sort(
      (a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
    );
  }, [status?.todayEvents, pendingQueue.events]);

  // Live elapsed shift clock
  useEffect(() => {
    if (!effectiveShift.shiftActive || !effectiveShift.shiftStartedAt) {
      setElapsedText('00:00:00');
      return;
    }
    const updateTimer = () => {
      const diffMs = Math.max(
        0,
        Date.now() - new Date(effectiveShift.shiftStartedAt!).getTime()
      );
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
  }, [effectiveShift.shiftActive, effectiveShift.shiftStartedAt]);

  // Live elapsed lunch clock
  useEffect(() => {
    if (!effectiveShift.shiftActive || !effectiveShift.onLunch || !effectiveShift.lunchStartedAt) {
      setLunchElapsedText('00:00:00');
      return;
    }
    const updateLunchTimer = () => {
      const diffMs = Math.max(
        0,
        Date.now() - new Date(effectiveShift.lunchStartedAt!).getTime()
      );
      const totalSec = Math.floor(diffMs / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      setLunchElapsedText(
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      );
    };
    updateLunchTimer();
    const timer = setInterval(updateLunchTimer, 1000);
    return () => clearInterval(timer);
  }, [effectiveShift.shiftActive, effectiveShift.onLunch, effectiveShift.lunchStartedAt]);

  // Automatic background GPS route tracking & geofence detection while on shift (works offline too)
  useEffect(() => {
    const hasShiftVehicle = Boolean(effectiveShift.vehicleId || status?.hasVehicle || user.vehicle_id);
    if (!effectiveShift.shiftActive || !hasShiftVehicle) {
      return;
    }

    const runGpsAndGeofenceCheck = async () => {
      let pos: GpsReading;
      try {
        pos = await readCurrentGps();
      } catch {
        return;
      }

      const nowIso = new Date().toISOString();
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const nextQ = enqueueOfflineGpsPoint(user.id, {
          latitude: pos.latitude,
          longitude: pos.longitude,
          accuracy_meters: pos.accuracy,
          recorded_at: nowIso,
        });
        setPendingQueue(nextQ);
        return;
      }

      try {
        const res = await apiFetch<{
          triggeredEvents: FleetEvent[];
          currentGeofence: DriverStatusResponse['currentGeofence'];
        }>('/api/driver/geofence-ping', {
          method: 'POST',
          body: JSON.stringify({
            latitude: pos.latitude,
            longitude: pos.longitude,
            accuracy_meters: pos.accuracy,
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
      } catch (err) {
        if (!(err instanceof ApiError)) {
          setIsOnline(false);
          const nextQ = enqueueOfflineGpsPoint(user.id, {
            latitude: pos.latitude,
            longitude: pos.longitude,
            accuracy_meters: pos.accuracy,
            recorded_at: nowIso,
          });
          setPendingQueue(nextQ);
        }
      }
    };

    const interval = setInterval(runGpsAndGeofenceCheck, 15000);
    return () => clearInterval(interval);
  }, [
    effectiveShift.shiftActive,
    effectiveShift.vehicleId,
    status?.hasVehicle,
    user.id,
    user.vehicle_id,
    readCurrentGps,
    loadStatus,
  ]);

  function saveEventLocally(
    eventType: EventType,
    reading: GpsReading,
    eventUuid: string,
    cleanNotes: string,
    chosenVehicle?: DriverAvailableVehicle | null
  ) {
    const now = new Date();
    const { eventDate, eventTime, recordedAt } = getColombiaDateParts(now);
    const pendingEv: PendingDriverEvent = {
      event_uuid: eventUuid,
      event_type: eventType,
      vehicle_id: chosenVehicle?.id ?? effectiveShift.vehicleId ?? user.vehicle_id ?? null,
      vehicle_code: chosenVehicle?.code ?? effectiveShift.vehicleCode ?? undefined,
      vehicle_plate: chosenVehicle?.plate ?? effectiveShift.vehiclePlate ?? undefined,
      latitude: reading.latitude,
      longitude: reading.longitude,
      accuracy_meters: reading.accuracy,
      notes: cleanNotes,
      recorded_at: recordedAt,
      event_date: eventDate,
      event_time: eventTime,
    };
    const nextQ = enqueueOfflineEvent(user.id, pendingEv);
    setPendingQueue(nextQ);
    setNotes('');
    setConfirmFinish(false);
    setFeedback({
      type: 'warn',
      text: `Sin señal: ${formatEventLabel(eventType)} guardado en este equipo a las ${eventTime}. Se enviará automáticamente al recuperar señal.`,
    });
  }

  async function registerEvent(eventType: EventType) {
    setFeedback(null);

    let chosenVehicle: DriverAvailableVehicle | null = null;
    if (eventType === 'INICIO_JORNADA') {
      chosenVehicle =
        availableVehiclesList.find((v) => v.id === selectedVehicleId) ?? null;
      if (!chosenVehicle) {
        setFeedback({
          type: 'err',
          text: 'Selecciona primero el camión en el que trabajarás hoy.',
        });
        return;
      }
      if (chosenVehicle.inUseByDriverName && chosenVehicle.inUseByUserId !== user.id) {
        setFeedback({
          type: 'err',
          text: `El camión ${chosenVehicle.code} ya está en jornada con ${chosenVehicle.inUseByDriverName}.`,
        });
        return;
      }
    }

    setSubmitting(true);
    const eventUuid = generateClientUuid();
    const cleanNotes = notes.trim();

    let reading: GpsReading;
    try {
      reading = await readCurrentGps();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'No se pudo obtener ubicación GPS.',
      });
      setSubmitting(false);
      return;
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsOnline(false);
      saveEventLocally(eventType, reading, eventUuid, cleanNotes, chosenVehicle);
      setSubmitting(false);
      return;
    }

    try {
      const res = await apiFetch<{ event: FleetEvent }>('/api/driver/events', {
        method: 'POST',
        body: JSON.stringify({
          event_uuid: eventUuid,
          event_type: eventType,
          vehicle_id: chosenVehicle ? chosenVehicle.id : undefined,
          latitude: reading.latitude,
          longitude: reading.longitude,
          accuracy_meters: reading.accuracy,
          notes: cleanNotes,
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
      if (err instanceof ApiError) {
        setFeedback({
          type: 'err',
          text: err.message,
        });
      } else {
        // Network failure in dead zone: queue locally instead of losing the event
        setIsOnline(false);
        saveEventLocally(eventType, reading, eventUuid, cleanNotes, chosenVehicle);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const hasAvailableVehicles =
    availableVehiclesList.length > 0 || Boolean(effectiveShift.vehicleId) || Boolean(status?.hasVehicle);
  const selectedVehicleObj =
    availableVehiclesList.find((v) => v.id === selectedVehicleId) ?? null;
  const headerVehicleText = effectiveShift.shiftActive && effectiveShift.vehicleCode
    ? `${effectiveShift.vehicleCode} (${effectiveShift.vehiclePlate})`
    : selectedVehicleObj
      ? `${selectedVehicleObj.code} (${selectedVehicleObj.plate})`
      : 'Elige camión al iniciar';
  const pendingCount = pendingQueue.events.length + pendingQueue.gpsPoints.length;

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
              {headerVehicleText}
            </p>
            <p className="text-xs text-slate-600 truncate leading-tight">
              {user.full_name}
              {user.driver_code ? ` · Cód. ${user.driver_code}` : ''}
              {user.sede_name ? ` · ${user.sede_name}` : ''}
            </p>
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
        {loading && !status ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-500">
            Cargando estado del camión...
          </div>
        ) : !hasAvailableVehicles ? (
          <div className="bg-yellow-50 border border-yellow-300 rounded-2xl p-6 text-emerald-950">
            <h2 className="text-lg font-bold">No hay camiones disponibles en tu sede</h2>
            <p className="mt-1 text-sm">
              Tu sede aún no tiene camiones activos registrados. Solicita a Gerencia o al Administrador de tu sede que agregue o traslade un vehículo.
            </p>
          </div>
        ) : (
          <>
            {/* Connection & Offline Queue Banner */}
            {!isOnline || pendingCount > 0 ? (
              <section
                className={`rounded-2xl p-4 border flex flex-wrap items-center justify-between gap-3 ${
                  !isOnline
                    ? 'bg-amber-50 border-amber-300 text-amber-950'
                    : 'bg-emerald-50 border-emerald-200 text-emerald-950'
                }`}
              >
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  {!isOnline ? (
                    <CloudOff className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                  ) : (
                    <UploadCloud className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
                  )}
                  <div className="text-xs sm:text-sm">
                    <p className="font-bold">
                      {!isOnline
                        ? 'Modo sin señal activo (GPS funcionando)'
                        : 'Registros pendientes listos para enviar'}
                    </p>
                    <p className="mt-0.5 text-slate-700">
                      {pendingQueue.events.length} movimiento(s) y {pendingQueue.gpsPoints.length} punto(s) GPS guardados en el equipo.
                      {!isOnline
                        ? ' Mantén esta pestaña abierta hasta recuperar señal para que se envíen solos.'
                        : ' Se sincronizarán automáticamente.'}
                    </p>
                  </div>
                </div>
                {isOnline && pendingCount > 0 && (
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={() => syncOfflineQueue(true)}
                    className="min-h-[40px] px-3.5 rounded-xl bg-[#0e7a2d] hover:bg-[#0b6123] text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 cursor-pointer disabled:opacity-60"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                    <span>{syncing ? 'Sincronizando...' : 'Sincronizar ahora'}</span>
                  </button>
                )}
              </section>
            ) : (
              <div className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-xs text-slate-600">
                <div className="flex items-center gap-2">
                  <Wifi className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Conexión activa · Guardado automático sin señal habilitado</span>
                </div>
              </div>
            )}

            {/* Status & GPS Panel */}
            <section className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-slate-500">Estado Actual</p>
                  <div className="mt-1 flex items-center gap-2.5">
                    {effectiveShift.shiftActive ? (
                      effectiveShift.onLunch ? (
                        <>
                          <Utensils className="w-6 h-6 text-amber-600 shrink-0" />
                          <span className="text-xl font-bold text-amber-700">
                            En Almuerzo
                          </span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
                          <span className="text-xl font-bold text-emerald-700">
                            Jornada Activa
                          </span>
                        </>
                      )
                    ) : (
                      <>
                        <Clock className="w-6 h-6 text-slate-400 shrink-0" />
                        <span className="text-xl font-bold text-slate-700">
                          Fuera de Jornada
                        </span>
                      </>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Jornada diaria estándar: <span className="font-mono font-semibold text-slate-700">{status?.dailyWorkHours ?? 8}h</span> (el almuerzo no cuenta dentro de la jornada)
                  </p>
                </div>

                {effectiveShift.shiftActive && (
                  <div className="text-right">
                    <p className="text-xs font-medium text-slate-500">
                      {effectiveShift.onLunch ? 'Tiempo en Almuerzo' : 'Tiempo en Jornada'}
                    </p>
                    <p className={`mt-0.5 text-2xl font-bold font-mono tabular-nums ${effectiveShift.onLunch ? 'text-amber-700' : 'text-slate-900'}`}>
                      {effectiveShift.onLunch ? lunchElapsedText : elapsedText}
                    </p>
                    {effectiveShift.onLunch && (
                      <p className="text-[11px] font-mono text-slate-500">
                        Total turno: {elapsedText}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {status?.currentGeofence && (
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
                    : feedback.type === 'warn'
                      ? 'bg-amber-50 border-amber-300 text-amber-950'
                      : 'bg-red-50 border-red-200 text-red-900'
                }`}
              >
                {feedback.type === 'ok' ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                ) : feedback.type === 'warn' ? (
                  <CloudOff className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                )}
                <span>{feedback.text}</span>
              </div>
            )}

            {/* Primary Driver Controls */}
            <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
              {!effectiveShift.shiftActive ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-bold text-slate-900 mb-2">
                      1. Selecciona el camión que vas a conducir hoy
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {availableVehiclesList.map((v) => {
                        const occupied =
                          Boolean(v.inUseByDriverName) && v.inUseByUserId !== user.id;
                        const isSelected = selectedVehicleId === v.id;
                        return (
                          <button
                            key={v.id}
                            type="button"
                            disabled={occupied}
                            onClick={() => setSelectedVehicleId(v.id)}
                            className={`text-left p-3.5 rounded-xl border-2 transition-all flex items-center justify-between gap-2 ${
                              occupied
                                ? 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed'
                                : isSelected
                                  ? 'bg-emerald-50 border-[#0e7a2d] text-emerald-950 cursor-pointer'
                                  : 'bg-white border-slate-200 hover:border-emerald-400 text-slate-800 cursor-pointer'
                            }`}
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-bold font-mono">
                                {v.code} · {v.plate}
                              </p>
                              <p className="text-xs text-slate-500 truncate">
                                {occupied
                                  ? `En turno con ${v.inUseByDriverName}`
                                  : [v.brand, v.model].filter(Boolean).join(' ') || 'Disponible'}
                              </p>
                            </div>
                            <Truck
                              className={`w-5 h-5 shrink-0 ${
                                isSelected && !occupied ? 'text-[#0e7a2d]' : 'text-slate-400'
                              }`}
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <p className="text-sm text-slate-600">
                    Presiona el botón para comenzar tu jornada con el camión elegido. La fecha, hora y ubicación GPS se guardarán automáticamente{!isOnline ? ' (modo sin señal)' : ''}.
                  </p>
                  <button
                    type="button"
                    disabled={submitting || !selectedVehicleId}
                    onClick={() => registerEvent('INICIO_JORNADA')}
                    className="w-full min-h-[76px] rounded-2xl bg-emerald-800 hover:bg-emerald-900 active:scale-[0.99] text-white text-xl font-bold flex items-center justify-center gap-3 transition-transform disabled:opacity-60 cursor-pointer"
                  >
                    <Play className="w-6 h-6 fill-current" />
                    <span>{submitting ? 'Registrando...' : 'Iniciar Jornada'}</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-5">
                  {effectiveShift.onLunch ? (
                    <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 space-y-3">
                      <div className="flex items-start gap-2.5 text-amber-950">
                        <Utensils className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                        <div className="text-sm">
                          <p className="font-bold">Estás en horario de almuerzo</p>
                          <p className="text-xs text-amber-900 mt-0.5">
                            Este tiempo no cuenta dentro de las {status?.dailyWorkHours ?? 8}h laborales. Presiona el botón cuando retomes tus labores.
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => registerEvent('FIN_ALMUERZO')}
                        className="w-full min-h-[76px] rounded-2xl bg-amber-600 hover:bg-amber-700 active:scale-[0.99] text-white text-xl font-bold flex items-center justify-center gap-3 transition-transform disabled:opacity-60 cursor-pointer"
                      >
                        <Utensils className="w-6 h-6" />
                        <span>{submitting ? 'Registrando...' : 'Finalizar Almuerzo'}</span>
                      </button>
                    </div>
                  ) : (
                    <>
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

                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => registerEvent('INICIO_ALMUERZO')}
                        className="w-full min-h-[58px] rounded-xl bg-amber-50 hover:bg-amber-100 active:scale-[0.99] border-2 border-amber-300 text-amber-950 text-base font-bold flex items-center justify-center gap-2.5 transition-colors disabled:opacity-60 cursor-pointer"
                      >
                        <Utensils className="w-5 h-5 text-amber-700" />
                        <span>Salir a Almorzar (no cuenta en jornada)</span>
                      </button>
                    </>
                  )}

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
                  {mergedTodayEvents.length} registro(s)
                </span>
              </div>

              {mergedTodayEvents.length === 0 ? (
                <p className="text-sm text-slate-500 py-6 text-center">
                  Aún no has registrado movimientos el día de hoy.
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {mergedTodayEvents.map((ev) => (
                    <div
                      key={ev.key}
                      className={`py-3.5 flex items-start justify-between gap-4 ${
                        ev.pending ? 'bg-amber-50/60 -mx-2 px-2 rounded-xl' : ''
                      }`}
                    >
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
                                    : ev.event_type === 'INICIO_ALMUERZO' ||
                                        ev.event_type === 'FIN_ALMUERZO'
                                      ? 'text-orange-700'
                                      : 'text-red-700'
                            }`}
                          >
                            {formatEventLabel(ev.event_type)}
                          </span>
                          <span aria-hidden="true" className="text-slate-300">·</span>
                          <span
                            className={`text-xs ${
                              ev.pending ? 'text-amber-800 font-semibold' : 'text-slate-500'
                            }`}
                          >
                            {ev.sourceLabel}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-slate-700 break-words">
                          {ev.locationText}
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
