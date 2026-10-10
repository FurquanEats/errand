/**
 * Signals: what Errand notices in your email on its own. This file is the cheap, deterministic
 * part, with no AI and no database: which emails deserve a closer look, and the formats that can
 * be read reliably without a model (CI failures, card and UPI alerts, merchant names, habits).
 */

export type Kind = 'ci' | 'payment' | 'job' | 'order' | 'bill' | 'travel' | 'security' | 'todo';

export interface Envelope {
  from: string; // "Name <address>" or just the address
  subject: string;
  sent?: boolean; // from the Sent folder
}

const has = (re: RegExp, s: string) => re.test(s);

const CODES = /\b(verification code|one[- ]time (pass)?code|otp\b|passcode|login code|sign[- ]in code|confirm your email|verify your email)/i;
const PROMO =
  /(\d+% off|\bsale\b|\bdeals?\b|newsletter|webinar|digest|recommended for you|jobs? (alert|you may|for you)|new jobs|is hiring|weekly|top picks|% cashback|coupon)/i;

const DEV =
  /@([\w-]+\.)*(github\.com|gitlab\.com|vercel\.com|netlify\.com|circleci\.com|travis-ci\.com|bitbucket\.org|render\.com|railway\.app|fly\.io|buildkite\.com|expo\.dev|heroku\.com|cloudflare\.com|azure\.com|dev\.azure\.com)\b/i;
const FAILED = /\b(fail(ed|ing|ure)?|broken|errored|cancel(l)?ed|did not succeed|unsuccessful)\b/i;
// "[Action Required] Payment failed" from a hosting service is a bill, not a broken build.
const BILLING = /\b(payment|invoice|billing|card|subscription|plan|trial|charge|shutdown|suspend)/i;

const MONEY_SENDER =
  /(alert|bank|card|upi|kotak|hdfc|icici|sbi|axis|idfc|yesbank|indusind|federal|rbl|onecard|slice|jupiter|razorpay|paytm|phonepe|gpay|google pay|stripe|paypal|cred\b|amex|americanexpress|chase|citi|capitalone|discover|wellsfargo|venmo|cashapp|revolut|monzo|wise\.com)/i;
const MONEY_SUBJECT = /(transaction|debited|spent|payment of|paid|purchase|charge|card (used|alert)|upi|declined|you made a|payment successful|receipt from)/i;

const ATS =
  /@([\w-]+\.)*(greenhouse\.io|greenhouse-mail\.io|lever\.co|myworkday(jobs)?\.com|workday\.com|ashbyhq\.com|smartrecruiters\.com|jobvite\.com|icims\.com|workable(mail)?\.com|bamboohr\.com|recruitee\.com|teamtailor\.com|wellfound\.com|angel\.co|breezy\.hr|jazzhr\.com|personio\.(de|com)|freshteam\.com|zohorecruit\.com|rippling\.com|hirist\.com|instahyre\.com|cutshort\.io|naukri\.com|indeed\.com|linkedin\.com|ycombinator\.com|workatastartup\.com|otta\.com|welcometothejungle\.com)\b/i;
const JOB_SUBJECT =
  /\b(application|applied|applying|candidacy|candidate|interview|assessment|coding (test|challenge)|take[- ]home|offer letter|your resume|your cv|next steps|thank you for (applying|your interest)|hiring team|recruit(er|ing))\b/i;
const SENT_JOB = /\b(application|applying|resume|cv|candidature|position|role|opening|opportunit(y|ies)|internship|referral)\b/i;

const SHOPS =
  /(zomato|swiggy|uber ?eats|doordash|grubhub|deliveroo|domino|jubilant|blinkit|grofers|zepto|bigbasket|instacart|amazon|flipkart|myntra|ajio|meesho|nykaa|ebay|etsy|walmart|target\.com|bestbuy|shopify|ikea|decathlon|tatacliq|jiomart|croma|apple\.com|shiprocket|delhivery|bluedart|ekart|fedex|ups\.com|dhl|usps|aramex|dtdc)/i;
