import { type LinearClient } from '@linear/sdk';
import { setParentIssue } from '@/linear/issues'; // Assuming setParentIssue handles the link
import { 
  type RelationshipLinkPayload,
  type EntityOperation 
} from './types';
import { resolveFriendlyIdToGuid } from './utils';

export const relationshipOperations: Record<string, EntityOperation<any>> = {
  link: {
    execute: async (client: LinearClient, payload: RelationshipLinkPayload): Promise<any> => {
      const { parentId: rawParentId, childId: rawChildId } = payload;

      if (!rawParentId || !rawChildId) {
        throw new Error('Both parentId and childId are required for linking issues.');
      }

      // Resolve IDs
      const parentGuid = await resolveFriendlyIdToGuid(client, rawParentId, 'issue');
      const childGuid = await resolveFriendlyIdToGuid(client, rawChildId, 'issue');
      
      // Use setParentIssue to establish the parent-child relationship
      return await setParentIssue(
        client, 
        childGuid,
        parentGuid
      );
    },
    description: (payload: RelationshipLinkPayload) => {
      // Use payload.id as alias for childId if present (for test fixtures)
      const childIdentifier = payload.childId || payload.id;
      return `Link issue ${childIdentifier} as child of ${payload.parentId}`;
    },
  },
  // Placeholder for potential create operation
  // create: {
  //   execute: async (_client: LinearClient, _payload: any) => {
  //     // Implement or import the createRelationship function
  //     throw new Error('Relationship creation not yet implemented');
  //   },
  //   description: (payload: any) => `Create relationship: "${payload.type}" between ${payload.issueId} and ${payload.relatedIssueId}`,
  // },
}; 