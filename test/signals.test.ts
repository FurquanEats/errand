import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brand, candidateKind, findHabits, parseCI, parsePayment } from '../server/signals.ts';

test('emails worth a closer look are picked from the envelope alone', () => {
  const kind = (from: string, subject: string, sent = false) => candidateKind({ from, subject, sent });
  assert.equal(kind('GitHub <notifications@github.com>', '[acme/shop] Run failed: CI - main (8825a5d)'), 'ci');
  assert.equal(kind('notifications@github.com', '[acme/shop] Pull request #12 merged'), null);
  assert.equal(kind('Render <no-reply@render.com>', '[Action Required] Payment Failed And Shutdown Coming Soon'), 'bill');
  assert.equal(kind('BankAlerts@kotak.com', 'Card online transaction- Successful'), 'payment');
  assert.equal(kind('no-reply@kotak.com', 'Payment of INR 250.00 successful'), 'payment');
  assert.equal(kind('Raycast <no-reply@greenhouse.io>', 'Thank you for applying to Raycast'), 'job');
  assert.equal(kind('jobs-noreply@linkedin.com', '10 new jobs for you: Software Engineer'), null);
  assert.equal(kind('me@example.com', 'Application for Software Developer Role | Sam Lee', true), 'job');
  assert.equal(kind('me@example.com', 'Re: Application for Software Developer Role', true), null);
  assert.equal(kind('me@example.com', 'Dinner on Friday?', true), null);
  assert.equal(kind('IndiGo <reservations@goindigo.in>', 'Your IndiGo booking is confirmed - PNR ABC123'), 'travel');
  assert.equal(kind('Amazon.in <shipment-tracking@amazon.in>', 'Out for delivery: Your Amazon order'), 'order');
  assert.equal(kind('Airtel <ebill@airtel.com>', 'Your Airtel bill of Rs 799 is due on 12 Oct'), 'bill');
  assert.equal(kind('Google <no-reply@accounts.google.com>', 'Security alert: new sign-in on Windows'), 'security');
  assert.equal(kind('Zomato <noreply@zomato.com>', 'Your OTP for Zomato is 482913'), null);
  assert.equal(kind('Myntra <news@myntra.com>', 'Big Fashion Sale: 70% off'), null);
});

test('CI failures are read from GitHub, GitLab and deploy emails', () => {
  assert.deepEqual(parseCI('[acme/shop] Run failed: CI - main (8825a5d)', 'View workflow run https://github.com/acme/shop/actions/runs/123456 now'), {
    repo: 'acme/shop',
    workflow: 'CI',
    branch: 'main',
    url: 'https://github.com/acme/shop/actions/runs/123456',
  });
  assert.equal(parseCI('acme/shop | Failed pipeline for main | 8825a5d')?.repo, 'acme/shop');
  assert.equal(parseCI('[Netlify] Deploy failed for shop-site')?.repo, 'Netlify');
  assert.equal(parseCI('[acme/shop] Run succeeded: CI - main'), null);
  assert.equal(parseCI('[Action Required] Build failed'), null);
});

test('card, UPI and gateway alerts give the merchant and amount', () => {
  const kotak = parsePayment(
    'Card online transaction- Successful',
    'Dear Customer, Your transaction of Rs.1324.52 on ZOMATO LIMITED using Kotak Bank Debit Card XX1234 on 03/10/2026 23:13:55 from your account XX9999 has been processed.',
  );
  assert.deepEqual(kotak, { amount: 1324.52, currency: 'INR', merchant: 'Zomato', category: 'food', declined: false });
  assert.equal(
    parsePayment('Card online transaction- Successful', 'Your transaction of Rs.291.00 on ZEPTO MARKETPLACE P using Kotak Bank Debit Card')?.merchant,
    'Zepto',
  );
  assert.equal(
    parsePayment('Card online transaction- Successful', 'Your transaction of Rs.1017.45 on PYU*Jubilant FoodWorks using Kotak')?.merchant,
    "Domino's",
  );
  assert.equal(
    parsePayment('Payment of INR 250.00 successful', 'You have successfully made a UPI payment of INR 250.00 towards ALEX JOHN through the App.')?.merchant,
    'Alex John',
  );
  assert.equal(
    parsePayment('Payment successful for ZEPTO MARKETPLACE PRIVATE LIMITED', 'ZEPTO MARKETPLACE PRIVATE LIMITED ₹2346.00 Paid Successfully')?.amount,
    2346,
  );
  assert.equal(
    parsePayment('Card Transaction declined- Insufficient funds', 'Your transaction at grofers using Kotak Bank Debit Card XX1234 could not be processed')
      ?.declined ?? 'no amount',
    'no amount',
  );
  const sbi = parsePayment('Transaction alert', 'Rs 234.00 spent on your SBI Credit Card ending 1234 at SWIGGY on 08/10/26.');
  assert.equal(sbi?.merchant, 'Swiggy');
  const chase = parsePayment('You made a $23.45 transaction with DoorDash', 'A $23.45 transaction with DOORDASH*CHIPOTLE was made on your card.');
  assert.deepEqual([chase?.merchant, chase?.currency], ['DoorDash', 'USD']);
  assert.equal(parsePayment('Amount credited', 'Rs.500 credited to your account from ACME'), null);
});

test('merchant names are cleaned up', () => {
  assert.deepEqual(brand('BLINK COMMERCE PVT LTD'), { name: 'Blinkit', category: 'groceries' });
  assert.deepEqual(brand('Cas*UNITY SMALL FINANC'), { name: 'Unity Small Financ', category: 'other' });
});

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
