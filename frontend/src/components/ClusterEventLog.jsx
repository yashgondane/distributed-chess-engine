import React, { useMemo, useState } from 'react';

function eventTone(type) {
  if (type === 'HEARTBEAT_LOST' || type === 'PEER_DOWN') return 'event-red';
  if (type.startsWith('ELECTION_')) return 'event-amber';
  if (type === 'BECAME_LEADER' || type.startsWith('COORDINATOR_')) return 'event-green';
  if (type === 'REPLICATED' || type === 'REPLICA_RECEIVED') return 'event-muted';
  return '';
}

function ClusterEventLog({ events }) {
  const [showReplication, setShowReplication] = useState(false);
  const [orderBy, setOrderBy] = useState('lamport');
  const shown = useMemo(() => events.filter((event) => showReplication ||
    !['REPLICATED', 'REPLICA_RECEIVED'].includes(event.type)).sort((a, b) => orderBy === 'lamport'
      ? (a.lc ?? 0) - (b.lc ?? 0) || a.nodeId - b.nodeId
      : a.ts - b.ts), [events, showReplication, orderBy]);
  return (
    <section className="panel cluster-event-panel">
      <div className="cluster-event-heading">
        <h2>Cluster Event Log</h2>
        <div className="event-order-toggle" role="group" aria-label="Order by">
          <span>Order by:</span>
          <button type="button" aria-pressed={orderBy === 'lamport'} onClick={() => setOrderBy('lamport')}>Lamport</button>
          <button type="button" aria-pressed={orderBy === 'wall'} onClick={() => setOrderBy('wall')}>Wall-clock</button>
        </div>
        <label className="replication-toggle"><input type="checkbox" checked={showReplication}
          onChange={(event) => setShowReplication(event.target.checked)} /> Show replication events</label>
      </div>
      <div className="log-wrapper cluster-event-wrapper">
        {shown.length === 0 ? <p className="empty-row">Cluster events will appear here</p> : (
          <table className="bound-log-table cluster-event-table">
            <thead><tr><th>Time</th><th>LC</th><th>Node</th><th>Event</th><th>Detail</th></tr></thead>
            <tbody>{shown.map((event) => (
              <tr key={`${event.nodeId}:${event.seq}`} className={eventTone(event.type)}>
                <td>{new Date(event.ts).toLocaleTimeString('en-GB', { hour12: false })}.{String(event.ts % 1000).padStart(3, '0')}</td>
                <td>{event.lc ?? '—'}</td><td>{event.nodeId}</td><td>{event.type}</td>
                <td>{Object.keys(event.detail || {}).length ? JSON.stringify(event.detail) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export default ClusterEventLog;
