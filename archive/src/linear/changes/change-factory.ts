import { v4 as uuidv4 } from 'uuid';
import {
    hasOperation,
    getOperationDescription
} from '@/linear/operations';
import type {
    LinearFriendlyId,
    LinearGuid,
    TemporaryFriendlyId
} from '@/types/linear-ids';
import { asTemporaryFriendlyId } from '@/types/linear-ids';
import type {
    LinearEntityType,
    LinearChangeOperation,
    StagedChange,
    TemporaryId
} from './types';
import type { IdRegistry } from './id-registry';
// import { type LinearChange, type LinearChangeAction, type LinearChangePayload } from '@/types/linear'; // Removed problematic import

// Updated path

/**
 * Factory class for creating staged change objects.
 * This encapsulates the logic for generating temporary IDs and structuring change payloads.
 */
export class ChangeFactory {
    // Dependencies injected from LinearChangeManager
    private addChangeFn: (change: StagedChange) => string;
    private idRegistry: IdRegistry;
    private getNextIssueCounter: () => number;
    private getNextProjectCounter: () => number;

    constructor(
        addChangeFn: (change: StagedChange) => string,
        idRegistry: IdRegistry,
        getNextIssueCounter: () => number,
        getNextProjectCounter: () => number
    ) {
        this.addChangeFn = addChangeFn;
        this.idRegistry = idRegistry;
        this.getNextIssueCounter = getNextIssueCounter;
        this.getNextProjectCounter = getNextProjectCounter;
    }

    /**
     * Generic helper to create a change of any type
     * @param entityType The type of entity to create
     * @param operation The operation to perform
     * @param payload The data for the operation
     * @param dependsOn Optional IDs of changes this depends on
     * @returns ID of the added change
     */
    createChange(
        entityType: LinearEntityType,
        operation: LinearChangeOperation,
        payload: any,
        dependsOn?: string[]
    ): string {
        // Validate the operation is supported
        if (!hasOperation(entityType, operation)) {
            throw new Error(`Unsupported operation: ${operation} on ${entityType}`);
        }

        return this.addChangeFn({
            id: uuidv4(),
            operation,
            entityType,
            payload,
            description: getOperationDescription(entityType, operation, payload),
            dependsOn,
        });
    }

    /**
     * Helper to create a new issue change
     * @param projectId Project ID (can be a friendly ID)
     * @param title Issue title
     * @param description Optional issue description
     * @param dependsOnProjectChange Optional project change ID that this issue depends on
     * @returns ID of the added change
     */
    createIssueChange(
        projectId: LinearFriendlyId | TemporaryFriendlyId,
        title: string,
        description?: string,
        dependsOnProjectChange?: string
    ): string {
        // Create a temporary ID for the issue using the counter
        const internalId = asTemporaryFriendlyId(`TMP-${this.getNextIssueCounter()}`);
        
        // Register the internal ID
        this.idRegistry.registerInternalId(internalId);
        
        // Create the dependencies array
        const dependsOn: string[] = [];
        
        if (dependsOnProjectChange) {
            dependsOn.push(dependsOnProjectChange);
        }

        // Create and add the change using the registered internal ID
        return this.addChangeFn({
            id: uuidv4(),
            entityType: 'issue',
            operation: 'create',
            payload: {
                projectId,
                title,
                description,
                internalId // Pass the generated internal ID
            },
            description: `Create issue "${title}" in project ${projectId}`,
            dependsOn
        });
    }

    /**
     * Helper to create a new project change
     * @param name Project name
     * @param description Optional project description
     * @param internalId Optional internal ID to use (will be generated if not provided)
     * @returns ID of the added change
     */
    createProjectChange(
        name: string,
        description?: string,
        internalId?: string // Allow providing an internalId
    ): string {
        // Create or use the provided temporary ID for the project
        const projectInternalId = internalId
            ? asTemporaryFriendlyId(internalId)
            : asTemporaryFriendlyId(`TMP-${this.getNextProjectCounter()}`);
        
        // Register the internal ID
        this.idRegistry.registerProjectInternalId(projectInternalId);
        
        // Create and add the change
        return this.addChangeFn({
            id: uuidv4(),
            entityType: 'project',
            operation: 'create',
            payload: {
                name,
                description,
                internalId: projectInternalId // Use the generated/provided ID
            },
            description: `Create project "${name}"`,
            dependsOn: [] // Project creation usually doesn't depend on others initially
        });
    }

    /**
     * Helper to create a parent-child relationship change
     * @param parentId The ID of the parent issue (can be a real Linear ID or a temporary ID)
     * @param childId The ID of the child issue (can be a real Linear ID or a temporary ID)
     * @returns ID of the added change
     */
    createParentChildChange(parentId: string | LinearGuid | TemporaryId, childId: string | LinearGuid | TemporaryId): string {
        // Validate that both IDs are provided
        if (!parentId) {
            throw new Error('Parent ID is required for createParentChildChange');
        }
        if (!childId) {
            throw new Error('Child ID is required for createParentChildChange');
        }
        
        // Keep track of which IDs are temporary for dependencies
        const dependsOn: string[] = [];
        
        // Check for TMPC- (change reference) format for dependency tracking
        if (typeof parentId === 'string' && parentId.startsWith('TMPC-')) {
            const parentChangeId = parentId.substring(5); // Remove "TMPC-" prefix
            dependsOn.push(parentChangeId);
        }
        // Note: TMP- format dependency tracking is implicitly handled by the applyChanges logic
        
        if (typeof childId === 'string' && childId.startsWith('TMPC-')) {
            const childChangeId = childId.substring(5); // Remove "TMPC-" prefix
            dependsOn.push(childChangeId);
        }
        
        // Use the generic createChange method
        return this.createChange(
            'relationship',
            'link',
            { parentId, childId },
            dependsOn.length > 0 ? dependsOn : undefined
        );
    }

