import type { EventType } from '../types.ts';

export interface PendingDriverEvent {
  event_uuid: string;
  event_type: EventType;
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
  notes: string;
  recorded_at: string;
  event_date: string;
  event_time: string;
}

export interface PendingGpsPoint {
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
  recorded_at: string;
}

export interface OfflineDriverQueue {
  events: PendingDriverEvent[];
  gpsPoints: PendingGpsPoint[];
}

export interface SyncOfflineResponse {
  syncedEventUuids: string[];
  rejectedEvents: Array<{ event_uuid: string; reason: string }>;
  syncedEventsCount: number;
  syncedPointsCount: number;
}

const STORAGE_PREFIX = 'copaques_offline_queue_v1_';
const MAX_OFFLINE_POINTS = 500;

function getStorageKey(userId: number): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function haversineMetersClient(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function getColombiaDateParts(date: Date = new Date()): {
  eventDate: string;
  eventTime: string;
  recordedAt: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hour = map.hour === '24' ? '00' : map.hour;

  return {
    eventDate: `${map.year}-${map.month}-${map.day}`,
    eventTime: `${hour}:${map.minute}:${map.second}`,
    recordedAt: date.toISOString(),
  };
}

export function generateClientUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const rand = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${rand()}${rand()}-${rand()}-${rand()}-${rand()}-${rand()}${rand()}${rand()}`;
}

export function loadOfflineQueue(userId: number): OfflineDriverQueue {
  try {
    const raw = localStorage.getItem(getStorageKey(userId));
    if (!raw) return { events: [], gpsPoints: [] };
    const parsed = JSON.parse(raw) as Partial<OfflineDriverQueue>;
    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      gpsPoints: Array.isArray(parsed.gpsPoints) ? parsed.gpsPoints : [],
    };
  } catch {
    return { events: [], gpsPoints: [] };
  }
}

function saveOfflineQueue(userId: number, queue: OfflineDriverQueue): OfflineDriverQueue {
  try {
    localStorage.setItem(getStorageKey(userId), JSON.stringify(queue));
  } catch {
    // If storage quota is full, trim oldest GPS breadcrumbs and retry once
    const trimmed: OfflineDriverQueue = {
      events: queue.events,
      gpsPoints: queue.gpsPoints.slice(-150),
    };
    try {
      localStorage.setItem(getStorageKey(userId), JSON.stringify(trimmed));
      return trimmed;
    } catch {
      // ignore unrecoverable storage quota errors
    }
  }
  return queue;
}

export function enqueueOfflineEvent(
  userId: number,
  event: PendingDriverEvent
): OfflineDriverQueue {
  const queue = loadOfflineQueue(userId);
  if (queue.events.some((e) => e.event_uuid === event.event_uuid)) {
    return queue;
  }
  const next: OfflineDriverQueue = {
    events: [...queue.events, event],
    gpsPoints: queue.gpsPoints,
  };
  return saveOfflineQueue(userId, next);
}

export function enqueueOfflineGpsPoint(
  userId: number,
  point: PendingGpsPoint
): OfflineDriverQueue {
  const queue = loadOfflineQueue(userId);
  const last = queue.gpsPoints[queue.gpsPoints.length - 1];
  if (last) {
    const dist = haversineMetersClient(
      last.latitude,
      last.longitude,
      point.latitude,
      point.longitude
    );
    const elapsedSec =
      (new Date(point.recorded_at).getTime() - new Date(last.recorded_at).getTime()) / 1000;
    if (dist < 25 && elapsedSec < 120) {
      return queue;
    }
  }

  let nextPoints = [...queue.gpsPoints, point];
  if (nextPoints.length > MAX_OFFLINE_POINTS) {
    nextPoints = nextPoints.slice(nextPoints.length - MAX_OFFLINE_POINTS);
  }

  return saveOfflineQueue(userId, {
    events: queue.events,
    gpsPoints: nextPoints,
  });
}

export function removeSyncedItems(
  userId: number,
  handledEventUuids: string[],
  syncedPointsTimestamps: Set<string>
): OfflineDriverQueue {
  const queue = loadOfflineQueue(userId);
  const handledSet = new Set(handledEventUuids);
  const next: OfflineDriverQueue = {
    events: queue.events.filter((e) => !handledSet.has(e.event_uuid)),
    gpsPoints: queue.gpsPoints.filter((p) => !syncedPointsTimestamps.has(p.recorded_at)),
  };
  return saveOfflineQueue(userId, next);
}
