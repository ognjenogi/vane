import db from '@/lib/db';
import { projects, chats, messages, DBFile } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import UploadManager from '@/lib/uploads/manager';
import crypto from 'crypto';

export interface CreateProjectInput {
  name: string;
  description?: string;
  systemInstructions?: string;
  defaultSources?: any;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  systemInstructions?: string;
  defaultSources?: any;
  files?: DBFile[];
}

export class ProjectManager {
  static async listProjects() {
    const allProjects = await db.select().from(projects).all();

    const enriched = await Promise.all(
      allProjects.map(async (project) => {
        const projectChats = await db
          .select({ id: chats.id })
          .from(chats)
          .where(eq(chats.projectId, project.id))
          .all();

        return {
          ...project,
          chatCount: projectChats.length,
          fileCount: project.files?.length || 0,
        };
      }),
    );

    return enriched.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  static async getProject(id: string) {
    const project = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    if (!project) return null;

    const projectChats = await db
      .select({
        id: chats.id,
        title: chats.title,
        createdAt: chats.createdAt,
      })
      .from(chats)
      .where(eq(chats.projectId, id))
      .all();

    return {
      ...project,
      chats: projectChats.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    };
  }

  static async createProject(input: CreateProjectInput) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const newProject = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() || '',
      systemInstructions: input.systemInstructions?.trim() || '',
      defaultSources: input.defaultSources || ['web'],
      files: [],
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(projects).values(newProject).run();
    return newProject;
  }

  static async updateProject(id: string, input: UpdateProjectInput) {
    const existing = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    if (!existing) return null;

    const updates: Partial<typeof projects.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };

    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.description !== undefined)
      updates.description = input.description.trim();
    if (input.systemInstructions !== undefined)
      updates.systemInstructions = input.systemInstructions.trim();
    if (input.defaultSources !== undefined)
      updates.defaultSources = input.defaultSources;
    if (input.files !== undefined) updates.files = input.files;

    await db.update(projects).set(updates).where(eq(projects.id, id)).run();

    return this.getProject(id);
  }

  static async deleteProject(id: string) {
    const project = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    if (!project) return false;

    // 1. Find all chats belonging to this project
    const projectChats = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.projectId, id))
      .all();

    // 2. Delete messages for all project chats
    for (const chat of projectChats) {
      await db.delete(messages).where(eq(messages.chatId, chat.id)).run();
    }

    // 3. Delete the chats
    await db.delete(chats).where(eq(chats.projectId, id)).run();

    // 4. Delete vector chunks and physical files for all project files
    if (project.files && Array.isArray(project.files)) {
      for (const file of project.files) {
        if (file.fileId) {
          UploadManager.deleteFile(file.fileId);
        }
      }
    }

    // 5. Delete the project record
    await db.delete(projects).where(eq(projects.id, id)).run();

    return true;
  }

  static async addProjectFiles(id: string, newFiles: DBFile[]) {
    const project = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    if (!project) return null;

    const existingFiles = project.files || [];
    const updatedFiles = [...existingFiles, ...newFiles];

    await db
      .update(projects)
      .set({
        files: updatedFiles,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(projects.id, id))
      .run();

    return updatedFiles;
  }

  static async removeProjectFile(id: string, fileId: string) {
    const project = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    if (!project) return null;

    const updatedFiles = (project.files || []).filter(
      (f) => f.fileId !== fileId,
    );

    // Delete the underlying file and its vector embeddings
    UploadManager.deleteFile(fileId);

    await db
      .update(projects)
      .set({
        files: updatedFiles,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(projects.id, id))
      .run();

    return updatedFiles;
  }

  static async addChatsToProject(projectId: string, chatIds: string[]) {
    for (const chatId of chatIds) {
      await db
        .update(chats)
        .set({ projectId })
        .where(eq(chats.id, chatId))
        .run();
    }

    await db
      .update(projects)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(projects.id, projectId))
      .run();

    return true;
  }

  static async removeChatFromProject(chatId: string) {
    await db
      .update(chats)
      .set({ projectId: null })
      .where(eq(chats.id, chatId))
      .run();

    return true;
  }
}
