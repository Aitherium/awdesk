/* global window, navigator, KVHolder, setTimeout, setInterval */
// The engine page Desk keeps hidden while lending memory. Desk's main process owns the policy
// (AC, idle, no game, the owner's switch) and the device key; this page owns the holder and
// the link, and reconnects with back-off while it is open.
(async function () {
  'use strict';
  const cfg = await window.kvlend.config();
  let engine = null, holder = null, state = 'connecting', backoff = 1000, lastErr = '';
  try { if (navigator.gpu) engine = await KVHolder.GpuEngine.create(navigator.gpu, {}); } catch { engine = null; }
  if (!engine) engine = new KVHolder.CpuEngine();
  holder = new KVHolder.Holder(engine, cfg.mb * 1048576, cfg.deviceId);
  const report = () => window.kvlend.status({
    state, engine: engine.describe(), held: holder && holder.cfg ? holder.maxHeld() : 0,
    calls: holder ? holder.calls : 0, last_ms: holder ? holder.lastMs : 0, error: lastErr,
  });
  function dial() {
    state = 'connecting'; report();
    KVHolder.connect(cfg.relay, '', holder, {
      hello: () => window.kvlend.hello(),
      attached: () => { state = 'attached'; backoff = 1000; lastErr = ''; report(); },
      error: (e) => { lastErr = String(e); report(); },
      closed: () => { state = 'retrying'; report(); setTimeout(dial, backoff); backoff = Math.min(backoff * 2, 15000); },
    });
  }
  dial();
  setInterval(report, 5000);
})();
