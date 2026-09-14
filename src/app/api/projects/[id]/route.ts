import { NextResponse } from 'next/server';
import { ProjectManager } from '@/lib/projects/manager';
import z from 'zod';

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  systemInstructions: z.string().optional(),
  defaultSources: z.array(z.string()).optional(),
});

export async function GET(
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

    return NextResponse.json({ project }, { status: 200 });
  } catch (err) {
    console.error('Error fetching project:', err);
    return NextResponse.json(
      { message: 'An error occurred fetching project.' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const parsed = updateProjectSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { message: 'Invalid input', errors: parsed.error.issues },
        { status: 400 },
      );
    }

    const updated = await ProjectManager.updateProject(id, parsed.data);
    if (!updated) {
      return NextResponse.json(
        { message: 'Project not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({ project: updated }, { status: 200 });
  } catch (err) {
    console.error('Error updating project:', err);
    return NextResponse.json(
      { message: 'An error occurred updating project.' },
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
    const deleted = await ProjectManager.deleteProject(id);

    if (!deleted) {
      return NextResponse.json(
        { message: 'Project not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error('Error deleting project:', err);
    return NextResponse.json(
      { message: 'An error occurred deleting project.' },
      { status: 500 },
    );
  }
}
