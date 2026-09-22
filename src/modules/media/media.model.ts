import { Schema, model, models, type Model, type Types } from 'mongoose';

export interface MediaDoc {
  _id: Types.ObjectId;
  publicId: string;
  url: string;
  secureUrl: string;
  resourceType: string;
  format?: string;
  bytes?: number;
  width?: number;
  height?: number;
  folder: string;
  uploadedBy?: Types.ObjectId;
  createdAt: Date;
}
const schema = new Schema<MediaDoc>(
  {
    publicId: { type: String, required: true, unique: true },
    url: { type: String, required: true },
    secureUrl: { type: String, required: true },
    resourceType: { type: String, default: 'image' },
    format: String,
    bytes: Number,
    width: Number,
    height: Number,
    folder: { type: String, required: true, index: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
export const MediaModel: Model<MediaDoc> = (models.Media as Model<MediaDoc>) ?? model<MediaDoc>('Media', schema);
