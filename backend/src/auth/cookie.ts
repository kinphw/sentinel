import type { Request, Response } from 'express';

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'sentinel_sid';
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'true').toLowerCase() !== 'false';

export function getSessionCookieName(): string {
  return COOKIE_NAME;
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq);
    if (name === COOKIE_NAME) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return null;
}

export function setSessionCookie(res: Response, rawToken: string, expiresAt: Date): void {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response): void {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
