import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  type AuthenticatedUser,
  type AuthedRequest,
  clearSessionCookie,
  getUserById,
  requireAuth,
  requireRole,
  setSessionCookie,
  signAuthToken,
  type UserRole,
} from './server/auth.ts';
import {
  db,
  getServerDateParts,
  haversineMeters,
  initDatabase,
} from './server/db.ts';
import { reverseGeocode } from './server/geocode.ts';
import { createProjectZipBuffer } from './server/zip.ts';

dotenv.config();
initDatabase();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

// Security headers (no X-Frame-Options to preserve iframe compatibility)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const VALID_EVENT_TYPES = ['INICIO_JORNADA', 'FIN_JORNADA', 'ENTRADA', 'SALIDA'] as const;
const VALID_CATEGORIES = ['Planta', 'Cliente', 'Obra', 'Bodega', 'Proveedor', 'Otro'] as const;

interface SedeRow {
  id: number;
  name: string;
  code: string;
  latitude: number;
  longitude: number;
  active: number;
}

interface VehicleRow {
  id: number;
  code: string;
  plate: string;
  brand: string;
  model: string;
  capacity_tons: number;
  sede_id: number | null;
  soat_expires_at: string;
  tecnomecanica_expires_at: string;
  active: number;
  created_at: string;
}

interface GeofenceRow {
  id: number;
  name: string;
  category: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  sede_id: number | null;
  active: number;
}

interface EventRow {
  id: number;
  event_uuid: string;
  event_date: string;
  event_time: string;
  recorded_at: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
  address: string;
  user_id: number;
  username_snapshot: string;
  driver_name_snapshot: string;
  driver_code_snapshot: string;
  vehicle_id: number | null;
  vehicle_code_snapshot: string;
  vehicle_plate_snapshot: string;
  sede_id: number | null;
  sede_name_snapshot: string;
  event_type: 'INICIO_JORNADA' | 'FIN_JORNADA' | 'ENTRADA' | 'SALIDA';
  source: 'MANUAL' | 'GEOCERCA_AUTO';
  geofence_id: number | null;
  geofence_name_snapshot: string | null;
  notes: string;
  created_at: string;
}

interface RoutePointRow {
  id: number;
  vehicle_id: number;
  user_id: number;
  event_date: string;
  recorded_at: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
}

function logAudit(actorUserId: number | null, action: string, details: string): void {
  db.prepare(
    'INSERT INTO system_audit_log (actor_user_id, action, details, created_at) VALUES (?, ?, ?, ?)'
  ).run(actorUserId, action, details, new Date().toISOString());
}

function validateCoords(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (
    !Number.isFinite(nLat) ||
    !Number.isFinite(nLng) ||
    nLat < -90 ||
    nLat > 90 ||
    nLng < -180 ||
    nLng > 180
  ) {
    return null;
  }
  return { lat: nLat, lng: nLng };
}

