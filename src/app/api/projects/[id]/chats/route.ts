import { NextResponse } from 'next/server';
import { ProjectManager } from '@/lib/projects/manager';
import z from 'zod';

const addChatsSchema = z.object({
  chatIds: z.array(z.string()).min(1, 'At least one chat ID must be provided'),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const project = await ProjectManager.getProject(id);

    if (!project) {
      return NextResponse.json(
        { message: 'Project not found' },
        { status: 404 },
      );
    }

    const body = await req.json();
    const parsed = addChatsSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { message: 'Invalid input', errors: parsed.error.issues },
        { status: 400 },
      );
    }

    await ProjectManager.addChatsToProject(id, parsed.data.chatIds);
    const updated = await ProjectManager.getProject(id);

    return NextResponse.json({ project: updated }, { status: 200 });
  } catch (error) {
    console.error('Error adding chats to project:', error);
    return NextResponse.json(
      { message: 'An error occurred adding chats to project.' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const chatId = searchParams.get('chatId');

    if (!chatId) {
      return NextResponse.json(
        { message: 'Missing chatId query parameter' },
        { status: 400 },
      );
    }

    await ProjectManager.removeChatFromProject(chatId);
    const updated = await ProjectManager.getProject(id);

    return NextResponse.json({ project: updated }, { status: 200 });
  } catch (error) {
    console.error('Error removing chat from project:', error);
    return NextResponse.json(
      { message: 'An error occurred removing chat from project.' },
      { status: 500 },
    );
  }
}
