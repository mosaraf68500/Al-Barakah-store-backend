import type { Request, Response } from 'express';
import { ApiResponse } from '../../utils/ApiResponse';
import { toCustomerProfile } from '../users/user.serializer';
import { assertCsrf, clearRefreshCookie, readRefreshToken, revokeByRawToken, rotateRefreshToken } from '../users/token.service';
import { addAddress, changeCustomerPin, listAddresses, loginCustomer, loginWithGoogle, registerCustomer, removeAddress, updateAddress, updateCustomerProfile } from './auth.service';

export const register = async (req: Request, res: Response) => ApiResponse.created(res, await registerCustomer(req.body, req, res));
export const login = async (req: Request, res: Response) => ApiResponse.ok(res, await loginCustomer(req.body, req, res));
export const google = async (req: Request, res: Response) => ApiResponse.ok(res, await loginWithGoogle(req.body.idToken, req, res));

export async function refresh(req: Request, res: Response) {
  assertCsrf(req);
  const r = await rotateRefreshToken(readRefreshToken(req, 'customer'), 'customer', req, res);
  ApiResponse.ok(res, { accessToken: r.token, expiresIn: r.expiresIn, refreshToken: r.refreshToken, user: toCustomerProfile(r.user) });
}

export async function logout(req: Request, res: Response) {
  assertCsrf(req);
  await revokeByRawToken(readRefreshToken(req, 'customer'));
  clearRefreshCookie(res, 'customer');
  ApiResponse.noContent(res);
}

export const me = async (req: Request, res: Response) => ApiResponse.ok(res, { user: toCustomerProfile(req.authUser!) });

export const changePin = async (req: Request, res: Response) => ApiResponse.ok(res, await changeCustomerPin(req.authUser!, req.body, readRefreshToken(req, 'customer'), req));

export const updateMe = async (req: Request, res: Response) => ApiResponse.ok(res, { user: await updateCustomerProfile(req.authUser!, req.body, req) });

export const getAddresses = async (req: Request, res: Response) => ApiResponse.ok(res, await listAddresses(req.authUser!));
export const postAddress = async (req: Request, res: Response) => ApiResponse.created(res, await addAddress(req.authUser!, req.body, req));
export const putAddress = async (req: Request, res: Response) => ApiResponse.ok(res, await updateAddress(req.authUser!, req.params.id, req.body, req));
export const deleteAddress = async (req: Request, res: Response) => ApiResponse.ok(res, await removeAddress(req.authUser!, req.params.id, req));
