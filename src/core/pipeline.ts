/**
 * Pipeline CLI
 *
 * @intent Orchestrate the full pipeline: fetch → group → compress → release
 * @guarantee Integrates all core components with proper error handling
 * 
 * Pipeline flow:
 *   FETCH → VALIDATE → GROUP → JSONL → COMPRESS → MANIFEST → RELEASE → NOTIFY
 */

import { parseArgs } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { VersionTracker } from './version-tracker.js';
      // Remove unused imports - keeping for reference
      // import { validateFile, checkExtension, extractGameEntries } from './validator.js';
import { compress } from './compressor.js';
import { GitHubReleaser } from './releaser.js';
import { DiscordNotifier } from './notifier.js';
import type { DAT, GroupedDATs, Artifact, PipelineEvent } from '../types/index.js';

import { NoIntroFetcher } from '../fetchers/no-intro-fetcher.js';
import { NoIntroGroupStrategy } from '../strategies/no-intro-grouping.js';

interface PipelineOptions {
  dryRun: boolean;
  source: string;
  outputDir: string;
  skipNotification: boolean;
}

/**
 * Convert DAT[] to JSONL string (one JSON object per line)
 */
function datsToJSONL(dats: DAT[]): string {
  return dats.map(dat => JSON.stringify(dat)).join('\n');
}

/**
 * Generate artifact name from source and group
 */
      // Remove unused code for now
      // function generateArtifactName(source: string, group: string): string {
      //   return `${source}--${group}.jsonl.zst`;
      // }

/**
 * Main pipeline orchestration
 */
