import { type LinearClient } from '@linear/sdk';
import { createIssue } from '@/linear/issues';
import { 
  type IssueCreatePayload, 
  type IssueUpdatePayload, 
  type IssueDeletePayload, 
  type EntityOperation 
} from './types';
import { resolveFriendlyIdToGuid } from './utils';

export const issueOperations: Record<string, EntityOperation<any>> = {
  create: {
    execute: async (client: LinearClient, payload: IssueCreatePayload) => {
      // Resolve projectId if it's a friendly ID or raw string
      const resolvedProjectId = await resolveFriendlyIdToGuid(client, payload.projectId, 'project');
      
      // Define the type explicitly based on createIssue options
      type CreateIssueOptions = {
        description?: string;
        parentId?: string;
        stateId?: string;
        priority?: number;
        labelIds?: string[];
        assigneeId?: string;
        dueDate?: string;
      };
      
      const createPayload: CreateIssueOptions = {}; 
      if (payload.description) createPayload.description = payload.description;
      if (payload.parentId) createPayload.parentId = await resolveFriendlyIdToGuid(client, payload.parentId, 'issue') as string;
      if (payload.stateId) createPayload.stateId = payload.stateId as string;
      if (payload.priority !== undefined) createPayload.priority = payload.priority as number;
      if (payload.labelIds) createPayload.labelIds = payload.labelIds;
      if (payload.assigneeId) createPayload.assigneeId = payload.assigneeId;
      if (payload.dueDate) createPayload.dueDate = payload.dueDate;

      return await createIssue(
        client, 
        resolvedProjectId, 
        payload.title,
        createPayload // Pass the object with optional fields
      );
    },
    description: (payload: IssueCreatePayload) => `Create issue: "${payload.title}" in project ${payload.projectId}`,
  },
  update: {
    execute: async (client: LinearClient, payload: IssueUpdatePayload) => {
      const issueGuid = await resolveFriendlyIdToGuid(client, payload.id, 'issue');
      
      try {
        const issue = await client.issue(issueGuid);
        if (!issue) {
          throw new Error(`Issue with ID ${issueGuid} not found`);
        }
        
        // Create a new payload object explicitly excluding the id field
        const updateData: Partial<IssueUpdatePayload> = {};
        for (const key in payload) {
            if (key !== 'id' && Object.prototype.hasOwnProperty.call(payload, key)) {
                 // Type assertion needed as key is string, but payload index signature expects specific keys
                (updateData as any)[key] = (payload as any)[key];
            }
        }

        // Resolve parentId if it's provided and is a friendly ID
        if (updateData.parentId) {
          // Resolve potential friendly ID to GUID for the API call
          updateData.parentId = await resolveFriendlyIdToGuid(client, updateData.parentId, 'issue') as string;
        }
        
        // TODO: Resolve other potential IDs like assigneeId, labelIds if needed

        // Call the original SDK method on the fetched issue instance
        return await issue.update(updateData);

      } catch (error) {
        console.error(`Error updating issue ${issueGuid}:`, error);
        throw error;
      }
    },
    description: (payload: IssueUpdatePayload) => `Update issue: ${payload.id}${payload.title ? ` with title "${payload.title}"` : ''}`,
  },
  delete: {
    execute: async (client: LinearClient, payload: IssueDeletePayload) => {
      const issueGuid = await resolveFriendlyIdToGuid(client, payload.id, 'issue');
      
      try {
        const issue = await client.issue(issueGuid);
        if (!issue) {
          throw new Error(`Issue with ID ${issueGuid} not found`);
        }
        // Linear doesn't support true deletion, so we archive the issue instead
        return await issue.archive();
      } catch (error) {
        console.error(`Error archiving issue ${issueGuid}:`, error);
        throw error;
      }
    },
    description: (payload: IssueDeletePayload) => `Delete (archive) issue ${payload.id}`,
  },
}; 