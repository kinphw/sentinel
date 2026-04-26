import type { NextFunction, Request, Response } from 'express';
import { lookupSession, type AuthenticatedUser } from './AuthService.js';
import { readSessionCookie } from './cookie.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * 모든 보호 라우트 앞에 둔다. 쿠키→세션 조회 후 req.user 주입.
 * 미인증이면 401.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readSessionCookie(req);
    if (!token) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const user = await lookupSession(token);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    req.user = user;
    next();
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}

/**
 * admin 전용 라우트 가드. requireAuth 다음에 둔다.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}
