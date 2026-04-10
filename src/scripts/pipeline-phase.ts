/**
 * Pipeline Phase Runner
 * 
 * @intent Run individual pipeline phases for GitHub Actions visibility
 * @guarantee Each phase can run independently with proper state management
 */

import { parseArgs } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { VersionTracker } from '../core/version-tracker.js';
import { compress, trainDictionary, compressWithDictionary } from '../core/compressor.js';
import { GitHubReleaser } from '../core/releaser.js';
import type { DAT, GroupedDATs, Artifact } from '../types/index.js';
import { NoIntroFetcher } from '../fetchers/no-intro-fetcher.js';
import { NoIntroGroupStrategy } from '../strategies/no-intro-grouping.js';

type Phase = 'fetch' | 'group' | 'dict' | 'jsonl' | 'compress' | 'release';

interface PhaseOptions {
  source: string;
  phase: Phase;
  outputDir: string;
}

const STATE_FILE = '.pipeline-state.json';

interface PipelineState {
  source: string;
  dats?: DAT[];
  groupedDats?: GroupedDATs;
  artifacts?: Artifact[];
  dictPath?: string;
}

async function loadState(): Promise<PipelineState | null> {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveState(state: PipelineState): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function runPhase(options: PhaseOptions): Promise<void> {
  const outputDir = options.outputDir;
  await fs.mkdir(outputDir, { recursive: true });
  
  const state = await loadState() || { source: options.source };
  
  switch (options.phase) {
    case 'fetch': {
      console.log('[phase:fetch] Fetching DATs...');
      const versionTracker = new VersionTracker('./versions.json');
      const fetcher = new NoIntroFetcher(versionTracker, outputDir);
      
      const shouldSkip = await fetcher.shouldSkip();
      if (shouldSkip) {
        console.log('[phase:fetch] Already on latest version, skipping...');
        process.exit(0);
      }
      
      const dats = await fetcher.fetch();
      console.log(`[phase:fetch] Fetched ${dats.length} games`);
      
      if (dats.length === 0) {
        throw new Error('No DATs fetched');
      }
      
      state.dats = dats;
      await saveState(state);
      break;
    }
    
    case 'group': {
      console.log('[phase:group] Grouping DATs...');
      if (!state.dats) {
        throw new Error('No DATs loaded - run fetch phase first');
      }
      
      const groupStrategy = new NoIntroGroupStrategy();
      const groupedDats = groupStrategy.group(state.dats);
      const groupNames = Object.keys(groupedDats);
      
      console.log(`[phase:group] Created ${groupNames.length} groups: ${groupNames.join(', ')}`);
      
      state.groupedDats = groupedDats;
      await saveState(state);
      break;
    }
    
    case 'dict': {
      console.log('[phase:dict] Training dictionary...');
      if (!state.dats) {
        throw new Error('No DATs loaded - run fetch phase first');
      }
      
      const dictDir = path.join(outputDir, '.dict');
      await fs.mkdir(dictDir, { recursive: true });
      
      const dictPath = path.join(dictDir, `${options.source}.dict`);
      const sample = JSON.stringify(state.dats.slice(0, 10));
      
      await trainDictionary([sample], dictPath);
      console.log(`[phase:dict] Dictionary trained: ${dictPath}`);
      
      state.dictPath = dictPath;
      await saveState(state);
      break;
    }
    
    case 'jsonl': {
      console.log('[phase:jsonl] Creating JSONL files...');
      if (!state.groupedDats) {
        throw new Error('No grouped DATs - run group phase first');
      }
      
      const groupNames = Object.keys(state.groupedDats);
      
      for (const groupName of groupNames) {
        const groupDats = state.groupedDats[groupName];
        if (!groupDats || groupDats.length === 0) continue;
        
        const jsonlContent = groupDats.map((d: DAT) => JSON.stringify(d)).join('\n');
        const jsonlFileName = `${options.source}--${groupName}.jsonl`;
        const jsonlPath = path.join(outputDir, jsonlFileName);
        
        await fs.writeFile(jsonlPath, jsonlContent);
        console.log(`[phase:jsonl] Created: ${jsonlFileName} (${groupDats.length} entries)`);
      }
      break;
    }
    
    case 'compress': {
      console.log('[phase:compress] Compressing to ZST...');
      if (!state.groupedDats) {
        throw new Error('No grouped DATs - run group phase first');
      }
      
      const artifacts: Artifact[] = [];
      const groupNames = Object.keys(state.groupedDats);
      
      // Check for dictionary
      let dictPath = '';
      if (state.dictPath) {
        try {
          await fs.readFile(state.dictPath);
          dictPath = state.dictPath;
          console.log('[phase:compress] Using dictionary');
        } catch {
          console.log('[phase:compress] Dictionary not found, using standard compression');
        }
      }
      
      for (const groupName of groupNames) {
        const groupDats = state.groupedDats[groupName];
        if (!groupDats || groupDats.length === 0) continue;
        
        const jsonlContent = groupDats.map((d: DAT) => JSON.stringify(d)).join('\n');
        const zstFileName = `${options.source}--${groupName}.jsonl.zst`;
        const zstPath = path.join(outputDir, zstFileName);
        
        let artifact;
        if (dictPath) {
          try {
            artifact = await compressWithDictionary(jsonlContent, zstPath, dictPath);
          } catch {
            artifact = await compress(jsonlContent, zstPath);
          }
        } else {
          artifact = await compress(jsonlContent, zstPath);
        }
        
        artifacts.push({
          name: artifact.name,
          path: artifact.path,
          size: artifact.size,
          sha256: artifact.sha256,
          entryCount: artifact.entryCount,
          systems: groupDats.map(d => ({ id: d.system, name: d.system, gameCount: d.roms?.length || 1 }))
        });
        
        console.log(`[phase:compress] Created: ${zstFileName} (${artifact.size} bytes)`);
      }
      
      // Create manifest
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
      console.log('[phase:compress] Created: manifest.json');
      
      // Clean up state - don't save large DATs
      state.artifacts = artifacts;
      state.dats = undefined;
      state.groupedDats = undefined;
      await saveState(state);
      break;
    }
    
    case 'release': {
      console.log('[phase:release] Creating GitHub release...');
      if (!state.artifacts || state.artifacts.length === 0) {
        throw new Error('No artifacts - run compress phase first');
      }
      
      const releaser = new GitHubReleaser(
        process.env.GITHUB_OWNER || 'Mesh-ARKade',
        process.env.GITHUB_REPO || (options.source === 'no-intro' ? 'metadat-nointro' : `metadat-${options.source}`),
        process.env.GITHUB_TOKEN || ''
      );
      
      const tag = `${options.source}-${new Date().toISOString().split('T')[0]}`;
      await releaser.createRelease(tag, state.artifacts);
      
      // Clean up state file
      await fs.unlink(STATE_FILE).catch(() => {});
      break;
    }
  }
  
  console.log(`[phase:${options.phase}] Complete`);
}

// CLI
const { values } = parseArgs({
  options: {
    source: { type: 'string', short: 's', default: 'test' },
    phase: { type: 'string' },
    'output-dir': { type: 'string', short: 'o', default: './output' },
    help: { type: 'boolean', short: 'h', default: false }
  }
});

if (values.help || !values.phase) {
  console.log(`
Pipeline Phase Runner
Usage: node dist/scripts/pipeline-phase.js [options]

Options:
  --phase <phase>    Phase to run: fetch, group, dict, jsonl, compress, release
  -s, --source       Source name (default: test)
  -o, --output-dir   Output directory (default: ./output)
  -h, --help

Phases:
  fetch     - Download DATs from source
  group     - Group DATs by manufacturer
  dict      - Train compression dictionary
  jsonl     - Create JSONL files
  compress  - Compress to ZST
  release   - Create GitHub release
`);
  process.exit(0);
}

runPhase({
  source: values.source || 'test',
  phase: values.phase as Phase,
  outputDir: values['output-dir'] || './output'
}).catch(err => {
  console.error(`[phase] Error: ${(err as Error).message}`);
  process.exit(1);
});
