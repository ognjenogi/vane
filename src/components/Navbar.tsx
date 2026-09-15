import {
  Clock,
  Edit,
  Share,
  Trash,
  FileText,
  FileDown,
  FolderKanban,
  FolderPlus,
  FolderMinus,
  Check,
} from 'lucide-react';
import { Message } from './ChatWindow';
import { useEffect, useState, Fragment } from 'react';
import { formatTimeDifference } from '@/lib/utils';
import { toast } from 'sonner';
import DeleteChat from './DeleteChat';
import {
  Popover,
  PopoverButton,
  PopoverPanel,
  Transition,
} from '@headlessui/react';
import jsPDF from 'jspdf';
import { useChat, Section } from '@/lib/hooks/useChat';
import { SourceBlock } from '@/lib/types';

const downloadFile = (filename: string, content: string, type: string) => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
};

const exportAsMarkdown = (sections: Section[], title: string) => {
  const date = new Date(
    sections[0].message.createdAt || Date.now(),
  ).toLocaleString();
  let md = `# 💬 Chat Export: ${title}\n\n`;
  md += `*Exported on: ${date}*\n\n---\n`;

  sections.forEach((section, idx) => {
    md += `\n---\n`;
    md += `**🧑 User**  
`;
    md += `*${new Date(section.message.createdAt).toLocaleString()}*\n\n`;
    md += `> ${section.message.query.replace(/\n/g, '\n> ')}\n`;

    if (section.message.responseBlocks.length > 0) {
      md += `\n---\n`;
      md += `**🤖 Assistant**  
`;
      md += `*${new Date(section.message.createdAt).toLocaleString()}*\n\n`;
      md += `> ${section.message.responseBlocks
        .filter((b) => b.type === 'text')
        .map((block) => block.data)
        .join('\n')
        .replace(/\n/g, '\n> ')}\n`;
    }

    const sourceResponseBlock = section.message.responseBlocks.find(
      (block) => block.type === 'source',
    ) as SourceBlock | undefined;

    if (
      sourceResponseBlock &&
      sourceResponseBlock.data &&
      sourceResponseBlock.data.length > 0
    ) {
      md += `\n**Citations:**\n`;
      sourceResponseBlock.data.forEach((src: any, i: number) => {
        const url = src.metadata?.url || '';
        md += `- [${i + 1}] [${url}](${url})\n`;
      });
    }
  });
  md += '\n---\n';
  downloadFile(`${title || 'chat'}.md`, md, 'text/markdown');
};

