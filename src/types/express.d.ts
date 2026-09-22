import type { UserDocument } from '../modules/users/user.model';

declare global {
  namespace Express {
    interface Request {
      /** Set by `authenticate()` after the access token, the user record, `isActive` and `tokenVersion` were all verified. */
      authUser?: UserDocument;
    }
  }
}
export {};
