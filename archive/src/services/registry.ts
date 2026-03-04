import { GeminiClient, GraphQLProcessor, LinearCommandProcessor } from '@/api';
import { getLinearClient } from '@/linear/client';
import { type LinearClient } from '@linear/sdk';
import { FocusManager } from '@/linear/focus-manager';
import { IdMapper } from '@/linear/id-mapper';
import { LinearChangeManager } from '@/linear/changes';
import { PlainTextGenerator, MutationConverter } from '@/linear/staging-transformer';
import { LinearHandler } from '@/cli/handlers/LinearHandler';
import { ErrorLogger } from '@/cli/logging/ErrorLogger';
import { Logger } from '@/utils/logger';
import { type LinearGuid } from '@/types/linear-ids';
import { StagingTransformer } from '@/linear/staging-transformer';
import type { SerializableIdMappings } from '@/graph/graph';
import { DEFAULT_GEMINI_MODEL } from '@/constants/llm';

/**
 * Centralized service registry for dependency injection.
 * Instantiates and provides singleton instances of core services.
 */
export class ServiceRegistry {
  private static instance: ServiceRegistry;
  public readonly linearClient: LinearClient;
  private llmClient: GeminiClient;
  public readonly focusManager: FocusManager;
  public readonly idMapper: IdMapper;
  public readonly linearChangeManager: LinearChangeManager;
  public readonly mutationConverter: MutationConverter;
  public readonly plainTextGenerator: PlainTextGenerator;
  public readonly graphqlProcessor: GraphQLProcessor;
  public readonly linearCommandProcessor: LinearCommandProcessor;
  public readonly linearHandler: LinearHandler;
  public readonly errorLogger: ErrorLogger;
  public readonly logger: Logger;
  public readonly stagingTransformer: StagingTransformer;

  // Store potentially dynamic values that depend on focus
  // Note: These are captured at construction time.
  // Dependent services might need access to FocusManager directly
  // or an update mechanism if focus changes post-instantiation.
  private currentProjectId: LinearGuid | null = null;
  private currentProjectName: string | null = null;

  private constructor(
      mockLinearClient?: LinearClient,
      initialIdMappings: SerializableIdMappings | null = null
  ) {
    console.debug('Initializing ServiceRegistry...');
    this.logger = Logger.getInstance();
    console.info('[ServiceRegistry] Initializing...');

    this.linearClient = mockLinearClient ?? getLinearClient();
    this.llmClient = new GeminiClient(DEFAULT_GEMINI_MODEL);
    this.errorLogger = new ErrorLogger();

    this.idMapper = new IdMapper(this.linearClient, initialIdMappings);
    this.focusManager = new FocusManager(this.linearClient);

    this.currentProjectId = this.focusManager.getFocusedProjectId();
    this.currentProjectName = this.focusManager.getFocusedProjectName();

    // Services that depend on focus state (using state at construction time)
    this.linearChangeManager = new LinearChangeManager(
        this.linearClient,
        this.currentProjectId,
        this.idMapper,
        this.focusManager
    );
    this.mutationConverter = new MutationConverter(this.linearClient, this.idMapper);
    this.plainTextGenerator = new PlainTextGenerator(
        this.llmClient,
        this.currentProjectId,
        this.currentProjectName ?? '', // Provide default string
        this.idMapper
    );
    this.graphqlProcessor = new GraphQLProcessor(this.llmClient);

    // Instantiate LinearHandler with correct dependencies
    this.linearHandler = new LinearHandler(this.linearChangeManager, this.errorLogger, this.idMapper);

    // Instantiate Processors/Transformers
    this.linearCommandProcessor = new LinearCommandProcessor(this.llmClient);

    // Initialize staging transformer
    this.stagingTransformer = new StagingTransformer(
        this.llmClient,
        this.linearClient,
        this.idMapper,
        this.focusManager
    );

    console.debug('ServiceRegistry initialized.');
    console.info('[ServiceRegistry] Initialization complete.');
  }

  public static getInstance(
      mockLinearClient?: LinearClient,
      initialIdMappings: SerializableIdMappings | null = null
  ): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry(mockLinearClient, initialIdMappings);
    }
    return ServiceRegistry.instance;
  }

  public getLLMClient(): GeminiClient {
    return this.llmClient;
  }

  // Removed: No event listener to trigger this
  // private handleFocusChange(projectId: LinearGuid | null, projectName?: string): void { ... }

} 