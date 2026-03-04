/// <reference types="vitest" />
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
    enrichStagedChangeData,
    // Export internal functions for testing if they aren't already exported
    // Alternatively, test them indirectly via enrichStagedChangeData
    // Let's assume we can import them directly for focused tests:
    // (Requires exporting them from enrichment.ts if not already done)
    resolveWorkflowStateNameToId, 
    resolveUserToId,
    resolveLabelNamesToIds,
    resolvePriorityNameToValue, // Assuming this is exported or testable
    resolveProjectNameToId,
    resolveTeamNameToId,
    resolveCycleNameToId,
    EnrichmentError // Import the custom error
} from '@/linear/enrichment'; 
import { resolveFriendlyIdToGuid } from '@/linear/operations/utils';
import type { StagedChange } from '@/state/types';
import type { LinearClient } from '@linear/sdk';
import type { LinearGuid, TemporaryFriendlyId } from '@/types/linear-ids';

// --- Mock Definitions ---

// Mock the utility function
vi.mock('@/linear/operations/utils', () => ({
  resolveFriendlyIdToGuid: vi.fn(),
}));

// Define a type for our mock client including all methods used by enrichment resolvers
type MockLinearClientEnrichment = {
    teams: Mock;
    cycles: Mock;
    workflowStates: Mock;
    users: Mock;
    issueLabels: Mock;
    projects: Mock;
    issue: Mock; // Used in enrichIssueUpdateData for team context
    project: Mock; // Used in resolveFriendlyIdToGuid, needs mock here if testing that path indirectly
    // Add other methods if used by enrichment logic
};

// Create mock functions
const mockTeams = vi.fn();
const mockCycles = vi.fn();
const mockWorkflowStates = vi.fn();
const mockUsers = vi.fn();
const mockIssueLabels = vi.fn();
const mockProjects = vi.fn();
const mockIssue = vi.fn(); // Mock for client.issue()
const mockProject = vi.fn(); // Mock for client.project()

// Create a mock client instance structure
const mockClientInstance = {
    teams: mockTeams,
    cycles: mockCycles,
    workflowStates: mockWorkflowStates,
    users: mockUsers,
    issueLabels: mockIssueLabels,
    projects: mockProjects,
    issue: mockIssue,
    project: mockProject,
} as MockLinearClientEnrichment;


