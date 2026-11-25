# Copaques — Documentación Funcional, Técnica y Operativa de Control de Flota

## 1. Documento Funcional Completo

### 1.1 Propósito del Sistema
La plataforma de Control de Flota de **Copaques** es una solución web responsiva de trazabilidad operativa para la distribución de materiales de construcción (diseñada inicialmente para 40 camiones y preparada para escalar a 100+ unidades sin cambios de arquitectura). Permite registrar de manera automática e inmutable la fecha, hora, coordenadas GPS, dirección aproximada, usuario, camión y tipo de evento durante la jornada laboral de cada conductor, y ofrece a la gerencia un panel completo de supervisión, mapas interactivos, geocercas y exportación de reportes.

### 1.2 Roles de Usuario
1. **CONDUCTOR**: Acceso desde teléfono inteligente. Tiene un camión asignado de forma exclusiva. Puede iniciar sesión, iniciar jornada, registrar entradas, registrar salidas, agregar observaciones opcionales, finalizar jornada y consultar sus registros del día. No puede editar ni eliminar fecha, hora, coordenadas, usuario, vehículo ni tipo de evento.
2. **GERENCIA**: Acceso desde computador. Puede administrar vehículos, usuarios conductores y administradores, consultar el dashboard operativo, filtrar el historial permanente, visualizar recorridos diarios sobre el mapa, crear/editar/activar/eliminar geocercas (incluso desde eventos históricos), generar y exportar reportes en PDF y Excel, y gestionar copias de seguridad.

### 1.3 Casos de Uso Principales
- **CU-01 Configuración inicial de Gerencia**: En el primer arranque del sistema sin usuarios previos, el responsable crea la cuenta principal de Gerencia.
- **CU-02 Alta de Flota y Conductores**: Gerencia registra los camiones (`codigo`, `placa`, `marca`, `modelo`, `capacidad`) y crea las cuentas de conductores vinculadas a cada camión.
- **CU-03 Registro de Jornada y Movimientos (Conductor)**: El conductor inicia sesión en su celular, pulsa `Iniciar Jornada`, y durante el día pulsa `Registrar Entrada` o `Registrar Salida` (con observaciones opcionales) y finalmente `Finalizar Jornada`. El navegador captura el GPS real y el servidor sella fecha, hora, dirección y snapshots de usuario/vehículo.
- **CU-04 Detección Automática por Geocerca**: Mientras la jornada está activa, la aplicación envía verificaciones periódicas de posición (`/api/driver/geofence-ping`). Si el camión entra o sale del radio de una geocerca activa, el sistema genera automáticamente un evento `ENTRADA` o `SALIDA` marcado con origen `GEOCERCA_AUTO`.
- **CU-05 Visualización de Recorrido en Mapa**: Gerencia selecciona un camión y una fecha; el mapa Leaflet/OpenStreetMap dibuja la polilínea cronológica, pines numerados por tipo de evento y geocercas activas.
- **CU-06 Creación de Geocerca desde Evento Histórico**: Desde el mapa o la tabla de historial, Gerencia pulsa `Crear geocerca` sobre cualquier evento registrado para prellenar las coordenadas de una nueva geocerca.
- **CU-07 Reportes Gerenciales PDF y Excel**: Gerencia filtra por rango diario, semanal, mensual o personalizado, vehículo o conductor, visualiza visitas, horas trabajadas y tiempo por ubicación, y descarga PDF o `.xlsx`.
- **CU-08 Respaldo y Recuperación**: Gerencia descarga una copia exacta `.db` de SQLite o un archivo `.json` portable y puede restaurar datos incrementalmente.

---

## 2. Arquitectura Recomendada y Justificación Técnica

