import { test, expect, Page } from '@playwright/test';

// Helper function to send a message and wait for a response
async function sendMessageAndGetResponse(page: Page, message: string): Promise<string> {
  await page.getByTestId('chat-input').fill(message);
  await page.getByTestId('chat-send-button').click();
  // Wait for the last message from the assistant, with increased timeout
  // Assuming messages are added and the last one is the newest
  await page.waitForSelector('[data-testid^="assistant-message-"]:last-child', { timeout: 90000 }); // Increased timeout to 90s
  const lastMessage = await page.locator('[data-testid^="assistant-message-"]:last-child').textContent();
  return lastMessage || '';
}

// Helper function to extract issue ID from text
function extractIssueId(text: string): string | null {
  const match = text.match(/([A-Z]+-\d+)/);
  return match ? match[0] : null;
}

test.describe('Update Issue Status E2E Test', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Ensure the chat input is visible before starting the test
    await expect(page.getByTestId('chat-input')).toBeVisible();
  });

  test('should attempt to update an issue status via chat', async ({ page }) => {
    // 1. Create a new Linear issue
    const createIssueTitle = 'Test E2E Update - ' + Date.now();
    let assistantResponse = await sendMessageAndGetResponse(page, `Create a Linear issue titled "${createIssueTitle}" with description "This is a test for status update."`);

    // Expect the agent to stage the change and ask for confirmation
    expect(assistantResponse).toMatch(/Okay, I've staged the following change: Create a new Linear issue/i);
    expect(assistantResponse).toMatch(/Do you want to apply this change?/i);

    // 2. Confirm applying the staged change
    assistantResponse = await sendMessageAndGetResponse(page, 'yes');

    // Expect the agent to confirm the issue creation and provide an ID
    expect(assistantResponse).toMatch(new RegExp(`Okay, I've created issue.*${createIssueTitle}`, 'i'));
    const issueId = extractIssueId(assistantResponse);
    expect(issueId).not.toBeNull();

    // 3. Ask the agent to mark the issue as complete
    assistantResponse = await sendMessageAndGetResponse(page, `Mark issue ${issueId} as complete.`);

    // 4. Assert that the agent does NOT say it *cannot* update the status
    // This is the key check for the LLM's reluctance.
    // We are checking if it *tries* or at least acknowledges the request positively,
    // rather than immediately saying it lacks the capability.
    const denialPhrases = [
      /I don't have a function to update/i,
      /I don't have the ability to change the status/i,
      /I cannot update an existing issue/i,
      /I can only search for issues/i,
      /My current tools allow me to.*but not modify existing ones/i,
    ];

    for (const phrase of denialPhrases) {
      expect(assistantResponse).not.toMatch(phrase);
    }

    // Ideally, we'd also check if it *did* stage an update,
    // e.g., "Okay, I've staged the following change: Update issue ${issueId}..."
    // This can be a more specific success condition if the agent is expected to confirm staging.
    expect(assistantResponse).toMatch(new RegExp(`Okay, I've staged.*update issue ${issueId}.*status to complete`, 'i'));
  });
}); 