function resolveScopedSedeId(user: AuthenticatedUser, requestedSedeId?: unknown): number | null {
  if (user.role === 'ADMIN') {
    return user.sede_id ?? -1;
  }
  if (requestedSedeId !== undefined && requestedSedeId !== null && String(requestedSedeId).trim() !== '') {
    const parsed = Number(requestedSedeId);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function getSedeById(sedeId: number | null | undefined): SedeRow | null {
  if (!sedeId) return null;
  const row = db.prepare('SELECT * FROM sedes WHERE id = ?').get(sedeId) as SedeRow | undefined;
  return row ?? null;
}

function getVehicleSedeInfo(vehicleId: number): { sede_id: number | null; sede_name: string } {
  const row = db
    .prepare(
      `SELECT v.sede_id, COALESCE(s.name, '') AS sede_name
       FROM vehicles v
       LEFT JOIN sedes s ON s.id = v.sede_id
       WHERE v.id = ?`
    )
    .get(vehicleId) as { sede_id: number | null; sede_name: string } | undefined;
  return row ?? { sede_id: null, sede_name: '' };
}

function recordRoutePoint(
  vehicleId: number,
  userId: number,
  eventDate: string,
  recordedAt: string,
  lat: number,
  lng: number,
  accuracy: number | null,
  force = false
): void {
  if (!force) {
    const last = db
      .prepare(
        `SELECT latitude, longitude, recorded_at FROM route_points
         WHERE vehicle_id = ? AND event_date = ?
         ORDER BY recorded_at DESC, id DESC LIMIT 1`
      )
      .get(vehicleId, eventDate) as { latitude: number; longitude: number; recorded_at: string } | undefined;

    if (last) {
      const dist = haversineMeters(last.latitude, last.longitude, lat, lng);
      const elapsedSec = (new Date(recordedAt).getTime() - new Date(last.recorded_at).getTime()) / 1000;
      if (dist < 25 && elapsedSec < 120) {
        return;
      }
    }
  }

  db.prepare(
    `INSERT INTO route_points (vehicle_id, user_id, event_date, recorded_at, latitude, longitude, accuracy_meters)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(vehicleId, userId, eventDate, recordedAt, lat, lng, accuracy);
}

function findMatchingGeofence(lat: number, lng: number, sedeId: number | null): GeofenceRow | null {
  const activeGeofences = (
    sedeId
      ? db
          .prepare(
            'SELECT id, name, category, latitude, longitude, radius_meters, sede_id, active FROM geofences WHERE active = 1 AND (sede_id = ? OR sede_id IS NULL)'
          )
          .all(sedeId)
      : db
          .prepare('SELECT id, name, category, latitude, longitude, radius_meters, sede_id, active FROM geofences WHERE active = 1')
          .all()
  ) as GeofenceRow[];

  let closest: GeofenceRow | null = null;
  let closestDist = Infinity;

  for (const gf of activeGeofences) {
    const dist = haversineMeters(lat, lng, gf.latitude, gf.longitude);
    if (dist <= gf.radius_meters && dist < closestDist) {
      closest = gf;
      closestDist = dist;
    }
  }
  return closest;
}

function validateExpiryDate(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return trimmed;
}

function validateDriverCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(clean)) return null;
  return clean;
}

function getVehicleShiftStatus(vehicleId: number): {
  shiftActive: boolean;
  shiftStartedAt: string | null;
  lastEvent: EventRow | null;
} {
  const lastEvent = db
    .prepare(
      'SELECT * FROM events WHERE vehicle_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1'
    )
    .get(vehicleId) as EventRow | undefined;

  if (!lastEvent || lastEvent.event_type === 'FIN_JORNADA') {
    return { shiftActive: false, shiftStartedAt: null, lastEvent: lastEvent ?? null };
  }

  const lastStart = db
    .prepare(
      `SELECT recorded_at FROM events
       WHERE vehicle_id = ? AND event_type = 'INICIO_JORNADA'
       ORDER BY recorded_at DESC, id DESC LIMIT 1`
    )
    .get(vehicleId) as { recorded_at: string } | undefined;

  return {
    shiftActive: true,
    shiftStartedAt: lastStart?.recorded_at ?? lastEvent.recorded_at,
    lastEvent,
  };
}

function getDriverActiveShift(userId: number): {
  shiftActive: boolean;
  shiftStartedAt: string | null;
  vehicleId: number | null;
  vehicleCode: string | null;
  vehiclePlate: string | null;
  sedeId: number | null;
  sedeName: string;
  lastEvent: EventRow | null;
} {
  const lastEvent = db
    .prepare(
      'SELECT * FROM events WHERE user_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1'
    )
    .get(userId) as EventRow | undefined;

  if (!lastEvent || lastEvent.event_type === 'FIN_JORNADA' || !lastEvent.vehicle_id) {
    return {
      shiftActive: false,
      shiftStartedAt: null,
      vehicleId: null,
      vehicleCode: null,
      vehiclePlate: null,
      sedeId: null,
      sedeName: '',
      lastEvent: lastEvent ?? null,
    };
  }

  const veh = db
    .prepare(
      `SELECT v.id, v.code, v.plate, v.sede_id, COALESCE(s.name, '') AS sede_name
       FROM vehicles v
       LEFT JOIN sedes s ON s.id = v.sede_id
       WHERE v.id = ?`
    )
    .get(lastEvent.vehicle_id) as
    | { id: number; code: string; plate: string; sede_id: number | null; sede_name: string }
    | undefined;

  const lastStart = db
    .prepare(
      `SELECT recorded_at FROM events
       WHERE user_id = ? AND event_type = 'INICIO_JORNADA'
       ORDER BY recorded_at DESC, id DESC LIMIT 1`
    )
    .get(userId) as { recorded_at: string } | undefined;

  return {
    shiftActive: true,
    shiftStartedAt: lastStart?.recorded_at ?? lastEvent.recorded_at,
    vehicleId: lastEvent.vehicle_id,
    vehicleCode: veh?.code ?? lastEvent.vehicle_code_snapshot,
    vehiclePlate: veh?.plate ?? lastEvent.vehicle_plate_snapshot,
    sedeId: veh?.sede_id ?? lastEvent.sede_id ?? null,
    sedeName: veh?.sede_name ?? lastEvent.sede_name_snapshot ?? '',
    lastEvent,
  };
}

// ==========================================
// HEALTH & AUTHENTICATION
// ==========================================

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/api/auth/status', (_req: Request, res: Response) => {
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'GERENCIA' AND active = 1")
    .get() as { cnt: number };
  const envAdminConfigured = Boolean(
    process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim().length > 0
  );
  res.json({
    needsInitialSetup: row.cnt === 0,
    envAdminConfigured,
  });
});

app.post('/api/auth/setup', (req: Request, res: Response) => {
  const { username, password, full_name } = req.body ?? {};
  const cleanUser = typeof username === 'string' ? username.trim().toLowerCase() : '';
  const cleanName = typeof full_name === 'string' ? full_name.trim() : '';
  const cleanPass = typeof password === 'string' ? password : '';

  if (cleanUser.length < 3 || cleanUser.length > 40) {
    res.status(400).json({ error: 'El usuario debe tener entre 3 y 40 caracteres.' });
    return;
  }
  if (!/^[a-z0-9._-]+$/.test(cleanUser)) {
    res.status(400).json({ error: 'El usuario solo puede contener letras, números, puntos o guiones.' });
    return;
  }
  if (cleanPass.length < 6) {
    res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    return;
  }
  if (cleanName.length < 2) {
    res.status(400).json({ error: 'Ingresa el nombre completo del gerente.' });
    return;
  }

  const hash = bcrypt.hashSync(cleanPass, 10);
  const now = new Date().toISOString();

  const createTx = db.transaction(() => {
    const existing = db
      .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'GERENCIA' AND active = 1")
      .get() as { cnt: number };
    if (existing.cnt > 0) {
      return null;
    }
    const result = db
      .prepare(
        `INSERT INTO users (username, password_hash, full_name, role, sede_id, vehicle_id, active, created_at)
         VALUES (?, ?, ?, 'GERENCIA', NULL, NULL, 1, ?)`
      )
      .run(cleanUser, hash, cleanName, now);
    const createdId = Number(result.lastInsertRowid);
    logAudit(createdId, 'INITIAL_ADMIN_SETUP', `Cuenta inicial de gerencia creada: ${cleanUser}`);
    return getUserById(createdId);
  });

  const user = createTx();
  if (!user) {
    res.status(409).json({ error: 'La configuración inicial de gerencia ya fue completada.' });
    return;
  }

  const token = signAuthToken({
    userId: user.id,
    username: user.username,
    role: user.role,
  });
  setSessionCookie(res, token, user.role);

  res.status(201).json({ token, user });
});

app.post('/api/auth/login', (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  const cleanUser = typeof username === 'string' ? username.trim().toLowerCase() : '';
  const cleanPass = typeof password === 'string' ? password : '';

  if (!cleanUser || !cleanPass) {
    res.status(400).json({ error: 'Ingresa usuario y contraseña.' });
    return;
  }

  const envAdminPass = process.env.ADMIN_PASSWORD?.trim() ?? '';

  // Support env-configured ADMIN_PASSWORD override for Gerencia
  if (envAdminPass && cleanPass === envAdminPass && (cleanUser === 'admin' || cleanUser === 'gerencia')) {
    let adminUser = db
      .prepare("SELECT * FROM users WHERE username = ? AND role = 'GERENCIA' AND deleted_at IS NULL")
      .get(cleanUser) as { id: number; active: number } | undefined;

    if (!adminUser) {
      const anyGerencia = db
        .prepare("SELECT * FROM users WHERE role = 'GERENCIA' AND active = 1 AND deleted_at IS NULL LIMIT 1")
        .get() as { id: number; active: number } | undefined;

      if (anyGerencia && cleanUser === 'gerencia') {
        adminUser = anyGerencia;
      } else {
        const hash = bcrypt.hashSync(envAdminPass, 10);
        const now = new Date().toISOString();
        const resInsert = db
          .prepare(
            `INSERT INTO users (username, password_hash, full_name, role, sede_id, vehicle_id, active, created_at)
             VALUES (?, ?, 'Gerencia General', 'GERENCIA', NULL, NULL, 1, ?)`
          )
          .run(cleanUser, hash, now);
        adminUser = { id: Number(resInsert.lastInsertRowid), active: 1 };
      }
    }

    if (adminUser.active === 1) {
      const user = getUserById(adminUser.id)!;
      const token = signAuthToken({
        userId: user.id,
        username: user.username,
        role: user.role,
      });
      setSessionCookie(res, token, user.role);
      res.json({ token, user });
      return;
    }
  }

  const dbUser = db
    .prepare('SELECT id, username, password_hash, role, active FROM users WHERE username = ? AND deleted_at IS NULL')
    .get(cleanUser) as
    | { id: number; username: string; password_hash: string; role: UserRole; active: number }
    | undefined;

  if (!dbUser || dbUser.active !== 1) {
    res.status(401).json({ error: 'Credenciales inválidas o usuario desactivado.' });
    return;
  }

  const passwordValid = bcrypt.compareSync(cleanPass, dbUser.password_hash);
  if (!passwordValid) {
    res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    return;
  }

  const user = getUserById(dbUser.id);
  if (!user) {
    res.status(401).json({ error: 'Usuario no encontrado.' });
    return;
  }

  const token = signAuthToken({
    userId: user.id,
    username: user.username,
    role: user.role,
  });
  setSessionCookie(res, token, user.role);

  res.json({ token, user });
});

app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const freshToken = signAuthToken({
    userId: user.id,
    username: user.username,
    role: user.role,
  });
  setSessionCookie(res, freshToken, user.role);
  res.json({ user, token: freshToken });
});

app.post('/api/auth/refresh', requireAuth, (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const freshToken = signAuthToken({
    userId: user.id,
    username: user.username,
    role: user.role,
  });
  setSessionCookie(res, freshToken, user.role);
  res.json({ user, token: freshToken });
});

app.post('/api/auth/logout', (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ==========================================
// DRIVER ROUTES (CONDUCTOR)
// ==========================================

app.get('/api/driver/status', requireAuth, (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const { eventDate } = getServerDateParts();

  const driverShift = getDriverActiveShift(user.id);
  const todayEvents = db
    .prepare(
      `SELECT * FROM events
       WHERE user_id = ? AND event_date = ?
       ORDER BY recorded_at DESC, id DESC`
    )
    .all(user.id, eventDate) as EventRow[];

  const availableVehicleRows = (
    user.sede_id
      ? db
          .prepare(
            `SELECT v.id, v.code, v.plate, v.brand, v.model, v.sede_id, COALESCE(s.name, '') AS sede_name
             FROM vehicles v
             LEFT JOIN sedes s ON s.id = v.sede_id
             WHERE v.active = 1 AND v.sede_id = ?
             ORDER BY v.code ASC`
          )
          .all(user.sede_id)
      : db
          .prepare(
            `SELECT v.id, v.code, v.plate, v.brand, v.model, v.sede_id, COALESCE(s.name, '') AS sede_name
             FROM vehicles v
             LEFT JOIN sedes s ON s.id = v.sede_id
             WHERE v.active = 1
             ORDER BY s.name ASC, v.code ASC`
          )
          .all()
  ) as Array<{
    id: number;
    code: string;
    plate: string;
    brand: string;
    model: string;
    sede_id: number | null;
    sede_name: string;
  }>;

  const availableVehicles = availableVehicleRows.map((v) => {
    const vShift = getVehicleShiftStatus(v.id);
    const busyByOther = vShift.shiftActive && vShift.lastEvent && vShift.lastEvent.user_id !== user.id;
    return {
      ...v,
      inUseByDriverName: busyByOther ? vShift.lastEvent!.driver_name_snapshot : null,
      inUseByUserId: busyByOther ? vShift.lastEvent!.user_id : null,
    };
  });

  const activeVehicle = driverShift.shiftActive && driverShift.vehicleId
    ? {
        id: driverShift.vehicleId,
        code: driverShift.vehicleCode ?? '',
        plate: driverShift.vehiclePlate ?? '',
        sede_id: driverShift.sedeId,
        sede_name: driverShift.sedeName,
      }
    : null;

  let currentGeofence: {
    id: number;
    name: string;
    category: string;
    entered_at: string | null;
  } | null = null;

  if (driverShift.shiftActive && driverShift.vehicleId) {
    const stateRow = db
      .prepare(
        `SELECT s.current_geofence_id, s.entered_at, g.name, g.category
         FROM driver_geofence_state s
         LEFT JOIN geofences g ON g.id = s.current_geofence_id
         WHERE s.vehicle_id = ?`
      )
      .get(driverShift.vehicleId) as
      | { current_geofence_id: number | null; entered_at: string | null; name: string | null; category: string | null }
      | undefined;

    if (stateRow && stateRow.current_geofence_id && stateRow.name) {
      currentGeofence = {
        id: stateRow.current_geofence_id,
        name: stateRow.name,
        category: stateRow.category ?? '',
        entered_at: stateRow.entered_at,
      };
    }
  }

  const effectiveSedeId = driverShift.sedeId ?? user.sede_id;
  const gfCount = (
    effectiveSedeId
      ? db
          .prepare('SELECT COUNT(*) AS cnt FROM geofences WHERE active = 1 AND (sede_id = ? OR sede_id IS NULL)')
          .get(effectiveSedeId)
      : db.prepare('SELECT COUNT(*) AS cnt FROM geofences WHERE active = 1').get()
  ) as { cnt: number };

  res.json({
    hasVehicle: Boolean(activeVehicle || availableVehicles.length > 0),
    shiftActive: driverShift.shiftActive,
    shiftStartedAt: driverShift.shiftStartedAt,
    activeVehicle,
    availableVehicles,
    currentGeofence,
    todayEvents,
    activeGeofencesCount: gfCount.cnt,
  });
});

function validateEventUuid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(trimmed)) return null;
  return trimmed;
}

function validateOfflineRecordedAt(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = new Date(raw);
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) return null;
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const fiveMinFutureMs = 5 * 60 * 1000;
  if (ms < now - thirtyDaysMs || ms > now + fiveMinFutureMs) {
    return null;
  }
  return parsed;
}

app.post('/api/driver/events', requireAuth, async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const { event_type, vehicle_id, latitude, longitude, accuracy_meters, notes, event_uuid } = req.body ?? {};
  const clientUuid = validateEventUuid(event_uuid);
  if (clientUuid) {
    const existing = db
      .prepare('SELECT * FROM events WHERE event_uuid = ? AND user_id = ?')
      .get(clientUuid, user.id) as EventRow | undefined;
    if (existing) {
      res.json({ event: existing, matchedGeofence: null, deduplicated: true });
      return;
    }
  }

  if (!VALID_EVENT_TYPES.includes(event_type)) {
    res.status(400).json({ error: 'Tipo de evento inválido.' });
    return;
  }

  const coords = validateCoords(latitude, longitude);
  if (!coords) {
    res.status(400).json({
      error: 'Ubicación GPS inválida. Activa el GPS de tu dispositivo e intenta nuevamente.',
    });
    return;
  }

  const cleanNotes =
    typeof notes === 'string' ? notes.trim().slice(0, 500) : '';
  const cleanAccuracy =
    typeof accuracy_meters === 'number' && Number.isFinite(accuracy_meters) && accuracy_meters >= 0
      ? Math.round(accuracy_meters * 10) / 10
      : null;

  const driverShift = getDriverActiveShift(user.id);

  let targetVehicle: {
    id: number;
    code: string;
    plate: string;
    sede_id: number | null;
    sede_name: string;
  } | null = null;

  if (event_type === 'INICIO_JORNADA') {
    if (driverShift.shiftActive) {
      res.status(400).json({ error: 'Ya tienes una jornada activa en curso.' });
      return;
    }

    const requestedVehId = vehicle_id ? Number(vehicle_id) : user.vehicle_id;
    if (!requestedVehId || !Number.isInteger(requestedVehId)) {
      res.status(400).json({ error: 'Debes seleccionar el camión que vas a conducir hoy.' });
      return;
    }

    const veh = db
      .prepare(
        `SELECT v.id, v.code, v.plate, v.sede_id, v.active, COALESCE(s.name, '') AS sede_name
         FROM vehicles v
         LEFT JOIN sedes s ON s.id = v.sede_id
         WHERE v.id = ?`
      )
      .get(requestedVehId) as
      | { id: number; code: string; plate: string; sede_id: number | null; active: number; sede_name: string }
      | undefined;

    if (!veh || veh.active !== 1) {
      res.status(400).json({ error: 'El camión seleccionado no está disponible o está inactivo.' });
      return;
    }
    if (user.sede_id !== null && veh.sede_id !== user.sede_id) {
      res.status(403).json({ error: 'Solo puedes seleccionar camiones asignados a tu sede.' });
      return;
    }

    const vehShift = getVehicleShiftStatus(veh.id);
    if (vehShift.shiftActive && vehShift.lastEvent && vehShift.lastEvent.user_id !== user.id) {
      res.status(409).json({
        error: `El camión ${veh.code} (${veh.plate}) ya tiene una jornada activa con ${vehShift.lastEvent.driver_name_snapshot}.`,
      });
      return;
    }

    targetVehicle = {
      id: veh.id,
      code: veh.code,
      plate: veh.plate,
      sede_id: veh.sede_id,
      sede_name: veh.sede_name,
    };
  } else {
    if (!driverShift.shiftActive || !driverShift.vehicleId) {
      res.status(400).json({ error: 'Debes iniciar jornada seleccionando un camión antes de registrar movimientos.' });
      return;
    }
    targetVehicle = {
      id: driverShift.vehicleId,
      code: driverShift.vehicleCode ?? '',
      plate: driverShift.vehiclePlate ?? '',
      sede_id: driverShift.sedeId,
      sede_name: driverShift.sedeName,
    };
  }

  const matchedGf = findMatchingGeofence(coords.lat, coords.lng, targetVehicle.sede_id);
  const address = await reverseGeocode(coords.lat, coords.lng);
  const { eventDate, eventTime, recordedAt } = getServerDateParts();
  const eventUuid = clientUuid ?? crypto.randomUUID();

  const insertTx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO events (
          event_uuid, event_date, event_time, recorded_at,
          latitude, longitude, accuracy_meters, address,
          user_id, username_snapshot, driver_name_snapshot, driver_code_snapshot,
          vehicle_id, vehicle_code_snapshot, vehicle_plate_snapshot,
          sede_id, sede_name_snapshot,
          event_type, source, geofence_id, geofence_name_snapshot,
          notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?)`
      )
      .run(
        eventUuid,
        eventDate,
        eventTime,
        recordedAt,
        coords.lat,
        coords.lng,
        cleanAccuracy,
        address,
        user.id,
        user.username,
        user.full_name,
        user.driver_code ?? '',
        targetVehicle!.id,
        targetVehicle!.code,
        targetVehicle!.plate,
        targetVehicle!.sede_id,
        targetVehicle!.sede_name,
        event_type,
        matchedGf ? matchedGf.id : null,
        matchedGf ? matchedGf.name : null,
        cleanNotes,
        recordedAt
      );

    // Record GPS breadcrumb point for route tracing
    recordRoutePoint(
      targetVehicle!.id,
      user.id,
      eventDate,
      recordedAt,
      coords.lat,
      coords.lng,
      cleanAccuracy,
      true
    );

    // Sync geofence state cleanly
    if (event_type === 'FIN_JORNADA' || event_type === 'SALIDA') {
      db.prepare(
        `INSERT INTO driver_geofence_state (vehicle_id, current_geofence_id, entered_at, last_lat, last_lng, updated_at)
         VALUES (?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(vehicle_id) DO UPDATE SET
           current_geofence_id = NULL,
           entered_at = NULL,
           last_lat = excluded.last_lat,
           last_lng = excluded.last_lng,
           updated_at = excluded.updated_at`
      ).run(targetVehicle!.id, coords.lat, coords.lng, recordedAt);
    } else {
      db.prepare(
        `INSERT INTO driver_geofence_state (vehicle_id, current_geofence_id, entered_at, last_lat, last_lng, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(vehicle_id) DO UPDATE SET
           current_geofence_id = excluded.current_geofence_id,
           entered_at = excluded.entered_at,
           last_lat = excluded.last_lat,
           last_lng = excluded.last_lng,
           updated_at = excluded.updated_at`
      ).run(
        targetVehicle!.id,
        matchedGf ? matchedGf.id : null,
        matchedGf ? recordedAt : null,
        coords.lat,
        coords.lng,
        recordedAt
      );
    }

    return db
      .prepare('SELECT * FROM events WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as EventRow;
  });

  const createdEvent = insertTx();
  res.status(201).json({ event: createdEvent, matchedGeofence: matchedGf });
});

