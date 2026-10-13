# Implemented Features in This Chat

This document inventories the distributed chess engine work carried out and pushed during this chat. It records the feature scope and the validation evidence stated in the conversation; it does not claim unreported acceptance checks.

## Cluster runtime and failover

- Replaced the separate master and worker process model with a shared per-node entry point. Nodes load `backend/cluster.json`, build their node state, and can operate as leader or follower.
- Added node state and leader state models, with serializable leader snapshots and restoration from replicas.
- Moved leader/master duties and follower/worker duties into `backend/leaderRole.js` and `backend/workerRole.js`.
- Moved worker search RPC to `POST /rpc/search`; retained the leader search API at `POST /search`.
- Added cluster heartbeats, peer health tracking, event ring buffers, status/replica endpoints, state replication, and anti-entropy snapshot sends.
- Added Bully elections, terms, coordinator announcements, stale-term rejection, leader/follower transitions, and resumption of interrupted searches from replicated state. Assigned moves return to pending on promotion; completed move results are retained.
- Added progress and state synchronization for newly connected leader clients and failover-aware search completion.
- Added Windows-friendly scripts for starting all four nodes together and killing the process associated with a configured node port.
- Added frontend node discovery, node/role/health cards, merged cluster event log, leader-change banner, progress reconnection, and failover-tolerant results. Bound logs and comparison results are held in React state across leader changes.

## Logical clocks and clock synchronization

- Added a per-process Lamport clock, `now()` timestamp helper, event ordering helper, and defensive stale-bound predicate in `backend/lamport.js`.
- Stamped cross-node HTTP requests/responses and the cluster Socket.IO event paths; added Lamport stamps to cluster events, status, and bound-update relay records.
- Added `/cluster/bound-log` and retained the bound chain's worker-send, leader-relay, and receiver stamps and timestamps.
- Added the stale-bound guard for mismatched search, older term, or a relay causally predating the worker's current search.
- Added skew launch mode and diagnostic scripts to compare wall-clock delays with Lamport ordering.
- Added Cristian-style clock synchronization: the current leader serves cluster time; followers select the lowest-RTT sample from five requests, estimate offset and error bound, and periodically resynchronize. Sync can be toggled with `/cluster/clock-sync`; status reports synchronization fields.
- Added frontend Lamport/wall-clock event ordering, Lamport columns, raw clock skew and post-sync estimate display, clock-sync toggle, and bound-log skew indication.

## Distributed analysis store

- Added a deterministic SHA-1 consistent-hash ring using virtual nodes and two distinct owners per `(FEN position, depth)` key.
- Added local in-memory and JSON-file storage, with atomic file replacement, startup loading, clear/keys/get/put operations, and store events/status counts.
- Added store endpoints on all nodes and leader `/store/view` aggregation for ring share, liveness, entry owners, and actual placement.
- Integrated optional cache lookup into normal searches, with cache-hit results and metadata, replica fallback, read repair, and asynchronous writes to the two owners after completed searches.
- Compare searches bypass the store. Interrupted searches do not write partial results.
- Added frontend store view, cache-use toggle, clear-store action, and result cache-source badge.

## Distributed search lock

- Added a pure `LockManager` with FIFO queueing, idempotent request IDs, leases and renewal, queue limits, release/cancel/expiry, fencing tokens, and snapshot/restore support.
- Added leader lock view/acquire/release endpoints, replicated lock state, lease-expiration polling, lock events, and queued search handling for both normal and Compare searches. Cache hits remain outside the lock.
- Added progress-based lease renewal and stale-fence completion rejection so an expired holder cannot publish or store a stale result.
- Added lock launch/check scripts and lock demo notes. The chat's code changes added the frontend lock-related scope requested in the M3 task only where included in the pushed frontend diff; no separate UI interaction results are asserted here.

## Tests, scripts, and documentation

- Added Node built-in test suites for Lamport clocks, clock-sync estimates, consistent hashing/local store, and lock behavior; no new npm dependency was introduced for these suites.
- Added diagnostic/check scripts for Lamport event and bound ordering, skew, clock sync, store priming/verification, and lock queue/lease behavior, plus store clearing.
- Added demo documents: `backend/FAILOVER_DEMO.md`, `backend/LAMPORT_DEMO.md`, `backend/CLOCKSYNC_DEMO.md`, `backend/STORE_DEMO.md`, and `backend/LOCK_DEMO.md`.
- Added the root-level `fa2-script-and-viva.md` notes file.

## Commands and repository state

- The distributed runtime uses four configured local nodes on ports 4001–4004, with npm scripts for individual nodes and `start:all`; additional scripts were added for skew, synchronized skew, lock testing, node termination, and store clearing.
- Changes were pushed to `https://github.com/yashgondane/distributed-chess-engine` on branch `main` in commits `44ae227` (cluster/store/clocks/lock work) and `9cd2f13` (FA2 notes).
- Generated backend `.log` and `.err` files were left out of those commits.

## Validation evidence and limits

- The conversation includes requests to run multiple staged tests, builds, searches, failover simulations, and API checks. Only checks explicitly reported as run in those task reports should be treated as verified; this inventory does not infer success from requested checks.
- The final push itself completed successfully. No new test, build, or live cluster run was performed while writing this inventory.
