// thread/read stays fresh: file authorization rechecks it after taking a lease.
const reads=new Set(["thread/list","thread/turns/list","config/read","model/list","permissionProfile/list"]);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
// Share only identical requests while they are pending. Authorization and
// per-client result filtering still run for every caller; no result TTL cache.
export class ReadRequestCoalescer {
  constructor(){this.pending=new Map();}
  run(method,params,read){
    if(!reads.has(method))return Promise.resolve().then(read);
    const key=method+JSON.stringify(canonical(params));if(this.pending.has(key))return this.pending.get(key);
    if(this.pending.size>=128)return Promise.resolve().then(read);
    const promise=Promise.resolve().then(read).finally(()=>this.pending.delete(key));this.pending.set(key,promise);return promise;
  }
}
