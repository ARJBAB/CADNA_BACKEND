import asyncHandler from 'express-async-handler';
import TimelineEntry from '../models/timelineEntryModel.js';
import cloudinary from '../config/cloudinary.js';

const CATEGORIES = ['exams', 'scholarships', 'jobs', 'community'];

const formatEntry = (entry) => {
  const author = entry.author || {};
  return {
    id: entry._id.toString(),
    author: {
      id: author._id ? author._id.toString() : null,
      name: `${author.firstName || ''} ${author.lastName || ''}`.trim(),
      avatarUrl: author.avatar || null,
    },
    caption: entry.caption,
    images: entry.images,
    category: entry.category,
    createdAt: entry.createdAt.toISOString(),
  };
};

// @desc    Create a timeline entry
// @route   POST /api/timeline
// @access  Private
export const createTimelineEntry = asyncHandler(async (req, res) => {
  const { caption = '', category } = req.body;
  const files = req.files || [];

  if (!category || !CATEGORIES.includes(category)) {
    return res.status(400).json({
      success: false,
      message: `category is required and must be one of: ${CATEGORIES.join(', ')}`,
    });
  }

  const entry = await TimelineEntry.create({
    author: req.user._id,
    caption,
    category,
    images: files.map((f) => f.path),
    imagePublicIds: files.map((f) => f.filename),
  });

  await entry.populate('author', 'firstName lastName avatar');

  res.status(201).json({
    success: true,
    message: 'Timeline entry created',
    data: formatEntry(entry),
  });
});

// @desc    Get all timeline entries, newest first, optionally filtered by category
// @route   GET /api/timeline
// @access  Private
export const getTimelineEntries = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || null;
  const limit = parseInt(req.query.limit, 10) || null;
  const { category } = req.query;

  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({
      success: false,
      message: `category must be one of: ${CATEGORIES.join(', ')}`,
    });
  }

  const filter = category ? { category } : {};

  let query = TimelineEntry.find(filter)
    .sort({ createdAt: -1 })
    .populate('author', 'firstName lastName avatar');

  if (page && limit) {
    query = query.skip((page - 1) * limit).limit(limit);
  }

  const entries = await query;
  const count = page && limit ? await TimelineEntry.countDocuments(filter) : entries.length;

  res.json({
    success: true,
    data: entries.map(formatEntry),
    count,
  });
});

// @desc    Update a timeline entry's caption/category (author only)
// @route   PATCH /api/timeline/:id
// @access  Private
export const updateTimelineEntry = asyncHandler(async (req, res) => {
  const entry = await TimelineEntry.findById(req.params.id);

  if (!entry) {
    return res.status(404).json({ success: false, message: 'Timeline entry not found' });
  }

  if (entry.author.toString() !== req.user._id.toString()) {
    return res.status(403).json({ success: false, message: 'Not authorized to modify this entry' });
  }

  const { caption, category } = req.body;

  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({
        success: false,
        message: `category must be one of: ${CATEGORIES.join(', ')}`,
      });
    }
    entry.category = category;
  }

  if (caption !== undefined) {
    entry.caption = caption;
  }

  await entry.save();
  await entry.populate('author', 'firstName lastName avatar');

  res.json({
    success: true,
    message: 'Timeline entry updated',
    data: formatEntry(entry),
  });
});

// @desc    Delete a timeline entry (author only)
// @route   DELETE /api/timeline/:id
// @access  Private
export const deleteTimelineEntry = asyncHandler(async (req, res) => {
  const entry = await TimelineEntry.findById(req.params.id);

  if (!entry) {
    return res.status(404).json({ success: false, message: 'Timeline entry not found' });
  }

  if (entry.author.toString() !== req.user._id.toString()) {
    return res.status(403).json({ success: false, message: 'Not authorized to modify this entry' });
  }

  await Promise.all(
    (entry.imagePublicIds || []).map((publicId) =>
      cloudinary.uploader.destroy(publicId).catch((err) =>
        console.error(`Failed to delete Cloudinary image ${publicId}:`, err.message)
      )
    )
  );

  await entry.deleteOne();

  res.json({
    success: true,
    message: 'Timeline entry deleted',
  });
});
