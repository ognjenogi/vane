import Database from 'better-sqlite3';
import {
  drizzle,
  type BetterSQLite3Database,
} from 'drizzle-orm/better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as schema from '@/lib/db/schema';
import SessionManager from '@/lib/session';
import { resolveJobModels, runJobNow } from '@/lib/scheduler/runner';
import type { ScheduledJob } from '@/lib/scheduler/types';
import {
  betterSqliteMockFactory,
  closeTrackedDatabases,
} from '@/test/dbTracking';

const doubles = vi.hoisted(() => ({
  searchAsync: vi.fn(),
  loadChatModel: vi.fn(),
  loadEmbeddingModel: vi.fn(),
  /**
   * The values the registry hands back, as PLAIN functions rather than spies:
   * vitest attaches a rejection handler to any promise a spy returns, which
   * would hide the very unhandled rejection
   * `leaves no rejection unhandled when a sibling load throws synchronously`
   * is about. The spies above still record the calls.
   */
  chatModelResult: (() => Promise.resolve(undefined)) as () => unknown,
  embeddingModelResult: (() => Promise.resolve(undefined)) as () => unknown,
  getCurrentConfig: vi.fn(),
  /**
   * `@/lib/db` opens `<DATA_DIR>/data/db.sqlite` at import time, and the runner
   * module is imported before any `beforeAll` runs, so the mock factory cannot
   * build the in-memory handle itself. It reads it from here instead, once
   * `beforeAll` has filled it in.
   */
  db: { handle: null as BetterSQLite3Database<typeof schema> | null },
}));

vi.mock('@/lib/agents/search', () => ({
  default: class SearchAgent {
    searchAsync = doubles.searchAsync;
  },
}));

/**
 * The registry only hands back model handles here; no provider is ever
 * constructed, so no key or endpoint is needed. A test can also make either
 * method throw synchronously, or return an already rejected promise.
 */
vi.mock('@/lib/models/registry', () => ({
  default: class ModelRegistry {
    loadChatModel = (...args: unknown[]) => {
      doubles.loadChatModel(...args);
      return doubles.chatModelResult();
    };
    loadEmbeddingModel = (...args: unknown[]) => {
      doubles.loadEmbeddingModel(...args);
      return doubles.embeddingModelResult();
    };
  },
}));

vi.mock('@/lib/config', () => ({
  default: { getCurrentConfig: doubles.getCurrentConfig },
}));

vi.mock('@/lib/db', () => ({
  default: {
    query: {
      projects: {
        // Forwarded to the in-memory drizzle handle, so the runner's query runs
        // for real against the `projects` table the migration created. Called
        // as a method: drizzle's relational query builder reads `this.mode`.
        findFirst: (args: unknown) => {
          const handle = doubles.db.handle;
          if (!handle) throw new Error('the test database is not ready');
          return handle.query.projects.findFirst(
            args as Parameters<typeof handle.query.projects.findFirst>[0],
          );
        },
      },
    },
  },
}));

/**
 * The projects table is read through real drizzle against real sqlite, so this
 * file prepares native `Statement`s; the helper keeps every wrapper reachable
 * and closes the handles at the end. See src/test/dbTracking.ts.
 */
vi.mock('better-sqlite3', () =>
  import('@/test/dbTracking').then((m) => m.betterSqliteMockFactory()),
);

const MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

const LLM = { fake: 'chat model' };
const EMBEDDING = { fake: 'embedding model' };

const provider = (
  id: string,
  chatModels: string[],
  embeddingModels: string[],
) => ({
  id,
  name: id,
  type: 'openai',
  chatModels: chatModels.map((key) => ({ key, name: key })),
  embeddingModels: embeddingModels.map((key) => ({ key, name: key })),
  config: {},
  hash: `${id}-hash`,
});

const OPENAI = provider('openai', ['gpt-4o', 'gpt-4o-mini'], ['embed-3']);
const ANTHROPIC = provider('anthropic', ['claude-sonnet'], ['voyage-3']);

