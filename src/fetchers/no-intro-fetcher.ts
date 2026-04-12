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
import crypto from 'crypto';
import unzipper from 'unzipper';
import { AbstractFetcher, type FetcherOptions } from '../base/base-fetcher.js';
import { VersionTracker } from '../core/version-tracker.js';
import type { DAT, RomEntry } from '../types/index.js';
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
          if (attempt === maxAttempts) {
            // Capture screenshot on final failure before throwing
            await this.captureErrorScreenshot(page);
            throw err;
          }
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

      // Note: verifyChecksum is not called here because Dat-o-Matic does not
      // provide an expected checksum for the daily pack download on the UI.

      // Extract zip and parse DATs
      const dats = await this.extractAndParse(finalPath);
      console.log(`[nointro] Parsed ${dats.length} games`);

      return dats;
    } catch (err) {
      // Capture screenshot on any error for debugging
      await this.captureErrorScreenshot(page);
      throw err;
    } finally {
      await browser.close();
    }
  }

  /**
   * Capture a screenshot on error for debugging
   * @param page Playwright page instance
   */
  private async captureErrorScreenshot(page: any): Promise<void> {
    try {
      const screenshotPath = path.join(this.outputDir, 'playwright-error.png');
      await page.screenshot({ path: screenshotPath });
      console.log(`[nointro] Error screenshot saved: ${screenshotPath}`);
    } catch (screenshotErr) {
      console.warn(`[nointro] Failed to capture error screenshot: ${(screenshotErr as Error).message}`);
    }
  }

  /**
   * Verify checksum of a downloaded file against expected value
   * @param filePath Path to the downloaded file
   * @param expectedChecksum Expected checksum value
   * @param algorithm Hash algorithm (md5, sha1, sha256)
   */
  async verifyChecksum(filePath: string, expectedChecksum: string, algorithm: 'md5' | 'sha1' | 'sha256' = 'md5'): Promise<void> {
    const fileBuffer = await fs.readFile(filePath);
    const hash = crypto.createHash(algorithm).update(fileBuffer).digest('hex');
    
    if (hash !== expectedChecksum.toLowerCase()) {
      throw new Error(`Checksum verification failed: expected ${expectedChecksum}, got ${hash}`);
    }
    
    console.log(`[nointro] Checksum verified: ${algorithm}=${hash}`);
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
              // Extract ROM entries from game
              const roms = extractRomsFromGame(game);
              
              dats.push({
                id: `${systemName}:${game.name || game.description || 'unknown'}`,
                source: 'no-intro',
                system: systemName,
                datVersion: new Date().toISOString(),
                description: game.name || game.description,
                roms
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

/**
 * Extract ROM entries from a game entry (No-Intro format)
 * @param game Game object from XML parser
 * @returns Array of ROM entries with name, size, CRC, MD5, SHA1
 */
function extractRomsFromGame(game: Record<string, unknown>): RomEntry[] {
  const roms: RomEntry[] = [];
  
  // No-Intro format: game has 'rom' child elements
  const romElement = game.rom;
  if (!romElement) return roms;
  
  // Handle single ROM or array of ROMs
  const romArray = Array.isArray(romElement) ? romElement : [romElement];
  
  for (const rom of romArray) {
    if (!rom || typeof rom !== 'object') continue;
    
    const romObj = rom as Record<string, unknown>;
    const entry: RomEntry = {
      name: String(romObj.name || romObj['@_name'] || ''),
      size: Number(romObj.size) || 0
    };
    
    // Add checksums if present
    if (romObj.crc) entry.crc = String(romObj.crc);
    if (romObj.md5) entry.md5 = String(romObj.md5);
    if (romObj.sha1) entry.sha1 = String(romObj.sha1);
    if (romObj.sha256) entry.sha256 = String(romObj.sha256);
    
    if (entry.name) roms.push(entry);
  }
  
  return roms;
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