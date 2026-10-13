# Failover demo

## Start
1. Terminal 1: `cd backend` then `npm run start:all`.
2. Terminal 2: `cd frontend` then `npm run dev` and open the printed local URL.
3. Wait for Node 4 to show LEADER (term 1), with three registered workers.

## Idle failover
1. In the backend terminal, run `npm run kill:node -- 4`.
2. The panel shows Node 4 DOWN and Node 3 LEADER (term 2); dismiss the leader-change banner if desired.
3. The event log shows `HEARTBEAT_LOST`, `ELECTION_STARTED`, `BECAME_LEADER`, and coordinator events.
4. Run a search; it completes using the two surviving workers.

## Mid-search failover
1. Reset after idle failover by running `npm run kill:node -- 1`, `npm run kill:node -- 2`, and `npm run kill:node -- 3`; then run `npm run start:all` again.
2. Wait for Node 4 to lead.
3. In the UI select depth 4, disable bound sharing, and start a search.
4. While rows are SEARCHING, run `npm run kill:node -- 4` in the backend terminal.
5. The UI shows the lost-leader status, then Node 3 becomes leader; the event log records `SEARCH_RESUMED`.
6. The Master Table completes with 20 unique root moves. The same position without failure returned the same best move and score (`Nc3`, 0).

## Double failover
1. After Node 3 takes over, run `npm run kill:node -- 3`.
2. Node 2 becomes leader (term 3); a search completes using the one surviving worker.

Restarted higher-ID nodes follow the current leader; they do not preempt it.
