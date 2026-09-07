# Distributed Real-Time Chess Engine: System Architecture, DS Theory & Viva Preparation Guide

---

## 1. Executive Summary & File-by-File Interaction Map

### **1.1 Overview of the System**
This project is a **distributed alpha-beta chess evaluation engine** designed to demonstrate core **Distributed Systems (DS)** principles. It splits a complex computational task (evaluating all root moves in a given chess position) across multiple worker processes that run in parallel.

The system showcases **three distinct Unit 2 communication paradigms** within a single application:
1. **RPC-Style Communication (HTTP POST `/search`)**: Master assigns a specific root move to a worker over a blocking HTTP request/response call.
2. **Message-Oriented Communication (Socket.IO Events)**: Workers broadcast bound improvements (`bound_update`) asynchronously through the Master to prune sibling branches across independent worker processes (`global_bound`).
3. **Stream-Oriented Communication (Socket.IO `/progress` Namespace)**: Live telemetry metrics (explored node count, bound deliveries) are continuously streamed to the React frontend dashboard in real time.

---

### **1.2 Complete File Interaction Map**

```
+-----------------------------------------------------------------------------------+
|                                    FRONTEND                                       |
|                                                                                   |
|  [GameBoard.jsx]  <--->  [App.jsx]  ---> [MasterTable.jsx] / [BoundLog.jsx] / etc.|
+-----------------------------|-----------------------------------------------------+
                              | 1. HTTP REST (POST /search, GET /workers)
                              | 2. Socket.IO Stream (/progress)
                              v
+-----------------------------------------------------------------------------------+
|                                    MASTER PROCESS                                 |
|                                     (master.js)                                   |
|                                                                                   |
| - Express Server (Port 3001)                                                      |
| - Socket.IO Server (Default & /progress namespaces)                               |
| - Root Move Extraction via searchEngine.js (getRootMoves)                         |
| - Job Scheduler & Bound Relay Coordinator                                         |
+-----------------------------|-----------------------------------------------------+
                              |
       +----------------------+----------------------+
       | 1. HTTP RPC (POST /search)                  | 2. Socket.IO Events
       |    (Blocking Task Assignment)               |    (bound_update, global_bound, register)
       v                                             v
+-----------------------------------------------------------------------------------+
|                                   WORKER PROCESSES                                |
|                           (worker.js --id 1 --port 4001, etc.)                    |
|                                                                                   |
| - Express HTTP Server (Port 4001, 4002...) -> Receives POST /search               |
| - Socket.IO Client -> Connects to Master (Port 3001)                              |
| - Alpha-Beta Search Engine (searchEngine.js: searchAssignedMove, minimax, PST)    |
+-----------------------------------------------------------------------------------+
```

#### **Detailed Breakdown of Each File**

1. **`backend/master.js` (The Coordinator)**:
   - **Role**: Central manager for move partitioning, HTTP RPC dispatch, bound relaying, and frontend streaming.
   - **Interactions**:
     - Imports `getRootMoves` from `backend/searchEngine.js`.
     - Exposes REST endpoints (`POST /search`, `POST /search/compare`, `GET /workers`) for the browser.
     - Maintains a registry of connected workers (`workers` Map) with their Socket.IO connection and Express `httpPort`.
     - Issues HTTP `POST http://localhost:<httpPort>/search` RPC calls to dispatch root moves to available workers.
     - Relays incoming `bound_update` events from one worker to all other active searching workers as `global_bound` over Socket.IO.
     - Emits live updates to the `/progress` Socket.IO namespace for the React UI.

2. **`backend/worker.js` (The Execution Node)**:
   - **Role**: Independent worker process that executes compute-heavy alpha-beta search.
   - **Interactions**:
     - Imports `searchAssignedMove` from `backend/searchEngine.js`.
     - Hosts an embedded Express HTTP server on a designated port (`4001`, `4002`, etc.) exposing `POST /search`.
     - Maintains a Socket.IO client connection to `http://localhost:3001` (Master).
     - On startup, registers itself with Master via Socket.IO: `socket.emit('register', { workerId, httpPort })`.
     - When receiving `POST /search` from Master, runs `searchAssignedMove()`.
     - During search, emits `progress_update` and `bound_update` over Socket.IO to Master.
     - Once search completes, returns the blocking HTTP response `{ move, score, nodesExplored, timeMs }`.

