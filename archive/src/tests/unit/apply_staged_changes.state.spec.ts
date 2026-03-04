/// <reference types="vitest" />
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { apply_staged_changes } from '@/tools/linear_apply';
import type { AgentState, StagedChange } from '@/state/types';
import type { TemporaryFriendlyId, LinearGuid } from '@/types/linear-ids';
import { createMockLinearClient, type MockLinearClientInterface } from '@tests/shared/mocks/linear_client.mock'; // Using shared mock
import { enrichStagedChangeData, EnrichmentError } from '@/linear/enrichment';
import { saveAgentState } from '@/state/manager';
import { resolveIdentifiers, executeLinearOperation } from '@/tools/linear_sdk_helpers';
import { createInitialAgentState } from '@tests/shared/linear-e2e.config'; // May need to create a shared test util for this
import { createMockGuid } from '@tests/shared/testUtils';
import { ApplyOutcome } from '@/tools/linear_apply';

// Mock dependencies
vi.mock('@/linear/enrichment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/linear/enrichment')>();
  return {
    ...actual,
    enrichStagedChangeData: vi.fn(),
    EnrichmentError: actual.EnrichmentError,
  };
});
vi.mock('@/state/manager', () => ({
  saveAgentState: vi.fn(),
}));
vi.mock('@/tools/linear_sdk_helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/linear_sdk_helpers')>();
  return {
    ...actual,
    resolveIdentifiers: vi.fn(),
    executeLinearOperation: vi.fn(),
  };
});
// No need to mock getLinearClient if we directly use createMockLinearClient

