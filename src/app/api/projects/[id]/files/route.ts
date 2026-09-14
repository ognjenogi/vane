import { NextResponse } from 'next/server';
import ModelRegistry from '@/lib/models/registry';
import UploadManager from '@/lib/uploads/manager';
import { ProjectManager } from '@/lib/projects/manager';

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

    const formData = await req.formData();
    const files = formData.getAll('files') as File[];
    const embeddingModel = formData.get('embedding_model_key') as string;
    const embeddingModelProvider = formData.get(
      'embedding_model_provider_id',
    ) as string;

    if (!embeddingModel || !embeddingModelProvider) {
      return NextResponse.json(
        { message: 'Missing embedding model or provider' },
        { status: 400 },
      );
    }

    if (!files || files.length === 0) {
      return NextResponse.json(
        { message: 'No files provided' },
        { status: 400 },
      );
    }

    const registry = new ModelRegistry();
    const model = await registry.loadEmbeddingModel(
      embeddingModelProvider,
      embeddingModel,
    );

    const uploadManager = new UploadManager({
      embeddingModel: model,
    });

    const processedFiles = await uploadManager.processFiles(files);

    const dbFiles = processedFiles.map((f) => ({
      name: f.fileName,
      fileId: f.fileId,
    }));

    const updatedFiles = await ProjectManager.addProjectFiles(id, dbFiles);

    return NextResponse.json({
      files: updatedFiles,
      added: dbFiles,
    });
  } catch (error) {
    console.error('Error uploading file to project:', error);
    return NextResponse.json(
      { message: 'An error occurred uploading files.' },
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
    const fileId = searchParams.get('fileId');

    if (!fileId) {
      return NextResponse.json(
        { message: 'Missing fileId parameter' },
        { status: 400 },
      );
    }

    const updatedFiles = await ProjectManager.removeProjectFile(id, fileId);
    if (!updatedFiles) {
      return NextResponse.json(
        { message: 'Project not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({ files: updatedFiles }, { status: 200 });
  } catch (error) {
    console.error('Error removing project file:', error);
    return NextResponse.json(
      { message: 'An error occurred removing file.' },
      { status: 500 },
    );
  }
}
