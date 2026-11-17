<div align="center">

<img src="MarinBox/renderer/logo.png" width="104" alt="MarinBox">

# MarinBox

**Windows-клиент MarinVPN** — подписки и ключи, системный прокси и TUN-режим,
пресеты маршрутизации, уведомления и автообновление.

<p>
  <a href="https://github.com/marinVPN/MarinBOX/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/marinVPN/MarinBOX?style=flat-square&label=release&color=7a5cff"></a>
  <a href="https://github.com/marinVPN/MarinBOX/releases/latest"><img alt="Downloads" src="https://img.shields.io/github/downloads/marinVPN/MarinBOX?style=flat-square&label=downloads&color=35e6cf"></a>
  <img alt="Electron" src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&label=electron">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square&label=platform">
  <img alt="Xray" src="https://img.shields.io/badge/xray-core-26.x-2F6FEB?style=flat-square&label=xray-core">
</p>

<p>
  <a href="https://github.com/marinVPN/MarinBOX/releases/latest"><b>⬇ Скачать MarinBox для Windows</b></a>
  &nbsp;·&nbsp;
  <a href="#сборка-из-исходников"><b>🛠 Собрать самому</b></a>
  &nbsp;·&nbsp;
  <a href="https://t.me/mar1n3x"><b>🛟 Поддержка</b></a>
</p>

</div>

---

## Что это

MarinBox — десктоп-клиент для Windows в духе Happ: добавили подписку (или ключ) —
и трафик пошёл через VPN. Всё в одном окне: серверы с задержками, трафик и срок
подписки, кабинет и платежи.

Под капотом — **Xray-core**: VLESS (в том числе Reality), VMess, Trojan и Shadowsocks,
транспорты tcp / ws / grpc / httpupgrade / xhttp / h2, TLS и Reality.

## Скриншоты

Все снимки сделаны в работающем клиенте с включённым VPN.

| | |
|:--:|:--:|
| <img src="MarinBox/docs/screens/01-home.png" width="430"><br><sub><b>Главный экран.</b> Статус, живая скорость приёма и передачи, трафик за месяц, задержка</sub> | <img src="MarinBox/docs/screens/02-servers-search.png" width="430"><br><sub><b>Поиск по серверам.</b> Фильтр по стране, задержка до каждого узла</sub> |
| <img src="MarinBox/docs/screens/03-routes.png" width="430"><br><sub><b>Маршрутизация.</b> Схема правил: приложения → категории → исключения</sub> | <img src="MarinBox/docs/screens/04-routes-apps.png" width="430"><br><sub><b>Правила по приложениям.</b> Программу можно пустить мимо VPN или только через него</sub> |
| <img src="MarinBox/docs/screens/05-routes-categories.png" width="430"><br><sub><b>Категории сайтов.</b> 123 категории geosite: блокировать или напрямую</sub> | <img src="MarinBox/docs/screens/06-settings-app.png" width="430"><br><sub><b>Настройки · Приложение.</b> Автозапуск, уведомления, темы и цвет акцента</sub> |
| <img src="MarinBox/docs/screens/07-settings-vpn.png" width="430"><br><sub><b>Настройки · VPN.</b> Проверка связи, автопереподключение, тип пинга</sub> | <img src="MarinBox/docs/screens/08-settings-vpn-dns.png" width="430"><br><sub><b>Настройки · VPN.</b> TUN-режим и DNS через VPN (DoH)</sub> |
| <img src="MarinBox/docs/screens/09-settings-xray.png" width="430"><br><sub><b>Настройки · Xray.</b> Версия ядра, обновление, уровень журнала</sub> | <img src="MarinBox/docs/screens/10-settings-about.png" width="430"><br><sub><b>Настройки · О программе.</b> Обновления, changelog, поддержка</sub> |
| <img src="MarinBox/docs/screens/11-search.png" width="430"><br><sub><b>Поиск по настройкам.</b> Ctrl+K ищет по всем полям с переходом к нужному</sub> | <img src="MarinBox/docs/screens/12-add.png" width="430"><br><sub><b>Подписка или ключ.</b> Ссылка подписки, ключи или файл</sub> |
| <img src="MarinBox/docs/screens/13-changelog.png" width="430"><br><sub><b>Что нового.</b> Changelog показывается один раз на версию</sub> | <img src="MarinBox/docs/screens/14-cabinet.png" width="430"><br><sub><b>Кабинет.</b> Баланс, оплата, промокоды, ключи и подписки</sub> |

<div align="center">

