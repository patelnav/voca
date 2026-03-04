/// <reference types="vitest" />
import { vi, type Mock } from 'vitest';
import type { LinearClient, Issue, Comment, ArchivePayload, User, Team, Project } from '@linear/sdk';

// Define more specific mock types if needed, e.g., for async getters on payloads
export type MockLinearSdkIssue = Partial<Issue> & { 
    archive?: Mock<[], Promise<Partial<ArchivePayload>>>; 
    comments?: Mock<[], Promise<{ nodes: (Partial<Comment> & { children?: Mock<[], Promise<{ nodes: Partial<Comment>[] }>> })[] }>>;
    children?: Mock<[], Promise<{ nodes: MockLinearSdkIssue[] }>>;
    project?: Mock<[], Promise<Partial<Project> | undefined>>;
    team?: Mock<[], Promise<Partial<Team> | undefined>>;
    assignee?: Mock<[], Promise<Partial<User> | undefined>>;
    subscriber?: Mock<[], Promise<Partial<User> | undefined>>;
    lead?: Mock<[], Promise<Partial<User> | undefined>>;
};
export type MockLinearSdkComment = Partial<Comment> & { 
    archive?: Mock<[], Promise<Partial<ArchivePayload>>>; 
    children?: Mock<[], Promise<{ nodes: MockLinearSdkComment[] }>>;
};
export type MockLinearSdkProject = Partial<Project> & { 
    lead?: Mock<[], Promise<Partial<User> | undefined>>;
};


export interface MockLinearClientInterface extends LinearClient {
    createIssue: Mock;
    updateIssue: Mock;
    deleteIssue: Mock; // Was missing, but opType issue.delete implies it could exist
    issue: Mock<[id: string], Promise<MockLinearSdkIssue | undefined>>;

    createComment: Mock;
    updateComment: Mock;
    deleteComment: Mock;
    comment: Mock<[id: string], Promise<MockLinearSdkComment | undefined>>;

    updateProject: Mock;
    project: Mock<[id: string], Promise<MockLinearSdkProject | undefined>>;

    // Add other commonly used methods as vi.fn()
    teams: Mock;
    users: Mock;
    workflowStates: Mock;
    createIssueRelation: Mock;
    // ... any other methods used across tests
}

export const createMockLinearClient = (): MockLinearClientInterface => ({
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    deleteIssue: vi.fn(),
    issue: vi.fn(),

    createComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    comment: vi.fn(),

    updateProject: vi.fn(),
    project: vi.fn(),

    teams: vi.fn(),
    users: vi.fn(),
    workflowStates: vi.fn(),
    createIssueRelation: vi.fn(),

    // Ensure all methods from LinearClient are technically present, even if just as basic mocks
    // This helps satisfy the LinearClient type if it's strictly checked.
    // Many of these will likely not be called in most unit tests.
    attachmentArchive: vi.fn(),
    attachmentCreate: vi.fn(),
    attachments: vi.fn(),
    attachmentSources: vi.fn(),
    auditEntries: vi.fn(),
    authorizedApplications: vi.fn(),
    billingDetails: vi.fn(),
    cycle: vi.fn(),
    cycles: vi.fn(),
    customView: vi.fn(),
    customViews: vi.fn(),
    deleteCycle: vi.fn(),
    deleteCustomView: vi.fn(),
    deleteDocument: vi.fn(),
    deleteIntegration: vi.fn(),
    deleteIssueLabel: vi.fn(),
    deleteNotification: vi.fn(),
    deleteOrganizationDomain: vi.fn(),
    deleteProjectLink: vi.fn(),
    deleteProjectUpdate: vi.fn(),
    deleteRoadmap: vi.fn(),
    deleteTeam: vi.fn(),
    deleteTeamMembership: vi.fn(),
    deleteWebhook: vi.fn(),
    document: vi.fn(),
    documents: vi.fn(),
    emoji: vi.fn(),
    emojis: vi.fn(),
    favorite: vi.fn(),
    favorites: vi.fn(),
    integration: vi.fn(),
    integrations: vi.fn(),
    integrationResources: vi.fn(),
    issueLabel: vi.fn(),
    issueLabels: vi.fn(),
    issueRelation: vi.fn(),
    issueRelations: vi.fn(),
    issues: vi.fn(),
    issueSearch: vi.fn(),
    notification: vi.fn(),
    notifications: vi.fn(),
    notificationSubscription: vi.fn(),
    notificationSubscriptions: vi.fn(),
    organization: vi.fn(),
    organizationDomainClaim: vi.fn(),
    organizationDomains: vi.fn(),
    organizationExists: vi.fn(),
    organizationInvite: vi.fn(),
    organizationInvites: vi.fn(),
    projectLink: vi.fn(),
    projectLinks: vi.fn(),
    projectMilestone: vi.fn(),
    projectMilestones: vi.fn(),
    projects: vi.fn(),
    projectUpdate: vi.fn(),
    projectUpdates: vi.fn(),
    roadmap: vi.fn(),
    roadmaps: vi.fn(),
    team: vi.fn(),
    teamMemberships: vi.fn(),
    teamKey: vi.fn(),
    teamKeys: vi.fn(),
    user: vi.fn(),
    userSettings: vi.fn(),
    viewer: vi.fn(),
    webhook: vi.fn(),
    webhooks: vi.fn(),
    workflowState: vi.fn(),
    // Need to cast to unknown first then to MockLinearClientInterface to satisfy the type system
    // for potentially unassigned methods from the full LinearClient type.
}) as unknown as MockLinearClientInterface; 