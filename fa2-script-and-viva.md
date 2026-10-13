# FA-2 script, syllabus map and viva answers (Units 3-4)

Everything below is something you built and ran. Where something is NOT built, it says so, and the honest answer is given.

---

## A. Numbers you may quote (all measured by the agent on your machine)

| Claim | Number |
|---|---|
| Nodes searched with bound sharing vs without (depth 4, start position) | about 20-22.6k vs 41,502 (about 45-52% fewer). The with-sharing figure varies per run (seen: 22,544 / 22,606 / 22,621 / 20,013) because bound delivery timing varies. The without figure is always 41,502. |
| Best move / score, start position | Nc3, 0 (every run, every stage) |
| Lamport chains checked | 30 bound chains, all satisfy sentLc < relayLc < recvLc |
| Clock skew demo | node clocks 0 / +8000 / -5000 / +2000 ms; wall-clock delay went negative; Lamport order all pass |
| Cristian sync | 9 unit tests pass; after sync the simulated error between nodes is within 50 ms; sync survived a leader kill |
| Election | Bully with terms; new leader at term 2 and 3 after kills; search resumed on the new leader with 20 unique moves |
| Analysis store | first search 517 ms (computed); repeat 10 ms from primary; primary killed -> 13 ms from replica; restarted node reloaded its 1 entry from disk; both owners dead -> recomputed correctly |
| Search lock | queue test PASS (second search started only after first released); lease test PASS; leader killed with 1 holder + 2 queued -> LOCK_RESTORED showed 1 holder, 2 queued, both queued searches finished with 20 rows, Nc3, 0 |
| Tests | `npm test`: 19 passed, 0 failed |

Say "about" and "varies slightly run to run". Do not say 22,544 as if it were fixed.

---

## B. Syllabus map (say this on the "what we covered" slide)

| Syllabus topic | Status | Where in the project |
|---|---|---|
| Clock synchronization: physical clocks, Cristian | BUILT | Each node has a simulated skew; followers sync to the leader (time server), 5 samples, min-RTT, error <= RTT/2 |
| Logical clocks: Lamport | BUILT | Every message and event stamped; bound chain and event log ordered by (lc, nodeId) |
| Logical clocks: vector clocks | NOT built | Explain the difference (see viva Q5). Lamport was enough because we only need an ordering for logs and a stale-bound guard, not concurrency detection |
| Election algorithms | BUILT | Bully with terms, heartbeat failure detector |
| Global state / snapshots | PARTLY | Leader replicates a state snapshot to followers (version, term, search state). This is a practical state replication, NOT Chandy-Lamport. Be honest. |
| Mutual exclusion | BUILT (centralized) | Leader is lock coordinator for the search pool; fair FIFO queue, lease, fencing token. Ricart-Agrawala and Maekawa NOT built |
| Deadlocks | NOT built, by design | See viva Q10 |
| Distributed storage (Unit 4) | BUILT | Consistent-hashing ring, 2 replicas per entry, disk persistence, read repair |
| Fault tolerance / replication | BUILT | State replication, store replicas, failover with resume |
| CAP, case studies (Hadoop, Kubernetes, AWS, Cloudflare, Megaport, serverless) | SLIDES | Mapping on slides 10-11 below. These are discussion, not code |

---

## C. Slide plan with script (about 10 minutes + 5 minute demo)

**Slide 1: Title.** "Real-Time Distributed Chess Search Engine, extended."
Say: "Last time we showed root-split alpha-beta search across processes with global bound sharing. This time we made the system survive failures and stay consistent across nodes."

**Slide 2: Recap in one slide (FA-1).** Master-worker, root splitting, bound sharing, three communication styles (RPC, message-oriented, stream-oriented).
Say: "That version had one weakness: the master was a single point of failure and nodes only cared about wall-clock time. FA-2 fixes the system around the search, not the search."