3. **`backend/searchEngine.js` (The Algorithm Core)**:
   - **Role**: Contains the mathematical chess evaluation logic.
   - **Functions**:
     - `evaluateBoard(board, rootColor)`: Static board evaluation using material values (Pawn=100, Knight=320, etc.) + Piece-Square Tables (PST) + checkmate/draw score.
     - `minimax(board, depth, alpha, beta, ...)`: Recursive sequential minimax with standard alpha-beta pruning.
     - `searchAssignedMove(fen, move, depth, opts)`: Root-move search worker logic. Evaluates opponent reply branches, checks the live `globalBound` mid-search, and triggers `opts.onBoundImprove` / `opts.onProgress` callbacks.
     - `getRootMoves(fen)`: Generates legal moves for White/Black using `chess.js`.

4. **`frontend/src/App.jsx` (The UI Controller)**:
   - **Role**: Main React component managing board state, search depth controls, and real-time dashboard layout.
   - **Interactions**:
     - Sends `POST /search` REST request to `master.js` when user clicks **Run Distributed Search**.
     - Connects to `http://localhost:3001/progress` via Socket.IO Client.
     - Receives `progress`, `bound_event`, `bound_delivery`, and `search_complete` events to reactively update state variables (`tableRows`, `boundEvents`, `bestMove`).

5. **`frontend/src/components/GameBoard.jsx`**:
   - Renders the interactive 8x8 chessboard using `react-chessboard` and handles drag-and-drop piece movement via `chess.js`.

6. **`frontend/src/components/MasterTable.jsx`**:
   - Displays real-time worker telemetry: which worker is assigned which move, nodes explored, evaluated score, execution time, and completion status.

7. **`frontend/src/components/BoundLog.jsx`**:
   - Renders the real-time bound broadcast log showing transmission timestamps (`sentTs`, `relayTs`, `receivedTs`) and latency delays (e.g. `6ms`).

8. **`frontend/src/components/ComparisonChart.jsx`**:
   - Renders a bar chart comparing total nodes explored **With Bound Sharing** vs **Without Bound Sharing**.

9. **`backend/engine.js`, `backend/cache.js`, `backend/server.js`**:
   - Legacy files from single-process implementation (kept for baseline reference; not used in the FA-1 distributed system).

---

## 2. Deep Dive: Communication Models & Design Choices (Unit 2)

### **2.1 Why RPC for Move Assignment? Why Not MOM or WebSockets?**

| Communication Choice | Why It Fits / Why It Was Chosen | Why Other Options Were Rejected |
| :--- | :--- | :--- |
| **HTTP RPC (`POST /search`)** | **Procedure Call Semantics**: Move assignment is conceptually a Remote Procedure Call: `executeSearch(move, depth) -> Result`. The Master invokes a procedure on the worker, blocks asynchronously awaiting execution, and receives a structured result. | **WS/MOM Blur**: Using Socket.IO events for task assignment blurs the distinction between procedural task execution and event-stream broadcasting. |
| **Blocking HTTP Response** | A true RPC requires the procedure caller to wait until the procedure has completed. The worker HTTP endpoint does not respond until alpha-beta evaluation finishes. | **Non-blocking Fire-and-Forget**: Standard message queues require complex correlation IDs to match request messages with async result messages. RPC handles this natively in the HTTP transport layer. |

---

### **2.2 How Failure is Handled**

Fault tolerance is critical in distributed systems. Here is how our architecture handles failures:

```
[Master] ---> HTTP POST /search ---> [Worker 1 (Crashes/Times out)]
   |                                           |
   | (HTTP Request Fails or Timeout Occurs)     x (Process Dead)
   v
[Master Catches Error]
   |
   +---> Re-marks Move as "pending"
   +---> Dispatches Move via HTTP POST /search to [Worker 2]
```

1. **Worker Crash during RPC**:
   - If Worker 1 crashes while searching move `d4`, the pending `fetch()` in `master.js` rejects with a network error (`ECONNREFUSED` or `FETCH_ERROR`).
   - `master.js` catches the error inside `.catch()`, sets move status back to `'pending'`, and immediately calls `distributeMoves()` to assign `d4` to Worker 2.
2. **Worker Disconnection**:
   - If Worker 1's Socket.IO connection drops, Master's `socket.on('disconnect')` fires immediately.
   - Master iterates through `activeSearch.assignments`, finds any moves assigned to Worker 1 that are not complete, resets them to `'pending'`, and reassigns them to remaining connected workers.
3. **Master 60-Second Search Timeout**:
   - Master sets a global 60-second guard timer (`setTimeout`) when starting a search. If workers hang indefinitely, Master completes the search with all available completed results, preventing deadlock.

---

## 3. How a Distributed Chess Engine Works

