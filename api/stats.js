const TTL_SECONDS = 45 * 24 * 60 * 60; // שמירת נתונים ל-45 ימים
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '301360';

function isAuthorized(req) {
  const provided = String(req.headers['x-admin-password'] || '').trim();
  return provided.length > 0 && provided === ADMIN_PASSWORD;
}

function getRedisConfig() {
  const url = (
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    ''
  ).replace(/\/$/, '');
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    '';
  return { url, token };
}

async function redisPipeline(commands) {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    throw new Error('MISSING_REDIS_ENV');
  }
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!response.ok) {
    throw new Error(`REDIS_HTTP_${response.status}`);
  }
  return response.json();
}

function getIsraelDates(count) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const y = parseInt(parts.find((p) => p.type === 'year').value, 10);
  const m = parseInt(parts.find((p) => p.type === 'month').value, 10);
  const d = parseInt(parts.find((p) => p.type === 'day').value, 10);

  const dates = [];
  for (let i = 0; i < count; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d - i));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    dates.push(`${yy}-${mm}-${dd}`);
  }
  return dates;
}

function parseHashArray(arr) {
  const obj = {};
  if (!Array.isArray(arr)) return obj;
  for (let i = 0; i < arr.length; i += 2) {
    const key = arr[i];
    const val = parseInt(arr[i + 1], 10) || 0;
    if (key && val > 0) obj[key] = val;
  }
  return obj;
}

function mergeHashes(target, sourceObj) {
  for (const [key, val] of Object.entries(sourceObj)) {
    target[key] = (target[key] || 0) + val;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const { url, token } = getRedisConfig();
  if (!url || !token) {
    return res.status(500).json({
      error: 'משתני הסביבה של Upstash Redis לא נמצאו ב-Vercel',
    });
  }

  try {
    const today = getIsraelDates(1)[0];

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          body = {};
        }
      }
      body = body || {};

      const action = String(body.action || '');

      // 1. רישום כניסה חדשה + מקור הגעה (פתוח לכל מבקר)
      if (action === 'visit') {
        const source = String(body.source || 'direct').slice(0, 40);
        await redisPipeline([
          ['INCR', `stats:v:${today}`],
          ['EXPIRE', `stats:v:${today}`, TTL_SECONDS],
          ['HINCRBY', `stats:s:${today}`, source, 1],
          ['EXPIRE', `stats:s:${today}`, TTL_SECONDS],
        ]);
        return res.status(200).json({ ok: true, date: today });
      }

      // 2. ביטול כניסה נוכחית (מוגן בסיסמת מנהל)
      if (action === 'cancel') {
        if (!isAuthorized(req)) {
          return res.status(401).json({ error: 'סיסמה שגויה' });
        }

        const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))
          ? String(body.date)
          : today;
        const source = String(body.source || 'direct').slice(0, 40);

        const current = await redisPipeline([
          ['GET', `stats:v:${dateKey}`],
          ['HGET', `stats:s:${dateKey}`, source],
        ]);

        const currentVisits = parseInt(current[0]?.result || '0', 10) || 0;
        const currentSource = parseInt(current[1]?.result || '0', 10) || 0;

        const decrCommands = [];
        if (currentVisits > 0) {
          decrCommands.push(['DECR', `stats:v:${dateKey}`]);
        }
        if (currentSource > 0) {
          decrCommands.push(['HINCRBY', `stats:s:${dateKey}`, source, -1]);
        }
        if (decrCommands.length > 0) {
          await redisPipeline(decrCommands);
        }

        return res.status(200).json({ ok: true, cancelled: true });
      }

      // 3. רישום לחיצה על כפתור (פתוח לכל מבקר)
      if (action === 'click') {
        const button = String(body.button || '').trim().slice(0, 60);
        if (!button) return res.status(400).json({ error: 'Missing button' });
        await redisPipeline([
          ['HINCRBY', `stats:c:${today}`, button, 1],
          ['EXPIRE', `stats:c:${today}`, TTL_SECONDS],
        ]);
        return res.status(200).json({ ok: true });
      }

      // 4. שמירה או מחיקה של "עדכון השבוע" + קישור תמונה (מוגן בסיסמת מנהל)
      if (action === 'set_update') {
        if (!isAuthorized(req)) {
          return res.status(401).json({ error: 'סיסמה שגויה' });
        }

        const text = String(body.text || '').trim().slice(0, 220);
        const rawImage = String(body.image || '').trim().slice(0, 1000);
        const image =
          /^https?:\/\//i.test(rawImage) || /^[a-zA-Z0-9._\-\/~]+$/.test(rawImage)
            ? rawImage
            : '';

        const cmds = [];
        if (text) {
          cmds.push(['SET', 'site:weekly_update', text]);
        } else {
          cmds.push(['DEL', 'site:weekly_update']);
        }

        if (image) {
          cmds.push(['SET', 'site:weekly_update_image', image]);
        } else {
          cmds.push(['DEL', 'site:weekly_update_image']);
        }

        await redisPipeline(cmds);
        return res.status(200).json({
          ok: true,
          weeklyUpdate: text,
          weeklyUpdateImage: image,
        });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'GET') {
      // שליפה מהירה של עדכון השבוע והתמונה בלבד (פתוח לכל מבקר)
      if (
        (req.query && req.query.only === 'update') ||
        (req.url && req.url.includes('only=update'))
      ) {
        const resUpdate = await redisPipeline([
          ['GET', 'site:weekly_update'],
          ['GET', 'site:weekly_update_image'],
        ]);
        return res.status(200).json({
          weeklyUpdate: resUpdate[0]?.result || '',
          weeklyUpdateImage: resUpdate[1]?.result || '',
        });
      }

      // שליפת הסטטיסטיקות המלאות (מוגן בסיסמת מנהל)
      if (!isAuthorized(req)) {
        return res.status(401).json({ error: 'סיסמה שגויה' });
      }

      const dates = getIsraelDates(30); // 0 = היום, 0..6 = שבוע, 0..29 = חודש
      const visitKeys = dates.map((d) => `stats:v:${d}`);

      const commands = [
        ['MGET', ...visitKeys],
        ...dates.map((d) => ['HGETALL', `stats:s:${d}`]),
        ...dates.map((d) => ['HGETALL', `stats:c:${d}`]),
        ['GET', 'site:weekly_update'],
        ['GET', 'site:weekly_update_image'],
      ];

      const results = await redisPipeline(commands);
      const visitCounts = (results[0]?.result || []).map((v) =>
        Math.max(0, parseInt(v || '0', 10) || 0)
      );
      const sourceHashes = results
        .slice(1, 31)
        .map((r) => parseHashArray(r?.result));
      const clickHashes = results
        .slice(31, 61)
        .map((r) => parseHashArray(r?.result));

      function aggregate(daysCount) {
        let visits = 0;
        const sources = {};
        const clicks = {};
        for (let i = 0; i < daysCount; i++) {
          visits += visitCounts[i] || 0;
          mergeHashes(sources, sourceHashes[i]);
          mergeHashes(clicks, clickHashes[i]);
        }
        return { visits, sources, clicks };
      }

      return res.status(200).json({
        todayDate: today,
        weeklyUpdate: results[61]?.result || '',
        weeklyUpdateImage: results[62]?.result || '',
        day: aggregate(1),
        week: aggregate(7),
        month: aggregate(30),
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
