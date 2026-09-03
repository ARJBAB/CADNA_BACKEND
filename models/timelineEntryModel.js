import mongoose from 'mongoose';

const timelineEntrySchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    caption: {
      type: String,
      default: '',
      trim: true,
    },

    images: [{ type: String }], // Cloudinary secure URLs

    imagePublicIds: [{ type: String }], // Cloudinary public_ids, for cleanup on delete

    category: {
      type: String,
      enum: ['exams', 'scholarships', 'jobs', 'community'],
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

timelineEntrySchema.index({ createdAt: -1 });
timelineEntrySchema.index({ category: 1, createdAt: -1 });

const TimelineEntry = mongoose.model('TimelineEntry', timelineEntrySchema);

export default TimelineEntry;
