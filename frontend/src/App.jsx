import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { io } from 'socket.io-client';
import axios from 'axios';
import GameBoard from './components/GameBoard';
import MasterTable from './components/MasterTable';
import BoundLog from './components/BoundLog';
import ComparisonChart from './components/ComparisonChart';
import ClusterPanel from './components/ClusterPanel';
import ClusterEventLog from './components/ClusterEventLog';
import useLeader from './cluster/useLeader';
import { NODES } from './cluster/nodes';
import './App.css';

function App() {
  const { leader, term, nodes, events, storeView, refreshStore, lockView, setLockView, refreshLock } = useLeader();
  const clockSyncEnabled = nodes.some((node) => node.reachable)
    && nodes.filter((node) => node.reachable).every((node) => node.clockSync?.enabled === true);
  const toggleClockSync = async () => {
    await Promise.allSettled(NODES.map(({ url }) => axios.post(`${url}/cluster/clock-sync`,
      { enabled: !clockSyncEnabled }, { timeout: 800 })));
  };
  const [game, setGame] = useState(new Chess());
  const [history, setHistory] = useState([]);
  const [depth, setDepth] = useState(3);
  const [boundSharing, setBoundSharing] = useState(true);
  const [useCache, setUseCache] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [isComparing, setIsComparing] = useState(false);
  const [workerCount, setWorkerCount] = useState(0);
  const [tableRows, setTableRows] = useState([]);
  const [bestMove, setBestMove] = useState(null);
  const [boundEvents, setBoundEvents] = useState([]);
  const [comparisonData, setComparisonData] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [leaderBanner, setLeaderBanner] = useState(null);
  const [searchStatus, setSearchStatus] = useState(null);
  const [cacheInfo, setCacheInfo] = useState(null);
  const socketRef = useRef(null);
  const previousLeaderRef = useRef(null);
  const isComparingRef = useRef(false);
  const waitingForFailoverRef = useRef(false);
  const completedSearchRef = useRef(false);
  const failoverTimerRef = useRef(null);
  const leaderRef = useRef(leader);
  leaderRef.current = leader;
  const requestIdRef = useRef(null);
  const clientIdRef = useRef(null);
  if (!clientIdRef.current) {
    try {
      clientIdRef.current = sessionStorage.getItem('distributed-search-client-id');
      if (!clientIdRef.current) {
        clientIdRef.current = `tab-${Math.random().toString(36).slice(2, 10)}`;
        sessionStorage.setItem('distributed-search-client-id', clientIdRef.current);
      }
    } catch { clientIdRef.current = `tab-${Math.random().toString(36).slice(2, 10)}`; }
  }

  const fetchWorkers = useCallback(async () => {
    if (!leader?.url) { setWorkerCount(0); return; }
    try {
      const res = await axios.get(`${leader.url}/workers`, { timeout: 1000 });
      setWorkerCount(res.data.count);
    } catch {
      setWorkerCount(leader.workersRegistered ?? 0);
    }
  }, [leader?.url, leader?.workersRegistered]);

  useEffect(() => {
    void fetchWorkers();
    const interval = setInterval(fetchWorkers, 2000);
    return () => clearInterval(interval);
  }, [fetchWorkers]);

  useEffect(() => {
    const previous = previousLeaderRef.current;
    if (previous && leader && (previous.id !== leader.id || previous.term !== leader.term)) {
      setLeaderBanner(`Leader changed: Node ${previous.id} -> Node ${leader.id} (term ${leader.term})`);
      if (isComparingRef.current) {
        isComparingRef.current = false;
        setIsComparing(false);
        setSearchError('Compare interrupted, run it again');
      }
    }
    previousLeaderRef.current = leader ? { id: leader.id, term: leader.term } : previous;
  }, [leader?.id, leader?.term]);

  useEffect(() => {
    if (!leader?.url) return undefined;
    const socket = io(`${leader.url}/progress`, { reconnection: false });
    socketRef.current = socket;

    socket.on('state_sync', ({ currentSearch }) => {
      if (!currentSearch) return;
      setTableRows((previousRows) => {
        const previousByMove = new Map(previousRows.map((row) => [row.move, row]));
        return (currentSearch.moves || []).map((move) => {
          const previous = previousByMove.get(move.move);
          let status = move.status === 'complete' ? 'complete'
            : move.status === 'assigned' ? 'searching' : 'queued';
          if (move.status === 'pending' && previous?.status === 'searching') status = 'reassigned';
          return {
            workerId: move.assignedTo ?? previous?.workerId ?? '—', move: move.move,
            score: move.score ?? null, nodesExplored: move.nodesExplored ?? 0,
            nodesExploredSoFar: move.nodesExplored ?? 0, timeMs: move.timeMs ?? 0, status,
          };
        });
      });
    });

    socket.on('search_resumed', ({ completed, remaining }) => {
      setSearchStatus(`Search resumed on new leader (${completed} done, ${remaining} remaining)`);
    });
    socket.on('lock_update', (view) => setLockView({ ...view, receivedAt: Date.now() }));

    socket.on('progress', (data) => {
      setTableRows((previous) => {
        const index = previous.findIndex((row) => row.move === data.move);
        const row = {
          workerId: data.workerId, move: data.move, score: data.score ?? null,
          nodesExploredSoFar: data.nodesExploredSoFar, timeMs: data.timeMs ?? null,
          status: data.status,
        };
        if (index < 0) return [...previous, row];
        const next = [...previous];
        next[index] = { ...next[index], ...row };
        return next;
      });
    });

    socket.on('search_complete', ({ bestMove: move, table, cache }) => {
      if (isComparingRef.current) return;
      completedSearchRef.current = true;
      waitingForFailoverRef.current = false;
      requestIdRef.current = null;
      clearTimeout(failoverTimerRef.current);
      setSearchStatus((previous) => previous?.startsWith('Search resumed on new leader') ? previous : null);
      setBestMove(move);
      setCacheInfo(cache || null);
      void refreshStore();
      setTableRows((table || []).map((row) => ({
        workerId: row.workerId, move: row.move, score: row.score,
        nodesExplored: row.nodesExplored, nodesExploredSoFar: row.nodesExplored,
        timeMs: row.timeMs, status: row.status ?? 'complete',
      })));
      setIsSearching(false);
    });

    socket.on('bound_event', (event) => {
      setBoundEvents((previous) => [...previous, { ...event, deliveries: [] }]);
    });
    socket.on('bound_delivery', (delivery) => {
      setBoundEvents((previous) => {
        const next = [...previous];
        for (let index = next.length - 1; index >= 0; index--) {
          if (next[index].value === delivery.value && next[index].fromWorker === delivery.fromWorker) {
            next[index] = { ...next[index], deliveries: [...next[index].deliveries, {
              workerId: delivery.workerId, receivedTs: delivery.receivedTs,
              recvLc: delivery.recvLc, delayMs: delivery.delayMs,
            }] };
            break;
          }
        }
        return next;
      });
    });

    return () => {
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [leader?.id, leader?.term, leader?.url, refreshStore, setLockView]);

  useEffect(() => () => clearTimeout(failoverTimerRef.current), []);

  const makeMove = (move) => {
    const currentFen = game.fen();
    const newGame = new Chess(currentFen);
    try {
      const result = newGame.move(move);
      if (result) {
        setHistory((previous) => [...previous, currentFen]);
        setGame(newGame);
        return true;
      }
      return false;
    } catch { return false; }
  };

  const undoMove = () => {
    if (history.length === 0 || isSearching || isComparing) return;
    const lastFen = history[history.length - 1];
    setHistory((previous) => previous.slice(0, -1));
    setGame(new Chess(lastFen));
    setBestMove(null);
  };

  const onDrop = (sourceSquare, targetSquare) => {
    if (isSearching || game.isGameOver()) return false;
    return makeMove({ from: sourceSquare, to: targetSquare, promotion: 'q' });
  };

  const runSearch = async () => {
    if (!leader?.url) return;
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    requestIdRef.current = requestId;
    setSearchError(null);
    setSearchStatus(null);
    setCacheInfo(null);
    setIsSearching(true);
    waitingForFailoverRef.current = false;
    completedSearchRef.current = false;
    setBestMove(null);
    setBoundEvents([]);
    setTableRows([]);
    const payload = { fen: game.fen(), depth, boundSharing, useCache, requestId, clientId: clientIdRef.current };
    const retryUntil = Date.now() + 60000;
    let response;
    while (Date.now() < retryUntil) {
      const currentLeader = leaderRef.current;
      if (!currentLeader?.url) { await new Promise((resolve) => setTimeout(resolve, 500)); continue; }
      try {
        response = await axios.post(`${currentLeader.url}/search`, payload, { timeout: Math.max(1000, retryUntil - Date.now()) });
        if (response.status === 202) {
          setSearchStatus(response.data.status === 'queued' ? `Queued #${response.data.position}…` : 'Search resumed on new leader…');
          waitingForFailoverRef.current = true;
          clearTimeout(failoverTimerRef.current);
          failoverTimerRef.current = setTimeout(() => {
            if (waitingForFailoverRef.current) {
              waitingForFailoverRef.current = false; setIsSearching(false); setSearchStatus(null);
              setSearchError('No search result arrived within 60 seconds after leader loss.');
            }
          }, 60000);
          return;
        }
        break;
      } catch (error) {
        const retryable = !error.response || ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) ||
          (error.response.status === 503 && error.response.data?.error === 'not_leader');
        if (!retryable) {
          setSearchError(error.response?.data?.error || error.message);
          setIsSearching(false);
          return;
        }
        waitingForFailoverRef.current = true;
        setSearchStatus(lockView?.queue?.some((entry) => entry.requestId === requestId)
          ? `Queued #${lockView.queue.findIndex((entry) => entry.requestId === requestId) + 1}…`
          : 'Leader lost, waiting for failover…');
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    try {
      if (!response) throw new Error('No leader response within 60 seconds.');
      setCacheInfo(response.data.cache || null);
      if (response.data.bestMove) {
        setBestMove(response.data.bestMove);
        setTableRows((response.data.table || []).map((row) => ({
          ...row, nodesExploredSoFar: row.nodesExplored, status: row.status ?? 'complete',
        })));
      }
      waitingForFailoverRef.current = false;
      clearTimeout(failoverTimerRef.current);
      setIsSearching(false);
    } catch (error) {
      const retryable = !error.response || ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) ||
        (error.response.status === 503 && error.response.data?.error === 'not_leader');
      if (retryable && !completedSearchRef.current) {
        waitingForFailoverRef.current = true;
        setSearchStatus('Leader lost, waiting for failover...');
        clearTimeout(failoverTimerRef.current);
        failoverTimerRef.current = setTimeout(() => {
          if (waitingForFailoverRef.current) {
            waitingForFailoverRef.current = false;
            setIsSearching(false);
            setSearchStatus(null);
            setSearchError('No search result arrived within 60 seconds after leader loss.');
          }
        }, 60000);
      } else if (!completedSearchRef.current) {
        setSearchError(error.response?.data?.error || error.message);
        setIsSearching(false);
      }
    }
  };

  const runComparison = async () => {
    if (!leader?.url) return;
    setSearchError(null);
    setCacheInfo(null);
    setIsComparing(true);
    isComparingRef.current = true;
    setComparisonData(null);
    setBoundEvents([]);
    setTableRows([]);
    try {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const payload = { fen: game.fen(), depth, requestId, clientId: clientIdRef.current };
      const retryUntil = Date.now() + 60000;
      let response;
      while (Date.now() < retryUntil) {
        const currentLeader = leaderRef.current;
        if (!currentLeader?.url) { await new Promise((resolve) => setTimeout(resolve, 500)); continue; }
        try {
          response = await axios.post(`${currentLeader.url}/search/compare`, payload, { timeout: Math.max(1000, retryUntil - Date.now()) });
          if (response.status === 202) throw new Error('Compare interrupted, run it again');
          break;
        } catch (error) {
          const retryable = !error.response || ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) ||
            (error.response.status === 503 && error.response.data?.error === 'not_leader');
          if (!retryable) throw error;
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
      }
      if (!response) throw new Error('Compare interrupted, run it again');
      setComparisonData(response.data);
    } catch (error) {
      const retryable = !error.response || ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) ||
        (error.response.status === 503 && error.response.data?.error === 'not_leader');
      setSearchError(retryable ? 'Compare interrupted, run it again' :
        (error.response?.data?.error || error.message));
    } finally {
      isComparingRef.current = false;
      setIsComparing(false);
    }
  };

  const applyBestMove = () => {
    if (!bestMove) return;
    makeMove(bestMove);
    setBestMove(null);
  };

  const clearStore = async () => {
    await Promise.allSettled(NODES.map(({ url }) => axios.post(`${url}/store/clear`, {}, { timeout: 1000 })));
    await refreshStore();
  };

  const hogLock = async () => {
    const currentLeader = leaderRef.current;
    if (!currentLeader?.url) return;
    await axios.post(`${currentLeader.url}/lock/acquire`, {
      hold: true, label: 'hog', clientId: clientIdRef.current,
      requestId: `hog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }, { timeout: 1500 });
    await refreshLock();
  };

  const resetGame = () => {
    setGame(new Chess());
    setHistory([]);
    setBestMove(null);
    setTableRows([]);
    setBoundEvents([]);
    setComparisonData(null);
    setSearchError(null);
    setSearchStatus(null);
  };

  return (
    <div className="app-container wide">
      <header className="header">
        <h1>Distributed Chess Search</h1>
        <p>FA-2 — Leader election with replicated distributed search</p>
      </header>
      {leaderBanner && <div className="leader-banner" role="status">
        <span>{leaderBanner}</span><button onClick={() => setLeaderBanner(null)} aria-label="Dismiss leader change">×</button>
      </div>}
      <div className="cluster-sync-control">
        <button className="action-button" onClick={toggleClockSync}>
          Clock sync: {clockSyncEnabled ? 'ON' : 'OFF'}
        </button>
      </div>
      <ClusterPanel nodes={nodes} leader={leader} storeView={storeView} onClearStore={clearStore}
        lockView={lockView} onHogLock={hogLock} />
      <main className="main-content">
        <div className="board-section">
          <GameBoard game={game} onDrop={onDrop} />
          <div className="board-controls">
            <div className="button-group">
              <button className="action-button" onClick={undoMove} disabled={isSearching || isComparing || history.length === 0}>Undo Move</button>
              <button className="action-button" onClick={resetGame} disabled={isSearching || isComparing}>Reset Board</button>
            </div>
            {bestMove && <button className="action-button primary" onClick={applyBestMove}>Apply best move: <strong>{bestMove}</strong></button>}
          </div>
        </div>
        <div className="controls-section">
          <div className="panel controls-panel">
            <h2>Search Controls</h2>
            <div className="control-group">
              <label htmlFor="depth-input">Depth: {depth}</label>
              <input id="depth-input" type="range" min="1" max="4" value={depth}
                onChange={(event) => setDepth(Number(event.target.value))} disabled={isSearching || isComparing} />
            </div>
            <label className="checkbox-label"><input type="checkbox" checked={boundSharing}
              onChange={(event) => setBoundSharing(event.target.checked)} disabled={isSearching || isComparing} /> Enable bound sharing</label>
            <label className="checkbox-label"><input type="checkbox" checked={useCache}
              onChange={(event) => setUseCache(event.target.checked)} disabled={isSearching || isComparing} /> Use cache</label>
            <div className="button-row">
              <button className="action-button primary" onClick={runSearch}
                disabled={isSearching || isComparing || workerCount === 0 || !leader}>
                {isSearching ? (() => {
                  const index = lockView?.queue?.findIndex((entry) => entry.requestId === requestIdRef.current) ?? -1;
                  return index >= 0 ? `Queued #${index + 1}…` : 'Searching…';
                })() : 'Run Distributed Search'}
              </button>
              <button className="action-button" onClick={runComparison}
                disabled={isSearching || isComparing || workerCount === 0 || !leader}>
                {isComparing ? 'Comparing…' : 'Compare With/Without Bounds'}
              </button>
            </div>
            {workerCount === 0 && <p className="warning">No workers connected. Start the cluster with <code>npm run start:all</code>.</p>}
            {searchStatus && <p className="search-status" role="status">{searchStatus}</p>}
            {cacheInfo && <p className="cache-result-badge" role="status">{cacheInfo.hit
              ? `served from cache by node ${cacheInfo.servedBy} (${cacheInfo.servedBy === cacheInfo.owners?.[0] ? 'primary' : 'replica'}) in ${cacheInfo.latencyMs} ms`
              : `computed: owners node ${cacheInfo.owners?.[0]} + node ${cacheInfo.owners?.[1]}`}</p>}
            {searchError && <p className="error">{searchError}</p>}
          </div>
          <MasterTable rows={tableRows} workerCount={workerCount} />
        </div>
      </main>
      <section className="bottom-section">
        <BoundLog events={boundEvents} />
        <ComparisonChart data={comparisonData} />
      </section>
      <ClusterEventLog events={events} />
    </div>
  );
}

export default App;
