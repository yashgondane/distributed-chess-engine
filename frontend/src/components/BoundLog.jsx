import React from 'react';

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
                <th>Relayed (master)</th>
                <th>Received by</th>
                <th>Delay (ms)</th>
              </tr>
            </thead>
            <tbody>
              {events.map((evt, i) => (
                <React.Fragment key={i}>
                  {evt.deliveries.length === 0 ? (
                    <tr>
                      <td>W{evt.fromWorker}</td>
                      <td>{evt.value}</td>
                      <td>{new Date(evt.sentTs).toLocaleTimeString()}.{String(evt.sentTs % 1000).padStart(3, '0')}</td>
                      <td>{new Date(evt.relayTs).toLocaleTimeString()}.{String(evt.relayTs % 1000).padStart(3, '0')}</td>
                      <td colSpan="2">No other workers searching</td>
                    </tr>
                  ) : (
                    evt.deliveries.map((d, j) => (
                      <tr key={`${i}-${j}`}>
                        {j === 0 && (
                          <>
                            <td rowSpan={evt.deliveries.length}>W{evt.fromWorker}</td>
                            <td rowSpan={evt.deliveries.length}>{evt.value}</td>
                            <td rowSpan={evt.deliveries.length}>
                              {new Date(evt.sentTs).toLocaleTimeString()}.{String(evt.sentTs % 1000).padStart(3, '0')}
                            </td>
                            <td rowSpan={evt.deliveries.length}>
                              {new Date(evt.relayTs).toLocaleTimeString()}.{String(evt.relayTs % 1000).padStart(3, '0')}
                            </td>
                          </>
                        )}
                        <td>W{d.workerId}</td>
                        <td>{d.delayMs ?? (d.receivedTs - evt.relayTs)}</td>
                      </tr>
                    ))
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default BoundLog;
