import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// The front page's tour video and its poster (npm run site:media): a scripted walk through
// the dashboard with sample data (scripts/site-media.spec.ts), written into media/, which
// npm run media:publish puts in R2 at media.shipcel.com.
export default defineConfig({
  ...base,
  testDir: './scripts',
  testMatch: 'site-media.spec.ts',
  timeout: 180000,
});
