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
import type { MinimalProvider, Model } from '@/lib/models/types';
import SessionManager from '@/lib/session';
import type { ModelRef, ScheduledJob } from './types';

/** Which list on a configured provider serves one of the two model roles. */
type ModelRole = 'chatModels' | 'embeddingModels';

/**
 * One entry of `ModelRegistry.getActiveProviders()` — what a configured provider
 * reports about itself RIGHT NOW, by being asked, shaped as a `MinimalProvider`.
 * This is the same list `GET /api/providers` serves, which is why every stored
 * ref names something in it: the creation form offered models from there.
 *
 * Deliberately NOT `configManager.getCurrentConfig().modelProviders`. The file is
 * written when a provider is added and its `embeddingModels` arrays are routinely
 * left empty, so resolving against it rejected stored refs the user had picked
 * from the live list, found no fallback either, and failed every scheduled run
 * with `No embedding model configured` on a server whose providers were healthy.
 */
type LiveProvider = MinimalProvider;

/**
 * The key `ModelRegistry` substitutes for a model it could not fetch — a
 * placeholder carrying the provider's error message as its name, not a model.
 * `GET /api/providers` filters out any provider whose chat list holds one, so
 * nothing the UI offers can name it; nothing the runner picks may either.
 */
const ERROR_MODEL_KEY = 'error';

/**
 * What to report to whoever fired a run: whether the turn happened, and why
 * not if it did not. What to record or schedule off that is the caller's call.
 */
export type JobRunResult = { ok: boolean; error?: string };

/**
 * The models of one list a job could actually be run with. A list the provider
 * never filled in — missing entirely, or only ever the fetch-error placeholder —
 * contributes nothing, which is what makes such a provider invisible both to the
 * stored-ref check and to the fallback.
 */
const usable = (provider: LiveProvider, role: ModelRole): Model[] =>
  (provider[role] ?? []).filter((model) => model.key !== ERROR_MODEL_KEY);

/**
 * Whether a stored ref still points at a model the provider reports right now. A
 * provider can be removed, or a model dropped from it, while a job row keeps its
 * old ref, and the registry would then answer "Invalid provider id" (or refuse
 * the key) for every run. Both halves matter: matching the provider alone would
 * accept any key that provider has ever had.
 */
const isAvailable = (
  provider: LiveProvider,
  role: ModelRole,
  ref: ModelRef,
): boolean =>
  provider.id === ref.providerId &&
  usable(provider, role).some((model) => model.key === ref.key);

/**
 * One model role: the job's own ref when the live list still offers it,
 * otherwise the first usable model of the first provider that has one. Throws
 * when nothing offers one, which the caller reports as a failed run rather than
 * a crash.
 *
 * Roles are decided independently and in the order given: the chat model is
 * resolved before the embedding one, so an installation with neither reports the
 * chat role rather than both at once.
 */
const resolveModel = (
  stored: ModelRef | null,
  providers: LiveProvider[],
  role: ModelRole,
  label: 'chat' | 'embedding',
): ModelRef => {
  if (
    stored &&
    providers.some((provider) => isAvailable(provider, role, stored))
  ) {
    return stored;
  }

  for (const provider of providers) {
    const [first] = usable(provider, role);
    if (first) return { providerId: provider.id, key: first.key };
  }

  throw new Error(`No ${label} model configured`);
};

/**
 * The models a job runs with, resolved at run time rather than stored: the
 * stored refs are a preference, and the caller's live provider list is the only
 * thing that knows what is configured right now. Throws
 * `No chat model configured` / `No embedding model configured` when a role has
 * nothing to fall back to.
 *
 * The provider list is a PARAMETER, not a fetch here, so that one run costs one
 * `getActiveProviders()` call — a network round per provider — however many
 * roles it has to resolve. The list is fetched by `runJobNow`, which owns the
 * single call, and reused by the two loads that follow.
 *
 * `async` although nothing is awaited in here: resolution is now part of a chain
 * that ends in a run rather than a pure query, and a promise-returning signature
 * is the honest one for the only caller — `runJobNow`, which must never throw out
 * of it.
 */
export const resolveJobModels = async (
  job: ScheduledJob,
  providers: LiveProvider[],
): Promise<{ chatModel: ModelRef; embeddingModel: ModelRef }> => ({
  chatModel: resolveModel(job.chatModel, providers, 'chatModels', 'chat'),
  embeddingModel: resolveModel(
    job.embeddingModel,
    providers,
    'embeddingModels',
    'embedding',
  ),
});

