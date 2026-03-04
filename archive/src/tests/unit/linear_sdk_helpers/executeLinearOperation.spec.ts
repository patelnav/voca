/// <reference types="vitest" />
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { executeLinearOperation } from '@/tools/linear_sdk_helpers'; // Adjusted path
import type { LinearClient, Issue, Comment, ArchivePayload } from '@linear/sdk';
import type { LinearGuid } from '@/types/linear-ids'; // Corrected path
import type { ExecuteLinearOperationResult } from '@/tools/linear_sdk_helpers.types'; // Adjusted path
import { createMockGuid } from '@tests/shared/testUtils'; // Corrected path

// --- Mock Linear Client Setup ---
type MockLinearSdkIssue = Partial<Issue> & { archive?: Mock<() => Promise<Partial<ArchivePayload>>> };
type MockLinearSdkComment = Partial<Comment> & { archive?: Mock<() => Promise<Partial<ArchivePayload>>> };

const mockSdkCreateIssue = vi.fn();
const mockSdkUpdateIssue = vi.fn();
const mockSdkGetIssue = vi.fn();
const mockSdkCreateComment = vi.fn();
// Add other SDK method mocks as needed for project, comment update/delete etc.

const mockLinearClient = {
  createIssue: mockSdkCreateIssue,
  updateIssue: mockSdkUpdateIssue,
  issue: mockSdkGetIssue,
  createComment: mockSdkCreateComment,
  // ... other methods
} as unknown as LinearClient;

// --- Mock SDK Payloads (adapted from linear_apply_filter.spec.ts) ---
// These help simulate the structure of Linear SDK responses including the async entity getters.

interface MockSdkResponsePayload {
  success: boolean;
  lastSyncId?: number;
  get issue(): Promise<MockLinearSdkIssue | undefined>;
  get comment(): Promise<MockLinearSdkComment | undefined>;
  // Add other entity getters if needed by executeLinearOperation
}


