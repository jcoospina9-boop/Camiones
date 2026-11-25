import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  type AuthedRequest,
  getUserById,
  requireAuth,
  requireRole,
  signAuthToken,
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

interface GeofenceRow {
  id: number;
  name: string;
  category: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
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
  vehicle_id: number | null;
  vehicle_code_snapshot: string;
  vehicle_plate_snapshot: string;
  event_type: 'INICIO_JORNADA' | 'FIN_JORNADA' | 'ENTRADA' | 'SALIDA';
  source: 'MANUAL' | 'GEOCERCA_AUTO';
  geofence_id: number | null;
  geofence_name_snapshot: string | null;
  notes: string;
  created_at: string;
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

function findMatchingGeofence(lat: number, lng: number): GeofenceRow | null {
  const activeGeofences = db
    .prepare('SELECT id, name, category, latitude, longitude, radius_meters, active FROM geofences WHERE active = 1')
    .all() as GeofenceRow[];

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
    res.status(400).json({ error: 'Ingresa el nombre completo del administrador.' });
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
        `INSERT INTO users (username, password_hash, full_name, role, vehicle_id, active, created_at)
         VALUES (?, ?, ?, 'GERENCIA', NULL, 1, ?)`
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
      .prepare("SELECT * FROM users WHERE username = ? AND role = 'GERENCIA'")
      .get(cleanUser) as { id: number; active: number } | undefined;

    if (!adminUser) {
      const anyGerencia = db
        .prepare("SELECT * FROM users WHERE role = 'GERENCIA' AND active = 1 LIMIT 1")
        .get() as { id: number; active: number } | undefined;

      if (anyGerencia && cleanUser === 'gerencia') {
        adminUser = anyGerencia;
      } else {
        const hash = bcrypt.hashSync(envAdminPass, 10);
        const now = new Date().toISOString();
        const resInsert = db
          .prepare(
            `INSERT INTO users (username, password_hash, full_name, role, vehicle_id, active, created_at)
             VALUES (?, ?, 'Gerencia General', 'GERENCIA', NULL, 1, ?)`
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
      res.json({ token, user });
      return;
    }
  }

  const dbUser = db
    .prepare('SELECT id, username, password_hash, role, active FROM users WHERE username = ?')
    .get(cleanUser) as
    | { id: number; username: string; password_hash: string; role: string; active: number }
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

  res.json({ token, user });
});

app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res: Response) => {
  res.json({ user: req.user });
});

// ==========================================
// DRIVER ROUTES (CONDUCTOR)
// ==========================================

app.get('/api/driver/status', requireAuth, (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const { eventDate } = getServerDateParts();

  if (!user.vehicle_id) {
    res.json({
      hasVehicle: false,
      shiftActive: false,
      shiftStartedAt: null,
      currentGeofence: null,
      todayEvents: [],
      activeGeofencesCount: 0,
    });
    return;
  }

  const shift = getVehicleShiftStatus(user.vehicle_id);
  const todayEvents = db
    .prepare(
      `SELECT * FROM events
       WHERE vehicle_id = ? AND event_date = ?
       ORDER BY recorded_at DESC, id DESC`
    )
    .all(user.vehicle_id, eventDate) as EventRow[];

  const stateRow = db
    .prepare(
      `SELECT s.current_geofence_id, s.entered_at, g.name, g.category
       FROM driver_geofence_state s
       LEFT JOIN geofences g ON g.id = s.current_geofence_id
       WHERE s.vehicle_id = ?`
    )
    .get(user.vehicle_id) as
    | { current_geofence_id: number | null; entered_at: string | null; name: string | null; category: string | null }
    | undefined;

  const gfCount = db
    .prepare('SELECT COUNT(*) AS cnt FROM geofences WHERE active = 1')
    .get() as { cnt: number };

  res.json({
    hasVehicle: true,
    shiftActive: shift.shiftActive,
    shiftStartedAt: shift.shiftStartedAt,
    currentGeofence:
      stateRow && stateRow.current_geofence_id
        ? {
            id: stateRow.current_geofence_id,
            name: stateRow.name,
            category: stateRow.category,
            entered_at: stateRow.entered_at,
          }
        : null,
    todayEvents,
    activeGeofencesCount: gfCount.cnt,
  });
});