<img src="MarinBox/docs/screens/15-light.png" width="620" alt="Светлая тема">
<br><sub><b>Светлая тема</b> — или «как в системе», плюс свой цвет акцента</sub>

</div>

## Возможности

| | |
|---|---|
| 🔑 **Подписки и ключи** | ссылка подписки (`3x-ui` и совместимые) или ключи `vless://`, `vmess://`, `trojan://`, `ss://` — по одному или списком. Остаток трафика и срок из заголовка `subscription-userinfo` |
| 🖥 **Два режима** | системный прокси для браузеров и приложений либо **TUN-режим** — весь трафик системы, включая те, кто прокси игнорирует (родной TUN-инбаунд Xray + Wintun) |
| 🧭 **Пресеты маршрутизации** | Россия напрямую, блокировка рекламы, трекеров и 18+, Discord, соцсети, YouTube и OpenAI напрямую — плюс свои домены и IP/CIDR |
| 📶 **Пинг и таймер** | задержка до каждого сервера (Proxy GET / HEAD / TCP / ICMP), таймер сессии, избранное |
| 🔔 **Уведомления Windows** | подключение, потеря связи, восстановление, обновления |
| ♻️ **Автообновление** | и самого приложения (с changelog), и ядра Xray-core — новая версия ставится сама, установленная сборка не ломается |
| 🗂 **Кабинет в приложении** | вход в один клик через Telegram, оплата картой / СБП / криптой, промокоды, бонусы, рефералка, перевыпуск ключа |
| 🎨 **Оформление** | тёмная и светлая темы (или как в системе) и свой цвет акцента |
| 🧩 **Мелкие детали** | трей, сворачивание в окно, `marinbox://add/<ссылка>` для импорта подписки из бота, автовосстановление системного прокси |

## Сборка из исходников

Нужен Node.js 20+.

```bash
git clone https://github.com/marinVPN/MarinBOX.git
cd MarinBox/MarinBox
npm install
npm run fetch-xray     # скачает Xray-core в bin/ (xray.exe, geoip.dat, geosite.dat)
npm start              # запуск в режиме разработки
npm run dist           # сборка установщика и портативной версии
```

Результат — в `dist/`: `MarinBox Setup <версия>.exe` (NSIS) и `MarinBox <версия>.exe` (портативный).

### Команды

| Команда | Что делает |
|---|---|
| `npm start` | запуск в режиме разработки |
| `npm run dist` | сборка установщика и portable-версии |
| `npm test` | проверки парсера, конфига, пресетов и логики обновлений |
| `npm run check:config` | валидация собранных конфигов Xray на настоящем xray |
| `npm run icon` | пересобрать все иконки из `build/logo-source.png` |
| `npm run release -- --github` | собрать, разложить установщик и опубликовать релиз (нужен `GITHUB_TOKEN`) |

## Релизы

Обновления публикуются здесь, в разделе [Releases](https://github.com/marinVPN/MarinBOX/releases).
Клиент сам проверяет последний релиз (при запуске и раз в 6 часов) и предлагает
обновление с changelog — после установки показывается окно «Что нового».

Как выпустить новую версию:

```bash
cd MarinBox
npm version patch                 # поднять версию
# добавить раздел "## 1.0.3 — …" в CHANGELOG.md
export GITHUB_TOKEN=…             # токен с правом contents:write
npm run release -- --github       # сборка + релиз на GitHub
node scripts/push-source.js       # залить изменения в исходники
```

Скрипт релиза сам собирает установщик, создаёт релиз с описанием из `CHANGELOG.md`
и загружает `.exe` как вложение. Дополнительно кладёт установщик в `downloads/`
и обновляет `webapp/release.json` — на случай, если GitHub недоступен.

## Структура проекта

```
MarinBox/                 исходники приложения
  main.js                 главный процесс: Xray, прокси, трей, автообновление
  preload.js              мост main ↔ renderer
  lib/                    парсер ссылок, конфиг Xray, пресеты, апдейтер ядра
  renderer/               интерфейс (HTML/CSS/JS без фреймворков)
  scripts/                сборка иконок, релиз, проверки
  bin/                    Xray-core, geoip.dat, geosite.dat
docs/                     скриншоты
downloads/                установщики для раздачи со своего сервера
webapp_server.py          API Mini App и эндпоинты для десктоп-клиента
bot.py                    Telegram-бот
```

## Поддержка

- Telegram: [@mar1n3x](https://t.me/mar1n3x)
- Баги и предложения — [Issues](https://github.com/marinVPN/MarinBOX/issues)

<p align="center"><sub>MarinBox — клиент для проекта MarinVPN. Трафик идёт через Xray-core.</sub></p>
