'use client';

import { Cpu, Loader2, Search, RefreshCw, Check, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MinimalProvider } from '@/lib/models/types';
import { useChat } from '@/lib/hooks/useChat';
import { AnimatePresence, motion } from 'motion/react';

interface ChatModelSelectorProps {
  placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
  compact?: boolean;
}

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'anthropic', label: 'Claude' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'google', label: 'Gemini' },
  { id: 'meta', label: 'Llama' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'free', label: 'Free' },
];

const ModelSelector = ({
  placement = 'top-end',
  compact = false,
}: ChatModelSelectorProps) => {
  const [providers, setProviders] = useState<MinimalProvider[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedSubscription, setSelectedSubscription] = useState('all');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [panelMaxH, setPanelMaxH] = useState<number | null>(null);
  const [panelPos, setPanelPos] = useState<'up' | 'down' | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // The desktop panel is an absolutely-positioned popover anchored to the
  // trigger button. Decide which side to open on (and cap the height to the
  // space available) at open time so the panel is never clipped — e.g. on
  // the new-chat page, where the button sits high on screen and a fixed
  // upward-opening panel would overflow the top of the viewport.
  const computePanelPosition = () => {
    if (window.innerWidth < 640) {
      // Mobile renders a fixed bottom sheet with its own CSS height.
      setPanelMaxH(null);
      setPanelPos(null);
      return;
    }
    const btn = triggerRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const PANEL = 460;
    const up = r.top - 16;
    const down = window.innerHeight - r.bottom - 16;
    let openUp: boolean;
    if (up >= PANEL) openUp = true;
    else if (down >= PANEL) openUp = false;
    else openUp = up >= down;
    setPanelPos(openUp ? 'up' : 'down');
    setPanelMaxH(
      Math.floor(Math.min(PANEL, Math.max(120, openUp ? up : down))),
    );
  };

  const { setChatModelProvider, chatModelProvider } = useChat();

  useEffect(() => {
    const loadProviders = async () => {
      try {
        setIsLoading(true);
        const res = await fetch('/api/providers');

        if (!res.ok) {
          throw new Error('Failed to fetch providers');
        }

        const data: { providers: MinimalProvider[] } = await res.json();
        setProviders(data.providers);
      } catch (error) {
        console.error('Error loading providers:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadProviders();
  }, []);

  const currentModel = useMemo(() => {
    if (!chatModelProvider?.providerId || !chatModelProvider?.key) return null;
    for (const p of providers) {
      if (p.id === chatModelProvider.providerId) {
        const found = p.chatModels.find((m) => m.key === chatModelProvider.key);
        if (found) return { providerName: p.name, modelName: found.name, key: found.key };
      }
    }
    return null;
  }, [providers, chatModelProvider]);

  const handleRefresh = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      setIsRefreshing(true);
      const res = await fetch('/api/providers?refresh=true');
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers);
      }
    } catch (err) {
      console.error('Failed to refresh models:', err);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleModelSelect = (
    providerId: string,
    modelKey: string,
    close: () => void,
  ) => {
    setChatModelProvider({ providerId, key: modelKey });
    localStorage.setItem('chatModelProviderId', providerId);
    localStorage.setItem('chatModelKey', modelKey);
    close();
  };

  const matchCategory = (catId: string, model: { name: string; key: string }) => {
    if (catId === 'all') return true;
    const lowerKey = model.key.toLowerCase();
    const lowerName = model.name.toLowerCase();
    if (catId === 'free') {
      return lowerKey.includes(':free') || lowerKey.endsWith('/free');
    }
    if (catId === 'anthropic') {
      return lowerKey.includes('anthropic') || lowerName.includes('claude');
    }
    if (catId === 'openai') {
      return (
        lowerKey.includes('openai') ||
        lowerName.includes('gpt') ||
        lowerKey.includes('/o1') ||
        lowerKey.includes('/o3') ||
        lowerName.includes('chatgpt')
      );
    }
    if (catId === 'deepseek') {
      return lowerKey.includes('deepseek') || lowerName.includes('deepseek');
    }
    if (catId === 'google') {
      return (
        lowerKey.includes('google') ||
        lowerName.includes('gemini') ||
        lowerName.includes('gemma')
      );
    }
    if (catId === 'meta') {
      return lowerKey.includes('meta') || lowerName.includes('llama');
    }
    if (catId === 'mistral') {
      return (
        lowerKey.includes('mistral') ||
        lowerName.includes('mixtral') ||
        lowerName.includes('codestral')
      );
    }
    return true;
  };

  const orderedProviders = useMemo(() => {
    if (!chatModelProvider?.providerId) return providers;

    const currentProviderIndex = providers.findIndex(
      (p) => p.id === chatModelProvider.providerId,
    );

    if (currentProviderIndex === -1) {
      return providers;
    }

    const selectedProvider = providers[currentProviderIndex];
    const remainingProviders = providers.filter(
      (_, index) => index !== currentProviderIndex,
    );

    return [selectedProvider, ...remainingProviders];
  }, [providers, chatModelProvider]);

  const subscriptions = useMemo(() => {
    return [
      { id: 'all', label: 'All' },
      ...providers.map((p) => ({ id: p.id, label: p.name })),
    ];
  }, [providers]);

  const filteredProviders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return orderedProviders
      .map((provider) => ({
        ...provider,
        chatModels: provider.chatModels.filter((model) => {
          const matchesSearch =
            !q ||
            model.name.toLowerCase().includes(q) ||
            model.key.toLowerCase().includes(q) ||
            provider.name.toLowerCase().includes(q);

          const matchesCat = matchCategory(selectedCategory, model);
          return matchesSearch && matchesCat;
        }),
      }))
      .filter((provider) => {
        const matchesSubscription =
          selectedSubscription === 'all' ||
          provider.id === selectedSubscription;
        return matchesSubscription && provider.chatModels.length > 0;
      });
  }, [orderedProviders, searchQuery, selectedCategory, selectedSubscription]);

  const totalModelCount = useMemo(() => {
    return filteredProviders.reduce((acc, p) => acc + p.chatModels.length, 0);
  }, [filteredProviders]);

  const placementClasses = useMemo(() => {
    // Effective vertical side: computePanelPosition may flip the panel
    // below the button when there is more room there.
    const vertical = panelPos === 'down' ? 'bottom' : 'top';
    const horizontal = placement.endsWith('start') ? 'start' : 'end';
    const effective = `${vertical}-${horizontal}` as
      | 'top-start'
      | 'top-end'
      | 'bottom-start'
      | 'bottom-end';
    switch (effective) {
      case 'top-start':
        return 'sm:bottom-full sm:mb-2 sm:left-0 sm:origin-bottom-left';
      case 'top-end':
        return 'sm:bottom-full sm:mb-2 sm:right-0 sm:origin-bottom-right';
      case 'bottom-start':
        return 'sm:top-full sm:mt-2 sm:left-0 sm:origin-top-left';
      case 'bottom-end':
      default:
        return 'sm:top-full sm:mt-2 sm:right-0 sm:origin-top-right';
    }
  }, [placement, panelPos]);

  const displayName = useMemo(() => {
    if (!currentModel) return 'Select Model';
    return currentModel.modelName.replace(/^[^:]+:\s*/, '').trim();
  }, [currentModel]);

  return (
    <Popover className="relative inline-flex items-center">
      {({ open, close }) => (
        <>
          <PopoverButton
            onClick={computePanelPosition}
            ref={triggerRef}
            type="button"
            title={
              currentModel
                ? `Model: ${currentModel.modelName} (${currentModel.providerName})`
                : 'Select Chat Model'
            }
            className={cn(
              'group flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium focus:outline-none transition duration-150 active:scale-95 cursor-pointer',
              compact
                ? 'p-2 rounded-lg text-black/50 dark:text-white/50 hover:bg-light-200 dark:hover:bg-dark-200 hover:text-black dark:hover:text-white'
                : 'text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white bg-light-200/50 dark:bg-dark-200/50 hover:bg-light-200 dark:hover:bg-dark-200 border border-light-200 dark:border-dark-200/60 shadow-xs',
            )}
          >
            <Cpu size={14} className="text-sky-500 shrink-0" />
            {!compact && (
              <>
                <span className="max-w-[75px] xs:max-w-[100px] sm:max-w-[140px] truncate">
                  {displayName}
                </span>
                <ChevronDown
                  size={12}
                  className={cn(
                    'shrink-0 text-black/40 dark:text-white/40 transition-transform duration-200',
                    open && 'rotate-180',
                  )}
                />
              </>
            )}
          </PopoverButton>

          <AnimatePresence>
            {open && (
              <>
                {/* Mobile Backdrop */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={close}
                  className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 sm:hidden"
                />

                <PopoverPanel
                  className={cn(
                    // Mobile: Full-width fixed bottom sheet drawer
                    'fixed inset-x-0 bottom-0 z-50 max-h-[85vh] flex flex-col',
                    // Desktop: Absolute popover relative to button
                    'sm:absolute sm:inset-auto sm:z-50 sm:w-[380px] md:sm:w-[410px] sm:max-h-none',
                    placementClasses,
                  )}
                  static
                >
                  <motion.div
                    initial={
                      panelPos === 'down'
                        ? { opacity: 0, y: -30, scale: 0.98 }
                        : { opacity: 0, y: 30, scale: 0.98 }
                    }
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={
                      panelPos === 'down'
                        ? { opacity: 0, y: -30, scale: 0.98 }
                        : { opacity: 0, y: 30, scale: 0.98 }
                    }
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                    className="bg-light-primary dark:bg-dark-primary border-t sm:border border-light-200 dark:border-dark-200/80 rounded-t-2xl sm:rounded-xl w-full flex flex-col shadow-2xl overflow-hidden backdrop-blur-md max-h-[82vh] sm:max-h-[460px] pb-5 sm:pb-0"
                    style={
                      panelMaxH != null ? { maxHeight: panelMaxH } : undefined
                    }
                  >
                    {/* Mobile drag handle bar */}
                    <div className="w-10 h-1 bg-black/20 dark:bg-white/20 rounded-full mx-auto my-2.5 sm:hidden shrink-0" />

                    {/* Search and Refresh Header */}
                    <div className="p-2.5 border-b border-light-200 dark:border-dark-200/60 flex items-center gap-2 bg-light-secondary/40 dark:bg-dark-secondary/30">
                      <div className="relative flex-1">
                        <Search
                          size={14}
                          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-black/40 dark:text-white/40"
                        />
                        <input
                          type="text"
                          placeholder="Search models..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          autoFocus
                          className="w-full pl-8 pr-7 py-1.5 bg-light-secondary dark:bg-dark-secondary rounded-lg placeholder:text-xs text-xs text-black dark:text-white placeholder:text-black/40 dark:placeholder:text-white/40 focus:outline-none border border-transparent focus:border-sky-500/40 transition duration-150"
                        />
                        {searchQuery && (
                          <button
                            type="button"
                            onClick={() => setSearchQuery('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-black/40 dark:text-white/40 hover:text-black dark:hover:text-white cursor-pointer"
                          >
                            <X size={13} />
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={handleRefresh}
                        disabled={isRefreshing || isLoading}
                        className="p-2 rounded-lg hover:bg-light-secondary dark:hover:bg-dark-secondary text-black/50 dark:text-white/50 hover:text-sky-500 dark:hover:text-sky-400 transition disabled:opacity-50 cursor-pointer shrink-0"
                        title="Sync live models from OpenRouter"
                      >
                        <RefreshCw
                          size={14}
                          className={isRefreshing ? 'animate-spin text-sky-500' : ''}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={close}
                        className="p-2 rounded-lg hover:bg-light-secondary dark:hover:bg-dark-secondary text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white transition sm:hidden shrink-0 cursor-pointer"
                        title="Close"
                      >
                        <X size={16} />
                      </button>
                    </div>

                    {/* Filters: model family (top) + source/subscription (bottom) */}
                    <div className="px-2.5 py-2 space-y-1.5 border-b border-light-200/70 dark:border-dark-200/50">
                      <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
                        {CATEGORIES.map((cat) => (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => setSelectedCategory(cat.id)}
                            className={cn(
                              'px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition cursor-pointer',
                              selectedCategory === cat.id
                                ? 'bg-sky-500 text-white shadow-xs'
                                : 'bg-light-secondary dark:bg-dark-secondary/60 text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white hover:bg-light-200 dark:hover:bg-dark-200',
                            )}
                          >
                            {cat.label}
                          </button>
                        ))}
                        <div className="ml-auto pl-2 text-[10px] text-black/40 dark:text-white/40 whitespace-nowrap shrink-0">
                          {totalModelCount} models
                        </div>
                      </div>
                      <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
                        <span className="pr-0.5 text-[10px] font-semibold uppercase tracking-wider text-black/40 dark:text-white/40 shrink-0">
                          Source
                        </span>
                        {subscriptions.map((sub) => (
                          <button
                            key={sub.id}
                            type="button"
                            onClick={() => setSelectedSubscription(sub.id)}
                            className={cn(
                              'px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap transition cursor-pointer',
                              selectedSubscription === sub.id
                                ? 'bg-violet-500 text-white shadow-xs'
                                : 'bg-transparent text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white',
                            )}
                          >
                            {sub.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Scrollable Models List */}
                    <div className="flex-1 max-h-[60vh] sm:max-h-[320px] overflow-y-auto divide-y divide-light-200/40 dark:divide-dark-200/40">
                    {isLoading ? (
                      <div className="flex flex-col items-center justify-center py-12 gap-2">
                        <Loader2
                          className="animate-spin text-sky-500"
                          size={22}
                        />
                        <span className="text-xs text-black/40 dark:text-white/40">
                          Fetching models...
                        </span>
                      </div>
                    ) : filteredProviders.length === 0 ? (
                      <div className="text-center py-12 px-4 text-black/60 dark:text-white/60 text-xs">
                        {searchQuery
                          ? `No models found matching "${searchQuery}"`
                          : 'No models available in this category'}
                      </div>
                    ) : (
                      filteredProviders.map((provider) => (
                        <div key={provider.id} className="py-1">
                          <div className="px-3 py-1.5 sticky top-0 bg-light-primary/95 dark:bg-dark-primary/95 backdrop-blur-xs flex items-center justify-between">
                            <span className="text-[10px] font-semibold text-black/40 dark:text-white/40 uppercase tracking-wider">
                              {provider.name}
                            </span>
                            <span className="text-[10px] text-black/30 dark:text-white/30">
                              {provider.chatModels.length}
                            </span>
                          </div>

                          <div className="px-1.5 space-y-0.5">
                            {provider.chatModels.map((model) => {
                              const isSelected =
                                chatModelProvider?.providerId === provider.id &&
                                chatModelProvider?.key === model.key;

                              const isFree =
                                model.key.includes(':free') ||
                                model.key.endsWith('/free');

                              return (
                                <button
                                  key={model.key}
                                  onClick={() =>
                                    handleModelSelect(
                                      provider.id,
                                      model.key,
                                      close,
                                    )
                                  }
                                  type="button"
                                  className={cn(
                                    'w-full px-2.5 py-2 flex items-center justify-between text-start duration-150 cursor-pointer transition rounded-lg group',
                                    isSelected
                                      ? 'bg-sky-500/10 dark:bg-sky-500/15 border border-sky-500/30'
                                      : 'hover:bg-light-secondary dark:hover:bg-dark-secondary border border-transparent',
                                  )}
                                >
                                  <div className="flex flex-col min-w-0 flex-1 pr-2">
                                    <div className="flex items-center gap-1.5">
                                      <span
                                        className={cn(
                                          'text-xs truncate font-medium',
                                          isSelected
                                            ? 'text-sky-600 dark:text-sky-400'
                                            : 'text-black/80 dark:text-white/80 group-hover:text-black dark:group-hover:text-white',
                                        )}
                                      >
                                        {model.name}
                                      </span>
                                      {isFree && (
                                        <span className="px-1.5 py-0.2 rounded-full text-[9px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">
                                          FREE
                                        </span>
                                      )}
                                    </div>
                                    <span className="text-[10px] text-black/40 dark:text-white/40 truncate font-mono mt-0.5">
                                      {model.key}
                                    </span>
                                  </div>

                                  {isSelected && (
                                    <Check
                                      size={14}
                                      className="text-sky-500 shrink-0"
                                    />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </motion.div>
              </PopoverPanel>
            </>
          )}
        </AnimatePresence>
      </>
    )}
  </Popover>
);
};

export default ModelSelector;