app.post('/api/driver/events', requireAuth, async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  if (!user.vehicle_id || !user.vehicle_code || !user.vehicle_plate) {
    res.status(400).json({
      error: 'Tu usuario no tiene un camión asignado. Contacta a Gerencia.',
    });
    return;
  }

  const { event_type, latitude, longitude, accuracy_meters, notes } = req.body ?? {};
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

  const shift = getVehicleShiftStatus(user.vehicle_id);
  if (event_type === 'INICIO_JORNADA' && shift.shiftActive) {
    res.status(400).json({ error: 'Ya tienes una jornada activa en curso.' });
    return;
  }
  if (event_type !== 'INICIO_JORNADA' && !shift.shiftActive) {
    res.status(400).json({ error: 'Debes iniciar jornada antes de registrar movimientos.' });
    return;
  }

  const matchedGf = findMatchingGeofence(coords.lat, coords.lng);
  const address = await reverseGeocode(coords.lat, coords.lng);
  const { eventDate, eventTime, recordedAt } = getServerDateParts();
  const eventUuid = crypto.randomUUID();

  const insertTx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO events (
          event_uuid, event_date, event_time, recorded_at,
          latitude, longitude, accuracy_meters, address,
          user_id, username_snapshot, driver_name_snapshot,
          vehicle_id, vehicle_code_snapshot, vehicle_plate_snapshot,
          event_type, source, geofence_id, geofence_name_snapshot,
          notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?)`
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
        user.vehicle_id,
        user.vehicle_code,
        user.vehicle_plate,
        event_type,
        matchedGf ? matchedGf.id : null,
        matchedGf ? matchedGf.name : null,
        cleanNotes,
        recordedAt
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
      ).run(user.vehicle_id, coords.lat, coords.lng, recordedAt);
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
        user.vehicle_id,
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
  if (!user.vehicle_id || !user.vehicle_code || !user.vehicle_plate) {
    res.json({ triggeredEvents: [], currentGeofence: null });
    return;
  }

  const coords = validateCoords(req.body?.latitude, req.body?.longitude);
  if (!coords) {
    res.status(400).json({ error: 'Coordenadas inválidas.' });
    return;
  }

  const shift = getVehicleShiftStatus(user.vehicle_id);
  if (!shift.shiftActive) {
    res.json({ triggeredEvents: [], currentGeofence: null });
    return;
  }

  const currentState = db
    .prepare(
      `SELECT s.current_geofence_id, g.name, g.category
       FROM driver_geofence_state s
       LEFT JOIN geofences g ON g.id = s.current_geofence_id
       WHERE s.vehicle_id = ?`
    )
    .get(user.vehicle_id) as
    | { current_geofence_id: number | null; name: string | null; category: string | null }
    | undefined;

  const previousGfId = currentState?.current_geofence_id ?? null;
  const matchedGf = findMatchingGeofence(coords.lat, coords.lng);
  const nextGfId = matchedGf ? matchedGf.id : null;

  if (previousGfId === nextGfId) {
    db.prepare(
      `INSERT INTO driver_geofence_state (vehicle_id, current_geofence_id, entered_at, last_lat, last_lng, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?)
       ON CONFLICT(vehicle_id) DO UPDATE SET
         last_lat = excluded.last_lat,
         last_lng = excluded.last_lng,
         updated_at = excluded.updated_at`
    ).run(user.vehicle_id, previousGfId, coords.lat, coords.lng, new Date().toISOString());

    res.json({
      triggeredEvents: [],
      currentGeofence: matchedGf
        ? { id: matchedGf.id, name: matchedGf.name, category: matchedGf.category }
        : null,
    });
    return;
  }

  const address = await reverseGeocode(coords.lat, coords.lng);
  const { eventDate, eventTime, recordedAt } = getServerDateParts();
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
          user_id, username_snapshot, driver_name_snapshot,
          vehicle_id, vehicle_code_snapshot, vehicle_plate_snapshot,
          event_type, source, geofence_id, geofence_name_snapshot,
          notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'GEOCERCA_AUTO', ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        eventDate,
        eventTime,
        recordedAt,
        coords.lat,
        coords.lng,
        address,
        user.id,
        user.username,
        user.full_name,
        user.vehicle_id,
        user.vehicle_code,
        user.vehicle_plate,
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
      user.vehicle_id,
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

// ==========================================
// ADMIN / GERENCIA ROUTES
// ==========================================

app.get('/api/admin/dashboard', requireAuth, requireRole('GERENCIA'), (_req: AuthedRequest, res: Response) => {
  const { eventDate } = getServerDateParts();

  const totalVehicles = (
    db.prepare('SELECT COUNT(*) AS cnt FROM vehicles').get() as { cnt: number }
  ).cnt;
  const activeVehiclesCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM vehicles WHERE active = 1').get() as { cnt: number }
  ).cnt;
  const activeDriversCount = (
    db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'CONDUCTOR' AND active = 1").get() as { cnt: number }
  ).cnt;
  const eventsTodayCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM events WHERE event_date = ?').get(eventDate) as { cnt: number }
  ).cnt;
  const entriesTodayCount = (
    db.prepare("SELECT COUNT(*) AS cnt FROM events WHERE event_date = ? AND event_type = 'ENTRADA'").get(eventDate) as { cnt: number }
  ).cnt;
  const activeGeofencesCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM geofences WHERE active = 1').get() as { cnt: number }
  ).cnt;

  const recentEvents = db
    .prepare('SELECT * FROM events ORDER BY recorded_at DESC, id DESC LIMIT 15')
    .all() as EventRow[];

  const vehicles = db
    .prepare(
      `SELECT v.id, v.code, v.plate, v.brand, v.model, v.capacity_tons, v.active,
              u.id AS driver_id, u.full_name AS driver_name, u.username AS driver_username
       FROM vehicles v
       LEFT JOIN users u ON u.vehicle_id = v.id AND u.role = 'CONDUCTOR' AND u.active = 1
       WHERE v.active = 1
       ORDER BY v.code ASC`
    )
    .all() as Array<{
    id: number;
    code: string;
    plate: string;
    brand: string;
    model: string;
    capacity_tons: number;
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
      shiftActive: shift.shiftActive,
      shiftStartedAt: shift.shiftStartedAt,
      lastEvent: shift.lastEvent,
      currentGeofence: gfState ?? null,
    };
  });

  const activeShiftsCount = fleetStatus.filter((v) => v.shiftActive).length;

  res.json({
    today: eventDate,
    kpis: {
      totalVehicles,
      activeVehiclesCount,
      activeDriversCount,
      activeShiftsCount,
      eventsTodayCount,
      entriesTodayCount,
      activeGeofencesCount,
    },
    recentEvents,
    fleetStatus,
  });
});

app.get('/api/admin/events', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const {
    date,
    startDate,
    endDate,
    vehicleId,
    userId,
    eventType,
    source,
    search,
    limit = '250',
    offset = '0',
  } = req.query;

  const conditions: string[] = [];
  const params: unknown[] = [];

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
      '(address LIKE ? OR notes LIKE ? OR driver_name_snapshot LIKE ? OR vehicle_code_snapshot LIKE ? OR vehicle_plate_snapshot LIKE ? OR geofence_name_snapshot LIKE ?)'
    );
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
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

app.get('/api/admin/route', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const vehicleId = Number(req.query.vehicleId);
  const date = typeof req.query.date === 'string' && req.query.date.trim()
    ? req.query.date.trim()
    : getServerDateParts().eventDate;

  if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
    res.status(400).json({ error: 'Selecciona un vehículo válido.' });
    return;
  }

  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
  if (!vehicle) {
    res.status(404).json({ error: 'Vehículo no encontrado.' });
    return;
  }

  const events = db
    .prepare(
      `SELECT * FROM events
       WHERE vehicle_id = ? AND event_date = ?
       ORDER BY recorded_at ASC, id ASC`
    )
    .all(vehicleId, date) as EventRow[];

  let totalDistanceMeters = 0;
  for (let i = 1; i < events.length; i++) {
    totalDistanceMeters += haversineMeters(
      events[i - 1].latitude,
      events[i - 1].longitude,
      events[i].latitude,
      events[i].longitude
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

  const geofences = db
    .prepare('SELECT * FROM geofences WHERE active = 1 ORDER BY name ASC')
    .all();

  res.json({
    vehicle,
    date,
    events,
    geofences,
    summary: {
      totalEvents: events.length,
      entriesCount: events.filter((e) => e.event_type === 'ENTRADA').length,
      exitsCount: events.filter((e) => e.event_type === 'SALIDA').length,
      distanceKm: Math.round((totalDistanceMeters / 1000) * 100) / 100,
      shiftDurationMinutes,
    },
  });
});

// ==========================================
// GEOFENCES CRUD
// ==========================================

app.get('/api/admin/geofences', requireAuth, requireRole('GERENCIA'), (_req: AuthedRequest, res: Response) => {
  const geofences = db
    .prepare('SELECT * FROM geofences ORDER BY active DESC, name ASC')
    .all();
  res.json({ geofences });
});

app.post('/api/admin/geofences', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const { name, category, latitude, longitude, radius_meters, active = true } = req.body ?? {};
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

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO geofences (name, category, latitude, longitude, radius_meters, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cleanName,
      cleanCategory,
      coords.lat,
      coords.lng,
      Math.round(radius),
      active ? 1 : 0,
      req.user!.id,
      now,
      now
    );

  const created = db
    .prepare('SELECT * FROM geofences WHERE id = ?')
    .get(Number(info.lastInsertRowid));
  logAudit(req.user!.id, 'GEOFENCE_CREATE', `Geocerca creada: ${cleanName} (${cleanCategory}, ${Math.round(radius)}m)`);
  res.status(201).json({ geofence: created });
});

app.put('/api/admin/geofences/:id', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM geofences WHERE id = ?').get(id) as GeofenceRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Geocerca no encontrada.' });
    return;
  }

  const { name, category, latitude, longitude, radius_meters, active } = req.body ?? {};
  const cleanName = typeof name === 'string' ? name.trim() : existing.name;
  const cleanCategory = category !== undefined ? (VALID_CATEGORIES.includes(category) ? category : null) : existing.category;
  const coords =
    latitude !== undefined && longitude !== undefined
      ? validateCoords(latitude, longitude)
      : { lat: existing.latitude, lng: existing.longitude };
  const radius = radius_meters !== undefined ? Number(radius_meters) : existing.radius_meters;
  const isActive = active !== undefined ? (active ? 1 : 0) : existing.active;

  if (cleanName.length < 2 || cleanName.length > 120 || !cleanCategory || !coords || !Number.isFinite(radius) || radius < 20 || radius > 50000) {
    res.status(400).json({ error: 'Datos de geocerca inválidos.' });
    return;
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE geofences
     SET name = ?, category = ?, latitude = ?, longitude = ?, radius_meters = ?, active = ?, updated_at = ?
     WHERE id = ?`
  ).run(cleanName, cleanCategory, coords.lat, coords.lng, Math.round(radius), isActive, now, id);

  const updated = db.prepare('SELECT * FROM geofences WHERE id = ?').get(id);
  logAudit(req.user!.id, 'GEOFENCE_UPDATE', `Geocerca #${id} actualizada: ${cleanName}`);
  res.json({ geofence: updated });
});

