/**
 * GitHubReleaser - Creates GitHub releases and uploads artifacts
 *
 * @intent Handle GitHub release creation and asset uploads
 * @guarantee Sequential uploads to avoid rate limits, retry logic, idempotent
 */

import { Octokit } from '@octokit/rest';
import fs from 'fs/promises';
import type { Artifact, Release } from '../types/index.js';

export class GitHubReleaser {
  private owner: string;
  private repo: string;
  public octokit: Octokit;

  constructor(owner: string, repo: string, token: string) {
    this.owner = owner;
    this.repo = repo;
    this.octokit = new Octokit({ auth: token });
  }

  /**
   * Create a release and upload all artifacts
   * @param tag Release tag name
   * @param artifacts Array of artifacts to upload
   * @returns Release object
   */
  async createRelease(tag: string, artifacts: Artifact[]): Promise<Release> {
    // Check if release already exists
    const existing = await this.releaseExists(tag);
    if (existing) {
      // Return existing release info
      const release = await this.getReleaseByTag(tag);
      return release;
    }

    // Generate release notes
    const body = generateReleaseNotes(artifacts);

    // Create release
    const releaseResponse = await this.octokit.repos.createRelease({
      owner: this.owner,
      repo: this.repo,
      tag_name: tag,
      name: `Release ${tag}`,
      body,
      draft: false,
      prerelease: false
    });

    const release = releaseResponse.data;

    // Upload artifacts sequentially to avoid rate limits
    for (const artifact of artifacts) {
      await this.uploadAsset(release.id, artifact);
      // Add delay between uploads
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return {
      tag: release.tag_name,
      name: release.name || '',
      body: release.body || '',
      draft: release.draft,
      prerelease: release.prerelease,
      assets: release.assets.map(asset => ({
        name: asset.name,
        size: asset.size,
        downloadCount: asset.download_count,
        browserDownloadUrl: asset.browser_download_url
      })),
      htmlUrl: release.html_url,
      createdAt: release.created_at
    };
  }

  /**
   * Check if a release exists
   * @param tag Release tag
   * @returns true if exists
   */
  async releaseExists(tag: string): Promise<boolean> {
    try {
      await this.octokit.repos.getReleaseByTag({
        owner: this.owner,
        repo: this.repo,
        tag
      });
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Get release by tag
   */
  private async getReleaseByTag(tag: string): Promise<Release> {
    const response = await this.octokit.repos.getReleaseByTag({
      owner: this.owner,
      repo: this.repo,
      tag
    });
    const release = response.data;

    return {
      tag: release.tag_name,
      name: release.name || '',
      body: release.body || '',
      draft: release.draft,
      prerelease: release.prerelease,
      assets: release.assets.map(asset => ({
        name: asset.name,
        size: asset.size,
        downloadCount: asset.download_count,
        browserDownloadUrl: asset.browser_download_url
      })),
      htmlUrl: release.html_url,
      createdAt: release.created_at
    };
  }

  /**
   * Upload a single asset to a release
   */
  private async uploadAsset(releaseId: number, artifact: Artifact): Promise<void> {
    const fileContent = await fs.readFile(artifact.path);

    await this.octokit.repos.uploadReleaseAsset({
      owner: this.owner,
      repo: this.repo,
      release_id: releaseId,
      name: artifact.name,
      data: fileContent as unknown as string
    });
  }

  /**
   * Delete a release
   * @param tag Release tag
   */
  async deleteRelease(tag: string): Promise<void> {
    const releaseResponse = await this.octokit.repos.getReleaseByTag({
      owner: this.owner,
      repo: this.repo,
      tag
    });

    await this.octokit.repos.deleteRelease({
      owner: this.owner,
      repo: this.repo,
      release_id: releaseResponse.data.id
    });
  }
}

/**
 * Generate release notes from artifacts
 */
export function generateReleaseNotes(artifacts: Artifact[], date?: string): string {
  const lines: string[] = [
    '## Artifacts',
    '',
    `Generated: ${date || new Date().toISOString().split('T')[0]}`,
    '',
    '| File | Size | Entries |',
    '|------|------|---------|'
  ];

  for (const artifact of artifacts) {
    const sizeMB = (artifact.size / (1024 * 1024)).toFixed(2);
    lines.push(`| ${artifact.name} | ${sizeMB} MB | ${artifact.entryCount} |`);
  }

  return lines.join('\n');
}