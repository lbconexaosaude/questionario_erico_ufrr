import { createHash } from 'node:crypto';
import { fingerprintContent } from './shared/spreadsheet.js';
export { parseCSV, parseSpreadsheet, prepareImport, createTemplate } from './shared/spreadsheet.js';
export function importFingerprint(row) { return createHash('sha256').update(fingerprintContent(row)).digest('hex'); }
