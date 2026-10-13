import React from 'react';

function timeLabel(ts) {
  if (!Number.isFinite(ts)) return '—';
  return `${new Date(ts).toLocaleTimeString()}.${String(ts % 1000).padStart(3, '0')}`;
}

function BoundLog({ events }) {
  return (
    <div className="panel bound-log-panel">
      <h2>Bound Broadcast Log</h2>
        <p className="panel-subtitle">Sent vs received timestamps show propagation delay</p>
      <div className="log-wrapper">
        {events.length === 0 ? (
          <p className="empty-row">Bound events will appear here during search with sharing enabled</p>
        ) : (
          <table className="bound-log-table">
            <thead>
              <tr>
                <th>From</th>
                <th>Value</th>
                <th>Sent (worker)</th>
                <th>Sent LC</th>
                <th>Relayed (master)</th>
                <th>Relay LC</th>
                <th>Received by</th>
                <th>Received (worker)</th>
                <th>Recv LC</th>
                <th>Delay (ms)</th>
              </tr>
            </thead>
            <tbody>
              {events.map((evt, i) => {
                const deliveries = evt.deliveries || [];
                return (
                <React.Fragment key={i}>
                  {deliveries.length === 0 ? (
                    <tr>
                      <td>W{evt.fromWorker}</td>
                      <td>{evt.value}</td>
                      <td>{timeLabel(evt.sentTs)}</td>
                      <td>{evt.sentLc ?? '—'}</td>
                      <td>{timeLabel(evt.relayTs)}</td>
                      <td>{evt.relayLc ?? '—'}</td>
                      <td colSpan="4">No other workers searching</td>
                    </tr>
                  ) : (
                    deliveries.map((d, j) => {
                      const delay = Number.isFinite(d.receivedTs) && Number.isFinite(evt.sentTs)
                        ? d.receivedTs - evt.sentTs : null;
                      return (
                      <tr key={`${i}-${j}`}>
                        {j === 0 && (
                          <>
                            <td rowSpan={deliveries.length}>W{evt.fromWorker}</td>
                            <td rowSpan={deliveries.length}>{evt.value}</td>
                            <td rowSpan={deliveries.length}>{timeLabel(evt.sentTs)}</td>
                            <td rowSpan={deliveries.length}>{evt.sentLc ?? '—'}</td>
                            <td rowSpan={deliveries.length}>{timeLabel(evt.relayTs)}</td>
                            <td rowSpan={deliveries.length}>{evt.relayLc ?? '—'}</td>
                          </>
                        )}
                        <td>W{d.workerId}</td>
                        <td>{timeLabel(d.receivedTs)}</td>
                        <td>{d.recvLc ?? '—'}</td>
                        <td>{delay == null ? '—' : delay < 0 ? `⚠ skew ${delay}` : delay}</td>
                      </tr>
                    );})
                  )}
                </React.Fragment>
              );})}
            </tbody>
          </table>
        )}
      </div>
      <p className="panel-subtitle">Wall-clock delay is unreliable across nodes; Lamport order is not.</p>
    </div>
  );
}

export default BoundLog;
