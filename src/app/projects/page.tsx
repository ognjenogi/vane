'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  FolderKanban,
  Plus,
  Files,
  MessageSquare,
  Trash2,
  ExternalLink,
  Search,
} from 'lucide-react';
import NewProjectModal from '@/components/NewProjectModal';
import { toast } from 'sonner';

interface ProjectListItem {
  id: string;
  name: string;
  description: string;
  systemInstructions: string;
  chatCount: number;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

const ProjectsPage = () => {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (res.ok) {
        setProjects(data.projects || []);
      } else {
        toast.error(data.message || 'Failed to load projects');
      }
    } catch (err: any) {
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const handleDeleteProject = async (id: string, name: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!confirm(`Are you sure you want to delete project "${name}"? This will delete all attached documents and project chats.`)) {
      return;
    }

    setDeletingId(id);
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success(`Project "${name}" deleted`);
        setProjects((prev) => prev.filter((p) => p.id !== id));
      } else {
        const data = await res.json();
        toast.error(data.message || 'Failed to delete project');
      }
    } catch (err) {
      toast.error('An error occurred deleting the project');
    } finally {
      setDeletingId(null);
    }
  };

  const filteredProjects = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 pb-24">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-8 border-b border-light-200 dark:border-dark-200">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-2xl bg-light-200 dark:bg-dark-200 text-black/80 dark:text-white/80">
            <FolderKanban size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-semibold dark:text-white text-black">
              Projects
            </h1>
            <p className="text-sm text-black/60 dark:text-white/60">
              Workspaces with dedicated document knowledge bases and custom personas.
            </p>
          </div>
        </div>

        <button
          onClick={() => setIsNewModalOpen(true)}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-black text-white dark:bg-white dark:text-black font-medium text-sm hover:opacity-90 transition shadow-sm"
        >
          <Plus size={18} />
          <span>New Project</span>
        </button>
      </div>

      {/* Search Bar */}
      <div className="my-6">
        <div className="relative max-w-md">
          <Search
            size={18}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-black/40 dark:text-white/40"
          />
          <input
            type="text"
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm rounded-xl border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary text-black dark:text-white focus:outline-none focus:ring-1 focus:ring-black/40 dark:focus:ring-white/40"
          />
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <div className="w-8 h-8 border-2 border-black/20 border-t-black dark:border-white/20 dark:border-t-white rounded-full animate-spin" />
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center min-h-[40vh] text-center p-8 rounded-2xl border border-dashed border-light-200 dark:border-dark-200 bg-light-secondary/30 dark:bg-dark-secondary/30">
          <FolderKanban size={48} className="text-black/30 dark:text-white/30 mb-3" />
          <h3 className="text-lg font-medium text-black dark:text-white">
            {searchQuery ? 'No matching projects found' : 'No projects yet'}
          </h3>
          <p className="text-sm text-black/60 dark:text-white/60 max-w-sm mt-1 mb-4">
            {searchQuery
              ? 'Try a different search term.'
              : 'Create a project to store shared documents, tailor AI instructions, and group your research.'}
          </p>
          {!searchQuery && (
            <button
              onClick={() => setIsNewModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-black text-white dark:bg-white dark:text-black text-sm font-medium hover:opacity-90 transition"
            >
              <Plus size={16} />
              <span>Create your first project</span>
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredProjects.map((project) => (
            <Link
              key={project.id}
              href={`/project/${project.id}`}
              className="group relative flex flex-col justify-between p-5 rounded-2xl border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary hover:border-black/30 dark:hover:border-white/30 transition shadow-sm hover:shadow-md"
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h2 className="text-lg font-semibold text-black dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition line-clamp-1">
                    {project.name}
                  </h2>
                  <button
                    onClick={(e) => handleDeleteProject(project.id, project.name, e)}
                    disabled={deletingId === project.id}
                    title="Delete project"
                    className="p-1.5 text-black/40 dark:text-white/40 hover:text-red-500 hover:dark:text-red-400 rounded-lg hover:bg-light-200 hover:dark:bg-dark-200 transition"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>

                <p className="text-xs text-black/60 dark:text-white/60 line-clamp-2 min-h-[32px] mb-4">
                  {project.description || 'No description provided.'}
                </p>

                {project.systemInstructions && (
                  <div className="p-2.5 rounded-lg bg-light-200/60 dark:bg-dark-primary/60 border border-light-200/40 dark:border-dark-200/40 mb-4">
                    <p className="text-[11px] text-black/70 dark:text-white/70 italic line-clamp-2">
                      &ldquo;{project.systemInstructions}&rdquo;
                    </p>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-light-200/60 dark:border-dark-200/60 text-xs text-black/50 dark:text-white/50">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1" title="Attached documents">
                    <Files size={14} />
                    {project.fileCount}
                  </span>
                  <span className="flex items-center gap-1" title="Conversations">
                    <MessageSquare size={14} />
                    {project.chatCount}
                  </span>
                </div>
                <span className="flex items-center gap-1 group-hover:translate-x-0.5 transition font-medium">
                  Open <ExternalLink size={12} />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* New Project Modal */}
      <NewProjectModal
        isOpen={isNewModalOpen}
        setIsOpen={setIsNewModalOpen}
        onProjectCreated={() => fetchProjects()}
      />
    </div>
  );
};

export default ProjectsPage;
