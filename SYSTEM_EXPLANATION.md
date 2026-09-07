# Distributed Real-Time Chess Search Engine (FA-1)

## Executive Summary & Overview

This project is a **distributed alpha-beta chess search engine** built for a **Distributed Systems** course (FA-1). It demonstrates how high-complexity computational workloads (game-tree evaluation) can be partitioned across independent execution units (workers) without shared memory, using modern middleware and real-time message broadcasting.

---

## 1. Tech Stack Overview

### **Backend & Distributed Layer**
- **Node.js**: Asynchronous event-driven JavaScript runtime environment.
- **Express.js**: REST API server exposing search control endpoints (`POST /search`, `POST /search/compare`, `GET /workers`).
- **Socket.IO (Server & Client)**: WebSocket abstraction providing event-driven, bidirectional, stream-oriented communication between Master and Workers, and between Master and Frontend.
- **`chess.js`**: Legal move generation, board state management, FEN validation, checkmate/draw detection.

### **Frontend Interface**
- **React (Vite)**: Reactive user interface framework.
- **Axios**: HTTP client for REST API communication.
- **Socket.IO-Client**: Real-time websocket subscription to the `/progress` namespace.
- **Vanilla CSS**: Clean, dark-mode visual interface with custom CSS design tokens.

---

## 2. Game Theory & Chess Engine Mechanics

### **Game Theory Foundation: Minimax Algorithm**
Chess is a **two-player, zero-sum, perfect-information game**. 
- **Zero-Sum**: Whatever score White gains, Black loses by an equal amount ($S_{\text{white}} = -S_{\text{black}}$).
- **Minimax**: White chooses moves to **maximize** the board evaluation score ($+\infty$), while Black chooses counter-moves to **minimize** the board evaluation score ($-\infty$).

### **Static Board Evaluation Formula**
When a search reaches its designated maximum depth, it computes a static numerical score using:
$$\text{Score} = \sum_{\text{White Pieces}} (\text{Material} + \text{PST}) - \sum_{\text{Black Pieces}} (\text{Material} + \text{PST})$$

1. **Material Values**:
   - Pawn ($p$): $100$
   - Knight ($n$): $320$
   - Bishop ($b$): $330$
   - Rook ($r$): $500$
   - Queen ($q$): $900$
   - King ($k$): $20000$ (terminal priority)

2. **Piece-Square Tables (PST)**:
   - 64-element positional weight matrices that reward controlling central squares ($d4, e4, d5, e5$), advancing pawns, knight outposts, and king safety in early/mid game.

3. **Special Terminal States**:
   - Checkmate: $+20000$ if root player delivered checkmate; $-20000$ if root player is checkmated.
   - Draw (Stalemate / 3-fold repetition / Insufficient material): $0$.

---

## 3. Alpha-Beta Pruning & Distributed Bound Sharing

### **Sequential Alpha-Beta Pruning**
In standard sequential minimax, $\alpha$ represents the minimum score the maximizing player is assured of, and $\beta$ represents the maximum score the minimizing player is assured of. If $\beta \le \alpha$, the opponent has a counter-move that renders the current branch irrelevant, so the rest of the branch is **pruned** (skipped).

### **Distributed Root-Move Partitioning**
The Master process extracts all legal root moves (e.g., 20 legal opening moves) from the current FEN position and distributes them across connected worker processes.
- Worker 1 receives move $m_1$ (`Rb7`)
- Worker 2 receives move $m_2$ (`Rb6`)
- Worker 3 receives move $m_3$ (`Ra8`)

Each worker searches its assigned root move to depth $D-1$ by evaluating all opponent reply branches.

### **Mid-Search Distributed Bound Sharing**
When Worker 3 finishes searching move `Bb7+` and discovers a guaranteed score of $+3315$:
1. Worker 3 emits a `bound_update` event: `{ workerId: 3, value: 3315, ts: timestamp }`.
2. Master updates its `globalBound` and immediately broadcasts a `global_bound` message to Worker 1 and Worker 2.
3. When Worker 1 evaluates its next move, it checks the live global bound ($+3315$). If White's best possible score in Worker 1's branch falls below $+3315$, Worker 1 **prunes the entire branch immediately**.