**Slide 3: From master-worker to a symmetric cluster.** Diagram: 4 nodes, each can be leader or follower; one leader.
Say: "Every node runs the same program. One is the leader; the rest follow. If the leader dies, one of the followers takes over and finishes the search."

**Slide 4: Failure detection and election (Bully).** Heartbeat every 1 s, timeout 3 s; highest id wins; terms prevent stale leaders.
Say: "Followers detect a dead leader by missing heartbeats. The surviving node with the highest id wins, and the election term goes up. We killed the leader mid-search; node 3 became leader at term 2 and the search finished with the same 20 moves."

**Slide 5: State replication and resume.** Leader sends snapshots to followers (debounced 250 ms, plus periodic anti-entropy).
Say: "Followers hold a copy of the leader's state: which moves are done, the global bound, history. On failover the new leader resumes instead of restarting. Only the last 250 ms can be lost, and since search is idempotent, that is safe."

**Slide 6: Physical clocks and Cristian's algorithm.** Formula slide: theta = (T + RTT/2) - local; error <= RTT/2; take min-RTT of 5 samples.
Say: "We simulated clock skew of +8 s and -5 s. Without sync, the Bound Log showed negative delays, which is physically impossible. After Cristian sync, delays were small and positive. The leader is the time server, and keeps its offset on promotion so cluster time does not jump."

**Slide 7: Logical clocks, Lamport.** The bound chain example: worker L=10 -> sends 11 -> leader receives max(40,11)+1=41, relays 42 -> other worker receives max(5,42)+1=43.
Say: "Even when wall clocks are wrong, Lamport stamps order the chain: 11 < 42 < 43. We checked 30 real bound chains. A smaller stamp does not prove causality; it only guarantees that if A caused B, A's stamp is smaller."

**Slide 8: Mutual exclusion: the search lock.** Leader as coordinator, FIFO queue, lease, fencing token, lock state replicated.
Say: "Two users searching at once would fight over one worker pool, so searches take a lock held by the leader. Waiting requests queue in order. The lock has a lease, so a crashed holder cannot block everyone. A fencing token makes sure a late result from an expired holder is thrown away. When we killed the leader with one running search and two queued, the new leader restored the holder and both queued entries."

**Slide 9: Distributed storage: the analysis store.** Ring picture with 4 nodes, key -> primary + replica; read repair; disk persistence.
Say: "Finished analyses are stored by consistent hashing, each on two nodes. First search 517 ms; repeat 10 ms. Kill the primary and the replica serves it. Restart it and it reloads from disk. If both are dead we simply recompute, so the store is a cache, never a source of errors."

**Slide 10: CAP and our choices.**
Say: "During a failover we choose availability for reads: the replica answers even if it might miss the very latest write. Results are deterministic for (position, depth), so a stale or duplicated value is never wrong; that is why we can afford eventual consistency. The lock is the opposite: it needs consistency, which is why it is centralized and briefly unavailable during an election."

**Slide 11: Case studies mapped to what we built.** (Keep this short and explicit about what is analogy.)
- Hadoop: master (NameNode/ResourceManager) plus workers, work split into tasks, re-run when a worker dies; our root-move assignment and re-assignment is the same pattern at small scale.
- Kubernetes: a control plane with leader election (etcd/Raft) and leases, node heartbeats; our heartbeat, election and lease are the same ideas, simpler algorithm (Bully, not Raft).
- AWS: replication across zones; DynamoDB-style consistent hashing is exactly our store ring.
- Cloudflare: global replicated edge cache; our store is a cache of deterministic results with replicas.
- Serverless: stateless workers; our workers are stateless between searches, which is why a new leader can re-assign work.
- Megaport (network interconnect): latency between sites; our RTT-bounded clock error is the same constraint.
Say: "We did not build these systems. We built the same mechanisms in miniature."

**Slide 12: Honest limits.** (See section E.) Say them yourself before sir asks.

