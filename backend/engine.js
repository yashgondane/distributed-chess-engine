const { Chess } = require('chess.js');
const CacheEntry = require('./cache');

// Memory map for transposition table to allow fast synchronous lookups during minimax.
// This will be initialized from MongoDB.
let transpositionTable = new Map();

// Initialize the memory cache from MongoDB
async function initCache() {
    const entries = await CacheEntry.find({});
    for (let entry of entries) {
        transpositionTable.set(entry.boardString, { score: entry.score, depth: entry.depth });
    }
    console.log(`Loaded ${entries.length} entries from MongoDB cache.`);
}

// Function: evaluateBoard(board, engineColor)
// What it does: Assigns a numeric score to the current board state based on piece values.
// What it returns: A single numeric score. Positive score favors the engine, negative favors the player.
function evaluateBoard(board, engineColor) {
    if (board.isCheckmate()) {
        // If engine's turn to move and checkmated, engine lost
        return board.turn() === engineColor ? -10000 : 10000;
    }
    if (board.isDraw()) return 0;
    
    const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 1000 };
    let score = 0;
    
    // board.board() returns 2D array of the board
    const b = board.board();
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const piece = b[row][col];
            if (piece) {
                const val = values[piece.type];
                if (piece.color === engineColor) {
                    score += val; // Engine pieces add to score
                } else {
                    score -= val; // Player pieces subtract from score
                }
            }
        }
    }
    return score;
}

// Function: generateMoves(board)
// What it does: Returns all legal moves for the current player's turn.
// What it returns: An array of string move notation (e.g. ['e4', 'Nf3', ...]).
function generateMoves(board) {
    return board.moves();
}

// Function: minimax(board, depth, alpha, beta, isMaximizing, engineColor, stats)
// What it does: Recursive minimax with alpha-beta pruning. Evaluates game states up to the given depth limit.
// Checks the transposition table (cache) to avoid re-evaluating known positions.
// What it returns: An object containing { score, line } where line is the principal variation of moves.
function minimax(board, depth, alpha, beta, isMaximizing, engineColor, stats) {
    // Generate a FEN string for cache lookup (we strip off move counts to generalize the board state)
    const boardString = board.fen().split(' ').slice(0, 4).join(' ');
    
    // Check Cache
    if (transpositionTable.has(boardString)) {
        const cached = transpositionTable.get(boardString);
        if (cached.depth >= depth) {
            stats.cacheHits++;
            // We just return the score, for best line we'll just return early. 
            // In a more complex engine, we'd cache the best move too.
            return { score: cached.score, line: [] };
        }
    }

    if (depth === 0 || board.isGameOver()) {
        stats.nodesExplored++;
        const score = evaluateBoard(board, engineColor);
        return { score, line: [] };
    }
    
    const moves = generateMoves(board);
    let bestLine = [];

    if (isMaximizing) {
        let maxEval = -Infinity;
        for (let move of moves) {
            board.move(move);
            let result = minimax(board, depth - 1, alpha, beta, false, engineColor, stats);
            board.undo();
            
            if (result.score > maxEval) {
                maxEval = result.score;
                bestLine = [move, ...result.line];
            }
            alpha = Math.max(alpha, result.score);
            if (beta <= alpha) {
                stats.nodesPruned++;
                break;
            }
        }
        
        // Save to cache
        transpositionTable.set(boardString, { score: maxEval, depth });
        stats.newCacheEntries.push({ boardString, score: maxEval, depth });

        return { score: maxEval, line: bestLine };
    } else {
        let minEval = Infinity;
        for (let move of moves) {
            board.move(move);
            let result = minimax(board, depth - 1, alpha, beta, true, engineColor, stats);
            board.undo();
            
            if (result.score < minEval) {
                minEval = result.score;
                bestLine = [move, ...result.line];
            }
            beta = Math.min(beta, result.score);
            if (beta <= alpha) {
                stats.nodesPruned++;
                break;
            }
        }
        
        // Save to cache
        transpositionTable.set(boardString, { score: minEval, depth });
        stats.newCacheEntries.push({ boardString, score: minEval, depth });

        return { score: minEval, line: bestLine };
    }
}

// Function: getBestMove(board, depthLimit, engineColor)
// What it does: Starts the minimax recursion to find the best move for the engine.
// What it returns: An object containing { bestMove, bestLine, stats, score }
async function getBestMove(board, depthLimit = 3, engineColor = 'b') {
    const stats = {
        nodesExplored: 0,
        nodesPruned: 0,
        cacheHits: 0,
        newCacheEntries: [] // To be saved asynchronously
    };

    const moves = generateMoves(board);
    let bestMove = null;
    let bestLine = [];
    let bestScore = -Infinity; // Engine is always looking for positive scores because evaluateBoard is engine-relative.
    
    // Alpha and Beta bounds
    let alpha = -Infinity;
    let beta = Infinity;

    for (let move of moves) {
        board.move(move);
        // Next level is minimizing for the player
        let result = minimax(board, depthLimit - 1, alpha, beta, false, engineColor, stats);
        board.undo();

        if (result.score > bestScore) {
            bestScore = result.score;
            bestMove = move;
            bestLine = [move, ...result.line];
        }
        alpha = Math.max(alpha, result.score);
    }
    
    // Asynchronously save new cache entries to MongoDB
    if (stats.newCacheEntries.length > 0) {
        // Bulk write to avoid blocking and duplicate key errors
        const bulkOps = stats.newCacheEntries.map(entry => ({
            updateOne: {
                filter: { boardString: entry.boardString },
                update: { $set: { score: entry.score, depth: entry.depth } },
                upsert: true
            }
        }));
        // Fire and forget
        CacheEntry.bulkWrite(bulkOps, { ordered: false }).catch(err => {
            console.error('Failed to save to MongoDB:', err.message);
        });
    }

    // Default move if none found (e.g. checkmate or stalemate edge cases)
    if (!bestMove && moves.length > 0) {
        bestMove = moves[0];
    }

    return {
        bestMove,
        bestLine,
        stats: {
            nodesExplored: stats.nodesExplored,
            nodesPruned: stats.nodesPruned,
            cacheHits: stats.cacheHits,
            score: bestScore
        }
    };
}

module.exports = {
    initCache,
    evaluateBoard,
    generateMoves,
    minimax,
    getBestMove
};
