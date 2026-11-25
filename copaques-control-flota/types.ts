export type UserRole = 'CONDUCTOR' | 'ADMIN' | 'GERENCIA';

export type EventType = 'INICIO_JORNADA' | 'FIN_JORNADA' | 'ENTRADA' | 'SALIDA';

export type EventSource = 'MANUAL' | 'GEOCERCA_AUTO';

export type GeofenceCategory =
  | 'Planta'
  | 'Cliente'
  | 'Obra'
  | 'Bodega'
  | 'Proveedor'
  | 'Otro';

export interface Sede {
  id: number;
  name: string;
  code: string;
  latitude: number;
  longitude: number;
  active: number;
}

export interface SedeSummary {
  id: number;
  name: string;
  code: string;
  vehiclesCount: number;
  activeShiftsCount: number;
  eventsTodayCount: number;
  adminsCount: number;
}

export interface User {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
  sede_id: number | null;
  sede_name?: string | null;
  vehicle_id: number | null;
  vehicle_code: string | null;
  vehicle_plate: string | null;
  active: number;
  created_at?: string;
}

export interface Vehicle {
  id: number;
  code: string;
  plate: string;
  brand: string;
  model: string;
  capacity_tons: number;
  sede_id: number | null;
  sede_name?: string;
  active: number;
  created_at: string;
  assigned_user_id?: number | null;
  assigned_driver_name?: string | null;
  assigned_username?: string | null;
}

export interface FleetEvent {
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
  sede_id?: number | null;
  sede_name_snapshot?: string;
  event_type: EventType;
  source: EventSource;
  geofence_id: number | null;
  geofence_name_snapshot: string | null;
  notes: string;
  created_at: string;
}

export interface RoutePoint {
  id: number;
  vehicle_id: number;
  user_id: number;
  event_date: string;
  recorded_at: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
}

export interface PlannedWaypoint {
  lat: number;
  lng: number;
  label?: string;
}

export interface PlannedRoute {
  id: number;
  name: string;
  sede_id: number | null;
  sede_name?: string | null;
  vehicle_id: number | null;
  vehicle_code?: string | null;
  vehicle_plate?: string | null;
  waypoints_json: string;
  distance_km: number;
  created_at: string;
  updated_at: string;
}

export interface Geofence {
  id: number;
  name: string;
  category: GeofenceCategory;
  latitude: number;
  longitude: number;
  radius_meters: number;
  sede_id?: number | null;
  sede_name?: string;
  active: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface DriverStatusResponse {
  hasVehicle: boolean;
  shiftActive: boolean;
  shiftStartedAt: string | null;
  currentGeofence: {
    id: number;
    name: string;
    category: string;
    entered_at?: string | null;
  } | null;
  todayEvents: FleetEvent[];
  activeGeofencesCount: number;
}

export interface FleetVehicleStatus {
  id: number;
  code: string;
  plate: string;
  brand: string;
  model: string;
  capacity_tons: number;
  sede_id: number | null;
  sede_name?: string;
  active: number;
  driver_id: number | null;
  driver_name: string | null;
  driver_username: string | null;
  shiftActive: boolean;
  shiftStartedAt: string | null;
  lastEvent: FleetEvent | null;
  currentGeofence: { name: string; category: string } | null;
}

export interface DashboardResponse {
  today: string;
  scopedSedeId: number | null;
  kpis: {
    totalVehicles: number;
    activeVehiclesCount: number;
    activeDriversCount: number;
    activeShiftsCount: number;
    eventsTodayCount: number;
    entriesTodayCount: number;
    activeGeofencesCount: number;
  };
  sedeSummaries: SedeSummary[];
  recentEvents: FleetEvent[];
  fleetStatus: FleetVehicleStatus[];
}

export interface RouteResponse {
  vehicle: Vehicle & { sede_lat?: number | null; sede_lng?: number | null };
  date: string;
  events: FleetEvent[];
  routePoints: RoutePoint[];
  geofences: Geofence[];
  availableDates: string[];
  summary: {
    totalEvents: number;
    gpsPointsCount: number;
    entriesCount: number;
    exitsCount: number;
    distanceKm: number;
    shiftDurationMinutes: number;
  };
}

export interface ReportAggRow {
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

export interface LocationStayRow {
  vehicleCode: string;
  vehiclePlate: string;
  driverName: string;
  locationName: string;
  entryTime: string;
  exitTime: string | null;
  durationMinutes: number | null;
  date: string;
}

export interface ReportResponse {
  summary: {
    startDate: string;
    endDate: string;
    totalEvents: number;
    totalVisits: number;
    totalShifts: number;
    totalWorkedHours: number;
    totalStayHours: number;
  };
  byVehicle: ReportAggRow[];
  byDriver: ReportAggRow[];
  locationStays: LocationStayRow[];
  events: FleetEvent[];
}

export interface AuditLogEntry {
  id: number;
  actor_user_id: number | null;
  actor_username: string | null;
  actor_name: string | null;
  action: string;
  details: string;
  created_at: string;
}

export function formatEventLabel(type: EventType): string {
  switch (type) {
    case 'INICIO_JORNADA':
      return 'Inicio de Jornada';
    case 'FIN_JORNADA':
      return 'Fin de Jornada';
    case 'ENTRADA':
      return 'Entrada';
    case 'SALIDA':
      return 'Salida';
  }
}

export function formatRoleLabel(role: UserRole): string {
  switch (role) {
    case 'GERENCIA':
      return 'Gerente';
    case 'ADMIN':
      return 'Administrador';
    case 'CONDUCTOR':
      return 'Conductor';
  }
}

export function formatMinutesAsHours(mins: number | null | undefined): string {
  if (mins === null || mins === undefined) return 'En curso';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function getColombiaToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}