### **3.1 Sequential Minimax & Alpha-Beta Pruning**
Chess is a **two-player zero-sum game of perfect information**.
- **Minimax**: Maximizer (White) picks moves to maximize board evaluation score ($+\infty$), while Minimizer (Black) picks moves to minimize board evaluation score ($-\infty$).
- **Static Board Evaluation**:
  $$\text{Score} = \sum (\text{Material Value}) + \sum (\text{Piece-Square Table Positional Bonus})$$
- **Alpha-Beta Cutoff**:
  - $\alpha$: Minimum score guaranteed to Maximizer.
  - $\beta$: Maximum score guaranteed to Minimizer.
  - If $\beta \le \alpha$, the opponent has a counter-move that makes the current branch irrelevant $\to$ **pruning occurs**.

### **3.2 Distributed Root-Move Partitioning + Mid-Search Bound Sharing**
In standard sequential search, alpha-beta pruning is fast because bound improvements from move 1 immediately restrict search space for move 2. In a naive distributed search without bound sharing, workers evaluate root moves completely independently, missing out on pruning opportunities across root branches.

**Our Bound Sharing Solution**:
1. Worker 3 evaluates root move `e4` and discovers a guaranteed score of $+50$.
2. Worker 3 emits a `bound_update` event: `{ workerId: 3, value: 50, ts: timestamp }`.
3. Master updates `globalBound = max(globalBound, 50)` and broadcasts `global_bound` to Worker 1 and Worker 2 over Socket.IO.
4. When Worker 1 evaluates opponent replies for move `d4`, it checks `getGlobalBound()`. If Black's best counter-move guarantees White cannot achieve $> +50$, Worker 1 **prunes all remaining reply branches immediately**!

**Real Metric Impact**:
- **Without Bound Sharing**: **25,880 nodes explored**.
- **With Bound Sharing**: **8,743 nodes explored**.
- **Pruning Savings**: **17,137 nodes saved (66.2% reduction in compute!)**.

---

## 4. Distributed Systems Concepts (Unit 1 & Unit 2 Detailed Alignment)

### **Unit 1: Fundamentals of Distributed Systems**
- **Definition**: A distributed system is a collection of autonomous computing entities (processes/nodes) that communicate strictly via network message passing without shared memory, appearing to users as a single coherent system.
- **Why our project is a true Distributed System on 1 Machine**:
  - Worker 1 and Worker 2 run in **completely separate OS processes** (`node worker.js --id 1` and `node worker.js --id 2`).
  - Each process has its **own isolated V8 heap memory**. No shared memory, no shared pointers, no thread locks.
  - All inter-process communication occurs over TCP sockets (`127.0.0.1`). Scaling to 10 separate physical physical machines across AWS requires **zero code changes**—only updating `MASTER_URL`.
- **4 Design Goals Met**:
  1. **Resource Sharing**: Partitioning root search load across multiple CPU process cores.
  2. **Distribution Transparency**: The frontend user makes a single `POST /search` call to Master without knowing which worker evaluated which move.
  3. **Openness**: Well-defined JSON HTTP/Socket interfaces (`POST /search`, `bound_update`).
  4. **Scalability**: Adding Worker 3 and Worker 4 increases search throughput horizontally.

### **Unit 2: Communication Models in the System**
- **Remote Procedure Call (RPC)**:
  - Express `POST /search` on worker ports. Synchronous procedure invocation abstraction built over HTTP.
- **Message-Oriented Middleware (MOM)**:
  - Event-driven Socket.IO messages (`bound_update`, `global_bound`) for asynchronous peer-to-peer bound propagation via central broker.
- **Stream-Oriented Communication**:
  - Real-time continuous progress update stream over Socket.IO `/progress` namespace for UI telemetry.

---

## 5. Expansion Plan for Unit 3 & Unit 4 (Next Steps)

If you are asked how this project can be expanded into **Unit 3 (Synchronization)** and **Unit 4 (Emerging Paradigms)**, here is the roadmap:

### **Expansion to Unit 3: Synchronization & Distributed State**

```
+-----------------------------------------------------------------------------------+
|                               UNIT 3 EXPANSIONS                                   |
+-----------------------------------------------------------------------------------+
| 1. Lamport Logical Clocks: Attach Lamport timestamps L(e) to bound events to      |
|    enforce strict causal ordering across workers despite network jitter.          |
| 2. Leader Election Algorithms: Implement Bully or Ring Algorithm so if Master     |
|    crashes, workers elect a new Master worker automatically.                      |
| 3. Distributed Mutual Exclusion: Use Ricart-Agrawala algorithm for synchronized    |
|    writes to a shared distributed transposition table.                            |
| 4. Distributed Deadlock Detection: Implement Knapp's classification to detect    |
|    orphaned HTTP RPC requests or worker starvation.                               |
+-----------------------------------------------------------------------------------+
```

