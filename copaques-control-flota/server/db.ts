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

export const DEFAULT_SEDES = [
  { name: 'Rionegro', code: 'RNG', latitude: 6.1551, longitude: -75.3737 },
  { name: 'San Juan', code: 'SJU', latitude: 6.2442, longitude: -75.5812 },
  { name: 'La Estrella', code: 'EST', latitude: 6.1576, longitude: -75.6433 },
  { name: 'Caucasia', code: 'CAU', latitude: 7.9866, longitude: -75.1935 },
  { name: 'Apartadó', code: 'APA', latitude: 7.883, longitude: -76.6259 },
  { name: 'Montería', code: 'MTR', latitude: 8.7479, longitude: -75.8814 },
  { name: 'Cartagena', code: 'CTG', latitude: 10.391, longitude: -75.4794 },
  { name: 'Sincelejo', code: 'SIN', latitude: 9.3047, longitude: -75.3978 },
] as const;

function hasColumn(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sedes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      plate TEXT NOT NULL UNIQUE,
      brand TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      capacity_tons REAL NOT NULL DEFAULT 0,
      sede_id INTEGER REFERENCES sedes(id) ON DELETE SET NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('CONDUCTOR', 'ADMIN', 'GERENCIA')),
      sede_id INTEGER REFERENCES sedes(id) ON DELETE SET NULL,
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
      sede_id INTEGER REFERENCES sedes(id) ON DELETE SET NULL,
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
      sede_id INTEGER REFERENCES sedes(id) ON DELETE SET NULL,
      sede_name_snapshot TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL CHECK(event_type IN ('INICIO_JORNADA', 'FIN_JORNADA', 'ENTRADA', 'SALIDA')),
      source TEXT NOT NULL DEFAULT 'MANUAL' CHECK(source IN ('MANUAL', 'GEOCERCA_AUTO')),
      geofence_id INTEGER,
      geofence_name_snapshot TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS route_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_date TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      accuracy_meters REAL
    );

    CREATE TABLE IF NOT EXISTS planned_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sede_id INTEGER REFERENCES sedes(id) ON DELETE SET NULL,
      vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
      waypoints_json TEXT NOT NULL,
      distance_km REAL NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
  `);

  // Seed the 8 default sedes idempotently
  const now = new Date().toISOString();
  const insertSede = db.prepare(
    `INSERT OR IGNORE INTO sedes (name, code, latitude, longitude, active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`
  );
  for (const s of DEFAULT_SEDES) {
    insertSede.run(s.name, s.code, s.latitude, s.longitude, now);
  }

  // Incremental schema migrations for existing SQLite databases
  if (!hasColumn('vehicles', 'sede_id')) {
    db.exec('ALTER TABLE vehicles ADD COLUMN sede_id INTEGER REFERENCES sedes(id) ON DELETE SET NULL;');
  }
  if (!hasColumn('geofences', 'sede_id')) {
    db.exec('ALTER TABLE geofences ADD COLUMN sede_id INTEGER REFERENCES sedes(id) ON DELETE SET NULL;');
  }
  if (!hasColumn('events', 'sede_id')) {
    db.exec('ALTER TABLE events ADD COLUMN sede_id INTEGER REFERENCES sedes(id) ON DELETE SET NULL;');
  }
  if (!hasColumn('events', 'sede_name_snapshot')) {
    db.exec("ALTER TABLE events ADD COLUMN sede_name_snapshot TEXT NOT NULL DEFAULT '';");
  }

  // Migrate users table if missing sede_id or missing ADMIN role in CHECK constraint
  const usersMaster = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { sql: string } | undefined;

  const needsUsersMigration =
    !hasColumn('users', 'sede_id') ||
    !usersMaster?.sql.includes("'ADMIN'");

  if (needsUsersMigration) {
    const hasSedeCol = hasColumn('users', 'sede_id');
    db.pragma('foreign_keys = OFF');
    const migrateTx = db.transaction(() => {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          full_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('CONDUCTOR', 'ADMIN', 'GERENCIA')),
          sede_id INTEGER REFERENCES sedes(id) ON DELETE SET NULL,
          vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );

        INSERT INTO users_new (id, username, password_hash, full_name, role, sede_id, vehicle_id, active, created_at)
        SELECT id, username, password_hash, full_name, role, ${hasSedeCol ? 'sede_id' : 'NULL'}, vehicle_id, active, created_at
        FROM users;

        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    });
    migrateTx();
    db.pragma('foreign_keys = ON');
  }

  // Ensure indexes & immutability triggers exist
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
    CREATE INDEX IF NOT EXISTS idx_events_vehicle_date ON events(vehicle_id, event_date, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_events_user_date ON events(user_id, event_date, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_events_sede_date ON events(sede_id, event_date, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_geofences_active ON geofences(active, sede_id);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, active);
    CREATE INDEX IF NOT EXISTS idx_users_sede ON users(sede_id, role, active);
    CREATE INDEX IF NOT EXISTS idx_vehicles_sede ON vehicles(sede_id, active);
    CREATE INDEX IF NOT EXISTS idx_route_points_vehicle_date ON route_points(vehicle_id, event_date, recorded_at);

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
  // Format consistently in Colombia local time (America/Bogota, UTC-5)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hour = map.hour === '24' ? '00' : map.hour;

  return {
    eventDate: `${map.year}-${map.month}-${map.day}`,
    eventTime: `${hour}:${map.minute}:${map.second}`,
    recordedAt: now.toISOString(),
  };
}
