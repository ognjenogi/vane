import { z } from 'zod';
import SessionManager from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const abortSchema = z.object({
  sessionId: z.string().optional(),
  chatId: z.string().optional(),
  messageId: z.string().optional(),
});

export const POST = async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = abortSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json(
        { message: 'Invalid abort request' },
        { status: 400 },
      );
    }

    const session = SessionManager.findSession(parsed.data);

    if (session) {
      session.abort();
      return Response.json({
        success: true,
        aborted: true,
        sessionId: session.id,
      });
    }

    return Response.json({
      success: true,
      aborted: false,
      message: 'No active session found to abort',
    });
  } catch (err) {
    console.error('Error in chat abort:', err);
    return Response.json(
      { message: 'Internal server error while aborting chat' },
      { status: 500 },
    );
  }
};
