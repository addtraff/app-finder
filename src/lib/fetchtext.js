// Простой сборщик текста внешней страницы: privacy policy живёт на домене разработчика,
// не в Play. Только текст, без выполнения JS — большинство privacy-страниц статические;
// те, что рендерятся на клиенте, честно дают пусто, а не ложный "не найдено".
export async function fetchPageText(url, { timeoutMs = 12000, maxBytes = 800_000 } = {}) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(u.toString(), {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; play-radar-privacy-scan/1.0)' },
    });
    if (!res.ok) return { ok: false, status: res.status, text: null };
    const buf = await res.arrayBuffer();
    const raw = Buffer.from(buf.slice(0, maxBytes)).toString('utf8');
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: true, status: res.status, text };
  } catch (e) {
    return { ok: false, status: null, text: null, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}
