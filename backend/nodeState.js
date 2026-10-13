const { LamportClock, now, setClockSyncState } = require('./lamport');
const AnalysisStore = require('./store');

class NodeState {
  constructor({id, port, peers}) {
    this.clock = new LamportClock();
    this.clockSync = { enabled: process.env.CLOCK_SYNC_ENABLED === '1', syncOffsetMs: 0,
      lastSyncAt: null, bestRttMs: null, errorBoundMs: null, source: null, syncInProgress: false };
    setClockSyncState(this.clockSync);
    this.id=id; this.port=port; this.peers=peers; this.role='follower'; this.term=0; this.leaderId=null;
    this.lastHeartbeatAt=Date.now(); this.electionInProgress=false; this.replica=null; this.replicaVersion=0;
    this.leaderState=null; this.peerStatus=Object.fromEntries(peers.filter(p=>p.id!==id).map(p=>[p.id,'DOWN']));
    this.lockManager=null;
    this.events=[]; this.replicationEvents=[]; this.boundLog=[]; this.eventSeq=0;
    this.heartbeatLostLogged=false; this.workersRegistered=0;
    this.store = new AnalysisStore(id, { log: (type, detail) => this.log(type, detail) });
  }
  log(type, detail={}) {
    const e={seq:++this.eventSeq,ts:now(),lc:this.clock.tick(),nodeId:this.id,type,detail};
    const isReplication = type === 'REPLICATED' || type === 'REPLICA_RECEIVED';
    const history = isReplication ? this.replicationEvents : this.events;
    history.push(e);
    if (history.length > 200) history.shift();
    console.log(`[Node ${this.id}] ${type}`, detail);
    return e;
  }
}
module.exports=NodeState;
