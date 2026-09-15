import { NextResponse } from 'next/server';
import { getConfiguredModelProviders } from '@/lib/config/serverRegistry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get('content-type') || '';
    if (
      !contentType.includes('multipart/form-data') &&
      !contentType.includes('application/x-www-form-urlencoded')
    ) {
      return NextResponse.json(
        { message: 'Invalid Content-Type. Expected multipart/form-data.' },
        { status: 400 },
      );
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | Blob | null;

    if (!file) {
      return NextResponse.json(
        { message: 'No audio file provided' },
        { status: 400 },
      );
    }

    // Locate an audio transcription provider from configured model providers
    const providers = getConfiguredModelProviders();

    // 1. Check for OpenRouter
    const openRouterProvider = providers.find(
      (p) =>
        p.config?.apiKey &&
        (p.name.toLowerCase().includes('open router') ||
          p.name.toLowerCase().includes('openrouter') ||
          p.config?.baseURL?.includes('openrouter')),
    );

    // 2. Check for Groq
    const groqProvider = providers.find(
      (p) =>
        p.config?.apiKey &&
        (p.name.toLowerCase().includes('groq') ||
          p.type === 'groq' ||
          p.config?.baseURL?.includes('groq')),
    );

    // 3. Check for OpenAI
    const openAIProvider = providers.find(
      (p) =>
        p.config?.apiKey &&
        (p.name.toLowerCase().includes('openai') ||
          p.type === 'openai') &&
        !p.config?.baseURL?.includes('openrouter'),
    );

    let apiUrl = '';
    let apiKey = '';
    let model = '';

    if (openRouterProvider?.config?.apiKey) {
      apiUrl = 'https://openrouter.ai/api/v1/audio/transcriptions';
      apiKey = openRouterProvider.config.apiKey;
      model = 'openai/whisper-large-v3-turbo';
    } else if (groqProvider?.config?.apiKey) {
      apiUrl = 'https://api.groq.com/openai/v1/audio/transcriptions';
      apiKey = groqProvider.config.apiKey;
      model = 'whisper-large-v3-turbo';
    } else if (openAIProvider?.config?.apiKey) {
      apiUrl = 'https://api.openai.com/v1/audio/transcriptions';
      apiKey = openAIProvider.config.apiKey;
      model = 'whisper-1';
    } else {
      return NextResponse.json(
        {
          message:
            'No transcription provider (OpenRouter/Groq/OpenAI) configured with an API key.',
          useFallback: true,
        },
        { status: 422 },
      );
    }

    const outgoingFormData = new FormData();
    outgoingFormData.append('file', file, 'audio.webm');
    outgoingFormData.append('model', model);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: outgoingFormData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Transcription API error:', response.status, errorText);
      return NextResponse.json(
        {
          message: `Transcription provider error: ${response.statusText}`,
          details: errorText,
          useFallback: true,
        },
        { status: response.status },
      );
    }

    const data = await response.json();
    const text = (data.text || '').trim();

    return NextResponse.json({ text }, { status: 200 });
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return NextResponse.json(
        { message: 'Transcription timed out after 30s', useFallback: true },
        { status: 504 },
      );
    }
    console.error('Error handling audio transcription:', error);
    return NextResponse.json(
      { message: error.message || 'Failed to process audio', useFallback: true },
      { status: 500 },
    );
  }
}
