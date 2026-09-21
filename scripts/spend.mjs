#!/usr/bin/env node
/**
 * AI spend for Mission Control. Runs in GitHub Actions (.github/workflows/spend.yml) every hour with the
 * ANTHROPIC_ADMIN_KEY secret, reads the organisation's cost and usage reports (Usage & Cost Admin API), and
 * writes spend.json next to index.html, which the page renders. The key never reaches the browser.
 *
 * Output shape (all money in USD, tokens as numbers):
 * { at, monthStart, month: { total, byDescription: [{ description, model, amount }] }, days: [{ day, amount }] (last 31),
 *   today, yesterday, keys: [{ id, name, tokensIn, tokensOut, tokensCached, days: 7 }], error? }
 */
import { writeFileSync } from 'node:fs';

const key = process.env.ANTHROPIC_ADMIN_KEY;
const out = { at: new Date().toISOString() };
const H = { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01', 'user-agent': 'veritill-mission-control/1.0 (https://veritill.github.io/mission-control/)' };
const iso = (d) => d.toISOString().slice(0, 19) + 'Z';
const dayOf = (s) => String(s).slice(0, 10);

async function page(url) {
  const rows = []; let next = null;
  for (let i = 0; i < 20; i++) {
    const u = next ? `${url}&page=${encodeURIComponent(next)}` : url;
    const r = await fetch(u, { headers: H });
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} on ${url.split('?')[0]}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    rows.push(...(j.data ?? []));
    if (!j.has_more) break; next = j.next_page;
  }
  return rows;
}

try {
  if (!key) throw new Error('ANTHROPIC_ADMIN_KEY is not set (repository secret on Veritill/mission-control)');
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from31 = new Date(now.getTime() - 31 * 86400000); from31.setUTCHours(0, 0, 0, 0);
  const start = monthStart < from31 ? from31 : monthStart; // the cost report allows 31 daily buckets
  const end = new Date(now.getTime() + 86400000); end.setUTCHours(0, 0, 0, 0);
  out.monthStart = monthStart.toISOString().slice(0, 10);

  // Cost, by day and by description (model / service), month to date. Amounts are decimal strings in cents.
  const cost = await page(`https://api.anthropic.com/v1/organizations/cost_report?starting_at=${iso(from31)}&ending_at=${iso(end)}&group_by[]=description&limit=31`);
  const byDay = new Map(); const byDesc = new Map(); let monthTotal = 0;
  for (const b of cost) {
    const day = dayOf(b.starting_at);
    for (const r of b.results ?? []) {
      const usd = Number(r.amount ?? 0) / 100;
      byDay.set(day, (byDay.get(day) ?? 0) + usd);
      if (day >= out.monthStart) {
        monthTotal += usd;
        const k = r.description ?? r.model ?? 'other';
        const cur = byDesc.get(k) ?? { description: k, model: r.model ?? null, amount: 0 };
        cur.amount += usd; byDesc.set(k, cur);
      }
    }
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  out.days = [...byDay.entries()].sort().map(([day, amount]) => ({ day, amount: r2(amount) }));
  out.month = { total: r2(monthTotal), byDescription: [...byDesc.values()].map((x) => ({ ...x, amount: r2(x.amount) })).sort((a, b) => b.amount - a.amount) };
  const today = now.toISOString().slice(0, 10); const yday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  out.today = r2(byDay.get(today) ?? 0); out.yesterday = r2(byDay.get(yday) ?? 0);

  // Tokens by API key, last 7 days, so the product's key and the development key can be told apart.
  const from7 = new Date(now.getTime() - 7 * 86400000); from7.setUTCHours(0, 0, 0, 0);
  const usage = await page(`https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=${iso(from7)}&ending_at=${iso(end)}&bucket_width=1d&group_by[]=api_key_id&limit=7`);
  const byKey = new Map();
  for (const b of usage) for (const r of b.results ?? []) {
    const id = r.api_key_id ?? 'none';
    const cur = byKey.get(id) ?? { id, name: id === 'none' ? 'no key (console or Claude Code)' : id, tokensIn: 0, tokensOut: 0, tokensCached: 0 };
    cur.tokensIn += Number(r.uncached_input_tokens ?? 0) + Number(r.cache_creation?.ephemeral_5m_input_tokens ?? 0) + Number(r.cache_creation?.ephemeral_1h_input_tokens ?? 0);
    cur.tokensCached += Number(r.cache_read_input_tokens ?? 0);
    cur.tokensOut += Number(r.output_tokens ?? 0);
    byKey.set(id, cur);
  }
  // Names for the keys (best effort; the list endpoint is part of the same Admin API).
  try {
    const keys = await page('https://api.anthropic.com/v1/organizations/api_keys?limit=100');
    for (const k of keys) { const cur = byKey.get(k.id); if (cur) cur.name = k.name || k.partial_key_hint || k.id; }
  } catch (e) { out.keyNamesError = String(e.message || e); }
  out.keys = [...byKey.values()].sort((a, b) => (b.tokensIn + b.tokensOut) - (a.tokensIn + a.tokensOut)).map((k) => ({ ...k, days: 7 }));
} catch (e) {
  out.error = String(e.message || e);
}
writeFileSync(new URL('../spend.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(out.error ? `spend: ERROR ${out.error}` : `spend: month $${out.month.total} · today $${out.today} · ${out.keys.length} keys`);
