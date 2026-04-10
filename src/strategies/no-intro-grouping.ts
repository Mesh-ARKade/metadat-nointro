/**
 * No-Intro Grouping Strategy
 *
 * Groups DATs by manufacturer to keep artifact count under 1,000
 */

import type { DAT, GroupedDATs } from '../types/index.js';
import { IGroupStrategy } from '../contracts/igroup-strategy.js';

/**
 * Manufacturer mapping for No-Intro systems
 */
const MANUFACTURER_MAP: Record<string, string> = {
  // Nintendo
  'Nintendo - Game Boy': 'nintendo',
  'Nintendo - Game Boy Color': 'nintendo',
  'Nintendo - Game Boy Advance': 'nintendo',
  'Nintendo - Nintendo 64': 'nintendo',
  'Nintendo - Nintendo DS': 'nintendo',
  'Nintendo - Nintendo Entertainment System': 'nintendo',
  'Nintendo - Super Nintendo': 'nintendo',
  'Nintendo - Wii': 'nintendo',
  'Nintendo - Wii U': 'nintendo',
  'Nintendo - GameCube': 'nintendo',
  'Nintendo - Switch': 'nintendo',
  'Nintendo - Nintendo 3DS': 'nintendo',
  'Nintendo - Nintendo DSi': 'nintendo',
  'Nintendo - Pokemon Mini': 'nintendo',
  'Nintendo - Game & Watch': 'nintendo',
  'Nintendo - Virtual Boy': 'nintendo',
  'Nintendo - amiibo': 'nintendo',
  'Nintendo - Satellaview': 'nintendo',
  'Nintendo - Sufami Turbo': 'nintendo',
  'Nintendo - Famicom Disk System': 'nintendo',
  
  // Sega
  'Sega - Game Gear': 'sega',
  'Sega - Master System': 'sega',
  'Sega - Mega Drive': 'sega',
  'Sega - Saturn': 'sega',
  'Sega - Dreamcast': 'sega',
  'Sega - Genesis': 'sega',
  'Sega - SG-1000': 'sega',
  'Sega - 32X': 'sega',
  'Sega - PICO': 'sega',
  'Sega - Beena': 'sega',
  
  // Sony (split by generation)
  'Sony - PlayStation': 'sony-ps1',
  'Sony - PlayStation (PS one Classics)': 'sony-ps1',
  'Sony - PlayStation 2': 'sony-ps2',
  'Sony - PlayStation 3': 'sony-ps3',
  'Sony - PlayStation 4': 'sony-ps4',
  'Sony - PlayStation 5': 'sony-ps5',
  'Sony - PlayStation Portable': 'sony-psp',
  'Sony - PlayStation Vita': 'sony-vita',
  
  // Microsoft
  'Microsoft - Xbox': 'microsoft',
  'Microsoft - Xbox 360': 'microsoft',
  'Microsoft - Xbox One': 'microsoft',
  'Microsoft - MSX': 'microsoft',
  
  // Other
  'Atari - Atari 2600': 'other',
  'Atari - Atari 7800': 'other',
  'Atari - Jaguar': 'other',
  'Atari - Jaguar CD': 'other',
  'NEC - PC Engine': 'other',
  'NEC - PC-FX': 'other',
  'NEC - PC-88': 'other',
  'NEC - PC-98': 'other',
  'Bandai - WonderSwan': 'other',
  'Bandai - WonderSwan Color': 'other',
  'Bandai - Pippin': 'other',
  'SNK - NeoGeo Pocket': 'other',
  'SNK - NeoGeo Pocket Color': 'other',
  'Tiger - Game.com': 'other',
  'Tiger - Gizmondo': 'other',
  'VTech - V.Smile': 'other',
  'VTech - Mobigo': 'other',
};

export class NoIntroGroupStrategy implements IGroupStrategy {
  /**
   * Group DATs by manufacturer
   */
  group(dats: DAT[]): GroupedDATs {
    const groups: GroupedDATs = {};
    
    for (const dat of dats) {
      const manufacturer = this.getManufacturer(dat.system);
      
      if (!groups[manufacturer]) {
        groups[manufacturer] = [];
      }
      
      groups[manufacturer].push(dat);
    }
    
    return groups;
  }
  
  /**
   * Get manufacturer for a system
   */
  private getManufacturer(systemName: string): string {
    // Check for Unofficial systems first
    if (systemName.startsWith('Unofficial')) {
      // Extract the actual system from "Unofficial - Sony - PlayStation"
      const actualSystem = systemName.replace('Unofficial - ', '');
      
      // Try to find manufacturer in the actual system
      for (const [prefix, manufacturer] of Object.entries(MANUFACTURER_MAP)) {
        if (actualSystem.startsWith(prefix.replace(' - ', ''))) {
          return `unofficial-${manufacturer}`;
        }
      }
      return 'unofficial-other';
    }
    
    // Try exact match first
    if (MANUFACTURER_MAP[systemName]) {
      return MANUFACTURER_MAP[systemName];
    }
    
    // Try prefix match
    for (const [prefix, manufacturer] of Object.entries(MANUFACTURER_MAP)) {
      if (systemName.startsWith(prefix.split(' - ')[0])) {
        return manufacturer;
      }
    }
    
    return 'other';
  }
  
  getStrategyName(): string {
    return 'nointro-manufacturer';
  }
}