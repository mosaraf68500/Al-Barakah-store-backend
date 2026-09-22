import { Schema, model, models, type Model, type Types } from 'mongoose';

export interface OtpDoc {
  _id: Types.ObjectId;
  email: string;
  purpose: 'admin_login';
  /** HMAC-SHA256(pepper, email:code) - never the code itself */
  codeHash: string;
  expiresAt: Date;
  consumedAt?: Date | null;
  attempts: number;
  createdAt: Date;
}
const schema = new Schema<OtpDoc>(
  {
    email: { type: String, required: true, lowercase: true, index: true },
    purpose: { type: String, enum: ['admin_login'], default: 'admin_login' },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    consumedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
export const OtpModel: Model<OtpDoc> = (models.Otp as Model<OtpDoc>) ?? model<OtpDoc>('Otp', schema);