app.post('/api/driver/geofence-ping', requireAuth, async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const driverShift = getDriverActiveShift(user.id);
  if (!driverShift.shiftActive || !driverShift.vehicleId) {
    res.json({ triggeredEvents: [], currentGeofence: null });
    return;
  }

  const coords = validateCoords(req.body?.latitude, req.body?.longitude);
  if (!coords) {
    res.status(400).json({ error: 'Coordenadas inválidas.' });
    return;
  }

  const cleanAccuracy =
    typeof req.body?.accuracy_meters === 'number' &&
    Number.isFinite(req.body.accuracy_meters) &&
    req.body.accuracy_meters >= 0
      ? Math.round(req.body.accuracy_meters * 10) / 10
      : null;

  const activeVehicleId = driverShift.vehicleId;
  const activeVehicleCode = driverShift.vehicleCode ?? '';
  const activeVehiclePlate = driverShift.vehiclePlate ?? '';
  const activeSedeId = driverShift.sedeId;
  const activeSedeName = driverShift.sedeName;
  const { eventDate, eventTime, recordedAt } = getServerDateParts();

  const currentState = db
    .prepare(
      `SELECT s.current_geofence_id, g.name, g.category
       FROM driver_geofence_state s
       LEFT JOIN geofences g ON g.id = s.current_geofence_id
       WHERE s.vehicle_id = ?`
    )
    .get(activeVehicleId) as
    | { current_geofence_id: number | null; name: string | null; category: string | null }
    | undefined;

  const previousGfId = currentState?.current_geofence_id ?? null;
  const matchedGf = findMatchingGeofence(coords.lat, coords.lng, activeSedeId);
  const nextGfId = matchedGf ? matchedGf.id : null;

  // Always store route breadcrumb while on shift; force point when entering/exiting geofence
  const transitioned = previousGfId !== nextGfId;
  recordRoutePoint(
    activeVehicleId,
    user.id,
    eventDate,
    recordedAt,
    coords.lat,
    coords.lng,
    cleanAccuracy,
    transitioned
  );

  if (!transitioned) {
    db.prepare(
      `INSERT INTO driver_geofence_state (vehicle_id, current_geofence_id, entered_at, last_lat, last_lng, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?)
       ON CONFLICT(vehicle_id) DO UPDATE SET
         last_lat = excluded.last_lat,
         last_lng = excluded.last_lng,
         updated_at = excluded.updated_at`
    ).run(activeVehicleId, previousGfId, coords.lat, coords.lng, recordedAt);

    res.json({
      triggeredEvents: [],
      currentGeofence: matchedGf
        ? { id: matchedGf.id, name: matchedGf.name, category: matchedGf.category }
        : null,
    });
    return;
  }

  const address = await reverseGeocode(coords.lat, coords.lng);
  const triggeredEvents: EventRow[] = [];

  const insertAutoEvent = (
    eventType: 'ENTRADA' | 'SALIDA',
    gfId: number | null,
    gfName: string | null,
    noteText: string
  ) => {
    const info = db
      .prepare(
        `INSERT INTO events (
          event_uuid, event_date, event_time, recorded_at,
          latitude, longitude, accuracy_meters, address,
          user_id, username_snapshot, driver_name_snapshot, driver_code_snapshot,
          vehicle_id, vehicle_code_snapshot, vehicle_plate_snapshot,
          sede_id, sede_name_snapshot,
          event_type, source, geofence_id, geofence_name_snapshot,
          notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'GEOCERCA_AUTO', ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        eventDate,
        eventTime,
        recordedAt,
        coords.lat,
        coords.lng,
        cleanAccuracy,
        address,
        user.id,
        user.username,
        user.full_name,
        user.driver_code ?? '',
        activeVehicleId,
        activeVehicleCode,
        activeVehiclePlate,
        activeSedeId,
        activeSedeName,
        eventType,
        gfId,
        gfName,
        noteText,
        recordedAt
      );
    const created = db
      .prepare('SELECT * FROM events WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as EventRow;
    triggeredEvents.push(created);
  };

  const tx = db.transaction(() => {
    if (previousGfId !== null) {
      const prevName = currentState?.name ?? 'Geocerca';
      insertAutoEvent('SALIDA', previousGfId, prevName, `Salida automática de geocerca: ${prevName}`);
    }
    if (matchedGf) {
      insertAutoEvent('ENTRADA', matchedGf.id, matchedGf.name, `Entrada automática a geocerca: ${matchedGf.name}`);
    }

    db.prepare(
      `INSERT INTO driver_geofence_state (vehicle_id, current_geofence_id, entered_at, last_lat, last_lng, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(vehicle_id) DO UPDATE SET
         current_geofence_id = excluded.current_geofence_id,
         entered_at = excluded.entered_at,
         last_lat = excluded.last_lat,
         last_lng = excluded.last_lng,
         updated_at = excluded.updated_at`
    ).run(
      activeVehicleId,
      nextGfId,
      nextGfId ? recordedAt : null,
      coords.lat,
      coords.lng,
      recordedAt
    );
  });

  tx();

  res.json({
    triggeredEvents,
    currentGeofence: matchedGf
      ? { id: matchedGf.id, name: matchedGf.name, category: matchedGf.category }
      : null,
  });
});

app.post('/api/driver/sync-offline', requireAuth, async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const rawEvents: unknown[] = Array.isArray(req.body?.events) ? req.body.events.slice(0, 200) : [];
  const rawPoints: unknown[] = Array.isArray(req.body?.gpsPoints) ? req.body.gpsPoints.slice(0, 1000) : [];

  const syncedEventUuids: string[] = [];
  const rejectedEvents: Array<{ event_uuid: string; reason: string }> = [];
  let syncedEventsCount = 0;
  let syncedPointsCount = 0;

  // Sort incoming events chronologically so shift state & vehicle selection validate in sequence
  const normalizedEvents = rawEvents
    .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : null))
    .filter((item): item is Record<string, unknown> => item !== null)
    .sort((a, b) => {
      const ta = typeof a.recorded_at === 'string' ? new Date(a.recorded_at).getTime() : 0;
      const tb = typeof b.recorded_at === 'string' ? new Date(b.recorded_at).getTime() : 0;
      return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
    });

  for (const item of normalizedEvents) {
    const uuid = validateEventUuid(item.event_uuid);
    if (!uuid) continue;

    const existing = db
      .prepare('SELECT id FROM events WHERE event_uuid = ?')
      .get(uuid) as { id: number } | undefined;
    if (existing) {
      syncedEventUuids.push(uuid);
      continue;
    }

    const eventType = item.event_type as EventRow['event_type'];
    if (!VALID_EVENT_TYPES.includes(eventType)) {
      rejectedEvents.push({ event_uuid: uuid, reason: 'Tipo de evento inválido.' });
      continue;
    }

    const coords = validateCoords(item.latitude, item.longitude);
    if (!coords) {
      rejectedEvents.push({ event_uuid: uuid, reason: 'Coordenadas GPS inválidas.' });
      continue;
    }

    const recordedDateObj = validateOfflineRecordedAt(item.recorded_at);
    if (!recordedDateObj) {
      rejectedEvents.push({ event_uuid: uuid, reason: 'Fecha u hora fuera de rango válido.' });
      continue;
    }

    const cleanNotes = typeof item.notes === 'string' ? item.notes.trim().slice(0, 500) : '';
    const cleanAccuracy =
      typeof item.accuracy_meters === 'number' &&
      Number.isFinite(item.accuracy_meters) &&
      item.accuracy_meters >= 0
        ? Math.round(item.accuracy_meters * 10) / 10
        : null;

    const { eventDate, eventTime, recordedAt } = getServerDateParts(recordedDateObj);

    // Resolve vehicle either from INICIO_JORNADA payload or from prior open shift event for this driver
    let resolvedVehicle: {
      id: number;
      code: string;
      plate: string;
      sede_id: number | null;
      sede_name: string;
    } | null = null;

    if (eventType === 'INICIO_JORNADA') {
      const reqVehId = item.vehicle_id ? Number(item.vehicle_id) : user.vehicle_id;
      if (!reqVehId || !Number.isInteger(reqVehId)) {
        rejectedEvents.push({ event_uuid: uuid, reason: 'Falta seleccionar vehículo para iniciar jornada.' });
        continue;
      }
      const veh = db
        .prepare(
          `SELECT v.id, v.code, v.plate, v.sede_id, COALESCE(s.name, '') AS sede_name
           FROM vehicles v
           LEFT JOIN sedes s ON s.id = v.sede_id
           WHERE v.id = ?`
        )
        .get(reqVehId) as
        | { id: number; code: string; plate: string; sede_id: number | null; sede_name: string }
        | undefined;
      if (!veh) {
        rejectedEvents.push({ event_uuid: uuid, reason: 'Vehículo seleccionado no existe.' });
        continue;
      }
      if (user.sede_id !== null && veh.sede_id !== user.sede_id) {
        rejectedEvents.push({ event_uuid: uuid, reason: 'Vehículo pertenece a otra sede.' });
        continue;
      }
      resolvedVehicle = veh;
    } else {
      const priorEvent = db
        .prepare(
          `SELECT event_type, vehicle_id, vehicle_code_snapshot, vehicle_plate_snapshot, sede_id, sede_name_snapshot
           FROM events WHERE user_id = ? AND recorded_at <= ?
           ORDER BY recorded_at DESC, id DESC LIMIT 1`
        )
        .get(user.id, recordedAt) as EventRow | undefined;

      if (!priorEvent || priorEvent.event_type === 'FIN_JORNADA' || !priorEvent.vehicle_id) {
        rejectedEvents.push({ event_uuid: uuid, reason: 'No había una jornada activa en ese horario.' });
        continue;
      }
      resolvedVehicle = {
        id: priorEvent.vehicle_id,
        code: priorEvent.vehicle_code_snapshot,
        plate: priorEvent.vehicle_plate_snapshot,
        sede_id: priorEvent.sede_id,
        sede_name: priorEvent.sede_name_snapshot,
      };
    }

    const matchedGf = findMatchingGeofence(coords.lat, coords.lng, resolvedVehicle.sede_id);
    const address = await reverseGeocode(coords.lat, coords.lng);

    const txResult = db.transaction(() => {
      const dup = db.prepare('SELECT id FROM events WHERE event_uuid = ?').get(uuid);
      if (dup) {
        return { ok: true as const, inserted: false };
      }

      const priorEvent = db
        .prepare(
          'SELECT event_type FROM events WHERE user_id = ? AND recorded_at <= ? ORDER BY recorded_at DESC, id DESC LIMIT 1'
        )
        .get(user.id, recordedAt) as { event_type: EventRow['event_type'] } | undefined;

      const activeBefore = Boolean(priorEvent && priorEvent.event_type !== 'FIN_JORNADA');
      if (eventType === 'INICIO_JORNADA' && activeBefore) {
        return { ok: false as const, reason: 'Ya existía una jornada activa en ese horario.' };
      }
      if (eventType !== 'INICIO_JORNADA' && !activeBefore) {
        return { ok: false as const, reason: 'No había una jornada activa en ese horario.' };
      }

      db.prepare(
        `INSERT INTO events (
          event_uuid, event_date, event_time, recorded_at,
          latitude, longitude, accuracy_meters, address,
          user_id, username_snapshot, driver_name_snapshot, driver_code_snapshot,
          vehicle_id, vehicle_code_snapshot, vehicle_plate_snapshot,
          sede_id, sede_name_snapshot,
          event_type, source, geofence_id, geofence_name_snapshot,
          notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?)`
      ).run(
        uuid,
        eventDate,
        eventTime,
        recordedAt,
        coords.lat,
        coords.lng,
        cleanAccuracy,
        address,
        user.id,
        user.username,
        user.full_name,
        user.driver_code ?? '',
        resolvedVehicle!.id,
        resolvedVehicle!.code,
        resolvedVehicle!.plate,
        resolvedVehicle!.sede_id,
        resolvedVehicle!.sede_name,
        eventType,
        matchedGf ? matchedGf.id : null,
        matchedGf ? matchedGf.name : null,
        cleanNotes,
        new Date().toISOString()
      );

      const dupPt = db
        .prepare('SELECT id FROM route_points WHERE vehicle_id = ? AND recorded_at = ? LIMIT 1')
        .get(resolvedVehicle!.id, recordedAt);
      if (!dupPt) {
        recordRoutePoint(
          resolvedVehicle!.id,
          user.id,
          eventDate,
          recordedAt,
          coords.lat,
          coords.lng,
          cleanAccuracy,
          true
        );
      }

      const curState = db
        .prepare('SELECT updated_at FROM driver_geofence_state WHERE vehicle_id = ?')
        .get(resolvedVehicle!.id) as { updated_at: string } | undefined;

      if (!curState || curState.updated_at <= recordedAt) {
        if (eventType === 'FIN_JORNADA' || eventType === 'SALIDA') {
          db.prepare(
            `INSERT INTO driver_geofence_state (vehicle_id, current_geofence_id, entered_at, last_lat, last_lng, updated_at)
             VALUES (?, NULL, NULL, ?, ?, ?)
             ON CONFLICT(vehicle_id) DO UPDATE SET
               current_geofence_id = NULL,
               entered_at = NULL,
               last_lat = excluded.last_lat,
               last_lng = excluded.last_lng,
               updated_at = excluded.updated_at`
          ).run(resolvedVehicle!.id, coords.lat, coords.lng, recordedAt);
        } else {
          db.prepare(
            `INSERT INTO driver_geofence_state (vehicle_id, current_geofence_id, entered_at, last_lat, last_lng, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(vehicle_id) DO UPDATE SET
               current_geofence_id = excluded.current_geofence_id,
               entered_at = excluded.entered_at,
               last_lat = excluded.last_lat,
               last_lng = excluded.last_lng,
               updated_at = excluded.updated_at`
          ).run(
            resolvedVehicle!.id,
            matchedGf ? matchedGf.id : null,
            matchedGf ? recordedAt : null,
            coords.lat,
            coords.lng,
            recordedAt
          );
        }
      }

      return { ok: true as const, inserted: true };
    })();

    if (txResult.ok) {
      syncedEventUuids.push(uuid);
      if (txResult.inserted) syncedEventsCount += 1;
    } else {
      rejectedEvents.push({ event_uuid: uuid, reason: txResult.reason });
    }
  }

  // Sync offline GPS route breadcrumbs in chronological order AND detect offline geofence crossings
  const normalizedPoints = rawPoints
    .map((pt) => (pt && typeof pt === 'object' ? (pt as Record<string, unknown>) : null))
    .filter((pt): pt is Record<string, unknown> => pt !== null)
    .sort((a, b) => {
      const ta = typeof a.recorded_at === 'string' ? new Date(a.recorded_at).getTime() : 0;
      const tb = typeof b.recorded_at === 'string' ? new Date(b.recorded_at).getTime() : 0;
      return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
    });

  const gfTrackerByVehicle = new Map<number, { gfId: number | null; gfName: string | null }>();

  for (const pt of normalizedPoints) {
    const coords = validateCoords(pt.latitude, pt.longitude);
    const recordedDateObj = validateOfflineRecordedAt(pt.recorded_at);
    if (!coords || !recordedDateObj) {
      continue;
    }
    const cleanAccuracy =
      typeof pt.accuracy_meters === 'number' &&
      Number.isFinite(pt.accuracy_meters) &&
      pt.accuracy_meters >= 0
        ? Math.round(pt.accuracy_meters * 10) / 10
        : null;

    const { eventDate, eventTime, recordedAt } = getServerDateParts(recordedDateObj);

    const priorEvent = db
      .prepare(
        `SELECT event_type, vehicle_id, vehicle_code_snapshot, vehicle_plate_snapshot, sede_id, sede_name_snapshot, geofence_id, geofence_name_snapshot
         FROM events WHERE user_id = ? AND recorded_at <= ?
         ORDER BY recorded_at DESC, id DESC LIMIT 1`
      )
      .get(user.id, recordedAt) as EventRow | undefined;

    if (!priorEvent || priorEvent.event_type === 'FIN_JORNADA' || !priorEvent.vehicle_id) {
      syncedPointsCount += 1;
      continue;
    }

    const vId = priorEvent.vehicle_id;

    // Skip if exact timestamp already recorded (idempotent)
    const dupPt = db
      .prepare('SELECT id FROM route_points WHERE vehicle_id = ? AND recorded_at = ? LIMIT 1')
      .get(vId, recordedAt);
    if (dupPt) {
      syncedPointsCount += 1;
      continue;
    }

    if (!gfTrackerByVehicle.has(vId)) {
      const lastVehEv = db
        .prepare(
          `SELECT event_type, geofence_id, geofence_name_snapshot FROM events
           WHERE vehicle_id = ? AND recorded_at <= ?
           ORDER BY recorded_at DESC, id DESC LIMIT 1`
        )
        .get(vId, recordedAt) as
        | { event_type: EventRow['event_type']; geofence_id: number | null; geofence_name_snapshot: string | null }
        | undefined;
      const isInside =
        lastVehEv &&
        lastVehEv.event_type !== 'FIN_JORNADA' &&
        lastVehEv.event_type !== 'SALIDA' &&
        lastVehEv.geofence_id !== null;
      gfTrackerByVehicle.set(vId, {
        gfId: isInside ? lastVehEv!.geofence_id : null,
        gfName: isInside ? lastVehEv!.geofence_name_snapshot : null,
      });
    }

    const prevGf = gfTrackerByVehicle.get(vId)!;
    const matchedGf = findMatchingGeofence(coords.lat, coords.lng, priorEvent.sede_id);
    const nextGfId = matchedGf ? matchedGf.id : null;
    const transitioned = prevGf.gfId !== nextGfId;
    const address = transitioned ? await reverseGeocode(coords.lat, coords.lng) : '';

    db.transaction(() => {
      const prevPt = db
        .prepare(
          `SELECT latitude, longitude, recorded_at FROM route_points
           WHERE vehicle_id = ? AND event_date = ? AND recorded_at <= ?
           ORDER BY recorded_at DESC, id DESC LIMIT 1`
        )
        .get(vId, eventDate, recordedAt) as
        | { latitude: number; longitude: number; recorded_at: string }
        | undefined;

      let shouldInsertPt = transitioned;
      if (!shouldInsertPt) {
        shouldInsertPt = true;
        if (prevPt) {
          const dist = haversineMeters(prevPt.latitude, prevPt.longitude, coords.lat, coords.lng);
          const elapsedSec =
            (new Date(recordedAt).getTime() - new Date(prevPt.recorded_at).getTime()) / 1000;
          if (dist < 25 && elapsedSec < 120) {
            shouldInsertPt = false;
          }
        }
      }

      if (shouldInsertPt) {
        db.prepare(
          `INSERT INTO route_points (vehicle_id, user_id, event_date, recorded_at, latitude, longitude, accuracy_meters)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(vId, user.id, eventDate, recordedAt, coords.lat, coords.lng, cleanAccuracy);
      }

      if (transitioned) {
        if (prevGf.gfId !== null) {
          const prevName = prevGf.gfName ?? 'Geocerca';
          db.prepare(
            `INSERT INTO events (
              event_uuid, event_date, event_time, recorded_at,
              latitude, longitude, accuracy_meters, address,
              user_id, username_snapshot, driver_name_snapshot, driver_code_snapshot,
              vehicle_id, vehicle_code_snapshot, vehicle_plate_snapshot,
              sede_id, sede_name_snapshot,
              event_type, source, geofence_id, geofence_name_snapshot,
              notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SALIDA', 'GEOCERCA_AUTO', ?, ?, ?, ?)`
          ).run(
            crypto.randomUUID(),
            eventDate,
            eventTime,
            recordedAt,
            coords.lat,
            coords.lng,
            cleanAccuracy,
            address,
            user.id,
            user.username,
            user.full_name,
            user.driver_code ?? '',
            vId,
            priorEvent.vehicle_code_snapshot,
            priorEvent.vehicle_plate_snapshot,
            priorEvent.sede_id,
            priorEvent.sede_name_snapshot,
            prevGf.gfId,
            prevName,
            `Salida automática de geocerca: ${prevName}`,
            new Date().toISOString()
          );
        }
        if (matchedGf) {
          db.prepare(
            `INSERT INTO events (
              event_uuid, event_date, event_time, recorded_at,
              latitude, longitude, accuracy_meters, address,
              user_id, username_snapshot, driver_name_snapshot, driver_code_snapshot,
              vehicle_id, vehicle_code_snapshot, vehicle_plate_snapshot,
              sede_id, sede_name_snapshot,
              event_type, source, geofence_id, geofence_name_snapshot,
              notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ENTRADA', 'GEOCERCA_AUTO', ?, ?, ?, ?)`
          ).run(
            crypto.randomUUID(),
            eventDate,
            eventTime,
            recordedAt,
            coords.lat,
            coords.lng,
            cleanAccuracy,
            address,
            user.id,
            user.username,
            user.full_name,
            user.driver_code ?? '',
            vId,
            priorEvent.vehicle_code_snapshot,
            priorEvent.vehicle_plate_snapshot,
            priorEvent.sede_id,
            priorEvent.sede_name_snapshot,
            matchedGf.id,
            matchedGf.name,
            `Entrada automática a geocerca: ${matchedGf.name}`,
            new Date().toISOString()
          );
        }

        const curState = db
          .prepare('SELECT updated_at FROM driver_geofence_state WHERE vehicle_id = ?')
          .get(vId) as { updated_at: string } | undefined;
        if (!curState || curState.updated_at <= recordedAt) {
          db.prepare(
            `INSERT INTO driver_geofence_state (vehicle_id, current_geofence_id, entered_at, last_lat, last_lng, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(vehicle_id) DO UPDATE SET
               current_geofence_id = excluded.current_geofence_id,
               entered_at = excluded.entered_at,
               last_lat = excluded.last_lat,
               last_lng = excluded.last_lng,
               updated_at = excluded.updated_at`
          ).run(vId, nextGfId, nextGfId ? recordedAt : null, coords.lat, coords.lng, recordedAt);
        }
      }
    })();

    gfTrackerByVehicle.set(vId, {
      gfId: nextGfId,
      gfName: matchedGf ? matchedGf.name : null,
    });
    syncedPointsCount += 1;
  }

  res.json({
    syncedEventUuids,
    rejectedEvents,
    syncedEventsCount,
    syncedPointsCount,
  });
});

