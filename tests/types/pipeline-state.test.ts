/**
 * Tests for pipeline state validation
 *
 * @intent Verify pipeline state Zod schemas validate correctly
 * @guarantee Invalid states are rejected, valid states pass
 */

import { describe, it, expect } from 'vitest';
import {
  RomEntrySchema,
  DATSchema,
  ArtifactSchema,
  FetchPhaseStateSchema,
  GroupPhaseStateSchema,
  CompressPhaseStateSchema,
  PipelineStateSchema,
  validatePipelineState
} from '../../src/types/index.js';

describe('Pipeline State Zod Schemas', () => {
  describe('RomEntrySchema', () => {
    it('should validate a valid rom entry', () => {
      const valid = { name: 'game.bin', size: 1024 };
      expect(() => RomEntrySchema.parse(valid)).not.toThrow();
    });

    it('should reject negative size', () => {
      const invalid = { name: 'game.bin', size: -1 };
      expect(() => RomEntrySchema.parse(invalid)).toThrow();
    });
  });

  describe('DATSchema', () => {
    it('should validate a valid DAT', () => {
      const valid = {
        id: 'nintendo:Super Mario Bros',
        source: 'no-intro',
        system: 'Nintendo - NES',
        datVersion: '2024-01-01T00:00:00.000Z',
        roms: [{ name: 'game.nes', size: 40960 }]
      };
      expect(() => DATSchema.parse(valid)).not.toThrow();
    });

    it('should reject missing required fields', () => {
      const invalid = { id: 'test' }; // missing source, system, datVersion, roms
      expect(() => DATSchema.parse(invalid)).toThrow();
    });
  });

  describe('ArtifactSchema', () => {
    it('should validate a valid artifact', () => {
      const valid = {
        name: 'no-intro--nintendo.jsonl.zst',
        path: '/output/no-intro--nintendo.jsonl.zst',
        size: 1024000,
        sha256: 'a'.repeat(64),
        entryCount: 100
      };
      expect(() => ArtifactSchema.parse(valid)).not.toThrow();
    });

    it('should reject invalid SHA-256 length', () => {
      const invalid = {
        name: 'test.zst',
        path: '/test.zst',
        size: 100,
        sha256: 'abc', // Too short
        entryCount: 1
      };
      expect(() => ArtifactSchema.parse(invalid)).toThrow();
    });
  });

  describe('PipelineStateSchema', () => {
    it('should validate fetch phase state', () => {
      const valid = {
        phase: 'fetch',
        source: 'no-intro',
        dats: [{
          id: 'test',
          source: 'no-intro',
          system: 'NES',
          datVersion: '2024-01-01T00:00:00.000Z',
          roms: []
        }]
      };
      expect(() => PipelineStateSchema.parse(valid)).not.toThrow();
    });

    it('should validate group phase state', () => {
      const valid = {
        phase: 'group',
        source: 'no-intro',
        groupedDats: {
          Nintendo: []
        }
      };
      expect(() => PipelineStateSchema.parse(valid)).not.toThrow();
    });

    it('should reject invalid phase', () => {
      const invalid = {
        phase: 'invalid',
        source: 'no-intro'
      };
      expect(() => PipelineStateSchema.parse(invalid)).toThrow();
    });
  });

  describe('validatePipelineState', () => {
    it('should throw on invalid state', () => {
      const invalid = { phase: 'invalid' };
      expect(() => validatePipelineState(invalid)).toThrow();
    });

    it('should not throw on valid state', () => {
      const valid = {
        phase: 'fetch',
        source: 'no-intro',
        dats: []
      };
      expect(() => validatePipelineState(valid)).not.toThrow();
    });
  });
});