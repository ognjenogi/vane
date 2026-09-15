'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Mic, Check, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface VoiceRecorderButtonProps {
  onTranscribed: (text: string) => void;
  disabled?: boolean;
  className?: string;
}

const VoiceRecorderButton: React.FC<VoiceRecorderButtonProps> = ({
  onTranscribed,
  disabled = false,
  className = '',
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const isCancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const getSupportedMimeType = (): string => {
    if (typeof MediaRecorder === 'undefined') return '';
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/aac',
      'audio/ogg',
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  };

  const startRecording = async () => {
    if (disabled || isRecording || isTranscribing) return;

    if (
      typeof window === 'undefined' ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      toast.error('Audio recording is not supported in this browser environment.');
      return;
    }

    try {
      isCancelledRef.current = false;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = getSupportedMimeType();
      const options = mimeType ? { mimeType } : undefined;
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Stop all tracks to turn off the microphone hardware indicator
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }

        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }

        setIsRecording(false);
        setRecordingSeconds(0);

        if (isCancelledRef.current) {
          audioChunksRef.current = [];
          return;
        }

        const audioBlob = new Blob(audioChunksRef.current, {
          type: mimeType || 'audio/webm',
        });
        audioChunksRef.current = [];

        if (audioBlob.size === 0) {
          toast.error('No audio captured');
          return;
        }

        await handleTranscribe(audioBlob);
      };

      mediaRecorder.start(250); // Emit data every 250ms
      setIsRecording(true);
      setRecordingSeconds(0);

      timerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      console.error('Microphone error:', err);
      if (
        err.name === 'NotAllowedError' ||
        err.name === 'PermissionDeniedError'
      ) {
        toast.error('Microphone permission was denied.');
      } else if (
        err.name === 'NotFoundError' ||
        err.name === 'DevicesNotFoundError'
      ) {
        toast.error('No microphone found on your device.');
      } else {
        toast.error(err.message || 'Could not start microphone recording.');
      }
    }
  };

  const stopRecording = () => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === 'recording'
    ) {
      isCancelledRef.current = false;
      mediaRecorderRef.current.stop();
    }
  };

  const cancelRecording = () => {
    isCancelledRef.current = true;
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === 'recording'
    ) {
      mediaRecorderRef.current.stop();
    } else {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setIsRecording(false);
      setRecordingSeconds(0);
    }
  };

  const handleTranscribe = async (blob: Blob) => {
    setIsTranscribing(true);
    try {
      const formData = new FormData();
      formData.append('file', blob, 'recording.webm');

      const res = await fetch('/api/audio/transcribe', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        // Check if browser SpeechRecognition is available as fallback
        if (
          data.useFallback &&
          typeof window !== 'undefined' &&
          ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
        ) {
          toast.info('Falling back to browser speech recognition...');
          runBrowserSpeechFallback();
          return;
        }
        throw new Error(data.message || 'Transcription failed');
      }

      if (data.text && data.text.trim()) {
        onTranscribed(data.text.trim());
        toast.success('Speech transcribed');
      } else {
        toast.info('No speech detected in audio.');
      }
    } catch (err: any) {
      console.error('Transcription error:', err);
      // Try browser speech fallback if server failed
      if (
        typeof window !== 'undefined' &&
        ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
      ) {
        toast.info('Using browser speech recognition fallback...');
        runBrowserSpeechFallback();
      } else {
        toast.error(err.message || 'Failed to transcribe audio.');
      }
    } finally {
      setIsTranscribing(false);
    }
  };

  const runBrowserSpeechFallback = () => {
    try {
      const SpeechRecognition =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) return;

      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onresult = (event: any) => {
        const transcript = event.results?.[0]?.[0]?.transcript;
        if (transcript) {
          onTranscribed(transcript.trim());
          toast.success('Transcribed via browser speech');
        }
      };

      recognition.onerror = () => {
        toast.error('Browser speech recognition failed');
      };

      recognition.start();
    } catch (err) {
      console.error('Browser speech fallback error:', err);
    }
  };

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remainingSecs = secs % 60;
    return `${mins}:${remainingSecs < 10 ? '0' : ''}${remainingSecs}`;
  };

  if (isTranscribing) {
    return (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 animate-pulse">
        <Loader2 size={13} className="animate-spin" />
        <span>Transcribing...</span>
      </div>
    );
  }

  if (isRecording) {
    return (
      <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 shadow-sm animate-in fade-in duration-200">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
        </span>
        <span className="font-mono text-xs font-medium">{formatTime(recordingSeconds)}</span>
        <button
          type="button"
          onClick={stopRecording}
          className="p-1 rounded-full bg-red-600 text-white hover:bg-red-700 transition"
          title="Done (Transcribe speech)"
        >
          <Check size={11} strokeWidth={3} />
        </button>
        <button
          type="button"
          onClick={cancelRecording}
          className="p-1 rounded-full text-red-600/70 hover:text-red-700 hover:bg-red-500/20 transition"
          title="Cancel recording"
        >
          <X size={11} strokeWidth={2.5} />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startRecording}
      disabled={disabled}
      className={`p-2 rounded-full text-black/60 dark:text-white/60 hover:text-black hover:dark:text-white hover:bg-light-200 dark:hover:bg-dark-200 transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
      title="Voice search (Whisper)"
    >
      <Mic size={17} />
    </button>
  );
};

export default VoiceRecorderButton;