| Capa | Tecnología Elegida | Justificación (Simplicidad, Costo $0, Mantenimiento, Migración) |
| :--- | :--- | :--- |
| **Backend / API** | Node.js + Express (`server.ts`) | Un solo lenguaje (TypeScript) en servidor y cliente, bajo consumo de RAM (<120 MB para 100 camiones), fácil de mantener por 1 persona y desplegable en cualquier VPS o servicio gratuito. |
| **Base de Datos** | SQLite (`better-sqlite3` en modo WAL) | Costo $0, sin motor externo que administrar ni pagar, soporta lecturas/escrituras concurrentes de 100+ camiones, respaldo instantáneo de un solo archivo (`data/flota.db`). |
| **Frontend** | React + Vite + Tailwind CSS | Interfaz única responsiva: vista móvil ultra simple para conductores y consola de escritorio completa para gerencia, compilada en estáticos servidos por el mismo Express. |
| **Mapas** | Leaflet + OpenStreetMap | 100% gratuito y de código abierto; evita costos recurrentes o cuotas por carga de mapas de plataformas comerciales. |
| **Geocodificación Inversa** | OpenStreetMap Nominatim + Caché en SQLite | Gratuita, consultada desde el servidor y almacenada en `geocode_cache` por cuadrícula (~11 m) para respuestas inmediatas sin saturar el servicio externo. |
| **Reportes** | `jspdf` + `jspdf-autotable` + `xlsx` | Generación directa de PDF y Excel en el navegador sin librerías pesadas en servidor ni costos de licencias. |
| **Seguridad** | `bcryptjs` + JWT (`jsonwebtoken`) + Triggers SQLite | Contraseñas cifradas, autenticación Bearer sin estado en cliente, control estricto por rol e inmutabilidad física de la tabla `events`. |

---

## 3. Diseño de Base de Datos

### 3.1 Diagrama Entidad-Relación (ER)

```text
+----------------+       1:N       +------------------+
|    vehicles    |---------------->|      users       |
+----------------+                 +------------------+
| PK id          |                 | PK id            |
| UQ code        |                 | UQ username      |
| UQ plate       |                 |    password_hash |
|    brand       |                 |    full_name     |
|    model       |                 |    role          |
|    capacity    |                 | FK vehicle_id    |
|    active      |                 |    active        |
+----------------+                 +------------------+
        |                                   |
        | 1:N                               | 1:N
        v                                   v
+-----------------------------------------------------+
|             events (INMUTABLE / APPEND-ONLY)        |
+-----------------------------------------------------+
| PK id                                               |
| UQ event_uuid                                       |
|    event_date, event_time, recorded_at              |
|    latitude, longitude, accuracy_meters, address    |
| FK user_id, vehicle_id                              |
|    username_snapshot, driver_name_snapshot          |
|    vehicle_code_snapshot, vehicle_plate_snapshot    |
|    event_type (INICIO_JORNADA/FIN/ENTRADA/SALIDA)   |
|    source (MANUAL / GEOCERCA_AUTO)                  |
|    geofence_id, geofence_name_snapshot              |
|    notes                                            |
+-----------------------------------------------------+
                                            ^
+----------------+       1:1                |
|   geofences    |<--+                      |
+----------------+   |   +-----------------------+
| PK id          |   +---| driver_geofence_state |
|    name        |       +-----------------------+
|    category    |       | PK/FK vehicle_id      |
|    latitude    |       | FK current_geofence_id|
|    longitude   |       |    entered_at         |
|    radius_m    |       |    last_lat/last_lng  |
|    active      |       +-----------------------+
+----------------+

Tablas auxiliares:
- geocode_cache (PK coord_key, address, cached_at)
- system_audit_log (PK id, actor_user_id, action, details, created_at)
```

### 3.2 Índices y Triggers de Inmutabilidad
- **Índices**: `idx_events_date`, `idx_events_vehicle_date`, `idx_events_user_date`, `idx_events_type`, `idx_geofences_active`, `idx_users_role`.
- **Inmutabilidad**: `trg_events_prevent_update` y `trg_events_prevent_delete` bloquean en el propio motor SQLite cualquier sentencia `UPDATE` o `DELETE` sobre `events`.

---

## 4. Flujo de Usuarios y Wireframes

### 4.1 Flujo del Conductor
1. Abre la web en su celular e inicia sesión con su usuario y contraseña.
2. Verifica que el GPS esté activo y pulsa **Iniciar Jornada**.
3. Al llegar a planta, proveedor, bodega, obra o cliente pulsa **Registrar Entrada** (o se registra automáticamente al entrar en geocerca activa).
4. Opcionalmente elige una etiqueta rápida u observación escrita antes de registrar.
5. Al salir del punto pulsa **Registrar Salida**.
6. Al terminar el día pulsa **Finalizar Jornada** y confirma.

