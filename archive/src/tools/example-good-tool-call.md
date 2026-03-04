


You asked for the exact `code_edit` text I used in the tool call to remove the `post_execution_acknowledgement` parameter from the schemas in `src/tools/linear_stage.ts`. Here it is:

```typescript
// ... existing code ...
export const stageAddToolSchema: FunctionDeclaration = {
  name: 'stage_add',
  description: 
      'Adds a single proposed change (e.g., create issue, update issue) to a staging area. ' +
      'Requires a \'change\' object containing the operation type (opType) and data. ' +
      'If the change is for a new entity, provide a temporary ID (e.g., TMP-123) in \'tempId\'. ' +
      'Returns the outcome and the potentially updated agent state.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      change: {
        type: Type.OBJECT,
        description: 'The StagedChange object representing the operation to stage.'
        // Note: We cannot easily define the nested StagedChange structure here.
        // The LLM will need to construct this based on the StagedChange type definition.
      },
      pre_execution_narration: {
        type: Type.STRING,
        description: "Optional. Short message before execution. Example: 'Okay, I\\'ll stage that new issue.'",
        nullable: true,
      },
    },
    required: ['change']
  }
};
// --- END TOOL SCHEMA: stage_add ---
// ... existing code ...
export const stageListToolSchema: FunctionDeclaration = {
  name: 'stage_list',
  description: 
      'Lists all changes currently in the staging area. Does not take any parameters.',
  parameters: { 
    type: Type.OBJECT, 
    properties: {
        pre_execution_narration: {
            type: Type.STRING,
            description: "Optional. Short message before execution. Example: 'Let me check what\\'s staged.'",
            nullable: true,
        },
    }, 
    required: [] 
  }
};
// --- END TOOL SCHEMA: stage_list ---
// ... existing code ...
export const stageRemoveToolSchema: FunctionDeclaration = {
  name: 'stage_remove',
  description: 
      'Removes a previously staged change using its temporary ID (tempId, e.g., TMP-123).' +
      'Returns the outcome and the potentially updated agent state.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      tempId: {
        type: Type.STRING,
        description: 'The temporary ID (e.g., TMP-123) of the change to remove.'
      },
      pre_execution_narration: {
        type: Type.STRING,
        description: "Optional. Short message before execution. Example: 'Sure, I\\'ll remove that staged item.'",
        nullable: true,
      },
    },
    required: ['tempId']
  }
};
// --- END TOOL SCHEMA: stage_remove ---
// ... existing code ...
export const stageUpdateToolSchema: FunctionDeclaration = {
  name: 'stage_update',
  description: 
      'Updates an existing staged change identified by its temporary ID (tempId). ' +
      'Requires a \'changeToUpdate\' object which includes the \'tempId\' and the new data for the change. ' +
      'Returns the outcome and the potentially updated agent state.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      changeToUpdate: {
        type: Type.OBJECT,
        description: 'The StagedChange object containing the tempId to identify the change and the new data to apply.'
        // Note: Similar to stage_add, nested StagedChange structure is complex for schema.
      },
      pre_execution_narration: {
        type: Type.STRING,
        description: "Optional. Short message before execution. Example: 'Okay, let me update that staged change.'",
        nullable: true,
      },
    },
    required: ['changeToUpdate']
  }
};
// --- END TOOL SCHEMA: stage_update ---
// ... existing code ...

```

The instruction provided alongside this `code_edit` was: "Remove the `post_execution_acknowledgement` parameter from all tool schemas, leaving only `pre_execution_narration`."
