# Analysis store — verified run
1. Ran `npm run store:clear`, `npm run start:all`; leader was node 4 with nodes 1–3 registered.
2. `node check-store.js prime`: `hit=false`; key present on nodes 2,4; `PRIME PASS`.
3. `node check-store.js verify`: `hit=true servedBy=4 requestMs=10 cacheLatencyMs=0`; `VERIFY PASS`.
4. Killed primary 4; after 5 s verify returned `hit=true servedBy=2 requestMs=13 cacheLatencyMs=5`; `VERIFY PASS`.
5. Restarted node 4: `STORE_LOADED { count: 1 }`; `/store/keys` returned `count: 1`.
6. With owners 3,4 down, a fresh depth-2 search returned `Nc3`, score `0`, `cache.hit=false`; no crash.
7. After clearing all live nodes, depth-4 search returned `Nc3`, score `0`, 22,606 nodes.
8. Compare runs returned 22,621 then 22,606 with bounds; both returned 41,502 without bounds and `Nc3` for both.
9. Store counts were `0,0,1,1` before and after Compare; no store writes occurred during Compare.

Limits observed in the implementation:
- A permanently dead node remains in the fixed ring; availability relies on its replica and later read repair.
- A failed owner write is not retried until a later read repairs it.
- This is a last-write-wins result cache, not a general database or transactional store.
