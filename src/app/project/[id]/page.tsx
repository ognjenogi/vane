'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import {
  FolderKanban,
  FileText,
  Upload,
  Trash2,
  MessageSquare,
  Plus,
  Save,
  ArrowLeft,
  Clock,
  Sparkles,
  FolderPlus,
  FolderMinus,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatTimeDifference } from '@/lib/utils';
import DeleteChat from '@/components/DeleteChat';
import AddChatToProjectModal from '@/components/AddChatToProjectModal';

interface DBFile {
  name: string;
  fileId: string;
}

interface ProjectChat {
  id: string;
  title: string;
  createdAt: string;
  sources?: string[];
  files?: DBFile[];
}

interface ProjectData {
  id: string;
  name: string;
  description: string;
  systemInstructions: string;
  files: DBFile[];
  chats: ProjectChat[];
  createdAt: string;
  updatedAt: string;
}

const ProjectDetailPage = () => {
  const routeParams = useParams();
  const id = routeParams?.id as string;
  const router = useRouter();

  const [project, setProject] = useState<ProjectData | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [isAddChatModalOpen, setIsAddChatModalOpen] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');

  const handleRemoveChatFromProject = async (
    chatId: string,
    e: React.MouseEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();

    if (
      !confirm(
        'Remove this conversation from the project? The conversation will remain in your general history.',
      )
    ) {
      return;
    }

    try {
      const res = await fetch(`/api/projects/${id}/chats?chatId=${chatId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success('Conversation removed from project');
        setProject((prev) =>
          prev
            ? {
                ...prev,
                chats: prev.chats.filter((c) => c.id !== chatId),
              }
            : null,
        );
      } else {
        toast.error('Failed to remove conversation');
      }
    } catch {
      toast.error('Error removing conversation');
    }
  };

  const fetchProject = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/projects/${id}`);
      if (!res.ok) {
        if (res.status === 404) {
          toast.error('Project not found');
          router.push('/projects');
          return;
        }
        throw new Error('Failed to load project');
      }
      const data = await res.json();
      setProject(data.project);
      setName(data.project.name || '');
      setDescription(data.project.description || '');
      setInstructions(data.project.systemInstructions || '');
    } catch (err: any) {
      toast.error(err.message || 'Error fetching project');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProject();
  }, [id]);

  const handleSaveDetails = async () => {
    if (!name.trim()) {
      toast.error('Project name cannot be empty');
      return;
    }

    setSavingInstructions(true);
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          systemInstructions: instructions.trim(),
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to update project');
      }

      toast.success('Project details saved');
      setProject((prev) =>
        prev
          ? {
              ...prev,
              name: name.trim(),
              description: description.trim(),
              systemInstructions: instructions.trim(),
            }
          : null,
      );
    } catch (err: any) {
      toast.error(err.message || 'Error saving project');
    } finally {
      setSavingInstructions(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;

    setUploading(true);
    try {
      const formData = new FormData();
      for (let i = 0; i < selectedFiles.length; i++) {
        formData.append('files', selectedFiles[i]);
      }

      const embeddingModelProvider =
        localStorage.getItem('embeddingModelProviderId') ||
        '4cfd5ec1-4531-4f8a-9282-037cc6eec6d1';
      const embeddingModel =
        localStorage.getItem('embeddingModelKey') || 'Xenova/all-MiniLM-L6-v2';

      formData.append('embedding_model_provider_id', embeddingModelProvider);
      formData.append('embedding_model_key', embeddingModel);

      const res = await fetch(`/api/projects/${id}/files`, {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Failed to upload files');
      }

      toast.success('Document(s) successfully indexed into project!');
      setProject((prev) =>
        prev ? { ...prev, files: data.files || [] } : null,
      );
    } catch (err: any) {
      toast.error(err.message || 'Error uploading file');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDeleteFile = async (fileId: string, fileName: string) => {
    if (!confirm(`Remove "${fileName}" from this project's knowledge base?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/projects/${id}/files?fileId=${fileId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error('Failed to delete file');
      }

      toast.success(`Removed ${fileName}`);
      setProject((prev) =>
        prev
          ? {
              ...prev,
              files: prev.files.filter((f) => f.fileId !== fileId),
            }
          : null,
      );
    } catch (err: any) {
      toast.error(err.message || 'Error removing file');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-black/20 border-t-black dark:border-white/20 dark:border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 pb-28">
      {/* Top Breadcrumb & Action Header */}
      <div className="flex items-center justify-between gap-4 mb-6">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1.5 text-xs text-black/60 dark:text-white/60 hover:text-black hover:dark:text-white transition"
        >
          <ArrowLeft size={14} />
          <span>Back to Projects</span>
        </Link>

        <a
          href={`/?projectId=${project.id}`}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-black text-white dark:bg-white dark:text-black text-sm font-medium hover:opacity-90 transition shadow-sm"
        >
          <Plus size={16} />
          <span>Start New Chat in Project</span>
        </a>
      </div>

      {/* Project Meta / Name / Description Card */}
      <div className="p-6 rounded-2xl border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary mb-8 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-4">
          <div className="flex-1">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project Name"
              className="w-full text-2xl font-bold bg-transparent text-black dark:text-white focus:outline-none border-b border-transparent focus:border-black/30 dark:focus:border-white/30 pb-1"
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a short description..."
              className="w-full text-sm text-black/60 dark:text-white/60 bg-transparent focus:outline-none border-b border-transparent focus:border-black/30 dark:focus:border-white/30 pt-1 pb-1"
            />
          </div>

          <button
            onClick={handleSaveDetails}
            disabled={savingInstructions}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary text-xs font-medium text-black/80 dark:text-white/80 hover:bg-light-200 hover:dark:bg-dark-200 transition"
          >
            <Save size={14} />
            <span>{savingInstructions ? 'Saving...' : 'Save Details'}</span>
          </button>
        </div>

        {/* Custom Instructions Sub-Card */}
        <div className="pt-4 border-t border-light-200/60 dark:border-dark-200/60">
          <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-black/70 dark:text-white/70 mb-2">
            <Sparkles size={14} className="text-blue-500" />
            <span>Project Custom Instructions / Persona</span>
          </label>
          <p className="text-xs text-black/50 dark:text-white/50 mb-2">
            Instructions applied automatically to every chat in this workspace (e.g. role, strict formatting, domain context).
          </p>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g., You are an expert Serbian corporate tax lawyer. Always reference official articles and bullet-point your conclusions..."
            rows={3}
            className="w-full p-3 text-xs rounded-xl border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary text-black dark:text-white focus:outline-none focus:ring-1 focus:ring-black/40 dark:focus:ring-white/40 resize-y"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Knowledge Base Card (Left 1 Col) */}
        <div className="lg:col-span-1 flex flex-col gap-4">
          <div className="p-5 rounded-2xl border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm text-black dark:text-white flex items-center gap-2">
                <FileText size={16} />
                <span>Knowledge Base</span>
              </h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-light-200 dark:bg-dark-200 text-black/70 dark:text-white/70">
                {project.files?.length || 0}
              </span>
            </div>

            <p className="text-xs text-black/50 dark:text-white/50 mb-4">
              Documents are indexed using local embeddings and automatically searched during research.
            </p>

            {/* Dropzone Upload Button */}
            <label className="flex flex-col items-center justify-center p-4 rounded-xl border-2 border-dashed border-light-200 dark:border-dark-200 hover:border-black/40 hover:dark:border-white/40 cursor-pointer bg-light-primary/50 dark:bg-dark-primary/50 transition mb-4">
              <Upload size={20} className="text-black/50 dark:text-white/50 mb-1.5" />
              <span className="text-xs font-medium text-black/80 dark:text-white/80">
                {uploading ? 'Chunking & Indexing...' : 'Upload Document'}
              </span>
              <span className="text-[10px] text-black/40 dark:text-white/40 mt-0.5">
                PDF, DOCX, TXT, MD
              </span>
              <input
                type="file"
                multiple
                accept=".pdf,.docx,.txt,.md"
                onChange={handleFileUpload}
                disabled={uploading}
                className="hidden"
              />
            </label>

            {/* File List */}
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {project.files && project.files.length > 0 ? (
                project.files.map((file) => (
                  <div
                    key={file.fileId}
                    className="flex items-center justify-between p-2.5 rounded-lg border border-light-200/50 dark:border-dark-200/50 bg-light-primary dark:bg-dark-primary text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                      <FileText size={14} className="text-blue-500 shrink-0" />
                      <span className="truncate text-black/80 dark:text-white/80" title={file.name}>
                        {file.name}
                      </span>
                    </div>
                    <button
                      onClick={() => handleDeleteFile(file.fileId, file.name)}
                      className="text-black/30 dark:text-white/30 hover:text-red-500 hover:dark:text-red-400 p-1 transition"
                      title="Remove file"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="text-center py-6 text-xs text-black/40 dark:text-white/40">
                  No documents attached yet.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Project Conversations (Right 2 Cols) */}
        <div className="lg:col-span-2">
          <div className="p-5 rounded-2xl border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <MessageSquare size={16} />
                <h3 className="font-semibold text-sm text-black dark:text-white">
                  Project Conversations
                </h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsAddChatModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary text-xs font-medium text-black dark:text-white hover:bg-light-200 hover:dark:bg-dark-200 transition shadow-sm"
                >
                  <FolderPlus size={14} className="text-blue-500" />
                  <span>Add Existing</span>
                </button>
                <span className="text-xs text-black/50 dark:text-white/50">
                  {project.chats?.length || 0} chats
                </span>
              </div>
            </div>

            {project.chats && project.chats.length > 0 ? (
              <div className="space-y-3">
                {project.chats.map((chat) => (
                  <Link
                    key={chat.id}
                    href={`/c/${chat.id}`}
                    className="group flex items-center justify-between p-3.5 rounded-xl border border-light-200/70 dark:border-dark-200/70 bg-light-primary dark:bg-dark-primary hover:border-black/40 dark:hover:border-white/40 transition shadow-sm"
                  >
                    <div className="flex-1 min-w-0 pr-4">
                      <h4 className="text-sm font-medium text-black dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 truncate transition">
                        {chat.title}
                      </h4>
                      <div className="flex items-center gap-1.5 text-[11px] text-black/40 dark:text-white/40 mt-1">
                        <Clock size={11} />
                        <span>{formatTimeDifference(new Date(), new Date(chat.createdAt))}</span>
                      </div>
                    </div>

                    <div
                      className="flex items-center gap-1"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    >
                      <button
                        type="button"
                        onClick={(e) => handleRemoveChatFromProject(chat.id, e)}
                        className="p-1.5 text-black/40 dark:text-white/40 hover:text-amber-600 hover:dark:text-amber-400 rounded-lg hover:bg-light-200 hover:dark:bg-dark-200 transition"
                        title="Remove from project (keeps conversation)"
                      >
                        <FolderMinus size={15} />
                      </button>
                      <DeleteChat
                        chatId={chat.id}
                        chats={project.chats as any}
                        setChats={(updatedChats: any) =>
                          setProject((prev) =>
                            prev ? { ...prev, chats: updatedChats } : null,
                          )
                        }
                      />
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <MessageSquare size={36} className="text-black/20 dark:text-white/20 mb-2" />
                <p className="text-sm text-black/60 dark:text-white/60 mb-3">
                  No conversations yet in this project.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <a
                    href={`/?projectId=${project.id}`}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-black text-white dark:bg-white dark:text-black text-xs font-medium hover:opacity-90 transition shadow-sm"
                  >
                    <Plus size={14} />
                    <span>Start the first conversation</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => setIsAddChatModalOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary text-xs font-medium text-black dark:text-white hover:bg-light-200 hover:dark:bg-dark-200 transition"
                  >
                    <FolderPlus size={14} className="text-blue-500" />
                    <span>Add existing conversation</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <AddChatToProjectModal
        isOpen={isAddChatModalOpen}
        setIsOpen={setIsAddChatModalOpen}
        projectId={project.id}
        projectName={project.name}
        currentProjectChatIds={(project.chats || []).map((c) => c.id)}
        onChatsAdded={() => fetchProject()}
      />
    </div>
  );
};

export default ProjectDetailPage;
