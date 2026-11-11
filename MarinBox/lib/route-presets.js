'use strict';
// Готовые пресеты маршрутизации: список галочек в настройках -> правила Xray.
//
// Значения geosite/geoip берутся из bin\geosite.dat и bin\geoip.dat,
// они проверены на наличие (см. scripts/selftest.js).

const PRESETS = [
  {
    id: 'ru-direct',
    label: 'Россия напрямую',
    hint: 'Российские сайты и IP идут мимо туннеля',
    rules: [
      { domain: ['geosite:category-ru', 'geosite:category-gov-ru'], outboundTag: 'direct' },
      { ip: ['geoip:ru'], outboundTag: 'direct' },
    ],
  },
  {
    id: 'ads-block',
    label: 'Блокировка рекламы',
    hint: 'Рекламные домены блокируются (AdGuard-списки)',
    rules: [{ domain: ['geosite:category-ads-all'], outboundTag: 'block' }],
  },
  {
    id: 'trackers-block',
    label: 'Блокировка трекеров',
    hint: 'Счётчики и трекеры блокируются',
    rules: [{ domain: ['geosite:category-public-tracker'], outboundTag: 'block' }],
  },
  {
    id: 'porn-block',
    label: 'Блокировка 18+',
    hint: 'Запрещённые сайты блокируются',
    rules: [{ domain: ['geosite:category-porn'], outboundTag: 'block' }],
  },
  {
    id: 'discord-direct',
    label: 'Discord напрямую',
    hint: 'Discord и его голосовые серверы — без VPN',
    rules: [{ domain: ['geosite:discord'], outboundTag: 'direct' }],
  },
  {
    id: 'social-direct',
    label: 'Соцсети напрямую',
    hint: 'ВК, Одноклассники, Facebook, Instagram, Twitter',
    rules: [{ domain: ['geosite:vk', 'geosite:ok', 'geosite:facebook', 'geosite:instagram', 'geosite:twitter'], outboundTag: 'direct' }],
  },
  {
    id: 'youtube-direct',
    label: 'YouTube напрямую',
    hint: 'YouTube не через туннель',
    rules: [{ domain: ['geosite:youtube'], outboundTag: 'direct' }],
  },
  {
    id: 'openai-direct',
    label: 'OpenAI напрямую',
    hint: 'ChatGPT и API — без VPN',
    rules: [{ domain: ['geosite:openai'], outboundTag: 'direct' }],
  },
];

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

function preset(id) { return BY_ID.get(id) || null; }

// Правила блокировки идут раньше правил «напрямую»,
// иначе RU-сайт с рекламой ушёл бы в туннель мимо блокировки.
const ORDER = ['ads-block', 'trackers-block', 'porn-block', 'ru-direct', 'discord-direct', 'social-direct', 'youtube-direct', 'openai-direct'];

function selectedRules(ids) {
  const wanted = Array.isArray(ids) ? ids : [];
  const out = [];
  for (const id of ORDER) {
    if (!wanted.includes(id)) continue;
    const p = BY_ID.get(id);
    if (p) out.push(...p.rules);
  }
  return out;
}

module.exports = { PRESETS, preset, selectedRules };
