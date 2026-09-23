let csrfToken;

export async function request(path, { method = 'GET', body } = {}) {
  if (method !== 'GET' && !csrfToken) {
    const auth = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if (auth.status === 401) { location.assign('/auth.html#login'); throw new Error('Войдите, чтобы продолжить.'); }
    if (!auth.ok) throw new Error('Не удалось проверить сеанс.');
    csrfToken = (await auth.json()).csrfToken;
  }
  const multipart = body instanceof FormData;
  const response = await fetch(`/api/hectra${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: {
      ...(method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
      ...(body !== undefined && !multipart ? { 'content-type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body)
  });
  if (response.status === 401) { location.assign('/auth.html#login'); throw new Error('Войдите, чтобы продолжить.'); }
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = null; }
  if (!response.ok) throw new Error(data?.message || data?.error?.message || `Ошибка HTTP ${response.status}`);
  if (data === null) throw new Error('Сервер вернул неожиданный ответ.');
  return data;
}

export const runUrl = id => `/run.html?id=${encodeURIComponent(id)}`;

export const states = {
  draft: 'Загрузка документов', prompts_not_configured: 'Промпты не настроены',
  key_not_configured: 'Не настроен API-ключ', running: 'Выполняется',
  needs_clarification: 'Требуется пояснение', cancelled: 'Остановлено',
  interrupted: 'Прервано', partial: 'Обработка не завершена',
  completed: 'Завершено', completed_with_limits: 'Завершено с ограничениями'
};

export const stages = {
  routing: 'Сопоставление разделов', extraction: 'Извлечение функций',
  comparison: 'Сравнение', judge: 'Проверка выводов',
  crosscheck: 'Проверка пересечений', reconcile: 'Сверка реестра',
  synthesis: 'Подготовка заключения'
};
