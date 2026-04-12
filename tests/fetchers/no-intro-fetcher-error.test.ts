/**
 * Tests for No-Intro Fetcher error handling
 *
 * @intent Verify fetcher captures screenshots on failure
 * @guarantee Screenshot is saved to output/playwright-error.png on error
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';

// Use vi.hoisted to define mocks before they're used
const { mockScreenshot, mockPage, mockBrowser, mockContext } = vi.hoisted(() => {
  const mockScreenshot = vi.fn();
  const mockPage = {
    goto: vi.fn().mockRejectedValue(new Error('Network timeout')),
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

import { NoIntroFetcher } from '../../src/fetchers/no-intro-fetcher.js';
import { VersionTracker } from '../../src/core/version-tracker.js';

describe('NoIntroFetcher error handling', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = './test-output-error';
    mockScreenshot.mockClear();
    (mockPage.goto as any).mockRejectedValue(new Error('Network timeout'));
  });

  afterEach(async () => {
    try {
      await fs.rm(outputDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should capture screenshot when fetch fails', async () => {
    const tracker = new VersionTracker('./test-versions.json');
    const fetcher = new NoIntroFetcher(tracker, outputDir);

    // Call fetchDats - should throw but trigger screenshot capture
    await expect(fetcher.fetchDats()).rejects.toThrow();

    // Verify screenshot was called
    expect(mockScreenshot).toHaveBeenCalled();
    
    // Verify screenshot was saved to the correct path
    const screenshotCall = mockScreenshot.mock.calls[0][0];
    expect(screenshotCall.path).toContain('metadat-nointro--error-playwright.png');
  });

  it('should handle screenshot failure gracefully', async () => {
    // Make screenshot also fail
    (mockPage.screenshot as any).mockRejectedValue(new Error('Screenshot failed'));
    
    const tracker = new VersionTracker('./test-versions.json');
    const fetcher = new NoIntroFetcher(tracker, outputDir);

    // Should still throw the original error, not the screenshot error
    await expect(fetcher.fetchDats()).rejects.toThrow('Network timeout');
  });
}, 30000);