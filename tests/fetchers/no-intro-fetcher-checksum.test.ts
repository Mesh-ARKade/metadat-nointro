/**
 * Tests for No-Intro Fetcher checksum verification
 *
 * @intent Verify downloaded ZIP checksums are validated
 * @guarantee Throws error if checksum doesn't match expected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

// Use vi.hoisted to define mocks before they're used
const { mockScreenshot, mockPage, mockBrowser, mockContext } = vi.hoisted(() => {
  const mockScreenshot = vi.fn();
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    screenshot: mockScreenshot,
    close: vi.fn()
  };
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn()
  };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn()
  };
  return { mockScreenshot, mockPage, mockBrowser, mockContext };
});

// Mock chromium before any imports
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser)
  }
}));

// Mock unzipper
vi.mock('unzipper', () => ({
  Open: {
    file: vi.fn().mockResolvedValue({
      files: []
    })
  }
}));

import { NoIntroFetcher } from '../../src/fetchers/no-intro-fetcher.js';
import { VersionTracker } from '../../src/core/version-tracker.js';

describe('NoIntroFetcher checksum verification', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = './test-output-checksum';
  });

  afterEach(async () => {
    try {
      await fs.rm(outputDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should have verifyChecksum method', async () => {
    const tracker = new VersionTracker('./test-versions.json');
    const fetcher = new NoIntroFetcher(tracker, outputDir);
    
    // Verify the method exists
    expect(typeof (fetcher as any).verifyChecksum).toBe('function');
  });

  it('should accept valid checksum', async () => {
    // Create a test file with known content
    await fs.mkdir(outputDir, { recursive: true });
    const testFile = path.join(outputDir, 'test.zip');
    const content = 'test content';
    await fs.writeFile(testFile, content);
    
    // Calculate actual checksum
    const hash = crypto.createHash('md5').update(content).digest('hex');
    
    const tracker = new VersionTracker('./test-versions.json');
    const fetcher = new NoIntroFetcher(tracker, outputDir);
    
    // Should not throw for valid checksum
    await expect((fetcher as any).verifyChecksum(testFile, hash, 'md5')).resolves.not.toThrow();
  });

  it('should reject invalid checksum', async () => {
    // Create a test file with known content
    await fs.mkdir(outputDir, { recursive: true });
    const testFile = path.join(outputDir, 'test.zip');
    const content = 'test content';
    await fs.writeFile(testFile, content);
    
    const tracker = new VersionTracker('./test-versions.json');
    const fetcher = new NoIntroFetcher(tracker, outputDir);
    
    // Should throw for invalid checksum
    await expect((fetcher as any).verifyChecksum(testFile, 'wrong-checksum', 'md5')).rejects.toThrow(/checksum/i);
  });
}, 15000);