app.delete('/api/admin/geofences/:id', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM geofences WHERE id = ?').get(id) as GeofenceRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Geocerca no encontrada.' });
    return;
  }
  db.prepare('DELETE FROM geofences WHERE id = ?').run(id);
  logAudit(req.user!.id, 'GEOFENCE_DELETE', `Geocerca eliminada: ${existing.name} (#${id})`);
  res.json({ deleted: true });
});

// ==========================================
// VEHICLES & USERS CRUD
// ==========================================

app.get('/api/admin/vehicles', requireAuth, requireRole('GERENCIA'), (_req: AuthedRequest, res: Response) => {
  const vehicles = db
    .prepare(
      `SELECT v.*, u.id AS assigned_user_id, u.full_name AS assigned_driver_name, u.username AS assigned_username
       FROM vehicles v
       LEFT JOIN users u ON u.vehicle_id = v.id AND u.role = 'CONDUCTOR' AND u.active = 1
       ORDER BY v.code ASC`
    )
    .all();
  res.json({ vehicles });
});

app.post('/api/admin/vehicles', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const { code, plate, brand = '', model = '', capacity_tons = 0 } = req.body ?? {};
  const cleanCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
  const cleanPlate = typeof plate === 'string' ? plate.trim().toUpperCase() : '';
  const cleanBrand = typeof brand === 'string' ? brand.trim() : '';
  const cleanModel = typeof model === 'string' ? model.trim() : '';
  const cap = Number(capacity_tons) || 0;

  if (cleanCode.length < 2 || cleanPlate.length < 3) {
    res.status(400).json({ error: 'El código interno y la placa son obligatorios.' });
    return;
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO vehicles (code, plate, brand, model, capacity_tons, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(cleanCode, cleanPlate, cleanBrand, cleanModel, cap, new Date().toISOString());

    const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(info.lastInsertRowid));
    logAudit(req.user!.id, 'VEHICLE_CREATE', `Vehículo creado: ${cleanCode} (${cleanPlate})`);
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
  const existing = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id) as
    | { id: number; code: string; plate: string; brand: string; model: string; capacity_tons: number; active: number }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Vehículo no encontrado.' });
    return;
  }

  const { code, plate, brand, model, capacity_tons, active } = req.body ?? {};
  const cleanCode = typeof code === 'string' ? code.trim().toUpperCase() : existing.code;
  const cleanPlate = typeof plate === 'string' ? plate.trim().toUpperCase() : existing.plate;
  const cleanBrand = typeof brand === 'string' ? brand.trim() : existing.brand;
  const cleanModel = typeof model === 'string' ? model.trim() : existing.model;
  const cap = capacity_tons !== undefined ? Number(capacity_tons) || 0 : existing.capacity_tons;
  const isActive = active !== undefined ? (active ? 1 : 0) : existing.active;

  try {
    db.prepare(
      `UPDATE vehicles SET code = ?, plate = ?, brand = ?, model = ?, capacity_tons = ?, active = ? WHERE id = ?`
    ).run(cleanCode, cleanPlate, cleanBrand, cleanModel, cap, isActive, id);

    const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
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

app.get('/api/admin/users', requireAuth, requireRole('GERENCIA'), (_req: AuthedRequest, res: Response) => {
  const users = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role, u.vehicle_id, u.active, u.created_at,
              v.code AS vehicle_code, v.plate AS vehicle_plate
       FROM users u
       LEFT JOIN vehicles v ON v.id = u.vehicle_id
       ORDER BY u.role DESC, u.full_name ASC`
    )
    .all();
  res.json({ users });
});

app.post('/api/admin/users', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const { username, password, full_name, role, vehicle_id } = req.body ?? {};
  const cleanUser = typeof username === 'string' ? username.trim().toLowerCase() : '';
  const cleanName = typeof full_name === 'string' ? full_name.trim() : '';
  const cleanPass = typeof password === 'string' ? password : '';
  const cleanRole = role === 'GERENCIA' ? 'GERENCIA' : 'CONDUCTOR';
  const cleanVehicleId =
    cleanRole === 'CONDUCTOR' && vehicle_id ? Number(vehicle_id) : null;

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
  if (cleanRole === 'CONDUCTOR' && !cleanVehicleId) {
    res.status(400).json({ error: 'Todo conductor debe tener un camión asignado.' });
    return;
  }

  try {
    const hash = bcrypt.hashSync(cleanPass, 10);
    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, full_name, role, vehicle_id, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(cleanUser, hash, cleanName, cleanRole, cleanVehicleId, new Date().toISOString());

    const created = getUserById(Number(info.lastInsertRowid));
    logAudit(req.user!.id, 'USER_CREATE', `Usuario creado: ${cleanUser} (${cleanRole})`);
    res.status(201).json({ user: created });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('UNIQUE')) {
      res.status(409).json({ error: 'El nombre de usuario ya está en uso.' });
      return;
    }
    res.status(500).json({ error: 'Error al crear usuario.' });
  }
});

app.put('/api/admin/users/:id', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | { id: number; username: string; full_name: string; role: 'CONDUCTOR' | 'GERENCIA'; vehicle_id: number | null; active: number }
    | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Usuario no encontrado.' });
    return;
  }

  const { full_name, role, vehicle_id, active, password } = req.body ?? {};
  const cleanName = typeof full_name === 'string' && full_name.trim() ? full_name.trim() : existing.full_name;
  const cleanRole = role === 'GERENCIA' || role === 'CONDUCTOR' ? role : existing.role;
  const cleanVehicleId =
    cleanRole === 'CONDUCTOR'
      ? vehicle_id !== undefined
        ? vehicle_id
          ? Number(vehicle_id)
          : null
        : existing.vehicle_id
      : null;
  const isActive = active !== undefined ? (active ? 1 : 0) : existing.active;

  // Prevent disabling own Gerencia account accidentally
  if (id === req.user!.id && isActive === 0) {
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

  db.prepare(
    'UPDATE users SET full_name = ?, role = ?, vehicle_id = ?, active = ? WHERE id = ?'
  ).run(cleanName, cleanRole, cleanVehicleId, isActive, id);

  const updated = getUserById(id);
  logAudit(req.user!.id, 'USER_UPDATE', `Usuario actualizado: ${existing.username}`);
  res.json({ user: updated });
});

// ==========================================
// REPORTS ENGINE
// ==========================================

app.get('/api/admin/reports', requireAuth, requireRole('GERENCIA'), (req: AuthedRequest, res: Response) => {
  const { eventDate: today } = getServerDateParts();
  const startDate =
    typeof req.query.startDate === 'string' && req.query.startDate.trim()
      ? req.query.startDate.trim()
      : today;
  const endDate =
    typeof req.query.endDate === 'string' && req.query.endDate.trim()
      ? req.query.endDate.trim()
      : today;
  const vehicleId = req.query.vehicleId ? Number(req.query.vehicleId) : null;
  const userId = req.query.userId ? Number(req.query.userId) : null;

  const conditions = ['event_date >= ?', 'event_date <= ?'];
  const params: unknown[] = [startDate, endDate];

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

  // Group chronologically per vehicle to compute exact shift hours & location stays
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
// BACKUP & RECOVERY
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
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: req.user!.username,
    tables: {
      vehicles: db.prepare('SELECT * FROM vehicles').all(),
      users: db.prepare('SELECT * FROM users').all(),
      geofences: db.prepare('SELECT * FROM geofences').all(),
      events: db.prepare('SELECT * FROM events').all(),
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
      `INSERT OR IGNORE INTO vehicles (code, plate, brand, model, capacity_tons, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const v of vehicles) {
      if (typeof v.code === 'string' && typeof v.plate === 'string') {
        const r = insertVehicle.run(
          v.code,
          v.plate,
          String(v.brand ?? ''),
          String(v.model ?? ''),
          Number(v.capacity_tons ?? 0),
          Number(v.active ?? 1),
          String(v.created_at ?? new Date().toISOString())
        );
        restoredVehicles += r.changes;
      }
    }

    const insertGf = db.prepare(
      `INSERT OR IGNORE INTO geofences (id, name, category, latitude, longitude, radius_meters, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        event_type, source, geofence_id, geofence_name_snapshot,
        notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
