/// <reference types="vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apply_staged_changes, formatEnrichmentFailureReason, type ApplyStagedChangesResult, ApplyOutcome } from '@/tools/linear_apply';
import type { AgentState, StagedChange } from '@/state/types';
import type { TemporaryFriendlyId, LinearGuid } from '@/types/linear-ids';
import { createMockLinearClient, type MockLinearClientInterface } from '@tests/shared/mocks/linear_client.mock';
import { enrichStagedChangeData, EnrichmentError } from '@/linear/enrichment';
import { saveAgentState } from '@/state/manager';
import { resolveIdentifiers, executeLinearOperation } from '@/tools/linear_sdk_helpers';
import { createInitialAgentState } from '@tests/shared/linear-e2e.config';
import { createMockGuid } from '@tests/shared/testUtils';

// Mock dependencies (similar setup as state.spec file)
vi.mock('@/linear/enrichment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/linear/enrichment')>();
  return { ...actual, enrichStagedChangeData: vi.fn(), EnrichmentError: actual.EnrichmentError };
});
vi.mock('@/state/manager', () => ({ saveAgentState: vi.fn() }));
vi.mock('@/tools/linear_sdk_helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/linear_sdk_helpers')>();
  return { ...actual, resolveIdentifiers: vi.fn(), executeLinearOperation: vi.fn() };
});

