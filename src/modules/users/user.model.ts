import { Schema, model, models, type HydratedDocument, type Model, type Types } from 'mongoose';
import type { Role } from '../../config/constants';

export interface Address { id: string; label?: string; name: string; phone: string; address: string; district: string; isDefault: boolean }

export interface UserDoc {
  _id: Types.ObjectId;
  role: Role;
  name: string;
  email?: string;
  phone?: string;
  phoneKey?: string;
  /** bcrypt hash: customers = the 6-digit PIN, admins = the password. Never serialised. */
  passwordHash?: string | null;
  isActive: boolean;
  /** Bumped to invalidate every outstanding access token immediately (revoke / password change / lock-out). */
  tokenVersion: number;
  avatarUrl?: string;
  addresses: Address[];
  passwordSetTokenHash?: string | null;
  passwordSetExpires?: Date | null;
  legacyUid?: string;
  createdBy?: Types.ObjectId;
  /** Set when an admin's access was revoked (lets a later re-grant recognise the account). */
  revokedAdminAt?: Date | null;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
export type UserDocument = HydratedDocument<UserDoc>;

const addressSchema = new Schema<Address>({ id: String, label: String, name: String, phone: String, address: String, district: String, isDefault: Boolean }, { _id: false });

const schema = new Schema<UserDoc>(
  {
    role: { type: String, enum: ['customer', 'admin', 'super_admin'], default: 'customer', required: true, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: String,
    phoneKey: String,
    passwordHash: { type: String, default: null, select: false },
    isActive: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
    avatarUrl: String,
    addresses: { type: [addressSchema], default: [] },
    passwordSetTokenHash: { type: String, default: null, select: false },
    passwordSetExpires: { type: Date, default: null },
    legacyUid: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    revokedAdminAt: { type: Date, default: null },
    lastLoginAt: Date,
  },
  { timestamps: true },
);
schema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
schema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
schema.index({ phoneKey: 1 });

export const UserModel: Model<UserDoc> = (models.User as Model<UserDoc>) ?? model<UserDoc>('User', schema);
