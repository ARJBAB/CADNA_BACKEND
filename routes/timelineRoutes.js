import express from 'express';
import {
  createTimelineEntry,
  getTimelineEntries,
  updateTimelineEntry,
  deleteTimelineEntry,
} from '../controllers/timelineController.js';
import { protect } from '../middleware/AuthMiddleware.js';
import { uploadTimelineImages } from '../middleware/timelineUploadMiddleware.js';

const router = express.Router();

router.post('/', protect, uploadTimelineImages.array('images', 6), createTimelineEntry);
router.get('/', getTimelineEntries);
router.patch('/:id', protect, updateTimelineEntry);
router.delete('/:id', protect, deleteTimelineEntry);

export default router;
