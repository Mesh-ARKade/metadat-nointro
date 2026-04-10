/**
 * DiscordNotifier - Sends pipeline notifications to Discord webhooks
 * 
 * Per S8 notification standard:
 * - Fancy embeds with colors (🟡 started, 🟢 success, 🔴 failure, ⚪ skipped)
 * - Stats tables
 * - Links to GitHub Action run and Release
 * 
 * @intent Send webhook notifications for pipeline events
 * @guarantee Handles started/success/failure/skipped with formatted embeds
 */

import type { PipelineEvent } from '../types/index.js';

/** S8 Discord embed colors (per spec) */
export const EMBED_COLORS = {
  started: 16776960,   // 🟡 Yellow
  success: 3066993,    // 🟢 Green  
  failure: 15158332,    // 🔴 Red
  skipped: 9807270,    // ⚪ Gray
  warning: 16744448     // 🟠 Orange
} as const;

// S8 event emoji mapping
// Note: Used in formatTitle(), formatDescription()

/**
 * Format duration in seconds to human readable
 */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Get embed color for event type
 */
export function getEmbedColor(type: PipelineEvent['type']): number {
  return EMBED_COLORS[type] || EMBED_COLORS.started;
}

/**
 * DiscordNotifier class
 */
export class DiscordNotifier {
  private webhookUrl: string;
  private maxRetries: number;

  constructor(webhookUrl: string, maxRetries: number = 3) {
    this.webhookUrl = webhookUrl;
    this.maxRetries = maxRetries;
  }

  /**
   * Send notification for a pipeline event
   */
  async notify(event: PipelineEvent): Promise<void> {
    const embed = this.formatEmbed(event);
    const payload = {
      username: 'METADAT Pipeline',
      avatar_url: 'https://raw.githubusercontent.com/Mesh-ARKade/mesh-arkade/main/assets/icon.png',
      embeds: [embed]
    };

    await this.sendWithRetry(JSON.stringify(payload));
  }

  /**
   * Format Discord embed for event
   */
  private formatEmbed(event: PipelineEvent): Record<string, unknown> {
    const color = getEmbedColor(event.type);
    const title = this.formatTitle(event.type, event.source);
    
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

    if (event.version) {
      fields.push({ name: 'Version', value: event.version, inline: true });
    }

    if (event.entryCount) {
      fields.push({ name: 'Entries', value: event.entryCount.toLocaleString(), inline: true });
    }

    if (event.artifactCount) {
      fields.push({ name: 'Artifacts', value: event.artifactCount.toString(), inline: true });
    }

    if (event.duration) {
      fields.push({ name: 'Duration', value: formatDuration(event.duration), inline: true });
    }

    if (event.error) {
      fields.push({ name: 'Error', value: event.error, inline: false });
    }

    const timestamp = new Date(event.timestamp).toISOString();

    return {
      title,
      color,
      fields,
      timestamp,
      footer: {
        text: `Source: ${event.source}`
      }
    };
  }

  /**
   * Format title based on event type
   */
  private formatTitle(type: PipelineEvent['type'], source: string): string {
    const sourceLabel = source.charAt(0).toUpperCase() + source.slice(1).replace('-', ' ');
    
    switch (type) {
      case 'started':
        return `🚀 ${sourceLabel} Pipeline Started`;
      case 'success':
        return `✅ ${sourceLabel} Pipeline Completed`;
      case 'failure':
        return `❌ ${sourceLabel} Pipeline Failed`;
      case 'skipped':
        return `⏭️ ${sourceLabel} Pipeline Skipped (No Changes)`;
      default:
        return `📦 ${sourceLabel} Pipeline Update`;
    }
  }

  /**
   * Send webhook with retry logic
   */
  private async sendWithRetry(payload: string, attempt: number = 1): Promise<void> {
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: payload
      });

      if (!response.ok && attempt < this.maxRetries) {
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        return this.sendWithRetry(payload, attempt + 1);
      }

      if (!response.ok) {
        throw new Error(`Discord webhook failed: ${response.status}`);
      }
    } catch (err) {
      if (attempt < this.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        return this.sendWithRetry(payload, attempt + 1);
      }
      throw err;
    }
  }
}