// ==========================================
// SEDES ENDPOINT
// ==========================================

app.get('/api/admin/sedes', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  if (req.user!.role === 'ADMIN' && req.query.all !== '1') {
    const sedes = req.user!.sede_id
      ? db.prepare('SELECT * FROM sedes WHERE id = ? AND active = 1').all(req.user!.sede_id)
      : [];
    res.json({ sedes });
    return;
  }
  const sedes = db.prepare('SELECT * FROM sedes WHERE active = 1 ORDER BY id ASC').all();
  res.json({ sedes });
});

// ==========================================
// ADMIN / GERENCIA ROUTES
// ==========================================

app.get('/api/admin/dashboard', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  if (user.role === 'ADMIN' && !user.sede_id) {
    res.status(403).json({ error: 'Tu usuario administrador no tiene una sede asignada.' });
    return;
  }

  const scopedSedeId = resolveScopedSedeId(user, req.query.sedeId);
  const { eventDate } = getServerDateParts();

  const vehicleWhere = scopedSedeId ? 'WHERE sede_id = ?' : '';
  const vehicleActiveWhere = scopedSedeId ? 'WHERE active = 1 AND sede_id = ?' : 'WHERE active = 1';
  const driverWhere = scopedSedeId
    ? "WHERE role = 'CONDUCTOR' AND active = 1 AND deleted_at IS NULL AND sede_id = ?"
    : "WHERE role = 'CONDUCTOR' AND active = 1 AND deleted_at IS NULL";
  const eventTodayWhere = scopedSedeId ? 'WHERE event_date = ? AND sede_id = ?' : 'WHERE event_date = ?';
  const gfWhere = scopedSedeId ? 'WHERE active = 1 AND (sede_id = ? OR sede_id IS NULL)' : 'WHERE active = 1';

  const totalVehicles = (
    (scopedSedeId
      ? db.prepare(`SELECT COUNT(*) AS cnt FROM vehicles ${vehicleWhere}`).get(scopedSedeId)
      : db.prepare('SELECT COUNT(*) AS cnt FROM vehicles').get()) as { cnt: number }
  ).cnt;

  const activeVehiclesCount = (
    (scopedSedeId
      ? db.prepare(`SELECT COUNT(*) AS cnt FROM vehicles ${vehicleActiveWhere}`).get(scopedSedeId)
      : db.prepare('SELECT COUNT(*) AS cnt FROM vehicles WHERE active = 1').get()) as { cnt: number }
  ).cnt;

  const activeDriversCount = (
    (scopedSedeId
      ? db.prepare(`SELECT COUNT(*) AS cnt FROM users ${driverWhere}`).get(scopedSedeId)
      : db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'CONDUCTOR' AND active = 1 AND deleted_at IS NULL").get()) as { cnt: number }
  ).cnt;

  const eventsTodayCount = (
    (scopedSedeId
      ? db.prepare(`SELECT COUNT(*) AS cnt FROM events ${eventTodayWhere}`).get(eventDate, scopedSedeId)
      : db.prepare('SELECT COUNT(*) AS cnt FROM events WHERE event_date = ?').get(eventDate)) as { cnt: number }
  ).cnt;

  const entriesTodayCount = (
    (scopedSedeId
      ? db
          .prepare("SELECT COUNT(*) AS cnt FROM events WHERE event_date = ? AND event_type = 'ENTRADA' AND sede_id = ?")
          .get(eventDate, scopedSedeId)
      : db
          .prepare("SELECT COUNT(*) AS cnt FROM events WHERE event_date = ? AND event_type = 'ENTRADA'")
          .get(eventDate)) as { cnt: number }
  ).cnt;

  const activeGeofencesCount = (
    (scopedSedeId
      ? db.prepare(`SELECT COUNT(*) AS cnt FROM geofences ${gfWhere}`).get(scopedSedeId)
      : db.prepare('SELECT COUNT(*) AS cnt FROM geofences WHERE active = 1').get()) as { cnt: number }
  ).cnt;

  const recentEvents = (
    scopedSedeId
      ? db
          .prepare('SELECT * FROM events WHERE sede_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 15')
          .all(scopedSedeId)
      : db.prepare('SELECT * FROM events ORDER BY recorded_at DESC, id DESC LIMIT 15').all()
  ) as EventRow[];

  const vehicles = (
    scopedSedeId
      ? db
          .prepare(
            `SELECT v.id, v.code, v.plate, v.brand, v.model, v.capacity_tons, v.sede_id,
                    v.soat_expires_at, v.tecnomecanica_expires_at, v.active,
                    COALESCE(s.name, 'Sin sede') AS sede_name,
                    u.id AS driver_id, u.full_name AS driver_name, u.username AS driver_username
             FROM vehicles v
             LEFT JOIN sedes s ON s.id = v.sede_id
             LEFT JOIN users u ON u.vehicle_id = v.id AND u.role = 'CONDUCTOR' AND u.active = 1 AND u.deleted_at IS NULL
             WHERE v.active = 1 AND v.sede_id = ?
             ORDER BY v.code ASC`
          )
          .all(scopedSedeId)
      : db
          .prepare(
            `SELECT v.id, v.code, v.plate, v.brand, v.model, v.capacity_tons, v.sede_id,
                    v.soat_expires_at, v.tecnomecanica_expires_at, v.active,
                    COALESCE(s.name, 'Sin sede') AS sede_name,
                    u.id AS driver_id, u.full_name AS driver_name, u.username AS driver_username
             FROM vehicles v
             LEFT JOIN sedes s ON s.id = v.sede_id
             LEFT JOIN users u ON u.vehicle_id = v.id AND u.role = 'CONDUCTOR' AND u.active = 1 AND u.deleted_at IS NULL
             WHERE v.active = 1
             ORDER BY s.name ASC, v.code ASC`
          )
          .all()
  ) as Array<{
    id: number;
    code: string;
    plate: string;
    brand: string;
    model: string;
    capacity_tons: number;
    sede_id: number | null;
    soat_expires_at: string;
    tecnomecanica_expires_at: string;
    sede_name: string;
    active: number;
    driver_id: number | null;
    driver_name: string | null;
    driver_username: string | null;
  }>;

  const fleetStatus = vehicles.map((v) => {
    const shift = getVehicleShiftStatus(v.id);
    const gfState = db
      .prepare(
        `SELECT g.name, g.category
         FROM driver_geofence_state s
         JOIN geofences g ON g.id = s.current_geofence_id
         WHERE s.vehicle_id = ?`
      )
      .get(v.id) as { name: string; category: string } | undefined;
    return {
      ...v,
      driver_name: shift.shiftActive && shift.lastEvent ? shift.lastEvent.driver_name_snapshot : v.driver_name,
      driver_username: shift.shiftActive && shift.lastEvent ? shift.lastEvent.username_snapshot : v.driver_username,
      shiftActive: shift.shiftActive,
      shiftStartedAt: shift.shiftStartedAt,
      lastEvent: shift.lastEvent,
      currentGeofence: gfState ?? null,
    };
  });

  const activeShiftsCount = fleetStatus.filter((v) => v.shiftActive).length;

  // Build per-sede summaries so Gerencia can navigate sedes without seeing 40 trucks in one table
  const allSedes = (
    user.role === 'ADMIN'
      ? db.prepare('SELECT * FROM sedes WHERE id = ? AND active = 1').all(user.sede_id)
      : db.prepare('SELECT * FROM sedes WHERE active = 1 ORDER BY id ASC').all()
  ) as SedeRow[];

  const allActiveVehiclesForSummary = (
    user.role === 'ADMIN'
      ? db.prepare('SELECT id, sede_id FROM vehicles WHERE active = 1 AND sede_id = ?').all(user.sede_id)
      : db.prepare('SELECT id, sede_id FROM vehicles WHERE active = 1').all()
  ) as Array<{ id: number; sede_id: number | null }>;

  const shiftByVehicleId = new Map<number, boolean>();
  for (const av of allActiveVehiclesForSummary) {
    shiftByVehicleId.set(av.id, getVehicleShiftStatus(av.id).shiftActive);
  }

  const sedeSummaries = allSedes.map((s) => {
    const sedeVehicles = allActiveVehiclesForSummary.filter((v) => v.sede_id === s.id);
    const sedeShifts = sedeVehicles.filter((v) => shiftByVehicleId.get(v.id)).length;
    const sedeEventsToday = (
      db
        .prepare('SELECT COUNT(*) AS cnt FROM events WHERE event_date = ? AND sede_id = ?')
        .get(eventDate, s.id) as { cnt: number }
    ).cnt;
    const sedeAdminsCount = (
      db
        .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'ADMIN' AND active = 1 AND deleted_at IS NULL AND sede_id = ?")
        .get(s.id) as { cnt: number }
    ).cnt;

    return {
      id: s.id,
      name: s.name,
      code: s.code,
      vehiclesCount: sedeVehicles.length,
      activeShiftsCount: sedeShifts,
      eventsTodayCount: sedeEventsToday,
      adminsCount: sedeAdminsCount,
    };
  });

  res.json({
    today: eventDate,
    scopedSedeId,
    kpis: {
      totalVehicles,
      activeVehiclesCount,
      activeDriversCount,
      activeShiftsCount,
      eventsTodayCount,
      entriesTodayCount,
      activeGeofencesCount,
    },
    sedeSummaries,
    recentEvents,
    fleetStatus,
  });
});

