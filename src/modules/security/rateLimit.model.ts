import { Schema, model, models, type Model } from 'mongoose';

/** DB-backed fixed-window counters (survive cold starts and are shared by every serverless instance). */
export interface RateLimitDoc { key: string; count: number; resetAt: Date }
const schema = new Schema<RateLimitDoc>({ key: { type: String, required: true, unique: true }, count: { type: Number, default: 0 }, resetAt: { type: Date, required: true, index: true } });
export const RateLimitModel: Model<RateLimitDoc> = (models.RateLimit as Model<RateLimitDoc>) ?? model<RateLimitDoc>('RateLimit', schema);
