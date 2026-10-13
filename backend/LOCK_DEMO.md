# Distributed Search Lock Demo

1. `cd backend`
2. `npm run start:all:lock`
3. In the UI, click **Hog lock**, then **Run Distributed Search** with cache off.
4. Verified: the button showed `Queued #1…`; `LOCK_LEASE_EXPIRED` appeared and the search finished with 20 rows.
5. `node check-lock.js queue` verifies FIFO grants; `node check-lock.js lease` verifies lease expiry.
6. For failover, queue two searches behind an active search, then run `npm run kill:node -- 4`.
7. Verified: Node 3 became leader (term 2); `LOCK_RESTORED` showed one holder and two queued IDs.
8. The holder re-attachment returned HTTP 202; both queued searches finished with 20 rows.

Limits:
- The leader is a centralized coordinator, so a leader failure briefly stalls the lock during election.
- Replication is asynchronous; a grant in the last ~250 ms before a crash can be lost, so clients re-request.
- This protects only the search pool; it is not a general or transactional lock service, and Ricart-Agrawala/Maekawa were not implemented.
