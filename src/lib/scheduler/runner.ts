import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import db from '@/lib/db';
import { projects } from '@/lib/db/schema';
import SearchAgent from '@/lib/agents/search';
import type {
  SearchAgentConfig,
  SearchAgentInput,
} from '@/lib/agents/search/types';
import ModelRegistry from '@/lib/models/registry';
import configManager from '@/lib/config';
import type { ConfigModelProvider } from '@/lib/config/types';
import SessionManager from '@/lib/session';
import type { ModelRef, ScheduledJob } from './types';

/** Which list on a configured provider serves one of the two model roles. */
type ModelRole = 'chatModels' | 'embeddingModels';

/** What a run reports back to the ticker; see `recordRunOutcome`. */
export type JobRunResult = { ok: boolean; error?: string };

const configuredProviders = (): ConfigModelProvider[] =>
  configManager.getCurrentConfig().modelProviders ?? [];

/**
 * Whether a stored ref still points at a model that exists. A provider can be
 * removed, or a model dropped from it, while a job row keeps its old ref, and
 * the registry would then answer "Invalid provider id" for every run.
 */
const isConfigured = (
  provider: ConfigModelProvider,
  role: ModelRole,
  ref: ModelRef,
): boolean =>
  provider.id === ref.providerId &&
  (provider[role] ?? []).some((model) => model.key === ref.key);

/**
 * One model role: the job's own ref when it is still configured, otherwise the
 * first model of the first provider that offers one. Throws when nothing is
 * configured, which the caller reports as a failed run rather than a crash.
 */
const resolveModel = (
  stored: ModelRef | null,
  role: ModelRole,
  label: 'chat' | 'embedding',
): ModelRef => {
  const providers = configuredProviders();

  if (
    stored &&
    providers.some((provider) => isConfigured(provider, role, stored))
  ) {
    return stored;
  }

  const fallback = providers.find(
    (provider) => (provider[role] ?? []).length > 0,
  );
  const model = fallback?.[role][0];
  if (!model) throw new Error(`No ${label} model configured`);

  return { providerId: fallback.id, key: model.key };
};

/**
 * The models a job runs with, resolved at run time rather than stored: the
 * stored refs are a preference, and this is the only thing that knows what is
 * configured right now. Throws `No chat model configured` /
 * `No embedding model configured` when a role has nothing to fall back to.
 */
export const resolveJobModels = (
  job: ScheduledJob,
): { chatModel: ModelRef; embeddingModel: ModelRef } => ({
  chatModel: resolveModel(job.chatModel, 'chatModels', 'chat'),
  embeddingModel: resolveModel(
    job.embeddingModel,
    'embeddingModels',
    'embedding',
  ),
});

const MODES = [
  'speed',
  'superfast',
  'balanced',
  'quality',
] as const satisfies readonly SearchAgentConfig['mode'][];

const isMode = (mode: string): mode is SearchAgentConfig['mode'] =>
  (MODES as readonly string[]).includes(mode);

/**
 * `scheduled_jobs.optimizationMode` is plain TEXT rather than an enum, so a row
 * written by hand or by an older build can hold anything. Validated instead of
 * cast, and anything unrecognised runs as `balanced` — the same default
 * `createJobSchema` and the column DEFAULT declare — rather than failing the
 * run over a typo.
 */
const toMode = (mode: string): SearchAgentConfig['mode'] =>
  isMode(mode) ? mode : 'balanced';

const loadProject = async (projectId: string) =>
  db.query.projects.findFirst({ where: eq(projects.id, projectId) });

/**
 * Describes a failure without ever throwing: stringifying an object with a
 * throwing `toString` would turn this into a rejection from inside
 * `runJobNow`'s own catch block.
 */
const describeError = (err: unknown): string => {
  let message = '';
  try {
    message = err instanceof Error ? err.message : String(err);
  } catch {
    message = '';
  }

  return message || 'Unknown error';
};

/**
 * Runs one scheduled job headlessly: the same `SearchAgent` turn the chat route
 * starts, minus the HTTP and minus anyone reading the stream. The agent writes
 * the user message and its own answer to the job's chat, and its 30 minute
 * session TTL cleans the session up afterwards.
 *
 * Never rejects. The ticker fires this in the background where an unhandled
 * rejection would take the process down, so every failure — a model that cannot
 * be resolved, a provider that refuses the key, an agent that throws before it
 * catches anything itself — comes back as `{ ok: false, error }`.
 */
export const runJobNow = async (job: ScheduledJob): Promise<JobRunResult> => {
  try {
    const { chatModel, embeddingModel } = resolveJobModels(job);

    // A registry per run, as the chat route builds one per request: providers
    // can be added or removed between two ticks.
    const registry = new ModelRegistry();
    const [llm, embedding] = await Promise.all([
      registry.loadChatModel(chatModel.providerId, chatModel.key),
      registry.loadEmbeddingModel(
        embeddingModel.providerId,
        embeddingModel.key,
      ),
    ]);

    // Mirrors the project merge in `src/app/api/chat/route.ts`. The scheduled
    // prompt is the only user text there is, so the project's instructions (or
    // the literal 'None') are the whole system prompt.
    const project = job.projectId ? await loadProject(job.projectId) : null;
    const systemInstructions = project?.systemInstructions?.trim() || 'None';
    const fileIds = (project?.files ?? [])
      .map((file) => file.fileId)
      .filter((fileId): fileId is string => Boolean(fileId));

    const input: SearchAgentInput = {
      // Every run is standalone research: reading the previous run's answers as
      // history would make a recurring job drift further from its prompt on
      // every tick.
      chatHistory: [],
      followUp: job.prompt,
      chatId: job.chatId,
      messageId: crypto.randomBytes(7).toString('hex'),
      // Nobody is at the keyboard to answer clarifying questions. `skipped`
      // keeps the agent off that branch in quality mode (which would otherwise
      // stop with an unanswered `questions` block and write nothing) and leaves
      // the query untouched.
      clarification: { skipped: true },
      config: {
        llm,
        embedding,
        sources: job.sources,
        mode: toMode(job.optimizationMode),
        fileIds,
        systemInstructions,
      },
    };

    // `searchAsync` catches its own failures and persists a `status: 'error'`
    // turn, so a resolved promise means the turn is recorded, not that the
    // answer is good. The ticker counts and schedules off this result either
    // way.
    await new SearchAgent().searchAsync(SessionManager.createSession(), input);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
};
