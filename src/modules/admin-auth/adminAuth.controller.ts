import type { Request, Response } from 'express';
import { REFRESH_COOKIE } from '../../config/constants';
import { ApiResponse } from '../../utils/ApiResponse';
import { listAudit } from '../audit/audit.service';
import { toAdminSession } from '../users/user.serializer';
import { assertCsrf, clearRefreshCookie, revokeByRawToken, rotateRefreshToken } from '../users/token.service';
import * as svc from './adminAuth.service';

export const login = async (req: Request, res: Response) => ApiResponse.ok(res, await svc.adminLogin(req.body, req));
export const verifyOtp = async (req: Request, res: Response) => ApiResponse.ok(res, await svc.adminVerifyOtp(req.body, req, res));
export const resendOtp = async (req: Request, res: Response) => {
  await svc.adminResendOtp(req.body.email, req);
  ApiResponse.ok(res, { ok: true });
};

export async function refresh(req: Request, res: Response) {
  assertCsrf(req);
  const r = await rotateRefreshToken(req.cookies?.[REFRESH_COOKIE.admin], 'admin', req, res);
  ApiResponse.ok(res, { accessToken: r.token, expiresIn: r.expiresIn, session: toAdminSession(r.user) });
}
export async function logout(req: Request, res: Response) {
  assertCsrf(req);
  await revokeByRawToken(req.cookies?.[REFRESH_COOKIE.admin]);
  clearRefreshCookie(res, 'admin');
  ApiResponse.noContent(res);
}
export const me = async (req: Request, res: Response) => ApiResponse.ok(res, { session: toAdminSession(req.authUser!) });

export const grantAccess = async (req: Request, res: Response) => ApiResponse.created(res, await svc.grantAccess(req.authUser!, req.body, req));
export const revokeAccess = async (req: Request, res: Response) => {
  await svc.revokeAccess(req.authUser!, req.body.userId, req);
  ApiResponse.noContent(res);
};
export const revokeAccessById = async (req: Request, res: Response) => {
  await svc.revokeAccess(req.authUser!, req.params.id, req);
  ApiResponse.noContent(res);
};
export const setPassword = async (req: Request, res: Response) => {
  await svc.setPassword(req.body, req);
  ApiResponse.noContent(res);
};
export const staff = async (_req: Request, res: Response) => ApiResponse.ok(res, await svc.listStaff());
export const audit = async (req: Request, res: Response) => ApiResponse.ok(res, await listAudit(Number(req.query.limit) || 25));