    /**
     * Helper to create multiple parent-child relationships for an issue
     * @param parentIds Array of parent IDs (can be real Linear IDs or temporary IDs)
     * @param childId The ID of the child issue (can be a real Linear ID or a temporary ID)
     * @returns Array of IDs of the added changes
     */
    createMultipleParentChildChanges(parentIds: (string | LinearGuid | TemporaryId)[], childId: string | LinearGuid | TemporaryId): string[] {
        if (!parentIds || parentIds.length === 0) {
            throw new Error('At least one parent ID is required for createMultipleParentChildChanges');
        }
        if (!childId) {
            throw new Error('Child ID is required for createMultipleParentChildChanges');
        }
        
        const changeIds: string[] = [];
        
        // Create a separate relationship change for each parent
        for (const parentId of parentIds) {
            const changeId = this.createParentChildChange(parentId, childId);
            changeIds.push(changeId);
        }
        
        return changeIds;
    }

    /**
     * Helper to create a comment on an issue
     * @param issueId The ID of the issue to comment on (can be real or temporary)
     * @param body The content of the comment in markdown format
     * @returns ID of the added change
     */
    createCommentChange(issueId: string | LinearGuid | TemporaryId, body: string): string {
        // Check if the issue ID is a temporary change reference
        const dependsOn = (typeof issueId === 'string' && issueId.startsWith('TMPC-'))
            ? [issueId.substring(5)]
            : undefined;

        return this.createChange('comment', 'create', { issueId, body }, dependsOn);
    }

    /**
     * Create a task with subtasks
     * @param projectId The project ID to create the tasks in
     * @param parentTitle The title of the parent task
     * @param subtaskTitles Array of subtask titles
     * @param parentDescription Optional description for the parent task
     * @param dependsOnProjectChange Optional ID of a project change this depends on
     * @returns Object containing parent change ID and subtask change IDs
     */
    createTaskWithSubtasks(
        projectId: LinearFriendlyId,
        parentTitle: string,
        subtaskTitles: string[],
        parentDescription?: string,
        dependsOnProjectChange?: string
    ): { parentChangeId: string; subtaskChangeIds: string[] } {
        // Create a temporary ID for the parent task
        const parentInternalId = asTemporaryFriendlyId(`TMP-${this.getNextIssueCounter()}`);
        this.idRegistry.registerInternalId(parentInternalId);
        
        // Create the parent task change
        const parentChangeId = this.createChange(
            'issue',
            'create',
            {
                projectId,
                title: parentTitle,
                description: parentDescription,
                internalId: parentInternalId // Pass the generated internal ID
            },
            dependsOnProjectChange ? [dependsOnProjectChange] : undefined
        );
        
        // Generate a TMPC- reference for the parent change to use in dependencies
        const parentChangeRef = `TMPC-${parentChangeId}`;

        // Create changes for each subtask, depending on the parent task change
        const subtaskChangeIds = subtaskTitles.map(title => {
            const subtaskInternalId = asTemporaryFriendlyId(`TMP-${this.getNextIssueCounter()}`);
            this.idRegistry.registerInternalId(subtaskInternalId);
            
            return this.createChange(
                'issue',
                'create',
                {
                    projectId,
                    title,
                    internalId: subtaskInternalId // Pass the generated internal ID
                },
                [parentChangeId] // Subtask depends on parent task creation
            );
        });

        // Now, create relationship links from subtasks to the parent
        subtaskChangeIds.forEach((subtaskChangeId, _index) => {
            const subtaskChangeRef = `TMPC-${subtaskChangeId}`;
            this.createParentChildChange(parentChangeRef, subtaskChangeRef);
        });
        
        return { parentChangeId, subtaskChangeIds };
    }

    /**
     * Create a project with issues
     * @param projectName The name of the project
     * @param issueTitles Array of issue titles
     * @param projectDescription Optional project description
     * @returns Object containing project change ID and issue change IDs
     */
    createProjectWithIssues(
        projectName: string,
        issueTitles: string[],
        projectDescription?: string
    ): { projectChangeId: string; issueChangeIds: string[] } {
        // Create the project change first, generating an internal ID
        const projectInternalId = asTemporaryFriendlyId(`TMP-${this.getNextProjectCounter()}`);
        const projectChangeId = this.createProjectChange(projectName, projectDescription, projectInternalId);
        
        // Use the *internal* ID for referencing the project in issue creation payloads
        const projectRefId = projectInternalId;

        // Create changes for each issue, depending on the project change
        const issueChangeIds = issueTitles.map(title => 
            this.createIssueChange(
                projectRefId, // Use the *internal* project ID
                title,
                undefined,
                projectChangeId // Issue depends on project creation
            )
        );
        
        return { projectChangeId, issueChangeIds };
    }
} 