### 4.2 Wireframes
Ver sección integrada en el módulo **Respaldos y Docs** dentro del Panel de Gerencia para visualización gráfica directa junto al sistema en vivo.

---

## 5. Estructura de Carpetas

```text
/
├── data/                   # Base de datos SQLite (flota.db, generada en ejecución)
├── docs/                   # Documentación completa del proyecto
├── scripts/                # Scripts de respaldo automático (backup.sh)
├── server/
│   ├── auth.ts             # JWT Bearer y middleware de roles
│   ├── db.ts               # Esquema SQLite, índices, triggers y Haversine
│   └── geocode.ts          # Geocodificación inversa Nominatim con caché SQLite
├── src/
│   ├── components/
│   │   ├── AdminLayout.tsx
│   │   ├── DocsAndBackupView.tsx
│   │   ├── DriverApp.tsx
│   │   ├── FleetUsersView.tsx
│   │   ├── GeofencesView.tsx
│   │   ├── LoginScreen.tsx
│   │   ├── ReportsView.tsx
│   │   └── RouteMapView.tsx
│   ├── lib/
│   │   ├── api.ts
│   │   └── exportReports.ts
│   ├── App.tsx
│   ├── index.css
│   ├── main.tsx
│   └── types.ts
├── server.ts               # Servidor Express + API REST + Vite/Static
├── package.json
└── .env.example
```

---

## 6. Manuales Operativos

### 6.1 Manual de Instalación Local
1. Instalar **Node.js 22 LTS** o superior.
2. Instalar dependencias: `npm install`
3. Copiar `.env.example` a `.env` y opcionalmente definir `JWT_SECRET` (mínimo 32 caracteres aleatorios) y `ADMIN_PASSWORD`.
4. Ejecutar en desarrollo: `npm run dev` (puerto `3000`).

### 6.2 Manual de Despliegue (Costo Cero / Mínimo)
1. Compilar el frontend: `npm run build`
2. Iniciar el servidor productivo: `NODE_ENV=production PORT=3000 npm start`
3. **Importante para GPS móvil**: Publicar detrás de HTTPS (Caddy, Nginx + Certbot, o plataforma PaaS con TLS automático). Los navegadores móviles bloquean `navigator.geolocation` en orígenes HTTP no seguros (excepto `localhost`).
4. Para operar en un VPS económico ($4–$5/mes) o servidor Linux en oficina, usar `pm2 start "npm start" --name controlflota` o un servicio `systemd`.

### 6.3 Manual de Respaldo y Recuperación
- **Manual desde la web**: Panel de Gerencia → `Respaldos y Docs` → `Descargar .db` o `Descargar .json`.
- **Automático en servidor**: Programar `./scripts/backup.sh` diariamente en `crontab` (`0 2 * * *`). Realiza backup en caliente sin detener la operación y retiene los últimos 30 días.
- **Recuperación**: Restaurar `data/flota.db` con el servicio detenido o usar `Restaurar desde .json` en la interfaz de Gerencia para importación incremental segura.

### 6.4 Manual de Actualización
1. Generar respaldo de `data/flota.db`.
2. Descargar la nueva versión del código (`git pull`).
3. Ejecutar `npm install` y `npm run build`.
4. Reiniciar el proceso (`pm2 restart controlflota` o `systemctl restart controlflota`).

### 6.5 Manual de Migración (SQLite → PostgreSQL)
Si la flota creciera por encima de varios cientos de camiones simultáneos con escritura intensiva por segundo:
1. Exportar datos vía `.json` o `pgloader data/flota.db postgresql://...`.
2. Reemplazar únicamente el adaptador en `server/db.ts` manteniendo exactamente las mismas tablas, índices y contratos REST (`/api/*`), sin modificar la aplicación de conductores ni el panel de gerencia.

### 6.6 Recomendaciones de Seguridad
- Mantener HTTPS obligatorio en producción.
- Configurar `JWT_SECRET` largo y único en `.env` en producción.
- Asignar contraseñas individuales por conductor y desactivar de inmediato cuentas de conductores que dejen la empresa (el historial permanece intacto gracias a los snapshots).
- Guardar copias externas de `data/flota.db` semanalmente fuera del servidor principal (nube privada o disco externo).
