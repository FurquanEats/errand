import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHabits, findSubscriptions } from '../server/signals.ts';

test('a weekly habit is found, daily orders are not', () => {
  const tz = 'Asia/Kolkata';
  const now = Date.parse('2026-10-09T12:00:00+05:30'); // a Friday
  const fridays = [1, 2, 3, 5].map((w) => ({
    merchant: 'Zomato',
    category: 'food' as const,
    at: Date.parse('2026-10-02T20:10:00+05:30') - (w - 1) * 7 * 86400_000,
  }));
  const other = { merchant: 'Zomato', category: 'food' as const, at: Date.parse('2026-09-23T13:00:00+05:30') };
  const daily = Array.from({ length: 40 }, (_, i) => ({ merchant: 'Zepto', category: 'groceries' as const, at: now - i * 86400_000 - 3600_000 }));
  const habits = findHabits([...fridays, other, ...daily], tz, now);
  assert.deepEqual(habits, [{ merchant: 'Zomato', category: 'food', day: 5, hour: 20, weeks: 4 }]);
  assert.deepEqual(findHabits(fridays.slice(0, 2), tz, now), []);
});

test('steady charges become subscriptions; one-offs and stopped ones do not', () => {
  const now = Date.UTC(2026, 9, 10);
  const day = 86400_000;
  const p = (merchant: string, amount: number, daysAgo: number) => ({
    merchant,
    amount,
    currency: '₹',
    at: now - daysAgo * day,
    category: merchant === 'Zomato' ? 'food' : 'other',
  });
  const subs = findSubscriptions(
    [
      p('Netflix', 649, 3),
      p('Netflix', 649, 33),
      p('Netflix', 649, 63),
      p('Spotify', 119, 10),
      p('Spotify', 129, 40), // a small price change still counts
      p('Zomato', 420, 2),
      p('Zomato', 380, 9),
      p('Zomato', 610, 30), // food orders: amounts and gaps vary
      p('Gym', 1500, 100),
      p('Gym', 1500, 130), // stopped two months ago
      p('Amazon', 999, 5), // once
    ],
    now,
  );
  assert.deepEqual(
    subs.map((s) => `${s.merchant} ${s.every}`),
    ['Netflix month', 'Spotify month'],
  );
  assert.equal(subs[0].charges, 3);
});
