import { rmSync } from 'node:fs';
import { join } from 'node:path';

const data = join(import.meta.dirname, '..', 'data');
for (const file of ['silvius.sqlite', 'silvius.sqlite-wal', 'silvius.sqlite-shm', 'session-secret']) {
  rmSync(join(data, file), { force: true });
}
rmSync(join(import.meta.dirname, '..', 'uploads'), { force: true, recursive: true });
console.log('Локальные пользователи, сессии и загрузки удалены. При следующем запуске база создастся заново.');
