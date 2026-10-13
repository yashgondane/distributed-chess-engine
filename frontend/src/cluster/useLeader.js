import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { NODES } from './nodes';

export default function useLeader() {
  const [cluster, setCluster] = useState({ leader: null, term: 0, nodes: [], events: [] });
  const [storeView, setStoreView] = useState(null);
  const [lockView, setLockView] = useState(null);
  const leaderRef = useRef(null);

  const refreshStore = useCallback(async () => {
    const current = leaderRef.current;
    if (!current?.url) { setStoreView(null); return; }
    try {
      const { data } = await axios.get(`${current.url}/store/view`, { timeout: 1200 });
      setStoreView(data);
    } catch { setStoreView(null); }
  }, []);

  const refreshLock = useCallback(async () => {
    const current = leaderRef.current;
    if (!current?.url) { setLockView(null); return; }
    try {
      const { data } = await axios.get(`${current.url}/lock/view`, { timeout: 1200 });
      setLockView({ ...data, nodeId: current.id, receivedAt: Date.now() });
    } catch { /* lock_update socket remains the live path */ }
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      const results = await Promise.allSettled(NODES.map(({ id, url }) =>
        axios.get(`${url}/cluster/status`, { timeout: 700 }).then(({ data }) => ({ id, url, data }))
      ));

      if (!active) return;
      const nodes = results.map((result, index) => {
        const fallback = NODES[index];
        if (result.status !== 'fulfilled') {
          return { id: fallback.id, role: 'DOWN', term: 0, reachable: false,
            url: fallback.url, lastHeartbeatAgeMs: null, replicaVersion: 0, lamport: null, skewMs: null,
            clockSync: null, storeCount: 0 };
        }
        const { id, url, data } = result.value;
        return { id, url, role: data.role, term: data.term, reachable: true,
          lastHeartbeatAgeMs: data.lastHeartbeatAgeMs, replicaVersion: data.replicaVersion,
          lamport: data.lamport, skewMs: data.skewMs,
          clockSync: data.clockSync,
          storeCount: data.storeCount ?? 0,
          workersRegistered: data.workersRegistered,
          events: [...(data.events || []), ...(data.replicationEvents || [])] };
      });
      const leader = nodes.filter((node) => node.reachable && node.role === 'leader')
        .sort((a, b) => b.term - a.term || b.id - a.id)[0] || null;
      leaderRef.current = leader;
      const events = [...new Map(nodes.flatMap((node) => node.events || [])
        .map((event) => [`${event.nodeId}:${event.seq}`, event])).values()]
        .sort((a, b) => (a.lc ?? 0) - (b.lc ?? 0) || a.nodeId - b.nodeId).slice(-200);
      setCluster({ leader, term: leader?.term ?? Math.max(0, ...nodes.map((node) => node.term)), nodes, events });
      if (leader) void refreshStore();
      if (leader) void refreshLock();
    };

    void poll();
    const timer = setInterval(poll, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [refreshStore, refreshLock]);

  useEffect(() => {
    const timer = setInterval(() => void refreshStore(), 3000);
    return () => clearInterval(timer);
  }, [refreshStore]);

  useEffect(() => {
    const timer = setInterval(() => void refreshLock(), 2000);
    return () => clearInterval(timer);
  }, [refreshLock]);

  return { ...cluster, storeView, refreshStore, lockView, setLockView, refreshLock };
}