const ORDER_SUBJECT =
  /\b(your order|order (placed|confirmed|received|#|no\.?|id)|has (been )?(shipped|dispatched|delivered)|shipped|dispatched|out for delivery|arriving|delivered|on its way|refund|return (request|initiated|picked)|cancelled order|order summary)\b/i;

const TRAVEL =
  /(indigo|goindigo|airindia|air india|vistara|akasa|spicejet|united\.com|delta\.com|aa\.com|southwest|jetblue|alaskaair|ryanair|easyjet|lufthansa|emirates|qatarairways|britishairways|singaporeair|makemytrip|goibibo|cleartrip|easemytrip|ixigo|irctc|redbus|expedia|booking\.com|airbnb|agoda|hotels\.com|kayak|trip\.com|oyo|marriott|hilton|hyatt|ihg|opentable|district|bookmyshow)/i;
const TRAVEL_SUBJECT =
  /\b(flight|boarding pass|itinerary|check-?in|web check|pnr|e-?ticket|booking (confirmed|confirmation|id)|reservation|your (trip|stay|booking)|hotel|train ticket|bus ticket|gate change|delayed|rescheduled|table for)\b/i;

const BILL_SUBJECT =
  /\b(bill|statement|payment due|due (date|on|soon)|amount due|invoice|renew(al|s|ing)?|subscription|free trial|trial (ends|ending|expires)|membership|auto-?pay|auto-?debit|price (change|increase)|payment (failed|declined|unsuccessful)|plan (expir|end)|expir(es|ing|ed))\b/i;

// Things the user has to do: approvals, signatures, renewals, RSVPs.
const TODO_SUBJECT =
  /\b(action (required|needed)|awaiting (your )?approval|needs? your (approval|signature)|please (approve|sign|review|complete)|approve|docusign|sign(ature)? (request|required)|rsvp|registration (is )?(due|expir)|licen[cs]e (renewal|expir)|passport|deadline|complete your|kyc)\b/i;

const SECURITY_SUBJECT =
  /\b(new (sign|log)[- ]?in|security alert|unusual (activity|sign)|suspicious|password (was )?(changed|reset)|new device|login attempt|someone (signed|tried))\b/i;

/** Does this email deserve a closer look, and as what? Envelope only, so it costs nothing. */
export function candidateKind(e: Envelope): Kind | null {
  const from = e.from.toLowerCase();
  const s = e.subject;
  if (e.sent) return SENT_JOB.test(s) && !/^(re|fwd?):/i.test(s.trim()) ? 'job' : null;
  if (has(CODES, s)) return null;
  if (has(DEV, from) && has(FAILED, s) && !has(BILLING, s)) return 'ci';
  if (has(SECURITY_SUBJECT, s)) return 'security';
  if (has(MONEY_SENDER, from) && has(MONEY_SUBJECT, s)) return 'payment';
  if (has(PROMO, s)) return null;
  if (has(JOB_SUBJECT, s) || (has(ATS, from) && !/linkedin|indeed|naukri/.test(from))) return 'job';
  if (has(TRAVEL, from) ? has(TRAVEL_SUBJECT, s) || /confirm|ticket|booking/i.test(s) : has(TRAVEL_SUBJECT, s)) return 'travel';
  if (has(ORDER_SUBJECT, s) || (has(SHOPS, from) && /order|receipt|deliver|ship/i.test(s))) return 'order';
  if (has(BILL_SUBJECT, s)) return 'bill';
  if (has(TODO_SUBJECT, s)) return 'todo';
  return null;
}

// ── CI failures ─────────────────────────────────────────────────────────────

export interface CIFailure {
  repo: string;
  workflow: string;
  branch: string;
  url: string;
}

/**
 * GitHub: "[owner/repo] Run failed: CI - main (8825a5d)". GitLab: "owner/repo | Failed pipeline for main".
 * Netlify, Vercel and others: the project in brackets or after "for".
 */
export function parseCI(subject: string, text = ''): CIFailure | null {
  if (!FAILED.test(subject)) return null;
  const url =
    text.match(/https:\/\/[^\s"'<>)]+\/(actions\/runs\/\d+|-\/pipelines\/\d+|deploys\/[\w-]+|deployments?\/[\w-]+|pipelines\/[\w-]+)[^\s"'<>)]*/)?.[0] ?? '';
  const gh = subject.match(
    /^\[([^\]]+)\]\s+(?:Run (?:failed|cancelled)|(.+?) workflow run (?:failed|cancelled))(?::\s*(.+?)\s+-\s+(\S+?)(?:\s+\((\w+)\))?)?\s*$/i,
  );
  if (gh) return { repo: gh[1], workflow: gh[3] ?? gh[2] ?? '', branch: gh[4] ?? '', url };
  const gl = subject.match(/^(.+?)\s+\|\s+Failed pipeline for\s+(\S+)/i);
  if (gl) return { repo: gl[1].trim(), workflow: 'pipeline', branch: gl[2], url };
  const project =
    subject.match(/\[([^\]\s]+)\]/)?.[1] ?? subject.match(/\bfor\s+(?:project\s+)?["“]?([\w./-]+)/i)?.[1] ?? subject.match(/\bon\s+([\w./-]+)/i)?.[1];
  return project ? { repo: project, workflow: '', branch: '', url } : null;
}

// ── Card, UPI and wallet alerts ──────────────────────────────────────────────

export interface Payment {
  amount: number;
  currency: string;
  merchant: string;
  category: Category;
  declined: boolean;
}

const CURRENCY: Record<string, string> = {
  rs: 'INR',
  'rs.': 'INR',
  inr: 'INR',
  '₹': 'INR',
  $: 'USD',
  usd: 'USD',
  '€': 'EUR',
  eur: 'EUR',
  '£': 'GBP',
  gbp: 'GBP',
};
const AMOUNT = /(rs\.?|inr|₹|\$|usd|€|eur|£|gbp)\s?\(?(?:\$?usd\)?\s?)?([\d,]+(?:\.\d{1,2})?)/i;
const PAYEE =
  /\b(?:on|at|with|towards|to)\s+(?:vpa\s+\S+\s+)?([a-z0-9][a-z0-9*&.'’\- ]{1,40}?)(?=\s+(?:(?:using|via|through|from|has|was|is|for|ref|on\s+your|on\s+(?:mon|tue|wed|thu|fri|sat|sun)|dated)\b|on\s+\d)|\s*[.,;:\n(]|\s*$)/gi;
const NOT_PAYEE = /^(your|you|account|a\/c|ac|card|the|this|xx|\d)/i;

/** "Your transaction of Rs.1324.52 on ZOMATO LIMITED using Kotak Bank Debit Card…" → Zomato, 1324.52 INR. */
export function parsePayment(subject: string, text: string): Payment | null {
  const all = `${subject}\n${text}`.replace(/\s+/g, ' ');
  if (/\b(credited|received|refund(ed)?|cashback|reversal|reversed)\b/i.test(subject)) return null;
  const amt = all.match(AMOUNT);
  if (!amt) return null;
  const amount = Number(amt[2].replace(/,/g, ''));
  if (!amount) return null;
  let merchant = '';
  // Razorpay-style: "ZEPTO MARKETPLACE PRIVATE LIMITED ₹2346.00 Paid Successfully" / "Payment successful for X".
  const forName = subject.match(/(?:payment (?:successful|received|done) (?:for|to)|receipt from|your payment to)\s+(.+)$/i)?.[1];
  if (forName) merchant = forName;
  else
    for (const m of all.slice(amt.index!).matchAll(PAYEE)) {
      if (!NOT_PAYEE.test(m[1].trim())) {
        merchant = m[1];
        break;
      }
    }
  if (!merchant) return null;
  const { name, category } = brand(merchant);
  return {
    amount,
    currency: CURRENCY[amt[1].toLowerCase()] ?? 'INR',
    merchant: name,
    category,
    declined: /declined|could not be processed|insufficient funds|failed|unsuccessful/i.test(all),
  };
}

// ── Merchant names ──────────────────────────────────────────────────────────

export type Category = 'food' | 'groceries' | 'rides' | 'shopping' | 'subscriptions' | 'travel' | 'bills' | 'other';

const BRANDS: [RegExp, string, Category][] = [
  [/zomato/i, 'Zomato', 'food'],
  [/swiggy\s*instamart|instamart/i, 'Swiggy Instamart', 'groceries'],
  [/swiggy|bundl tech/i, 'Swiggy', 'food'],
  [/jubilant|domino/i, "Domino's", 'food'],
  [/uber\s*eats/i, 'Uber Eats', 'food'],
  [/doordash/i, 'DoorDash', 'food'],
  [/grubhub/i, 'Grubhub', 'food'],
  [/deliveroo/i, 'Deliveroo', 'food'],
  [/eatsure|rebel foods/i, 'EatSure', 'food'],
  [/mcdonald|hardcastle/i, "McDonald's", 'food'],
  [/starbucks|tata starbucks/i, 'Starbucks', 'food'],
  [/\bkfc\b|devyani/i, 'KFC', 'food'],
  [/pizza\s*hut/i, 'Pizza Hut', 'food'],
  [/chipotle/i, 'Chipotle', 'food'],
  [/zepto|kiranakart/i, 'Zepto', 'groceries'],
  [/blink\s*commerce|blinkit|grofers/i, 'Blinkit', 'groceries'],
  [/bigbasket|innovative retail|supermarket grocery/i, 'BigBasket', 'groceries'],
  [/instacart|maplebear/i, 'Instacart', 'groceries'],
  [/jiomart/i, 'JioMart', 'groceries'],
  [/uber/i, 'Uber', 'rides'],
  [/\bola\b|ani technologies/i, 'Ola', 'rides'],
  [/rapido|roppen/i, 'Rapido', 'rides'],
  [/\blyft\b/i, 'Lyft', 'rides'],
  [/amazon|amzn/i, 'Amazon', 'shopping'],
  [/flipkart/i, 'Flipkart', 'shopping'],
  [/myntra/i, 'Myntra', 'shopping'],
  [/nykaa/i, 'Nykaa', 'shopping'],
  [/meesho/i, 'Meesho', 'shopping'],
  [/\bajio\b|reliance retail/i, 'AJIO', 'shopping'],
  [/netflix/i, 'Netflix', 'subscriptions'],
  [/spotify/i, 'Spotify', 'subscriptions'],
  [/youtube|google\s*play|google\s*one/i, 'Google', 'subscriptions'],
  [/apple\.com\/bill|itunes|apple services/i, 'Apple', 'subscriptions'],
  [/openai|chatgpt/i, 'OpenAI', 'subscriptions'],
  [/hotstar|jiocinema|jiohotstar/i, 'JioHotstar', 'subscriptions'],
  [/airtel/i, 'Airtel', 'bills'],
  [/\bjio\b|reliance jio/i, 'Jio', 'bills'],
  [/indigo|interglobe/i, 'IndiGo', 'travel'],
  [/makemytrip/i, 'MakeMyTrip', 'travel'],
  [/irctc/i, 'IRCTC', 'travel'],
];

/** "PYU*Jubilant FoodWorks" → Domino's (food); "ZEPTO MARKETPLACE PRIVATE" → Zepto (groceries). */
export function brand(raw: string): { name: string; category: Category } {
  for (const [re, name, category] of BRANDS) if (re.test(raw)) return { name, category };
  const name = raw
    .replace(/^[a-z]{2,4}\*\s*/i, '')
    .replace(/\s+(marketplace|private|pvt|p|ltd|limited|inc|llc|llp|co|corp|corporation|india|technologies)\.?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { name: name || raw.trim(), category: 'other' };
}

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
