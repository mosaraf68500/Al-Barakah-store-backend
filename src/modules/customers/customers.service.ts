import type { Request } from 'express';
import { Types } from 'mongoose';
import { ApiError } from '../../utils/ApiError';
import { randomDigits } from '../../utils/crypto';
import { hashSecret } from '../../utils/password';
import { normalizeBdMobile } from '../../utils/phone';
import { recordAudit } from '../audit/audit.service';
import { clearFailures } from '../security';
import { revokeAllForUser } from '../users/token.service';
import { UserModel, type UserDocument } from '../users/user.model';

/**
 * Stop-gap for the missing self-service "forgot PIN" (no SMS gateway): an admin sets a NEW random 6-digit PIN for a customer.
 * The PIN is returned once to the admin (to tell the customer through a support channel) - the backend sends nothing.
 * The PIN is never logged and never written to the audit trail; every existing session of the customer is revoked and any lockout cleared.
 */
export async function resetCustomerPin(actor: UserDocument, target: { userId?: string; phone?: string }, req: Request) {
  const byId = target.userId ? await UserModel.findById(new Types.ObjectId(target.userId)) : null;
  const phone = target.phone ? normalizeBdMobile(target.phone) : null;
  if (target.phone && !phone) throw ApiError.badRequest('INVALID_BD_PHONE');
  const customer = byId ?? (phone ? await UserModel.findOne({ phone }) : null);
  if (!customer || customer.role !== 'customer') throw ApiError.notFound('CUSTOMER_NOT_FOUND'); // admins can never be reset through this route

  const pin = randomDigits(6);
  customer.passwordHash = await hashSecret(pin);
  customer.isActive = true;
  await customer.save();
  await revokeAllForUser(customer._id);
  if (customer.phone) await clearFailures(`customer:${customer.phone.slice(-10)}`);
  await recordAudit({
    actor: { id: actor._id, email: actor.email, role: actor.role },
    action: 'admin.customer.pin_reset',
    entity: 'User',
    entityId: String(customer._id),
    details: { customerPhone: customer.phone?.replace(/^(\d{3})\d+(\d{2})$/, '$1******$2') },
    req,
  });
  return { customerId: String(customer._id), phone: customer.phone, temporaryPin: pin };
}