### **Why Bound Sharing is Crucial (Real Metrics from your Run)**
- **Without Bound Sharing**: 25,880 nodes explored.
- **With Bound Sharing**: 8,743 nodes explored.
- **Pruning Efficiency**: **17,137 nodes saved (66.2% reduction in search work)**!

---

## 4. Distributed Systems Concepts Implemented (FA-1 Scope)

### **1. Architecture Pattern: Centralized Master-Worker Architecture**
- **Master**: Serves as the central coordinator. It maintains job queues, partitions root moves, aggregates final results, and relays inter-worker bounds.
- **Workers**: Autonomous computational nodes that pull tasks, execute pure search workloads, and broadcast state updates via message passing.

### **2. Single-Machine Distribution (Why is it "Distributed" on 1 PC?)**
A system is **distributed** if it consists of independent processes communicating solely via network protocols (IP/Sockets) without shared memory or shared threads.
- Each worker (`node worker.js --id <n>`) runs in its **own separate Operating System process**.
- Each process has its **own isolated memory heap (V8 instance)**.
- Communication occurs exclusively through loopback TCP sockets (`127.0.0.1:3001`) using Socket.IO message frames.
- Scaling to 10 machines across AWS/LAN requires **zero code changes**—only changing `MASTER_URL` from `localhost` to an external IP.

### **3. RPC-Style Communication**
- Master $\to$ Worker move assignment is implemented via **plain HTTP-based RPC**. Each worker hosts its own Express HTTP server on a distinct port (e.g. `4001`, `4002`). Master sends a blocking `POST /search` request to the worker with the position and move, and `await`s the response JSON payload containing score, node count, and execution time upon search completion.

### **4. Message-Oriented Middleware (MOM)**
- **Decoupled Asynchronous Events**:
  - `bound_update` & `global_bound`: Peer-to-peer bound synchronization via Master relay over Socket.IO.
  - `bound_received`: Delivery confirmation metrics.

### **5. Stream-Oriented Communication**
- The Master exposes a dedicated Socket.IO `/progress` namespace.
- As workers explore nodes, they periodically stream progress updates (`progress_update`) to Master, which relays them to the frontend. This provides a live, non-blocking real-time dashboard UI.


---

## 5. Frontend Visual Layout & Component Breakdown

### **1. Chessboard Section (`GameBoard.jsx`)**
- Renders an interactive 8x8 grid displaying piece positions from the current game FEN.
- Allows users to drag and drop pieces to create custom tactical positions.

### **2. Search Controls Panel (`App.jsx`)**
- **Depth Slider**: Configures evaluation depth (depth 1 to 4).
- **Enable Bound Sharing Toggle**: Toggles distributed bound broadcasts on/off.
- **Run Distributed Search Button**: Sends `POST /search` request.
- **Compare With/Without Bounds Button**: Triggers back-to-back searches to benchmark pruning efficiency.

### **3. Master Table (`MasterTable.jsx`)**
Displays a live telemetry table of worker assignments:
- **Worker**: ID of the worker processing the move (`1`, `2`, `3`).
- **Move**: Assigned root SAN move (e.g., `Rb7`, `f6`, `Qxd4#`).
- **Score**: Evaluated score (e.g., `3265`, `20000` for checkmate).
- **Nodes**: Number of game tree positions explored for that move.
- **Time (ms)**: Time spent by the worker on that move.
- **Status**: Current move status (`searching`, `complete`, `reassigned`).

### **4. Bound Broadcast Log (`BoundLog.jsx`)**
Visualizes message propagation latency:
- **From**: Originating worker (`W3`).
- **Value**: Improved bound score broadcasted (`3315`).
- **Sent / Relayed / Received Timestamps**: Exact millisecond timestamps showing network transmission and relay delays ($12-24\text{ ms}$).

### **5. Nodes Explored Comparison Chart (`ComparisonChart.jsx`)**
- Displays a visual bar chart comparison showing node savings achieved through bound sharing vs independent search.