describe('apply_staged_changes - Orchestration Tests', () => {
  const mockEnrichStagedChangeData = vi.mocked(enrichStagedChangeData);
  const mockSaveAgentState = vi.mocked(saveAgentState);
  const mockResolveIdentifiers = vi.mocked(resolveIdentifiers);
  const mockExecuteLinearOperation = vi.mocked(executeLinearOperation);
  let mockLinearClient: MockLinearClientInterface;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLinearClient = createMockLinearClient();

    // Default successful mocks - specific args/return values checked in tests
    mockResolveIdentifiers.mockResolvedValue({ success: true, resolvedData: {} });
    mockExecuteLinearOperation.mockResolvedValue({ success: true, newId: undefined });
    mockEnrichStagedChangeData.mockImplementation(async (change) => change.data);
    mockSaveAgentState.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('should call dependencies in order for a simple issue.create', async () => {
    const tempId = 'TMP-ORCH-1' as TemporaryFriendlyId;
    const initialData = { title: 'Orch Test Issue', teamId: 'team-orch' };
    const initialChange: StagedChange = { opType: 'issue.create', tempId: tempId, data: initialData };
    const initialState = createInitialAgentState('test-session-orch-1', { staged_changes: [initialChange] });
    const mockNewIssueGuid = createMockGuid('orch-issue-guid-1') as LinearGuid;
    
    // Mock specific return values needed for the sequence
    const resolvedData = { ...initialData }; // Simple create, assume resolve passes through
    const enrichedData = { ...resolvedData }; // Simple create, assume enrich passes through
    mockResolveIdentifiers.mockResolvedValue({ success: true, resolvedData: resolvedData });
    mockEnrichStagedChangeData.mockResolvedValue(enrichedData);
    mockExecuteLinearOperation.mockResolvedValue({ success: true, newId: mockNewIssueGuid });

    // --- Execute --- 
    const { newState, output: result }: { newState: AgentState, output: ApplyStagedChangesResult } = await apply_staged_changes({}, initialState, mockLinearClient);

    // --- Assertions --- 
    // Assert calls
    expect(mockResolveIdentifiers).toHaveBeenCalledTimes(1);
    expect(mockResolveIdentifiers).toHaveBeenCalledWith(initialData, 'issue.create', expect.any(Map));

    expect(mockEnrichStagedChangeData).toHaveBeenCalledTimes(1);
    // Enrichment is called with the original change object but potentially resolved data if applicable
    // For a simple create, resolvedData === initialData essentially
    expect(mockEnrichStagedChangeData).toHaveBeenCalledWith(
        expect.objectContaining({ data: resolvedData }), // Check data passed matches resolvedData
        expect.anything(), // client
        expect.any(Map)    // map
    );

    expect(mockExecuteLinearOperation).toHaveBeenCalledTimes(1);
    expect(mockExecuteLinearOperation).toHaveBeenCalledWith(
        'issue.create',
        enrichedData,      // Called with enriched data
        undefined,         // idForUpdate
        expect.anything()  // client
    );

    // Assert overall result structure
    expect(result.success).toBe(true);
    expect(result.outcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);
    expect(result.message).toBeUndefined();
    expect(result.results).toHaveLength(1);

    // Assert detailed result
    const detail = result.results[0];
    expect(detail.status).toBe('succeeded');
    expect(detail.change).toEqual(initialChange);
    expect(detail.newId).toBe(mockNewIssueGuid);
    expect(detail.reason).toBeUndefined();
    
    // Assert final state
    expect(newState.staged_changes).toEqual([]); // Successful change removed
    expect(newState.id_map[tempId]).toBe(mockNewIssueGuid); // ID map updated
  });

  it('should handle dependency resolution and calls for create issue then comment', async () => {
    const sessionId = 'test-session-orch-deps';
    const issueTempId = 'TMP-ISSUE-DEP-ORCH' as TemporaryFriendlyId;
    const commentTempId = 'TMP-COMMENT-DEP-ORCH' as TemporaryFriendlyId;
    const mockNewIssueGuid = createMockGuid('dep-issue-guid-orch') as LinearGuid;
    const mockNewCommentGuid = createMockGuid('dep-comment-guid-orch') as LinearGuid;

    const issueChange: StagedChange = {
      opType: 'issue.create',
      tempId: issueTempId,
      data: { teamId: 'team-dep-orch', title: 'Dependent Issue Orch' },
    };
    const issueResolvedData = { ...issueChange.data };
    const issueEnrichedData = { ...issueResolvedData }; 

    const commentChange: StagedChange = {
      opType: 'comment.create',
      tempId: commentTempId,
      data: { issueId: issueTempId, body: 'Depends on issue orch.' },
    };
    // This is the data structure AFTER resolveIdentifiers is called for the comment,
    // having resolved the tempId from the internalIdMap *inside* apply_staged_changes.
    // The assertion below checks that the map contained the ID.
    const commentResolvedData = { issueId: mockNewIssueGuid, body: commentChange.data.body }; 
    const commentEnrichedData = { ...commentResolvedData }; // Assume enrich passes through

    const initialState = createInitialAgentState(sessionId, {
      staged_changes: [issueChange, commentChange],
      id_map: {},
    });

    // --- Mock Implementations ---
    // Mock resolveIdentifiers: Called twice. First for issue (simple pass-through),
    // second for comment (also simple pass-through, as resolution logic is internal to apply_staged_changes's use of the map)
    mockResolveIdentifiers
      .mockResolvedValueOnce({ success: true, resolvedData: issueResolvedData })
      .mockResolvedValueOnce({ success: true, resolvedData: commentResolvedData }); // Return data with the *resolved* issueId for the comment

    // Mock enrichStagedChangeData: Called twice. 
    mockEnrichStagedChangeData
      .mockResolvedValueOnce(issueEnrichedData)
      .mockResolvedValueOnce(commentEnrichedData); // Enrich is called *after* internal ID resolution, so it gets the resolved GUID

    // Mock executeLinearOperation: Called twice.
    mockExecuteLinearOperation
      .mockResolvedValueOnce({ success: true, newId: mockNewIssueGuid })
      .mockResolvedValueOnce({ success: true, newId: mockNewCommentGuid });

    // --- Execute --- 
    const { newState, output: result }: { newState: AgentState, output: ApplyStagedChangesResult } = await apply_staged_changes({}, initialState, mockLinearClient);

    // --- Assertions --- 
    // Assert calls (same as before)
    expect(mockResolveIdentifiers).toHaveBeenCalledTimes(2);
    // First call (issue): simple data
    expect(mockResolveIdentifiers).toHaveBeenNthCalledWith(1, issueChange.data, issueChange.opType, expect.any(Map));
    // Second call (comment): Uses the map which *should* now contain the issue ID
    const mapPassedToSecondResolve = mockResolveIdentifiers.mock.calls[1][2];
    expect(mapPassedToSecondResolve.get(issueTempId)).toBe(mockNewIssueGuid);
    expect(mockResolveIdentifiers).toHaveBeenNthCalledWith(2, commentChange.data, commentChange.opType, mapPassedToSecondResolve);

    expect(mockEnrichStagedChangeData).toHaveBeenCalledTimes(2);
    // First call (issue)
    expect(mockEnrichStagedChangeData).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: issueResolvedData }), expect.anything(), expect.any(Map));
    // Second call (comment): Should be called with the *resolved* issue ID from the internal map
    const mapPassedToSecondEnrich = mockEnrichStagedChangeData.mock.calls[1][2];
    expect(mapPassedToSecondEnrich.get(issueTempId)).toBe(mockNewIssueGuid); // Verify map state passed to enrich
    expect(mockEnrichStagedChangeData).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: commentResolvedData }), expect.anything(), mapPassedToSecondEnrich);

    expect(mockExecuteLinearOperation).toHaveBeenCalledTimes(2);
    // First call (issue)
    expect(mockExecuteLinearOperation).toHaveBeenNthCalledWith(1, issueChange.opType, issueEnrichedData, undefined, expect.anything());
    // Second call (comment): Called with enriched data containing the resolved GUID
    expect(mockExecuteLinearOperation).toHaveBeenNthCalledWith(2, commentChange.opType, commentEnrichedData, undefined, expect.anything());

    // Assert overall result structure
    expect(result.success).toBe(true);
    expect(result.outcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);
    expect(result.message).toBeUndefined();
    expect(result.results).toHaveLength(2);

    // Assert detailed results
    const issueDetail = result.results.find(r => r.change.tempId === issueTempId);
    const commentDetail = result.results.find(r => r.change.tempId === commentTempId);
    expect(issueDetail).toBeDefined();
    expect(commentDetail).toBeDefined();
    expect(issueDetail!.status).toBe('succeeded');
    expect(issueDetail!.newId).toBe(mockNewIssueGuid);
    expect(commentDetail!.status).toBe('succeeded');
    expect(commentDetail!.newId).toBe(mockNewCommentGuid);
    
    // Assert final state
    expect(newState.staged_changes).toEqual([]); // Successful changes removed
    expect(newState.id_map[issueTempId]).toBe(mockNewIssueGuid);
    expect(newState.id_map[commentTempId]).toBe(mockNewCommentGuid);
  });

  it('should handle API failure during executeLinearOperation', async () => {
    const sessionId = 'test-session-orch-api-fail';
    const tempId = 'TMP-API-FAIL-ORCH' as TemporaryFriendlyId;
    const initialChange: StagedChange = {
      opType: 'issue.create',
      tempId: tempId,
      data: { teamId: 'team-api-fail-orch', title: 'API Fail Orch Test' },
    };
    const enrichedData = { ...initialChange.data }; // Assume simple enrichment
    const apiFailureReason = 'SDK Error From Execute Mock';

    const initialState = createInitialAgentState(sessionId, {
      staged_changes: [initialChange],
    });

    // Mock dependencies
    mockResolveIdentifiers.mockResolvedValue({ success: true, resolvedData: { ...initialChange.data } });
    mockEnrichStagedChangeData.mockResolvedValue(enrichedData);
    mockExecuteLinearOperation.mockResolvedValue({ success: false, reason: apiFailureReason });

    // --- Execute --- 
    const { newState, output: result }: { newState: AgentState, output: ApplyStagedChangesResult } = await apply_staged_changes({}, initialState, mockLinearClient);

    // --- Assertions --- 
    // Assert calls (same as before)
    expect(mockResolveIdentifiers).toHaveBeenCalledTimes(1);
    expect(mockEnrichStagedChangeData).toHaveBeenCalledTimes(1);
    expect(mockExecuteLinearOperation).toHaveBeenCalledTimes(1);
    expect(mockExecuteLinearOperation).toHaveBeenCalledWith(
      initialChange.opType,
      enrichedData,
      undefined, // idForUpdate for create
      expect.anything()
    );

    // Assert overall result structure
    expect(result.success).toBe(false);
    expect(result.outcome).toBe(ApplyOutcome.FAILURE_NONE_APPLIED);
    expect(result.results).toHaveLength(1);

    // Assert detailed result
    const detail = result.results[0];
    expect(detail.status).toBe('failed');
    expect(detail.change).toEqual(initialChange);
    expect(detail.newId).toBeUndefined();
    expect(detail.reason).toBe(apiFailureReason);

    // Assert final state 
    // Failure during SDK execution *should* remove the change from staged_changes
    expect(newState.staged_changes).toEqual([]); 
    expect(newState.id_map).toEqual({}); // No new mapping
  });

  it('should return immediately and not call dependencies if no changes are staged', async () => {
    const sessionId = 'test-session-orch-no-changes';
    const initialState = createInitialAgentState(sessionId); // Creates state with empty staged_changes

    // Clear mocks to ensure they are not called
    mockResolveIdentifiers.mockClear();
    mockEnrichStagedChangeData.mockClear();
    mockExecuteLinearOperation.mockClear();
    mockSaveAgentState.mockClear();

    // --- Execute ---
    const { newState, output: result }: { newState: AgentState, output: ApplyStagedChangesResult } = await apply_staged_changes({}, initialState, mockLinearClient);

    // --- Assertions ---
    expect(result.success).toBe(true); // Vacuously true
    expect(result.outcome).toBe(ApplyOutcome.ERROR_PRECONDITION);
    expect(result.message).toBe('No staged changes found to apply.');
    expect(result.results).toEqual([]);
    expect(newState).toEqual(initialState); // State should be unchanged

    // Assert no calls made
    expect(mockResolveIdentifiers).not.toHaveBeenCalled();
    expect(mockEnrichStagedChangeData).not.toHaveBeenCalled();
    expect(mockExecuteLinearOperation).not.toHaveBeenCalled();
    expect(mockSaveAgentState).not.toHaveBeenCalled();
  });

  it('should handle multiple successful independent changes', async () => {
    const sessionId = 'test-session-orch-multi-success';
    // --- Setup Mocks & Data ---
    const friendlyIssueIdToUpdate = 'MULTI-ISSUE-ORCH-1';
    const mockResolvedIssueIdUpdate = createMockGuid('MULTI-ISSUE-ORCH-1') as LinearGuid;
    const friendlyCommentIdToDelete = 'MULTI-COMMENT-ORCH-2';
    const mockResolvedCommentIdDelete = createMockGuid('MULTI-COMMENT-ORCH-2') as LinearGuid;
    const issueTempId = 'MULTI-TMP-ISSUE-ORCH-3' as TemporaryFriendlyId;
    const mockNewIssueGuid = createMockGuid('MULTI-TMP-ISSUE-ORCH-3') as LinearGuid;

    const updateChange: StagedChange = {
      opType: 'issue.update', 
      data: { id: friendlyIssueIdToUpdate, title: 'Updated Multi Orch' }
    };
    const deleteChange: StagedChange = {
      opType: 'comment.delete',
      data: { id: friendlyCommentIdToDelete }
    };
    const createChange: StagedChange = {
      opType: 'issue.create',
      tempId: issueTempId,
      data: { title: 'Created Multi Orch', teamId: 'mock-team-id' }
    };
    const initialState = createInitialAgentState(sessionId, {
      staged_changes: [updateChange, deleteChange, createChange],
      // Assume initial ID map contains the targets for update/delete if they were pre-existing
      id_map: {
          [friendlyIssueIdToUpdate]: mockResolvedIssueIdUpdate,
          [friendlyCommentIdToDelete]: mockResolvedCommentIdDelete
      }
    });

    // Mocks (assuming simple pass-through for resolve/enrich for brevity)
    mockResolveIdentifiers.mockImplementation(async (_data, opType, _map) => {
        if (opType === 'issue.update') return { success: true, resolvedData: { id: mockResolvedIssueIdUpdate, title: 'Updated Multi Orch' } };
        if (opType === 'comment.delete') return { success: true, resolvedData: { id: mockResolvedCommentIdDelete } };
        if (opType === 'issue.create') return { success: true, resolvedData: { title: 'Created Multi Orch', teamId: 'mock-team-id' } };
        return { success: false, reason: 'Unexpected opType' };
    });
     mockEnrichStagedChangeData.mockImplementation(async (change) => change.data);
     mockExecuteLinearOperation
        .mockResolvedValueOnce({ success: true }) // For issue.update
        .mockResolvedValueOnce({ success: true }) // For comment.delete
        .mockResolvedValueOnce({ success: true, newId: mockNewIssueGuid }); // For issue.create

    // --- Execute ---
    const { newState, output: result }: { newState: AgentState, output: ApplyStagedChangesResult } = await apply_staged_changes({}, initialState, mockLinearClient);

    // --- Assertions ---
    // Assert calls (check counts)
    expect(mockResolveIdentifiers).toHaveBeenCalledTimes(3);
    expect(mockEnrichStagedChangeData).toHaveBeenCalledTimes(3);
    expect(mockExecuteLinearOperation).toHaveBeenCalledTimes(3);

    // Assert overall result structure
    expect(result.success).toBe(true);
    expect(result.outcome).toBe(ApplyOutcome.SUCCESS_ALL_APPLIED);
    expect(result.message).toBeUndefined();
    expect(result.results).toHaveLength(3);

    // Assert detailed results (check statuses and relevant IDs)
    const updateDetail = result.results.find(r => r.change.opType === 'issue.update');
    const deleteDetail = result.results.find(r => r.change.opType === 'comment.delete');
    const createDetail = result.results.find(r => r.change.tempId === issueTempId);
    expect(updateDetail?.status).toBe('succeeded');
    expect(deleteDetail?.status).toBe('succeeded');
    expect(createDetail?.status).toBe('succeeded');
    expect(createDetail?.newId).toBe(mockNewIssueGuid);

    // Assert final state
    expect(newState.staged_changes).toEqual([]); // All successful, all removed
    expect(newState.id_map[issueTempId]).toBe(mockNewIssueGuid);
    // Check that original IDs used for update/delete are still in id_map
    expect(newState.id_map[friendlyIssueIdToUpdate]).toBe(mockResolvedIssueIdUpdate);
    expect(newState.id_map[friendlyCommentIdToDelete]).toBe(mockResolvedCommentIdDelete);
  });

  it('should handle partial success: one success, one SDK failure', async () => {
    const sessionId = 'test-session-orch-partial-sdk';
    const createTempId = 'TMP-PARTIAL-SDK-1' as TemporaryFriendlyId;
    const createChange: StagedChange = { 
        opType: 'issue.create', 
        tempId: createTempId, 
        data: { title: 'Partial SDK Create', teamId: 'mock-team-id' }
    };
    const friendlyUpdateTarget = 'PARTIAL-SDK-UPDATE-TARGET';
    const mockResolvedUpdateTarget = createMockGuid('partial-sdk-update-guid') as LinearGuid;
    const updateChange: StagedChange = { opType: 'issue.update', data: { id: friendlyUpdateTarget, title: 'Update Should Fail' } };
    const initialState = createInitialAgentState(sessionId, {
        staged_changes: [createChange, updateChange],
        id_map: { [friendlyUpdateTarget]: mockResolvedUpdateTarget } 
    });
    const mockNewIssueGuid = createMockGuid('partial-sdk-create-guid') as LinearGuid;
    const updateFailureReason = 'SDK error during update';

    // --- Mock Setup --- 
    mockResolveIdentifiers.mockImplementation(async (_data, opType, _map) => {
        if (opType === 'issue.create') return { success: true, resolvedData: { ...createChange.data } };
        if (opType === 'issue.update') return { success: true, resolvedData: { id: mockResolvedUpdateTarget, title: 'Update Should Fail' } };
        return { success: false, reason: 'Unexpected opType' };
    });
    mockEnrichStagedChangeData.mockImplementation(async (change) => change.data);
    mockExecuteLinearOperation
        .mockResolvedValueOnce({ success: true, newId: mockNewIssueGuid }) // For create
        .mockResolvedValueOnce({ success: false, reason: updateFailureReason }); // For update

    // --- Execute ---
    const { newState, output: result }: { newState: AgentState, output: ApplyStagedChangesResult } = await apply_staged_changes({}, initialState, mockLinearClient);

    // --- Assertions ---
    // Assert calls (check counts)
    expect(mockResolveIdentifiers).toHaveBeenCalledTimes(2);
    expect(mockEnrichStagedChangeData).toHaveBeenCalledTimes(2);
    expect(mockExecuteLinearOperation).toHaveBeenCalledTimes(2);

    // Assert overall result structure
    expect(result.success).toBe(false);
    expect(result.outcome).toBe(ApplyOutcome.SUCCESS_PARTIAL_APPLIED);
    expect(result.message).toBeUndefined();
    expect(result.results).toHaveLength(2);

    // Assert detailed results
    const createDetail = result.results.find(r => r.change.tempId === createTempId);
    const updateDetail = result.results.find(r => r.change.opType === 'issue.update');
    expect(createDetail?.status).toBe('succeeded');
    expect(createDetail?.newId).toBe(mockNewIssueGuid);
    expect(updateDetail?.status).toBe('failed');
    expect(updateDetail?.reason).toBe(updateFailureReason);

    // Assert final state
    expect(newState.staged_changes).toEqual([]); // Both success and SDK failure cause removal
    expect(newState.id_map[createTempId]).toBe(mockNewIssueGuid);
  });

  it('should handle partial success: one success, one enrichment failure', async () => {
    const sessionId = 'test-session-orch-partial-enrich';
    const createTempId = 'TMP-PARTIAL-ENRICH-1' as TemporaryFriendlyId;
    const createChange: StagedChange = { 
        opType: 'issue.create', 
        tempId: createTempId, 
        data: { title: 'Partial Enrich Create', teamId: 'mock-team-id' }
    };
    const updateTempId = 'TMP-PARTIAL-ENRICH-2' as TemporaryFriendlyId;
    const updateChange: StagedChange = { opType: 'issue.update', tempId: updateTempId, data: { id: 'some-guid', teamId: 'ZZZ' } }; // Team ZZZ will fail enrichment
    const initialState = createInitialAgentState(sessionId, { staged_changes: [createChange, updateChange] });
    const mockNewIssueGuid = createMockGuid('partial-enrich-create-guid') as LinearGuid;
    const createResolvedData = { ...createChange.data };
    const updateResolvedData = { ...updateChange.data };
    const createEnrichedData = { ...createResolvedData };
    const enrichFailureReason = 'Cannot find team ID ZZZ';

    // --- Mock Setup ---
    mockResolveIdentifiers.mockImplementation(async (_data, opType) => {
        if (opType === 'issue.create') return { success: true, resolvedData: createResolvedData };
        if (opType === 'issue.update') return { success: true, resolvedData: updateResolvedData };
        return { success: false, reason: 'Unexpected opType' };
    });
    mockEnrichStagedChangeData
        .mockResolvedValueOnce(createEnrichedData) // Success for create
        .mockRejectedValueOnce(new EnrichmentError(enrichFailureReason)); // Failure for update
    mockExecuteLinearOperation.mockResolvedValueOnce({ success: true, newId: mockNewIssueGuid });

    // --- Execute ---
    const { newState, output: result }: { newState: AgentState, output: ApplyStagedChangesResult } = await apply_staged_changes({}, initialState, mockLinearClient);

    // --- Assertions ---
    // Assert calls
    expect(mockResolveIdentifiers).toHaveBeenCalledTimes(2);
    expect(mockEnrichStagedChangeData).toHaveBeenCalledTimes(2);
    expect(mockExecuteLinearOperation).toHaveBeenCalledTimes(1); // Only the successful one reaches execution

    // Assert overall result structure
    expect(result.success).toBe(false);
    expect(result.outcome).toBe(ApplyOutcome.SUCCESS_PARTIAL_APPLIED);
    expect(result.message).toBeUndefined();
    expect(result.results).toHaveLength(2);

    // Assert detailed results
    const createDetail = result.results.find(r => r.change.tempId === createTempId);
    const updateDetail = result.results.find(r => r.change.tempId === updateTempId);
    expect(createDetail?.status).toBe('succeeded');
    expect(createDetail?.newId).toBe(mockNewIssueGuid);
    expect(updateDetail?.status).toBe('failed');
    expect(updateDetail?.reason).toBe(formatEnrichmentFailureReason(enrichFailureReason)); // Check formatted reason

    // Assert final state
    // Enrichment failure should *not* remove the change
    expect(newState.staged_changes).toHaveLength(1);
    expect(newState.staged_changes[0]).toEqual(updateChange); // Failed change remains
    expect(newState.id_map[createTempId]).toBe(mockNewIssueGuid);
  });

  it('should handle partial success: one success, one ID resolution failure', async () => {
    const sessionId = 'test-session-orch-partial-resolve';
    const createTempId = 'TMP-RES-PARTIAL-1' as TemporaryFriendlyId;
    const createChange: StagedChange = { 
        opType: 'issue.create', 
        tempId: createTempId, 
        data: { title: 'Resolve Partial Create', teamId: 'mock-team-id' }
    };
    const updateTempId = 'TMP-RES-PARTIAL-2' as TemporaryFriendlyId;
    const nonExistentUpdateTarget = 'TARGET-NOT-EXIST' as TemporaryFriendlyId;
    const updateChange: StagedChange = { opType: 'issue.update', tempId: updateTempId, data: { id: nonExistentUpdateTarget, title: 'Update Should Fail' } };
    const initialState = createInitialAgentState(sessionId, { staged_changes: [createChange, updateChange] });
    const mockNewIssueGuid = createMockGuid('resolve-partial-guid') as LinearGuid;
    const resolveFailureReason = `ID resolution error for op 'issue.update': Could not resolve identifier '${nonExistentUpdateTarget}'`;

    // --- Mock Setup --- 
    mockResolveIdentifiers
        .mockResolvedValueOnce({ success: true, resolvedData: { ...createChange.data } }) // Success for create
        .mockResolvedValueOnce({ success: false, reason: resolveFailureReason });       // Failure for update
    mockEnrichStagedChangeData.mockResolvedValue({ ...createChange.data }); // Only create is enriched
    mockExecuteLinearOperation.mockResolvedValueOnce({ success: true, newId: mockNewIssueGuid });

    // --- Execute --- 
    const { newState, output: result }: { newState: AgentState, output: ApplyStagedChangesResult } = await apply_staged_changes({}, initialState, mockLinearClient);

    // --- Assertions --- 
    // Assert calls
    expect(mockResolveIdentifiers).toHaveBeenCalledTimes(2);
    expect(mockEnrichStagedChangeData).toHaveBeenCalledTimes(1); // Only the successful one
    expect(mockExecuteLinearOperation).toHaveBeenCalledTimes(1);

    // Assert overall result structure
    expect(result.success).toBe(false);
    expect(result.outcome).toBe(ApplyOutcome.SUCCESS_PARTIAL_APPLIED);
    expect(result.message).toBeUndefined();
    expect(result.results).toHaveLength(2);

    // Assert detailed results
    const createDetail = result.results.find(r => r.change.tempId === createTempId);
    const updateDetail = result.results.find(r => r.change.tempId === updateTempId);
    expect(createDetail?.status).toBe('succeeded');
    expect(createDetail?.newId).toBe(mockNewIssueGuid);
    expect(updateDetail?.status).toBe('failed');
    expect(updateDetail?.reason).toBe(resolveFailureReason);

    // Assert final state
    // ID Resolution failure should *not* remove the change
    expect(newState.staged_changes).toHaveLength(1);
    expect(newState.staged_changes[0]).toEqual(updateChange); // Failed change remains
    expect(newState.id_map[createTempId]).toBe(mockNewIssueGuid);
  });

  // Test for topological sort failure
  it('should handle topological sort error and return failure', async () => {
    const sessionId = 'test-session-orch-topo-fail';
    const tempIdA = 'TMP-TOPO-A' as TemporaryFriendlyId;
    const tempIdB = 'TMP-TOPO-B' as TemporaryFriendlyId;
    // Fix data to use "temp:" prefix for sortByDependencies
    const changeA: StagedChange = { opType: 'comment.create', tempId: tempIdA, data: { issueId: `temp:${tempIdB}`, body: 'A depends on B' } }; 
    const changeB: StagedChange = { opType: 'comment.create', tempId: tempIdB, data: { issueId: `temp:${tempIdA}`, body: 'B depends on A' } };
    const initialState = createInitialAgentState(sessionId, { staged_changes: [changeA, changeB] });

    // --- Execute --- 
    const { newState, output: result }: { newState: AgentState, output: ApplyStagedChangesResult } = await apply_staged_changes({}, initialState, mockLinearClient);

    // --- Assertions ---
    // Assert overall result structure
    expect(result.success).toBe(false);
    expect(result.outcome).toBe(ApplyOutcome.ERROR_PRECONDITION);
    expect(result.message).toMatch(/Error: Could not determine a valid order/i);
    expect(result.results).toEqual([]);
    expect(newState).toEqual(initialState);

    // Optionally check if mocks were called (or not called)
    // expect(mockSortByDependencies).toHaveBeenCalledTimes(1); // Cannot assert on real function easily
    expect(mockResolveIdentifiers).not.toHaveBeenCalled();
    expect(mockEnrichStagedChangeData).not.toHaveBeenCalled();
    expect(mockExecuteLinearOperation).not.toHaveBeenCalled();
  });

}); 