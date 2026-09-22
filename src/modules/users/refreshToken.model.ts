import { Schema, model, models, type Model, type Types } from 'mongoose';
import type { Audience } from '../../config/constants';

export interface RefreshTokenDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** sha-256 of the signed refresh JWT (the token itself is never stored) */
  tokenHash: string;
  familyId: string;
  audience: Audience;
  sessionStartedAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  replacedBy?: Types.ObjectId | null;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}
const schema = new Schema<RefreshTokenDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    audience: { type: String, enum: ['customer', 'admin'], required: true },
    sessionStartedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null },
    replacedBy: { type: Schema.Types.ObjectId, default: null },
    ip: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
export const RefreshTokenModel: Model<RefreshTokenDoc> = (models.RefreshToken as Model<RefreshTokenDoc>) ?? model<RefreshTokenDoc>('RefreshToken', schema);
