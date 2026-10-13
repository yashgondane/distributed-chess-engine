import React, { useEffect, useState } from 'react';

function ageLabel(age) {
  if (age == null || !Number.isFinite(age)) return '—';
  return `${Math.max(0, Math.round(age))} ms`;
}

function ClusterPanel({ nodes, leader, storeView, onClearStore, lockView, onHogLock }) {
  const leaderClock = leader?.skewMs ?? 0;
  const leaderOffset = leader?.clockSync?.syncOffsetMs ?? 0;
  const [clockNow, setClockNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setClockNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  const leaseRemaining = lockView?.holder
    ? Math.max(0, lockView.holder.leaseRemainingMs - (clockNow - (lockView.receivedAt || clockNow))) : 0;
  return (
    <section className="panel cluster-panel" aria-label="Cluster nodes">
      <div className="cluster-panel-heading">
        <div><h2>Cluster</h2><p className="panel-subtitle">Live node roles and replica state</p></div>
        <span className="cluster-term">Term {leader?.term ?? '—'}</span>
      </div>
      <div className="cluster-cards">
        {nodes.map((node) => {
          const role = node.reachable ? node.role.toUpperCase() : 'DOWN';
          return (
            <article className={`cluster-node ${node.reachable ? '' : 'unreachable'}`} key={node.id}>
              <div className="cluster-node-heading"><strong>Node {node.id}</strong><span className={`role-badge role-${role.toLowerCase()}`}>{role}</span></div>
              <dl>
                <div><dt>Term</dt><dd>{node.reachable ? node.term : '—'}</dd></div>
                <div><dt>LC</dt><dd>{node.reachable ? node.lamport ?? '—' : '—'}{node.reachable && node.skewMs ? <small className="clock-skew-badge">clock {node.skewMs > 0 ? '+' : ''}{node.skewMs} ms</small> : null}</dd></div>
                <div><dt>Raw clock offset</dt><dd>{node.reachable ? `${node.skewMs > 0 ? '+' : ''}${node.skewMs} ms` : '—'}</dd></div>
                <div><dt>After sync</dt><dd>{!node.reachable ? '—' : !node.clockSync?.enabled ? 'sync off' : `${(node.skewMs + (node.clockSync.syncOffsetMs ?? 0) - leaderClock - leaderOffset > 0 ? '+' : '')}${Math.round(node.skewMs + (node.clockSync.syncOffsetMs ?? 0) - leaderClock - leaderOffset)} ms (±${Math.ceil(node.clockSync.errorBoundMs ?? 0)} ms) (simulation)`}</dd></div>
                <div><dt>Heartbeat</dt><dd>{node.id === leader?.id ? '—' : node.reachable ? ageLabel(node.lastHeartbeatAgeMs) : '—'}</dd></div>
                <div><dt>Replica</dt><dd>{node.reachable ? node.replicaVersion : '—'}</dd></div>
                {node.id === leader?.id && <div><dt>Workers</dt><dd>{node.workersRegistered ?? 0}</dd></div>}
              </dl>
            </article>
          );
        })}
      </div>
      <section className="analysis-store-card search-lock-card" aria-label="Search Lock">
        <div className="cluster-panel-heading">
          <div><h3>Search Lock</h3><p className="panel-subtitle">Fence {lockView?.fence ?? 0} · coordinated by Node {lockView?.nodeId ?? leader?.id ?? '—'}</p></div>
          <button className="action-button" onClick={onHogLock} disabled={!leader}>Hog lock</button>
        </div>
        {lockView?.holder ? <>
          <div className="lock-holder">Holder: {lockView.holder.label || 'search'} / {lockView.holder.clientId} · {Math.ceil(leaseRemaining / 1000)} s lease</div>
          <div className="lock-lease-track" style={{ height: 8, background: '#d7dce4', borderRadius: 5, overflow: 'hidden', margin: '8px 0 14px' }}>
            <div style={{ width: `${Math.max(0, Math.min(100, 100 * leaseRemaining / (lockView.leaseMs || 30000)))}%`, height: '100%', background: '#4276d7', transition: 'width 250ms linear' }} />
          </div>
        </> : <p className="panel-subtitle">No current holder.</p>}
        <ol className="lock-queue">{(lockView?.queue || []).map((entry, index) => <li key={entry.requestId}>#{index + 1} {entry.label || 'search'} / {entry.clientId} · waiting {Math.round(entry.waitingMs)} ms</li>)}</ol>
      </section>
      <section className="analysis-store-card" aria-label="Analysis Store">
        <div className="cluster-panel-heading">
          <div><h3>Analysis Store (consistent hashing)</h3><p className="panel-subtitle">Finished analyses are held by the primary and replica nodes.</p></div>
          <button className="action-button" onClick={onClearStore}>Clear store</button>
        </div>
        <table className="store-table">
          <thead><tr><th>Node</th><th>Share %</th><th>Alive</th><th>Stored entries</th></tr></thead>
          <tbody>{(storeView?.ring || nodes.map((node) => ({ nodeId: node.id, sharePct: 0, alive: node.reachable, count: node.storeCount || 0 }))).map((row) => (
            <tr key={row.nodeId}>
              <td>Node {row.nodeId}</td>
              <td><span>{Number(row.sharePct || 0).toFixed(1)}%</span><span className="share-track" style={{ display: 'inline-block', width: 72, height: 7, marginLeft: 8, background: '#d7dce4', borderRadius: 4, verticalAlign: 'middle' }}><span style={{ display: 'block', width: `${Math.max(0, Math.min(100, row.sharePct || 0))}%`, height: '100%', background: '#4276d7', borderRadius: 4 }} /></span></td>
              <td><span className={`alive-dot ${row.alive ? 'alive' : 'dead'}`} aria-label={row.alive ? 'alive' : 'down'} style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: row.alive ? '#20a464' : '#a0a7b2' }} /></td>
              <td>{row.count}</td>
            </tr>
          ))}</tbody>
        </table>
        <div className="store-entry-list">
          {(storeView?.entries || []).length === 0 ? <p className="panel-subtitle">No stored analyses yet.</p> : (storeView.entries || []).map((entry) => (
            <article className="store-entry" key={entry.key}>
              <div><code>{entry.fen?.slice(0, 20) || entry.key.slice(0, 20)}…</code> · depth {entry.depth}</div>
              <div>Best move: <strong>{entry.bestMove}</strong> · score {entry.score}</div>
              <div>Owners: P:n{entry.owners?.[0]} R:n{entry.owners?.[1]}</div>
              <div className="store-chips">Present on: {nodes.map((node) => {
                const holds = entry.presentOn?.includes(node.id);
                const cls = holds && node.reachable ? 'present' : holds ? 'present-down' : 'missing';
                const color = cls === 'present' ? '#187a4b' : cls === 'present-down' ? '#b33b3b' : '#626b78';
                return <span className={`store-chip ${cls}`} key={node.id} style={{ display: 'inline-block', marginRight: 5, padding: '2px 6px', borderRadius: 10, background: color, color: 'white' }}>n{node.id}</span>;
              })}</div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}

export default ClusterPanel;
