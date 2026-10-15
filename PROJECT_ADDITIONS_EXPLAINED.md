# What Was Added to the Chess Engine, and Why

## Starting point

Originally, one **master** accepted a search, split the root chess moves, and sent work to **worker nodes** with HTTP RPC. Workers searched their assigned moves and returned results. The master combined the results and sent progress to the UI. If the master stopped, there was no process to coordinate the workers or finish the request.

## How the new pieces connect

```text
Browser ──search/progress──> Current leader
                                │
                ┌───────────────┼─────────────────┐
                │ heartbeats, elections, snapshots│
                v               v                 v
             Node 1           Node 2            Node 3 ...
             follower         follower          follower
                │               │                 │
                └──── RPC move searches to workers ─┘
```

Every node now runs the same program. A node's **role** decides what it does: the leader coordinates searches; followers search assigned moves and monitor the leader. If leadership changes, the promoted node starts coordinating and the others reconnect to it.

## Failure detection and choosing a replacement

- **Heartbeats** are periodic messages from the leader to its peers. A follower records when it last heard one. If the timeout passes, it suspects that the leader is gone and starts an election. This is needed because otherwise followers cannot distinguish a quiet leader from one that has stopped, and would wait forever.
- The election uses the **Bully algorithm**: a node asks higher-ID peers whether they are alive. A higher node that responds starts its own election. The highest-ID surviving participant wins and announces itself as coordinator. The ID rule makes the winner deterministic among the nodes that take part.
- **Terms** are election epochs. Messages from an older term are rejected, which prevents a former leader from taking control after a newer leader has been elected.
- A node that restarts follows the leader it hears from; it does not preempt that leader just because its ID is higher.

## Keeping enough search state to continue

The leader periodically sends full **replicas** of its coordination state to followers: the active search, each root move's status/result, the global bound, and recent completed-search history. If the leader fails, the new leader restores its latest replica. Completed moves stay complete; work assigned to a lost leader is made pending and can be searched again. This is why replication is connected to failover: election selects a coordinator, while the replica gives that coordinator useful search state.

## Two kinds of time

### Lamport logical clock: event order

Chess does not need a globally accurate physical time to calculate a move. It does need a reliable way to order events that caused one another—for example, a worker sends a bound update, the leader relays it, and another worker receives it. Each node's Lamport counter advances on local events and incorporates the counter on received messages. Thus the send, relay, and receive stamps increase in causal order, even if machine clocks disagree. Concurrent events can still be ordered for display by `(counter, node ID)`; that tie-break does not mean one caused the other.

The UI and diagnostic endpoints use these stamps to make cluster event and bound-update order understandable. A stale-bound guard also ignores a relayed bound from before the current search began. Lamport time does not tell us the real time or duration between events.

### Physical clock synchronization: approximate wall time

The project also includes **Cristian's clock synchronization**. Followers ask the current leader for its wall-clock time several times and use the lowest-round-trip sample to estimate an offset. The UI can show the raw simulated clock skew and the estimated error after synchronization; bound-log wall delays become easier to interpret when clocks are aligned.

This is for wall-clock display and diagnostics, not for deciding chess results or detecting leader failure. Heartbeat timeouts and election waits use each process's local elapsed-time clock, so clock correction cannot trigger a false election. Cristian's estimate is approximate and depends on network delay and on the leader's clock being a useful reference.

## Search mutual exclusion and leases

There is one worker pool and one active search state per leader, so overlapping search requests could overwrite or mix that state. A **centralized FIFO lock** at the leader queues normal searches and Compare runs. A grant has a monotonically increasing fencing number; a late result from an expired grant is rejected. Progress renews the lease, and a lease timeout frees the lock if its holder stops making progress. Lock state is replicated so a new leader can restore the holder and queue.

This is a mutual-exclusion mechanism for the search resource. It is not a deadlock detector. The implemented lock has one coordinator and one queued resource, so this project does **not** implement Lodha–Kshemkalyani, Knapp's deadlock-detection classifications, or a distributed wait-for-graph detector. A crashed lock holder is handled by lease expiry; that is crash recovery, not general deadlock detection.

## Distributed analysis cache

Completed search results can be cached across nodes. A consistent-hash ring chooses two storage owners for each position-and-depth key. A later search checks those owners and can return a cached result; if one copy is missing, a read can repair it. Compare bypasses the cache so it measures actual search work. This store reduces repeated computation and can still serve a result when one owner is down; it is a small result cache, not a transactional database.

## In one sentence

The original master/worker RPC search is still the computation path; heartbeats and Bully elections replace a failed coordinator, replicas preserve its search state, Lamport clocks order cross-node events, Cristian sync makes wall-clock displays more comparable, the lock protects the shared search pool, and the hash-ring store reuses completed work.

## Scope note

These additions demonstrate selected ideas from synchronization, election, mutual exclusion, and distributed storage. They do not implement vector clocks, global-state snapshots, beacon protocols, distributed deadlock detection, blockchain, Hadoop, Kubernetes, or a general-purpose distributed database.