describe('executeLinearOperation Helper Function', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset individual mock functions
    mockSdkCreateIssue.mockReset();
    mockSdkUpdateIssue.mockReset();
    mockSdkGetIssue.mockReset();
    mockSdkCreateComment.mockReset();
  });

  it('should be defined', () => {
    expect(executeLinearOperation).toBeDefined();
  });

  describe('issue.create operations', () => {
    const opType = 'issue.create';
    const issueInput = { title: 'Test Create Issue', teamId: 'team-guid' };

    it('should return success true and newId on successful issue creation', async () => {
      const newIssueGuid = createMockGuid('a1b2c3d4-e5f6-7890-1234-567890abcdef' as LinearGuid);
      mockSdkCreateIssue.mockResolvedValue({
        success: true,
        get issue() { return Promise.resolve({ id: newIssueGuid }); },
      } as Partial<MockSdkResponsePayload>); // Cast for simplicity in mock setup

      const result: ExecuteLinearOperationResult = await executeLinearOperation(
        opType,
        issueInput,
        undefined, // idForUpdate is undefined for create
        mockLinearClient
      );

      expect(mockSdkCreateIssue).toHaveBeenCalledWith(issueInput);
      expect(result.success).toBe(true);
      expect(result.newId).toBe(newIssueGuid);
      expect(result.reason).toBeUndefined();
    });

    it('should return success false and reason if SDK createIssue returns success: false', async () => {
      mockSdkCreateIssue.mockResolvedValue({
        success: false,
        error: 'SDK Error Message',
        get issue() { return Promise.resolve(undefined); },
      } as Partial<MockSdkResponsePayload>);

      const result: ExecuteLinearOperationResult = await executeLinearOperation(
        opType,
        issueInput,
        undefined,
        mockLinearClient
      );

      expect(result.success).toBe(false);
      expect(result.newId).toBeUndefined();
      expect(result.reason).toContain('Linear SDK reported failure for issue.create');
      expect(result.reason).toContain('SDK Error Message');
    });

    it('should return success false and reason if SDK createIssue succeeds but issue/id is missing', async () => {
      mockSdkCreateIssue.mockResolvedValue({
        success: true, 
        get issue() { return Promise.resolve(undefined); }, // No issue object or no id on issue
      } as Partial<MockSdkResponsePayload>);

      const result: ExecuteLinearOperationResult = await executeLinearOperation(
        opType,
        issueInput,
        undefined,
        mockLinearClient
      );

      expect(result.success).toBe(false);
      expect(result.newId).toBeUndefined();
      expect(result.reason).toBe('SDK createIssue succeeded but no issue or issue ID found in payload.');
    });
  });

  describe('issue.update operations', () => {
    const opType = 'issue.update';
    const issueInput = { title: 'Updated Issue Title' };
    const issueGuid = createMockGuid('b2c3d4e5-f6a7-8901-2345-67890abcdeff' as LinearGuid);

    it('should return success true and same id on successful issue update', async () => {
      mockSdkUpdateIssue.mockResolvedValue({
        success: true,
        get issue() { return Promise.resolve({ id: issueGuid }); } 
      } as Partial<MockSdkResponsePayload>);

      const result: ExecuteLinearOperationResult = await executeLinearOperation(
        opType,
        issueInput,
        issueGuid,
        mockLinearClient
      );

      expect(mockSdkUpdateIssue).toHaveBeenCalledWith(issueGuid, issueInput);
      expect(result.success).toBe(true);
      expect(result.newId).toBe(issueGuid);
      expect(result.reason).toBeUndefined();
    });

    it('should return success false and reason if idForUpdate is missing or invalid', async () => {
      const result1: ExecuteLinearOperationResult = await executeLinearOperation(opType, issueInput, undefined, mockLinearClient);
      expect(result1.success).toBe(false);
      expect(result1.reason).toContain('Invalid or missing GUID for issue.update');

      const result2: ExecuteLinearOperationResult = await executeLinearOperation(opType, issueInput, 'not-a-guid' as LinearGuid, mockLinearClient);
      expect(result2.success).toBe(false);
      expect(result2.reason).toContain('Invalid or missing GUID for issue.update');
    });

    it('should return success false and reason if SDK updateIssue returns success: false', async () => {
      mockSdkUpdateIssue.mockResolvedValue({
        success: false,
        error: 'SDK Update Error',
        get issue() { return Promise.resolve(undefined); }
      } as Partial<MockSdkResponsePayload>);

      const result: ExecuteLinearOperationResult = await executeLinearOperation(opType, issueInput, issueGuid, mockLinearClient);
      expect(result.success).toBe(false);
      expect(result.reason).toContain('Linear SDK reported failure for issue.update');
      expect(result.reason).toContain('SDK Update Error');
    });
  });

  describe('issue.delete operations', () => {
    const opType = 'issue.delete';
    const issueGuidToDelete = createMockGuid('c3d4e5f6-a7b8-9012-3456-7890abcdef01' as LinearGuid);
    const mockArchivedPayload = { success: true } as Partial<ArchivePayload>;
    const mockIssueEntityWithArchive: MockLinearSdkIssue = {
      id: issueGuidToDelete,
      archive: vi.fn().mockResolvedValue(mockArchivedPayload),
    };

    beforeEach(() => {
        // Ensure the archive mock on the entity is reset for each test in this describe block if needed, or defined freshly.
        // If mockIssueEntityWithArchive is redefined per test, this might not be necessary here.
        // For now, assuming it's defined fresh or reset by the outer beforeEach vi.clearAllMocks if it clears method mocks on objects.
        // Re-mocking getIssue for delete tests specifically to control the archive method.
        mockSdkGetIssue.mockImplementation(async (id: string) => {
            if (id === issueGuidToDelete) {
                const freshMockArchive = vi.fn().mockResolvedValue(mockArchivedPayload);
                return { id: issueGuidToDelete, archive: freshMockArchive };
            }
            return undefined;
        });
    });

    it('should return success true and same id on successful issue delete (archive)', async () => {
      // Specific mock for this test to ensure we can check call on *this* archive
      const specificArchiveMock = vi.fn().mockResolvedValue({ success: true } as Partial<ArchivePayload>); 
      mockSdkGetIssue.mockResolvedValue({ id: issueGuidToDelete, archive: specificArchiveMock });
            
      const result: ExecuteLinearOperationResult = await executeLinearOperation(
        opType,
        {}, 
        issueGuidToDelete,
        mockLinearClient
      );

      expect(mockSdkGetIssue).toHaveBeenCalledWith(issueGuidToDelete);
      expect(specificArchiveMock).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.newId).toBeUndefined();
      expect(result.reason).toBeUndefined();
    });

    it('should return success false if idForUpdate is missing or invalid for delete', async () => {
      const result: ExecuteLinearOperationResult = await executeLinearOperation(opType, {}, undefined, mockLinearClient);
      expect(result.success).toBe(false);
      expect(result.reason).toContain('Invalid or missing GUID for issue.delete');
    });

    it('should return success false if issue to delete is not found', async () => {
      mockSdkGetIssue.mockResolvedValue(undefined); 
      const result: ExecuteLinearOperationResult = await executeLinearOperation(opType, {}, issueGuidToDelete, mockLinearClient);
      expect(mockSdkGetIssue).toHaveBeenCalledWith(issueGuidToDelete); // Ensure getIssue was called
      expect(result.success).toBe(false);
      expect(result.reason).toBe(`Issue ${issueGuidToDelete} not found for deletion.`);
    });

    it('should return success false if SDK archive returns success: false', async () => {
      const failingArchiveMock = vi.fn().mockResolvedValue({ success: false, error: 'Archive SDK Error' } as Partial<ArchivePayload>);
      mockSdkGetIssue.mockResolvedValue({ id: issueGuidToDelete, archive: failingArchiveMock });

      const result: ExecuteLinearOperationResult = await executeLinearOperation(opType, {}, issueGuidToDelete, mockLinearClient);
      expect(failingArchiveMock).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.reason).toContain('Linear SDK reported failure for issue.delete');
      expect(result.reason).toContain('Archive SDK Error');
    });
  });

  describe('Unknown operation type', () => {
    it('should return success false and reason for an unimplemented operation type', async () => {
        const opType = 'some.unimplemented.operation';
        const result: ExecuteLinearOperationResult = await executeLinearOperation(
            opType,
            { data: 'any' },
            undefined,
            mockLinearClient
        );
        expect(result.success).toBe(false);
        expect(result.reason).toBeDefined();
        const reasonObj = JSON.parse(result.reason!);
        expect(reasonObj.message).toBe(`Operation type ${opType} is not implemented in executeLinearOperation.`);
        expect(reasonObj.code).toBe('OPERATION_NOT_IMPLEMENTED');
        expect(reasonObj.opType).toBe(opType);
    });
  });

}); 