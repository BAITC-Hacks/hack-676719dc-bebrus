import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || 'localhost';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT должен быть числом от 1 до 65535.');
  process.exit(1);
}

let service;
try { service = createApp(); }
catch (error) { console.error(`Не удалось запустить Silvius: ${error.message}`); process.exit(1); }

try { await service.initializePipeline(); }
catch (error) { console.error(`Не удалось загрузить пайплайн: ${error.message}`); service.close(); process.exit(1); }
const server = service.app.listen(port, host, () => {
  console.log(`Silvius доступен: http://${host}:${port}`);
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`Порт ${port} уже занят. Освободите его или задайте другой PORT.`);
  else console.error(`Не удалось запустить сервер: ${error.message}`);
  service.close();
  process.exitCode = 1;
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  try {
    await service.stopPipeline();
    server.close(() => { service.close(); process.exit(0); });
  } catch (error) {
    console.error(`Не удалось сохранить анализ при остановке: ${error.message}`);
    server.close(() => { service.close(); process.exit(1); });
  }
});
