import { Schema, model, models, type Model } from 'mongoose';

export interface LockoutDoc { key: string; failedCount: number; strikes: number; lockUntil: Date | null; updatedAt: Date }
const schema = new Schema<LockoutDoc>({
  key: { type: String, required: true, unique: true },
  failedCount: { type: Number, default: 0 },
  strikes: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
  updatedAt: { type: Date, default: () => new Date(), index: true },
});
export const LockoutModel: Model<LockoutDoc> = (models.Lockout as Model<LockoutDoc>) ?? model<LockoutDoc>('Lockout', schema);
