'use strict';
// Инструмент для съёмки скриншотов: пульт через файл-команду.
// Работает только в dev-режиме и только при MARINBOX_SHOT=1 — в собранное приложение не попадает.
//
//   MARINBOX_SHOT=1 npm start
//   node shot.js   // пишет %TEMP%\marinbox-shot.json и читает %TEMP%\marinbox-shot-ack.json
//
// Команда: { js?, wait?, size?, capture?, widget? }
//   js      — выполнить код в окне, результат вернётся в ack.value
//   wait    — пауза перед снимком, мс
//   size    — [ширина, высота] содержимого окна
//   capture — путь, куда сохранить PNG
//   widget  — снимать квик-виджет вместо главного окна
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function startShotHarness({ getWindow, getWidget, createWidget }) {
  const cmdFile = path.join(os.tmpdir(), 'marinbox-shot.json');
  const ackFile = path.join(os.tmpdir(), 'marinbox-shot-ack.json');

  setInterval(async () => {
    let cmd;
    try { cmd = JSON.parse(fs.readFileSync(cmdFile, 'utf8')); } catch { return; }
    try { fs.unlinkSync(cmdFile); } catch { /* уже удалён */ }
    const ack = { ok: true };
    const win = getWindow();
    try {
      if (!win || win.isDestroyed()) throw new Error('окно недоступно');
      if (cmd.size) win.setContentSize(cmd.size[0], cmd.size[1]);
      if (cmd.js) ack.value = await win.webContents.executeJavaScript(cmd.js, true);
      if (cmd.wait) await new Promise((resolve) => setTimeout(resolve, cmd.wait));
      if (cmd.widget) createWidget();
      if (cmd.capture) {
        const target = cmd.widget ? getWidget() : win;
        if (!target || target.isDestroyed()) throw new Error('окно недоступно');
        const image = await target.webContents.capturePage();
        fs.mkdirSync(path.dirname(cmd.capture), { recursive: true });
        fs.writeFileSync(cmd.capture, image.toPNG());
        ack.size = [image.getSize().width, image.getSize().height];
      }
    } catch (e) {
      ack.ok = false;
      ack.error = e.message;
    }
    try { fs.writeFileSync(ackFile, JSON.stringify(ack)); } catch { /* ignore */ }
  }, 250);
};
