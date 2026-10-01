import db from '@/lib/db';
import { chats, messages, scheduledJobs } from '@/lib/db/schema';
import { and, eq, ne } from 'drizzle-orm';

export const GET = async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;

    const chatExists = await db.query.chats.findFirst({
      where: eq(chats.id, id),
    });

    if (!chatExists) {
      return Response.json({ message: 'Chat not found' }, { status: 404 });
    }

    const chatMessages = await db.query.messages.findMany({
      where: eq(messages.chatId, id),
    });

    return Response.json(
      {
        chat: chatExists,
        messages: chatMessages,
      },
      { status: 200 },
    );
  } catch (err) {
    console.error('Error in getting chat by id: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};

export const DELETE = async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;

    const chatExists = await db.query.chats.findFirst({
      where: eq(chats.id, id),
    });

    if (!chatExists) {
      return Response.json({ message: 'Chat not found' }, { status: 404 });
    }

    /**
     * Pause every scheduled job that writes into this chat BEFORE the chat goes.
     *
     * A job keeps buying a full paid research turn on its own timer, and nothing
     * else stops it: there are no foreign keys, and the agent's message insert is
     * keyed on `messageId` alone, so each run silently re-creates message rows
     * for a chat the user just deleted — answers nobody can reach, since
     * `GET /api/chats/{id}` now 404s.
     *
     * Paused rather than deleted, and `nextRunAt` is left alone: the job and its
     * prompt are the user's own, so a mistaken delete is recoverable by resuming
     * from the scheduled page. A job that has ALREADY completed is left
     * completed — that status is terminal, and rewriting it would hand the user
     * a "Resume" on a schedule that is over.
     */
    await db
      .update(scheduledJobs)
      .set({ status: 'paused', updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(scheduledJobs.chatId, id),
          ne(scheduledJobs.status, 'completed'),
        ),
      )
      .execute();

    await db.delete(chats).where(eq(chats.id, id)).execute();
    await db.delete(messages).where(eq(messages.chatId, id)).execute();

    return Response.json(
      { message: 'Chat deleted successfully' },
      { status: 200 },
    );
  } catch (err) {
    console.error('Error in deleting chat by id: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};

export const PATCH = async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;
    const body = await req.json();

    const chatExists = await db.query.chats.findFirst({
      where: eq(chats.id, id),
    });

    if (!chatExists) {
      return Response.json({ message: 'Chat not found' }, { status: 404 });
    }

    const updates: Partial<typeof chats.$inferInsert> = {};
    if ('projectId' in body) {
      updates.projectId = body.projectId || null;
    }
    if ('title' in body && typeof body.title === 'string') {
      updates.title = body.title.trim();
    }

    if (Object.keys(updates).length > 0) {
      await db.update(chats).set(updates).where(eq(chats.id, id)).run();
    }

    const updated = await db.query.chats.findFirst({
      where: eq(chats.id, id),
    });

    return Response.json({ chat: updated }, { status: 200 });
  } catch (err) {
    console.error('Error in updating chat by id: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
