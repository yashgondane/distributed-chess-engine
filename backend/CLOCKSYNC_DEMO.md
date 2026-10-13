# Cristian clock sync demo

```powershell
cd backend
npm run start:all:skew
```

In the UI, run a depth-4 search with bound sharing ON to show raw skew and negative Bound Log delays.
Click **Clock sync: OFF** to enable synchronization, wait 15 seconds, then run another search.
Point at the raw clock offset vs the small after-sync simulation error, the toggle, and positive delays.

Limitations:
- Error is bounded by RTT/2; on one machine RTT is tiny, so the demo error is optimistic.
- The leader is one time server; if it is wrong, every follower follows it.
- This is Cristian's algorithm, not NTP or Berkeley clock synchronization.