describe('apply_staged_changes - State Management Tests', () => {
  const mockEnrichStagedChangeData = vi.mocked(enrichStagedChangeData);
  const mockSaveAgentState = vi.mocked(saveAgentState);
  const mockResolveIdentifiers = vi.mocked(resolveIdentifiers);
  const mockExecuteLinearOperation = vi.mocked(executeLinearOperation);
  let mockLinearClient: MockLinearClientInterface;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLinearClient = createMockLinearClient();

    // Default successful mock implementations for dependencies
    mockResolveIdentifiers.mockImplementation(async (changeData, opType, internalIdMap) => {
      return { success: true, resolvedData: { ...changeData } };
    });
    mockExecuteLinearOperation.mockImplementation(async (opType, input, idForUpdate) => {
      // For create operations, return a default newId if not specifically set by the test
      if (opType.endsWith('.create')) {
        return { success: true, newId: createMockGuid('default-mock-guid') as LinearGuid };
      }
      // For updates/deletes, return the provided ID, also cast if it's intended to be a LinearGuid
      return { success: true, newId: idForUpdate as LinearGuid | undefined }; 
    });
    mockEnrichStagedChangeData.mockImplementation(async (change) => change.data); // Simple pass-through
    mockSaveAgentState.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should clear staged_changes and update id_map for a simple issue.create success', async () => {
    const tempId = 'TMP-STATE-1' as TemporaryFriendlyId;
    const initialData = {
      title: 'State Test Issue',
      description: 'Testing state updates',
      teamId: 'team-guid-state',
    };
    const initialChange: StagedChange = {
      opType: 'issue.create',
      tempId: tempId,
      data: initialData,
    };
    const initialState = createInitialAgentState('test-session-state-1', {
      staged_changes: [initialChange],
      id_map: {},
    });
    const mockNewIssueGuid = createMockGuid('state-issue-guid-1');

    // Override default mock for executeLinearOperation for this specific test if needed for newId
    mockExecuteLinearOperation.mockResolvedValue({ success: true, newId: mockNewIssueGuid as LinearGuid });

    const {newState: finalStateCreate, output} = await apply_staged_changes({}, initialState, mockLinearClient);
    const { success, outcome } = output;

    // expect(mockSaveAgentState).toHaveBeenCalledTimes(1); // No longer saves directly
    const savedState = finalStateCreate; // Check the returned state
    
    expect(success).toBe(true);
    expect(outcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);

    expect(savedState.staged_changes).toEqual([]);
    expect(savedState.id_map).toEqual({ [tempId]: mockNewIssueGuid });
    expect(savedState.conversation_history).toEqual(initialState.conversation_history); // Ensure other parts are preserved
  });

  it('should clear staged_changes and update id_map for a simple issue.delete success', async () => {
    const deleteTempId = 'TMP-STATE-D1' as TemporaryFriendlyId;
    const issueGuidToDelete = createMockGuid('state-issue-guid-d1') as LinearGuid;

    const initialChange: StagedChange = {
      opType: 'issue.delete',
      tempId: deleteTempId,
      data: { id: issueGuidToDelete }, // For delete, data usually contains the ID of the item to delete
    };
    const initialState = createInitialAgentState('test-session-state-delete-1', {
      staged_changes: [initialChange],
      id_map: {},
    });

    // executeLinearOperation for delete should return success: true and the ID of the deleted item.
    // The default mock for executeLinearOperation already handles this if idForUpdate is passed.
    // mockExecuteLinearOperation.mockResolvedValue({ success: true, newId: issueGuidToDelete });
    // No specific override for mockExecuteLinearOperation needed here if default is sufficient for delete.

    const {newState: finalStateDelete, output} = await apply_staged_changes({}, initialState, mockLinearClient);
    const { success, outcome } = output;

    // expect(mockSaveAgentState).toHaveBeenCalledTimes(1); // No longer saves directly
    const savedStateDelete = finalStateDelete; // Check the returned state

    expect(success).toBe(true);
    expect(outcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);
    
    expect(savedStateDelete.staged_changes).toEqual([]);
    // For a delete operation, the tempId might still be mapped to the GUID of the deleted entity,
    // or it might be cleared from id_map, or not added. 
    // The current linear_apply.ts logic for successful changes *does* add to internalIdMap if tempId and newId exist.
    // For delete, executeLinearOperation returns the original guid as newId.
    expect(savedStateDelete.id_map).toEqual({ [deleteTempId]: issueGuidToDelete }); 
  });

  it('should handle dependent successes: clear staged_changes and update id_map for create issue then create comment', async () => {
    const sessionId = 'test-session-state-deps';
    const issueTempId = 'TMP-ISSUE-DEP-STATE' as TemporaryFriendlyId;
    const commentTempId = 'TMP-COMMENT-DEP-STATE' as TemporaryFriendlyId;
    const teamId = 'TEAM-DEP-STATE';
    const issueTitle = 'Dependent Issue For State Test';
    const commentBody = 'This depends on the issue for state test.';
    const mockNewIssueGuid = createMockGuid('dep-issue-guid-state') as LinearGuid;
    const mockNewCommentGuid = createMockGuid('dep-comment-guid-state') as LinearGuid;

    const issueChange: StagedChange = {
      opType: 'issue.create',
      tempId: issueTempId,
      data: { teamId: teamId, title: issueTitle },
    };
    const commentChange: StagedChange = {
      opType: 'comment.create',
      tempId: commentTempId,
      data: { 
        issueId: issueTempId, // Reference the issue via its Temp ID initially
        body: commentBody 
      },
    };

    const initialState = createInitialAgentState(sessionId, {
      staged_changes: [issueChange, commentChange],
      id_map: {},
    });

    // Mock Implementations for this specific test
    // enrichStagedChangeData: default pass-through is fine.
    // resolveIdentifiers: default pass-through is fine for initial data.
    // The critical part is that internalIdMap is updated correctly by apply_staged_changes itself.

    // executeLinearOperation needs to return the correct newIds in sequence
    mockExecuteLinearOperation
      .mockResolvedValueOnce({ success: true, newId: mockNewIssueGuid })
      .mockResolvedValueOnce({ success: true, newId: mockNewCommentGuid });
      
    const {newState: finalStateDeps, output} = await apply_staged_changes({}, initialState, mockLinearClient);
    const { success, outcome } = output;

    // expect(mockSaveAgentState).toHaveBeenCalledTimes(1); // No longer saves directly
    const savedStateDeps = finalStateDeps; // Check the returned state
    
    expect(success).toBe(true);
    expect(outcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);

    expect(savedStateDeps.staged_changes).toEqual([]); 
    expect(savedStateDeps.id_map).toEqual({ 
        [issueTempId]: mockNewIssueGuid, 
        [commentTempId]: mockNewCommentGuid 
    }); 
    expect(savedStateDeps.conversation_history).toEqual(initialState.conversation_history);
  });

  it('should keep failed change staged and id_map unchanged on enrichment failure', async () => {
    const sessionId = 'test-session-state-enrich-fail';
    const tempId = 'TMP-ENRICH-FAIL-STATE' as TemporaryFriendlyId;
    const initialChange: StagedChange = {
      opType: 'issue.create',
      tempId: tempId,
      data: { title: 'Enrichment Fail State Test', statusName: 'Invalid Status' },
    };
    const initialState = createInitialAgentState(sessionId, {
      staged_changes: [initialChange],
      id_map: { existing: 'mapping' as LinearGuid },
    });
    const enrichmentErrorMessage = 'Status name is invalid';

    // mockEnrichStagedChangeData is already the vi.fn() from the top-level mock.
    // We use the directly imported EnrichmentError class.
    mockEnrichStagedChangeData.mockRejectedValueOnce(new EnrichmentError(enrichmentErrorMessage));

    // executeLinearOperation should not be called
    mockExecuteLinearOperation.mockClear();

    const {newState: finalStateEnrichFail, output} = await apply_staged_changes({}, initialState, mockLinearClient);
    const { success, outcome, results } = output;

    // expect(mockSaveAgentState).toHaveBeenCalledTimes(1); // No longer saves directly
    const savedStateEnrichFail = finalStateEnrichFail; // Check the returned state

    expect(success).toBe(false);
    expect(outcome).toBe(ApplyOutcome.FAILURE_NONE_APPLIED);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('failed');
    expect(results[0].reason).toContain(enrichmentErrorMessage);
    // Optionally check the reason more specifically if needed
    // expect(results[0].reason).toContain('EnrichmentError');

    expect(savedStateEnrichFail.staged_changes).toHaveLength(1);
    expect(savedStateEnrichFail.staged_changes[0]).toEqual(initialChange);
    expect(savedStateEnrichFail.id_map).toEqual({ existing: 'mapping' as LinearGuid });
    expect(mockExecuteLinearOperation).not.toHaveBeenCalled();
  });

  it('should clear staged_changes for a successful issue.update (id_map may be unchanged or reflect resolved ID)', async () => {
    const sessionId = 'test-session-state-update';
    const friendlyIssueId = 'EXISTING-ISSUE-STATE-123'; // Using a distinct friendly ID for this test
    const mockResolvedIssueGuid = createMockGuid('state-update-guid-abc') as LinearGuid;
    const newTitle = 'Updated Issue Title For State Test';

    const initialChange: StagedChange = {
      opType: 'issue.update',
      // No tempId for this update, identified by data.id (which is a friendlyID here)
      data: {
        id: friendlyIssueId, 
        title: newTitle,
      },
    };

    const initialState = createInitialAgentState(sessionId, {
      staged_changes: [initialChange],
      id_map: { [friendlyIssueId]: mockResolvedIssueGuid }, // Pre-existing mapping
    });

    // Mock setup for this test:
    // 1. resolveIdentifiers needs to turn friendlyIssueId into mockResolvedIssueGuid
    mockResolveIdentifiers.mockResolvedValue({ 
      success: true, 
      resolvedData: { ...initialChange.data, id: mockResolvedIssueGuid } 
    });

    // 2. enrichStagedChangeData: default pass-through is fine if no name-to-ID enrichment for this update.
    //    If there was (e.g. statusName), we'd mock its output specifically.
    //    The data passed to enrichment will have the resolved GUID.
    mockEnrichStagedChangeData.mockImplementation(async (change) => {
        return { ...change.data }; // simple pass through of data part of change
    });

    // 3. executeLinearOperation: default success is fine. 
    //    It will be called with opType, (data - id), and idForUpdate = mockResolvedIssueGuid.
    //    The default mock already returns { success: true, newId: idForUpdate } which is correct for updates.

    const {newState: finalStateUpdate, output} = await apply_staged_changes({}, initialState, mockLinearClient);
    const { success, outcome } = output;

    // expect(mockSaveAgentState).toHaveBeenCalledTimes(1); // No longer saves directly
    const savedStateUpdate = finalStateUpdate; // Check the returned state

    expect(success).toBe(true);
    expect(outcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);

    expect(savedStateUpdate.staged_changes).toEqual([]);
    // id_map should still contain the original mapping, as no new tempIds were introduced and resolved.
    // If the update was via a tempId that got resolved to an existing guid, that tempId would be added.
    // But here, we started with a friendlyID that mapped to a guid.
    expect(savedStateUpdate.id_map).toEqual({ [friendlyIssueId]: mockResolvedIssueGuid }); 
    expect(savedStateUpdate.conversation_history).toEqual(initialState.conversation_history);
  });

  it('should handle partial success: keep failed changes, clear successful, update id_map correctly', async () => {
    const sessionId = 'test-session-state-partial';
    const issueTempIdSuccess = 'TMP-PARTIAL-SUCCESS-STATE' as TemporaryFriendlyId;
    const issueTempIdFailEnrich = 'MIXED-TMP-CREATE-FAIL-ENRICH-STATE' as TemporaryFriendlyId;
    const newIssueIdSuccess = createMockGuid('state-partial-create-ok') as LinearGuid;
    const enrichmentErrorMessage = 'Failed enrichment for partial state test';
    const apiFailureReason = 'Simulated API Failure for updateFail in state test';

    const updateSuccessChange: StagedChange = { opType: 'issue.update', data: { id: 'MIXED-ISSUE-UPDATE-OK-STATE', title: 'Mixed Update OK State' } };
    const updateFailChange: StagedChange = { opType: 'issue.update', data: { id: 'MIXED-ISSUE-UPDATE-FAIL-STATE', title: 'Mixed Update Fail State' } };
    const createSuccessChange: StagedChange = { opType: 'issue.create', tempId: issueTempIdSuccess, data: { title: 'Mixed Create OK State', teamId: 'MIXED-TEAM-STATE' } };
    const createFailEnrichChange: StagedChange = { opType: 'issue.create', tempId: issueTempIdFailEnrich, data: { title: 'Mixed Create Fail Enrich State', teamId: 'MIXED-TEAM-FAIL-STATE' } };

    const initialState = createInitialAgentState(sessionId, {
      staged_changes: [updateSuccessChange, updateFailChange, createSuccessChange, createFailEnrichChange],
      id_map: { existing: 'mapping-partial' as LinearGuid },
    });

    // --- Mock Setup for Partial Success Test ---
    mockResolveIdentifiers.mockImplementation(async (data) => {
      // For updates, assume ID is already resolved for mock purposes
      if (data.id === updateSuccessChange.data.id || data.id === updateFailChange.data.id) {
        return { success: true, resolvedData: { ...data } };
      }
      // For creates, pass through the data (no complex resolution needed for this test's mocks)
      if (data.title === createSuccessChange.data.title || data.title === createFailEnrichChange.data.title) {
        return { success: true, resolvedData: { ...data } };
      }
      return { success: true, resolvedData: { ...data } }; // Default pass-through
    });
    
    mockEnrichStagedChangeData.mockImplementation(async (change) => {
      if (change.tempId === issueTempIdFailEnrich || change.data.title === createFailEnrichChange.data.title) {
        throw new EnrichmentError(enrichmentErrorMessage);
      }
      return change.data; // Pass through data for successful enrichments
    });

    mockExecuteLinearOperation.mockImplementation(async (opType, input, idForUpdate) => {
      if (opType === 'issue.update' && idForUpdate === updateSuccessChange.data.id) {
        return { success: true }; // updateSuccessChange
      }
      if (opType === 'issue.update' && idForUpdate === updateFailChange.data.id) {
        return { success: false, reason: apiFailureReason }; // updateFailChange
      }
      if (opType === 'issue.create' && input.title === createSuccessChange.data.title) {
        return { success: true, newId: newIssueIdSuccess }; // createSuccessChange
      }
      // Should not be called for createFailEnrichChange
      console.error('[TEST MOCK ERROR] Unexpected call to mockExecuteLinearOperation:', { opType, input, idForUpdate });
      return { success: false, reason: '[TEST MOCK ERROR] Unexpected call to executeLinearOperation' };
    });
    // --- End Mock Setup ---

    const {newState: finalStatePartial, output} = await apply_staged_changes({}, initialState, mockLinearClient);
    const { success, outcome, results } = output;

    // Verify the state that would have been saved
    // expect(mockSaveAgentState).toHaveBeenCalledTimes(1); // No longer saves directly
    const savedStatePartial = finalStatePartial; // Check the returned state

    expect(success).toBe(false);
    expect(outcome).toBe(ApplyOutcome.SUCCESS_PARTIAL_APPLIED);
    expect(results).toHaveLength(4); // Corrected assertion: expect 4 results for 4 changes

    // Adjust finders to handle potential undefined results cleanly
    const updateOkResult = results.find(r => r.change.data?.id === updateSuccessChange.data.id);
    const updateFailResult = results.find(r => r.change.data?.id === updateFailChange.data.id);
    const createOkResult = results.find(r => r.change.tempId === issueTempIdSuccess);
    const createFailResult = results.find(r => r.change.tempId === issueTempIdFailEnrich);

    expect(updateOkResult?.status).toBe('succeeded');
    expect(updateFailResult?.status).toBe('failed');
    expect(updateFailResult?.reason).toBe(apiFailureReason);
    expect(createOkResult?.status).toBe('succeeded');
    expect(createOkResult?.newId).toBe(newIssueIdSuccess);
    expect(createFailResult?.status).toBe('failed');
    expect(createFailResult?.reason).toContain(enrichmentErrorMessage);
    expect(createFailResult?.newId).toBeUndefined();

    expect(savedStatePartial.staged_changes).toHaveLength(1); // ONLY Enrichment fail remains (API fail is removed)
    // Check that the *specific* failed change remains
    expect(savedStatePartial.staged_changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ tempId: issueTempIdFailEnrich }), // Enrichment fail
      // expect.objectContaining({ data: expect.objectContaining({ id: updateFailChange.data.id }) }) // API fail is REMOVED
    ]));
    // Ensure ONLY the enrichment failure remains
    expect(savedStatePartial.staged_changes[0].tempId).toBe(issueTempIdFailEnrich);

    expect(savedStatePartial.id_map).toEqual({
      // Original mapping should persist if not used as tempId target
      existing: 'mapping-partial',
      // Mapping for the successfully created issue
      [issueTempIdSuccess]: newIssueIdSuccess,
      // No mapping for issueTempIdFailEnrich as it failed before execution
      // No mapping changes expected for the updates as they used existing IDs
    });
  });

  // More tests focusing on state outcomes will be migrated here...
}); 