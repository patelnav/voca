import { Tool, FunctionDeclaration as GeminiFunctionDeclaration, Type } from '@google/genai';
import { applyStagedChangesToolSchema } from '../tools/linear_apply'; // Assuming this path is correct relative to new location

// --- Tool Schemas START (Use new Type enum) ---
export const linearSearchToolSchema: GeminiFunctionDeclaration = {
  name: 'linear_search',
  description: 'Searches for Linear issues based on a query string. Can be optionally filtered by the current project focus if set in the agent state.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The search term or query string. Can be a general phrase (e.g., "fix login bug") or include structured filters like title:"<exact phrase>" or project:"<project_id>". Example: "high priority title:\"Urgent Fix\" project:\"project-guid\""',
      },
    },
    required: ['query'],
  },
};

export const linearGetDetailsToolSchema: GeminiFunctionDeclaration = {
  name: 'linear_get_details',
  description: 'Fetches detailed information for a specific Linear entity (Issue or Project) based on its identifier (e.g., "PRO-123" or a project GUID).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      entityId: {
        type: Type.STRING,
        description: 'The identifier of the Linear issue (e.g., "PRO-123") or project (GUID).',
      },
      pre_execution_narration: {
        type: Type.STRING,
        description: "Optional. A short, friendly message (1-2 sentences) to display to the user *before* this tool executes. Example: 'Let me fetch the details for that ticket.'",
      },
      post_execution_acknowledgement: {
        type: Type.STRING,
        description: "Optional. A short, friendly message (1-2 sentences) to display to the user *immediately after* this tool has finished, acknowledging completion. Example: 'Got the details!'",
      },
    },
    required: ['entityId'],
  },
};

export const stageAddToolSchema: GeminiFunctionDeclaration = {
  name: 'stage_add',
  description:
    "Stages a proposed change operation, such as creating a new entity (e.g., an issue) or modifying an existing one. This change is stored for later confirmation and does NOT execute immediately.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      change: {
        type: Type.OBJECT,
        description:
          'The change object to stage. Must include `opType` (e.g., "issue.create"), `data` (the payload). The `tempId` field is ONLY needed for NEW entities (e.g., "TMP-1") if they need to be referenced later, and MUST follow the format TMP-123. DO NOT include tempId for updates to existing entities.',
        properties: {
          opType: { type: Type.STRING, description: "Operation type (e.g., 'issue.create')" },
          data: { type: Type.OBJECT, description: "Payload for the operation" },
          tempId: { type: Type.STRING, description: "Optional temporary ID (e.g., TMP-1) for new entities being staged." },
        },
        required: ['opType', 'data']
      },
      pre_execution_narration: {
        type: Type.STRING,
        description: "Optional. A short, friendly message (1-2 sentences) to display to the user *before* this tool executes. Example: 'Okay, I'll get that change staged for you.'",
      },
      post_execution_acknowledgement: {
        type: Type.STRING,
        description: "Optional. A short, friendly message (1-2 sentences) to display to the user *immediately after* this tool has finished staging, acknowledging completion. Example: 'Alright, that's staged!'",
      },
    },
    required: ['change'],
  },
};

export const stageListToolSchema: GeminiFunctionDeclaration = {
  name: 'stage_list',
  description:
    "Lists all changes currently staged by the agent and awaiting confirmation.",
  parameters: { 
    type: Type.OBJECT,
    properties: {},
  },
};

export const stageRemoveToolSchema: GeminiFunctionDeclaration = {
  name: 'stage_remove',
  description:
    "Removes a previously staged change from the agent's state using its temporary ID (tempId). Used if the user decides not to proceed with a specific staged change.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      tempId: {
        type: Type.STRING,
        description:
          'The temporary ID (e.g., "TMP-1") of the staged change to remove.',
      },
    },
    required: ['tempId'],
  },
};

export const stageUpdateToolSchema: GeminiFunctionDeclaration = {
  name: 'stage_update',
  description:
    "Modifies an *existing* change that is already staged (pending confirmation). Use this specifically when the user wants to alter the details (like title, description, labels) of a change identified by its temporary ID (`tempId`). Requires the `tempId` of the change to modify.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      changeToUpdate: {
        type: Type.OBJECT,
        description:
          'The updated change object. Must include the `tempId` of the change to update, along with the new `opType` and `data`.',
        properties: {
          opType: { type: Type.STRING, description: "New operation type" },
          data: { type: Type.OBJECT, description: "New payload for the operation" },
          tempId: { type: Type.STRING, description: "The temporary ID (e.g., 'TMP-1') of the change to update" }
        },
        required: ['opType', 'data', 'tempId']
      },
    },
    required: ['changeToUpdate'],
  },
};

export const commentCreateToolSchema: GeminiFunctionDeclaration = {
  name: 'comment.create',
  description: 'Adds a comment directly to an existing Linear issue. Does not use staging.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      issueId: {
        type: Type.STRING,
        description: 'The GUID identifier of the Linear issue to add the comment to.',
      },
      body: {
        type: Type.STRING,
        description: 'The text content of the comment.',
      },
      pre_execution_narration: {
        type: Type.STRING,
        description: "Optional. A short, friendly message (1-2 sentences) to display to the user *before* this tool executes. Example: 'Okay, adding your comment now.'",
      },
      post_execution_acknowledgement: {
        type: Type.STRING,
        description: "Optional. A short, friendly message (1-2 sentences) to display to the user *immediately after* this tool has finished, acknowledging completion. Example: 'Comment added!'",
      },
    },
    required: ['issueId', 'body'],
  },
};

export const availableTools: Tool[] = [{
  functionDeclarations: [
    linearSearchToolSchema,
    linearGetDetailsToolSchema,
    stageAddToolSchema,
    stageListToolSchema,
    stageRemoveToolSchema,
    stageUpdateToolSchema,
    applyStagedChangesToolSchema,
    commentCreateToolSchema,
  ],
}];
// --- Tool Schemas END --- 