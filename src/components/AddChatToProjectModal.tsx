'use client';

import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
} from '@headlessui/react';
import { Fragment, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FolderPlus, Search, Check, MessageSquare, Clock } from 'lucide-react';
import { formatTimeDifference } from '@/lib/utils';

interface ChatItem {
  id: string;
  title: string;
  createdAt: string;
  projectId?: string | null;
}

interface AddChatToProjectModalProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  projectId: string;
  projectName: string;
  currentProjectChatIds?: string[];
  onChatsAdded?: () => void;
}

const AddChatToProjectModal = ({
  isOpen,
  setIsOpen,
  projectId,
  projectName,
  currentProjectChatIds = [],
  onChatsAdded,
}: AddChatToProjectModalProps) => {
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);

  const fetchChats = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/chats');
      const data = await res.json();
      if (res.ok && data.chats) {
        setChats(data.chats);
      }
    } catch (err) {
      console.error('Error loading chats:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchChats();
      setSelectedChatIds([]);
      setSearchQuery('');
    }
  }, [isOpen]);

  const toggleSelectChat = (chatId: string) => {
    setSelectedChatIds((prev) =>
      prev.includes(chatId)
        ? prev.filter((id) => id !== chatId)
        : [...prev, chatId],
    );
  };

  const handleSelectAll = (filteredIds: string[]) => {
    if (filteredIds.every((id) => selectedChatIds.includes(id))) {
      setSelectedChatIds((prev) =>
        prev.filter((id) => !filteredIds.includes(id)),
      );
    } else {
      setSelectedChatIds((prev) => Array.from(new Set([...prev, ...filteredIds])));
    }
  };

  const handleAddChats = async () => {
    if (selectedChatIds.length === 0) {
      toast.error('Please select at least one conversation');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatIds: selectedChatIds }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Failed to add conversations to project');
      }

      toast.success(
        `Added ${selectedChatIds.length} conversation${selectedChatIds.length > 1 ? 's' : ''} to "${projectName}"`,
      );
      setIsOpen(false);
      if (onChatsAdded) onChatsAdded();
    } catch (err: any) {
      toast.error(err.message || 'Error adding conversations');
    } finally {
      setSubmitting(false);
    }
  };

  const availableChats = chats.filter(
    (c) => !currentProjectChatIds.includes(c.id),
  );

  const filteredChats = availableChats.filter((c) =>
    (c.title || 'New Conversation')
      .toLowerCase()
      .includes(searchQuery.toLowerCase()),
  );

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog
        as="div"
        className="relative z-50"
        onClose={() => {
          if (!submitting) setIsOpen(false);
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
                <div className="flex items-center gap-2 mb-2">
                  <div className="p-2 rounded-lg bg-light-200 dark:bg-dark-200 text-black/80 dark:text-white/80">
                    <FolderPlus size={22} />
                  </div>
                  <DialogTitle className="text-lg font-semibold dark:text-white text-black">
                    Add Existing Conversations
                  </DialogTitle>
                </div>
                <p className="text-xs text-black/60 dark:text-white/60 mb-4">
                  Select past conversations to move into &ldquo;{projectName}&rdquo;.
                </p>

                {/* Search */}
                <div className="relative mb-3">
                  <Search
                    size={16}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-black/40 dark:text-white/40"
                  />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search past conversations..."
                    className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-primary text-black dark:text-white focus:outline-none focus:ring-1 focus:ring-black/40 dark:focus:ring-white/40"
                  />
                </div>

                {/* Chats List */}
                <div className="flex items-center justify-between text-xs text-black/50 dark:text-white/50 mb-2 px-1">
                  <span>
                    {selectedChatIds.length} selected
                  </span>
                  {filteredChats.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        handleSelectAll(filteredChats.map((c) => c.id))
                      }
                      className="hover:text-black hover:dark:text-white transition"
                    >
                      {filteredChats.every((c) => selectedChatIds.includes(c.id))
                        ? 'Deselect all'
                        : 'Select all'}
                    </button>
                  )}
                </div>

                <div className="max-h-64 overflow-y-auto space-y-1.5 p-1 rounded-xl border border-light-200/60 dark:border-dark-200/60 bg-light-secondary/50 dark:bg-dark-primary/50">
                  {loading ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="w-5 h-5 border-2 border-black/20 border-t-black dark:border-white/20 dark:border-t-white rounded-full animate-spin" />
                    </div>
                  ) : filteredChats.length === 0 ? (
                    <div className="text-center py-8 text-xs text-black/40 dark:text-white/40">
                      {searchQuery
                        ? 'No matching conversations found.'
                        : 'No conversations available to add.'}
                    </div>
                  ) : (
                    filteredChats.map((chat) => {
                      const isSelected = selectedChatIds.includes(chat.id);
                      return (
                        <div
                          key={chat.id}
                          onClick={() => toggleSelectChat(chat.id)}
                          className={`flex items-center justify-between p-2.5 rounded-lg text-xs cursor-pointer transition select-none ${
                            isSelected
                              ? 'bg-blue-500/10 border border-blue-500/30 dark:bg-blue-500/20'
                              : 'bg-light-primary dark:bg-dark-secondary hover:bg-light-200 dark:hover:bg-dark-primary border border-transparent'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-3">
                            <div
                              className={`w-4 h-4 rounded flex items-center justify-center border transition ${
                                isSelected
                                  ? 'bg-blue-600 border-blue-600 text-white'
                                  : 'border-light-300 dark:border-dark-300'
                              }`}
                            >
                              {isSelected && <Check size={11} strokeWidth={3} />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-black dark:text-white truncate">
                                {chat.title || 'New Conversation'}
                              </p>
                              <div className="flex items-center gap-1.5 text-[10px] text-black/40 dark:text-white/40 mt-0.5">
                                <Clock size={10} />
                                <span>
                                  {formatTimeDifference(
                                    new Date(),
                                    new Date(chat.createdAt),
                                  )}
                                </span>
                                {chat.projectId && (
                                  <span className="text-[10px] px-1 rounded bg-light-200 dark:bg-dark-200 text-black/60 dark:text-white/60">
                                    Already in project
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="flex justify-end gap-3 pt-4 mt-4 border-t border-light-200/50 dark:border-dark-200/50">
                  <button
                    type="button"
                    onClick={() => setIsOpen(false)}
                    disabled={submitting}
                    className="px-4 py-2 text-xs font-medium rounded-lg text-black/60 dark:text-white/60 hover:text-black hover:dark:text-white hover:bg-light-200 hover:dark:bg-dark-200 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleAddChats}
                    disabled={submitting || selectedChatIds.length === 0}
                    className="px-5 py-2 text-xs font-medium rounded-lg bg-black text-white dark:bg-white dark:text-black hover:opacity-90 disabled:opacity-40 transition"
                  >
                    {submitting
                      ? 'Adding...'
                      : `Add ${selectedChatIds.length > 0 ? `(${selectedChatIds.length})` : ''} to Project`}
                  </button>
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
};

export default AddChatToProjectModal;
