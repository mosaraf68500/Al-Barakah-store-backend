import type { Response } from 'express';

/** Raw JSON responses (no envelope) - exactly what the storefront/admin already parse (BACKEND_PLAN Q17). */
export const ApiResponse = {
  ok<T>(res: Response, data: T) { return res.status(200).json(data); },
  created<T>(res: Response, data: T) { return res.status(201).json(data); },
  noContent(res: Response) { return res.status(204).end(); },
};
