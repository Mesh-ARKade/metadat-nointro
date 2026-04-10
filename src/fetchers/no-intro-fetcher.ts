/**
 * No-Intro Fetcher - Dat-o-Matic Playwright implementation
 *
 * @intent Fetch DATs from No-Intro's Dat-o-Matic with correct filters
 * @guarantee Downloads daily pack with: Main, Aftermarket, Unofficial, Non-Redump, Redump BIOS
 * @constraint Extends AbstractFetcher, uses Playwright for browser automation
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import unzipper from 'unzipper';
import { AbstractFetcher, type FetcherOptions } from '../base/base-fetcher.js';
import { VersionTracker } from '../core/version-tracker.js';
import type { DAT } from '../types/index.js';
import { extractGameEntries } from '../core/validator.js';

const DAT_O_MATIC_URL = 'https://datomatic.no-intro.org/?page=download&op=daily';

/**
 * Checkbox configuration for Dat-o-Matic filter settings.
 * Based on project curation requirements (per ADR-0021):
 *   ✓ Main, Aftermarket, Unofficial, Non-Redump, Redump BIOS
 *   ✗ Source Code, Redump Custom, Non-Game
 */
const CHECKBOX_CONFIG = {
  set1: true,   // Main — core No-Intro verified dumps
  set2: false,  // Source Code — not needed
  set8: true,   // Aftermarket — homebrew, repros
  set4: true,   // Unofficial — community dumps
  set3: true,   // Non-Redump — disc systems outside Redump
  set6: false,  // Redump Custom — skip
  set7: true,   // Redump BIOS — need these
  set5: false,  // Non-Game — firmware/apps, skip
};

export class NoIntroFetcher extends AbstractFetcher {
  private outputDir: string;

  constructor(
    versionTracker: VersionTracker,
    outputDir: string = './dats/nointro',
    options: FetcherOptions = {}
  ) {
    super(versionTracker, {
      maxRetries: options.maxRetries ?? 3,
      retryDelay: options.retryDelay ?? 5000,
      rateLimitMs: options.rateLimitMs ?? 1000
    });
    this.outputDir = outputDir;
  }

  getSourceName(): string {
    return 'nointro';
  }

  /**
   * Check remote version by fetching the page and extracting the date
   */
  async checkRemoteVersion(): Promise<string> {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(DAT_O_MATIC_URL, { waitUntil: 'load', timeout: 60000 });
      
      // Look for version/date info on the page
      // Dat-o-Matic shows the date in various places
      const pageContent = await page.content();
      
      // Try to find a date pattern in the page
      const dateMatch = pageContent.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        return dateMatch[1];
      }
      
      // Fallback: use today's date
      return new Date().toISOString().split('T')[0];
    } finally {
      await browser.close();
    }
  }

  /**
   * Fetch DATs from Dat-o-Matic using Playwright
   */
  async fetchDats(): Promise<DAT[]> {
    await fs.mkdir(this.outputDir, { recursive: true });

    console.log('[nointro] Launching browser...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    try {
      // Navigate with retry
      let attempt = 0;
      const maxAttempts = 3;
      while (attempt < maxAttempts) {
        try {
          await page.goto(DAT_O_MATIC_URL, { waitUntil: 'load', timeout: 60000 });
          break;
        } catch (err) {
          attempt++;
          if (attempt === maxAttempts) throw err;
          console.warn(`[nointro] Navigation attempt ${attempt} failed, retrying...`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      // Apply filter settings
      console.log('[nointro] Applying filters...');
      for (const [name, shouldBeChecked] of Object.entries(CHECKBOX_CONFIG)) {
        const checkbox = page.locator(`input[type='checkbox'][name='${name}']`);
        
        if ((await checkbox.count()) === 0) {
          console.warn(`[nointro] Checkbox "${name}" not found - page structure may have changed`);
          continue;
        }

        const isChecked = await checkbox.isChecked();
        
        if (shouldBeChecked && !isChecked) {
          console.log(`[nointro]   Checking "${name}"...`);
          await checkbox.check();
        } else if (!shouldBeChecked && isChecked) {
          console.log(`[nointro]   Unchecking "${name}"...`);
          await checkbox.uncheck();
        }
      }

      // Request archive
      console.log('[nointro] Requesting archive...');
      await page.locator("button:has-text('Request'), input[value='Request']").first().click();

      // Wait for download button (up to 2 minutes)
      const downloadButton = page.locator("button:has-text('Download!!'), input[value='Download!!']").first();
      await downloadButton.waitFor({ state: 'visible', timeout: 120000 });

      // Download
      console.log('[nointro] Downloading...');
      const downloadPromise = page.waitForEvent('download');
      await downloadButton.click();

      const download = await downloadPromise;
      const filename = download.suggestedFilename();
      const finalPath = path.join(this.outputDir, filename);

      await download.saveAs(finalPath);
      console.log(`[nointro] Downloaded: ${finalPath}`);

      // Extract zip and parse DATs
      const dats = await this.extractAndParse(finalPath);
      console.log(`[nointro] Parsed ${dats.length} games`);

      return dats;
    } finally {
      await browser.close();
    }
  }

  /**
   * Extract downloaded zip and parse DAT XML files
   * @param zipPath Path to downloaded zip file
   * @returns Array of parsed DAT entries
   */
  private async extractAndParse(zipPath: string): Promise<DAT[]> {
    const dats: DAT[] = [];

    try {
      // Open and extract the zip
      const zip = await unzipper.Open.file(zipPath);
      
      for (const file of zip.files) {
        // Only process .dat and .xml files
        if (file.type === 'File' && /\.(dat|xml)$/i.test(file.path)) {
          console.log(`[nointro] Parsing: ${file.path}`);
          
          const buffer = await file.buffer();
          const content = buffer.toString('utf8');
          const result = extractGameEntries(content);
          
          if (result.valid && result.games.length > 0) {
            // Extract system name from filename
            const filename = path.basename(file.path, path.extname(file.path));
            const systemName = filename.replace(/\.dat$/i, '');
            
            for (const game of result.games) {
              dats.push({
                id: `${systemName}:${game.name || game.description || 'unknown'}`,
                source: 'no-intro',
                system: systemName,
                datVersion: new Date().toISOString(),
                description: game.name || game.description,
                roms: []
              });
            }
          }
        }
      }
    } catch (err) {
      console.error(`[nointro] Extract error: ${(err as Error).message}`);
    }

    return dats;
  }
}

// CLI entry point
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  const outputDir = process.argv[2] || './dats/nointro';
  const tracker = new VersionTracker('./versions.json');
  const fetcher = new NoIntroFetcher(tracker, outputDir);
  
  fetcher.fetch()
    .then(_dats => console.log(`[nointro] Fetch complete`))
    .catch((err: Error) => {
      console.log(`[nointro] SKIP: ${err.message}`);
      process.exit(0);
    });
}