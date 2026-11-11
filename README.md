# MarinBox

Windows-клиент MarinVPN: подписки и ключи vless/vmess/trojan/ss, системный прокси и TUN-режим,
пресеты маршрутизации, уведомления и автообновление.

## Релизы

Обновления публикуются здесь, в разделе **Releases**. Клиент сам проверяет последний релиз
и предлагает обновление с changelog.

```powershell
cd MarinBox
npm version patch
npm run release -- --github   # нужна переменная GITHUB_TOKEN
```

Сборка и разработка — в папке `MarinBox/`.