**Slide 13: Demo (5 minutes).** Order:
1. `npm run start:all:skew:sync` (or skew off first): show the cluster panel with skews and the Clock sync toggle.
2. Search depth 4: Bound Log shows LC chain; toggle sync off to show `⚠ skew`, on to show positive delays.
3. Search the same position again: "served from cache by node X in N ms"; Analysis Store card shows owners.
4. `npm run kill:node -- <primary>` (Administrator terminal): search again, served by the replica.
5. Two tabs: search in both; second shows Queued #1. Click Hog lock then Search: lease runs out, queue moves.
6. Kill the leader mid-search: banner shows election, new leader, search resumes.
Do not improvise a different order. Run it twice beforehand.

---

## D. Viva questions and honest answers

**Q1. What is distributed about this? Isn't it just APIs?**
Nodes have separate memory and agree on shared facts only by messages: who the leader is (election), what time it is (Cristian), which event came first (Lamport), who may run a search (lock), where data lives (hash ring). Each of those is an algorithm that works under delay and failure, and each can be broken live by killing or skewing a node.

**Q2. Why Bully and not Raft/Paxos?**
Bully is the syllabus algorithm and is simple to demonstrate. It assumes a reliable failure detector and no network partitions; Raft tolerates partitions with majority quorums. We use terms to reject stale leaders, but a network partition could still produce two leaders, and we have not handled that.

**Q3. What happens if two nodes both think they are leader?**
Terms break the tie: the higher (term, leaderId) wins and the other steps down when it sees it. Under a real partition both could run for a while; we did not build quorum protection.

**Q4. Why does a restarted node not take over, even if it has the highest id?**
Deliberate simplification: a running leader is never preempted. A real Bully would let it. We chose stability during a search.

**Q5. Lamport vs vector clocks?**
Lamport: if A -> B then L(A) < L(B), but L(A) < L(B) does not imply A -> B. Vector clocks (one counter per node) can detect concurrency exactly. We only need an ordering for logs and a stale-bound guard, so Lamport suffices. We did not implement vector clocks.

**Q6. Where do you actually use Lamport clocks for something besides display?**
The stale-bound guard rejects a global bound whose stamp is older than the search it arrives at. It is unit-tested but never fires in a normal run, because searchId and term already filter stale bounds. Say that plainly.

**Q7. Cristian's algorithm: what is the error and why take the minimum-RTT sample?**
Error is at most RTT/2, because the server's reply could have been generated anywhere inside the round trip. The smallest-RTT sample has the tightest bound. On one machine RTT is tiny, so our demo error is optimistic.

**Q8. Single time server problem?**
The leader is the only time source; if it is wrong, everyone follows it. Cristian's has this limit; Berkeley and NTP address it differently. We did not build those.

**Q9. Is replication consistent? What can you lose?**
It is asynchronous: the last ~250 ms of state can be lost on a crash. The resumed search recomputes, and search is deterministic, so the final answer is the same. State is in memory only.

**Q10. Are there deadlocks? Did you implement deadlock detection?**
No deadlock detection, deliberately. Deadlock needs hold-and-wait on multiple resources. We have one lock; waiters hold nothing while waiting, and every wait has a timeout (queue wait 60 s, lease expiry, request timeouts). The failure we can have is a stall with zero workers, which is a liveness problem, not a deadlock. We can explain the theory (wait-for graph, detection by cycles) but did not build it because it would be forced.

**Q11. Why a centralized lock and not Ricart-Agrawala?**
Centralized needs 3 messages per entry (request, grant, release) and is simple; it works because we already have a leader. Ricart-Agrawala needs 2(N-1) messages and every node's cooperation, and needs all nodes alive. The cost of centralized is that the coordinator is a single point of failure, which we mitigate by replicating the lock state and re-electing.

**Q12. What is a lease and why is it needed?**
A time-limited grant. If a holder crashes, the lock would be held forever; the lease lets the coordinator reclaim it. Progress updates renew it. The danger is a holder that is only slow, not dead: it keeps running after the lease expires, which is why we have fencing.

