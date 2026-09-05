import React from 'react';

function ComparisonChart({ data }) {
  if (!data) {
    return (
      <div className="panel chart-panel">
        <h2>Nodes Explored Comparison</h2>
        <p className="empty-row">Run comparison to see bound sharing effect</p>
      </div>
    );
  }

  const maxNodes = Math.max(data.withBoundSharing.totalNodesExplored, data.withoutBoundSharing.totalNodesExplored, 1);
  const withPct = (data.withBoundSharing.totalNodesExplored / maxNodes) * 100;
  const withoutPct = (data.withoutBoundSharing.totalNodesExplored / maxNodes) * 100;
  const saved = data.withoutBoundSharing.totalNodesExplored - data.withBoundSharing.totalNodesExplored;
  const savedPct = data.withoutBoundSharing.totalNodesExplored > 0
    ? ((saved / data.withoutBoundSharing.totalNodesExplored) * 100).toFixed(1)
    : 0;

  return (
    <div className="panel chart-panel">
      <h2>Nodes Explored Comparison</h2>
      <p className="panel-subtitle">Same position searched twice — with vs without bound sharing</p>

      <div className="bar-chart">
        <div className="bar-row">
          <span className="bar-label">With bounds</span>
          <div className="bar-track">
            <div className="bar-fill with-bounds" style={{ width: `${withPct}%` }} />
          </div>
          <span className="bar-value">{data.withBoundSharing.totalNodesExplored.toLocaleString()}</span>
        </div>
        <div className="bar-row">
          <span className="bar-label">Without bounds</span>
          <div className="bar-track">
            <div className="bar-fill without-bounds" style={{ width: `${withoutPct}%` }} />
          </div>
          <span className="bar-value">{data.withoutBoundSharing.totalNodesExplored.toLocaleString()}</span>
        </div>
      </div>

      {saved > 0 && (
        <p className="chart-summary">
          Bound sharing saved {saved.toLocaleString()} nodes ({savedPct}% reduction)
        </p>
      )}
      {saved <= 0 && (
        <p className="chart-summary">
          Both runs explored similar node counts (try a higher depth or more workers)
        </p>
      )}
    </div>
  );
}

export default ComparisonChart;