/**
 * Every mode `SearchAgentConfig` accepts, as a map KEYED BY THE UNION rather
 * than a list checked against it. `satisfies` would only have caught a mode
 * being removed; keying it by the type makes an ADDED mode a compile error too
 * (a missing key), so neither direction can slip through to silently run as
 * the default.
 */
const MODES: Record<SearchAgentConfig['mode'], true> = {
  speed: true,
  superfast: true,
  balanced: true,
  quality: true,
};

/**
 * `scheduled_jobs.optimizationMode` is plain TEXT rather than an enum, so a row
 * written by hand or by an older build can hold anything. Validated instead of
 * cast, and anything unrecognised runs as `balanced` — the same default
 * `createJobSchema` and the column DEFAULT declare — rather than failing the
 * run over a typo.
 */
const toMode = (mode: string): SearchAgentConfig['mode'] =>
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a stored
  // value of `toString` or `constructor` would pass and then be handed to the
  // agent as a mode.
  Object.hasOwn(MODES, mode) ? (mode as SearchAgentConfig['mode']) : 'balanced';

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
 * the user message and its own answer to the job's chat, and the session it was
 * handed is reclaimed by `SessionManager`'s 30 minute TTL.
 *
 * This is the contract, and it is what the background caller relies on: this
 * function NEVER rejects, and it never leaves a rejection unhandled. A job
 * scheduled to fire on a timer runs with nothing awaiting it, where an unhandled
 * rejection would take the whole process down rather than fail one job. So every
 * failure — a provider list that cannot be fetched, a model that cannot be
 * resolved, a provider that refuses the key, an agent that throws before it
 * catches anything itself — comes back as `{ ok: false, error }`.
 */
export const runJobNow = async (job: ScheduledJob): Promise<JobRunResult> => {
  try {
    // A registry per run, as the chat route builds one per request: providers
    // can be added or removed between two ticks.
    const registry = new ModelRegistry();

    /**
     * `getActiveProviders()` is awaited inside the `try` above, and a registry
     * catches a provider's failure itself, so neither an outright rejection nor
     * the throw it can raise is expected here. Both are inside this `try` anyway,
     * because the contract this function exists to keep is that it never
     * rejects: the background ticker fires a run with nothing awaiting it, where
     * an escaping rejection is node's `unhandledRejection` and a dead server
     * process. So a list that cannot be fetched is a failed run
     * (`{ ok: false, error }`), exactly like a model that cannot be loaded.
     *
     * Fetched ONCE and passed down: it asks every provider for its model list,
     * so asking again per role would be a second round of network requests for
     * an answer already in hand.
     */
    const providers = await registry.getActiveProviders();

    const { chatModel, embeddingModel } = await resolveJobModels(
      job,
      providers,
    );

    // Both loads in flight at once, but each wrapped: `Promise.all` attaches its
    // handlers only after it has evaluated BOTH array elements, so a synchronous
    // throw from the second call would strand the first call's already rejected
    // promise with no handler — node's `unhandledRejection`, which for a
    // scheduler means the server process dies. An async wrapper turns such a
    // throw into a rejection before `Promise.all` ever sees it. Today both
    // registry methods are `async`, which hides this; the wrapping is what makes
    // it safe rather than lucky.
    const [llm, embedding] = await Promise.all([
      (async () =>
        registry.loadChatModel(chatModel.providerId, chatModel.key))(),
      (async () =>
        registry.loadEmbeddingModel(
          embeddingModel.providerId,
          embeddingModel.key,
        ))(),
    ]);

    // The project merge from `src/app/api/chat/route.ts`, with ONE deliberate
    // difference: that route falls back to the CHAT row's `projectId` when the
    // request carries none, and this does not. `job.projectId` is the only
    // reference consulted, because the job row is what the user configured — a
    // job whose project was reassigned must follow the job, not the chat
    // `createJob` made for it. The cost of dropping the fallback is real and
    // silent: a chat still pointing at a project the job does not would lose
    // that project's instructions and files and still report `ok: true`. The
    // scheduled prompt is the only user text there is, so whatever this resolves
    // to is the whole system prompt.
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
    // turn, so `ok: true` here means the turn is recorded, not that the answer
    // is good. Deciding what to do with that — counting the run, rescheduling,
    // retrying — belongs to the caller that fires this, not to this function.
    // The session nobody read is reclaimed by `SessionManager`'s 30 minute TTL.
    await new SearchAgent().searchAsync(SessionManager.createSession(), input);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
};
