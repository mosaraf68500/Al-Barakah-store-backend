import type { Request } from 'express';
import type { Types } from 'mongoose';
import { logger } from '../../utils/logger';
import { AuditLogModel } from './audit.model';

export interface AuditEntry {
  actor?: { id?: Types.ObjectId | string; email?: string; role?: string };
  action: string;
  entity: string;
  entityId?: string;
  details?: Record<string, unknown>;
  status?: 'SUCCESS' | 'FAILED';
  req?: Request;
}

const SENSITIVE = /pass|pin|code|token|secret|otp|hash/i;
const redact = (o?: Record<string, unknown>) =>
  o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SENSITIVE.test(k) ? '[REDACTED]' : v]));

/**
 * Append-only audit trail. A failure to write is logged loudly but never turns a successful business action into an error
 * (the audit collection has no update/delete path anywhere in the API).
 */
export async function recordAudit(e: AuditEntry): Promise<void> {
  try {
    await AuditLogModel.create({
      actorUserId: e.actor?.id,
      actorEmail: e.actor?.email ?? 'unknown',
      actorRole: e.actor?.role ?? 'unknown',
      action: e.action,
      entity: e.entity,
      entityId: e.entityId,
      details: redact(e.details),
      status: e.status ?? 'SUCCESS',
      ip: e.req?.ip,
      userAgent: e.req?.get('user-agent')?.slice(0, 300),
    });
  } catch (err) {
    logger.error({ err, action: e.action }, 'AUDIT WRITE FAILED');
  }
}

export async function listAudit(limit = 25) {
  const rows = await AuditLogModel.find().sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), 200)).lean();
  // shape used by the admin app's `AdminAuditLog`
  return rows.map((r) => ({ id: String(r._id), adminEmail: r.actorEmail, adminRole: r.actorRole, action: r.action, status: r.status, timestamp: r.createdAt.toISOString(), deviceInfo: r.userAgent }));
}
