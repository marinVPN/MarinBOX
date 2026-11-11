'use strict';
// Разбор geosite.dat: список категорий и сколько доменов в каждой.
// Формат (protobuf): GeoSite{ repeated Domain_Type type=1 }
//                             Domain_Type{ string name=1; repeated Domain domain=2 }
//                             Domain{ Type type=1; string value=2 }
// Свой декодер, чтобы не тянуть protobuf в Electron.

const fs = require('fs');
const path = require('path');

const DOMAIN_TYPES = ['None', 'TLD', 'Keyword', 'Regex', 'Domain', 'Full', 'RootDomain'];

function readVarint(buf, pos) {
  let result = 0, shift = 0, byte;
  do {
    byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [result, pos];
}

function parseGeosite(buf) {
  const cats = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = tag >> 3, wire = tag & 7;
    if (field === 1 && wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const end = pos + len;
      let name = '';
      const domains = [];
      while (pos < end) {
        let t2;
        [t2, pos] = readVarint(buf, pos);
        const f2 = t2 >> 3, w2 = t2 & 7;
        if (f2 === 1 && w2 === 2) {
          let l2;
          [l2, pos] = readVarint(buf, pos);
          name = buf.toString('utf8', pos, pos + l2);
          pos += l2;
        } else if (f2 === 2 && w2 === 2) {
          let l2;
          [l2, pos] = readVarint(buf, pos);
          const e2 = pos + l2;
          let type = 0, value = '';
          while (pos < e2) {
            let t3;
            [t3, pos] = readVarint(buf, pos);
            const f3 = t3 >> 3, w3 = t3 & 7;
            if (f3 === 1 && w3 === 0) { [type, pos] = readVarint(buf, pos); }
            else if (f3 === 2 && w3 === 2) {
              let l3;
              [l3, pos] = readVarint(buf, pos);
              value = buf.toString('utf8', pos, pos + l3);
              pos += l3;
            } else { pos = e2; break; }
          }
          domains.push({ type, value });
          pos = e2;
        } else { pos = end; break; }
      }
      pos = end;
      if (name) cats.push({ name, count: domains.length, types: countTypes(domains) });
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      pos += len;
    } else if (wire === 0) {
      [, pos] = readVarint(buf, pos);
    } else break;
  }
  return cats;
}

function countTypes(domains) {
  const out = {};
  for (const d of domains) {
    const name = DOMAIN_TYPES[d.type] || String(d.type);
    out[name] = (out[name] || 0) + 1;
  }
  return out;
}

// Кэш по пути: файл не меняется, пока не обновится ядро
const cache = new Map();

function readCatalog(file) {
  if (!file || !fs.existsSync(file)) return [];
  const stat = fs.statSync(file);
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (cache.has(key)) return cache.get(key);
  const cats = parseGeosite(fs.readFileSync(file));
  cache.set(key, cats);
  // чистим старые ключи, чтобы не раздувать кэш
  for (const k of cache.keys()) if (k !== key) cache.delete(k);
  return cats;
}

// Перевод популярных категорий на русский
const TITLES = {
  'CATEGORY-ADS': 'Реклама',
  'CATEGORY-ADS-ALL': 'Реклама (вся)',
  'CATEGORY-ADS-AND-TELEMETRY': 'Реклама и телеметрия',
  'CATEGORY-PORN': '18+',
  'CATEGORY-PUBLIC-TRACKER': 'Трекеры',
  'CATEGORY-SOCIAL-MEDIA': 'Соцсети',
  'CATEGORY-GAMES': 'Игры',
  'CATEGORY-CASINO': 'Казино',
  'CATEGORY-CRYPTO': 'Крипта',
  'CATEGORY-AI-CHAT': 'ИИ-сервисы',
  'CATEGORY-AI-!CN': 'ИИ (кроме Китая)',
  'CATEGORY-MEDIA': 'Медиа',
  'CATEGORY-VIDEO': 'Видео',
  'CATEGORY-ANIMATION': 'Аниме',
  'CATEGORY-COMIC': 'Комиксы',
  'CATEGORY-MUSIC': 'Музыка',
  'CATEGORY-NEWS': 'Новости',
  'CATEGORY-SHOPPING': 'Магазины',
  'CATEGORY-FINANCE': 'Финансы',
  'CATEGORY-BANKING': 'Банки',
  'CATEGORY-INSURANCE': 'Страхование',
  'CATEGORY-TELEGRAM': 'Телеграм',
  'CATEGORY-DISCORD': 'Discord',
  'CATEGORY-YOUTUBE': 'YouTube',
  'CATEGORY-GOOGLE': 'Google',
  'CATEGORY-MICROSOFT': 'Microsoft',
  'CATEGORY-APPLE': 'Apple',
  'CATEGORY-TELEGRAM-!CN': 'Телеграм (кроме Китая)',
  'CATEGORY-RU': 'Россия',
  'CATEGORY-GEOIP-RU': 'Россия (гео)',
  'CATEGORY-ANTIVIRUS': 'Антивирусы',
  'CATEGORY-ANTICENSORSHIP': 'Антицензура',
  'CATEGORY-CDN': 'CDN',
  'CATEGORY-EDUCATION': 'Образование',
  'CATEGORY-FORUM': 'Форумы',
  'CATEGORY-SEARCH': 'Поиск',
  'CATEGORY-SPORTS': 'Спорт',
  'CATEGORY-WEBHOSTING': 'Хостинг',
  'CATEGORY-WEBRTC': 'WebRTC',
  'CATEGORY-BLOG': 'Блоги',
  'CATEGORY-CLASSIFIEDS': 'Объявления',
  'CATEGORY-DATING': 'Знакомства',
  'CATEGORY-DOWNLOAD': 'Загрузки',
  'CATEGORY-GOV': 'Госструктуры',
  'CATEGORY-IMAGE': 'Картинки',
  'CATEGORY-MAIL': 'Почта',
  'CATEGORY-NSFW': '18+ (альт)',
  'CATEGORY-PIRACY': 'Пиратство',
  'CATEGORY-PARKED': 'Заброшенные домены',
  'CATEGORY-SERVER': 'Серверы и хостинг',
  'CATEGORY-SEO': 'SEO',
  'CATEGORY-TELEMETRY': 'Телеметрия',
  'CATEGORY-UNSAFE': 'Небезопасное',
  'CATEGORY-WEB-ANALYTICS': 'Веб-аналитика',
  'CATEGORY-WEB-CDN': 'Веб-CDN',
  'CATEGORY-CCTV': 'Камеры наблюдения',
};

// Каталог категорий: только «category-*» и «geolocation-*», с человеческими названиями
function humanName(name) {
  if (TITLES[name]) return TITLES[name];
  return name
    .replace(/^category-/i, '')
    .replace(/^geolocation-/i, 'гео: ')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function buildCatalog(file) {
  const cats = readCatalog(file);
  return cats
    .filter((c) => /^(category-|geolocation-)/i.test(c.name))
    .map((c) => ({
      name: c.name,
      title: humanName(c.name),
      count: c.count,
      types: c.types,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}

module.exports = { parseGeosite, readCatalog, buildCatalog, humanName };
