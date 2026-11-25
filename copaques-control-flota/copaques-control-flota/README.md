# Copaques — Control de Flota GPS y Trazabilidad

Sistema web unificado para gestión y control de flota de camiones (**Gerencia** y **Conductores**).

## Despliegue rápido en GitHub + Railway

1. **Subir a GitHub:**
   - Crea un repositorio nuevo en GitHub.
   - Descomprime `copaques-control-flota.zip`.
   - Abre la carpeta extraída y sube **todo su contenido directamente a la raíz** del repositorio (debes ver `package.json`, `Dockerfile` y `railway.json` en el nivel principal, no dentro de otra carpeta).

2. **Conectar en Railway:**
   - Crea un proyecto → **Deploy from GitHub repo** → elige tu repositorio.
   - Railway detectará automáticamente `railway.json` y `Dockerfile` (Node 22 + SQLite).

3. **Almacenamiento permanente (Volume):**
   - En el servicio dentro de Railway → clic derecho o **Settings** → **Add Volume**.
   - **Mount Path:** `/app/data`

4. **Variables de entorno (Variables):**
   - `JWT_SECRET` = clave secreta larga (mínimo 32 caracteres)
   - `DATA_DIR` = `/app/data`

5. **Dominio HTTPS (Networking):**
   - En **Settings → Networking → Public Networking** → **Generate Domain**.
   - Abre el enlace resultante para crear la cuenta inicial de **Gerencia**, registrar los camiones/conductores y compartir la misma URL por WhatsApp a los choferes.
