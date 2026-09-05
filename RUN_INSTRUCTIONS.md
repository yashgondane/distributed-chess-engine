# Distributed Chess Search Engine (FA-1)

This project runs a **master** process that splits root moves across **worker** processes.
Workers run alpha-beta search independently and share score bounds mid-search to prune faster.

## Prerequisites

- Node.js 18+
- Three terminal windows (master, workers, frontend)

## 1. Install dependencies

```powershell
cd backend
npm install

cd ..\frontend
npm install
```

## 2. Start the Master

```powershell
cd backend
node master.js
```

Master listens on `http://localhost:3001`:
- `POST /search` — start distributed search `{ fen, depth, boundSharing }`
- `POST /search/compare` — run same position with/without bound sharing
- `GET /workers` — list connected workers
- Socket.IO default namespace — workers
- Socket.IO `/progress` namespace — frontend live updates

## 3. Start Workers (one or more terminals)

```powershell
cd backend
node worker.js --id 1
node worker.js --id 2
node worker.js --id 3
```

Each worker connects to the master and waits for move assignments.

## 4. Start the Frontend

```powershell
cd frontend
npm run dev
```

Open the URL shown (usually `http://localhost:5173`).

## Usage

1. Drag pieces on the board to set up a position.
2. Set search depth and toggle bound sharing.
3. Click **Run Distributed Search** — the master table updates live via Socket.IO.
4. Click **Compare With/Without Bounds** for the bar chart comparison.
5. Apply the suggested best move when search completes.

## Architecture

```
[Browser]  <--Socket.IO /progress-->  [Master: Express + Socket.IO]
                                              |
                                   Socket.IO (assign/result/bound)
                                              |
                            [Worker 1]  [Worker 2]  ...  [Worker N]
```

## Legacy single-process server

The original MongoDB-backed engine is still in `server.js`. FA-1 uses `master.js` + `worker.js` instead.
