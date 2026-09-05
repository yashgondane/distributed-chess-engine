import React, { useState, useEffect, useCallback } from 'react';
import { Chess } from 'chess.js';
import { io } from 'socket.io-client';
import axios from 'axios';
import GameBoard from './components/GameBoard';
import MasterTable from './components/MasterTable';
import BoundLog from './components/BoundLog';
import ComparisonChart from './components/ComparisonChart';
import './App.css';

const BACKEND_URL = 'http://localhost:3001';

function App() {
  const [game, setGame] = useState(new Chess());
  const [history, setHistory] = useState([]);
  const [depth, setDepth] = useState(3);
  const [boundSharing, setBoundSharing] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [isComparing, setIsComparing] = useState(false);
  const [workerCount, setWorkerCount] = useState(0);
  const [tableRows, setTableRows] = useState([]);
  const [bestMove, setBestMove] = useState(null);
  const [boundEvents, setBoundEvents] = useState([]);
  const [comparisonData, setComparisonData] = useState(null);
  const [searchError, setSearchError] = useState(null);

  const fetchWorkers = useCallback(async () => {
    try {
      const res = await axios.get(`${BACKEND_URL}/workers`);
      setWorkerCount(res.data.count);
    } catch {
      setWorkerCount(0);
    }
  }, []);

  useEffect(() => {
    fetchWorkers();
    const interval = setInterval(fetchWorkers, 3000);

    const socket = io(`${BACKEND_URL}/progress`);

    socket.on('progress', (data) => {
      setTableRows((prev) => {
        const idx = prev.findIndex((r) => r.workerId === data.workerId && r.move === data.move);
        const row = {
          workerId: data.workerId,
          move: data.move,
          score: data.score ?? null,
          nodesExploredSoFar: data.nodesExploredSoFar,
          timeMs: null,
          status: data.status,
        };
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], ...row };
          return next;
        }
        return [...prev, row];
      });
    });

    socket.on('search_complete', ({ bestMove: move, table }) => {
      setBestMove(move);
      setTableRows(
        table.map((r) => ({
          workerId: r.workerId,
          move: r.move,
          score: r.score,
          nodesExplored: r.nodesExplored,
          nodesExploredSoFar: r.nodesExplored,
          timeMs: r.timeMs,
          status: r.status ?? 'complete',
        }))
      );
      setIsSearching(false);
      setIsComparing(false);
    });

    socket.on('bound_event', (evt) => {
      setBoundEvents((prev) => [
        ...prev,
        { ...evt, deliveries: [] },
      ]);
    });

    socket.on('bound_delivery', (d) => {
      setBoundEvents((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].value === d.value && next[i].fromWorker === d.fromWorker) {
            next[i] = {
              ...next[i],
              deliveries: [
                ...next[i].deliveries,
                { workerId: d.workerId, receivedTs: d.receivedTs, delayMs: d.delayMs },
              ],
            };
            break;
          }
        }
        return next;
      });
    });

    return () => {
      clearInterval(interval);
      socket.disconnect();
    };
  }, [fetchWorkers]);

  const makeMove = (move) => {
    const currentFen = game.fen();
    const newGame = new Chess(currentFen);
    try {
      const result = newGame.move(move);
      if (result) {
        setHistory((prev) => [...prev, currentFen]);
        setGame(newGame);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const undoMove = () => {
    if (history.length === 0 || isSearching || isComparing) return;
    const lastFen = history[history.length - 1];
    setHistory((prev) => prev.slice(0, -1));
    setGame(new Chess(lastFen));
    setBestMove(null);
  };

  const onDrop = (sourceSquare, targetSquare) => {
    if (isSearching || game.isGameOver()) return false;

    const success = makeMove({
      from: sourceSquare,
      to: targetSquare,
      promotion: 'q',
    });
    return success;
  };

  const runSearch = async () => {
    setSearchError(null);
    setIsSearching(true);
    setBestMove(null);
    setBoundEvents([]);
    setTableRows([]);

    try {
      const res = await axios.post(`${BACKEND_URL}/search`, {
        fen: game.fen(),
        depth,
        boundSharing,
      });

      if (res.data.bestMove) {
        setBestMove(res.data.bestMove);
        if (res.data.table) {
          setTableRows(
            res.data.table.map((r) => ({
              ...r,
              nodesExploredSoFar: r.nodesExplored,
              status: r.status ?? 'complete',
            }))
          );
        }
      }
    } catch (err) {
      setSearchError(err.response?.data?.error || err.message);
    } finally {
      setIsSearching(false);
    }
  };

  const runComparison = async () => {
    setSearchError(null);
    setIsComparing(true);
    setComparisonData(null);
    setBoundEvents([]);
    setTableRows([]);

    try {
      const res = await axios.post(`${BACKEND_URL}/search/compare`, {
        fen: game.fen(),
        depth,
      });
      setComparisonData(res.data);
    } catch (err) {
      setSearchError(err.response?.data?.error || err.message);
    } finally {
      setIsComparing(false);
    }
  };

  const applyBestMove = () => {
    if (!bestMove) return;
    makeMove(bestMove);
    setBestMove(null);
  };

  const resetGame = () => {
    setGame(new Chess());
    setHistory([]);
    setBestMove(null);
    setTableRows([]);
    setBoundEvents([]);
    setComparisonData(null);
    setSearchError(null);
  };

  return (
    <div className="app-container wide">
      <header className="header">
        <h1>Distributed Chess Search</h1>
        <p>FA-1 — Master / Worker alpha-beta with bound sharing</p>
      </header>

      <main className="main-content">
        <div className="board-section">
          <GameBoard game={game} onDrop={onDrop} />
          <div className="board-controls">
            <div className="button-group">
              <button
                className="action-button"
                onClick={undoMove}
                disabled={isSearching || isComparing || history.length === 0}
              >
                Undo Move
              </button>
              <button
                className="action-button"
                onClick={resetGame}
                disabled={isSearching || isComparing}
              >
                Reset Board
              </button>
            </div>
            {bestMove && (
              <button className="action-button primary" onClick={applyBestMove}>
                Apply best move: <strong>{bestMove}</strong>
              </button>
            )}
          </div>
        </div>

        <div className="controls-section">
          <div className="panel controls-panel">
            <h2>Search Controls</h2>

            <div className="control-group">
              <label htmlFor="depth-input">Depth: {depth}</label>
              <input
                id="depth-input"
                type="range"
                min="1"
                max="4"
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
                disabled={isSearching || isComparing}
              />
            </div>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={boundSharing}
                onChange={(e) => setBoundSharing(e.target.checked)}
                disabled={isSearching || isComparing}
              />
              Enable bound sharing
            </label>

            <div className="button-row">
              <button
                className="action-button primary"
                onClick={runSearch}
                disabled={isSearching || isComparing || workerCount === 0}
              >
                {isSearching ? 'Searching…' : 'Run Distributed Search'}
              </button>
              <button
                className="action-button"
                onClick={runComparison}
                disabled={isSearching || isComparing || workerCount === 0}
              >
                {isComparing ? 'Comparing…' : 'Compare With/Without Bounds'}
              </button>
            </div>

            {workerCount === 0 && (
              <p className="warning">No workers connected. Start workers with: node worker.js --id 1</p>
            )}
            {searchError && <p className="error">{searchError}</p>}
          </div>

          <MasterTable rows={tableRows} workerCount={workerCount} />
        </div>
      </main>

      <section className="bottom-section">
        <BoundLog events={boundEvents} />
        <ComparisonChart data={comparisonData} />
      </section>
    </div>
  );
}

export default App;
