(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);

  let state = { subs: [], selectedId: null, settings: {} };
  let vpn = { state: 'disconnected', serverId: null, error: null };
  const pings = {};

  const serverById = (id) => state.subs.flatMap((s) => s.servers).find((x) => x.id === id);

  // Windows не рисует флаги-эмодзи, а панели кладут в название ещё и код страны — убираем оба
  function cleanName(name) {
    return String(name || '')
      .replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, '')
      .replace(/^[A-Z]{2}\s*/, '');
  }

  function render() {
    const power = $('#widgetPower');
    power.className = 'widget-power' + (vpn.state === 'connected' ? ' on' : '') + (vpn.state === 'connecting' ? ' busy' : '');
    $('#widgetState').textContent = vpn.state === 'connected' ? 'Подключено' : vpn.state === 'connecting' ? 'Подключение…' : 'Отключено';
    const id = vpn.state === 'disconnected' ? state.selectedId : vpn.serverId;
    const server = serverById(id);
    const ping = id && pings[id];
    $('#widgetServer').textContent = server ? `${cleanName(server.name)}${ping ? ` · ${ping} мс` : ''}` : 'Нет подписки';
  }

  $('#widgetPower').onclick = async () => {
    if (vpn.state === 'connecting') return;
    if (vpn.state === 'connected') { await marin.disconnect(); return; }
    if (!state.selectedId) return;
    await marin.connect(state.selectedId);
  };
  $('#widgetClose').onclick = () => marin.hideWidget();

  async function ping() {
    const sub = state.subs.find((s) => s.servers.some((x) => x.id === state.selectedId));
    if (!sub) return;
    const r = await marin.pingAll(sub.id, state.settings?.pingType);
    if (r.ok) { Object.assign(pings, r.data); render(); }
  }

  marin.onState((s) => { state = s; render(); });


  (async () => {
    const r = await marin.state();
    if (r.ok) { state = r.data; render(); }
    ping();
  })();
  setInterval(ping, 30000);
})();
