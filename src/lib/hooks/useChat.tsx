'use client';

import { Message } from '@/components/ChatWindow';
import { Block } from '@/lib/types';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import crypto from 'crypto';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { getSuggestions } from '../actions';
import { MinimalProvider } from '../models/types';
import { getAutoMediaSearch } from '../config/clientRegistry';
import { applyPatch } from 'rfc6902';
import { Widget } from '@/components/ChatWindow';

export type Section = {
  message: Message;
  widgets: Widget[];
  parsedTextBlocks: string[];
  speechMessage: string;
  thinkingEnded: boolean;
  suggestions?: string[];
};

type ChatContext = {
  messages: Message[];
  sections: Section[];
  chatHistory: [string, string][];
  files: File[];
  fileIds: string[];
  sources: string[];
  chatId: string | undefined;
  optimizationMode: string;
  isMessagesLoaded: boolean;
  loading: boolean;
  notFound: boolean;
  messageAppeared: boolean;
  isReady: boolean;
  hasError: boolean;
  chatModelProvider: ChatModelProvider;
  embeddingModelProvider: EmbeddingModelProvider;
  researchEnded: boolean;
  setResearchEnded: (ended: boolean) => void;
  setOptimizationMode: (mode: string) => void;
  setSources: (sources: string[]) => void;
  setFiles: (files: File[]) => void;
  setFileIds: (fileIds: string[]) => void;
  sendMessage: (message: string, messageId?: string) => Promise<void>;
  rewrite: (messageId: string) => void;
  editMessage: (messageId: string, content: string) => void;
  setChatModelProvider: (provider: ChatModelProvider) => void;
  setEmbeddingModelProvider: (provider: EmbeddingModelProvider) => void;
  projectId: string | null;
  setProjectId: (id: string | null) => void;
};

export interface File {
  fileName: string;
  fileExtension: string;
  fileId: string;
}

interface ChatModelProvider {
  key: string;
  providerId: string;
}

interface EmbeddingModelProvider {
  key: string;
  providerId: string;
}

const STREAM_STALL_TIMEOUT_MS = 30000;
const RECONNECT_DELAYS_MS = [1000, 2000, 3000];
const CONTENT_STALL_TIMEOUT_MS = 120000;

const checkConfig = async (
  setChatModelProvider: (provider: ChatModelProvider) => void,
  setEmbeddingModelProvider: (provider: EmbeddingModelProvider) => void,
  setIsConfigReady: (ready: boolean) => void,
  setHasError: (hasError: boolean) => void,
) => {
  try {
    let chatModelKey = localStorage.getItem('chatModelKey');
    let chatModelProviderId = localStorage.getItem('chatModelProviderId');
    let embeddingModelKey = localStorage.getItem('embeddingModelKey');
    let embeddingModelProviderId = localStorage.getItem(
      'embeddingModelProviderId',
    );

    const res = await fetch(`/api/providers`, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(
        `Provider fetching failed with status code ${res.status}`,
      );
    }

    const data = await res.json();
    const providers: MinimalProvider[] = data.providers;

    if (providers.length === 0) {
      throw new Error(
        'No chat model providers found, please configure them in the settings page.',
      );
    }

    const chatModelProvider =
      providers.find((p) => p.id === chatModelProviderId) ??
      providers.find((p) => p.chatModels.length > 0);

    if (!chatModelProvider) {
      throw new Error(
        'No chat models found, pleae configure them in the settings page.',
      );
    }

    chatModelProviderId = chatModelProvider.id;

    const chatModel =
      chatModelProvider.chatModels.find((m) => m.key === chatModelKey) ??
      chatModelProvider.chatModels[0];
    chatModelKey = chatModel.key;

    const embeddingModelProvider =
      providers.find((p) => p.id === embeddingModelProviderId) ??
      providers.find((p) => p.embeddingModels.length > 0);

    if (!embeddingModelProvider) {
      throw new Error(
        'No embedding models found, pleae configure them in the settings page.',
      );
    }

    embeddingModelProviderId = embeddingModelProvider.id;

    const embeddingModel =
      embeddingModelProvider.embeddingModels.find(
        (m) => m.key === embeddingModelKey,
      ) ?? embeddingModelProvider.embeddingModels[0];
    embeddingModelKey = embeddingModel.key;

    localStorage.setItem('chatModelKey', chatModelKey);
    localStorage.setItem('chatModelProviderId', chatModelProviderId);
    localStorage.setItem('embeddingModelKey', embeddingModelKey);
    localStorage.setItem('embeddingModelProviderId', embeddingModelProviderId);

    setChatModelProvider({
      key: chatModelKey,
      providerId: chatModelProviderId,
    });

    setEmbeddingModelProvider({
      key: embeddingModelKey,
      providerId: embeddingModelProviderId,
    });

    setIsConfigReady(true);
  } catch (err: any) {
    console.error('An error occurred while checking the configuration:', err);
    toast.error(err.message);
    setIsConfigReady(false);
    setHasError(true);
  }
};

