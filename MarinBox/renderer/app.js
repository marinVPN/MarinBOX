(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  // Всё из подписок — недоверенные данные: только textContent, никакого innerHTML.
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  let S = { subs: [], selectedId: null, settings: {} };
  let V = { state: 'disconnected', since: null, serverId: null, error: null };
  const DEFAULT_SETTINGS = { startup: false, tray: true, refresh: true, notify: true, autoUpdate: true, tun: false, routePresets: [], theme: 'dark', accent: '', pingType: 'proxy-get', healthCheck: true, healthInterval: 30, autoReconnect: true, reconnectAttempts: 5, reconnectDelay: 5, logLevel: 'warning', bypassDomains: '', bypassIps: '' };
  let activeSub = null;
  const pings = {};
  let pingPending = false;
  let pingQueued = false;
  let cabinetCode = null;
  let cabinetExpiresAt = 0;
  let cabinetPollTimer = null;
  let cabinetPollBusy = false;

  const allServers = () => S.subs.flatMap((s) => s.servers);
  const serverById = (id) => allServers().find((x) => x.id === id);
  const subOf = (id) => S.subs.find((s) => s.servers.some((x) => x.id === id));

  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  };
  const fmtBytes = (n) => {
    if (!n) return '0 Б';
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
  };

  function toast(msg, bad = true) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast'; }, 4200);
  }

  async function act(fn, okMsg) {
    const r = await fn();
    if (!r.ok) toast(r.error);
    else if (okMsg) toast(okMsg, false);
    return r;
  }

  // ───── отрисовка ─────
  function renderHero() {
    const p = $('#power');
    const st = V.state;
    p.className = 'power' + (st === 'connected' ? ' on' : '') + (st === 'connecting' ? ' busy' : '');
    const t = $('#statusText');
    t.textContent = st === 'connected' ? 'Подключено' : st === 'connecting' ? 'Подключение…' : 'Отключено';
    t.className = 'status' + (st === 'connected' ? ' on' : '');

    const h = $('#hint');
    h.className = 'hint';
    const chip = $('#proxyInfo');
    if (chip) chip.textContent = S.settings?.tun ? 'TUN-режим' : 'Системный прокси';
    const cur = serverById(st === 'disconnected' ? S.selectedId : V.serverId);
    if (V.error && st === 'disconnected') { h.textContent = V.error; h.className = 'hint err'; }
    else if (cur) h.textContent = cur.name;
    else h.textContent = 'Добавьте подписку';
    tick();
  }

  function tick() {
    $('#timer').textContent = V.state === 'connected' && V.since ? fmtTime(Date.now() - V.since) : '00:00:00';
  }

  function iconBtn(glyph, title, fn) {
    const b = mk('button', 'icon-btn', glyph);
    b.title = title;
    b.onclick = fn;
    return b;
  }

  function renderSub() {
    const box = $('#subCard');
    box.replaceChildren();
    const sub = S.subs.find((s) => s.id === activeSub);
    if (!sub) { box.hidden = true; return; }
    box.hidden = false;

    if (S.subs.length) {
      const tabs = mk('div', 'tabs');
      for (const s of S.subs) {
        const b = mk('button', 'tab' + (s.id === activeSub ? ' active' : ''));
        b.title = `${s.servers.length} серверов`;
        b.append(mk('span', 'tab-title', s.name));
        b.onclick = () => { activeSub = s.id; render(); pingActive(); };
        tabs.append(b);
      }
      box.append(tabs);
    }

    const head = mk('div', 'sub-head');
    head.append(mk('div', 'sub-name', sub.name));
    if (sub.url) head.append(iconBtn('⟳', 'Обновить подписку', async () => {
      const r = await act(() => marin.refresh(sub.id), 'Подписка обновлена');
      if (r.ok) pingActive();
    }));
    head.append(iconBtn('✕', 'Удалить подписку', () => {
      if (confirm(`Удалить «${sub.name}»?`)) act(() => marin.remove(sub.id));
    }));
    box.append(head);

    const details = mk('div', 'sub-details');
    const updated = sub.updatedAt ? new Date(sub.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : 'Нет данных';
    const interval = Number(sub.updateInterval);
    details.append(mk('div', 'sub-detail', `Обновлено: ${updated}`));
    const refreshInfo = interval > 0 ? `Интервал обновления: ${interval} ч.` : sub.url ? (S.settings?.refresh === false ? 'Обновление при запуске выключено' : 'Обновление при запуске включено') : 'Добавлено вручную';
    details.append(mk('div', 'sub-detail', refreshInfo));
    details.append(mk('div', 'sub-detail', `Серверов: ${sub.servers.length}`));
    box.append(details);

    const u = sub.userinfo;
    if (u) {
      const used = (u.upload || 0) + (u.download || 0);
      if (Number.isFinite(u.total) || Number.isFinite(u.download) || Number.isFinite(u.upload)) {
        const bar = mk('div', 'bar');
        const fill = mk('i');
        fill.style.width = (u.total ? Math.min(100, (used / u.total) * 100) : 0) + '%';
        bar.append(fill);
        const meta = mk('div', 'sub-meta');
        meta.append(mk('span', null, `${fmtBytes(used)} / ${u.total ? fmtBytes(u.total) : '∞'}`));
        meta.append(mk('span', null, u.total ? `${Math.max(0, 100 - Math.floor((used / u.total) * 100))}% осталось` : 'Безлимитный трафик'));
        box.append(bar, meta);
      }

      const traffic = mk('div', 'sub-details traffic-details');
      traffic.append(mk('div', 'sub-detail', `↓ Получено: ${fmtBytes(u.download || 0)}`));
      traffic.append(mk('div', 'sub-detail', `↑ Отправлено: ${fmtBytes(u.upload || 0)}`));
      if (u.expire) {
        const expires = new Date(u.expire * 1000);
        const remaining = Math.ceil((expires.getTime() - Date.now()) / 86400000);
        const expiryText = remaining > 0 ? `Истекает: ${expires.toLocaleDateString('ru-RU')} (через ${remaining} дн.)` : `Срок истёк: ${expires.toLocaleDateString('ru-RU')}`;
        traffic.append(mk('div', 'sub-detail', expiryText));
      } else {
        traffic.append(mk('div', 'sub-detail', 'Срок действия: не указан'));
      }
      box.append(traffic);
    } else {
      box.append(mk('div', 'sub-detail muted', 'Данные о трафике и сроке действия не предоставлены сервером подписки.'));
    }
  }

  const COUNTRY_MATCHERS = [
    ['🇸🇪', 'Швеция', /швеци|sweden|stockholm|gothenburg/i],
    ['🇩🇪', 'Германия', /германи|немец|germany|deutschland|frankfurt|berlin|munich/i],
    ['🇳🇱', 'Нидерланды', /нидерланд|голланд|netherlands|holland|amsterdam|rotterdam/i],
    ['🇫🇷', 'Франция', /франци|france|paris|marseille/i],
    ['🇬🇧', 'Великобритания', /великобритани|британи|англи|united kingdom|london|manchester/i],
    ['🇺🇸', 'США', /сша|америк|united states|usa|new york|los angeles|chicago|miami/i],
    ['🇨🇦', 'Канада', /канада|canada|toronto|montreal|vancouver/i],
    ['🇫🇮', 'Финляндия', /финлянди|finland|helsinki/i],
    ['🇨🇭', 'Швейцария', /швейцари|switzerland|zurich|geneva/i],
    ['🇵🇱', 'Польша', /польш|poland|warsaw/i],
    ['🇹🇷', 'Турция', /турци|turkey|türkiye|istanbul/i],
    ['🇯🇵', 'Япония', /япони|japan|tokyo|osaka/i],
    ['🇸🇬', 'Сингапур', /сингапур|singapore/i],
    ['🇷🇺', 'Россия', /росси|russia|moscow|saint petersburg/i],
    ['🇦🇹', 'Австрия', /австри|austria|vienna/i],
    ['🇧🇪', 'Бельгия', /бельги|belgium|brussels/i],
    ['🇧🇬', 'Болгария', /болгари|bulgaria|sofia/i],
    ['🇧🇷', 'Бразилия', /бразили|brazil|sao paulo/i],
    ['🇨🇿', 'Чехия', /чехи|czech|prague/i],
    ['🇩🇰', 'Дания', /дани|denmark|copenhagen/i],
    ['🇪🇪', 'Эстония', /эстони|estonia|tallinn/i],
    ['🇪🇸', 'Испания', /испани|spain|madrid|barcelona/i],
    ['🇭🇰', 'Гонконг', /гонконг|hong kong/i],
    ['🇭🇺', 'Венгрия', /венгри|hungary|budapest/i],
    ['🇮🇪', 'Ирландия', /ирланди|ireland|dublin/i],
    ['🇮🇱', 'Израиль', /израил|israel|tel aviv/i],
    ['🇮🇹', 'Италия', /итали|italy|milan|rome/i],
    ['🇰🇷', 'Южная Корея', /коре|south korea|seoul/i],
    ['🇱🇻', 'Латвия', /латви|latvia|riga/i],
    ['🇱🇹', 'Литва', /литв|lithuania|vilnius/i],
    ['🇳🇴', 'Норвегия', /норвеги|norway|oslo/i],
    ['🇵🇹', 'Португалия', /португали|portugal|lisbon/i],
    ['🇷🇴', 'Румыния', /румыни|romania|bucharest/i],
    ['🇷🇸', 'Сербия', /серби|serbia|belgrade/i],
    ['🇸🇰', 'Словакия', /словаки|slovakia|bratislava/i],
    ['🇸🇮', 'Словения', /словени|slovenia|ljubljana/i],
    ['🇺🇦', 'Украина', /украин|ukraine|kyiv|kiev/i],
    ['🇦🇪', 'ОАЭ', /оаэ|эмират|united arab emirates|dubai/i],
    ['🇦🇺', 'Австралия', /австрали|australia|sydney/i],
    ['🇳🇿', 'Новая Зеландия', /новая зеландия|new zealand|auckland/i],
  ];

  function countryForServer(server) {
    const text = `${server.name || ''} ${server.host || ''}`.toLocaleLowerCase('ru');
    return COUNTRY_MATCHERS.find(([, , pattern]) => pattern.test(text))?.slice(0, 2) || ['🌐', 'Страна не определена'];
  }

  function serverDisplayName(server) {
    const [flag] = countryForServer(server);
    const codePoints = [...flag].map((char) => char.codePointAt(0));
    if (codePoints.length !== 2 || codePoints.some((point) => point < 0x1f1e6 || point > 0x1f1ff)) return server.name;
    const code = codePoints.map((point) => String.fromCharCode(point - 0x1f1e6 + 65)).join('');
    return String(server.name || '').replace(new RegExp(`^${code}\\s+`, 'i'), '');
  }

  function pingClass(ms) { return ms == null ? '' : ms < 120 ? 'good' : ms < 300 ? 'mid' : 'bad'; }

  function renderServers() {
    const list = $('#list');
    list.replaceChildren();
    const sub = S.subs.find((s) => s.id === activeSub);
    if (!sub || !sub.servers.length) {
      list.append(mk('div', 'empty', 'Пока пусто. Нажмите «Добавить» и вставьте ссылку подписки или ключ.'));
      return;
    }
    for (const s of sub.servers) {
      const b = mk('button', 'item' + (s.id === S.selectedId ? ' sel' : ''));
      b.append(mk('span', 'proto', s.protocol === 'shadowsocks' ? 'ss' : s.protocol));
      const [flag, country] = countryForServer(s);
      const countryBadge = document.createElement('img');
      countryBadge.className = 'country-flag';
      countryBadge.src = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg/' + [...flag].map((char) => char.codePointAt(0).toString(16)).join('-') + '.svg';
      countryBadge.alt = '';
      countryBadge.title = country;
      countryBadge.setAttribute('aria-label', country);
      b.append(countryBadge, mk('span', 'iname', serverDisplayName(s)));
      const ms = pings[s.id];
      const pe = mk('span', 'ping ' + pingClass(ms), pingPending ? 'проверка…' : ms === undefined ? 'не проверено' : ms == null ? 'нет связи' : ms + ' мс');
      b.append(pe);
      b.onclick = () => selectServer(s.id);
      list.append(b);
    }
  }

  // ───── тема и акцент ─────
  const prefersLight = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  function applyTheme(theme, accent) {
    const value = theme === 'system' ? (prefersLight() ? 'light' : 'dark') : (theme === 'light' ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', value);
    if (accent && /^#[0-9a-f]{6}$/i.test(accent)) {
      document.documentElement.style.setProperty('--accent', accent);
      document.documentElement.style.setProperty('--accent2', accent);
    } else {
      document.documentElement.style.removeProperty('--accent');
      document.documentElement.style.removeProperty('--accent2');
    }
  }
  applyTheme(marin.initialTheme || 'dark', marin.initialAccent || '');
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = () => {
      if ((S.settings?.theme || 'dark') === 'system') applyTheme('system', S.settings?.accent || '');
    };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
    else if (mq.addListener) mq.addListener(onScheme);
  }

  // ───── разделы настроек ─────
  let settingsSection = 'app';
  function showSettingsSection(name) {
    settingsSection = name;
    document.querySelectorAll('#settingsTabs .settings-tab').forEach((b) => b.classList.toggle('active', b.dataset.section === name));
    document.querySelectorAll('#page-settings .settings-section').forEach((s) => { s.hidden = s.dataset.section !== name; });
  }
  document.querySelectorAll('#settingsTabs .settings-tab').forEach((b) => {
    b.onclick = () => showSettingsSection(b.dataset.section);
  });

  function renderSettings() {
    const settings = { ...DEFAULT_SETTINGS, ...(S.settings || {}) };
    $('#settingStartup').checked = !!settings.startup;
    $('#settingTray').checked = !!settings.tray;
    $('#settingRefresh').checked = !!settings.refresh;
    $('#settingNotify').checked = settings.notify !== false;
    $('#settingAutoUpdate').checked = settings.autoUpdate !== false;
    $('#settingTun').checked = !!settings.tun;
    $('#settingHealthCheck').checked = !!settings.healthCheck;
    $('#settingHealthInterval').value = settings.healthInterval;
    $('#settingAutoReconnect').checked = !!settings.autoReconnect;
    $('#settingReconnectAttempts').value = settings.reconnectAttempts;
    $('#settingReconnectDelay').value = settings.reconnectDelay;
    $('#settingLogLevel').value = settings.logLevel;
    $('#settingBypassDomains').value = settings.bypassDomains || '';
    $('#settingBypassIps').value = settings.bypassIps || '';
    const pingType = ['proxy-get', 'proxy-head', 'tcp', 'icmp'].includes(settings.pingType) ? settings.pingType : DEFAULT_SETTINGS.pingType;
    document.querySelector(`input[name="pingType"][value="${pingType}"]`).checked = true;
    const notes = {
      'proxy-get': 'Измеряется ответ тестового HTTPS-сервера через VPN-туннель.',
      'proxy-head': 'Измеряется ответ тестового HTTPS-сервера через VPN-туннель без загрузки тела.',
      tcp: 'Измеряется время TCP-подключения к узлу сервера; это не пинг через VPN-туннель.',
      icmp: 'Измеряется системный ICMP ping до узла сервера; маршрут может отличаться от VPN-туннеля.',
    };
    $('.latency-note').textContent = notes[pingType];
    const theme = ['dark', 'light', 'system'].includes(settings.theme) ? settings.theme : 'dark';
    const themeRadio = document.querySelector(`input[name="theme"][value="${theme}"]`);
    if (themeRadio) themeRadio.checked = true;
    $('#settingAccent').value = settings.accent || '#35e6cf';
    applyTheme(theme, settings.accent || '');
    const version = $('#appVersion');
    if (version) version.textContent = S.version || '—';
    showSettingsSection(settingsSection);
    renderPresets();
  }

  // Чекбоксы пресетов маршрутизации
  let PRESET_LIST = null;
  async function loadPresets() {
    if (PRESET_LIST) return PRESET_LIST;
    const r = await marin.routePresets();
    PRESET_LIST = r.ok ? (r.data || []) : [];
    return PRESET_LIST;
  }
  function renderPresets() {
    const box = $('#routePresets');
    if (!box) return;
    const selected = new Set(S.settings?.routePresets || []);
    box.replaceChildren();
    for (const p of PRESET_LIST || []) {
      const label = mk('label', 'preset');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selected.has(p.id);
      input.dataset.preset = p.id;
      input.onchange = saveSettings;
      const text = mk('span');
      text.append(mk('b', null, p.label), mk('small', null, p.hint));
      label.append(input, text);
      box.append(label);
    }
  }

  function render() { renderHero(); renderSub(); renderServers(); renderSettings(); }

  function cabinetNotice(message, isError = false) {
    const notice = $('#cabinetNotice');
    notice.textContent = message;
    notice.classList.toggle('error', isError);
  }

  function formatDate(value) {
    const date = typeof value === 'number' || /^\\d{9,}$/.test(String(value || ''))
      ? new Date(Number(value) * (Number(value) < 1e12 ? 1000 : 1))
      : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleDateString('ru-RU', { dateStyle: 'long' }) : 'не указан';
  }

  let cabinetData = null;
  let cabinetPromo = null;
  let cabinetRenameSubId = null;
  const cabinetMoney = (value) => `${Number(value || 0).toLocaleString('ru-RU')} ₽`;
  const cabinetButton = (label, action, payload = {}, primary = false) => {
    const button = mk('button', primary ? 'primary cabinet-small-button' : 'ghost cabinet-small-button', label);
    button.type = 'button';
    button.dataset.cabinet = action;
    for (const [key, value] of Object.entries(payload)) button.dataset[key] = String(value);
    return button;
  };

  function renderCabinet(data) {
    cabinetData = data;
    $('#cabinetConnect').hidden = true;
    $('#cabinetData').hidden = false;
    $('#cabinetSummary').textContent = data.user?.name ? `Аккаунт: ${data.user.name}` : 'Ваш аккаунт MarinVPN';
    const overview = $('#cabinetOverview');
    overview.replaceChildren();
    const referralStats = data.referrals && typeof data.referrals === 'object' ? data.referrals : {};
    const referralCount = Number(referralStats.total ?? data.referral_total ?? (typeof data.referrals === 'number' ? data.referrals : 0));
    for (const [label, value] of [
      ['Баланс', cabinetMoney(data.balance)],
      ['Подписок', String((data.subscriptions || []).length)],
      ['Рефералов', String(Number.isFinite(referralCount) ? referralCount : 0)],
    ]) {
      const card = mk('section', 'glass cabinet-stat');
      card.append(mk('span', 'cabinet-stat-label', label), mk('strong', 'cabinet-stat-value', value));
      overview.append(card);
    }

    const subscriptions = $('#cabinetSubscriptions');
    subscriptions.replaceChildren();
    const rows = data.subscriptions || [];
    if (!rows.length) subscriptions.append(mk('div', 'cabinet-empty', 'Подписок пока нет. Выберите тариф ниже, чтобы подключить VPN.'));
    const renewSelect = $('#cabinetRenewSub');
    renewSelect.replaceChildren(new Option('Новый ключ', ''));
    for (const sub of rows) {
      const option = new Option(`${sub.name || 'Ключ'} · ${sub.tariff || 'MarinVPN'}`, String(sub.id));
      renewSelect.append(option);
      const row = mk('div', 'cabinet-row cabinet-subscription');
      const main = mk('div', 'cabinet-row-main');
      main.append(mk('span', 'cabinet-row-title', sub.name || `Ключ #${sub.key_number || sub.id}`));
      main.append(mk('span', 'cabinet-row-meta', `${sub.tariff || 'MarinVPN'} · до ${formatDate(sub.expires)}`));
      const actions = mk('div', 'cabinet-row-actions');
      actions.append(cabinetButton('Добавить в MarinBox', 'add-to-app', { url: sub.url || '' }, true));
      actions.append(cabinetButton('Скопировать ссылку', 'copy', { url: sub.url || '' }));
      actions.append(cabinetButton('Переименовать', 'rename', { subId: sub.id }));
      actions.append(cabinetButton('Перевыпустить', 'reissue', { subId: sub.id }));
      row.append(main, actions);
      subscriptions.append(row);
    }

    const tariffSelect = $('#cabinetTariff');
    const selectedTariff = tariffSelect.value;
    tariffSelect.replaceChildren();
    const globalDiscount = data.global_discount;
    const discountPercent = Number(globalDiscount?.discount_percent) || 0;
    $('#cabinetDiscountNotice').textContent = discountPercent
      ? `Скидка ${discountPercent}% действует до ${formatDate(globalDiscount.expires_at)}.` : '';
    for (const tariff of data.tariffs || []) {
      const basePrice = Number(tariff.price) || 0;
      const price = discountPercent ? Math.max(1, Math.round(basePrice * (100 - discountPercent) / 100)) : basePrice;
      const option = new Option(`${tariff.name} · ${tariff.days} дн.`, tariff.name);
      option.dataset.price = String(price);
      option.dataset.basePrice = String(basePrice);
      tariffSelect.append(option);
    }
    if ([...tariffSelect.options].some(option => option.value === selectedTariff)) tariffSelect.value = selectedTariff;
    const updateTariffPrice = () => {
      const option = tariffSelect.selectedOptions[0];
      if (!option) return;
      const discounted = Number(option.dataset.price) || 0;
      const base = Number(option.dataset.basePrice) || discounted;
      $('#cabinetSelectedPrice').textContent = discountPercent && discounted !== base
        ? `${cabinetMoney(discounted)} вместо ${cabinetMoney(base)}` : cabinetMoney(base);
    };
    updateTariffPrice();
    tariffSelect.onchange = updateTariffPrice;
    $('#cabinetPromoNotice').textContent = cabinetPromo ? `Промокод ${cabinetPromo.code} применён · скидка ${cabinetPromo.discount}%` : '';
    $('[data-cabinet="trial"]').disabled = !!data.trial_used;
    $('[data-cabinet="bonus"]').textContent = Number(data.bonus_remaining) > 0
      ? `Бонус через ${Math.ceil(Number(data.bonus_remaining) / 3600)} ч.` : 'Забрать ежедневный бонус';
    $('[data-cabinet="bonus"]').disabled = Number(data.bonus_remaining) > 0;
    // Payment history now opens in its own dialog.
    // Referral details are rendered in a dedicated dialog.
  }

  async function cabinetAction(action, payload = {}) {
    const result = await marin.cabinetAction(action, payload);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }

  async function refreshCabinet() {
    const result = await marin.cabinet();
    if (!result.ok) {
      if (/Подключите аккаунт/.test(result.error)) {
        $('#cabinetConnect').hidden = false;
        $('#cabinetData').hidden = true;
        $('#cabinetSummary').textContent = 'Управляйте аккаунтом, не покидая MarinBox.';
      } else cabinetNotice(result.error, true);
      return false;
    }
    cabinetNotice('Данные аккаунта обновлены.', false);
    renderCabinet(result.data);
    return true;
  }

  async function checkCabinetLogin() {
    if (!cabinetCode || cabinetPollBusy) return;
    if (Date.now() >= cabinetExpiresAt) {
      cabinetNotice('Срок кода истёк. Запросите новый.', true);
      $('#cabinetCheck').disabled = true;
      return;
    }
    cabinetPollBusy = true;
    $('#cabinetCheck').disabled = true;
    cabinetNotice('Проверяем подтверждение в Telegram…');
    try {
      const result = await marin.cabinetLoginExchange(cabinetCode);
      if (result.ok) {
        clearInterval(cabinetPollTimer);
        cabinetCode = null;
        renderCabinet(result.data);
        cabinetNotice('Аккаунт подключён.', false);
      } else {
        cabinetNotice(/не найден|истёк|использован/i.test(result.error) ? 'Пока нет подтверждения. Отправьте код боту и попробуйте ещё раз.' : result.error, true);
        $('#cabinetCheck').disabled = Date.now() >= cabinetExpiresAt;
      }
    } finally { cabinetPollBusy = false; }
  }

  // ───── действия ─────
  async function selectServer(id) {
    if (id === S.selectedId) return;
    await marin.select(id);
    if (V.state === 'connected') act(() => marin.connect(id));
  }

  async function pingActive() {
    if (!activeSub) return;
    if (pingPending) { pingQueued = true; return; }
    pingPending = true;
    const button = $('#btnPing');
    button.disabled = true;
    button.textContent = 'Проверка…';
    renderServers();
    const subId = activeSub;
    const pingType = S.settings?.pingType || DEFAULT_SETTINGS.pingType;
    try {
      const r = await marin.pingAll(subId, pingType);
      if (r.ok && activeSub === subId && (S.settings?.pingType || DEFAULT_SETTINGS.pingType) === pingType) Object.assign(pings, r.data);
      else if (!r.ok) toast(r.error);
    } finally {
      pingPending = false;
      button.disabled = false;
      button.textContent = 'Задержка';
      renderServers();
      if (pingQueued) { pingQueued = false; pingActive(); }
    }
  }

  function apply(st) {
    S = st;
    V = st.status;
    if (!S.subs.some((s) => s.id === activeSub)) {
      const sel = subOf(S.selectedId);
      activeSub = (sel || S.subs[0] || {}).id || null;
    }
    render();
  }

  $('#power').onclick = () => {
    if (V.state === 'connecting') return;
    if (V.state === 'connected') return act(() => marin.disconnect());
    if (!S.selectedId) return toast('Сначала добавьте подписку или ключ');
    act(() => marin.connect(S.selectedId));
  };
  $('#btnPing').onclick = pingActive;
  $('#cabinetGetCode').onclick = async () => {
    const button = $('#cabinetGetCode');
    button.disabled = true;
    cabinetNotice('Запрашиваем код…');
    const result = await marin.cabinetLoginStart();
    button.disabled = false;
    if (!result.ok) { cabinetNotice(result.error, true); return; }
    cabinetCode = result.data.code;
    cabinetExpiresAt = Date.now() + Number(result.data.expires_in || 300) * 1000;
    $('#cabinetCode').textContent = cabinetCode;
    $('#cabinetCheck').disabled = false;
    cabinetNotice('Отправьте боту команду /box ' + cabinetCode + '. Код действует 5 минут.');
    clearInterval(cabinetPollTimer);
    cabinetPollTimer = setInterval(() => {
      if (Date.now() >= cabinetExpiresAt) {
        clearInterval(cabinetPollTimer);
        $('#cabinetCheck').disabled = true;
        cabinetNotice('Срок кода истёк. Запросите новый.', true);
      }
    }, 1000);
  };
  $('#cabinetCheck').onclick = checkCabinetLogin;
  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.onclick = () => document.getElementById(button.dataset.closeDialog)?.close();
  });
  $('#cabinetRenameSave').onclick = async () => {
    const name = $('#cabinetRenameInput').value.trim();
    if (!name) { toast('Введите название ключа'); $('#cabinetRenameInput').focus(); return; }
    if (!cabinetRenameSubId) return;
    const saveButton = $('#cabinetRenameSave');
    saveButton.disabled = true;
    try {
      await cabinetAction('rename', { id: cabinetRenameSubId, name: name.slice(0, 40) });
      $('#cabinetRenameDialog').close();
      cabinetRenameSubId = null;
      await refreshCabinet();
      toast('Название ключа изменено', false);
    } catch (error) {
      toast(error.message || 'Не удалось переименовать ключ');
    } finally { saveButton.disabled = false; }
  };
  $('#cabinetRenameInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); $('#cabinetRenameSave').click(); }
  });
  $('#cabinetBotLink').onclick = async () => {
    const result = await marin.openExternal('https://t.me/marinvpnspeed_bot');
    if (!result.ok) toast(result.error);
  };
  $('#cabinetRefresh').onclick = async () => {
    $('#cabinetRefresh').disabled = true;
    await refreshCabinet();
    $('#cabinetRefresh').disabled = false;
  };
  $('#cabinetData').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-cabinet]');
    if (!button || button.disabled) return;
    const action = button.dataset.cabinet;
    button.disabled = true;
    try {
      if (action === 'add-to-app') {
        if (!button.dataset.url) throw new Error('Ссылка подписки недоступна');
        const result = await marin.add(button.dataset.url);
        if (!result.ok) throw new Error(result.error);
        toast('Подписка добавлена в MarinBox', false);
        document.querySelector('[data-page="home"]').click();
      } else if (action === 'copy') {
        if (!button.dataset.url) throw new Error('Ссылка недоступна');
        const result = await marin.writeClipboard(button.dataset.url);
        if (!result.ok) throw new Error(result.error);
        toast('Ссылка скопирована', false);
      } else if (action === 'share') {
        if (!button.dataset.url) throw new Error('Ссылка приглашения недоступна');
        const result = await marin.openExternal(button.dataset.url);
        if (!result.ok) throw new Error(result.error);
        toast('Открыта отправка приглашения', false);
      } else if (action === 'rename') {
        const sub = cabinetData?.subscriptions?.find(item => String(item.id) === button.dataset.subId);
        if (!sub) throw new Error('Ключ не найден');
        cabinetRenameSubId = sub.id;
        $('#cabinetRenameInput').value = sub.name || '';
        $('#cabinetRenameDialog').showModal();
        $('#cabinetRenameInput').focus();
      } else if (action === 'reissue') {
        if (!confirm('Создать новую ссылку для этого ключа? Старую ссылку после этого нужно будет заменить в VPN-приложении.')) return;
        await cabinetAction('reissue', { id: button.dataset.subId });
        await refreshCabinet();
        toast('Ключ перевыпущен', false);
      } else if (action === 'bonus') {
        const result = await cabinetAction('dailyBonus', {});
        await refreshCabinet();
        toast(result.ok ? `Бонус начислен: +${cabinetMoney(result.amount)}` : `Следующий бонус через ${Math.ceil(Number(result.remaining || 0) / 3600)} ч.`, false);
      } else if (action === 'trial') {
        await cabinetAction('trial', {});
        await refreshCabinet();
        toast('Пробный доступ активирован', false);
      } else if (action === 'promo') {
        const code = $('#cabinetPromoInput').value.trim();
        const result = await cabinetAction('promo', { code });
        cabinetPromo = code ? { code: result.code || code, discount: result.discount || 0 } : null;
        $('#cabinetPromoNotice').textContent = cabinetPromo ? `Промокод ${cabinetPromo.code} применён · скидка ${cabinetPromo.discount}%` : 'Промокод удалён.';
        toast(code ? 'Промокод применён' : 'Промокод удалён', false);
      } else if (action === 'purchase') {
        const tariff = $('#cabinetTariff').value;
        if (!tariff) throw new Error('Нет доступных тарифов');
        const subscriptionId = $('#cabinetRenewSub').value;
        const method = $('#cabinetPaymentMethod').value;
        const result = await cabinetAction('payment', { tariff, method, ...(subscriptionId ? { subscription_id: subscriptionId } : {}) });
        if (result.url) {
          toast('Платёж открыт в браузере. После оплаты обновите кабинет.', false);
        } else {
          await refreshCabinet();
          toast('Оплата выполнена', false);
        }
      } else if (action === 'topup') {
        const amount = Number($('#cabinetTopupAmount').value);
        if (!Number.isInteger(amount) || amount < 1 || amount > 10000) throw new Error('Введите сумму от 1 до 10000 ₽');
        await cabinetAction('topup', { amount });
        toast('Страница оплаты открыта в браузере', false);
      } else if (action === 'payments') {
        const panel = $('#cabinetPayments');
        const dialog = $('#cabinetPaymentsDialog');
        if (!dialog.open) dialog.showModal();
        panel.replaceChildren(mk('div', 'cabinet-empty', 'Загружаем историю платежей…'));
        const result = await cabinetAction('payments');
        const payments = Array.isArray(result) ? result : (Array.isArray(result?.payments) ? result.payments : Array.isArray(result?.rows) ? result.rows : Array.isArray(result?.data) ? result.data : []);
        panel.replaceChildren();
        if (!payments.length) panel.append(mk('div', 'cabinet-empty', 'Платежей пока нет.'));
        for (const payment of payments) {
          const row = mk('div', 'cabinet-row');
          const main = mk('div', 'cabinet-row-main');
          main.append(mk('span', 'cabinet-row-title', payment.tariff || 'Платёж'));
          main.append(mk('span', 'cabinet-row-meta', `${payment.status} · ${formatDate(payment.created_at)}`));
          row.append(main, mk('span', 'cabinet-row-price', cabinetMoney(payment.amount)));
          if (payment.status === 'pending') row.append(cabinetButton('Проверить', 'payment-check', { paymentId: payment.payment_id }));
          panel.append(row);
        }
        // Keep the payment list inside its dialog.
      } else if (action === 'payment-check') {
        const result = await cabinetAction('paymentStatus', { payment_id: button.dataset.paymentId });
        if (result.status === 'succeeded') await refreshCabinet();
        toast(result.status === 'succeeded' ? 'Платёж подтверждён' : result.status === 'failed' ? 'Платёж не прошёл' : 'Платёж ещё обрабатывается', result.status === 'failed');
      } else if (action === 'referral') {
        const result = await cabinetAction('referral', {});
        const panel = $('#cabinetReferral');
        panel.replaceChildren(mk('p', 'cabinet-row-meta', result.terms || 'Приглашайте друзей по своей ссылке.'));
        if (result.url) {
          panel.append(mk('div', 'cabinet-row-title', result.url));
          panel.append(cabinetButton('Скопировать ссылку', 'copy', { url: result.url }, true));
        }
        panel.append(mk('p', 'cabinet-row-meta', `Приглашено: ${result.total ?? result.referrals?.total ?? 0} · оплатили: ${result.paid ?? result.referrals?.paid ?? 0}`));
        if (result.url) panel.append(cabinetButton('Отправить приглашение', 'share', { url: `https://t.me/share/url?url=${encodeURIComponent(result.url)}&text=${encodeURIComponent('Приглашаю подключиться к MarinVPN')}` }));
        const dialog = $('#cabinetReferralDialog');
        if (!dialog.open) dialog.showModal();
      }
    } catch (error) {
      toast(error.message || 'Не удалось выполнить действие');
    } finally { button.disabled = false; }
  });
  $('#cabinetLogout').onclick = async () => {
    const result = await marin.cabinetLogout();
    if (!result.ok) { cabinetNotice(result.error, true); return; }
    $('#cabinetData').hidden = true;
    $('#cabinetConnect').hidden = false;
    $('#cabinetSummary').textContent = 'Управляйте аккаунтом, не покидая MarinBox.';
    $('#cabinetCode').textContent = '— — — — — —';
    cabinetCode = null;
    clearInterval(cabinetPollTimer);
    cabinetNotice('Аккаунт отключён.', false);
  };
  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.onclick = () => {
      document.querySelectorAll('.nav-btn').forEach((item) => item.classList.toggle('active', item === button));
      document.querySelectorAll('.page').forEach((page) => { page.hidden = page.id !== 'page-' + button.dataset.page; });
      $('#btnAdd').hidden = button.dataset.page !== 'home';
      if (button.dataset.page === 'cabinet') refreshCabinet();
    };
  });
  const saveSettings = () => {
    S.settings = {
      ...(S.settings || {}),
      startup: $('#settingStartup').checked,
      tray: $('#settingTray').checked,
      refresh: $('#settingRefresh').checked,
      notify: $('#settingNotify').checked,
      autoUpdate: $('#settingAutoUpdate').checked,
      tun: $('#settingTun').checked,
      theme: document.querySelector('input[name="theme"]:checked')?.value || DEFAULT_SETTINGS.theme,
      accent: $('#settingAccent').value,
      routePresets: Array.from(document.querySelectorAll('#routePresets input[type=checkbox]'))
        .filter((i) => i.checked).map((i) => i.dataset.preset),
      pingType: document.querySelector('input[name="pingType"]:checked')?.value || DEFAULT_SETTINGS.pingType,
      healthCheck: $('#settingHealthCheck').checked,
      healthInterval: Number($('#settingHealthInterval').value),
      autoReconnect: $('#settingAutoReconnect').checked,
      reconnectAttempts: Number($('#settingReconnectAttempts').value),
      reconnectDelay: Number($('#settingReconnectDelay').value),
      logLevel: $('#settingLogLevel').value,
      bypassDomains: $('#settingBypassDomains').value,
      bypassIps: $('#settingBypassIps').value,
    };
    marin.saveSettings(S.settings).then((r) => {
      if (!r.ok) toast(r.error);
      else toast('Настройки сохранены', false);
    });
  };
  ['settingStartup', 'settingTray', 'settingRefresh', 'settingNotify', 'settingAutoUpdate', 'settingTun', 'settingHealthCheck', 'settingHealthInterval', 'settingAutoReconnect', 'settingReconnectAttempts', 'settingReconnectDelay', 'settingLogLevel', 'settingBypassDomains', 'settingBypassIps', 'settingAccent'].forEach((id) => {
    $('#' + id).onchange = saveSettings;
  });
  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.onchange = () => {
      applyTheme(input.value, $('#settingAccent').value);
      saveSettings();
    };
  });
  $('#btnResetAccent').onclick = () => {
    $('#settingAccent').value = '#35e6cf';
    applyTheme(document.querySelector('input[name="theme"]:checked')?.value || 'dark', '');
    saveSettings();
  };
  $('#btnOpenLog').onclick = async () => {
    const r = await marin.openLog();
    if (!r.ok) toast(r.error);
  };
  document.querySelectorAll('input[name="pingType"]').forEach((input) => {
    input.onchange = () => { saveSettings(); pingActive(); };
  });
  $('#btnResetSettings').onclick = () => {
    S.settings = { ...DEFAULT_SETTINGS };
    renderSettings();
    marin.saveSettings(S.settings).then((r) => {
      if (!r.ok) toast(r.error);
      else toast('Настройки сброшены', false);
    });
  };
  $('#btnMin').onclick = () => marin.minimize();
  $('#btnClose').onclick = () => marin.hide();

  const dlg = $('#dlg');
  const setAddLoading = (loading) => {
    $('#dlgLoading').hidden = !loading;
    $('#dlgText').disabled = loading;
    $('#dlgPaste').disabled = loading;
    $('#dlgCancel').disabled = loading;
    $('#dlgOk').disabled = loading;
    $('#dlgOk').textContent = loading ? 'Загрузка…' : 'Добавить';
    $('#btnAdd').disabled = loading;
  };
  $('#btnAdd').hidden = true;
  $('#btnAdd').onclick = () => { $('#dlgText').value = ''; setAddLoading(false); dlg.showModal(); $('#dlgText').focus(); };
  $('#dlgCancel').onclick = () => dlg.close();
  $('#dlgPaste').onclick = async () => {
    const r = await marin.readClipboard();
    if (r.ok) $('#dlgText').value = r.data;
  };
  $('#dlgOk').onclick = async () => {
    const text = $('#dlgText').value;
    setAddLoading(true);
    try {
      const r = await act(() => marin.add(text), 'Добавлено');
      if (r.ok) { dlg.close(); activeSub = r.data; render(); pingActive(); }
    } finally {
      setAddLoading(false);
    }
  };

  // ───── ядро Xray ─────
  const xrayNotice = (text, bad) => {
    const n = $('#xrayNotice');
    if (!n) return;
    n.textContent = text;
    n.classList.toggle('error', !!bad);
  };
  const setXrayVersion = (value) => {
    const el = $('#xrayVersion');
    if (el) el.textContent = value || '—';
  };
  $('#btnXrayCheck').onclick = async () => {
    const btn = $('#btnXrayCheck');
    btn.disabled = true;
    xrayNotice('Проверяем новые версии Xray…', false);
    try {
      const r = await marin.xrayCheck();
      if (!r.ok) { xrayNotice(r.error, true); return; }
      const info = r.data;
      setXrayVersion(info.current || '—');
      if (!info.hasUpdate) { xrayNotice('Установлена свежая версия ядра', false); return; }
      xrayNotice(`Доступна версия ${info.latest}`, false);
      $('#btnXrayUpdate').hidden = false;
    } finally { btn.disabled = false; }
  };
  $('#btnXrayUpdate').onclick = async () => {
    const btn = $('#btnXrayUpdate');
    btn.disabled = true;
    xrayNotice('Скачиваем ядро…', false);
    try {
      const r = await marin.xrayUpdate();
      if (!r.ok) { xrayNotice(r.error, true); return; }
      setXrayVersion(r.data.version);
      xrayNotice(`Ядро обновлено до ${r.data.version}`, false);
      $('#btnXrayUpdate').hidden = true;
    } finally { btn.disabled = false; }
  };
  marin.onUpdateProgress(({ received, total, what }) => {
    if (what !== 'xray') return;
    if (total) xrayNotice(`Скачиваем ядро… ${Math.round((received / total) * 100)}%`, false);
    else xrayNotice(`Скачано ${fmtBytes(received)}`, false);
  });

  // ───── обновление приложения ─────
  const updateState = { manifest: null, file: null };
  const setUpdateNotice = (text, bad) => {
    const n = $('#updateNotice');
    if (!n) return;
    n.textContent = text;
    n.classList.toggle('error', !!bad);
  };
  const showChangelog = (version, notes) => {
    $('#changelogVersion').textContent = version ? `Версия ${version}` : '';
    const box = $('#changelogText');
    box.textContent = (notes || '').trim() || 'В этой версии нет заметок.';
    const dlg = $('#changelogDialog');
    if (!dlg.open) dlg.showModal();
  };
  $('#btnChangelog').onclick = async () => {
    const r = await marin.changelog();
    if (r.ok) showChangelog(r.data.version, r.data.notes);
    else toast(r.error);
  };
  marin.onChangelog(({ version, notes }) => showChangelog(version, notes));
  $('#btnCheckUpdate').onclick = async () => {
    const btn = $('#btnCheckUpdate');
    btn.disabled = true;
    setUpdateNotice('Проверяем обновления…', false);
    try {
      const r = await marin.checkUpdate();
      if (!r.ok) { setUpdateNotice(r.error, true); return; }
      const info = r.data || {};
      if (!info.hasUpdate) { setUpdateNotice('Установлена последняя версия', false); return; }
      updateState.manifest = info;
      setUpdateNotice(`Доступна версия ${info.version}${info.notes ? '. ' + info.notes : ''}`, false);
      $('#btnDownloadUpdate').hidden = false;
    } finally { btn.disabled = false; }
  };
  $('#btnDownloadUpdate').onclick = async () => {
    const btn = $('#btnDownloadUpdate');
    btn.disabled = true;
    setUpdateNotice('Скачиваем обновление…', false);
    const r = await marin.downloadUpdate();
    btn.disabled = false;
    if (!r.ok) { setUpdateNotice(r.error, true); return; }
    updateState.file = r.data.path;
    btn.hidden = true;
    $('#btnInstallUpdate').hidden = false;
    setUpdateNotice(`Обновление ${r.data.version} скачано. Установить сейчас?`, false);
  };
  $('#btnInstallUpdate').onclick = async () => {
    const r = await marin.installUpdate(updateState.file);
    if (!r.ok) setUpdateNotice(r.error, true);
  };
  marin.onUpdateProgress(({ received, total }) => {
    if (total) setUpdateNotice(`Скачиваем обновление… ${Math.round((received / total) * 100)}%`, false);
    else setUpdateNotice(`Скачано ${fmtBytes(received)}`, false);
  });
  marin.onUpdateAvailable((info) => {
    updateState.manifest = info;
    setUpdateNotice(`Доступно обновление ${info.version}. Скачать — кнопкой ниже.`, false);
    const btn = $('#btnDownloadUpdate');
    if (btn) btn.hidden = false;
  });

  // ───── старт ─────
  marin.onState(apply);
  marin.onStatus((s) => { V = s; renderHero(); });
  marin.onToast((m) => toast(m));
  setInterval(tick, 1000);
  (async () => {
    await loadPresets();
    const r = await marin.state();
    if (r.ok) { apply(r.data); pingActive(); }
  })();
})();