/** A provider with an embedding model only: it cannot serve the chat role. */
const EMBEDDINGS_ONLY = provider('embeddings-only', [], ['nomic-embed']);

const T0 = '2026-01-01T00:00:00.000Z';

const job = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: 'job-1',
  title: 'Daily digest',
  prompt: 'Summarize what changed today',
  chatId: 'chat-1',
  intervalMinutes: 60,
  endType: 'never',
  maxRuns: null,
  runUntil: null,
  status: 'active',
  runCount: 3,
  lastRunAt: T0,
  nextRunAt: '2026-01-01T01:00:00.000Z',
  lastError: null,
  optimizationMode: 'quality',
  sources: ['web', 'academic'],
  chatModel: { providerId: 'openai', key: 'gpt-4o' },
  embeddingModel: { providerId: 'openai', key: 'embed-3' },
  projectId: null,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

describe('scheduler runner', () => {
  let sqlite: Database.Database;

  beforeAll(() => {
    sqlite = new Database(':memory:');
    // The shipped migrations, so the projects read tracks the real schema.
    for (const file of fs.readdirSync(MIGRATIONS_DIR).sort()) {
      if (!file.endsWith('.sql')) continue;
      sqlite.exec(
        fs
          .readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
          .split('--> statement-breakpoint')
          .join(';'),
      );
    }

    doubles.db.handle = drizzle(sqlite, { schema });
  });

  afterAll(() => {
    closeTrackedDatabases();
  });

  beforeEach(() => {
    // Only `Date` is faked: SessionManager arms a 30 minute TTL timer per
    // session, and nothing here waits on a timer.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.clearAllMocks();

    doubles.chatModelResult = () => Promise.resolve(LLM);
    doubles.embeddingModelResult = () => Promise.resolve(EMBEDDING);
    doubles.searchAsync.mockResolvedValue(undefined);
    doubles.getCurrentConfig.mockReturnValue({
      modelProviders: [ANTHROPIC, OPENAI],
    });

    sqlite.exec('DELETE FROM projects;');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Writes a `projects` row the way the table allows: `systemInstructions` and
   * `files` both have DEFAULTs but no NOT NULL, so `null` here stands for a
   * legacy row written before those columns were populated.
   */
  const insertProject = (row: {
    id: string;
    systemInstructions?: string | null;
    files?: unknown[] | null;
  }) =>
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, systemInstructions, files, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        'Project',
        row.systemInstructions ?? null,
        row.files === null ? null : JSON.stringify(row.files ?? []),
        T0,
        T0,
      );

  /** The agent input the last `searchAsync` call received. */
  const agentInput = () => doubles.searchAsync.mock.calls[0][1];
  const agentSession = () => doubles.searchAsync.mock.calls[0][0];

  describe('resolveJobModels', () => {
    it('keeps stored refs that are still configured', () => {
      expect(resolveJobModels(job())).toEqual({
        chatModel: { providerId: 'openai', key: 'gpt-4o' },
        embeddingModel: { providerId: 'openai', key: 'embed-3' },
      });
    });

    it('falls back per role when a stored ref is no longer configured', () => {
      doubles.getCurrentConfig.mockReturnValue({
        modelProviders: [EMBEDDINGS_ONLY, ANTHROPIC, OPENAI],
      });

      expect(
        resolveJobModels(
          job({
            chatModel: { providerId: 'removed-provider', key: 'gpt-4o' },
            embeddingModel: { providerId: 'openai', key: 'removed-model' },
          }),
        ),
      ).toEqual({
        // The first provider has no chat models at all, so the chat role skips it.
        chatModel: { providerId: 'anthropic', key: 'claude-sonnet' },
        // ...while the embedding role can still use it.
        embeddingModel: { providerId: 'embeddings-only', key: 'nomic-embed' },
      });
    });

    it('falls back when the job stores no model at all', () => {
      expect(
        resolveJobModels(job({ chatModel: null, embeddingModel: null })),
      ).toEqual({
        chatModel: { providerId: 'anthropic', key: 'claude-sonnet' },
        embeddingModel: { providerId: 'anthropic', key: 'voyage-3' },
      });
    });

    it('skips a provider that has no model list for the role at all', () => {
      // Both columns have DEFAULTs but no NOT NULL, so a provider saved by an
      // older build can be missing the list entirely.
      doubles.getCurrentConfig.mockReturnValue({
        modelProviders: [
          { ...EMBEDDINGS_ONLY, chatModels: null },
          ANTHROPIC,
          OPENAI,
        ],
      });

      // No stored refs, so both roles fall back to the first provider that has a
      // list at all — skipping the one whose list is null.
      expect(
        resolveJobModels(job({ chatModel: null, embeddingModel: null })),
      ).toEqual({
        chatModel: { providerId: 'anthropic', key: 'claude-sonnet' },
        embeddingModel: { providerId: 'embeddings-only', key: 'nomic-embed' },
      });

      // And a stored ref pointing AT that provider is not "configured" — the
      // list it would have to be found in does not exist.
      expect(
        resolveJobModels(
          job({
            chatModel: { providerId: 'embeddings-only', key: 'claude-sonnet' },
            embeddingModel: null,
          }),
        ),
      ).toEqual({
        chatModel: { providerId: 'anthropic', key: 'claude-sonnet' },
        embeddingModel: { providerId: 'embeddings-only', key: 'nomic-embed' },
      });
    });

    it('throws a clear error when no provider offers a chat model', () => {
      doubles.getCurrentConfig.mockReturnValue({
        modelProviders: [EMBEDDINGS_ONLY],
      });

      expect(() => resolveJobModels(job())).toThrow('No chat model configured');
    });

    it('throws a clear error when no provider offers an embedding model', () => {
      doubles.getCurrentConfig.mockReturnValue({
        modelProviders: [provider('chat-only', ['gpt-4o'], [])],
      });

      expect(() => resolveJobModels(job())).toThrow(
        'No embedding model configured',
      );
    });

    it('treats a config without providers as nothing configured', () => {
      doubles.getCurrentConfig.mockReturnValue({});

      expect(() => resolveJobModels(job())).toThrow('No chat model configured');
    });
  });

  describe('runJobNow', () => {
    it('runs the prompt headlessly against the job own chat', async () => {
      const result = await runJobNow(job());

      expect(result).toEqual({ ok: true });
      expect(doubles.searchAsync).toHaveBeenCalledTimes(1);
      expect(doubles.loadChatModel).toHaveBeenCalledWith('openai', 'gpt-4o');
      expect(doubles.loadEmbeddingModel).toHaveBeenCalledWith(
        'openai',
        'embed-3',
      );

      // A real session nobody reads: the agent's stream is discarded.
      expect(agentSession()).toBeInstanceOf(SessionManager);

      // The exact turn the agent was asked to run, every field of it: no
      // history carried over from previous runs, nobody to answer clarifying
      // questions, a fresh message id, the job's own chat, and no project to
      // inherit instructions or files from.
      expect(agentInput()).toStrictEqual({
        chatHistory: [],
        followUp: 'Summarize what changed today',
        chatId: 'chat-1',
        messageId: expect.stringMatching(/^[0-9a-f]{14}$/),
        clarification: { skipped: true },
        config: {
          llm: LLM,
          embedding: EMBEDDING,
          sources: ['web', 'academic'],
          mode: 'quality',
          fileIds: [],
          systemInstructions: 'None',
        },
      });
    });

    it('gives every run its own message id', async () => {
      await runJobNow(job());
      await runJobNow(job());

      const [first, second] = doubles.searchAsync.mock.calls.map(
        ([, input]) => input.messageId,
      );
      expect(first).not.toBe(second);
    });

    /**
     * Project inheritance follows `job.projectId` and nothing else, unlike the
     * chat route, which falls back to the CHAT row's `projectId`. The deviation
     * is deliberate (a job whose project was reassigned must follow the job row),
     * and the test pins the behaviour that comes with it: instructions trimmed,
     * empty file ids dropped, missing values defaulted rather than fatal.
     */
    it('passes the project instructions and files down', async () => {
      insertProject({
        id: 'proj-1',
        systemInstructions: '  Always answer in Bulgarian.  ',
        files: [
          { fileId: 'file-1', name: 'notes.pdf' },
          { fileId: 'file-2', name: 'data.csv' },
        ],
      });

      const result = await runJobNow(job({ projectId: 'proj-1' }));

      expect(result).toEqual({ ok: true });
      expect(agentInput().config.systemInstructions).toBe(
        'Always answer in Bulgarian.',
      );
      expect(agentInput().config.fileIds).toEqual(['file-1', 'file-2']);
    });

    it('falls back to no instructions for a project that has none', async () => {
      insertProject({ id: 'proj-2', systemInstructions: '   ', files: [] });

      const result = await runJobNow(job({ projectId: 'proj-2' }));

      expect(result).toEqual({ ok: true });
      expect(agentInput().config.systemInstructions).toBe('None');
      expect(agentInput().config.fileIds).toEqual([]);
    });

    it('drops a file entry that carries no id', async () => {
      insertProject({
        id: 'proj-partial',
        systemInstructions: 'Be brief.',
        files: [
          { fileId: 'file-1', name: 'notes.pdf' },
          { fileId: '', name: 'unreadable.pdf' },
          { fileId: 'file-2', name: 'data.csv' },
        ],
      });

      const result = await runJobNow(job({ projectId: 'proj-partial' }));

      expect(result).toEqual({ ok: true });
      expect(agentInput().config.systemInstructions).toBe('Be brief.');
      // An empty id would be sent to the agent as a file to search with.
      expect(agentInput().config.fileIds).toEqual(['file-1', 'file-2']);
    });

    it('tolerates a project row with null instructions and null files', async () => {
      // Both columns are nullable: a row written before they were populated
      // reads back as null rather than as '' and [].
      insertProject({
        id: 'proj-legacy',
        systemInstructions: null,
        files: null,
      });

      const result = await runJobNow(job({ projectId: 'proj-legacy' }));

      expect(result).toEqual({ ok: true });
      expect(agentInput().config.systemInstructions).toBe('None');
      expect(agentInput().config.fileIds).toEqual([]);
    });

    it('runs without a project even when the id points at a deleted row', async () => {
      const result = await runJobNow(job({ projectId: 'gone' }));

      expect(result).toEqual({ ok: true });
      expect(agentInput().config.systemInstructions).toBe('None');
      expect(agentInput().config.fileIds).toEqual([]);
    });

    it('passes a narrower stored mode through unchanged', async () => {
      await runJobNow(job({ optimizationMode: 'superfast' }));
      expect(agentInput().config.mode).toBe('superfast');

      doubles.searchAsync.mockClear();
      await runJobNow(job({ optimizationMode: 'speed' }));
      expect(agentInput().config.mode).toBe('speed');
    });

    it('falls back to balanced for a mode that is not one of the four', async () => {
      // The column is plain text, so a hand edited row can hold anything.
      const result = await runJobNow(job({ optimizationMode: 'turbo' }));

      expect(result).toEqual({ ok: true });
      expect(agentInput().config.mode).toBe('balanced');
    });

    it('does not mistake an inherited object key for a mode', async () => {
      // The mode set is a plain object, so `in` would accept `toString` and
      // hand the agent a mode that does not exist.
      for (const mode of ['toString', 'constructor', 'hasOwnProperty']) {
        doubles.searchAsync.mockClear();

        const result = await runJobNow(job({ optimizationMode: mode }));

        expect(result).toEqual({ ok: true });
        expect(agentInput().config.mode).toBe('balanced');
      }
    });

    it('replaces a stored model that is no longer configured', async () => {
      doubles.getCurrentConfig.mockReturnValue({
        modelProviders: [ANTHROPIC, OPENAI],
      });

      const result = await runJobNow(
        job({
          chatModel: { providerId: 'removed-provider', key: 'gpt-4o' },
          embeddingModel: null,
        }),
      );

      expect(result).toEqual({ ok: true });
      expect(doubles.loadChatModel).toHaveBeenCalledWith(
        'anthropic',
        'claude-sonnet',
      );
      expect(doubles.loadEmbeddingModel).toHaveBeenCalledWith(
        'anthropic',
        'voyage-3',
      );
      expect(agentInput().config.llm).toBe(LLM);
    });

    it('reports the failure and skips the run when no model is configured', async () => {
      doubles.getCurrentConfig.mockReturnValue({ modelProviders: [] });

      const result = await runJobNow(job());

      expect(result).toEqual({ ok: false, error: 'No chat model configured' });
      expect(doubles.searchAsync).not.toHaveBeenCalled();
    });

    it('reports the failure when a model cannot be loaded', async () => {
      doubles.chatModelResult = () =>
        Promise.reject(new Error('Invalid provider id'));

      const result = await runJobNow(job());

      expect(result).toEqual({ ok: false, error: 'Invalid provider id' });
      expect(doubles.searchAsync).not.toHaveBeenCalled();
    });

    it('leaves no rejection unhandled when a sibling load throws synchronously', async () => {
      // `Promise.all` attaches its handlers only after both array elements have
      // been evaluated, so a synchronous throw from the second call can strand
      // the first call's already-rejected promise: node would then raise
      // `unhandledRejection` and take the server process down. The registry
      // methods happen to be `async` today, which hides this.
      doubles.chatModelResult = () =>
        Promise.reject(new Error('chat load rejected'));
      doubles.embeddingModelResult = () => {
        throw new Error('embedding load threw');
      };

      const unhandled: unknown[] = [];
      const collect = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', collect);

      try {
        const result = await runJobNow(job());

        expect(result).toEqual({
          ok: false,
          error: 'embedding load threw',
        });
        expect(doubles.searchAsync).not.toHaveBeenCalled();

        // Node reports a handler-less rejection on the next macrotask.
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', collect);
      }
    });

    it('reports the failure when the agent rejects', async () => {
      doubles.searchAsync.mockRejectedValue(new Error('disk is on fire'));

      const result = await runJobNow(job());

      expect(result).toEqual({ ok: false, error: 'disk is on fire' });
      // The agent was reached, so the run itself happened; what the caller
      // makes of that is its own decision.
      expect(doubles.searchAsync).toHaveBeenCalledTimes(1);
    });

    it('reports a non-Error rejection without throwing', async () => {
      doubles.searchAsync.mockRejectedValue('teapot');

      const result = await runJobNow(job());

      expect(result).toEqual({ ok: false, error: 'teapot' });
    });

    it('reports a failure it cannot describe without rejecting', async () => {
      // `String()` handles a symbol, but an object whose own `toString`
      // throws would take the catch block down with it.
      doubles.searchAsync.mockRejectedValue(Symbol('teapot'));
      expect(await runJobNow(job())).toEqual({
        ok: false,
        error: 'Symbol(teapot)',
      });

      doubles.searchAsync.mockRejectedValue({
        toString: () => {
          throw new Error('nope');
        },
      });
      expect(await runJobNow(job())).toEqual({
        ok: false,
        error: 'Unknown error',
      });

      doubles.searchAsync.mockRejectedValue(new Error(''));
      expect(await runJobNow(job())).toEqual({
        ok: false,
        error: 'Unknown error',
      });
    });
  });
});
