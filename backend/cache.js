const mongoose = require('mongoose');

const CacheEntrySchema = new mongoose.Schema({
  boardString: {
    type: String,
    required: true,
    index: true,
    unique: true
  },
  score: {
    type: Number,
    required: true
  },
  depth: {
    type: Number,
    required: true
  }
});

module.exports = mongoose.model('CacheEntry', CacheEntrySchema);
