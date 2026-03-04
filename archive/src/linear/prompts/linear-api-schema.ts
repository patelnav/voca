/**
 * Linear API schema information for LLM context
 */
export const LINEAR_API_SCHEMA = `
Linear API Key Entities and Operations:

1. Project:
   - id: String
   - name: String
   - description: String
   - issues: [Issue]
   Mutations:
   - projectCreate(name: String!, description: String)
   - projectUpdate(id: String!, name: String, description: String)
   - projectArchive(id: String!)
   - projectDelete(id: String!)

2. Issue:
   - id: String
   - title: String
   - description: String
   - state: State
   - priority: Int (1-4, where 1 is highest)
   - parent: Issue
   - children: [Issue]
   - assignee: User
   - labels: [Label]
   - estimate: Float
   - dueDate: String
   Mutations:
   - issueCreate(teamId: String!, title: String!, description: String, projectId: String)
   - issueUpdate(id: String!, title: String, description: String)
   - issueArchive(id: String!)
   - issueDelete(id: String!)
   - issueStateUpdate(id: String!, stateId: String!)
   - issuePriorityUpdate(id: String!, priority: Int!)
   - issueAssigneeUpdate(id: String!, assigneeId: String)
   - issueLabelUpdate(id: String!, labelIds: [String!])
   - issueEstimateUpdate(id: String!, estimate: Float)
   - issueDueDateUpdate(id: String!, dueDate: String)
   - issueParentUpdate(id: String!, parentId: String)

3. State:
   - id: String
   - name: String
   - type: String (backlog, unstarted, started, completed, canceled)
   Mutations:
   - workflowStateCreate(name: String!, type: String!, teamId: String!)
   - workflowStateUpdate(id: String!, name: String, type: String)
   - workflowStateArchive(id: String!)

4. Label:
   - id: String
   - name: String
   - color: String
   Mutations:
   - labelCreate(name: String!, color: String, teamId: String!)
   - labelUpdate(id: String!, name: String, color: String)
   - labelDelete(id: String!)

5. Comment:
   - id: String
   - body: String
   - issueId: String
   Mutations:
   - commentCreate(body: String!, issueId: String!)
   - commentUpdate(id: String!, body: String!)
   - commentDelete(id: String!)
`; 