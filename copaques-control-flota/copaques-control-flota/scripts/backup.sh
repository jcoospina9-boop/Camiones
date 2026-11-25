#!/usr/bin/env bash
set -euo pipefail

# Script de respaldo automático diario para Copaques — Control de Flota (SQLite en modo WAL)
# Uso recomendado en cron: 0 2 * * * /ruta/al/proyecto/scripts/backup.sh

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_FILE="${PROJECT_DIR}/data/flota.db"
BACKUP_DIR="${PROJECT_DIR}/backups"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
TARGET_FILE="${BACKUP_DIR}/copaques_flota_${STAMP}.db"

if [ ! -f "${DB_FILE}" ]; then
  echo "Error: No se encontró la base de datos en ${DB_FILE}" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${DB_FILE}" ".backup '${TARGET_FILE}'"
else
  node -e "
    const Database = require('better-sqlite3');
    const db = new Database('${DB_FILE}', { readonly: true });
    db.backup('${TARGET_FILE}').then(() => {
      db.close();
      process.exit(0);
    }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  "
fi

echo "Respaldo generado correctamente: ${TARGET_FILE}"

# Retención automática de los últimos 30 días
find "${BACKUP_DIR}" -name "copaques_flota_*.db" -type f -mtime +30 -delete