app.get('/api/admin/events', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const {
    date,
    startDate,
    endDate,
    sedeId,
    vehicleId,
    userId,
    eventType,
    source,
    search,
    limit = '250',
    offset = '0',
  } = req.query;

  const scopedSedeId = resolveScopedSedeId(req.user!, sedeId);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (scopedSedeId) {
    conditions.push('sede_id = ?');
    params.push(scopedSedeId);
  }

  if (typeof date === 'string' && date.trim()) {
    conditions.push('event_date = ?');
    params.push(date.trim());
  } else {
    if (typeof startDate === 'string' && startDate.trim()) {
      conditions.push('event_date >= ?');
      params.push(startDate.trim());
    }
    if (typeof endDate === 'string' && endDate.trim()) {
      conditions.push('event_date <= ?');
      params.push(endDate.trim());
    }
  }

  if (typeof vehicleId === 'string' && vehicleId.trim()) {
    conditions.push('vehicle_id = ?');
    params.push(Number(vehicleId));
  }
  if (typeof userId === 'string' && userId.trim()) {
    conditions.push('user_id = ?');
    params.push(Number(userId));
  }
  if (typeof eventType === 'string' && eventType.trim()) {
    conditions.push('event_type = ?');
    params.push(eventType.trim());
  }
  if (typeof source === 'string' && source.trim()) {
    conditions.push('source = ?');
    params.push(source.trim());
  }
  if (typeof search === 'string' && search.trim()) {
    const pattern = `%${search.trim()}%`;
    conditions.push(
      '(address LIKE ? OR notes LIKE ? OR driver_name_snapshot LIKE ? OR driver_code_snapshot LIKE ? OR vehicle_code_snapshot LIKE ? OR vehicle_plate_snapshot LIKE ? OR geofence_name_snapshot LIKE ? OR sede_name_snapshot LIKE ?)'
    );
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 250, 1), 1000);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM events ${whereClause}`)
    .get(...params) as { cnt: number };

  const events = db
    .prepare(
      `SELECT * FROM events ${whereClause}
       ORDER BY recorded_at DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, safeLimit, safeOffset) as EventRow[];

  res.json({ events, total: totalRow.cnt });
});

app.get('/api/admin/route', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const vehicleId = Number(req.query.vehicleId);
  const date =
    typeof req.query.date === 'string' && req.query.date.trim()
      ? req.query.date.trim()
      : getServerDateParts().eventDate;

  if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
    res.status(400).json({ error: 'Selecciona un vehículo válido.' });
    return;
  }

  const vehicle = db
    .prepare(
      `SELECT v.*, COALESCE(s.name, '') AS sede_name, s.latitude AS sede_lat, s.longitude AS sede_lng
       FROM vehicles v
       LEFT JOIN sedes s ON s.id = v.sede_id
       WHERE v.id = ?`
    )
    .get(vehicleId) as (VehicleRow & { sede_name: string; sede_lat: number | null; sede_lng: number | null }) | undefined;

  if (!vehicle) {
    res.status(404).json({ error: 'Vehículo no encontrado.' });
    return;
  }

  if (req.user!.role === 'ADMIN' && vehicle.sede_id !== req.user!.sede_id) {
    res.status(403).json({ error: 'Este vehículo pertenece a otra sede.' });
    return;
  }

  const events = db
    .prepare(
      `SELECT * FROM events
       WHERE vehicle_id = ? AND event_date = ?
       ORDER BY recorded_at ASC, id ASC`
    )
    .all(vehicleId, date) as EventRow[];

  const routePoints = db
    .prepare(
      `SELECT * FROM route_points
       WHERE vehicle_id = ? AND event_date = ?
       ORDER BY recorded_at ASC, id ASC`
    )
    .all(vehicleId, date) as RoutePointRow[];

  // Collect all chronological trace coordinates (events + GPS breadcrumbs)
  const combinedTrace = [
    ...events.map((e) => ({
      recorded_at: e.recorded_at,
      latitude: e.latitude,
      longitude: e.longitude,
      kind: 'event' as const,
    })),
    ...routePoints.map((p) => ({
      recorded_at: p.recorded_at,
      latitude: p.latitude,
      longitude: p.longitude,
      kind: 'gps' as const,
    })),
  ].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));

  let totalDistanceMeters = 0;
  for (let i = 1; i < combinedTrace.length; i++) {
    totalDistanceMeters += haversineMeters(
      combinedTrace[i - 1].latitude,
      combinedTrace[i - 1].longitude,
      combinedTrace[i].latitude,
      combinedTrace[i].longitude
    );
  }

  let shiftDurationMinutes = 0;
  let shiftStart: Date | null = null;
  for (const ev of events) {
    if (ev.event_type === 'INICIO_JORNADA' && !shiftStart) {
      shiftStart = new Date(ev.recorded_at);
    } else if (ev.event_type === 'FIN_JORNADA' && shiftStart) {
      shiftDurationMinutes += Math.max(
        0,
        Math.round((new Date(ev.recorded_at).getTime() - shiftStart.getTime()) / 60000)
      );
      shiftStart = null;
    }
  }
  if (shiftStart && events.length > 0) {
    const lastEv = events[events.length - 1];
    shiftDurationMinutes += Math.max(
      0,
      Math.round((new Date(lastEv.recorded_at).getTime() - shiftStart.getTime()) / 60000)
    );
  }

  const geofences = vehicle.sede_id
    ? db
        .prepare('SELECT * FROM geofences WHERE active = 1 AND (sede_id = ? OR sede_id IS NULL) ORDER BY name ASC')
        .all(vehicle.sede_id)
    : db.prepare('SELECT * FROM geofences WHERE active = 1 ORDER BY name ASC').all();

  const availableDatesRows = db
    .prepare(
      `SELECT event_date FROM (
         SELECT DISTINCT event_date FROM events WHERE vehicle_id = ?
         UNION
         SELECT DISTINCT event_date FROM route_points WHERE vehicle_id = ?
       )
       ORDER BY event_date DESC
       LIMIT 15`
    )
    .all(vehicleId, vehicleId) as Array<{ event_date: string }>;

  res.json({
    vehicle,
    date,
    events,
    routePoints,
    geofences,
    availableDates: availableDatesRows.map((r) => r.event_date),
    summary: {
      totalEvents: events.length,
      gpsPointsCount: routePoints.length,
      entriesCount: events.filter((e) => e.event_type === 'ENTRADA').length,
      exitsCount: events.filter((e) => e.event_type === 'SALIDA').length,
      distanceKm: Math.round((totalDistanceMeters / 1000) * 100) / 100,
      shiftDurationMinutes,
    },
  });
});

// ==========================================
// PLANNED ROUTES CRUD (MAP DIGITIZER)
// ==========================================

app.get('/api/admin/planned-routes', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const scopedSedeId = resolveScopedSedeId(req.user!, req.query.sedeId);
  const routes = scopedSedeId
    ? db
        .prepare(
          `SELECT r.*, s.name AS sede_name, v.code AS vehicle_code, v.plate AS vehicle_plate
           FROM planned_routes r
           LEFT JOIN sedes s ON s.id = r.sede_id
           LEFT JOIN vehicles v ON v.id = r.vehicle_id
           WHERE r.sede_id = ? OR r.sede_id IS NULL
           ORDER BY r.updated_at DESC`
        )
        .all(scopedSedeId)
    : db
        .prepare(
          `SELECT r.*, s.name AS sede_name, v.code AS vehicle_code, v.plate AS vehicle_plate
           FROM planned_routes r
           LEFT JOIN sedes s ON s.id = r.sede_id
           LEFT JOIN vehicles v ON v.id = r.vehicle_id
           ORDER BY r.updated_at DESC`
        )
        .all();

  res.json({ routes });
});

app.post('/api/admin/planned-routes', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const { name, sede_id, vehicle_id, waypoints, distance_km } = req.body ?? {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (cleanName.length < 2 || cleanName.length > 120) {
    res.status(400).json({ error: 'El nombre de la ruta debe tener entre 2 y 120 caracteres.' });
    return;
  }
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    res.status(400).json({ error: 'La ruta debe tener al menos 2 puntos en el mapa.' });
    return;
  }

  const cleanWaypoints: Array<{ lat: number; lng: number; label?: string }> = [];
  for (const wp of waypoints) {
    const c = validateCoords(wp?.lat, wp?.lng);
    if (!c) {
      res.status(400).json({ error: 'Uno de los puntos de la ruta tiene coordenadas inválidas.' });
      return;
    }
    cleanWaypoints.push({
      lat: c.lat,
      lng: c.lng,
      label: typeof wp?.label === 'string' ? wp.label.trim().slice(0, 80) : undefined,
    });
  }

  let effectiveSedeId: number | null =
    req.user!.role === 'ADMIN'
      ? req.user!.sede_id
      : sede_id
        ? Number(sede_id)
        : null;

  const cleanVehicleId = vehicle_id ? Number(vehicle_id) : null;
  if (cleanVehicleId) {
    const v = db.prepare('SELECT id, sede_id FROM vehicles WHERE id = ?').get(cleanVehicleId) as
      | { id: number; sede_id: number | null }
      | undefined;
    if (!v) {
      res.status(400).json({ error: 'Vehículo seleccionado inválido.' });
      return;
    }
    if (req.user!.role === 'ADMIN' && v.sede_id !== req.user!.sede_id) {
      res.status(403).json({ error: 'No puedes asignar rutas a vehículos de otra sede.' });
      return;
    }
    if (!effectiveSedeId) {
      effectiveSedeId = v.sede_id;
    }
  }

  const distKm = Number.isFinite(Number(distance_km)) ? Math.round(Number(distance_km) * 100) / 100 : 0;
  const now = new Date().toISOString();

  const info = db
    .prepare(
      `INSERT INTO planned_routes (name, sede_id, vehicle_id, waypoints_json, distance_km, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cleanName,
      effectiveSedeId,
      cleanVehicleId,
      JSON.stringify(cleanWaypoints),
      distKm,
      req.user!.id,
      now,
      now
    );

  const created = db
    .prepare(
      `SELECT r.*, s.name AS sede_name, v.code AS vehicle_code, v.plate AS vehicle_plate
       FROM planned_routes r
       LEFT JOIN sedes s ON s.id = r.sede_id
       LEFT JOIN vehicles v ON v.id = r.vehicle_id
       WHERE r.id = ?`
    )
    .get(Number(info.lastInsertRowid));

  logAudit(req.user!.id, 'PLANNED_ROUTE_CREATE', `Ruta trazada guardada: ${cleanName} (${cleanWaypoints.length} puntos)`);
  res.status(201).json({ route: created });
});

app.delete('/api/admin/planned-routes/:id', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM planned_routes WHERE id = ?').get(id) as
    | { id: number; name: string; sede_id: number | null }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Ruta planificada no encontrada.' });
    return;
  }
  if (req.user!.role === 'ADMIN' && existing.sede_id !== req.user!.sede_id) {
    res.status(403).json({ error: 'No puedes eliminar rutas de otra sede.' });
    return;
  }
  db.prepare('DELETE FROM planned_routes WHERE id = ?').run(id);
  logAudit(req.user!.id, 'PLANNED_ROUTE_DELETE', `Ruta planificada eliminada: ${existing.name} (#${id})`);
  res.json({ deleted: true });
});

// ==========================================
// GEOFENCES CRUD
// ==========================================

app.get('/api/admin/geofences', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const scopedSedeId = resolveScopedSedeId(req.user!, req.query.sedeId);
  const geofences = scopedSedeId
    ? db
        .prepare(
          `SELECT g.*, COALESCE(s.name, 'Todas las sedes') AS sede_name
           FROM geofences g
           LEFT JOIN sedes s ON s.id = g.sede_id
           WHERE g.sede_id = ? OR g.sede_id IS NULL
           ORDER BY g.active DESC, g.name ASC`
        )
        .all(scopedSedeId)
    : db
        .prepare(
          `SELECT g.*, COALESCE(s.name, 'Todas las sedes') AS sede_name
           FROM geofences g
           LEFT JOIN sedes s ON s.id = g.sede_id
           ORDER BY g.active DESC, g.name ASC`
        )
        .all();
  res.json({ geofences });
});