1. **Lamport Logical Clocks**:
   - *Current*: Bound events use physical timestamps (`Date.now()`), which can suffer from clock skew across different physical machines.
   - *Unit 3 Upgrade*: Assign each bound update a Lamport timestamp $L(e) = \max(L_{\text{local}}, L_{\text{msg}}) + 1$ to guarantee strict causal ordering of global bounds.
2. **Leader Election (Bully / Ring Algorithm)**:
   - *Current*: Single point of failure (if Master process crashes, system halts).
   - *Unit 3 Upgrade*: If workers detect Master heartbeats failing, they execute the **Bully Election Algorithm** (`workerId` with highest ID becomes new Master) to ensure high availability.
3. **Distributed Mutual Exclusion**:
   - *Unit 3 Upgrade*: Implement **Ricart-Agrawala algorithm** or **Lamport's Mutual Exclusion** to synchronize concurrent updates to a shared Transposition Table (hash table of searched positions).

---

### **Expansion to Unit 4: Emerging Distributed Paradigms**

```
+-----------------------------------------------------------------------------------+
|                               UNIT 4 EXPANSIONS                                   |
+-----------------------------------------------------------------------------------+
| 1. Serverless Architecture: Deploy worker search logic as stateless AWS Lambda    |
|    or Cloudflare Workers that auto-scale from 0 to 100 on demand.                |
| 2. Distributed Memory / Caching: Replace local cache with a Redis Cluster        |
|    serving as a Distributed Transposition Table across cloud nodes.               |
| 3. Kubernetes Container Orchestration: Package Master/Workers into Docker images  |
|    with K8s Horizontal Pod Autoscaler (HPA) based on search queue depth.          |
+-----------------------------------------------------------------------------------+
```

1. **Serverless Architectures**:
   - Move move evaluation from persistent Express servers to **AWS Lambda / Cloudflare Workers**. When `POST /search` is called, Master invokes 20 stateless Lambda functions in parallel, scaling compute infinitely and dropping to zero cost when idle.
2. **Distributed Storage & Caching (Redis Cluster)**:
   - Implement a **Distributed Transposition Table** using Redis/Memcached cluster so workers share cached evaluations of transposing chess positions across the network.
3. **Kubernetes Orchestration & Serverless Auto-scaling**:
   - Containerize `master.js` and `worker.js` with Docker and deploy on Kubernetes. Use a Horizontal Pod Autoscaler (HPA) to scale worker pods dynamically based on CPU utilization and search queue depth.

---

## 6. Comprehensive Viva Questions & Solid Answers

### **Category A: Architecture & Distributed Systems (Unit 1)**

#### **Q1: Why is this project called a "Distributed System" when running on a single laptop?**
> **Answer**: A system is defined as distributed based on its **software architecture**, not its physical hardware. Our system consists of multiple independent Operating System processes (`master.js`, `worker.js --id 1`, `worker.js --id 2`), each executing inside its own isolated V8 JavaScript engine instance with separate memory heaps. They do not share memory or pointers. Communication occurs strictly over loopback TCP network sockets (`127.0.0.1`) using HTTP RPC and Socket.IO messages. Deploying this system to 10 physical AWS servers requires zero code modifications—only changing IP addresses.

#### **Q2: What architecture pattern does this project follow, and what are the roles of the master and workers?**
> **Answer**: It follows a **Centralized Master-Worker Architecture**. The Master acts as the coordinator: it receives client search requests, extracts legal root moves, schedules and dispatches tasks to workers via HTTP RPC, relays bound updates, and streams progress to the frontend. The Workers act as autonomous computational nodes: they host an Express HTTP server, listen for task assignments, perform alpha-beta minimax evaluation, and report progress/bounds over Socket.IO.

#### **Q3: What middleware technologies are used here, and what purpose do they serve?**
> **Answer**: We use **Express.js** for HTTP REST/RPC infrastructure and **Socket.IO** for WebSocket-based Message-Oriented Middleware and event streaming. Middleware abstracts away raw OS-level TCP/IP socket programming, providing transport management, serialization, event framing, and reconnection handling.

---

### **Category B: Communication Models (Unit 2)**

