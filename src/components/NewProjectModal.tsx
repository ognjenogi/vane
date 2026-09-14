'use client';

import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
} from '@headlessui/react';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';
import { FolderPlus } from 'lucide-react';

interface NewProjectModalProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  onProjectCreated?: (project: any) => void;
}

const NewProjectModal = ({
  isOpen,
  setIsOpen,
  onProjectCreated,
}: NewProjectModalProps) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemInstructions, setSystemInstructions] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Project name is required');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          systemInstructions: systemInstructions.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Failed to create project');
      }

      toast.success('Project created successfully!');
      setName('');
      setDescription('');
      setSystemInstructions('');
      setIsOpen(false);

      if (onProjectCreated) {
        onProjectCreated(data.project);
      }
    } catch (err: any) {
      toast.error(err.message || 'Error creating project');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog
        as="div"
        className="relative z-50"
        onClose={() => {
          if (!loading) setIsOpen(false);
        }}
      >
        <DialogBackdrop className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 text-center">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="w-full max-w-lg transform rounded-2xl bg-light-primary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 p-6 text-left align-middle shadow-2xl transition-all">
                <div className="flex items-center gap-2 mb-4">
                  <div className="p-2 rounded-lg bg-light-200 dark:bg-dark-200 text-black/80 dark:text-white/80">
                    <FolderPlus size={22} />
                  </div>
                  <DialogTitle className="text-xl font-semibold dark:text-white text-black">
                    New Project
                  </DialogTitle>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wider text-black/60 dark:text-white/60 mb-1">
                      Project Name *
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g., Serbian Tax Law, Quantitative Trading, Thesis"
                      required
                      maxLength={100}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-primary text-black dark:text-white focus:outline-none focus:ring-1 focus:ring-black/40 dark:focus:ring-white/40"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wider text-black/60 dark:text-white/60 mb-1">
                      Description
                    </label>
                    <input
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Brief overview of this workspace..."
                      className="w-full px-3 py-2 text-sm rounded-lg border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-primary text-black dark:text-white focus:outline-none focus:ring-1 focus:ring-black/40 dark:focus:ring-white/40"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wider text-black/60 dark:text-white/60 mb-1">
                      Custom Instructions / Persona
                    </label>
                    <textarea
                      value={systemInstructions}
                      onChange={(e) => setSystemInstructions(e.target.value)}
                      placeholder="Specify the AI's role, rules, tone, or context for all chats in this project (e.g. 'Always answer in Serbian with legal article references')..."
                      rows={4}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-primary text-black dark:text-white focus:outline-none focus:ring-1 focus:ring-black/40 dark:focus:ring-white/40 resize-none"
                    />
                  </div>

                  <div className="flex justify-end gap-3 pt-4 border-t border-light-200/50 dark:border-dark-200/50">
                    <button
                      type="button"
                      onClick={() => setIsOpen(false)}
                      disabled={loading}
                      className="px-4 py-2 text-sm font-medium rounded-lg text-black/60 dark:text-white/60 hover:text-black hover:dark:text-white hover:bg-light-200 hover:dark:bg-dark-200 transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={loading}
                      className="px-5 py-2 text-sm font-medium rounded-lg bg-black text-white dark:bg-white dark:text-black hover:opacity-90 disabled:opacity-50 transition"
                    >
                      {loading ? 'Creating...' : 'Create Project'}
                    </button>
                  </div>
                </form>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
};

export default NewProjectModal;
