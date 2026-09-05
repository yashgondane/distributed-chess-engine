import React from 'react';

function MasterTable({ rows, workerCount }) {
  return (
    <div className="panel master-table-panel">
      <h2>Master Table</h2>
      <p className="panel-subtitle">{workerCount} worker(s) connected</p>
      <div className="table-wrapper">
        <table className="master-table">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Move</th>
              <th>Score</th>
              <th>Nodes</th>
              <th>Time (ms)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan="6" className="empty-row">
                  Run a distributed search to populate this table
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={`${row.workerId}-${row.move}-${i}`} className={`status-${row.status}`}>
                  <td>{row.workerId}</td>
                  <td>{row.move || '—'}</td>
                  <td>{row.score != null ? row.score : '—'}</td>
                  <td>{row.nodesExploredSoFar?.toLocaleString() ?? row.nodesExplored?.toLocaleString() ?? '—'}</td>
                  <td>{row.timeMs != null ? row.timeMs : '—'}</td>
                  <td>
                    <span className={`status-badge ${row.status}`}>{row.status}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default MasterTable;