#### **Q4: Why did you use HTTP RPC (`POST /search`) for move assignment instead of Socket.IO event messages?**
> **Answer**: Move assignment is functionally a **Remote Procedure Call**: the Master requests a worker to perform a specific procedure (`searchAssignedMove`) with inputs (`fen`, `move`, `depth`) and waits synchronously for a single returned result object. Implementing this as a blocking HTTP `POST /search` request explicitly separates procedural task assignment (RPC) from asynchronous peer-to-peer event broadcasts (MOM bound updates over Socket.IO) and continuous telemetry streaming (Stream-Oriented `/progress` namespace).

#### **Q5: How does the worker HTTP endpoint remain "blocking" without freezing the Node.js event loop?**
> **Answer**: Node.js uses an asynchronous, single-threaded event loop. In `searchAssignedMove`, we insert `await yieldToEventLoop()` (`setImmediate`) during move loops. This yields execution back to the event loop, allowing the worker to receive incoming Socket.IO `global_bound` messages mid-search while keeping the HTTP `POST /search` response pending until the full move evaluation completes.

#### **Q6: How is fault tolerance handled if a worker process crashes during an RPC call?**
> **Answer**: If a worker crashes or drops its connection while processing an HTTP RPC request, the `fetch()` promise in `master.js` rejects. The Master catches this error in `.catch()`, resets the move's status from `'assigned'` back to `'pending'`, and reassigns the move to another active worker. Furthermore, if a worker disconnects from Socket.IO, Master's `disconnect` handler detects it and reassigns all uncompleted tasks.

---

### **Category C: Chess Engine & Distributed Alpha-Beta Pruning**

#### **Q7: How does distributed bound sharing reduce the number of explored search nodes?**
> **Answer**: In sequential alpha-beta pruning, $\alpha$ represents the lower bound of score guaranteed to White. When root moves are split across workers, worker 3 might find a strong move (`e4` scoring $+50$). Worker 3 emits a `bound_update` message over Socket.IO. Master updates `globalBound` and relays `global_bound` to Worker 1 and Worker 2. When Worker 1 evaluates opponent replies for its move (`d4`), it checks the live `globalBound`. If Black's counter-move holds White below $+50$, Worker 1 prunes all remaining reply branches immediately. In our benchmarks, bound sharing reduced node evaluations from **25,880 down to 8,743**—a **66.2% reduction in compute work**.

#### **Q8: How is a chess board statically evaluated when depth reaches zero?**
> **Answer**: We use a static evaluation function combining **material value** (Pawn=100, Knight=320, Bishop=330, Rook=500, Queen=900, King=20000) and positional **Piece-Square Tables (PST)** for all 64 squares. Terminal checkmate states are evaluated as $+20000$ (if root player wins) or $-20000$ (if root player is mated), and draws evaluate to $0$.

---

### **Category D: Future Expansion & Advanced Theory (Unit 3 & Unit 4)**

#### **Q9: How would you address clock skew issues when measuring bound latency across different physical servers? (Unit 3)**
> **Answer**: Physical system clocks (`Date.now()`) can drift across separate physical servers (clock skew). To enforce strict causal ordering of bound events without relying on physical time synchronization protocols (like NTP), we can attach **Lamport Logical Clocks** to every bound message. Each worker increments its local counter $L$ on event generation, and receivers update $L_{\text{local}} = \max(L_{\text{local}}, L_{\text{msg}}) + 1$.

#### **Q10: What happens if the Master process fails? How can we make the architecture peer-to-peer or highly available? (Unit 3)**
> **Answer**: Currently, the Master is a Single Point of Failure (SPOF). To eliminate this, we can implement the **Bully Election Algorithm** or **Ring Election Algorithm** (Unit 3). If workers miss heartbeat signals from Master, they initiate an election round. The worker process with the highest ID assumes the Master coordinator role and takes over job scheduling.

#### **Q11: How could this project be transformed into a Serverless Architecture? (Unit 4)**
> **Answer**: In a serverless model (Unit 4), workers are not persistent Express servers. Instead, move search functions are packaged as stateless cloud functions (e.g. **AWS Lambda** or **Cloudflare Workers**). When a search starts, Master invokes 20 Lambda functions concurrently via HTTP API calls. The cloud provider automatically handles instant scaling, process isolation, and billing per millisecond of compute.

#### **Q12: How would you implement a Transposition Table across distributed workers? (Unit 4)**
> **Answer**: A Transposition Table caches previously evaluated board positions (identified by Zobrist Hashing) to avoid redundant search. In a distributed environment, we can deploy a **Redis or Memcached cluster** (Unit 4 Distributed Storage) accessible to all workers via low-latency network calls or implement **Distributed Hash Table (DHT)** routing across worker nodes.
