





export class Bus {
  constructor() { this.subs = {}; this.state = {}; this.reset(); }
  reset() {
    Object.assign(this.state, {
      t: 0,            
      runT: 0,         
      sense: { energy: 0, groove: 0, inputs: null },
      phase: null,     
      claims: {},      
      cue: null,       
      off: {},         
      said: [],        
    });
  }
  on(name, fn) { (this.subs[name] ||= []).push(fn); return () => { this.subs[name] = this.subs[name].filter((f) => f !== fn); }; }
  emit(name, data) { for (const fn of this.subs[name] || []) { try { fn(data); } catch (e) { console.warn('[bus]', name, e); } } }
  claim(id, patch) {
    const c = (this.state.claims[id] ||= { state: 'pending', t: this.state.t });
    Object.assign(c, patch, { t: this.state.t });
    this.emit('probe', { id, ...c });
    return c;
  }
}