export async function runPipeline(options: PipelineOptions): Promise<void> {
  const startTime = Date.now();
  const versionTracker = new VersionTracker('./versions.json');
  const groupStrategy = new NoIntroGroupStrategy();
  
  console.log(`[pipeline] Starting ${options.source} pipeline...`);
  
  // Send started notification
  if (!options.skipNotification) {
    const notifier = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL || '');
    const event: PipelineEvent = {
      type: 'started',
      source: options.source,
      timestamp: new Date().toISOString()
    };
    await notifier.notify(event).catch(console.error);
  }

  try {
    // ============================================
    // STEP 1: FETCH DATs
    // ============================================
    console.log('[pipeline] Fetching DATs...');
    
    // Check version to decide skip
    const fetcher = new NoIntroFetcher(versionTracker, options.outputDir);
    const shouldSkip = await fetcher.shouldSkip();
    
    if (shouldSkip) {
      console.log('[pipeline] Already on latest version, skipping...');
      
      if (!options.skipNotification) {
        const notifier = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL || '');
        const storedVersion = fetcher.getStoredVersion();
        const event: PipelineEvent = {
          type: 'skipped',
          source: options.source,
          timestamp: new Date().toISOString(),
          skipReason: `Upstream version ${storedVersion} unchanged`
        };
        await notifier.notify(event).catch(console.error);
      }
      
      const duration = Math.floor((Date.now() - startTime) / 1000);
      console.log(`[pipeline] Skipped in ${duration}s`);
      return;
    }
    
    const dats = await fetcher.fetch();
    console.log(`[pipeline] Fetched ${dats.length} games`);
    
    if (dats.length === 0) {
      console.log('[pipeline] No DATs fetched, skipping...');
      // const duration = Math.floor((Date.now() - startTime) / 1000);
      return;
    }
    
    // ============================================
    // STEP 2: GROUP DATs by manufacturer
    // ============================================
    console.log('[pipeline] Grouping DATs...');
    const groupedDats: GroupedDATs = groupStrategy.group(dats);
    
    const groupNames = Object.keys(groupedDats);
    console.log(`[pipeline] Created ${groupNames.length} groups: ${groupNames.join(', ')}`);
    
    // ============================================
    // STEP 3: CONVERT to JSONL + COMPRESS
    // ============================================
    console.log('[pipeline] Converting and compressing...');
    const artifacts: Artifact[] = [];
    const outputDir = options.outputDir;
    
    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });
    
    for (const groupName of groupNames) {
      const groupDats = groupedDats[groupName];
      if (!groupDats || groupDats.length === 0) continue;
      
      // Convert to JSONL
      const jsonlContent = datsToJSONL(groupDats);
      const jsonlFileName = `${options.source}--${groupName}.jsonl`;
      const jsonlPath = path.join(outputDir, jsonlFileName);
      await fs.writeFile(jsonlPath, jsonlContent);
      
      // Compress to .zst
      const zstFileName = `${options.source}--${groupName}.jsonl.zst`;
      const zstPath = path.join(outputDir, zstFileName);
      const artifact = await compress(jsonlPath, zstPath);
      
      artifacts.push({
        name: artifact.name,
        path: artifact.path,
        size: artifact.size,
        sha256: artifact.sha256,
        entryCount: artifact.entryCount,
        systems: groupDats.map(d => ({ id: d.system, name: d.system, gameCount: d.roms?.length || 1 }))
      });
      
      console.log(`[pipeline] Created: ${zstFileName} (${artifact.size} bytes)`);
    }
    
    // ============================================
    // STEP 4: Create manifest.json
    // ============================================
    console.log('[pipeline] Generating manifest...');
    const manifest = {
      version: '1.0.0',
      generated: new Date().toISOString(),
      sources: [{
        name: options.source as 'no-intro' | 'tosec' | 'redump' | 'mame',
        repo: `Mesh-ARKade/metadat-${options.source}`,
        release: `${options.source}${new Date().toISOString().split('T')[0]}`,
        date: new Date().toISOString().split('T')[0],
        artifacts: artifacts.map(a => ({
          name: a.name,
          url: `https://github.com/Mesh-ARKade/metadat-${options.source}/releases/latest/${a.name}`,
          size: a.size,
          sha256: a.sha256,
          systems: a.systems || []
        }))
      }]
    };
    
    const manifestPath = path.join(outputDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`[pipeline] Created: manifest.json`);
    
    // ============================================
    // STEP 5: Create GitHub Release (unless dry-run)
    // ============================================
    const duration = Math.floor((Date.now() - startTime) / 1000);
    const totalEntries = dats.length;
    
    if (!options.dryRun && artifacts.length > 0) {
      console.log('[pipeline] Creating GitHub release...');
      const releaser = new GitHubReleaser(
        process.env.GITHUB_OWNER || 'Mesh-ARKade',
        process.env.GITHUB_REPO || `metadat-${options.source}`,
        process.env.GITHUB_TOKEN || ''
      );
      
      // Source-specific tag format: no-intro-2026-04-10
      const tag = `${options.source}-${new Date().toISOString().split('T')[0]}`;
      const release = await releaser.createRelease(tag, artifacts);
      console.log(`[pipeline] Release created: ${release.htmlUrl}`);
      
      // Success notification
      if (!options.skipNotification) {
        const notifier = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL || '');
        const event: PipelineEvent = {
          type: 'success',
          source: options.source,
          timestamp: new Date().toISOString(),
          duration,
          entryCount: totalEntries,
          artifactCount: artifacts.length
        };
        await notifier.notify(event).catch(console.error);
      }
    }
    
    console.log(`[pipeline] Completed: ${totalEntries} entries → ${artifacts.length} artifacts in ${duration}s`);
    
  } catch (err) {
    const duration = Math.floor((Date.now() - startTime) / 1000);
    
    // Send failure notification
    if (!options.skipNotification) {
      const notifier = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL || '');
      const event: PipelineEvent = {
        type: 'failure',
        source: options.source,
        timestamp: new Date().toISOString(),
        duration,
        error: (err as Error).message
      };
      await notifier.notify(event).catch(console.error);
    }
    
    console.error(`[pipeline] Failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

/**
 * CLI entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      'dry-run': {
        type: 'boolean',
        default: false,
        short: 'd'
      },
      source: {
        type: 'string',
        short: 's',
        default: 'test'
      },
      'output-dir': {
        type: 'string',
        short: 'o',
        default: './output'
      },
      'skip-notification': {
        type: 'boolean',
        default: false
      },
      help: {
        type: 'boolean',
        short: 'h',
        default: false
      }
    }
  });

  if (values.help) {
    console.log(`
METADAT Pipeline CLI

Usage: node scripts/pipeline.js [options]

Options:
  -d, --dry-run          Run without creating release
  -s, --source           Source name (default: test)
  -o, --output-dir       Output directory (default: ./output)
      --skip-notification  Don't send Discord notifications
  -h, --help             Show this help message

Environment Variables:
  GITHUB_OWNER           GitHub owner/organization
  GITHUB_REPO            GitHub repository name
  GITHUB_TOKEN           GitHub token for releases
  DISCORD_WEBHOOK_URL    Discord webhook URL for notifications
`);
    process.exit(0);
  }

  runPipeline({
    dryRun: values['dry-run'] || false,
    source: values.source || 'test',
    outputDir: values['output-dir'] || './output',
    skipNotification: values['skip-notification'] || false
  }).catch(console.error);
}