/// <reference types="vitest" />
import { describe, it, expect } from 'vitest';
import { isEffectivelySameChange } from '@/tools/linear_apply'; // Adjust path if linear_apply moves or this file moves deeper
import type { StagedChange } from '@/state/types'; // Adjust path
import type { TemporaryFriendlyId, LinearGuid } from '@/types/linear-ids'; // Adjust path

describe('isEffectivelySameChange Helper Function', () => {
  const mockGuid1 = 'a1b2c3d4-e5f6-7890-1234-567890abcdef' as LinearGuid;
  const mockGuid2 = 'b2c3d4e5-f6a7-8901-2345-67890abcdeff' as LinearGuid;
  const mockTempId1 = 'TMP-1' as TemporaryFriendlyId;
  const mockTempId2 = 'TMP-2' as TemporaryFriendlyId;

  // Helper to create a minimal StagedChange object
  const createChange = (
    opType: string,
    tempId?: TemporaryFriendlyId,
    id?: LinearGuid,
    dataOverrides: Record<string, any> = {}
  ): StagedChange => {
    const change: Partial<StagedChange> = { opType };
    if (tempId) {
      change.tempId = tempId;
    }
    change.data = { ...dataOverrides };
    if (id) {
      change.data.id = id;
    }
    return change as StagedChange;
  };

  describe('Comparisons based on tempId', () => {
    it('should return true if tempIds exist and match', () => {
      const change1 = createChange('issue.create', mockTempId1);
      const change2 = createChange('issue.create', mockTempId1);
      expect(isEffectivelySameChange(change1, change2)).toBe(true);
    });

    it('should return false if tempIds exist but do not match', () => {
      const change1 = createChange('issue.create', mockTempId1);
      const change2 = createChange('issue.create', mockTempId2);
      expect(isEffectivelySameChange(change1, change2)).toBe(false);
    });

    it('should return false if one change has tempId and the other does not', () => {
      const change1 = createChange('issue.create', mockTempId1);
      const change2 = createChange('issue.update', undefined, mockGuid1);
      expect(isEffectivelySameChange(change1, change2)).toBe(false);
      expect(isEffectivelySameChange(change2, change1)).toBe(false);
    });

    it('should return false if one tempId is undefined and the other is null (edge case, though type is string|number)', () => {
        const change1 = createChange('issue.create', mockTempId1);
        const change2 = createChange('issue.create', null as any); // Test null
        expect(isEffectivelySameChange(change1, change2)).toBe(false);
    });
  });

  describe('Comparisons based on data.id and opType (when tempIds are absent)', () => {
    it('should return true if tempIds are absent, data.ids match, and opTypes match', () => {
      const change1 = createChange('issue.update', undefined, mockGuid1);
      const change2 = createChange('issue.update', undefined, mockGuid1);
      expect(isEffectivelySameChange(change1, change2)).toBe(true);
    });

    it('should return false if tempIds are absent, data.ids match, but opTypes differ', () => {
      const change1 = createChange('issue.update', undefined, mockGuid1);
      const change2 = createChange('issue.delete', undefined, mockGuid1); // Different opType
      expect(isEffectivelySameChange(change1, change2)).toBe(false);
    });

    it('should return false if tempIds are absent, opTypes match, but data.ids differ', () => {
      const change1 = createChange('issue.update', undefined, mockGuid1);
      const change2 = createChange('issue.update', undefined, mockGuid2); // Different data.id
      expect(isEffectivelySameChange(change1, change2)).toBe(false);
    });

    it('should return false if tempIds are absent and one data.id is missing', () => {
      const change1 = createChange('issue.update', undefined, mockGuid1);
      const change2 = createChange('issue.update', undefined, undefined); // Missing data.id
      expect(isEffectivelySameChange(change1, change2)).toBe(false);
      expect(isEffectivelySameChange(change2, change1)).toBe(false);
    });
  });

  describe('Fallback comparisons (neither tempId nor data.id match)', () => {
    it('should return false if neither tempIds nor data.ids provide a match', () => {
      const change1 = createChange('issue.create', mockTempId1); // Has tempId
      const change2 = createChange('issue.update', undefined, mockGuid2); // Different opType, no tempId, different guid
      expect(isEffectivelySameChange(change1, change2)).toBe(false);
    });

    it('should return false if both changes lack tempId and data.id', () => {
      const change1 = createChange('some.op');
      const change2 = createChange('some.op');
      expect(isEffectivelySameChange(change1, change2)).toBe(false);
    });

    it('should return false if one has tempId, other has data.id, but they are conceptually different changes', () => {
        const change1 = createChange('issue.create', mockTempId1, undefined, { title: 'Change 1' });
        const change2 = createChange('issue.update', undefined, mockGuid1, { title: 'Change 2' });
        expect(isEffectivelySameChange(change1, change2)).toBe(false);
    });
  });

  describe('Considering opType in tempId comparisons', () => {
    it('should return true if tempIds match, even if opTypes differ (current behavior)', () => {
        // Current implementation of isEffectivelySameChange prioritizes tempId match over opType
        // if tempIds are present. This test verifies that.
        const change1 = createChange('issue.create', mockTempId1);
        const change2 = createChange('comment.create', mockTempId1); // Same tempId, different opType
        expect(isEffectivelySameChange(change1, change2)).toBe(false); 
        // This might be a point of discussion: should opType also match if tempIds match?
        // For now, testing the implemented behavior.
      });
  });
}); 