app.post('/api/admin/geofences', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const { name, category, latitude, longitude, radius_meters, sede_id, active = true } = req.body ?? {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanCategory = VALID_CATEGORIES.includes(category) ? category : null;
  const coords = validateCoords(latitude, longitude);
  const radius = Number(radius_meters);

  if (cleanName.length < 2 || cleanName.length > 120) {
    res.status(400).json({ error: 'El nombre de la geocerca debe tener entre 2 y 120 caracteres.' });
    return;
  }
  if (!cleanCategory) {
    res.status(400).json({ error: 'Categoría de geocerca inválida.' });
    return;
  }
  if (!coords) {
    res.status(400).json({ error: 'Coordenadas inválidas.' });
    return;
  }
  if (!Number.isFinite(radius) || radius < 20 || radius > 50000) {
    res.status(400).json({ error: 'El radio debe estar entre 20 y 50,000 metros.' });
    return;
  }

  let effectiveSedeId: number | null = null;
  if (req.user!.role === 'ADMIN') {
    effectiveSedeId = req.user!.sede_id;
  } else if (sede_id !== undefined && sede_id !== null && String(sede_id).trim() !== '') {
    const s = getSedeById(Number(sede_id));
    if (!s) {
      res.status(400).json({ error: 'Sede inválida.' });
      return;
    }
    effectiveSedeId = s.id;
  }

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO geofences (name, category, latitude, longitude, radius_meters, sede_id, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cleanName,
      cleanCategory,
      coords.lat,
      coords.lng,
      Math.round(radius),
      effectiveSedeId,
      active ? 1 : 0,
      req.user!.id,
      now,
      now
    );

  const created = db
    .prepare(
      `SELECT g.*, COALESCE(s.name, 'Todas las sedes') AS sede_name
       FROM geofences g
       LEFT JOIN sedes s ON s.id = g.sede_id
       WHERE g.id = ?`
    )
    .get(Number(info.lastInsertRowid));
  logAudit(req.user!.id, 'GEOFENCE_CREATE', `Geocerca creada: ${cleanName} (${cleanCategory}, ${Math.round(radius)}m)`);
  res.status(201).json({ geofence: created });
});

app.put('/api/admin/geofences/:id', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM geofences WHERE id = ?').get(id) as GeofenceRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Geocerca no encontrada.' });
    return;
  }
  if (req.user!.role === 'ADMIN' && existing.sede_id !== req.user!.sede_id) {
    res.status(403).json({ error: 'No puedes modificar geocercas de otra sede.' });
    return;
  }

  const { name, category, latitude, longitude, radius_meters, sede_id, active } = req.body ?? {};
  const cleanName = typeof name === 'string' ? name.trim() : existing.name;
  const cleanCategory = category !== undefined ? (VALID_CATEGORIES.includes(category) ? category : null) : existing.category;
  const coords =
    latitude !== undefined && longitude !== undefined
      ? validateCoords(latitude, longitude)
      : { lat: existing.latitude, lng: existing.longitude };
  const radius = radius_meters !== undefined ? Number(radius_meters) : existing.radius_meters;
  const isActive = active !== undefined ? (active ? 1 : 0) : existing.active;

  let effectiveSedeId = existing.sede_id;
  if (req.user!.role === 'GERENCIA' && sede_id !== undefined) {
    if (sede_id === null || String(sede_id).trim() === '') {
      effectiveSedeId = null;
    } else {
      const s = getSedeById(Number(sede_id));
      if (!s) {
        res.status(400).json({ error: 'Sede inválida.' });
        return;
      }
      effectiveSedeId = s.id;
    }
  }

  if (cleanName.length < 2 || cleanName.length > 120 || !cleanCategory || !coords || !Number.isFinite(radius) || radius < 20 || radius > 50000) {
    res.status(400).json({ error: 'Datos de geocerca inválidos.' });
    return;
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE geofences
     SET name = ?, category = ?, latitude = ?, longitude = ?, radius_meters = ?, sede_id = ?, active = ?, updated_at = ?
     WHERE id = ?`
  ).run(cleanName, cleanCategory, coords.lat, coords.lng, Math.round(radius), effectiveSedeId, isActive, now, id);

  const updated = db
    .prepare(
      `SELECT g.*, COALESCE(s.name, 'Todas las sedes') AS sede_name
       FROM geofences g
       LEFT JOIN sedes s ON s.id = g.sede_id
       WHERE g.id = ?`
    )
    .get(id);
  logAudit(req.user!.id, 'GEOFENCE_UPDATE', `Geocerca #${id} actualizada: ${cleanName}`);
  res.json({ geofence: updated });
});

app.delete('/api/admin/geofences/:id', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM geofences WHERE id = ?').get(id) as GeofenceRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Geocerca no encontrada.' });
    return;
  }
  if (req.user!.role === 'ADMIN' && existing.sede_id !== req.user!.sede_id) {
    res.status(403).json({ error: 'No puedes eliminar geocercas de otra sede.' });
    return;
  }
  db.prepare('DELETE FROM geofences WHERE id = ?').run(id);
  logAudit(req.user!.id, 'GEOFENCE_DELETE', `Geocerca eliminada: ${existing.name} (#${id})`);
  res.json({ deleted: true });
});

// ==========================================
// VEHICLES & USERS CRUD
// ==========================================

app.get('/api/admin/vehicles', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const scopedSedeId = resolveScopedSedeId(req.user!, req.query.sedeId);
  const vehicles = scopedSedeId
    ? db
        .prepare(
          `SELECT v.*, COALESCE(s.name, 'Sin sede') AS sede_name,
                  u.id AS assigned_user_id, u.full_name AS assigned_driver_name, u.username AS assigned_username
           FROM vehicles v
           LEFT JOIN sedes s ON s.id = v.sede_id
           LEFT JOIN users u ON u.vehicle_id = v.id AND u.role = 'CONDUCTOR' AND u.active = 1 AND u.deleted_at IS NULL
           WHERE v.sede_id = ?
           ORDER BY v.code ASC`
        )
        .all(scopedSedeId)
    : db
        .prepare(
          `SELECT v.*, COALESCE(s.name, 'Sin sede') AS sede_name,
                  u.id AS assigned_user_id, u.full_name AS assigned_driver_name, u.username AS assigned_username
           FROM vehicles v
           LEFT JOIN sedes s ON s.id = v.sede_id
           LEFT JOIN users u ON u.vehicle_id = v.id AND u.role = 'CONDUCTOR' AND u.active = 1 AND u.deleted_at IS NULL
           ORDER BY s.name ASC, v.code ASC`
        )
        .all();
  res.json({ vehicles });
});

app.post('/api/admin/vehicles', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const {
    code,
    plate,
    brand = '',
    model = '',
    capacity_tons = 0,
    sede_id,
    soat_expires_at,
    tecnomecanica_expires_at,
  } = req.body ?? {};
  const cleanCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
  const cleanPlate = typeof plate === 'string' ? plate.trim().toUpperCase() : '';
  const cleanBrand = typeof brand === 'string' ? brand.trim() : '';
  const cleanModel = typeof model === 'string' ? model.trim() : '';
  const cap = Number(capacity_tons) || 0;
  const sede = getSedeById(Number(sede_id));
  const cleanSoat = validateExpiryDate(soat_expires_at);
  const cleanTecno = validateExpiryDate(tecnomecanica_expires_at);

  if (cleanCode.length < 2 || cleanPlate.length < 3) {
    res.status(400).json({ error: 'El código interno y la placa son obligatorios.' });
    return;
  }
  if (!sede) {
    res.status(400).json({ error: 'Debes asignar el camión a una de las 8 sedes.' });
    return;
  }
  if (cleanSoat === null) {
    res.status(400).json({ error: 'La fecha de vencimiento del SOAT es inválida (formato YYYY-MM-DD).' });
    return;
  }
  if (cleanTecno === null) {
    res.status(400).json({ error: 'La fecha de vencimiento de la Tecnomecánica es inválida (formato YYYY-MM-DD).' });
    return;
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO vehicles (code, plate, brand, model, capacity_tons, sede_id, soat_expires_at, tecnomecanica_expires_at, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        cleanCode,
        cleanPlate,
        cleanBrand,
        cleanModel,
        cap,
        sede.id,
        cleanSoat,
        cleanTecno,
        new Date().toISOString()
      );

    const vehicle = db
      .prepare(
        `SELECT v.*, s.name AS sede_name FROM vehicles v LEFT JOIN sedes s ON s.id = v.sede_id WHERE v.id = ?`
      )
      .get(Number(info.lastInsertRowid));
    logAudit(req.user!.id, 'VEHICLE_CREATE', `Vehículo creado: ${cleanCode} (${cleanPlate}) en sede ${sede.name}`);
    res.status(201).json({ vehicle });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('UNIQUE')) {
      res.status(409).json({ error: 'Ya existe un vehículo con ese código o placa.' });
      return;
    }
    res.status(500).json({ error: 'Error al registrar vehículo.' });
  }
});

