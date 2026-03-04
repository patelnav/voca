import { type LinearClient } from '@linear/sdk';
import { createComment } from '@/linear/comments';
import { 
  type CommentCreatePayload, 
  type EntityOperation 
} from './types';
import { resolveFriendlyIdToGuid } from './utils';

export const commentOperations: Record<string, EntityOperation<any>> = {
  create: {
    execute: async (client: LinearClient, payload: CommentCreatePayload) => {
      // Resolve issueId if it's a friendly ID or raw string
      const issueGuid = await resolveFriendlyIdToGuid(client, payload.issueId, 'issue');
      return await createComment(
        client, 
        issueGuid, 
        payload.body
      );
    },
    description: (payload: CommentCreatePayload) => `Create comment on issue: ${payload.issueId}`,
  },
}; 