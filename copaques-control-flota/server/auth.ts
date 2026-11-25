import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { db } from './db.ts';

const JWT_SECRET =
  process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 16
    ? process.env.JWT_SECRET.trim()
    : crypto.randomBytes(32).toString('hex');

export type UserRole = 'CONDUCTOR' | 'ADMIN' | 'GERENCIA';

export interface AuthTokenPayload {
  userId: number;
  username: string;
  role: UserRole;
}

export interface AuthenticatedUser {
  id: number;
  username: string;
  full_name: string;
  driver_code: string | null;
  role: UserRole;
  sede_id: number | null;
  sede_name: string | null;
  vehicle_id: number | null;
  vehicle_code: string | null;
  vehicle_plate: string | null;
  active: number;
}

export interface AuthedRequest extends Request {
  user?: AuthenticatedUser;
}

export const SESSION_COOKIE_NAME = 'copaques_session';

export function signAuthToken(payload: AuthTokenPayload): string {
  const expiresIn = payload.role === 'CONDUCTOR' ? '180d' : '24h';
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}

export function setSessionCookie(res: Response, token: string, role: UserRole): void {
  const maxAgeSeconds = role === 'CONDUCTOR' ? 180 * 24 * 60 * 60 : 24 * 60 * 60;
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=None; Partitioned`
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`
  );
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

function isSameOriginOrXhr(req: Request): boolean {
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return true;
  }
  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host;
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost === host.split(',')[0].trim()) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

export function getUserById(userId: number): AuthenticatedUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.driver_code, u.role, u.sede_id, u.vehicle_id, u.active,
              s.name AS sede_name,
              v.code AS vehicle_code, v.plate AS vehicle_plate
       FROM users u
       LEFT JOIN sedes s ON s.id = u.sede_id
       LEFT JOIN vehicles v ON v.id = u.vehicle_id
       WHERE u.id = ? AND u.deleted_at IS NULL`
    )
    .get(userId) as AuthenticatedUser | undefined;
  return row ?? null;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  let token = '';
  let fromCookie = false;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SESSION_COOKIE_NAME]) {
      token = cookies[SESSION_COOKIE_NAME];
      fromCookie = true;
    }
  }

  if (!token) {
    res.status(401).json({ error: 'Sesión requerida. Inicia sesión para continuar.' });
    return;
  }

  if (
    fromCookie &&
    (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') &&
    !isSameOriginOrXhr(req)
  ) {
    res.status(403).json({ error: 'Solicitud rechazada por validación de origen.' });
    return;
  }

  try {
    const decoded = verifyAuthToken(token);
    const user = getUserById(decoded.userId);
    if (!user || user.active !== 1) {
      res.status(401).json({ error: 'Usuario inactivo o inexistente.' });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Sesión expirada o inválida. Inicia sesión nuevamente.' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Autenticación requerida.' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'No tienes permisos para acceder a este módulo.' });
      return;
    }
    next();
  };
}