const exportAsPDF = (sections: Section[], title: string) => {
  const doc = new jsPDF();
  const date = new Date(
    sections[0]?.message?.createdAt || Date.now(),
  ).toLocaleString();
  let y = 15;
  const pageHeight = doc.internal.pageSize.height;
  doc.setFontSize(18);
  doc.text(`Chat Export: ${title}`, 10, y);
  y += 8;
  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(`Exported on: ${date}`, 10, y);
  y += 8;
  doc.setDrawColor(200);
  doc.line(10, y, 200, y);
  y += 6;
  doc.setTextColor(30);

  sections.forEach((section, idx) => {
    if (y > pageHeight - 30) {
      doc.addPage();
      y = 15;
    }
    doc.setFont('helvetica', 'bold');
    doc.text('User', 10, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text(`${new Date(section.message.createdAt).toLocaleString()}`, 40, y);
    y += 6;
    doc.setTextColor(30);
    doc.setFontSize(12);
    const userLines = doc.splitTextToSize(section.message.query, 180);
    for (let i = 0; i < userLines.length; i++) {
      if (y > pageHeight - 20) {
        doc.addPage();
        y = 15;
      }
      doc.text(userLines[i], 12, y);
      y += 6;
    }
    y += 6;
    doc.setDrawColor(230);
    if (y > pageHeight - 10) {
      doc.addPage();
      y = 15;
    }
    doc.line(10, y, 200, y);
    y += 4;

    if (section.message.responseBlocks.length > 0) {
      if (y > pageHeight - 30) {
        doc.addPage();
        y = 15;
      }
      doc.setFont('helvetica', 'bold');
      doc.text('Assistant', 10, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(120);
      doc.text(
        `${new Date(section.message.createdAt).toLocaleString()}`,
        40,
        y,
      );
      y += 6;
      doc.setTextColor(30);
      doc.setFontSize(12);
      const assistantLines = doc.splitTextToSize(
        section.parsedTextBlocks.join('\n'),
        180,
      );
      for (let i = 0; i < assistantLines.length; i++) {
        if (y > pageHeight - 20) {
          doc.addPage();
          y = 15;
        }
        doc.text(assistantLines[i], 12, y);
        y += 6;
      }

      const sourceResponseBlock = section.message.responseBlocks.find(
        (block) => block.type === 'source',
      ) as SourceBlock | undefined;

      if (
        sourceResponseBlock &&
        sourceResponseBlock.data &&
        sourceResponseBlock.data.length > 0
      ) {
        doc.setFontSize(11);
        doc.setTextColor(80);
        if (y > pageHeight - 20) {
          doc.addPage();
          y = 15;
        }
        doc.text('Citations:', 12, y);
        y += 5;
        sourceResponseBlock.data.forEach((src: any, i: number) => {
          const url = src.metadata?.url || '';
          if (y > pageHeight - 15) {
            doc.addPage();
            y = 15;
          }
          doc.text(`- [${i + 1}] ${url}`, 15, y);
          y += 5;
        });
        doc.setTextColor(30);
      }
      y += 6;
      doc.setDrawColor(230);
      if (y > pageHeight - 10) {
        doc.addPage();
        y = 15;
      }
      doc.line(10, y, 200, y);
      y += 4;
    }
  });
  doc.save(`${title || 'chat'}.pdf`);
};

const Navbar = () => {
  const [title, setTitle] = useState<string>('');
  const [timeAgo, setTimeAgo] = useState<string>('');

  const [projectName, setProjectName] = useState<string | null>(null);
  const [allProjects, setAllProjects] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [assigningProject, setAssigningProject] = useState(false);

  const { sections, chatId, projectId, setProjectId } = useChat();

  const fetchAllProjects = async () => {
    try {
      setLoadingProjects(true);
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (res.ok && data.projects) {
        setAllProjects(data.projects);
      }
    } catch (err) {
      console.error('Error fetching projects:', err);
    } finally {
      setLoadingProjects(false);
    }
  };

  const handleAssignProject = async (
    targetProjectId: string | null,
    targetProjectName?: string,
  ) => {
    if (!chatId) return;
    try {
      setAssigningProject(true);
      const res = await fetch(`/api/chats/${chatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: targetProjectId }),
      });

      if (!res.ok) {
        throw new Error('Failed to update chat project');
      }

      setProjectId(targetProjectId);
      if (targetProjectId && targetProjectName) {
        setProjectName(targetProjectName);
        toast.success(`Conversation assigned to "${targetProjectName}"`);
      } else {
        setProjectName(null);
        toast.success('Conversation removed from project');
      }
    } catch (err: any) {
      toast.error(err.message || 'Error updating conversation project');
    } finally {
      setAssigningProject(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetch(`/api/projects/${projectId}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.project?.name) setProjectName(data.project.name);
        })
        .catch(() => {});
    } else {
      setProjectName(null);
    }
  }, [projectId]);

  useEffect(() => {
    if (sections.length > 0 && sections[0].message) {
      const newTitle =
        sections[0].message.query.length > 30
          ? `${sections[0].message.query.substring(0, 30).trim()}...`
          : sections[0].message.query || 'New Conversation';

      setTitle(newTitle);
      const newTimeAgo = formatTimeDifference(
        new Date(),
        sections[0].message.createdAt,
      );
      setTimeAgo(newTimeAgo);
    }
  }, [sections]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      if (sections.length > 0 && sections[0].message) {
        const newTimeAgo = formatTimeDifference(
          new Date(),
          sections[0].message.createdAt,
        );
        setTimeAgo(newTimeAgo);
      }
    }, 1000);

    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="sticky -mx-4 lg:mx-0 top-0 z-40 bg-light-primary/95 dark:bg-dark-primary/95 backdrop-blur-sm border-b border-light-200/50 dark:border-dark-200/30">
      <div className="px-4 lg:px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center min-w-0">
            <a
              href="/"
              className="lg:hidden mr-3 p-2 -ml-2 rounded-lg hover:bg-light-secondary dark:hover:bg-dark-secondary transition-colors duration-200"
            >
              <Edit size={18} className="text-black/70 dark:text-white/70" />
            </a>
            <div className="hidden lg:flex items-center gap-2 text-black/50 dark:text-white/50 min-w-0">
              <Clock size={14} />
              <span className="text-xs whitespace-nowrap">{timeAgo} ago</span>
            </div>
          </div>

          <div className="flex-1 mx-4 min-w-0 flex flex-col items-center justify-center">
            {projectId && (
              <a
                href={`/project/${projectId}`}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 mb-1 rounded-full text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 transition-colors"
                title="View Project Workspace"
              >
                <FolderKanban size={12} />
                <span className="truncate max-w-[150px]">
                  {projectName || 'Project Workspace'}
                </span>
              </a>
            )}
            <h1 className="text-center text-sm font-medium text-black/80 dark:text-white/90 truncate">
              {title || 'New Conversation'}
            </h1>
          </div>

          <div className="flex items-center gap-1 min-w-0">
            {chatId && (
              <Popover className="relative">
                <PopoverButton
                  onClick={fetchAllProjects}
                  className="p-2 rounded-lg hover:bg-light-secondary dark:hover:bg-dark-secondary transition-colors duration-200"
                  title={
                    projectId
                      ? `In Project: ${projectName || 'Workspace'}`
                      : 'Assign to Project'
                  }
                >
                  {projectId ? (
                    <FolderKanban size={16} className="text-blue-500" />
                  ) : (
                    <FolderPlus
                      size={16}
                      className="text-black/60 dark:text-white/60"
                    />
                  )}
                </PopoverButton>
                <Transition
                  as={Fragment}
                  enter="transition ease-out duration-200"
                  enterFrom="opacity-0 translate-y-1"
                  enterTo="opacity-100 translate-y-0"
                  leave="transition ease-in duration-150"
                  leaveFrom="opacity-100 translate-y-0"
                  leaveTo="opacity-0 translate-y-1"
                >
                  <PopoverPanel className="absolute right-0 mt-2 w-64 origin-top-right rounded-2xl bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 shadow-xl shadow-black/10 dark:shadow-black/30 z-50">
                    <div className="p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-medium text-black/40 dark:text-white/40 uppercase tracking-wide">
                          Project Workspace
                        </p>
                        {projectId && (
                          <button
                            type="button"
                            disabled={assigningProject}
                            onClick={() => handleAssignProject(null)}
                            className="text-[11px] text-amber-600 dark:text-amber-400 hover:underline disabled:opacity-50"
                          >
                            Remove
                          </button>
                        )}
                      </div>

                      <div className="space-y-1 max-h-56 overflow-y-auto">
                        {loadingProjects ? (
                          <div className="py-4 text-center text-xs text-black/40 dark:text-white/40">
                            Loading projects...
                          </div>
                        ) : allProjects.length === 0 ? (
                          <div className="py-3 text-center text-xs text-black/40 dark:text-white/40">
                            No projects yet.
                          </div>
                        ) : (
                          allProjects.map((p) => {
                            const isCurrent = p.id === projectId;
                            return (
                              <button
                                key={p.id}
                                type="button"
                                disabled={assigningProject || isCurrent}
                                onClick={() =>
                                  handleAssignProject(p.id, p.name)
                                }
                                className={`w-full flex items-center justify-between px-3 py-2 text-left rounded-xl transition-colors duration-200 text-xs ${
                                  isCurrent
                                    ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium'
                                    : 'hover:bg-light-secondary dark:hover:bg-dark-secondary text-black dark:text-white'
                                }`}
                              >
                                <span className="truncate flex-1 mr-2">
                                  {p.name}
                                </span>
                                {isCurrent && (
                                  <Check size={14} className="shrink-0" />
                                )}
                              </button>
                            );
                          })
                        )}
                      </div>

                      <div className="mt-2 pt-2 border-t border-light-200/50 dark:border-dark-200/50 flex justify-between items-center text-[11px]">
                        <a
                          href="/projects"
                          className="text-blue-500 hover:underline flex items-center gap-1"
                        >
                          Manage Projects &rarr;
                        </a>
                      </div>
                    </div>
                  </PopoverPanel>
                </Transition>
              </Popover>
            )}

            <Popover className="relative">
              <PopoverButton className="p-2 rounded-lg hover:bg-light-secondary dark:hover:bg-dark-secondary transition-colors duration-200">
                <Share size={16} className="text-black/60 dark:text-white/60" />
              </PopoverButton>
              <Transition
                as={Fragment}
                enter="transition ease-out duration-200"
                enterFrom="opacity-0 translate-y-1"
                enterTo="opacity-100 translate-y-0"
                leave="transition ease-in duration-150"
                leaveFrom="opacity-100 translate-y-0"
                leaveTo="opacity-0 translate-y-1"
              >
                <PopoverPanel className="absolute right-0 mt-2 w-64 origin-top-right rounded-2xl bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 shadow-xl shadow-black/10 dark:shadow-black/30 z-50">
                  <div className="p-3">
                    <div className="mb-2">
                      <p className="text-xs font-medium text-black/40 dark:text-white/40 uppercase tracking-wide">
                        Export Chat
                      </p>
                    </div>
                    <div className="space-y-1">
                      <button
                        className="w-full flex items-center gap-3 px-3 py-2 text-left rounded-xl hover:bg-light-secondary dark:hover:bg-dark-secondary transition-colors duration-200"
                        onClick={() => exportAsMarkdown(sections, title || '')}
                      >
                        <FileText size={16} className="text-[#24A0ED]" />
                        <div>
                          <p className="text-sm font-medium text-black dark:text-white">
                            Markdown
                          </p>
                          <p className="text-xs text-black/50 dark:text-white/50">
                            .md format
                          </p>
                        </div>
                      </button>
                      <button
                        className="w-full flex items-center gap-3 px-3 py-2 text-left rounded-xl hover:bg-light-secondary dark:hover:bg-dark-secondary transition-colors duration-200"
                        onClick={() => exportAsPDF(sections, title || '')}
                      >
                        <FileDown size={16} className="text-[#24A0ED]" />
                        <div>
                          <p className="text-sm font-medium text-black dark:text-white">
                            PDF
                          </p>
                          <p className="text-xs text-black/50 dark:text-white/50">
                            Document format
                          </p>
                        </div>
                      </button>
                    </div>
                  </div>
                </PopoverPanel>
              </Transition>
            </Popover>
            <DeleteChat
              redirect
              chatId={chatId!}
              chats={[]}
              setChats={() => {}}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Navbar;