const loadMessages = async (
  chatId: string,
  setMessages: (messages: Message[]) => void,
  setIsMessagesLoaded: (loaded: boolean) => void,
  chatHistory: React.MutableRefObject<[string, string][]>,
  setSources: (sources: string[]) => void,
  setNotFound: (notFound: boolean) => void,
  setFiles: (files: File[]) => void,
  setFileIds: (fileIds: string[]) => void,
  setProjectId?: (id: string | null) => void,
) => {
  const res = await fetch(`/api/chats/${chatId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (res.status === 404) {
    setNotFound(true);
    setIsMessagesLoaded(true);
    return;
  }

  const data = await res.json();

  const messages = data.messages as Message[];

  setMessages(messages);

  const history: [string, string][] = [];
  messages.forEach((msg) => {
    history.push(['human', msg.query]);

    const textBlocks = msg.responseBlocks
      .filter(
        (block): block is Block & { type: 'text' } => block.type === 'text',
      )
      .map((block) => block.data)
      .join('\n');

    if (textBlocks) {
      history.push(['assistant', textBlocks]);
    }
  });

  console.debug(new Date(), 'app:messages_loaded');

  if (messages.length > 0) {
    document.title = messages[0].query;
  }

  const files = data.chat.files.map((file: any) => {
    return {
      fileName: file.name,
      fileExtension: file.name.split('.').pop(),
      fileId: file.fileId,
    };
  });

  setFiles(files);
  setFileIds(files.map((file: File) => file.fileId));

  if (setProjectId) {
    setProjectId(data.chat?.projectId || null);
  }

  chatHistory.current = history;
  setSources(data.chat.sources);
  setIsMessagesLoaded(true);
};

export const chatContext = createContext<ChatContext>({
  chatHistory: [],
  chatId: '',
  fileIds: [],
  files: [],
  sources: [],
  hasError: false,
  isMessagesLoaded: false,
  isReady: false,
  loading: false,
  messageAppeared: false,
  messages: [],
  sections: [],
  notFound: false,
  optimizationMode: '',
  chatModelProvider: { key: '', providerId: '' },
  embeddingModelProvider: { key: '', providerId: '' },
  researchEnded: false,
  rewrite: () => {},
  editMessage: () => {},
  sendMessage: async () => {},
  setFileIds: () => {},
  setFiles: () => {},
  setSources: () => {},
  setOptimizationMode: () => {},
  setChatModelProvider: () => {},
  setEmbeddingModelProvider: () => {},
  setResearchEnded: () => {},
  projectId: null,
  setProjectId: () => {},
});

export const ChatProvider = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();
  const params: { chatId: string } = useParams();

  const searchParams = useSearchParams();
  const initialMessage = searchParams.get('q');
  const projectIdParam = searchParams.get('projectId');
  const [projectId, setProjectIdState] = useState<string | null>(
    projectIdParam || null,
  );
  const lastParamProjectIdRef = useRef<string | null>(projectIdParam || null);

  const setProjectId = (id: string | null) => {
    setProjectIdState(id);
    if (!id) {
      lastParamProjectIdRef.current = null;
      if (typeof window !== 'undefined' && !params.chatId) {
        const url = new URL(window.location.href);
        if (url.searchParams.has('projectId')) {
          url.searchParams.delete('projectId');
          window.history.replaceState(
            null,
            '',
            url.pathname + (url.search ? url.search : ''),
          );
        }
      }
    } else {
      lastParamProjectIdRef.current = id;
    }
  };

  const [chatId, setChatId] = useState<string | undefined>(params.chatId);
  const [newChatCreated, setNewChatCreated] = useState(false);

  const [loading, setLoading] = useState(false);
  const [messageAppeared, setMessageAppeared] = useState(false);

  const [researchEnded, setResearchEnded] = useState(false);

  const chatHistory = useRef<[string, string][]>([]);
  const [messages, setMessages] = useState<Message[]>([]);

  const [files, setFiles] = useState<File[]>([]);
  const [fileIds, setFileIds] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>(['web']);
  const [optimizationMode, setOptimizationModeState] = useState('speed');

  useEffect(() => {
    const saved = localStorage.getItem('optimizationMode');
    if (saved && ['speed', 'balanced', 'quality', 'superfast'].includes(saved)) {
      setOptimizationModeState(saved);
    }
  }, []);

  const setOptimizationMode = (mode: string) => {
    setOptimizationModeState(mode);
    localStorage.setItem('optimizationMode', mode);
  };

  const [isMessagesLoaded, setIsMessagesLoaded] = useState(false);

  const [notFound, setNotFound] = useState(false);

  const [chatModelProvider, setChatModelProvider] = useState<ChatModelProvider>(
    {
      key: '',
      providerId: '',
    },
  );

  const [embeddingModelProvider, setEmbeddingModelProvider] =
    useState<EmbeddingModelProvider>({
      key: '',
      providerId: '',
    });

  const [isConfigReady, setIsConfigReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const messagesRef = useRef<Message[]>([]);

  const sections = useMemo<Section[]>(() => {
    return messages.map((msg) => {
      const textBlocks: string[] = [];
      let speechMessage = '';
      let thinkingEnded = false;
      let suggestions: string[] = [];

      const sourceBlocks = msg.responseBlocks.filter(
        (block): block is Block & { type: 'source' } => block.type === 'source',
      );
      const sources = sourceBlocks.flatMap((block) => block.data);

      const widgetBlocks = msg.responseBlocks
        .filter((b) => b.type === 'widget')
        .map((b) => b.data) as Widget[];

      msg.responseBlocks.forEach((block) => {
        if (block.type === 'text') {
          let processedText = block.data;
          const citationRegex = /\[([^\]]+)\]/g;
          const regex = /\[(\d+)\]/g;

          if (processedText.includes('<think>')) {
            const openThinkTag = processedText.match(/<think>/g)?.length || 0;
            const closeThinkTag =
              processedText.match(/<\/think>/g)?.length || 0;

            if (openThinkTag && !closeThinkTag) {
              processedText += '</think> <a> </a>';
            }
          }

          if (block.data.includes('</think>')) {
            thinkingEnded = true;
          }

          if (sources.length > 0) {
            processedText = processedText.replace(
              citationRegex,
              (_, capturedContent: string) => {
                const numbers = capturedContent
                  .split(',')
                  .map((numStr) => numStr.trim());

                const linksHtml = numbers
                  .map((numStr) => {
                    const number = parseInt(numStr);

                    if (isNaN(number) || number <= 0) {
                      return `[${numStr}]`;
                    }

                    const source = sources[number - 1];
                    const url = source?.metadata?.url;

                    if (url) {
                      return `<citation href="${url}">${numStr}</citation>`;
                    } else {
                      return ``;
                    }
                  })
                  .join('');

                return linksHtml;
              },
            );
            speechMessage += block.data.replace(regex, '');
          } else {
            processedText = processedText.replace(regex, '');
            speechMessage += block.data.replace(regex, '');
          }

          textBlocks.push(processedText);
        } else if (block.type === 'suggestion') {
          suggestions = block.data;
        }
      });

      return {
        message: msg,
        parsedTextBlocks: textBlocks,
        speechMessage,
        thinkingEnded,
        suggestions,
        widgets: widgetBlocks,
      };
    });
  }, [messages]);

  const isReconnectingRef = useRef(false);
  const handledMessageEndRef = useRef<Set<string>>(new Set());
  const serverSessionIdsRef = useRef<Record<string, string>>({});

  const checkReconnect = async () => {
    if (isReconnectingRef.current) return;

    setIsReady(true);
    console.debug(new Date(), 'app:ready');

    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];

      if (lastMsg.status === 'answering') {
        setLoading(true);
        setResearchEnded(false);
        setMessageAppeared(false);

        isReconnectingRef.current = true;

        try {
          await recoverStream(lastMsg);
        } finally {
          isReconnectingRef.current = false;
        }
      }
    }
  };

  useEffect(() => {
    checkConfig(
      setChatModelProvider,
      setEmbeddingModelProvider,
      setIsConfigReady,
      setHasError,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const pId = searchParams.get('projectId');
    if (pId !== lastParamProjectIdRef.current) {
      lastParamProjectIdRef.current = pId;
      setProjectIdState(pId);
    } else if (!params.chatId && !pId && projectId) {
      setProjectIdState(null);
    }
  }, [searchParams, params.chatId]);

  useEffect(() => {
    if (params.chatId && params.chatId !== chatId) {
      setChatId(params.chatId);
      setMessages([]);
      chatHistory.current = [];
      setFiles([]);
      setFileIds([]);
      setIsMessagesLoaded(false);
      setNotFound(false);
      setNewChatCreated(false);
    } else if (!params.chatId && chatId && !newChatCreated) {
      setChatId(crypto.randomBytes(20).toString('hex'));
      setMessages([]);
      chatHistory.current = [];
      setFiles([]);
      setFileIds([]);
      setIsMessagesLoaded(true);
      setNotFound(false);
      setNewChatCreated(true);
    }
  }, [params.chatId, chatId, newChatCreated]);

  useEffect(() => {
    if (
      chatId &&
      !newChatCreated &&
      !isMessagesLoaded &&
      messages.length === 0
    ) {
      loadMessages(
        chatId,
        setMessages,
        setIsMessagesLoaded,
        chatHistory,
        setSources,
        setNotFound,
        setFiles,
        setFileIds,
        setProjectId,
      );
    } else if (!chatId) {
      setNewChatCreated(true);
      setIsMessagesLoaded(true);
      setChatId(crypto.randomBytes(20).toString('hex'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isMessagesLoaded, newChatCreated, messages.length]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (isMessagesLoaded && isConfigReady && newChatCreated) {
      setIsReady(true);
      console.debug(new Date(), 'app:ready');
    } else if (isMessagesLoaded && isConfigReady && !newChatCreated) {
      checkReconnect();
    } else {
      setIsReady(false);
    }
  }, [isMessagesLoaded, isConfigReady, newChatCreated]);

  const trimMessagesFrom = async (messageId: string) => {
    if (!chatId) return;

    try {
      await fetch(
        `/api/chats/${chatId}/messages?afterMessageId=${encodeURIComponent(messageId)}`,
        { method: 'DELETE' },
      );
    } catch (error) {
      console.warn('Failed to trim later messages:', error);
    }
  };

  const rewrite = async (messageId: string) => {
    const index = messages.findIndex((msg) => msg.messageId === messageId);

    if (index === -1) return;

    setMessages((prev) => prev.slice(0, index));

    chatHistory.current = chatHistory.current.slice(0, index * 2);

    const messageToRewrite = messages[index];
    await trimMessagesFrom(messageId);
    sendMessage(messageToRewrite.query, messageToRewrite.messageId);
  };

  const editMessage = (messageId: string, content: string) => {
    if (loading) return;

    const trimmed = content.trim();
    if (!trimmed) return;

    const index = messages.findIndex((msg) => msg.messageId === messageId);
    if (index === -1 || messages[index].query === trimmed) return;

    setMessages((prev) => prev.slice(0, index));
    chatHistory.current = chatHistory.current.slice(0, index * 2);

    trimMessagesFrom(messageId).then(() => sendMessage(trimmed, messageId));
  };

  useEffect(() => {
    let knownBuildId: string | null = null;

    const checkBuildId = async () => {
      try {
        const res = await fetch('/api/version');

        if (!res.ok) return;

        const { buildId } = await res.json();

        if (typeof buildId !== 'string' || !buildId) return;

        if (knownBuildId === null) {
          knownBuildId = buildId;
        } else if (buildId !== knownBuildId) {
          toast.info('Vane was updated — reloading…');
          setTimeout(() => window.location.reload(), 1200);
        }
      } catch {}
    };

    checkBuildId();
    const interval = setInterval(checkBuildId, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isReady && initialMessage && isConfigReady) {
      if (!isConfigReady) {
        toast.error('Cannot send message before the configuration is ready');
        return;
      }
      sendMessage(initialMessage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfigReady, isReady, initialMessage]);

  const getMessageHandler = (message: Message) => {
    const messageId = message.messageId;

    return async (data: any) => {
      if (data.type === 'sessionId') {
        serverSessionIdsRef.current[messageId] = String(data.data);
        return;
      }

      if (data.type === 'error') {
        toast.error(data.data);
        setLoading(false);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.messageId === messageId
              ? { ...msg, status: 'error' as const }
              : msg,
          ),
        );
        return;
      }

      if (data.type === 'researchComplete') {
        setResearchEnded(true);
        if (
          message.responseBlocks.find(
            (b) => b.type === 'source' && b.data.length > 0,
          )
        ) {
          setMessageAppeared(true);
        }
      }

      if (data.type === 'block') {
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.messageId === messageId) {
              const exists = msg.responseBlocks.findIndex(
                (b) => b.id === data.block.id,
              );

              if (exists !== -1) {
                const existingBlocks = [...msg.responseBlocks];
                existingBlocks[exists] = data.block;

                return {
                  ...msg,
                  responseBlocks: existingBlocks,
                };
              }

              return {
                ...msg,
                responseBlocks: [...msg.responseBlocks, data.block],
              };
            }
            return msg;
          }),
        );

        if (
          (data.block.type === 'source' && data.block.data.length > 0) ||
          data.block.type === 'text'
        ) {
          setMessageAppeared(true);
        }
      }

      if (data.type === 'updateBlock') {
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.messageId === messageId) {
              const updatedBlocks = msg.responseBlocks.map((block) => {
                if (block.id === data.blockId) {
                  const updatedBlock = { ...block };
                  applyPatch(updatedBlock, data.patch);
                  return updatedBlock;
                }
                return block;
              });
              return { ...msg, responseBlocks: updatedBlocks };
            }
            return msg;
          }),
        );
      }

      if (data.type === 'messageEnd') {
        if (handledMessageEndRef.current.has(messageId)) {
          return;
        }

        handledMessageEndRef.current.add(messageId);

        const currentMsg = messagesRef.current.find(
          (msg) => msg.messageId === messageId,
        );

        const newHistory: [string, string][] = [
          ...chatHistory.current,
          ['human', message.query],
          [
            'assistant',
            currentMsg?.responseBlocks.find((b) => b.type === 'text')?.data ||
              '',
          ],
        ];

        chatHistory.current = newHistory;

        setMessages((prev) =>
          prev.map((msg) =>
            msg.messageId === messageId
              ? { ...msg, status: 'completed' as const }
              : msg,
          ),
        );

        setLoading(false);

        const lastMsg = messagesRef.current[messagesRef.current.length - 1];

        const autoMediaSearch = getAutoMediaSearch();

        if (autoMediaSearch) {
          setTimeout(() => {
            document
              .getElementById(`search-images-${lastMsg.messageId}`)
              ?.click();

            document
              .getElementById(`search-videos-${lastMsg.messageId}`)
              ?.click();
          }, 200);
        }

        // Check if there are sources and no suggestions

        const hasSourceBlocks = currentMsg?.responseBlocks.some(
          (block) => block.type === 'source' && block.data.length > 0,
        );
        const hasSuggestions = currentMsg?.responseBlocks.some(
          (block) => block.type === 'suggestion',
        );

        if (hasSourceBlocks && !hasSuggestions) {
          const suggestions = await getSuggestions(newHistory);
          const suggestionBlock: Block = {
            id: crypto.randomBytes(7).toString('hex'),
            type: 'suggestion',
            data: suggestions,
          };

          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.messageId === messageId) {
                return {
                  ...msg,
                  responseBlocks: [...msg.responseBlocks, suggestionBlock],
                };
              }
              return msg;
            }),
          );
        }
      }
    };
  };

  const consumeStream = async (res: Response, message: Message) => {
    if (!res.ok) {
      let detail = `Request failed with status ${res.status}`;
      try {
        const body = await res.json();
        if (body?.message) detail = String(body.message);
        if (Array.isArray(body?.error) && body.error[0]?.message) {
          detail += `: ${body.error[0].path} ${body.error[0].message}`;
        }
      } catch {}
      throw new Error(detail);
    }
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const messageHandler = getMessageHandler(message);
    let partialChunk = '';
    let lastDataAt = Date.now();
    let lastContentAt = Date.now();
    let stalled = false;
    let contentStalled = false;

    const watchdog = setInterval(() => {
      const now = Date.now();

      if (now - lastDataAt > STREAM_STALL_TIMEOUT_MS) {
        stalled = true;
        reader.cancel().catch(() => {});
      } else if (now - lastContentAt > CONTENT_STALL_TIMEOUT_MS) {
        contentStalled = true;
        reader.cancel().catch(() => {});
      }
    }, 5000);

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        lastDataAt = Date.now();
        partialChunk += decoder.decode(value, { stream: true });

        try {
          const lines = partialChunk.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            const parsed = JSON.parse(line);

            if (
              parsed?.type === 'block' ||
              parsed?.type === 'updateBlock' ||
              parsed?.type === 'researchComplete' ||
              parsed?.type === 'messageEnd' ||
              parsed?.type === 'error'
            ) {
              lastContentAt = Date.now();
            }

            messageHandler(parsed);
          }
          partialChunk = '';
        } catch (error) {
          console.warn('Incomplete JSON, waiting for next chunk...');
        }
      }
    } finally {
      clearInterval(watchdog);
    }

    if (stalled) throw new Error('Stream stalled');
    if (contentStalled) throw new Error('No answer progress');
  };

  const recoverStream = async (message: Message) => {
    setLoading(true);

    const backendId =
      serverSessionIdsRef.current[message.messageId] || message.backendId;

    for (const delay of RECONNECT_DELAYS_MS) {
      const sleep = Promise.withResolvers<void>();
      setTimeout(sleep.resolve, delay);
      await sleep.promise;

      try {
        const res = await fetch(`/api/reconnect/${backendId}`, {
          method: 'POST',
        });
        await consumeStream(res, message);
        return;
      } catch (error) {
        console.warn('Reconnect attempt failed:', error);
      }
    }

    setMessages((prev) =>
      prev.map((msg) =>
        msg.messageId === message.messageId
          ? { ...msg, status: 'error' as const }
          : msg,
      ),
    );
    setLoading(false);
    toast.error('Lost connection to the server. Please try again.');
  };

  const sendMessage: ChatContext['sendMessage'] = async (
    message,
    messageId,
  ) => {
    if (loading || !message) return;
    setLoading(true);
    setResearchEnded(false);
    setMessageAppeared(false);

    if (messages.length <= 1) {
      window.history.replaceState(null, '', `/c/${chatId}`);
    }

    messageId = messageId ?? crypto.randomBytes(7).toString('hex');
    // Edit/rewrite re-send an existing messageId; allow its new messageEnd to
    // be processed instead of being swallowed by the once-only dedupe.
    handledMessageEndRef.current.delete(messageId);
    const backendId = crypto.randomBytes(20).toString('hex');

    const newMessage: Message = {
      messageId,
      chatId: chatId!,
      backendId,
      query: message,
      responseBlocks: [],
      status: 'answering',
      createdAt: new Date(),
    };

    setMessages((prevMessages) => [...prevMessages, newMessage]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: message,
          message: {
            messageId: messageId,
            chatId: chatId!,
            content: message,
          },
          chatId: chatId!,
          files: fileIds,
          sources: sources,
          optimizationMode: optimizationMode,
          history: chatHistory.current,
          chatModel: {
            key: chatModelProvider.key,
            providerId: chatModelProvider.providerId,
          },
          embeddingModel: {
            key: embeddingModelProvider.key,
            providerId: embeddingModelProvider.providerId,
          },
          systemInstructions: localStorage.getItem('systemInstructions'),
          projectId: projectId || undefined,
        }),
      });

      await consumeStream(res, newMessage);
    } catch (error) {
      console.warn('Chat stream interrupted, reconnecting:', error);
      await recoverStream(newMessage);
    }
  };

  return (
    <chatContext.Provider
      value={{
        messages,
        sections,
        chatHistory: chatHistory.current,
        files,
        fileIds,
        sources,
        chatId,
        hasError,
        isMessagesLoaded,
        isReady,
        loading,
        messageAppeared,
        notFound,
        optimizationMode,
        setFileIds,
        setFiles,
        setSources,
        setOptimizationMode,
        rewrite,
        editMessage,
        sendMessage,
        setChatModelProvider,
        chatModelProvider,
        embeddingModelProvider,
        setEmbeddingModelProvider,
        researchEnded,
        setResearchEnded,
        projectId,
        setProjectId,
      }}
    >
      {children}
    </chatContext.Provider>
  );
};

export const useChat = () => {
  const ctx = useContext(chatContext);
  return ctx;
};
