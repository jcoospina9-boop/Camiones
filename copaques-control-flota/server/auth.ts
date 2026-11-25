import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { db } from './db.ts';

const JWT_SECRET =
  process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 16
    ? process.env.JWT_SECRET.trim()
    : crypto.randomBytes(32).toString('hex');

export interface AuthTokenPayload {
  userId: number;
  username: string;
  role: 'CONDUCTOR' | 'GERENCIA';
}

export interface AuthenticatedUser {
  id: number;
  username: string;
  full_name: string;
  role: 'CONDUCTOR' | 'GERENCIA';
  vehicle_id: number | null;
  vehicle_code: string | null;
  vehicle_plate: string | null;
  active: number;
}

export interface AuthedRequest extends Request {
  user?: AuthenticatedUser;
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '16h' });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}

export function getUserById(userId: number): AuthenticatedUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role, u.vehicle_id, u.active,
              v.code AS vehicle_code, v.plate AS vehicle_plate
       FROM users u
       LEFT JOIN vehicles v ON v.id = u.vehicle_id
       WHERE u.id = ?`
    )
    .get(userId) as AuthenticatedUser | undefined;
  return row ?? null;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Sesión requerida. Inicia sesión para continuar.' });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: 'Token de sesión ausente.' });
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

export function requireRole(role: 'CONDUCTOR' | 'GERENCIA') {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Autenticación requerida.' });
      return;
    }
    if (req.user.role !== role) {
      res.status(403).json({ error: 'No tienes permisos para acceder a este módulo.' });
      return;
    }
    next();
  };
}