**Q13. What is the fencing token?**
A counter that increases with every grant. A result carries the fence it started under; if it is not the current holder's fence, it is discarded. So a zombie holder cannot overwrite newer results.

**Q14. What happens to the lock when the leader dies?**
The lock state is in the replicated snapshot. The new leader restores holder and queue and gives the holder a fresh lease. Queued clients re-POST with the same request id and are re-attached, not duplicated. A grant made in the last ~250 ms may be lost; the client just asks again.

**Q15. How does consistent hashing work, and why not hash mod N?**
Keys and nodes (50 virtual points each) are hashed onto a ring; a key belongs to the next point clockwise, and the next distinct node holds the replica. With mod N, changing N moves almost every key; with the ring, only keys of the changed node move. We tested that: removing a node changes the primary only for keys it owned.

**Q16. What if a storage node dies permanently? Do you rebalance?**
No. Placement is fixed by the 4-node ring and we rely on the replica and read repair. A failed write to one owner is not retried until a read repairs it. A production system would use hinted handoff or rebalancing.

**Q17. Is the store consistent? CAP?**
Results are deterministic per (position, depth), so there are no conflicting writes, last write wins is safe. We favour availability for reads (replica serves). If both owners are down we recompute. The lock favours consistency.

**Q18. Why not just use Redis/etcd/ZooKeeper?**
The point of the assessment is the algorithms. In production you would use etcd or ZooKeeper for election and locking and a replicated store for results. Say you know that, and that building them is how you learned the mechanisms.

**Q19. Is this a computer networks project?**
Networks give you delivery; this project is about what you do when delivery is late, lost or the node is gone: failure detection, agreement on a leader, ordering without a shared clock, exclusion, replication. None of those exist in TCP.

**Q20. What are the limits of your testing?**
One machine, localhost, so latencies are tiny and partitions are not tested. Kill/skew/race are simulated. Unit tests cover the pure logic (19 tests); integration checks were run through the scripts and the UI.

**Q21. What would you do with a real network?**
Run on 4 machines, measure real RTT and real skew, add partition handling (quorum), persistent state for the leader, and consider Raft.

**Q22. How does your replication relate to "global state"?**
It gives followers a recent copy of the leader's state, which is what you need for recovery. It is not a consistent global snapshot of all nodes and channels in the Chandy-Lamport sense; we did not build that.

**Q23. Why does bound sharing node count vary between runs?**
Bounds travel over the network with variable delay. Whether a worker sees a bound before or after it explores a branch changes how many nodes it searches. The answer (best move, score) is always the same. That variation is the stale-information effect the project is about.

**Q24. What happens if a worker dies mid-search?**
Its unfinished root moves are re-assigned to other workers (FA-1 behaviour), and the leader's search continues. If the leader dies, the new leader resumes from the replicated snapshot.

**Q25. If sir asks "what is the most distributed part you built?"**
Answer: the failover. Kill the leader mid-search and a different process finishes the same search, with the lock and the queue intact, and the log ordered by Lamport stamps.

---

## E. Honest limits to say yourself (one slide)

1. A restarted node never preempts a running leader.
2. Asynchronous replication can lose the last ~250 ms (safe, because search is idempotent).
3. State is in memory only (the store is the exception: it is on disk).
4. Tested on one machine; no network partitions.
5. Cristian's error is bounded by RTT/2; localhost is optimistic. The leader is a single time server.
6. Stale-bound guard is unit-tested but never fires live.
7. No vector clocks, no Chandy-Lamport, no Ricart-Agrawala, no deadlock detection, no store rebalancing.

---

## F. Before you present

- Run the whole demo twice. Use an Administrator terminal for `kill:node`.
- Clear the store (`npm run store:clear`) before the demo so the first search is a visible "computed".
- Update FA-1 slide numbers to "about 20-22k vs 41.5k".
- Delete `killNodeAfter.js` if it exists. Zip the folder.
