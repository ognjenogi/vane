'use client';

import { ChevronDown, Sliders, Star, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { useChat } from '@/lib/hooks/useChat';
import { AnimatePresence, motion } from 'motion/react';

export const OptimizationModes = [
  {
    key: 'speed',
    title: 'Speed',
    description: 'Prioritize speed and get the quickest possible answer.',
    icon: <Zap size={15} className="text-[#FF9800]" />,
  },
  {
    key: 'balanced',
    title: 'Balanced',
    description: 'Find the right balance between speed and accuracy.',
    icon: <Sliders size={15} className="text-[#4CAF50]" />,
  },
  {
    key: 'quality',
    title: 'Quality',
    description: 'Deep iterative research loop with rich multi-source citations.',
    icon: (
      <Star
        size={15}
        className="text-[#2196F3] dark:text-[#BBDEFB] fill-[#BBDEFB] dark:fill-[#2196F3]"
      />
    ),
  },
];

interface OptimizationProps {
  placement?: 'up' | 'down';
  compact?: boolean;
}

const Optimization = ({
  placement = 'down',
  compact = false,
}: OptimizationProps) => {
  const { optimizationMode, setOptimizationMode } = useChat();

  const currentMode =
    OptimizationModes.find((mode) => mode.key === optimizationMode) ??
    OptimizationModes[0];

  return (
    <Popover className="relative shrink-0">
      {({ open, close }) => (
        <>
          <PopoverButton
            type="button"
            className={cn(
              'flex items-center space-x-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium border transition-all duration-150 focus:outline-none select-none',
              'border-light-200 dark:border-dark-200 bg-light-primary/50 dark:bg-dark-primary/50 text-black/80 dark:text-white/80 hover:bg-light-secondary dark:hover:bg-dark-secondary hover:text-black dark:hover:text-white active:scale-95',
            )}
            title={`Mode: ${currentMode.title}`}
          >
            <div className="flex flex-row items-center space-x-1.5">
              {currentMode.icon}
              <span className="hidden xs:inline text-xs font-medium">
                {currentMode.title}
              </span>
              <ChevronDown
                size={13}
                className={cn(
                  open ? 'rotate-180' : 'rotate-0',
                  'transition duration-200 opacity-60',
                )}
              />
            </div>
          </PopoverButton>
          <AnimatePresence>
            {open && (
              <PopoverPanel
                className={cn(
                  'absolute z-50 w-64 max-w-[calc(100vw-32px)] left-0',
                  placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
                )}
                static
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.1, ease: 'easeOut' }}
                  className={cn(
                    'flex flex-col space-y-1.5 bg-light-primary dark:bg-dark-primary border rounded-xl border-light-200 dark:border-dark-200 w-full p-2 shadow-lg shadow-black/10 dark:shadow-black/40',
                    placement === 'up' ? 'origin-bottom-left' : 'origin-top-left',
                  )}
                >
                  {OptimizationModes.map((mode, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        setOptimizationMode(mode.key);
                        close();
                      }}
                      className={cn(
                        'p-2 rounded-lg flex flex-col items-start justify-start text-start space-y-1 duration-200 cursor-pointer transition focus:outline-none',
                        optimizationMode === mode.key
                          ? 'bg-light-secondary dark:bg-dark-secondary border border-light-200/50 dark:border-dark-200/50'
                          : 'hover:bg-light-secondary dark:hover:bg-dark-secondary',
                      )}
                    >
                      <div className="flex flex-row justify-between w-full text-black dark:text-white">
                        <div className="flex flex-row items-center space-x-1.5">
                          {mode.icon}
                          <p className="text-xs font-semibold">{mode.title}</p>
                        </div>
                        {mode.key === 'quality' && (
                          <span className="bg-sky-500/70 dark:bg-sky-500/40 border border-sky-600 px-1.5 py-0.5 rounded-full text-[10px] text-white font-medium">
                            Deep
                          </span>
                        )}
                      </div>
                      <p className="text-black/60 dark:text-white/60 text-[11px] leading-snug">
                        {mode.description}
                      </p>
                    </button>
                  ))}
                </motion.div>
              </PopoverPanel>
            )}
          </AnimatePresence>
        </>
      )}
    </Popover>
  );
};

export default Optimization;
