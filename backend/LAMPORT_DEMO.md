# Lamport clock demo

A Lamport clock is a per-node counter that advances when an event is logged or a message is sent.
On receipt, the counter advances past both the local value and the received stamp.
If events are causally related, the sender's stamp is smaller; ties sort by node id.

```powershell
cd backend
npm run start:all:skew
```

In the UI, run a depth-4 search with bound sharing enabled, then run:

```powershell
node check-skew.js
```

Point out the clock skew badges, negative wall-clock delay rows, Sent LC < Relay LC < Recv LC,
and the Lamport / Wall-clock ordering control in the event log.
For failover, run a search and kill the leader with `npm run kill:node -- 4`;
the verified log order is HEARTBEAT_LOST -> ELECTION_STARTED -> BECAME_LEADER -> COORDINATOR_RECEIVED.

Limitations:
- Lamport clocks provide causal consistency, not exact time.
- A smaller stamp alone does not prove causality.
- Bounds are monotonic, so ordering does not change search correctness; clocks support ordering,
  diagnostics, and the defensive stale-bound guard.
