# Distributed Chess Search: How the Demo Works

This guide describes the running project shown in the browser: four backend nodes and a chess-search frontend. In the screenshot, Node 4 is leader in term 17; Nodes 1–3 are followers, and the leader has three registered workers.

## What happens when you search

1. The board supplies a FEN position. The Search button sends that position, the selected depth, and the bound-sharing option to the current leader.
2. The leader splits the position into legal first moves and assigns those moves to followers using HTTP RPC (`POST /rpc/search`). The leader coordinates; it does not search chess positions itself.
3. Each follower searches its assigned move and returns its score, node count, and time to the leader. The leader fills the Master Table and selects the best result when all rows finish.
4. The Compare button runs the same position twice: once with bound sharing and once without. It reports the node counts and best moves so you can see the pruning effect.
5. The Bound Broadcast Log shows workers sending improved search bounds to the leader and the leader relaying them to other workers. The progress socket carries table updates and completed-search results to the browser.

## Bound sharing and alpha–beta pruning

Alpha–beta search avoids exploring branches that cannot improve the current answer. During a distributed search, workers can discover useful bounds independently. The leader keeps the best current global bound and broadcasts improvements to workers still searching. A worker can use a valid bound to prune work. This changes how much work is done, not the intended best move or score. The Lamport stamp on a bound message is also checked defensively so an obviously old bound is not applied to a newer search.

## Heartbeats and Bully leader election

The leader sends each peer an HTTP heartbeat about once per second. A successful heartbeat tells the leader that the peer is reachable; failures change that peer's status to DOWN, and recovery changes it back to UP. Followers record the time of the last heartbeat using their local elapsed-time clock. If that time exceeds about three seconds, a follower logs `HEARTBEAT_LOST` and starts an election.

The election uses the **Bully algorithm**. A candidate asks nodes with higher IDs whether they are alive. A higher-ID node responds and starts or continues its own election. If no higher-ID node responds, the candidate becomes leader, increments the term, and announces itself to peers. With several nodes starting together, the highest reachable ID normally wins. A restarted higher-ID node follows the current leader; it does not preempt it just because its ID is higher.

The `term` is the election epoch. Messages from an older term are rejected so a former leader cannot take control again using stale messages. Terms identify leadership generations; they are separate from Lamport clock values.

## Replication and recovery

The leader periodically sends followers a full JSON state replica. Search start, move results, bound changes, and other important state changes also schedule replication, debounced so bursts are combined. A periodic full snapshot is sent every five seconds as anti-entropy, which catches up a restarted or temporarily disconnected follower. Followers show the received replica version in their cards.

If the leader fails, an elected replacement loads its latest in-memory replica and resumes any unfinished search after workers reconnect. Completed move rows are retained; work that was assigned to the failed leader's workers can be assigned again. Replication is asynchronous, so the last very recent update might not have reached a follower before a crash.

## Lamport logical clocks and the event log

Each node has a Lamport counter. It advances when the node logs an event or sends a stamped message. On receiving a stamped message, the node advances its counter past both its own value and the received value. This makes a cause-and-effect chain sort forward: for example, a worker's bound update, the leader's relay, and a receiver's event.

The event log is ordered by `(Lamport clock, node ID)`. The node ID breaks ties when two independent nodes happen to have the same counter. Lamport clocks provide causal ordering; they do not measure real elapsed time, and a smaller value alone does not prove that one event caused another. The Time column remains a wall-clock display for context.

## Clock synchronization

The Clock sync control uses **Cristian's algorithm** when enabled. A follower requests the leader's current time, measures round-trip time with a local monotonic timer, and estimates the leader time at reply using half the round-trip time. It samples several times and uses the lowest-RTT sample. This adjusts displayed/sent wall timestamps; heartbeat timeouts and election timers continue to use local elapsed time, so clock correction cannot trigger an election. In the screenshot, clock sync is OFF.

## What the visible controls and panels mean

- **Cluster cards:** current role, election term, Lamport counter, raw simulated clock offset, sync state, heartbeat age, and latest replica version. The leader does not receive leader heartbeats, so its heartbeat age is shown as a dash. Its worker count is the number of followers registered over Socket.IO.
- **Enable bound sharing:** lets the leader relay useful bounds during this search. When unchecked, workers search without receiving those cross-worker bound improvements.
- **Run Distributed Search:** starts one search on the leader and displays each assigned root move in the Master Table.
- **Compare With/Without Bounds:** runs two real searches to compare node counts with bound sharing enabled and disabled.
- **Bound Broadcast Log:** shows sender, relay, and receiver Lamport stamps alongside wall-clock timestamps. The Lamport chain is the reliable ordering evidence; wall-clock delays can be misleading if machine clocks differ.
- **Cluster Event Log:** shows node events, ordered by Lamport clock. The replication checkbox includes otherwise-hidden replication traffic.
- **Undo Move / Reset Board / Apply best move:** change the local chess position. The next search uses the resulting board position.

## Where Kubernetes fits

Kubernetes is the container orchestrator for the demo, not part of the chess-search or election algorithm. Each backend node runs in its own container/pod. A StatefulSet gives the nodes stable identities (`chess-node-0` through `chess-node-3`), and per-node Services give them stable network names so they can send heartbeats, replication messages, and search RPCs to one another. The frontend runs in a separate Deployment and Service.

The local `kind` cluster runs Kubernetes inside Docker. `npm run k8s:deploy` builds the images, loads them into kind, applies the manifests, and waits for the pods to start. `npm run k8s:up` forwards the frontend and node ports to the PC so the browser and local demo commands can reach them. Deleting or pausing a backend pod demonstrates a node failure; Kubernetes may recreate a deleted pod because it maintains the StatefulSet's desired replica count. The application heartbeat and Bully election detect the interruption and select a leader—the Kubernetes controller itself does not elect the chess leader.

## Course concepts represented

This project demonstrates heartbeat-based failure detection, Bully election, replicated state, Lamport logical clocks, Cristian clock synchronization, and centralized coordination of distributed search work. It does not implement vector clocks, global-state snapshots, or distributed deadlock detection; those are separate course topics and are not needed by this search workflow.