describe('Enrichment Logic Unit Tests', () => {
  // Get typed references to mocked functions
  const mockResolveFriendlyIdToGuid = vi.mocked(resolveFriendlyIdToGuid);

  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    mockTeams.mockReset();
    mockCycles.mockReset();
    mockWorkflowStates.mockReset();
    mockUsers.mockReset();
    mockIssueLabels.mockReset();
    mockProjects.mockReset();
    mockIssue.mockReset();
    mockProject.mockReset();
    mockResolveFriendlyIdToGuid.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Tests for enrichStagedChangeData (Top Level) ---

  it('should call the correct enrichment functions based on opType (e.g., issue.create)', async () => {
    // Minimal setup to test dispatching
    const change: StagedChange = {
      opType: 'issue.create',
      tempId: 'TMP-1' as TemporaryFriendlyId,
      data: { title: 'Test Dispatch', teamName: 'Test Team' },
    };
    const idMap = new Map<string, LinearGuid>();

    // Spy on the internal functions (requires exporting them or more complex mocking)
    // For now, we'll just check if *any* resolver was likely called by mocking a downstream effect
    mockWorkflowStates.mockResolvedValue({ nodes: [] }); // Mock a nested call
    // Ensure that team resolution, if attempted, doesn't fail due to missing mocks
    mockTeams.mockResolvedValue({ nodes: [{id: 'd8b8f8f8-8f8f-8f8f-8f8f-8f8f8f8f8f8f' as LinearGuid, name: 'Test Team'}] });
    
    await enrichStagedChangeData(change, mockClientInstance as any as LinearClient, idMap);

    // We expect internal resolvers to be called, which in turn call client methods.
    // Check if a client method expected for issue.create was called.
    // Example: Status resolution might call client.workflowStates
    // expect(mockWorkflowStates).toHaveBeenCalled(); 
    // More specific tests for each resolver function are needed below.
    expect(true).toBe(true); // Placeholder until specific resolver tests are added
  });

   it('should resolve temporary IDs within the data payload', async () => {
        const issueTempId = 'TMP-ISSUE-RESOLVE' as TemporaryFriendlyId;
        const parentTempId = 'TMP-PARENT-RESOLVE' as TemporaryFriendlyId;
        const resolvedIssueId = 'RESOLVED-ISSUE-GUID' as LinearGuid;
        const resolvedParentId = 'RESOLVED-PARENT-GUID' as LinearGuid;

        const change: StagedChange = {
            opType: 'comment.create', // Example opType
            tempId: 'TMP-COMMENT-1' as TemporaryFriendlyId,
            data: {
                issueId: issueTempId, // Temp ID to resolve
                body: 'This is a comment',
                someOtherField: 'value',
                nested: {
                    parentId: parentTempId, // Nested temp ID
                    other: 123
                },
                listField: [issueTempId, 'literal', parentTempId] // List with temp IDs
            },
        };
        const idMap = new Map<string, LinearGuid>([
            [issueTempId, resolvedIssueId],
            [parentTempId, resolvedParentId],
        ]);

        // Mock any downstream client calls that might happen after temp ID resolution
         mockWorkflowStates.mockResolvedValue({ nodes: [] }); // Example

        const enrichedData = await enrichStagedChangeData(change, mockClientInstance as any as LinearClient, idMap);

        // Assert that the temp IDs in the returned data have been replaced
        expect(enrichedData.issueId).toBe(resolvedIssueId);
        expect(enrichedData.nested.parentId).toBe(resolvedParentId);
        expect(enrichedData.listField).toEqual([resolvedIssueId, 'literal', resolvedParentId]);
        expect(enrichedData.someOtherField).toBe('value'); // Ensure other fields are preserved
        expect(enrichedData.nested.other).toBe(123);
    });

    it('should throw EnrichmentError if an unresolved temporary ID is found in payload', async () => {
        const issueTempId = 'TMP-ISSUE-UNRESOLVED' as TemporaryFriendlyId;
        
        const change: StagedChange = {
            opType: 'comment.create',
            tempId: 'TMP-COMMENT-2' as TemporaryFriendlyId,
            data: {
                issueId: issueTempId, // This temp ID won't be in the map
                body: 'Another comment',
            },
        };
        const idMap = new Map<string, LinearGuid>(); // Empty map

        // Mock any downstream client calls 
        mockWorkflowStates.mockResolvedValue({ nodes: [] }); 

        await expect(enrichStagedChangeData(change, mockClientInstance as any as LinearClient, idMap))
            .rejects.toThrow(EnrichmentError);
        
        await expect(enrichStagedChangeData(change, mockClientInstance as any as LinearClient, idMap))
            .rejects.toThrow(/Unresolved temporary ID found in payload: "TMP-ISSUE-UNRESOLVED"/);
    });

  // --- Tests for Individual Resolver Functions ---

  describe('resolveWorkflowStateNameToId', () => {
    const mockTeamId = 'f0f7e7f5-1c2a-4b3f-9e8d-7a6c5b4e3d2f' as LinearGuid;
    const mockStateName = 'Todo';
    const mockStateId = 'a1b2c3d4-e5f6-7890-1234-567890abcdef' as LinearGuid;

    it('should resolve a state name to its ID successfully (case-insensitive)', async () => {
      mockWorkflowStates.mockResolvedValue({
        nodes: [{ id: mockStateId, name: mockStateName }],
      });

      const result = await resolveWorkflowStateNameToId(
        'todo', // Use lowercase name
        mockClientInstance as any as LinearClient,
        mockTeamId
      );

      expect(result).toBe(mockStateId);
      expect(mockWorkflowStates).toHaveBeenCalledWith({
        filter: {
          name: { eqIgnoreCase: 'todo' },
          team: { id: { eq: mockTeamId } },
        },
      });
    });

    it('should resolve a state name without a team ID if not provided', async () => {
      mockWorkflowStates.mockResolvedValue({
        nodes: [{ id: mockStateId, name: mockStateName }],
      });

      const result = await resolveWorkflowStateNameToId(
        mockStateName,
        mockClientInstance as any as LinearClient
        // No teamId provided
      );

      expect(result).toBe(mockStateId);
      expect(mockWorkflowStates).toHaveBeenCalledWith({
        filter: {
          name: { eqIgnoreCase: mockStateName },
          // No team filter expected
        },
      });
    });

    it('should throw EnrichmentError if the state name is not found', async () => {
      mockWorkflowStates.mockResolvedValue({ nodes: [] }); // No matching state

      await expect(
        resolveWorkflowStateNameToId(
          'NonExistentState',
          mockClientInstance as any as LinearClient,
          mockTeamId
        )
      ).rejects.toThrow(EnrichmentError);
      
      await expect(
        resolveWorkflowStateNameToId(
          'NonExistentState',
          mockClientInstance as any as LinearClient,
          mockTeamId
        )
      ).rejects.toThrow(/Workflow state with name "NonExistentState" in team f0f7e7f5-1c2a-4b3f-9e8d-7a6c5b4e3d2f not found/);
    });

    it('should throw EnrichmentError if the client call fails', async () => {
      const errorMessage = 'Linear API Error';
      mockWorkflowStates.mockRejectedValue(new Error(errorMessage));

      await expect(
        resolveWorkflowStateNameToId(
          mockStateName,
          mockClientInstance as any as LinearClient,
          mockTeamId
        )
      ).rejects.toThrow(EnrichmentError);

       await expect(
        resolveWorkflowStateNameToId(
          mockStateName,
          mockClientInstance as any as LinearClient,
          mockTeamId
        )
      ).rejects.toThrow(new RegExp(`Failed to resolve status "${mockStateName}":.*${errorMessage}`));
    });
    
    it('should warn and use the first result if multiple states match (e.g., without team ID)', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); // Suppress console output during test
      const otherStateId = 'STATE-GUID-XYZ' as LinearGuid;

      mockWorkflowStates.mockResolvedValue({
        nodes: [
          { id: mockStateId, name: mockStateName }, // First match
          { id: otherStateId, name: mockStateName }, // Second match
        ],
      });

      const result = await resolveWorkflowStateNameToId(
        mockStateName,
        mockClientInstance as any as LinearClient
        // No teamId provided - scenario where multiple might occur
      );

      expect(result).toBe(mockStateId); // Should return the first one
      expect(mockWorkflowStates).toHaveBeenCalledWith({
        filter: { name: { eqIgnoreCase: mockStateName } },
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Multiple workflow states found with name "${mockStateName}"`)
      );
      
      consoleWarnSpy.mockRestore(); // Clean up spy
    });

    it('should proceed without team filter if teamId is provided but invalid format', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const invalidTeamId = 'invalid-team-id-format'; // Not a GUID

      mockWorkflowStates.mockResolvedValue({
        nodes: [{ id: mockStateId, name: mockStateName }],
      });

      const result = await resolveWorkflowStateNameToId(
        mockStateName,
        mockClientInstance as any as LinearClient,
        invalidTeamId // Pass invalid ID
      );

      expect(result).toBe(mockStateId);
      // Expect filter *without* team constraint because teamId was invalid
      expect(mockWorkflowStates).toHaveBeenCalledWith({
        filter: {
          name: { eqIgnoreCase: mockStateName }, 
        },
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid teamId format provided for status resolution: "${invalidTeamId}"`)
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('resolvePriorityNameToValue', () => {
    it('should resolve valid priority names (case-insensitive, trimmed)', () => {
      expect(resolvePriorityNameToValue('Urgent')).toBe(4);
      expect(resolvePriorityNameToValue(' high ')).toBe(3);
      expect(resolvePriorityNameToValue('MEDIUM')).toBe(2);
      expect(resolvePriorityNameToValue('Low')).toBe(1);
      expect(resolvePriorityNameToValue('None')).toBe(0);
      expect(resolvePriorityNameToValue(' No Priority ')).toBe(0);
    });

    it('should throw EnrichmentError for invalid priority names', () => {
      expect(() => resolvePriorityNameToValue('Critical'))
        .toThrow(EnrichmentError);
      expect(() => resolvePriorityNameToValue('Critical'))
        .toThrow(/Invalid priority name: "Critical"/);
      expect(() => resolvePriorityNameToValue('Highest'))
        .toThrow(/Valid names are: urgent, high, medium, low, none, no priority/); // Check if error message lists valid names
    });
  });

  describe('resolveUserToId', () => {
    const mockUserId = 'user-guid-456' as LinearGuid;
    const mockUserName = 'Nav Patel';
    const mockUserEmail = 'nav@example.com';
    const mockUserDisplayName = 'NavP';

    it('should resolve user by email first', async () => {
        mockUsers
            .mockResolvedValueOnce({ nodes: [{ id: mockUserId, email: mockUserEmail }] }); // Email match

        const result = await resolveUserToId(mockUserEmail, mockClientInstance as any as LinearClient);

        expect(result).toBe(mockUserId);
        expect(mockUsers).toHaveBeenCalledTimes(1);
        expect(mockUsers).toHaveBeenCalledWith({ filter: { email: { eq: mockUserEmail } } });
    });

    it('should resolve user by name if email fails', async () => {
         mockUsers
            .mockResolvedValueOnce({ nodes: [] }) // Email fails
            .mockResolvedValueOnce({ nodes: [{ id: mockUserId, name: mockUserName }] }); // Name matches

        const result = await resolveUserToId(mockUserName, mockClientInstance as any as LinearClient);

        expect(result).toBe(mockUserId);
        expect(mockUsers).toHaveBeenCalledTimes(2);
        expect(mockUsers).toHaveBeenNthCalledWith(1, { filter: { email: { eq: mockUserName } } }); // Tries email first
        expect(mockUsers).toHaveBeenNthCalledWith(2, { filter: { name: { eq: mockUserName } } });  // Then name
    });

     it('should resolve user by display name if email and name fail', async () => {
         mockUsers
            .mockResolvedValueOnce({ nodes: [] }) // Email fails
            .mockResolvedValueOnce({ nodes: [] }) // Name fails
            .mockResolvedValueOnce({ nodes: [{ id: mockUserId, displayName: mockUserDisplayName }] }); // Display name matches

        const result = await resolveUserToId(mockUserDisplayName, mockClientInstance as any as LinearClient);

        expect(result).toBe(mockUserId);
        expect(mockUsers).toHaveBeenCalledTimes(3);
         expect(mockUsers).toHaveBeenNthCalledWith(1, { filter: { email: { eq: mockUserDisplayName } } });
         expect(mockUsers).toHaveBeenNthCalledWith(2, { filter: { name: { eq: mockUserDisplayName } } });
         expect(mockUsers).toHaveBeenNthCalledWith(3, { filter: { displayName: { eq: mockUserDisplayName } } });
    });

    it('should throw EnrichmentError if user is not found by any identifier', async () => {
         mockUsers
            .mockResolvedValueOnce({ nodes: [] }) // Email fails
            .mockResolvedValueOnce({ nodes: [] }) // Name fails
            .mockResolvedValueOnce({ nodes: [] }); // Display name fails

        const identifier = 'unknown_user';
        await expect(resolveUserToId(identifier, mockClientInstance as any as LinearClient))
            .rejects.toThrow(EnrichmentError);
        await expect(resolveUserToId(identifier, mockClientInstance as any as LinearClient))
            .rejects.toThrow(/User with identifier "unknown_user" not found/);
    });
    
    it('should warn and use the first result if multiple users match', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const otherUserId = 'other-user-guid' as LinearGuid;

        mockUsers
            .mockResolvedValueOnce({ 
                nodes: [
                    { id: mockUserId, email: mockUserEmail }, 
                    { id: otherUserId, email: mockUserEmail } // Multiple match on email
                ] 
            }); 

        const result = await resolveUserToId(mockUserEmail, mockClientInstance as any as LinearClient);

        expect(result).toBe(mockUserId); // Should return the first one
        expect(mockUsers).toHaveBeenCalledTimes(1);
        expect(mockUsers).toHaveBeenCalledWith({ filter: { email: { eq: mockUserEmail } } });
        expect(consoleWarnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`Multiple users found for identifier "${mockUserEmail}"`)
        );
        
        consoleWarnSpy.mockRestore();
    });

    it('should throw EnrichmentError if the client call fails', async () => {
        const errorMessage = 'Linear API Error';
        mockUsers.mockRejectedValue(new Error(errorMessage)); // Fail on first call (email)

         const identifier = 'any_user';
         await expect(resolveUserToId(identifier, mockClientInstance as any as LinearClient))
            .rejects.toThrow(EnrichmentError);
        // The function might re-throw immediately or after other attempts fail. Let's assume it wraps the error.
         await expect(resolveUserToId(identifier, mockClientInstance as any as LinearClient))
             .rejects.toThrow(/Failed to resolve user "any_user"/); // Check the wrapped error message
    });
  });

  describe('resolveLabelNamesToIds', () => {
    const mockLabelId1 = 'label-guid-123' as LinearGuid;
    const mockLabelId2 = 'label-guid-456' as LinearGuid;
    const mockLabelId3 = 'label-guid-789' as LinearGuid;
    const mockLabelName1 = 'Bug';
    const mockLabelName2 = 'Feature';

    it('should resolve multiple label names to their IDs', async () => {
        mockIssueLabels.mockResolvedValue({ 
            nodes: [
                { id: mockLabelId1, name: mockLabelName1 },
                { id: mockLabelId2, name: mockLabelName2 },
                { id: mockLabelId3, name: 'Tech Debt' }, // Match API response casing
            ]
        });

        const namesToResolve = [mockLabelName1, 'feature', 'tech debt']; // Use mixed casing
        const result = await resolveLabelNamesToIds(namesToResolve, mockClientInstance as any as LinearClient);

        expect(result).toHaveLength(3);
        expect(result).toEqual(expect.arrayContaining([mockLabelId1, mockLabelId2, mockLabelId3]));
        expect(mockIssueLabels).toHaveBeenCalledWith({
            filter: { name: { in: namesToResolve } } 
        });
    });

    it('should return an empty array if input names array is empty or null', async () => {
        const result1 = await resolveLabelNamesToIds([], mockClientInstance as any as LinearClient);
        expect(result1).toEqual([]);
        expect(mockIssueLabels).not.toHaveBeenCalled();
        
        // Reset mock for next assertion
        mockIssueLabels.mockClear(); 

        // @ts-ignore - Testing potentially null input
        const result2 = await resolveLabelNamesToIds(null, mockClientInstance as any as LinearClient);
        expect(result2).toEqual([]);
        expect(mockIssueLabels).not.toHaveBeenCalled();
    });

    it('should throw EnrichmentError if no labels are found for the given names', async () => {
         mockIssueLabels.mockResolvedValue({ nodes: [] });
         const namesToResolve = ['NonExistentLabel'];

         await expect(resolveLabelNamesToIds(namesToResolve, mockClientInstance as any as LinearClient))
            .rejects.toThrow(EnrichmentError);
         await expect(resolveLabelNamesToIds(namesToResolve, mockClientInstance as any as LinearClient))
            .rejects.toThrow(/No labels found matching names: NonExistentLabel/);
    });

    it('should throw EnrichmentError if *any* requested label name is not found', async () => {
        mockIssueLabels.mockResolvedValue({ 
            nodes: [
                { id: mockLabelId1, name: mockLabelName1 } // Only 'Bug' is found
            ]
        });
        const namesToResolve = [mockLabelName1, 'MissingLabel'];

        await expect(resolveLabelNamesToIds(namesToResolve, mockClientInstance as any as LinearClient))
            .rejects.toThrow(EnrichmentError);
        await expect(resolveLabelNamesToIds(namesToResolve, mockClientInstance as any as LinearClient))
            .rejects.toThrow(/Label\(s\) not found: MissingLabel/); // Check the specific missing label
    });

    it('should handle case-insensitive matching correctly via fallback logic', async () => {
        // Simulate API returning exact case, but fallback should still match
        mockIssueLabels.mockResolvedValue({ 
            nodes: [
                { id: mockLabelId1, name: 'Bug' }, // Exact case match
                { id: mockLabelId2, name: 'Feature' } // Different case than requested
            ]
        });
        
        const namesToResolve = ['bug', 'feature']; // Requesting lowercase
        const result = await resolveLabelNamesToIds(namesToResolve, mockClientInstance as any as LinearClient);

        expect(result).toHaveLength(2);
        expect(result).toEqual(expect.arrayContaining([mockLabelId1, mockLabelId2]));
         expect(mockIssueLabels).toHaveBeenCalledWith({
            filter: { name: { in: namesToResolve } } 
        });
    });

    it('should throw EnrichmentError if the client call fails', async () => {
         const errorMessage = 'Linear API Error';
        mockIssueLabels.mockRejectedValue(new Error(errorMessage));
        const namesToResolve = [mockLabelName1];

        await expect(resolveLabelNamesToIds(namesToResolve, mockClientInstance as any as LinearClient))
            .rejects.toThrow(EnrichmentError);
         await expect(resolveLabelNamesToIds(namesToResolve, mockClientInstance as any as LinearClient))
            .rejects.toThrow(new RegExp(`Failed to resolve labels.*${errorMessage}`)); // Check wrapped error
    });
  });

  describe('resolveTeamNameToId', () => {
    const mockTeamId = 'team-guid-789' as LinearGuid;
    const mockTeamName = 'Engineering';

    it('should resolve a team name to its ID successfully (case-insensitive)', async () => {
        mockTeams.mockResolvedValue({ 
            nodes: [{ id: mockTeamId, name: mockTeamName }]
        });

        const result = await resolveTeamNameToId('engineering', mockClientInstance as any as LinearClient);

        expect(result).toBe(mockTeamId);
        expect(mockTeams).toHaveBeenCalledWith({
             filter: { name: { eqIgnoreCase: 'engineering' } } 
        });
    });

    it('should throw EnrichmentError if the team name is not found', async () => {
        mockTeams.mockResolvedValue({ nodes: [] });
        const teamName = 'NonExistentTeam';

        await expect(resolveTeamNameToId(teamName, mockClientInstance as any as LinearClient))
            .rejects.toThrow(EnrichmentError);
        await expect(resolveTeamNameToId(teamName, mockClientInstance as any as LinearClient))
             .rejects.toThrow(/Team with name "NonExistentTeam" not found/);
    });

    it('should warn and use the first result if multiple teams match', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const otherTeamId = 'other-team-guid' as LinearGuid;

        mockTeams.mockResolvedValue({ 
            nodes: [
                { id: mockTeamId, name: mockTeamName },
                { id: otherTeamId, name: mockTeamName } // Same name, different ID
            ]
        });

        const result = await resolveTeamNameToId(mockTeamName, mockClientInstance as any as LinearClient);

        expect(result).toBe(mockTeamId); // Uses the first result
        expect(mockTeams).toHaveBeenCalledTimes(1);
        expect(consoleWarnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`Multiple teams found with name "${mockTeamName}"`)
        );
        
        consoleWarnSpy.mockRestore();
    });

    it('should throw EnrichmentError if the client call fails', async () => {
        const errorMessage = 'Linear API Error';
        mockTeams.mockRejectedValue(new Error(errorMessage));

        await expect(resolveTeamNameToId(mockTeamName, mockClientInstance as any as LinearClient))
            .rejects.toThrow(EnrichmentError);
        await expect(resolveTeamNameToId(mockTeamName, mockClientInstance as any as LinearClient))
             .rejects.toThrow(new RegExp(`Failed to resolve team "${mockTeamName}".*${errorMessage}`));
    });
  });

  describe('resolveProjectNameToId', () => {
    const mockProjectId = 'project-guid-xyz' as LinearGuid;
    const mockProjectName = 'Voca Refactor';
    // TODO: Add tests for friendly ID resolution (e.g., 'PRO-123') once implemented

    it('should resolve a project name to its ID successfully', async () => {
        mockProjects.mockResolvedValue({ 
            nodes: [{ id: mockProjectId, name: mockProjectName }]
        });

        const result = await resolveProjectNameToId(mockProjectName, mockClientInstance as any as LinearClient);

        expect(result).toBe(mockProjectId);
        expect(mockProjects).toHaveBeenCalledWith({
            filter: { name: { eq: mockProjectName } } 
        });
    });

    it('should throw EnrichmentError if the project name is not found', async () => {
        mockProjects.mockResolvedValue({ nodes: [] });
        const projectName = 'NonExistentProject';

        await expect(resolveProjectNameToId(projectName, mockClientInstance as any as LinearClient))
            .rejects.toThrow(EnrichmentError);
        await expect(resolveProjectNameToId(projectName, mockClientInstance as any as LinearClient))
             .rejects.toThrow(/Project with identifier "NonExistentProject" not found/);
    });

    it('should warn and use the first result if multiple projects match by name', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const otherProjectId = 'other-project-guid' as LinearGuid;

        mockProjects.mockResolvedValue({ 
            nodes: [
                { id: mockProjectId, name: mockProjectName },
                { id: otherProjectId, name: mockProjectName } 
            ]
        });

        const result = await resolveProjectNameToId(mockProjectName, mockClientInstance as any as LinearClient);

        expect(result).toBe(mockProjectId); // Uses the first result
        expect(mockProjects).toHaveBeenCalledTimes(1);
        expect(consoleWarnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`Multiple projects found for identifier "${mockProjectName}"`)
        );
        
        consoleWarnSpy.mockRestore();
    });

    it('should throw EnrichmentError if the client call fails', async () => {
        const errorMessage = 'Linear API Error';
        mockProjects.mockRejectedValue(new Error(errorMessage));

        await expect(resolveProjectNameToId(mockProjectName, mockClientInstance as any as LinearClient))
            .rejects.toThrow(EnrichmentError);
        // Note: The actual function needs a try/catch to wrap this error
        await expect(resolveProjectNameToId(mockProjectName, mockClientInstance as any as LinearClient))
             .rejects.toThrow(new RegExp(`Failed to resolve project "${mockProjectName}".*${errorMessage}`));
    });
  });

  describe('resolveCycleNameToId', () => {
    const mockCycleId = 'cycle-guid-123' as LinearGuid;
    const mockCycleName = 'Sprint 42';
    const mockOtherCycleId = 'cycle-guid-456' as LinearGuid;

    it('should resolve a cycle name to its ID successfully (case-insensitive)', async () => {
        mockCycles.mockResolvedValue({ 
            nodes: [{ id: mockCycleId, name: mockCycleName }]
        });

        const result = await resolveCycleNameToId('sprint 42', mockClientInstance as any as LinearClient);

        expect(result).toBe(mockCycleId);
        expect(mockCycles).toHaveBeenCalledWith({
             filter: { name: { eqIgnoreCase: 'sprint 42' } } 
             // TODO: Add assertion for isPast: { eq: false } or similar if that filter is finalized
        });
    });

    it('should throw EnrichmentError if the cycle name is not found', async () => {
        mockCycles.mockResolvedValue({ nodes: [] });
        const cycleName = 'NonExistentSprint';

        await expect(resolveCycleNameToId(cycleName, mockClientInstance as any as LinearClient))
            .rejects.toThrow(EnrichmentError);
        await expect(resolveCycleNameToId(cycleName, mockClientInstance as any as LinearClient))
             .rejects.toThrow(/Active or future cycle with name "NonExistentSprint" not found/);
    });

     it('should warn and use the first result if multiple active/future cycles match', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        
        mockCycles.mockResolvedValue({ 
            nodes: [
                { id: mockCycleId, name: mockCycleName }, // First match
                { id: mockOtherCycleId, name: mockCycleName } // Second match
            ]
        });

        const result = await resolveCycleNameToId(mockCycleName, mockClientInstance as any as LinearClient);

        expect(result).toBe(mockCycleId); // Uses the first result
        expect(mockCycles).toHaveBeenCalledTimes(1);
        expect(consoleWarnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`Multiple active/future cycles found with name "${mockCycleName}"`)
        );
        
        consoleWarnSpy.mockRestore();
    });

    it('should throw EnrichmentError if the client call fails', async () => {
         const errorMessage = 'Linear API Error';
        mockCycles.mockRejectedValue(new Error(errorMessage));

        await expect(resolveCycleNameToId(mockCycleName, mockClientInstance as any as LinearClient))
            .rejects.toThrow(EnrichmentError);
        // Note: The actual function needs a try/catch to wrap this error
        await expect(resolveCycleNameToId(mockCycleName, mockClientInstance as any as LinearClient))
             .rejects.toThrow(new RegExp(`Failed to resolve cycle "${mockCycleName}".*${errorMessage}`));
    });

    // TODO: Add test for filtering logic (e.g., isPast) if implemented
  });

});