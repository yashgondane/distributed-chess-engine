import React from 'react';
import { Chessboard } from 'react-chessboard';

function GameBoard({ game, onDrop }) {
  return (
    <div className="chessboard-wrapper">
      <Chessboard 
        options={{
          position: game.fen(),
          onPieceDrop: ({ sourceSquare, targetSquare }) =>
            onDrop(sourceSquare, targetSquare),
          boardStyle: {
            borderRadius: '4px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.1)'
          },
          darkSquareStyle: { backgroundColor: '#d0d0d0' },
          lightSquareStyle: { backgroundColor: '#f5f5f5' },
        }}
      />
    </div>
  );
}

export default GameBoard;
