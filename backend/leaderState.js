const { now } = require('./lamport');
class LeaderState {
  constructor(){ this.currentSearch=null; this.history=[]; this.version=0; this.lockManager=null; this.lock=null; }
  toSnapshot(term,leaderId){
    const search=this.currentSearch;
    const currentSearch=search?{
      searchId:search.searchId,fen:search.fen,depth:search.depth,boundSharing:search.boundSharing,
      startedAt:search.startedAt,lockRequestId:search.lockRequestId,fence:search.fence,moves:(search.assignments||search.moves||[]).map(a=>({
        move:a.move,status:a.status==='failed'?'pending':a.status,assignedTo:a.workerId??a.assignedTo??null,
        score:a.score??null,nodesExplored:a.nodesExplored||0,timeMs:a.timeMs||0,
      })),globalBound:search.globalBound??null,
      globalBoundFrom:search.globalBoundFrom??null,
    }:null;
    return {term,version:this.version,leaderId,takenAt:now(),currentSearch,history:JSON.parse(JSON.stringify(this.history)),lock:this.lockManager?.snapshot() || this.lock || null};
  }
  static fromSnapshot(s){
    const x=new LeaderState();
    if(s){
      x.version=s.version||0;x.history=s.history||[];x.lock=s.lock||null;
      const c=s.currentSearch;
      x.currentSearch=c?{...c,assignments:(c.assignments||c.moves||[]).map(a=>({
        move:a.move,status:a.status==='assigned'?'pending':a.status,workerId:a.status==='assigned'?null:(a.assignedTo??a.workerId??null),
        score:a.score??null,nodesExplored:a.nodesExplored||0,timeMs:a.timeMs||0,
      })),boundEvents:[]}:null;
    }
    return x;
  }
  static empty(){ return new LeaderState(); }
}
module.exports=LeaderState;