app.put('/api/admin/vehicles/:id', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id) as VehicleRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Vehículo no encontrado.' });
    return;
  }

  const {
    code,
    plate,
    brand,
    model,
    capacity_tons,
    sede_id,
    soat_expires_at,
    tecnomecanica_expires_at,
    active,
  } = req.body ?? {};
  const cleanCode = typeof code === 'string' ? code.trim().toUpperCase() : existing.code;
  const cleanPlate = typeof plate === 'string' ? plate.trim().toUpperCase() : existing.plate;
  const cleanBrand = typeof brand === 'string' ? brand.trim() : existing.brand;
  const cleanModel = typeof model === 'string' ? model.trim() : existing.model;
  const cap = capacity_tons !== undefined ? Number(capacity_tons) || 0 : existing.capacity_tons;
  const isActive = active !== undefined ? (active ? 1 : 0) : existing.active;
  const cleanSoat =
    soat_expires_at !== undefined ? validateExpiryDate(soat_expires_at) : existing.soat_expires_at;
  const cleanTecno =
    tecnomecanica_expires_at !== undefined
      ? validateExpiryDate(tecnomecanica_expires_at)
      : existing.tecnomecanica_expires_at;

  if (cleanSoat === null) {
    res.status(400).json({ error: 'La fecha de vencimiento del SOAT es inválida (formato YYYY-MM-DD).' });
    return;
  }
  if (cleanTecno === null) {
    res.status(400).json({ error: 'La fecha de vencimiento de la Tecnomecánica es inválida (formato YYYY-MM-DD).' });
    return;
  }

  let cleanSedeId = existing.sede_id;
  if (sede_id !== undefined) {
    const sede = getSedeById(Number(sede_id));
    if (!sede) {
      res.status(400).json({ error: 'Sede inválida.' });
      return;
    }
    cleanSedeId = sede.id;
  }

  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE vehicles
         SET code = ?, plate = ?, brand = ?, model = ?, capacity_tons = ?, sede_id = ?,
             soat_expires_at = ?, tecnomecanica_expires_at = ?, active = ?
         WHERE id = ?`
      ).run(
        cleanCode,
        cleanPlate,
        cleanBrand,
        cleanModel,
        cap,
        cleanSedeId,
        cleanSoat,
        cleanTecno,
        isActive,
        id
      );

      // Keep assigned driver's sede_id synced or detach if vehicle moved sede
      if (cleanSedeId !== existing.sede_id) {
        db.prepare("UPDATE users SET vehicle_id = NULL WHERE vehicle_id = ? AND role = 'CONDUCTOR'").run(id);
      }
    })();

    const vehicle = db
      .prepare(
        `SELECT v.*, COALESCE(s.name, 'Sin sede') AS sede_name FROM vehicles v LEFT JOIN sedes s ON s.id = v.sede_id WHERE v.id = ?`
      )
      .get(id);
    logAudit(req.user!.id, 'VEHICLE_UPDATE', `Vehículo actualizado: ${cleanCode} (${cleanPlate})`);
    res.json({ vehicle });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('UNIQUE')) {
      res.status(409).json({ error: 'Ya existe un vehículo con ese código o placa.' });
      return;
    }
    res.status(500).json({ error: 'Error al actualizar vehículo.' });
  }
});

app.post('/api/admin/vehicles/:id/transfer-sede', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const actor = req.user!;
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id) as VehicleRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Vehículo no encontrado.' });
    return;
  }

  if (actor.role === 'ADMIN' && existing.sede_id !== actor.sede_id) {
    res.status(403).json({ error: 'Solo puedes trasladar vehículos que actualmente pertenecen a tu sede.' });
    return;
  }

  const targetSede = getSedeById(Number(req.body?.sede_id));
  if (!targetSede) {
    res.status(400).json({ error: 'Debes seleccionar una sede de destino válida.' });
    return;
  }
  if (targetSede.id === existing.sede_id) {
    res.status(400).json({ error: `El camión ${existing.code} ya pertenece a la sede ${targetSede.name}.` });
    return;
  }

  const shift = getVehicleShiftStatus(id);
  if (shift.shiftActive) {
    res.status(400).json({
      error: `El camión ${existing.code} tiene una jornada activa en curso. Debe finalizar la jornada antes de trasladarlo de sede.`,
    });
    return;
  }

  const originSede = getSedeById(existing.sede_id);
  db.transaction(() => {
    db.prepare('UPDATE vehicles SET sede_id = ? WHERE id = ?').run(targetSede.id, id);
    db.prepare("UPDATE users SET vehicle_id = NULL WHERE vehicle_id = ? AND role = 'CONDUCTOR'").run(id);
  })();

  const vehicle = db
    .prepare(
      `SELECT v.*, COALESCE(s.name, 'Sin sede') AS sede_name FROM vehicles v LEFT JOIN sedes s ON s.id = v.sede_id WHERE v.id = ?`
    )
    .get(id);
  logAudit(
    actor.id,
    'VEHICLE_TRANSFER_SEDE',
    `Vehículo ${existing.code} (${existing.plate}) trasladado de ${originSede?.name ?? 'Sin sede'} a ${targetSede.name}`
  );
  res.json({ vehicle });
});

app.get('/api/admin/users', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  if (user.role === 'ADMIN') {
    if (!user.sede_id) {
      res.json({ users: [] });
      return;
    }
    const users = db
      .prepare(
        `SELECT u.id, u.username, u.full_name, u.driver_code, u.role, u.sede_id, u.vehicle_id, u.active, u.created_at,
                s.name AS sede_name,
                v.code AS vehicle_code, v.plate AS vehicle_plate
         FROM users u
         LEFT JOIN sedes s ON s.id = u.sede_id
         LEFT JOIN vehicles v ON v.id = u.vehicle_id
         WHERE u.role = 'CONDUCTOR' AND u.sede_id = ? AND u.deleted_at IS NULL
         ORDER BY u.full_name ASC`
      )
      .all(user.sede_id);
    res.json({ users });
    return;
  }

  const scopedSedeId = resolveScopedSedeId(user, req.query.sedeId);
  const users = scopedSedeId
    ? db
        .prepare(
          `SELECT u.id, u.username, u.full_name, u.driver_code, u.role, u.sede_id, u.vehicle_id, u.active, u.created_at,
                  COALESCE(s.name, 'Todas las sedes') AS sede_name,
                  v.code AS vehicle_code, v.plate AS vehicle_plate
           FROM users u
           LEFT JOIN sedes s ON s.id = u.sede_id
           LEFT JOIN vehicles v ON v.id = u.vehicle_id
           WHERE u.deleted_at IS NULL AND (u.sede_id = ? OR u.role = 'GERENCIA')
           ORDER BY u.role DESC, u.full_name ASC`
        )
        .all(scopedSedeId)
    : db
        .prepare(
          `SELECT u.id, u.username, u.full_name, u.driver_code, u.role, u.sede_id, u.vehicle_id, u.active, u.created_at,
                  COALESCE(s.name, 'Todas las sedes') AS sede_name,
                  v.code AS vehicle_code, v.plate AS vehicle_plate
           FROM users u
           LEFT JOIN sedes s ON s.id = u.sede_id
           LEFT JOIN vehicles v ON v.id = u.vehicle_id
           WHERE u.deleted_at IS NULL
           ORDER BY u.role DESC, s.name ASC, u.full_name ASC`
        )
        .all();

  res.json({ users });
});

app.post('/api/admin/users', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const actor = req.user!;
  const { username, password, full_name, driver_code, role, sede_id, vehicle_id } = req.body ?? {};
  const cleanUser = typeof username === 'string' ? username.trim().toLowerCase() : '';
  const cleanName = typeof full_name === 'string' ? full_name.trim() : '';
  const cleanPass = typeof password === 'string' ? password : '';

  let cleanRole: UserRole = 'CONDUCTOR';
  if (role === 'GERENCIA' || role === 'ADMIN' || role === 'CONDUCTOR') {
    cleanRole = role;
  }

  if (actor.role === 'ADMIN') {
    if (cleanRole !== 'CONDUCTOR') {
      res.status(403).json({ error: 'Un Administrador de Sede solo puede crear usuarios Conductores.' });
      return;
    }
    if (!actor.sede_id) {
      res.status(403).json({ error: 'Tu usuario administrador no tiene una sede asignada.' });
      return;
    }
  }

  if (cleanUser.length < 3 || !/^[a-z0-9._-]+$/.test(cleanUser)) {
    res.status(400).json({ error: 'Usuario inválido (mínimo 3 caracteres alfanuméricos).' });
    return;
  }
  if (cleanPass.length < 6) {
    res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    return;
  }
  if (cleanName.length < 2) {
    res.status(400).json({ error: 'El nombre completo es obligatorio.' });
    return;
  }

  let cleanDriverCode: string | null = null;
  let cleanVehicleId: number | null = null;
  let cleanSedeId: number | null = null;

  if (cleanRole === 'ADMIN') {
    const sede = getSedeById(Number(sede_id));
    if (!sede) {
      res.status(400).json({ error: 'Todo Administrador debe tener una sede asignada.' });
      return;
    }
    cleanSedeId = sede.id;
  } else if (cleanRole === 'CONDUCTOR') {
    cleanDriverCode = validateDriverCode(driver_code);
    if (!cleanDriverCode) {
      res.status(400).json({
        error: 'Todo conductor debe tener un código único válido (2 a 20 caracteres: letras, números, guion o guion bajo).',
      });
      return;
    }
    const existingCode = db
      .prepare('SELECT id FROM users WHERE driver_code = ? AND deleted_at IS NULL LIMIT 1')
      .get(cleanDriverCode);
    if (existingCode) {
      res.status(409).json({ error: `El código de conductor ${cleanDriverCode} ya está en uso.` });
      return;
    }

    if (vehicle_id !== undefined && vehicle_id !== null && String(vehicle_id).trim() !== '') {
      const veh = db.prepare('SELECT id, sede_id FROM vehicles WHERE id = ?').get(Number(vehicle_id)) as
        | { id: number; sede_id: number | null }
        | undefined;
      if (!veh) {
        res.status(400).json({ error: 'El camión seleccionado no existe.' });
        return;
      }
      if (actor.role === 'ADMIN' && veh.sede_id !== actor.sede_id) {
        res.status(403).json({ error: 'Solo puedes asignar camiones de tu propia sede.' });
        return;
      }
      cleanVehicleId = veh.id;
      cleanSedeId = actor.role === 'ADMIN' ? actor.sede_id : veh.sede_id;
    } else {
      if (actor.role === 'ADMIN') {
        cleanSedeId = actor.sede_id;
      } else {
        const sede = getSedeById(Number(sede_id));
        if (!sede) {
          res.status(400).json({ error: 'Debes asignar el conductor a una sede.' });
          return;
        }
        cleanSedeId = sede.id;
      }
    }
  } else {
    // GERENCIA is global
    cleanSedeId = null;
    cleanVehicleId = null;
  }

  try {
    const hash = bcrypt.hashSync(cleanPass, 10);
    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, full_name, driver_code, role, sede_id, vehicle_id, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        cleanUser,
        hash,
        cleanName,
        cleanDriverCode,
        cleanRole,
        cleanSedeId,
        cleanVehicleId,
        new Date().toISOString()
      );

    const created = getUserById(Number(info.lastInsertRowid));
    logAudit(
      actor.id,
      'USER_CREATE',
      `Usuario creado: ${cleanUser} (${cleanRole}${cleanDriverCode ? `, código ${cleanDriverCode}` : ''})`
    );
    res.status(201).json({ user: created });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('driver_code')) {
      res.status(409).json({ error: 'Ese código de conductor ya está en uso.' });
      return;
    }
    if (msg.includes('UNIQUE')) {
      res.status(409).json({ error: 'El nombre de usuario ya está en uso.' });
      return;
    }
    res.status(500).json({ error: 'Error al crear usuario.' });
  }
});

app.put('/api/admin/users/:id', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const actor = req.user!;
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as
    | {
        id: number;
        username: string;
        full_name: string;
        driver_code: string | null;
        role: UserRole;
        sede_id: number | null;
        vehicle_id: number | null;
        active: number;
      }
    | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Usuario no encontrado.' });
    return;
  }

  if (actor.role === 'ADMIN') {
    if (existing.role !== 'CONDUCTOR' || existing.sede_id !== actor.sede_id) {
      res.status(403).json({ error: 'Solo puedes editar conductores de tu propia sede.' });
      return;
    }
  }

  const { full_name, driver_code, role, sede_id, vehicle_id, active, password } = req.body ?? {};
  const cleanName = typeof full_name === 'string' && full_name.trim() ? full_name.trim() : existing.full_name;
  const requestedRole: UserRole =
    role === 'GERENCIA' || role === 'ADMIN' || role === 'CONDUCTOR' ? role : existing.role;

  if (actor.role === 'ADMIN' && requestedRole !== 'CONDUCTOR') {
    res.status(403).json({ error: 'No tienes permisos para cambiar el rol a Administrador o Gerencia.' });
    return;
  }

  let cleanDriverCode: string | null = existing.driver_code;
  let cleanVehicleId: number | null = null;
  let cleanSedeId: number | null = existing.sede_id;

  if (requestedRole === 'CONDUCTOR') {
    if (driver_code !== undefined) {
      const validated = validateDriverCode(driver_code);
      if (!validated) {
        res.status(400).json({
          error: 'Todo conductor debe tener un código único válido (2 a 20 caracteres: letras, números, guion o guion bajo).',
        });
        return;
      }
      cleanDriverCode = validated;
    } else if (!cleanDriverCode) {
      res.status(400).json({ error: 'Todo conductor debe tener un código único asignado.' });
      return;
    }

    const dupCode = db
      .prepare('SELECT id FROM users WHERE driver_code = ? AND deleted_at IS NULL AND id != ? LIMIT 1')
      .get(cleanDriverCode, id);
    if (dupCode) {
      res.status(409).json({ error: `El código de conductor ${cleanDriverCode} ya pertenece a otro conductor.` });
      return;
    }

    const targetVehId =
      vehicle_id !== undefined ? (vehicle_id ? Number(vehicle_id) : null) : existing.vehicle_id;
    if (targetVehId) {
      const veh = db.prepare('SELECT id, sede_id FROM vehicles WHERE id = ?').get(targetVehId) as
        | { id: number; sede_id: number | null }
        | undefined;
      if (!veh) {
        res.status(400).json({ error: 'El camión seleccionado no existe.' });
        return;
      }
      if (actor.role === 'ADMIN' && veh.sede_id !== actor.sede_id) {
        res.status(403).json({ error: 'Solo puedes asignar camiones de tu propia sede.' });
        return;
      }
      cleanVehicleId = veh.id;
      cleanSedeId = actor.role === 'ADMIN' ? actor.sede_id : veh.sede_id;
    } else {
      cleanVehicleId = null;
      if (actor.role === 'ADMIN') {
        cleanSedeId = actor.sede_id;
      } else if (sede_id !== undefined && sede_id !== null && String(sede_id).trim() !== '') {
        const sede = getSedeById(Number(sede_id));
        if (!sede) {
          res.status(400).json({ error: 'Sede inválida.' });
          return;
        }
        cleanSedeId = sede.id;
      }
    }
  } else if (requestedRole === 'ADMIN') {
    cleanDriverCode = null;
    const targetSedeId = sede_id !== undefined ? Number(sede_id) : existing.sede_id;
    const sede = getSedeById(targetSedeId);
    if (!sede) {
      res.status(400).json({ error: 'Todo Administrador debe tener una sede asignada.' });
      return;
    }
    cleanSedeId = sede.id;
    cleanVehicleId = null;
  } else {
    cleanDriverCode = null;
    cleanSedeId = null;
    cleanVehicleId = null;
  }

  const isActive = active !== undefined ? (active ? 1 : 0) : existing.active;

  // Prevent disabling own account accidentally
  if (id === actor.id && isActive === 0) {
    res.status(400).json({ error: 'No puedes desactivar tu propia cuenta en sesión.' });
    return;
  }

  if (typeof password === 'string' && password.length > 0) {
    if (password.length < 6) {
      res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
      return;
    }
    const newHash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, id);
  }

  try {
    db.prepare(
      'UPDATE users SET full_name = ?, driver_code = ?, role = ?, sede_id = ?, vehicle_id = ?, active = ? WHERE id = ?'
    ).run(cleanName, cleanDriverCode, requestedRole, cleanSedeId, cleanVehicleId, isActive, id);

    const updated = getUserById(id);
    logAudit(actor.id, 'USER_UPDATE', `Usuario actualizado: ${existing.username}`);
    res.json({ user: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('driver_code') || msg.includes('UNIQUE')) {
      res.status(409).json({ error: 'El código de conductor ya está en uso.' });
      return;
    }
    res.status(500).json({ error: 'Error al actualizar usuario.' });
  }
});

app.delete('/api/admin/users/:id', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const actor = req.user!;
  const id = Number(req.params.id);
  const existing = db
    .prepare('SELECT id, username, full_name, driver_code, role, sede_id FROM users WHERE id = ? AND deleted_at IS NULL')
    .get(id) as
    | {
        id: number;
        username: string;
        full_name: string;
        driver_code: string | null;
        role: UserRole;
        sede_id: number | null;
      }
    | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Usuario no encontrado.' });
    return;
  }
  if (id === actor.id) {
    res.status(400).json({ error: 'No puedes eliminar tu propio usuario en sesión.' });
    return;
  }
  if (actor.role === 'ADMIN') {
    if (existing.role !== 'CONDUCTOR' || existing.sede_id !== actor.sede_id) {
      res.status(403).json({ error: 'Solo puedes eliminar conductores pertenecientes a tu propia sede.' });
      return;
    }
  }
  if (existing.role === 'GERENCIA') {
    const gerenciaCount = (
      db
        .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'GERENCIA' AND active = 1 AND deleted_at IS NULL")
        .get() as { cnt: number }
    ).cnt;
    if (gerenciaCount <= 1) {
      res.status(400).json({ error: 'Debe permanecer al menos un usuario de Gerencia activo.' });
      return;
    }
  }
  if (existing.role === 'CONDUCTOR') {
    const shift = getDriverActiveShift(id);
    if (shift.shiftActive) {
      res.status(400).json({
        error: `El conductor ${existing.full_name} tiene una jornada activa en curso. Debe finalizar la jornada antes de eliminarlo.`,
      });
      return;
    }
  }

  const eventsCnt = (
    db.prepare('SELECT COUNT(*) AS cnt FROM events WHERE user_id = ?').get(id) as { cnt: number }
  ).cnt;

  if (eventsCnt === 0) {
    db.transaction(() => {
      db.prepare('DELETE FROM route_points WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();
  } else {
    // Preserve immutable historical events & allow driver_code/username reuse cleanly
    const now = new Date().toISOString();
    const archivedUsername = `${existing.username}__del_${id}`;
    db.prepare(
      'UPDATE users SET active = 0, deleted_at = ?, vehicle_id = NULL, username = ? WHERE id = ?'
    ).run(now, archivedUsername, id);
  }

  logAudit(
    actor.id,
    'USER_DELETE',
    `Usuario eliminado: ${existing.full_name} (${existing.username}${existing.driver_code ? ` · ${existing.driver_code}` : ''})`
  );
  res.json({ deleted: true, softDeleted: eventsCnt > 0 });
});

// ==========================================
// REPORTS ENGINE
// ==========================================

app.get('/api/admin/reports', requireAuth, requireRole('GERENCIA', 'ADMIN'), (req: AuthedRequest, res: Response) => {
  const { eventDate: today } = getServerDateParts();
  const startDate =
    typeof req.query.startDate === 'string' && req.query.startDate.trim()
      ? req.query.startDate.trim()
      : today;
  const endDate =
    typeof req.query.endDate === 'string' && req.query.endDate.trim()
      ? req.query.endDate.trim()
      : today;
  const scopedSedeId = resolveScopedSedeId(req.user!, req.query.sedeId);
  const vehicleId = req.query.vehicleId ? Number(req.query.vehicleId) : null;
  const userId = req.query.userId ? Number(req.query.userId) : null;

  const conditions = ['event_date >= ?', 'event_date <= ?'];
  const params: unknown[] = [startDate, endDate];

  if (scopedSedeId) {
    conditions.push('sede_id = ?');
    params.push(scopedSedeId);
  }
  if (vehicleId) {
    conditions.push('vehicle_id = ?');
    params.push(vehicleId);
  }
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }

  const events = db
    .prepare(
      `SELECT * FROM events
       WHERE ${conditions.join(' AND ')}
       ORDER BY vehicle_code_snapshot ASC, recorded_at ASC, id ASC`
    )
    .all(...params) as EventRow[];

  interface AggRow {
    key: string;
    label: string;
    sublabel: string;
    totalEvents: number;
    visitsCount: number;
    exitsCount: number;
    shiftsCount: number;
    workedMinutes: number;
    stayMinutes: number;
  }

  interface LocationStay {
    vehicleCode: string;
    vehiclePlate: string;
    driverName: string;
    locationName: string;
    entryTime: string;
    exitTime: string | null;
    durationMinutes: number | null;
    date: string;
  }

  const byVehicleMap = new Map<string, AggRow>();
  const byDriverMap = new Map<string, AggRow>();
  const locationStays: LocationStay[] = [];

  const eventsByVehicle = new Map<string, EventRow[]>();
  for (const ev of events) {
    const vKey = `${ev.vehicle_code_snapshot}|${ev.vehicle_plate_snapshot}`;
    if (!eventsByVehicle.has(vKey)) eventsByVehicle.set(vKey, []);
    eventsByVehicle.get(vKey)!.push(ev);
  }

  for (const [vKey, vEvents] of eventsByVehicle.entries()) {
    const [vCode, vPlate] = vKey.split('|');
    if (!byVehicleMap.has(vKey)) {
      byVehicleMap.set(vKey, {
        key: vKey,
        label: vCode,
        sublabel: vPlate,
        totalEvents: 0,
        visitsCount: 0,
        exitsCount: 0,
        shiftsCount: 0,
        workedMinutes: 0,
        stayMinutes: 0,
      });
    }
    const vAgg = byVehicleMap.get(vKey)!;

    let openShift: EventRow | null = null;
    let openEntry: EventRow | null = null;

    for (const ev of vEvents) {
      const dKey = ev.username_snapshot;
      if (!byDriverMap.has(dKey)) {
        byDriverMap.set(dKey, {
          key: dKey,
          label: ev.driver_name_snapshot,
          sublabel: ev.username_snapshot,
          totalEvents: 0,
          visitsCount: 0,
          exitsCount: 0,
          shiftsCount: 0,
          workedMinutes: 0,
          stayMinutes: 0,
        });
      }
      const dAgg = byDriverMap.get(dKey)!;

      vAgg.totalEvents++;
      dAgg.totalEvents++;

      if (ev.event_type === 'INICIO_JORNADA') {
        vAgg.shiftsCount++;
        dAgg.shiftsCount++;
        openShift = ev;
      } else if (ev.event_type === 'FIN_JORNADA') {
        if (openShift) {
          const mins = Math.max(
            0,
            Math.round((new Date(ev.recorded_at).getTime() - new Date(openShift.recorded_at).getTime()) / 60000)
          );
          vAgg.workedMinutes += mins;
          const openDriverAgg = byDriverMap.get(openShift.username_snapshot);
          if (openDriverAgg) openDriverAgg.workedMinutes += mins;
          openShift = null;
        }
        if (openEntry) {
          const stayMins = Math.max(
            0,
            Math.round((new Date(ev.recorded_at).getTime() - new Date(openEntry.recorded_at).getTime()) / 60000)
          );
          vAgg.stayMinutes += stayMins;
          const entryDriverAgg = byDriverMap.get(openEntry.username_snapshot);
          if (entryDriverAgg) entryDriverAgg.stayMinutes += stayMins;
          locationStays.push({
            vehicleCode: vCode,
            vehiclePlate: vPlate,
            driverName: openEntry.driver_name_snapshot,
            locationName: openEntry.geofence_name_snapshot || openEntry.address,
            entryTime: `${openEntry.event_date} ${openEntry.event_time}`,
            exitTime: `${ev.event_date} ${ev.event_time}`,
            durationMinutes: stayMins,
            date: openEntry.event_date,
          });
          openEntry = null;
        }
      } else if (ev.event_type === 'ENTRADA') {
        vAgg.visitsCount++;
        dAgg.visitsCount++;
        openEntry = ev;
      } else if (ev.event_type === 'SALIDA') {
        vAgg.exitsCount++;
        dAgg.exitsCount++;
        if (openEntry) {
          const stayMins = Math.max(
            0,
            Math.round((new Date(ev.recorded_at).getTime() - new Date(openEntry.recorded_at).getTime()) / 60000)
          );
          vAgg.stayMinutes += stayMins;
          const entryDriverAgg = byDriverMap.get(openEntry.username_snapshot);
          if (entryDriverAgg) entryDriverAgg.stayMinutes += stayMins;
          locationStays.push({
            vehicleCode: vCode,
            vehiclePlate: vPlate,
            driverName: openEntry.driver_name_snapshot,
            locationName: openEntry.geofence_name_snapshot || openEntry.address,
            entryTime: `${openEntry.event_date} ${openEntry.event_time}`,
            exitTime: `${ev.event_date} ${ev.event_time}`,
            durationMinutes: stayMins,
            date: openEntry.event_date,
          });
          openEntry = null;
        }
      }
    }

    if (openEntry) {
      locationStays.push({
        vehicleCode: vCode,
        vehiclePlate: vPlate,
        driverName: openEntry.driver_name_snapshot,
        locationName: openEntry.geofence_name_snapshot || openEntry.address,
        entryTime: `${openEntry.event_date} ${openEntry.event_time}`,
        exitTime: null,
        durationMinutes: null,
        date: openEntry.event_date,
      });
    }
  }

  const byVehicle = Array.from(byVehicleMap.values());
  const byDriver = Array.from(byDriverMap.values());

  const summary = {
    startDate,
    endDate,
    totalEvents: events.length,
    totalVisits: events.filter((e) => e.event_type === 'ENTRADA').length,
    totalShifts: events.filter((e) => e.event_type === 'INICIO_JORNADA').length,
    totalWorkedHours:
      Math.round((byVehicle.reduce((acc, r) => acc + r.workedMinutes, 0) / 60) * 100) / 100,
    totalStayHours:
      Math.round((byVehicle.reduce((acc, r) => acc + r.stayMinutes, 0) / 60) * 100) / 100,
  };

  res.json({ summary, byVehicle, byDriver, locationStays, events });
});

// ==========================================
// BACKUP & RECOVERY (GERENCIA ONLY)
// ==========================================

app.get('/api/admin/backup/export', requireAuth, requireRole('GERENCIA'), async (req: AuthedRequest, res: Response) => {
  const format = req.query.format === 'sqlite' ? 'sqlite' : 'json';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  if (format === 'sqlite') {
    const tmpFile = path.join(os.tmpdir(), `copaques_backup_${stamp}.db`);
    try {
      await db.backup(tmpFile);
      logAudit(req.user!.id, 'BACKUP_EXPORT_SQLITE', `Respaldo SQLite generado: ${stamp}`);
      res.download(tmpFile, `copaques_respaldo_${stamp}.db`, () => {
        fs.rmSync(tmpFile, { force: true });
      });
    } catch {
      res.status(500).json({ error: 'No se pudo generar el respaldo SQLite.' });
    }
    return;
  }

  const payload = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    exportedBy: req.user!.username,
    tables: {
      sedes: db.prepare('SELECT * FROM sedes').all(),
      vehicles: db.prepare('SELECT * FROM vehicles').all(),
      users: db.prepare('SELECT * FROM users').all(),
      geofences: db.prepare('SELECT * FROM geofences').all(),
      events: db.prepare('SELECT * FROM events').all(),
      route_points: db.prepare('SELECT * FROM route_points').all(),
      planned_routes: db.prepare('SELECT * FROM planned_routes').all(),
      driver_geofence_state: db.prepare('SELECT * FROM driver_geofence_state').all(),
    },
  };

  logAudit(req.user!.id, 'BACKUP_EXPORT_JSON', `Respaldo JSON generado (${payload.tables.events.length} eventos)`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="copaques_respaldo_${stamp}.json"`
  );
  res.send(JSON.stringify(payload, null, 2));
});

