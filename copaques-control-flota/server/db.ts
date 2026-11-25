import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const DB_PATH = path.join(DATA_DIR, 'flota.db');

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      plate TEXT NOT NULL UNIQUE,
      brand TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      capacity_tons REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('CONDUCTOR', 'GERENCIA')),
      vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS geofences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('Planta', 'Cliente', 'Obra', 'Bodega', 'Proveedor', 'Otro')),
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius_meters REAL NOT NULL CHECK(radius_meters >= 20 AND radius_meters <= 50000),
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_uuid TEXT NOT NULL UNIQUE,
      event_date TEXT NOT NULL,
      event_time TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      accuracy_meters REAL,
      address TEXT NOT NULL DEFAULT '',
      user_id INTEGER NOT NULL REFERENCES users(id),
      username_snapshot TEXT NOT NULL,
      driver_name_snapshot TEXT NOT NULL,
      vehicle_id INTEGER REFERENCES vehicles(id),
      vehicle_code_snapshot TEXT NOT NULL,
      vehicle_plate_snapshot TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('INICIO_JORNADA', 'FIN_JORNADA', 'ENTRADA', 'SALIDA')),
      source TEXT NOT NULL DEFAULT 'MANUAL' CHECK(source IN ('MANUAL', 'GEOCERCA_AUTO')),
      geofence_id INTEGER,
      geofence_name_snapshot TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS driver_geofence_state (
      vehicle_id INTEGER PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
      current_geofence_id INTEGER REFERENCES geofences(id) ON DELETE SET NULL,
      entered_at TEXT,
      last_lat REAL,
      last_lng REAL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS geocode_cache (
      coord_key TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      cached_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
    CREATE INDEX IF NOT EXISTS idx_events_vehicle_date ON events(vehicle_id, event_date, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_events_user_date ON events(user_id, event_date, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_geofences_active ON geofences(active);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, active);

    -- Permanence & Immutability Triggers: Historical events cannot be altered or deleted
    CREATE TRIGGER IF NOT EXISTS trg_events_prevent_update
    BEFORE UPDATE ON events
    BEGIN
      SELECT RAISE(ABORT, 'Los registros históricos de eventos son inmutables y no pueden modificarse.');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_events_prevent_delete
    BEFORE DELETE ON events
    BEGIN
      SELECT RAISE(ABORT, 'Los registros históricos de eventos son permanentes y no pueden eliminarse.');
    END;
  `);
}

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function getServerDateParts(now = new Date()): {
  eventDate: string;
  eventTime: string;
  recordedAt: string;
} {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  const secs = String(now.getSeconds()).padStart(2, '0');
  return {
    eventDate: `${year}-${month}-${day}`,
    eventTime: `${hours}:${mins}:${secs}`,
    recordedAt: now.toISOString(),
  };
}
