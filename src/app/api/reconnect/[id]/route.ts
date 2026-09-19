import SessionManager from '@/lib/session';

export const POST = async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;

    const session = SessionManager.getSession(id);

    if (!session) {
      return Response.json({ message: 'Session not found' }, { status: 404 });
    }

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
      } else if (event === 'error') {
        write({ type: 'error', data: data.data });
        closeStream();
      }
    });

    if (closed) disconnect();

    req.signal.addEventListener('abort', () => {
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
    console.error('Error in reconnecting to session stream: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
