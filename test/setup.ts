import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every test run gets a throwaway data directory, so tests never touch real data.
process.env.ERRAND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'errand-test-'));
process.env.ERRAND_PORT = '4747';
