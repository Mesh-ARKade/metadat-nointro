/**
 * Pipeline CLI
 *
 * @intent Orchestrate the full pipeline: fetch → group → compress → release
 * @guarantee Integrates all core components with proper error handling
 * 
 * Pipeline flow:
 *   FETCH → VALIDATE → GROUP → JSONL → TRAIN DICT → COMPRESS → MANIFEST → RELEASE → NOTIFY
 */

import { parseArgs } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { VersionTracker } from './version-tracker.js';
import { compress, trainDictionary, compressWithDictionary } from './compressor.js';
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

function datsToJSONL(dats: DAT[]): string {
  return dats.map(dat => JSON.stringify(dat)).join('\n');
}

export async function runPipeline(options: PipelineOptions): Promise<void> {
  const startTime = Date.now();
  const versionTracker = new VersionTracker('./versions.json');
  const groupStrategy = new NoIntroGroupStrategy();
  
  console.log(`[pipeline] Starting ${options.source} pipeline...`);
  
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
    console.log('[pipeline] Fetching DATs...');
    const fetcher = new NoIntroFetcher(versionTracker, options.outputDir);
    const shouldSkip = await fetcher.shouldSkip();
    
    if (shouldSkip) {
      console.log('[pipeline] Already on latest version, skipping...');
      if (!options.skipNotification) {
        const notifier = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL || '');
        const event: PipelineEvent = {
          type: 'skipped',
          source: options.source,
          timestamp: new Date().toISOString(),
          skipReason: 'Upstream unchanged'
        };
        await notifier.notify(event).catch(console.error);
      }
      return;
    }
    
    const dats = await fetcher.fetch();
    console.log(`[pipeline] Fetched ${dats.length} games`);
    
    if (dats.length === 0) {
      console.log('[pipeline] No DATs fetched, skipping...');
      return;
    }
    
    console.log('[pipeline] Grouping DATs...');
    const groupedDats: GroupedDATs = groupStrategy.group(dats);
    const groupNames = Object.keys(groupedDats);
    console.log(`[pipeline] Created ${groupNames.length} groups: ${groupNames.join(', ')}`);
    
    const artifacts: Artifact[] = [];
    const outputDir = options.outputDir;
    await fs.mkdir(outputDir, { recursive: true });
    
    // Train dictionary from sample
    const dictDir = path.join(outputDir, '.dict');
    let dictPath = '';
    try {
      await fs.mkdir(dictDir, { recursive: true });
      dictPath = path.join(dictDir, `${options.source}.dict`);
      const sample = JSON.stringify(dats.slice(0, 10));
      await trainDictionary([sample], dictPath);
      console.log('[pipeline] Dictionary trained');
    } catch (dictErr) {
      console.log(`[pipeline] Dictionary skipped: ${(dictErr as Error).message}`);
    }
    
    for (const groupName of groupNames) {
      const groupDats = groupedDats[groupName];
      if (!groupDats || groupDats.length === 0) continue;
      
      const jsonlContent = datsToJSONL(groupDats);
      const jsonlFileName = `${options.source}--${groupName}.jsonl`;
      const jsonlPath = path.join(outputDir, jsonlFileName);
      await fs.writeFile(jsonlPath, jsonlContent);
      
      const zstFileName = `${options.source}--${groupName}.jsonl.zst`;
      const zstPath = path.join(outputDir, zstFileName);
      let artifact;
      
      if (dictPath) {
        try {
          await fs.readFile(dictPath);
          artifact = await compressWithDictionary(jsonlContent, zstPath, dictPath);
          console.log(`[pipeline] Created: ${zstFileName} (${artifact.size} bytes) with dictionary`);
        } catch {
          artifact = await compress(jsonlContent, zstPath);
          console.log(`[pipeline] Created: ${zstFileName} (${artifact.size} bytes)`);
        }
      } else {
        artifact = await compress(jsonlContent, zstPath);
        console.log(`[pipeline] Created: ${zstFileName} (${artifact.size} bytes)`);
      }
      
      artifacts.push({
        name: artifact.name,
        path: artifact.path,
        size: artifact.size,
        sha256: artifact.sha256,
        entryCount: artifact.entryCount,
        systems: groupDats.map(d => ({ id: d.system, name: d.system, gameCount: d.roms?.length || 1 }))
      });
    }
    
    console.log('[pipeline] Generating manifest...');
    const manifest = {
      version: '1.0.0',
      generated: new Date().toISOString(),
      sources: [{
        name: options.source as 'no-intro' | 'tosec' | 'redump' | 'mame',
        repo: `Mesh-ARKade/metadat-${options.source}`,
        release: `${options.source}-${new Date().toISOString().split('T')[0]}`,
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
    
    const totalEntries = dats.length;
    
    if (!options.dryRun && artifacts.length > 0) {
      console.log('[pipeline] Creating GitHub release...');
      const releaser = new GitHubReleaser(
        process.env.GITHUB_OWNER || 'Mesh-ARKade',
        process.env.GITHUB_REPO || `metadat-${options.source}`,
        process.env.GITHUB_TOKEN || ''
      );
      const tag = `${options.source}-${new Date().toISOString().split('T')[0]}`;
      await releaser.createRelease(tag, artifacts);
    }
    
    if (!options.skipNotification) {
      const notifier = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL || '');
      const duration = Math.floor((Date.now() - startTime) / 1000);
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
    
    console.log(`[pipeline] Completed: ${totalEntries} entries → ${artifacts.length} artifacts`);
    
  } catch (err) {
    if (!options.skipNotification) {
      const notifier = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL || '');
      const event: PipelineEvent = {
        type: 'failure',
        source: options.source,
        timestamp: new Date().toISOString(),
        error: (err as Error).message
      };
      await notifier.notify(event).catch(console.error);
    }
    console.error(`[pipeline] Failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false, short: 'd' },
      source: { type: 'string', short: 's', default: 'test' },
      'output-dir': { type: 'string', short: 'o', default: './output' },
      'skip-notification': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  });

  if (values.help) {
    console.log(`
METADAT Pipeline CLI
Usage: node dist/core/pipeline.js [options]
Options:
  -d, --dry-run          Run without creating release
  -s, --source           Source name (default: test)
  -o, --output-dir       Output directory (default: ./output)
      --skip-notification
  -h, --help

Environment Variables:
  GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, DISCORD_WEBHOOK_URL
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