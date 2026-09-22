import { Schema, model, models, type Model, type Types } from 'mongoose';

/** ONE document (`_id: 'general'`). `config` = non-secret settings; `secrets` = { dottedPath: AES-GCM envelope } (never selected by default). */
export interface SettingsDoc {
  _id: string;
  config: Record<string, unknown>;
  secrets?: Record<string, string>;
  version: number;
  updatedBy?: Types.ObjectId;
  updatedAt: Date;
}
const schema = new Schema<SettingsDoc>(
  {
    _id: { type: String },
    config: { type: Schema.Types.Mixed, default: {} },
    secrets: { type: Schema.Types.Mixed, default: {}, select: false },
    version: { type: Number, default: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: false, updatedAt: true }, minimize: false },
);
export const SettingsModel: Model<SettingsDoc> = (models.Settings as Model<SettingsDoc>) ?? model<SettingsDoc>('Settings', schema);
export const SETTINGS_ID = 'general';
