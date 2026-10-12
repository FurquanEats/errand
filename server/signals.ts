/**
 * Statistics over what the AI has already read from email: weekly habits ("Zomato most Fridays")
 * and recurring charges. Understanding the emails themselves is the AI's job (see trackers.ts).
 */

export type Category = 'food' | 'groceries' | 'rides' | 'shopping' | 'subscriptions' | 'travel' | 'bills' | 'other';

// ── Habits ───────────────────────────────────────────────────────────────────

export interface Habit {
  merchant: string;
  category: Category;
  day: number; // 0 = Sunday
  hour: number; // typical local hour
  weeks: number; // how many different weeks it happened on that day
}

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const local = (ts: number, tz: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
      .formatToParts(ts)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hour: Number(p.hour) % 24 };
};
export const localTime = local;

/**
 * "Orders from Zomato most Fridays around 8 PM". A habit is a weekday that keeps coming back
 * (3+ different weeks out of the last 10) and stands out from the rest of that merchant's
 * orders (at least 30% of the days ordered), so daily grocery runs don't count as a Friday habit.
 */
export function findHabits(purchases: { merchant: string; category: Category; at: number }[], tz: string, now = Date.now()): Habit[] {
  const since = now - 70 * 86400_000;
  const by = new Map<string, { category: Category; days: Map<string, { day: number; hour: number; at: number }> }>();
  for (const p of purchases) {
    if (p.at < since || p.at > now || !['food', 'groceries', 'rides'].includes(p.category)) continue;
    const t = local(p.at, tz);
    const m = by.get(p.merchant) ?? { category: p.category, days: new Map() };
    if (!m.days.has(t.date)) m.days.set(t.date, { day: t.day, hour: t.hour, at: p.at });
    by.set(p.merchant, m);
  }
  const habits: Habit[] = [];
  for (const [merchant, { category, days }] of by) {
    const list = [...days.values()];
    for (let day = 0; day < 7; day++) {
      const on = list.filter((d) => d.day === day);
      if (on.length < 3 || on.length / list.length < 0.3) continue;
      if (now - Math.max(...on.map((d) => d.at)) > 22 * 86400_000) continue; // stopped
      const hours = on.map((d) => d.hour).sort((a, b) => a - b);
      habits.push({ merchant, category, day, hour: hours[Math.floor(hours.length / 2)], weeks: on.length });
    }
  }
  return habits.sort((a, b) => b.weeks - a.weeks);
}

export const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;

export interface Subscription {
  merchant: string;
  amount: number;
  currency: string;
  every: 'week' | 'month' | 'year';
  charges: number;
  last: number;
  next: number;
}

const CADENCE: [Subscription['every'], number, number][] = [
  ['week', 6, 8],
  ['month', 26, 35],
  ['year', 350, 380],
];

/**
 * Recurring charges: the same merchant, about the same amount, at a steady weekly, monthly or
 * yearly rhythm ("Netflix, ₹649 a month"). One that has missed two charges has stopped.
 */
export function findSubscriptions(
  purchases: { merchant: string; amount: number | null; currency: string; at: number; category?: string }[],
  now = Date.now(),
): Subscription[] {
  const by = new Map<string, { amount: number; currency: string; at: number }[]>();
  for (const p of purchases) {
    // Food, groceries and rides repeat too, but those are habits, not subscriptions.
    if (!p.amount || p.amount <= 0 || p.at > now || ['food', 'groceries', 'rides'].includes(p.category ?? '')) continue;
    by.set(p.merchant, [...(by.get(p.merchant) ?? []), { amount: p.amount, currency: p.currency, at: p.at }]);
  }
  const out: Subscription[] = [];
  for (const [merchant, list] of by) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.at - b.at);
    const amounts = list.map((p) => p.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const same = list.filter((p) => Math.abs(p.amount - median) <= median * 0.15);
    if (same.length < 2) continue;
    const gaps = same.slice(1).map((p, i) => (p.at - same[i].at) / 86400_000);
    const fit = CADENCE.find(([, lo, hi]) => gaps.every((g) => g >= lo && g <= hi));
    if (!fit || (fit[0] === 'week' && same.length < 3)) continue;
    const period = (fit[1] + fit[2]) / 2;
    const last = same[same.length - 1];
    if ((now - last.at) / 86400_000 > period * 2) continue; // stopped
    out.push({ merchant, amount: median, currency: last.currency, every: fit[0], charges: same.length, last: last.at, next: last.at + period * 86400_000 });
  }
  return out.sort((a, b) => b.amount - a.amount);
}
