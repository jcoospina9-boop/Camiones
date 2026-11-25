import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { BookOpen, Database, Download, FileArchive, ShieldCheck, Upload } from 'lucide-react';
import { apiDownload, apiFetch } from '../lib/api.ts';
import type { AuditLogEntry } from '../types.ts';

export function DocsAndBackupView() {
  const [subTab, setSubTab] = useState<'backup' | 'docs'>('backup');
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAudit = useCallback(async () => {
    try {
      const res = await apiFetch<{ logs: AuditLogEntry[] }>('/api/admin/audit');
      setLogs(res.logs);
    } catch {
      // ignore if empty
    }
  }, []);

  useEffect(() => {
    loadAudit();
  }, [loadAudit]);

  async function handleExport(format: 'sqlite' | 'json') {
    setBusy(true);
    setStatusMsg(null);
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      await apiDownload(
        `/api/admin/backup/export?format=${format}`,
        format === 'sqlite'
          ? `copaques_respaldo_${stamp}.db`
          : `copaques_respaldo_${stamp}.json`
      );
      setStatusMsg({
        type: 'ok',
        text: `Respaldo ${format.toUpperCase()} descargado correctamente.`,
      });
      await loadAudit();
    } catch (err) {
      setStatusMsg({
        type: 'err',
        text: err instanceof Error ? err.message : 'Error al exportar respaldo.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleDownloadProject() {
    setBusy(true);
    setStatusMsg(null);
    try {
      await apiDownload('/api/admin/export-project', 'copaques-control-flota.zip');
      setStatusMsg({
        type: 'ok',
        text: 'Paquete completo copaques-control-flota.zip descargado. Listo para subir a GitHub o Railway.',
      });
      await loadAudit();
    } catch (err) {
      setStatusMsg({
        type: 'err',
        text: err instanceof Error ? err.message : 'No se pudo descargar el proyecto.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleRestoreFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await apiFetch<{
        ok: boolean;
        restored: { vehicles: number; geofences: number; events: number };
      }>('/api/admin/backup/restore', {
        method: 'POST',
        body: JSON.stringify(json),
      });
      setStatusMsg({
        type: 'ok',
        text: `Restauración completada: +${res.restored.vehicles} vehículos, +${res.restored.geofences} geocercas, +${res.restored.events} eventos incorporados.`,
      });
      await loadAudit();
    } catch (err) {
      setStatusMsg({
        type: 'err',
        text: err instanceof Error ? err.message : 'El archivo de respaldo JSON no es válido.',
      });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setSubTab('backup')}
          className={`px-4 py-1.5 rounded-md text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
            subTab === 'backup'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Database className="w-4 h-4" />
          <span>Respaldos y Auditoría</span>
        </button>
        <button
          type="button"
          onClick={() => setSubTab('docs')}
          className={`px-4 py-1.5 rounded-md text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
            subTab === 'docs'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <BookOpen className="w-4 h-4" />
          <span>Documentación Técnica y Manuales</span>
        </button>
      </div>

      {subTab === 'backup' ? (
        <div className="space-y-5">
          {statusMsg && (
            <div
              className={`p-3.5 rounded-lg border text-sm font-medium ${
                statusMsg.type === 'ok'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              {statusMsg.text}
            </div>
          )}

          <div className="bg-emerald-950 text-white border border-emerald-900 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="max-w-2xl">
              <h3 className="text-base font-bold text-white">
                Descargar Paquete Completo para Despliegue (.zip)
              </h3>
              <p className="mt-1 text-xs text-emerald-100/85 leading-relaxed">
                Descarga todo el código fuente de Copaques listo para subir a GitHub, Railway o un servidor propio (sin secretos ni base de datos local).
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={handleDownloadProject}
              className="h-10 px-4 rounded-lg bg-yellow-400 hover:bg-yellow-300 text-emerald-950 text-xs font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              <FileArchive className="w-4 h-4" />
              <span>Descargar Proyecto (.zip)</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">Respaldo Base SQLite (.db)</h3>
                <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
                  Descarga una copia exacta en caliente de toda la base de datos SQLite (vehículos, usuarios, geocercas y eventos históricos).
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleExport('sqlite')}
                className="mt-4 h-10 px-4 rounded-lg bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <Download className="w-4 h-4" />
                <span>Descargar .db</span>
              </button>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">Respaldo Portable (.json)</h3>
                <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
                  Exporta todas las tablas en formato JSON estándar legible, ideal para archivo externo o migración hacia otro servidor.
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleExport('json')}
                className="mt-4 h-10 px-4 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <Download className="w-4 h-4" />
                <span>Descargar .json</span>
              </button>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">Recuperación Incremental</h3>
                <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
                  Importa un archivo .json de respaldo previo. Incorpora registros faltantes sin sobrescribir ni borrar eventos existentes.
                </p>
              </div>
              <label className="mt-4 h-10 px-4 rounded-lg bg-yellow-400 hover:bg-yellow-300 text-emerald-950 text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer border border-yellow-500/40">
                <Upload className="w-4 h-4" />
                <span>Restaurar desde .json</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={handleRestoreFile}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-slate-700" />
              <h3 className="text-sm font-bold text-slate-900">Bitácora de Auditoría del Sistema</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 px-4">Fecha / Hora</th>
                    <th className="py-2.5 px-4">Responsable</th>
                    <th className="py-2.5 px-4">Acción</th>
                    <th className="py-2.5 px-4">Detalle</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {logs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-slate-500">
                        Sin registros de auditoría aún.
                      </td>
                    </tr>
                  ) : (
                    logs.map((l) => (
                      <tr key={l.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-4 font-mono tabular-nums text-xs text-slate-500 whitespace-nowrap">
                          {l.created_at.slice(0, 19).replace('T', ' ')}
                        </td>
                        <td className="py-2.5 px-4 text-slate-800">
                          {l.actor_name || l.actor_username || 'Sistema'}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-xs font-semibold text-slate-700">
                          {l.action}
                        </td>
                        <td className="py-2.5 px-4 text-xs text-slate-600">{l.details}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-8 max-w-5xl">
          <section className="space-y-2">
            <h2 className="text-2xl font-bold text-slate-900">
              Copaques — Documentación Maestra de Arquitectura, Base de Datos y Operación
            </h2>
            <p className="text-sm text-slate-600 leading-relaxed">
              Especificación integral del sistema de flota de Copaques diseñada para operar flotas de 40 a 100+ camiones distribuidores de materiales de construcción con costo operativo mínimo, cero dependencia de licencias pagas y portabilidad total.
            </p>
          </section>

          <section className="space-y-3 pt-4 border-t border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">1. Arquitectura Recomendada y Justificación Técnica</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-slate-700">
              <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                <p className="font-bold text-slate-900">Backend Monolítico Modular: Node.js + Express</p>
                <p className="text-xs leading-relaxed">
                  Un único proceso sirve tanto la API REST (/api/*) como la aplicación web compilada. Cero microservicios innecesarios, fácil de mantener por una sola persona y compatible con cualquier VPS Linux, Railway, Render o servidor local de oficina.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                <p className="font-bold text-slate-900">Base de Datos: SQLite (modo WAL)</p>
                <p className="text-xs leading-relaxed">
                  Costo $0, cero servidor de BD que administrar y copias de seguridad de un solo archivo (data/flota.db). Con WAL activado soporta fácilmente cientos de camiones enviando eventos concurrentes y millones de registros históricos.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                <p className="font-bold text-slate-900">Mapas y Geocodificación: Leaflet + OpenStreetMap + Nominatim</p>
                <p className="text-xs leading-relaxed">
                  Alternativa 100% gratuita y open-source frente a Google Maps Platform (sin tarjetas ni cobros por carga de mapas). Las direcciones aproximadas se cachean en SQLite (geocode_cache) para reducir consultas externas y acelerar respuestas.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                <p className="font-bold text-slate-900">Seguridad e Inmutabilidad</p>
                <p className="text-xs leading-relaxed">
                  Contraseñas cifradas con bcrypt, autenticación por tokens JWT Bearer, separación estricta de roles CONDUCTOR/GERENCIA y triggers SQLite (BEFORE UPDATE / BEFORE DELETE) que impiden alterar o borrar eventos históricos.
                </p>
              </div>
            </div>
          </section>

          <section className="space-y-3 pt-4 border-t border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">2. Modelo de Datos y Diagrama Entidad-Relación</h3>
            <div className="overflow-x-auto border border-slate-200 rounded-lg p-4 bg-slate-50">
              <pre className="text-xs font-mono text-slate-800 leading-relaxed">{`+----------------+       1:N       +------------------+
|    vehicles    |---------------->|      users       |
+----------------+                 +------------------+
| PK id          |                 | PK id            |
| UQ code        |                 | UQ username      |
| UQ plate       |                 |    password_hash |
|    brand/model |                 |    full_name     |
|    capacity    |                 |    role          |
|    active      |                 | FK vehicle_id    |
+----------------+                 +------------------+
        |                                   |
        | 1:N                               | 1:N
        v                                   v
+-----------------------------------------------------+
|             events (INMUTABLE / APPEND-ONLY)        |
+-----------------------------------------------------+
| PK id, UQ event_uuid                                |
|    event_date, event_time, recorded_at              |
|    latitude, longitude, accuracy_meters, address    |
|    event_type (INICIO/FIN/ENTRADA/SALIDA)           |
|    source (MANUAL / GEOCERCA_AUTO)                  |
|    snapshots (driver, vehicle, geofence)            |
|    notes                                            |
+-----------------------------------------------------+
        ^
        | N:1 (referencia lógica por geofence_id)
+----------------+       1:1       +-----------------------+
|   geofences    |<----------------| driver_geofence_state |
+----------------+                 +-----------------------+
| PK id          |                 | PK/FK vehicle_id      |
|    name        |                 | FK current_geofence_id|
|    category    |                 |    entered_at         |
|    lat/lng     |                 |    last_lat/last_lng  |
|    radius_m    |                 +-----------------------+
+----------------+`}</pre>
            </div>
            <p className="text-xs text-slate-600">
              Índices activos: <code className="font-mono">idx_events_date</code>, <code className="font-mono">idx_events_vehicle_date</code>, <code className="font-mono">idx_events_user_date</code>, <code className="font-mono">idx_events_type</code>, <code className="font-mono">idx_geofences_active</code>, <code className="font-mono">idx_users_role</code>.
            </p>
          </section>

          <section className="space-y-3 pt-4 border-t border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">3. Casos de Uso, Flujo Operativo y Wireframes</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono text-slate-700">
              <div className="border border-slate-200 rounded-lg p-4 bg-slate-50">
                <p className="font-sans font-bold text-sm text-slate-900 mb-2">
                  Wireframe App Conductor (Móvil)
                </p>
                <pre className="leading-snug">{`+------------------------------------+
| [CAM-01 · ABC-123]         [Salir] |
+------------------------------------+
| Estado: JORNADA ACTIVA    03:42:15 |
| GPS listo (±12 m) · [Actualizar]   |
+------------------------------------+
|  [ REGISTRAR ENTRADA ]  (Verde)    |
|  [ REGISTRAR SALIDA  ]  (Ámbar)    |
|                                    |
|  Observaciones: [Carga][Obra][...] |
|  [ Campo texto opcional          ] |
|                                    |
|  [ FINALIZAR JORNADA ]  (Rojo)     |
+------------------------------------+
| Historial de Hoy                   |
| 08:02 Inicio Jornada · Planta Sur  |
| 09:15 Entrada · Obra Centro        |
+------------------------------------+`}</pre>
              </div>

              <div className="border border-slate-200 rounded-lg p-4 bg-slate-50">
                <p className="font-sans font-bold text-sm text-slate-900 mb-2">
                  Wireframe Panel Gerencia (Escritorio)
                </p>
                <pre className="leading-snug">{`+----------+----------------------------------+
| Control  | [Camiones][Jornadas][Eventos]    |
| Flota    +----------------------------------+
|          | Filtros: [Vehículo v] [Fecha]    |
| - Dash   +----------------------+-----------+
| - Mapa   |                      | Secuencia |
| - Hist.  |   Mapa Leaflet OSM   | 1. Inicio |
| - Geoc.  |   Ruta + Geocercas   | 2. Entr.  |
| - Rep.   |   + Pines numerados  | 3. Salida |
| - Flota  |                      | [Crear GF]|
| - Resp.  +----------------------+-----------+
+----------+----------------------------------+`}</pre>
              </div>
            </div>
          </section>

          <section className="space-y-3 pt-4 border-t border-slate-200 text-xs text-slate-700 leading-relaxed">
            <h3 className="text-lg font-bold text-slate-900">
              4. Manuales de Instalación, Despliegue, Respaldo y Migración
            </h3>
            <ul className="space-y-2 list-disc pl-5">
              <li>
                <strong>Instalación local:</strong> Instalar Node.js 22+, ejecutar <code className="font-mono">npm install</code>, configurar <code className="font-mono">.env</code> (opcional <code className="font-mono">JWT_SECRET</code> y <code className="font-mono">ADMIN_PASSWORD</code>) e iniciar con <code className="font-mono">npm run dev</code> (puerto 3000).
              </li>
              <li>
                <strong>Despliegue en producción (costo mínimo/cero):</strong> Ejecutar <code className="font-mono">npm run build</code> y luego <code className="font-mono">NODE_ENV=production npm start</code> detrás de Nginx/Caddy con HTTPS obligatorio (el GPS del navegador requiere HTTPS en producción).
              </li>
              <li>
                <strong>Respaldo diario:</strong> Desde esta misma pantalla descargar <code className="font-mono">.db</code> o programar <code className="font-mono">sqlite3 data/flota.db ".backup '/backups/flota_$(date +%F).db'"</code> vía cron.
              </li>
              <li>
                <strong>Actualización sin pérdida:</strong> Detener el servicio, respaldar <code className="font-mono">data/flota.db</code>, actualizar código fuente (<code className="font-mono">git pull &amp;&amp; npm install &amp;&amp; npm run build</code>) y reiniciar.
              </li>
              <li>
                <strong>Migración a PostgreSQL (si supera 500+ camiones):</strong> Exportar mediante el respaldo JSON o <code className="font-mono">pgloader</code> manteniendo intacto el esquema relacional y la API REST sin reescribir la app móvil ni el panel.
              </li>
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
