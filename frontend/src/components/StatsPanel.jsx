import React from 'react';

function StatsPanel({ stats, bestLine, depth, setDepth, isEngineThinking, cacheSize, onReset, gameOver, turn }) {
  const getOutcomeMessage = () => {
    if (!gameOver) return null;
    return <div className="game-over-alert">Game Over!</div>;
  };

  const getEvaluationString = (score) => {
    if (score > 9000) return 'Engine winning';
    if (score < -9000) return 'Player winning';
    return score > 0 ? `+${score}` : `${score}`;
  };

  return (
    <div className="stats-panel">
      <h2>Engine Controls & Stats</h2>
      
      <div className="control-group">
        <label htmlFor="depth-input">Search Depth: {depth}</label>
        <input 
          id="depth-input"
          type="range" 
          min="1" 
          max="5" 
          value={depth} 
          onChange={(e) => setDepth(Number(e.target.value))}
          disabled={isEngineThinking}
        />
        <small className="hint">higher depth = stronger but slower</small>
      </div>

      <div className="status-indicator">
        {isEngineThinking ? (
          <span className="thinking blink">Engine is thinking...</span>
        ) : (
          <span>{turn === 'w' ? 'Your turn (White)' : 'Engine turn (Black)'}</span>
        )}
      </div>

      {getOutcomeMessage()}

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">Evaluation</span>
          <span className="stat-value">{getEvaluationString(stats.score)}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Nodes Explored</span>
          <span className="stat-value">{stats.nodesExplored.toLocaleString()}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Nodes Pruned</span>
          <span className="stat-value">{stats.nodesPruned.toLocaleString()}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Cache Hits</span>
          <span className="stat-value">{stats.cacheHits.toLocaleString()}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Calc Time</span>
          <span className="stat-value">{stats.timeTakenMs} ms</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Total DB Cache Size</span>
          <span className="stat-value">{cacheSize.toLocaleString()}</span>
        </div>
      </div>

      <div className="best-line-section">
        <h3>Predicted Best Line</h3>
        {bestLine && bestLine.length > 0 ? (
          <ol className="best-line-list">
            {bestLine.map((move, i) => (
              <li key={i}>{move}</li>
            ))}
          </ol>
        ) : (
          <p className="no-line">No line predicted yet</p>
        )}
      </div>

      <button className="reset-button" onClick={onReset}>Reset Game</button>
    </div>
  );
}

export default StatsPanel;
