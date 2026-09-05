const { Chess } = require('chess.js');

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

function squareIndex(file, rank, color) {
  const f = file.charCodeAt(0) - 97;
  const r = parseInt(rank, 10) - 1;
  const idx = r * 8 + f;
  return color === 'w' ? idx : 63 - idx;
}

function evaluateBoard(board, rootColor) {
  if (board.isCheckmate()) {
    return board.turn() === rootColor ? -20000 : 20000;
  }
  if (board.isDraw()) return 0;

  let score = 0;
  const grid = board.board();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = grid[row][col];
      if (!piece) continue;
      const file = String.fromCharCode(97 + col);
      const rank = String(8 - row);
      const idx = squareIndex(file, rank, piece.color);
      const material = PIECE_VALUES[piece.type];
      const positional = PST[piece.type]?.[idx] ?? 0;
      const value = material + positional;
      score += piece.color === rootColor ? value : -value;
    }
  }
  return score;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function minimax(board, depth, alpha, beta, isMaximizing, rootColor, stats) {
  if (depth === 0 || board.isGameOver()) {
    stats.nodesExplored++;
    return evaluateBoard(board, rootColor);
  }

  const moves = board.moves();
  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const move of moves) {
      board.move(move);
      const evalScore = minimax(board, depth - 1, alpha, beta, false, rootColor, stats);
      board.undo();
      maxEval = Math.max(maxEval, evalScore);
      alpha = Math.max(alpha, evalScore);
      if (beta <= alpha) {
        stats.nodesPruned++;
        break;
      }
    }
    return maxEval;
  }

  let minEval = Infinity;
  for (const move of moves) {
    board.move(move);
    const evalScore = minimax(board, depth - 1, alpha, beta, true, rootColor, stats);
    board.undo();
    minEval = Math.min(minEval, evalScore);
    beta = Math.min(beta, evalScore);
    if (beta <= alpha) {
      stats.nodesPruned++;
      break;
    }
  }
  return minEval;
}

async function searchAssignedMove(fen, move, depth, opts = {}) {
  const board = new Chess(fen);
  const rootColor = board.turn();

  const moveResult = board.move(move);
  if (!moveResult) {
    throw new Error(`Illegal root move: ${move}`);
  }

  if (board.isGameOver()) {
    const score = evaluateBoard(board, rootColor);
    return { score, nodesExplored: 1, nodesPruned: 0 };
  }

  const stats = {
    nodesExplored: 0,
    nodesPruned: 0,
  };

  const remaining = Math.max(0, depth - 1);
  if (remaining === 0) {
    const score = evaluateBoard(board, rootColor);
    if (opts.onBoundImprove) opts.onBoundImprove(score);
    return { score, nodesExplored: 1, nodesPruned: 0 };
  }

  const replies = board.moves();
  let minEval = Infinity;

  for (let i = 0; i < replies.length; i++) {
    board.move(replies[i]);
    const evalScore = minimax(board, remaining - 1, -Infinity, Infinity, true, rootColor, stats);
    board.undo();
    minEval = Math.min(minEval, evalScore);

    if (opts.onProgress) {
      opts.onProgress(stats.nodesExplored);
    }

    const liveGlobalBound =
      typeof opts.getGlobalBound === 'function' ? opts.getGlobalBound() : opts.globalBound;
    if (
      opts.boundSharing &&
      liveGlobalBound != null &&
      Number.isFinite(liveGlobalBound) &&
      minEval < liveGlobalBound
    ) {
      stats.nodesPruned += replies.length - i - 1;
      break;
    }

    await yieldToEventLoop();
  }

  if (!Number.isFinite(minEval)) {
    minEval = evaluateBoard(board, rootColor);
  }

  if (opts.onBoundImprove) {
    opts.onBoundImprove(minEval);
  }

  return {
    score: minEval,
    nodesExplored: stats.nodesExplored,
    nodesPruned: stats.nodesPruned,
  };
}

function getRootMoves(fen) {
  const board = new Chess(fen);
  return board.moves();
}

module.exports = {
  evaluateBoard,
  searchAssignedMove,
  getRootMoves,
};
