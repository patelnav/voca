import { type LinearClient } from '@linear/sdk';

/**
 * Creates a new comment on an issue
 * @param linearClient An initialized Linear client
 * @param issueId The ID of the issue to comment on
 * @param body The content of the comment in markdown format
 * @returns The created comment
 */
export async function createComment(linearClient: LinearClient, issueId: string, body: string) {
  try {
    // Validate the issue exists
    const issue = await linearClient.issue(issueId);
    if (!issue) {
      throw new Error(`Issue with ID ${issueId} not found`);
    }

    // Create the comment
    const response = await linearClient.createComment({
      issueId,
      body,
    });

    if (!response.success) {
      throw new Error('Failed to create comment');
    }

    return response.comment;
  } catch (error) {
    console.error('Error creating comment:', error);
    throw error;
  }
}

/**
 * Fetches comments for a specific issue
 * @param linearClient An initialized Linear client
 * @param issueId The ID of the issue to fetch comments for
 * @returns Array of comments
 */
export async function fetchIssueComments(linearClient: LinearClient, issueId: string) {
  try {
    const commentsQuery = await linearClient.comments({
      filter: {
        issue: { id: { eq: issueId } },
      },
    });

    return commentsQuery.nodes;
  } catch (error) {
    console.error(`Error fetching comments for issue ${issueId}:`, error);
    throw error;
  }
}

/**
 * Updates an existing comment
 * @param linearClient An initialized Linear client
 * @param commentId The ID of the comment to update
 * @param body The new content of the comment
 * @returns The updated comment
 */
export async function updateComment(linearClient: LinearClient, commentId: string, body: string) {
  try {
    // Use the proper comment query instead of direct accessor
    const commentPayload = await linearClient.comment({ id: commentId });
    if (!commentPayload) {
      throw new Error(`Comment with ID ${commentId} not found`);
    }

    // Update the comment
    return await commentPayload.update({ body });
  } catch (error) {
    console.error(`Failed to update comment with ID ${commentId}:`, error);
    throw error;
  }
}
