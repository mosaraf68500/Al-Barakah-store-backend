import { Schema, model, models, type Model, type Types } from 'mongoose';

export interface AuditDoc {
  _id: Types.ObjectId;
  actorUserId?: Types.ObjectId;
  actorEmail: string;
  actorRole: string;
  action: string;
  entity: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  status: 'SUCCESS' | 'FAILED';
  createdAt: Date;
}
const schema = new Schema<AuditDoc>(
  {
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorEmail: { type: String, default: 'unknown' },
    actorRole: { type: String, default: 'unknown' },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: String,
    details: Schema.Types.Mixed,
    ip: String,
    userAgent: String,
    status: { type: String, enum: ['SUCCESS', 'FAILED'], default: 'SUCCESS' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ createdAt: -1 });
export const AuditLogModel: Model<AuditDoc> = (models.AuditLog as Model<AuditDoc>) ?? model<AuditDoc>('AuditLog', schema);
