import { NextResponse } from 'next/server';
import { ProjectManager } from '@/lib/projects/manager';
import z from 'zod';

const createProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(100),
  description: z.string().optional().default(''),
  systemInstructions: z.string().optional().default(''),
  defaultSources: z.array(z.string()).optional().default(['web']),
});

export async function GET() {
  try {
    const projects = await ProjectManager.listProjects();
    return NextResponse.json({ projects }, { status: 200 });
  } catch (err) {
    console.error('Error fetching projects:', err);
    return NextResponse.json(
      { message: 'An error occurred fetching projects.' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = createProjectSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { message: 'Invalid input', errors: parsed.error.issues },
        { status: 400 },
      );
    }

    const project = await ProjectManager.createProject(parsed.data);
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    console.error('Error creating project:', err);
    return NextResponse.json(
      { message: 'An error occurred creating project.' },
      { status: 500 },
    );
  }
}
