/// <reference types="vitest" />
import { describe, it, expect } from 'vitest';
import { prepareGraphQLInput } from '@/tools/linear_apply'; // Adjust path if needed
import type { LinearGuid } from '@/types/linear-ids';

describe('prepareGraphQLInput Helper Function', () => {

  it('should separate id into idForUpdate for update operations and remove it from input', () => {
    const opType = 'issue.update';
    const guid = 'guid-123' as LinearGuid;
    const enrichedData = { id: guid, title: 'New Title', otherField: 'value' };
    
    const { input, idForUpdate } = prepareGraphQLInput(opType, enrichedData);

    expect(idForUpdate).toBe(guid);
    expect(input.id).toBeUndefined();
    expect(input.title).toBe('New Title');
    expect(input.otherField).toBe('value');
  });

  it('should separate identifier into idForUpdate for update operations and remove it from input', () => {
    const opType = 'project.update';
    const guid = 'guid-456' as LinearGuid;
    const enrichedData = { identifier: guid, name: 'New Name', state: 'done' };

    const { input, idForUpdate } = prepareGraphQLInput(opType, enrichedData);

    expect(idForUpdate).toBe(guid);
    expect(input.identifier).toBeUndefined();
    expect(input.name).toBe('New Name');
    expect(input.state).toBe('done');
  });

  it('should prioritize data.id over data.identifier if both exist for updates', () => {
    const opType = 'issue.update';
    const guidFromId = 'guid-id-789' as LinearGuid;
    const guidFromIdentifier = 'guid-identifier-abc' as LinearGuid;
    const enrichedData = { 
        id: guidFromId, 
        identifier: guidFromIdentifier, 
        description: 'Updated description' 
    };

    const { input, idForUpdate } = prepareGraphQLInput(opType, enrichedData);

    expect(idForUpdate).toBe(guidFromId); // id should take precedence
    expect(input.id).toBeUndefined();
    expect(input.identifier).toBeUndefined(); // Should also remove identifier
    expect(input.description).toBe('Updated description');
  });

  it('should not extract idForUpdate for create operations', () => {
    const opType = 'issue.create';
    const enrichedData = { 
        teamId: 'team-guid', 
        title: 'Create Title', 
        tempId: 'TMP-1' // tempId might be present in enrichedData before this step
    }; 

    const { input, idForUpdate } = prepareGraphQLInput(opType, enrichedData);

    expect(idForUpdate).toBeUndefined();
    expect(input.teamId).toBe('team-guid');
    expect(input.title).toBe('Create Title');
    expect(input.tempId).toBeUndefined(); // Should remove tempId for create ops
  });

  it('should remove tempId from input for create operations', () => {
    const opType = 'comment.create';
    const enrichedData = { issueId: 'guid-123', body: 'Comment body', tempId: 'TMP-C1' };

    const { input, idForUpdate } = prepareGraphQLInput(opType, enrichedData);

    expect(idForUpdate).toBeUndefined();
    expect(input.tempId).toBeUndefined();
    expect(input.issueId).toBe('guid-123');
    expect(input.body).toBe('Comment body');
  });
  
  it('should remove opType from input if present', () => {
    const opType = 'issue.update';
    const guid = 'guid-abc' as LinearGuid;
    const enrichedData = { id: guid, title: 'New Title', opType: 'should-be-removed' };

    const { input, idForUpdate } = prepareGraphQLInput(opType, enrichedData);

    expect(idForUpdate).toBe(guid);
    expect(input.opType).toBeUndefined();
    expect(input.title).toBe('New Title');
  });

  it('should throw error if teamId is missing for issue.create', () => {
    const opType = 'issue.create';
    const enrichedData = { title: 'Missing Team ID' }; // No teamId

    expect(() => prepareGraphQLInput(opType, enrichedData))
      .toThrow(/'teamId' is required/);
  });

  it('should handle empty enrichedData gracefully', () => {
    const opType = 'issue.create';
    const enrichedData = {}; // Empty

    expect(() => prepareGraphQLInput(opType, enrichedData))
      .toThrow(/'teamId' is required/); // Still throws for missing teamId
    
    const opTypeUpdate = 'issue.update';
    const { input, idForUpdate } = prepareGraphQLInput(opTypeUpdate, {});
    expect(idForUpdate).toBeUndefined();
    expect(input).toEqual({});
  });

}); 