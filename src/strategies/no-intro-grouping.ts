/**
 * NoIntro Grouping Strategy
 *
 * Groups DATs dynamically by system manufacturer (first part before " - ")
 */

import type { DAT, GroupedDATs } from '../types/index.js';
import { IGroupStrategy } from '../contracts/igroup-strategy.js';

export class NoIntroGroupStrategy implements IGroupStrategy {
  /**
   * Group DATs by manufacturer (first part of system name before " - ")
   */
  group(dats: DAT[]): GroupedDATs {
    const groups: GroupedDATs = {};
    
    for (const dat of dats) {
      // Dynamic approach: split at first " - " and take first part
      const groupName = this.extractGroup(dat.system);
      
      if (!groups[groupName]) {
        groups[groupName] = [];
      }
      
      groups[groupName].push(dat);
    }
    
    return groups;
  }
  
  /**
   * Extract group from system name: "Manufacturer - System" → manufacturer (lowercase)
   */
  private extractGroup(systemName: string): string {
    const separatorIndex = systemName.indexOf(' - ');
    if (separatorIndex > 0) {
      return systemName.substring(0, separatorIndex).toLowerCase();
    }
    return 'other';
  }
  
  getStrategyName(): string {
    return 'nointro-dynamic';
  }
}