import { z } from 'zod';
import ModelRegistry from '@/lib/models/registry';
import { ModelWithProvider } from '@/lib/models/types';
import SearchAgent from '@/lib/agents/search';
import SessionManager from '@/lib/session';
import { ChatTurnMessage } from '@/lib/types';
import { SearchSources } from '@/lib/agents/search/types';
import db from '@/lib/db';
import { eq } from 'drizzle-orm';
import { chats, projects } from '@/lib/db/schema';
import UploadManager from '@/lib/uploads/manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const messageSchema = z.object({
  messageId: z.string().min(1, 'Message ID is required'),
  chatId: z.string().min(1, 'Chat ID is required'),
  content: z.string().min(1, 'Message content is required'),
});

const chatModelSchema: z.ZodType<ModelWithProvider> = z.object({
  providerId: z.string({ message: 'Chat model provider id must be provided' }),
  key: z.string({ message: 'Chat model key must be provided' }),
});

const embeddingModelSchema: z.ZodType<ModelWithProvider> = z.object({
  providerId: z.string({
    message: 'Embedding model provider id must be provided',
  }),
  key: z.string({ message: 'Embedding model key must be provided' }),
});

const bodySchema = z.object({
  message: messageSchema,
  optimizationMode: z.enum(['speed', 'balanced', 'quality', 'superfast'], {
    message:
      'Optimization mode must be one of: speed, balanced, quality, superfast',
  }),
  sources: z.array(z.string()).optional().default([]),
  history: z
    .array(z.tuple([z.string(), z.string()]))
    .optional()
    .default([]),
  files: z.array(z.string()).optional().default([]),
  chatModel: chatModelSchema,
  embeddingModel: embeddingModelSchema,
  systemInstructions: z.string().nullable().optional().default(''),
  projectId: z.string().nullable().optional(),
  clarification: z
    .object({
      skipped: z.boolean(),
      answers: z
        .array(
          z.object({
            question: z.string(),
            answer: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

type Body = z.infer<typeof bodySchema>;

const safeValidateBody = (data: unknown) => {
  const result = bodySchema.safeParse(data);

  if (!result.success) {
    return {
      success: false,
      error: result.error.issues.map((e: any) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    };
  }

  return {
    success: true,
    data: result.data,
  };
};

const ensureChatExists = async (input: {
  id: string;
  sources: SearchSources[];
  query: string;
  fileIds: string[];
  projectId?: string | null;
}) => {
  try {
    const exists = await db.query.chats
      .findFirst({
        where: eq(chats.id, input.id),
      })
      .execute();

    if (!exists) {
      await db.insert(chats).values({
        id: input.id,
        createdAt: new Date().toISOString(),
        sources: input.sources,
        title: input.query,
        projectId: input.projectId || null,
        files: input.fileIds.map((id) => {
          return {
            fileId: id,
            name: UploadManager.getFile(id)?.name || 'Uploaded File',
          };
        }),
      });
    }
  } catch (err) {
    console.error('Failed to check/save chat:', err);
  }
};

export const POST = async (req: Request) => {
  try {
    const reqBody = (await req.json()) as Body;

    const parseBody = safeValidateBody(reqBody);

    if (!parseBody.success) {
      return Response.json(
        { message: 'Invalid request body', error: parseBody.error },
        { status: 400 },
      );
    }

    const body = parseBody.data as Body;
    const { message } = body;

    if (message.content === '') {
      return Response.json(
        {
          message: 'Please provide a message to process',
        },
        { status: 400 },
      );
    }

    console.log(
      `[Chat API] Chat: ${body.message.chatId} | Model: ${body.chatModel.key} (${body.chatModel.providerId}) | Mode: ${body.optimizationMode}`
    );

    const registry = new ModelRegistry();

    const [llm, embedding] = await Promise.all([
      registry.loadChatModel(body.chatModel.providerId, body.chatModel.key),
      registry.loadEmbeddingModel(
        body.embeddingModel.providerId,
        body.embeddingModel.key,
      ),
    ]);

    const history: ChatTurnMessage[] = body.history.map((msg) => {
      if (msg[0] === 'human') {
        return {
          role: 'user',
          content: msg[1],
        };
      } else {
        return {
          role: 'assistant',
          content: msg[1],
        };
      }
    });

    const agent = new SearchAgent();
    const session = SessionManager.createSession();

    const responseStream = new TransformStream();
    const writer = responseStream.writable.getWriter();
    const encoder = new TextEncoder();

    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let disconnect: () => void = () => {};

    const write = (payload: unknown) => {
      if (closed) return;
      writer
        .write(encoder.encode(JSON.stringify(payload) + '\n'))
        .catch(() => {});
    };

    const closeStream = () => {
      if (closed) return;
      closed = true;
      disconnect();
      clearInterval(heartbeat);
      try {
        writer.close();
      } catch {}
    };

    heartbeat = setInterval(() => write({ type: 'ping' }), 10000);

    write({ type: 'sessionId', data: session.id });

    disconnect = session.subscribe((event, data) => {
      if (event === 'data') {
        if (data.type === 'block') {
          write({ type: 'block', block: data.block });
        } else if (data.type === 'updateBlock') {
          write({
            type: 'updateBlock',
            blockId: data.blockId,
            patch: data.patch,
          });
        } else if (data.type === 'researchComplete') {
          write({ type: 'researchComplete' });
        }
      } else if (event === 'end') {
        write({ type: 'messageEnd' });
        closeStream();
        session.removeAllListeners();
      } else if (event === 'error') {
        write({ type: 'error', data: data.data });
        closeStream();
        session.removeAllListeners();
      }
    });

    if (closed) disconnect();

    let projectSystemInstructions = '';
    let projectFileIds: string[] = [];
    let effectiveProjectId = body.projectId || null;

    if (!effectiveProjectId && body.message.chatId) {
      const existingChat = await db.query.chats.findFirst({
        where: eq(chats.id, body.message.chatId),
      });
      if (existingChat?.projectId) {
        effectiveProjectId = existingChat.projectId;
      }
    }

    if (effectiveProjectId) {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, effectiveProjectId),
      });
      if (project) {
        if (project.systemInstructions?.trim()) {
          projectSystemInstructions = project.systemInstructions.trim();
        }
        if (project.files && Array.isArray(project.files)) {
          projectFileIds = project.files.map((f) => f.fileId).filter(Boolean);
        }
      }
    }

    const combinedSystemInstructions =
      [projectSystemInstructions, body.systemInstructions]
        .filter(Boolean)
        .join('\n\n') || 'None';

    const combinedFileIds = Array.from(
      new Set([...projectFileIds, ...(body.files || [])]),
    );

    agent.searchAsync(session, {
      chatHistory: history,
      followUp: message.content,
      chatId: body.message.chatId,
      messageId: body.message.messageId,
      clarification: body.clarification,
      config: {
        llm,
        embedding: embedding,
        sources: body.sources as SearchSources[],
        mode: body.optimizationMode,
        fileIds: combinedFileIds,
        systemInstructions: combinedSystemInstructions,
      },
    });

    ensureChatExists({
      id: body.message.chatId,
      sources: body.sources as SearchSources[],
      fileIds: combinedFileIds,
      query: body.message.content,
      projectId: effectiveProjectId,
    });

    req.signal.addEventListener('abort', () => {
      session.abort();
      closeStream();
    });

    return new Response(responseStream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (err) {
    console.error('An error occurred while processing chat request:', err);
    return Response.json(
      { message: 'An error occurred while processing chat request' },
      { status: 500 },
    );
  }
};
