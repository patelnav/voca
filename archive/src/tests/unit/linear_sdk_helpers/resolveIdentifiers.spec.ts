/// <reference types="vitest" />
import { describe, it, expect, vi } from 'vitest';
import { resolveIdentifiers } from '@/tools/linear_sdk_helpers';
import type { LinearGuid, TemporaryFriendlyId } from '@/types/linear-ids';
import { createMockGuid } from '@tests/shared/testUtils';

describe('resolveIdentifiers Helper Function', () => {

  it('should resolve a friendly ID to a GUID from the map for issue.update', async () => {
    const friendlyId = 'TEST-123';
    const targetGuid = createMockGuid('11111111-aaaa-bbbb-cccc-1234567890ab') as LinearGuid;
    const changeData = { id: friendlyId, title: 'Update Title' };
    const opType = 'issue.update';
    const internalIdMap = new Map<string, LinearGuid>([[friendlyId, targetGuid]]);

    const result = await resolveIdentifiers(changeData, opType, internalIdMap);

    expect(result.success).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.resolvedData).toBeDefined();
    expect(result.resolvedData?.id).toBe(targetGuid); // Key assertion: ID should be the GUID
    expect(result.resolvedData?.title).toBe(changeData.title); // Other fields preserved
  });

  it('should pass through data if ID is already a GUID for issue.update', async () => {
    const targetGuid = createMockGuid('22222222-aaaa-bbbb-cccc-1234567890ab') as LinearGuid;
    const changeData = { id: targetGuid, title: 'Update Title Again' };
    const opType = 'issue.update';
    const internalIdMap = new Map<string, LinearGuid>(); // Map is empty or irrelevant

    const result = await resolveIdentifiers(changeData, opType, internalIdMap);

    expect(result.success).toBe(true);
    expect(result.resolvedData).toEqual(changeData);
  });

  it('should return error if friendly ID is not found in map for issue.update', async () => {
    const friendlyId = 'TEST-456';
    const changeData = { id: friendlyId, title: 'Update Title Fail' };
    const opType = 'issue.update';
    const internalIdMap = new Map<string, LinearGuid>(); // Map doesn't contain friendlyId

    const result = await resolveIdentifiers(changeData, opType, internalIdMap);

    expect(result.success).toBe(false);
    expect(result.resolvedData).toBeUndefined();
    expect(result.reason).toContain(`Failed to resolve identifier "${friendlyId}" to a valid Linear GUID for ${opType}.`);
  });

  it('should resolve tempId in issueId field for comment.create using the map', async () => {
    const issueTempId = 'TMP-ISSUE-789' as TemporaryFriendlyId;
    const resolvedIssueGuid = createMockGuid('33333333-aaaa-bbbb-cccc-1234567890ab') as LinearGuid;
    const changeData = { issueId: issueTempId, body: 'A comment' };
    const opType = 'comment.create';
    const internalIdMap = new Map<string, LinearGuid>([[issueTempId, resolvedIssueGuid]]);

    const result = await resolveIdentifiers(changeData, opType, internalIdMap);

    expect(result.success).toBe(true);
    expect(result.resolvedData).toBeDefined();
    expect(result.resolvedData?.issueId).toBe(resolvedIssueGuid); // Key assertion
    expect(result.resolvedData?.body).toBe(changeData.body);
  });

    it('should return error if tempId for comment.create issueId is not in map', async () => {
    const issueTempId = 'TMP-ISSUE-MISSING' as TemporaryFriendlyId;
    const changeData = { issueId: issueTempId, body: 'Another comment' };
    const opType = 'comment.create';
    const internalIdMap = new Map<string, LinearGuid>();

    const result = await resolveIdentifiers(changeData, opType, internalIdMap);

    expect(result.success).toBe(false);
    expect(result.resolvedData).toBeUndefined();
    expect(result.reason).toContain(`Failed to resolve required field 'issueId' ('${issueTempId}') for ${opType}.`);
  });

  it('should resolve data.identifier if data.id is not present for issue.update', async () => {
    const identifier = 'IDENTIFIER-123';
    const targetGuid = createMockGuid('44444444-aaaa-bbbb-cccc-1234567890ab') as LinearGuid;
    // Note: data has 'identifier', not 'id'
    const changeData = { identifier: identifier, title: 'Update By Identifier' }; 
    const opType = 'issue.update';
    const internalIdMap = new Map<string, LinearGuid>([[identifier, targetGuid]]);

    const result = await resolveIdentifiers(changeData, opType, internalIdMap);

    expect(result.success).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.resolvedData).toBeDefined();
    // The resolved data should now contain 'id' with the GUID
    expect(result.resolvedData?.id).toBe(targetGuid);
    // The original 'identifier' field might be removed or kept depending on the function's implementation
    // Checking if title is preserved
    expect(result.resolvedData?.title).toBe(changeData.title);
    // Let's assume the implementation removes identifier after resolving to id
    expect(result.resolvedData?.identifier).toBeUndefined(); 
  });

  it('should return error if data.identifier is not found in map for issue.update', async () => {
    const identifier = 'IDENTIFIER-456';
    const changeData = { identifier: identifier, title: 'Update By Identifier Fail' };
    const opType = 'issue.update';
    const internalIdMap = new Map<string, LinearGuid>(); // Identifier not in map

    const result = await resolveIdentifiers(changeData, opType, internalIdMap);

    expect(result.success).toBe(false);
    expect(result.resolvedData).toBeUndefined();
    expect(result.reason).toContain(`Failed to resolve identifier "${identifier}" to a valid Linear GUID for ${opType}.`);
  });

  // Add tests for project.update, issue.link, issue.delete etc. checking identifier resolution

  // Test for issue.create behavior with temp: prefixed IDs
  describe('issue.create with temp: prefixed IDs in payload', () => {
    const opType = 'issue.create';

    it('should fail if a temp: prefixed ID is not in internalIdMap', async () => {
      const parentTempKey = 'TMP-PARENT-1';
      const changeData = { title: 'Create Issue', teamId: 'team-abc', parentId: `temp:${parentTempKey}` };
      const internalIdMap = new Map<string, LinearGuid>(); // Empty map

      const result = await resolveIdentifiers(changeData, opType, internalIdMap);

      expect(result.success).toBe(false);
      expect(result.resolvedData).toBeUndefined();
      expect(result.reason).toContain(`Failed to resolve temporary ID temp:${parentTempKey} needed for ${opType}`);
    });

    it('should resolve temp: prefixed IDs if they are in internalIdMap', async () => {
      const parentTempKey = 'TMP-PARENT-SUCCESS-1' as TemporaryFriendlyId;
      const resolvedParentGuid = createMockGuid('55555555-aaaa-bbbb-cccc-resolvepid') as LinearGuid;
      const changeData = { title: 'Create Issue With Parent', teamId: 'team-def', parentId: `temp:${parentTempKey}` };
      const internalIdMap = new Map<string, LinearGuid>([[parentTempKey, resolvedParentGuid]]);

      const result = await resolveIdentifiers(changeData, opType, internalIdMap);

      expect(result.success).toBe(true);
      expect(result.resolvedData).toBeDefined();
      expect(result.resolvedData?.title).toBe(changeData.title);
      expect(result.resolvedData?.parentId).toBe(resolvedParentGuid);
      expect(result.resolvedData?.teamId).toBe(changeData.teamId);
    });
  });

}); 