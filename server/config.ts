import path from 'node:path';
import fs from 'node:fs';

export const DATA_DIR = path.resolve(process.env.ERRAND_DATA_DIR ?? 'data');
export const PORT = Number(process.env.ERRAND_PORT ?? 4747);
// Bind to loopback by default. Set ERRAND_HOST=0.0.0.0 (with ERRAND_PASSWORD) to use it from your phone.
export const HOST = process.env.ERRAND_HOST ?? '127.0.0.1';
export const PASSWORD = process.env.ERRAND_PASSWORD ?? '';
// Settings → Use on your phone listens here, on the network, always behind the phone code.
export const PHONE_PORT = Number(process.env.ERRAND_PHONE_PORT ?? PORT + 1);
export const WEB_DIST = path.resolve('web/dist');

fs.mkdirSync(DATA_DIR, { recursive: true });
