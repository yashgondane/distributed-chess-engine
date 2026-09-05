const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Chess } = require('chess.js');
const { initCache, getBestMove } = require('./engine');
const CacheEntry = require('./cache');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;
const MONGO_URI = 'mongodb://localhost:27017/chess_engine';

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('Connected to MongoDB');
    await initCache();
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB', err);
  });

app.post('/move', async (req, res) => {
    const { fen, depth = 3 } = req.body;
    
    if (!fen) {
        return res.status(400).json({ error: 'FEN string is required' });
    }

    try {
        const board = new Chess(fen);
        
        if (board.isGameOver()) {
            return res.json({ gameOver: true });
        }

        // Engine color should be exactly the turn it is right now.
        const engineColor = board.turn(); // 'b' or 'w'

        const startTime = Date.now();
        const result = await getBestMove(board, parseInt(depth), engineColor);
        const timeTaken = Date.now() - startTime;

        res.json({
            engineMove: result.bestMove,
            bestLine: result.bestLine,
            stats: result.stats,
            timeTakenMs: timeTaken
        });
    } catch (error) {
        console.error('Engine error:', error);
        res.status(500).json({ error: 'Engine failed to process move' });
    }
});

app.get('/cache/stats', async (req, res) => {
    try {
        const count = await CacheEntry.countDocuments();
        res.json({ cacheSize: count });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch cache stats' });
    }
});

app.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
});
