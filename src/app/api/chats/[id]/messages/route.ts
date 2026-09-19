import db from '@/lib/db';
import { chats, messages } from '@/lib/db/schema';
import { and, eq, gte } from 'drizzle-orm';

// Deletes a message and every later message in the same chat (by insertion
// order). Used by rewrite/edit so stale rows do not reappear after a reload.
export const DELETE = async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id: chatId } = await params;
    const afterMessageId = new URL(req.url).searchParams.get('afterMessageId');

    if (!afterMessageId) {
      return Response.json(
        { message: 'afterMessageId query parameter is required' },
        { status: 400 },
      );
    }

    const chatExists = await db.query.chats.findFirst({
      where: eq(chats.id, chatId),
    });

    if (!chatExists) {
      return Response.json({ message: 'Chat not found' }, { status: 404 });
    }

    const anchor = await db.query.messages.findFirst({
      where: eq(messages.messageId, afterMessageId),
    });

    if (!anchor || anchor.chatId !== chatId) {
      return Response.json({ message: 'Message not found' }, { status: 404 });
    }

    await db
      .delete(messages)
      .where(and(eq(messages.chatId, chatId), gte(messages.id, anchor.id)))
      .execute();

    return Response.json(
      { message: 'Messages deleted successfully' },
      { status: 200 },
    );
  } catch (err) {
    console.error('Error in deleting messages: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