app.post('/api/admin/backup/restore', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || !body.tables || typeof body.tables !== 'object') {
    res.status(400).json({ error: 'Archivo de respaldo inválido.' });
    return;
  }

  const { vehicles = [], geofences = [], events = [] } = body.tables as {
    vehicles?: Array<Record<string, unknown>>;
    geofences?: Array<Record<string, unknown>>;
    events?: Array<Record<string, unknown>>;
  };

  if (!Array.isArray(vehicles) || !Array.isArray(geofences) || !Array.isArray(events)) {
    res.status(400).json({ error: 'Estructura de tablas inválida en el respaldo.' });
    return;
  }

  let restoredVehicles = 0;
  let restoredGeofences = 0;
  let restoredEvents = 0;

  const tx = db.transaction(() => {
    const insertVehicle = db.prepare(
      `INSERT OR IGNORE INTO vehicles (code, plate, brand, model, capacity_tons, sede_id, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const v of vehicles) {
      if (typeof v.code === 'string' && typeof v.plate === 'string') {
        const r = insertVehicle.run(
          v.code,
          v.plate,
          String(v.brand ?? ''),
          String(v.model ?? ''),
          Number(v.capacity_tons ?? 0),
          v.sede_id ? Number(v.sede_id) : null,
          Number(v.active ?? 1),
          String(v.created_at ?? new Date().toISOString())
        );
        restoredVehicles += r.changes;
      }
    }

    const insertGf = db.prepare(
      `INSERT OR IGNORE INTO geofences (id, name, category, latitude, longitude, radius_meters, sede_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const g of geofences) {
      if (typeof g.name === 'string' && Number.isFinite(Number(g.latitude)) && Number.isFinite(Number(g.longitude))) {
        const r = insertGf.run(
          Number(g.id) || null,
          g.name,
          VALID_CATEGORIES.includes(g.category as (typeof VALID_CATEGORIES)[number]) ? g.category : 'Otro',
          Number(g.latitude),
          Number(g.longitude),
          Number(g.radius_meters) || 150,
          g.sede_id ? Number(g.sede_id) : null,
          Number(g.active ?? 1),
          String(g.created_at ?? new Date().toISOString()),
          String(g.updated_at ?? new Date().toISOString())
        );
        restoredGeofences += r.changes;
      }
    }

    const insertEvent = db.prepare(
      `INSERT OR IGNORE INTO events (
        event_uuid, event_date, event_time, recorded_at,
        latitude, longitude, accuracy_meters, address,
        user_id, username_snapshot, driver_name_snapshot,
        vehicle_id, vehicle_code_snapshot, vehicle_plate_snapshot,
        sede_id, sede_name_snapshot,
        event_type, source, geofence_id, geofence_name_snapshot,
        notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of events) {
      if (typeof e.event_uuid === 'string' && typeof e.event_date === 'string' && typeof e.event_type === 'string') {
        const r = insertEvent.run(
          e.event_uuid,
          e.event_date,
          String(e.event_time ?? '00:00:00'),
          String(e.recorded_at ?? new Date().toISOString()),
          Number(e.latitude ?? 0),
          Number(e.longitude ?? 0),
          e.accuracy_meters !== null && e.accuracy_meters !== undefined ? Number(e.accuracy_meters) : null,
          String(e.address ?? ''),
          req.user!.id,
          String(e.username_snapshot ?? ''),
          String(e.driver_name_snapshot ?? ''),
          null,
          String(e.vehicle_code_snapshot ?? ''),
          String(e.vehicle_plate_snapshot ?? ''),
          e.sede_id ? Number(e.sede_id) : null,
          String(e.sede_name_snapshot ?? ''),
          VALID_EVENT_TYPES.includes(e.event_type as (typeof VALID_EVENT_TYPES)[number]) ? e.event_type : 'ENTRADA',
          e.source === 'GEOCERCA_AUTO' ? 'GEOCERCA_AUTO' : 'MANUAL',
          e.geofence_id ? Number(e.geofence_id) : null,
          e.geofence_name_snapshot ? String(e.geofence_name_snapshot) : null,
          String(e.notes ?? ''),
          String(e.created_at ?? new Date().toISOString())
        );
        restoredEvents += r.changes;
      }
    }

    logAudit(
      req.user!.id,
      'BACKUP_RESTORE',
      `Restauración incremental: +${restoredVehicles} vehículos, +${restoredGeofences} geocercas, +${restoredEvents} eventos`
    );
  });

  tx();
  res.json({
    ok: true,
    restored: { vehicles: restoredVehicles, geofences: restoredGeofences, events: restoredEvents },
  });
});

app.get('/api/admin/audit', requireAuth, requireRole('GERENCIA'), (_req: AuthedRequest, res: Response) => {
  const logs = db
    .prepare(
      `SELECT l.*, u.username AS actor_username, u.full_name AS actor_name
       FROM system_audit_log l
       LEFT JOIN users u ON u.id = l.actor_user_id
       ORDER BY l.id DESC LIMIT 100`
    )
    .all();
  res.json({ logs });
});

app.get('/api/admin/export-project', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  try {
    const zipBuffer = createProjectZipBuffer();
    logAudit(req.user!.id, 'PROJECT_EXPORT_ZIP', 'Descarga de paquete fuente (.zip) para despliegue');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="copaques-control-flota.zip"'
    );
    res.send(zipBuffer);
  } catch {
    res.status(500).json({ error: 'No se pudo empaquetar el proyecto.' });
  }
});

// ==========================================
// VITE / STATIC SERVING
// ==========================================

async function startServer() {
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Copaques Control de Flota server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
