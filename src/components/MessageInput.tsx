import { cn } from '@/lib/utils';
import { ArrowUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import AttachSmall from './MessageInputActions/AttachSmall';
import ModelSelector from './MessageInputActions/ChatModelSelector';
import Optimization from './MessageInputActions/Optimization';
import VoiceRecorderButton from './VoiceRecorderButton';
import { useChat } from '@/lib/hooks/useChat';

const MessageInput = () => {
  const { loading, sendMessage } = useChat();

  const [copilotEnabled, setCopilotEnabled] = useState(false);
  const [message, setMessage] = useState('');
  const [textareaRows, setTextareaRows] = useState(1);
  const [mode, setMode] = useState<'multi' | 'single'>('single');

  useEffect(() => {
    if (textareaRows >= 2 && message && mode === 'single') {
      setMode('multi');
    } else if (!message && mode === 'multi') {
      setMode('single');
    }
  }, [textareaRows, mode, message]);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeElement = document.activeElement;

      const isInputFocused =
        activeElement?.tagName === 'INPUT' ||
        activeElement?.tagName === 'TEXTAREA' ||
        activeElement?.hasAttribute('contenteditable');

      if (e.key === '/' && !isInputFocused) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <form
      onSubmit={(e) => {
        if (loading) return;
        e.preventDefault();
        sendMessage(message);
        setMessage('');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !loading) {
          e.preventDefault();
          sendMessage(message);
          setMessage('');
        }
      }}
      className={cn(
        'relative bg-light-secondary dark:bg-dark-secondary flex overflow-visible border border-light-200 dark:border-dark-200 shadow-sm shadow-light-200/10 dark:shadow-black/20 transition-all duration-200 focus-within:border-light-300 dark:focus-within:border-dark-300',
        mode === 'multi'
          ? 'flex-col rounded-2xl p-4'
          : 'flex-col sm:flex-row rounded-2xl sm:rounded-full p-3 sm:p-4 sm:items-center',
      )}
    >
      <TextareaAutosize
        ref={inputRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onHeightChange={(height, props) => {
          setTextareaRows(Math.ceil(height / props.rowHeight));
        }}
        className={cn(
          'transition bg-transparent dark:placeholder:text-white/50 text-base sm:text-sm placeholder:text-sm dark:text-white resize-none focus:outline-none w-full px-2 max-h-24 lg:max-h-36 xl:max-h-48 flex-grow flex-shrink',
          mode === 'single' ? 'order-1 sm:order-2' : '',
        )}
        placeholder="Ask a follow-up"
      />

      {mode === 'single' && (
        <>
          <div className="order-2 sm:order-1 flex items-center justify-between sm:justify-start w-full sm:w-auto pt-2 sm:pt-0 mt-1 sm:mt-0 border-t border-light-200/40 dark:border-dark-200/40 sm:border-0 sm:mr-1 shrink-0">
            <div className="flex items-center space-x-1 shrink-0">
              <AttachSmall />
              <VoiceRecorderButton
                onTranscribed={(text) => {
                  setMessage((prev) => (prev ? `${prev.trim()} ${text}` : text));
                  inputRef.current?.focus();
                }}
              />
              <ModelSelector placement="top-start" />
              <Optimization placement="up" />
            </div>

            <button
              disabled={message.trim().length === 0 || loading}
              className="sm:hidden bg-[#24A0ED] text-white disabled:text-black/50 dark:disabled:text-white/50 hover:bg-opacity-85 transition duration-100 disabled:bg-[#e0e0dc79] dark:disabled:bg-[#ececec21] rounded-full p-2 shrink-0"
              aria-label="Send message"
            >
              <ArrowUp className="bg-background" size={17} />
            </button>
          </div>

          <button
            disabled={message.trim().length === 0 || loading}
            className="hidden sm:flex order-3 bg-[#24A0ED] text-white disabled:text-black/50 dark:disabled:text-white/50 hover:bg-opacity-85 transition duration-100 disabled:bg-[#e0e0dc79] dark:disabled:bg-[#ececec21] rounded-full p-2 shrink-0 ml-1"
            aria-label="Send message"
          >
            <ArrowUp className="bg-background" size={17} />
          </button>
        </>
      )}

      {mode === 'multi' && (
        <div className="flex flex-row items-center justify-between w-full pt-2">
          <div className="flex items-center space-x-1">
            <AttachSmall />
            <VoiceRecorderButton
              onTranscribed={(text) => {
                setMessage((prev) => (prev ? `${prev.trim()} ${text}` : text));
                inputRef.current?.focus();
              }}
            />
            <ModelSelector placement="top-start" />
            <Optimization placement="up" />
          </div>
          <button
            disabled={message.trim().length === 0 || loading}
            className="bg-[#24A0ED] text-white disabled:text-black/50 dark:disabled:text-white/50 hover:bg-opacity-85 transition duration-100 disabled:bg-[#e0e0dc79] dark:disabled:bg-[#ececec21] rounded-full p-2 shrink-0"
          >
            <ArrowUp className="bg-background" size={17} />
          </button>
        </div>
      )}
    </form>
  );
};

export default MessageInput;
