import { type LinearClient } from '@linear/sdk';
import { createProject, archiveProject } from '@/linear/projects';
import { 
  type ProjectCreatePayload, 
  type ProjectArchivePayload, 
  type EntityOperation 
} from './types';
// Although not used here yet, keep for consistency
import { asLinearFriendlyId } from '@/types/linear-ids';

export const projectOperations: Record<string, EntityOperation<any>> = {
  create: {
    execute: async (client: LinearClient, payload: ProjectCreatePayload) => {
      return await createProject(client, payload.name, payload.description || '');
    },
    description: (payload: ProjectCreatePayload) => `Create project: "${payload.name}"`,
  },
  archive: {
    execute: async (client: LinearClient, payload: ProjectArchivePayload) => {
      // Assuming projectId in payload is always a friendly ID for archiveProject
      // If it could be a GUID, we'd need resolveFriendlyIdToGuid here.
      const friendlyId = asLinearFriendlyId(payload.projectId);
      return await archiveProject(
        client, 
        friendlyId,
        payload.archiveIssues || false
      );
    },
    description: (payload: ProjectArchivePayload) => `Archive project with ID: ${payload.projectId}`,
  },
}; 