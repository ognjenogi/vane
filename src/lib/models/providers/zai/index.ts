import { UIConfigField } from '@/lib/config/types';
import { getConfiguredModelProviderById } from '@/lib/config/serverRegistry';
import { Model, ModelList, ProviderMetadata } from '../../types';
import BaseEmbedding from '../../base/embedding';
import BaseModelProvider from '../../base/provider';
import BaseLLM from '../../base/llm';
import OpenAILLM from '../openai/openaiLLM';

interface ZAIConfig {
  apiKey: string;
  baseURL?: string;
}

export const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

const providerConfigFields: UIConfigField[] = [
  {
    type: 'password',
    name: 'API Key',
    key: 'apiKey',
    description: 'Your Z.AI API key',
    required: true,
    placeholder: 'Z.AI API Key',
    env: 'ZAI_API_KEY',
    scope: 'server',
  },
  {
    type: 'string',
    name: 'Base URL',
    key: 'baseURL',
    description:
      'Change to https://api.z.ai/api/coding/paas/v4 when using a GLM Coding Plan key',
    required: false,
    placeholder: ZAI_BASE_URL,
    default: ZAI_BASE_URL,
    env: 'ZAI_BASE_URL',
    scope: 'server',
  },
];

// Shown only when the live /models fetch fails (e.g. key not set yet).
const fallbackChatModels: Model[] = [
  { name: 'GLM-5.3 Flash', key: 'glm-5.3-flash' },
  { name: 'GLM-5.3', key: 'glm-5.3' },
  { name: 'GLM-5.2', key: 'glm-5.2' },
  { name: 'GLM-5.1', key: 'glm-5.1' },
  { name: 'GLM-5', key: 'glm-5' },
  { name: 'GLM-4.6', key: 'glm-4.6' },
  { name: 'GLM-4.5 Air', key: 'glm-4.5-air' },
];

class ZAIProvider extends BaseModelProvider<ZAIConfig> {
  constructor(id: string, name: string, config: ZAIConfig) {
    super(id, name, config);
  }

  async getDefaultModels(): Promise<ModelList> {
    const baseURL = this.config.baseURL || ZAI_BASE_URL;
    try {
      const res = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Models fetch failed with status ${res.status}`);
      }

      const data = await res.json();
      const rawModels: unknown[] = Array.isArray(data.data) ? data.data : [];

      const chat = rawModels.flatMap((m) => {
        const id =
          m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined;
        if (typeof id !== 'string' || id.toLowerCase().includes('embedding')) {
          return [];
        }
        return [{ key: id, name: id }];
      });

      if (chat.length === 0) {
        throw new Error('No chat models in response');
      }

      return { embedding: [], chat };
    } catch (err) {
      console.warn('[ZAI] Falling back to default GLM model list:', err);
      return { embedding: [], chat: fallbackChatModels };
    }
  }

  async getModelList(): Promise<ModelList> {
    const defaultModels = await this.getDefaultModels();
    const configProvider = getConfiguredModelProviderById(this.id)!;

    return {
      embedding: [
        ...defaultModels.embedding,
        ...configProvider.embeddingModels,
      ],
      chat: [...defaultModels.chat, ...configProvider.chatModels],
    };
  }

  async loadChatModel(key: string): Promise<BaseLLM<unknown>> {
    return new OpenAILLM({
      apiKey: this.config.apiKey,
      model: key,
      baseURL: this.config.baseURL || ZAI_BASE_URL,
    });
  }

  async loadEmbeddingModel(key: string): Promise<BaseEmbedding<any>> {
    throw new Error('Z.AI Provider does not support embedding models.');
  }

  static parseAndValidate(raw: unknown): ZAIConfig {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Invalid config provided. Expected object');
    }
    if (
      !('apiKey' in raw) ||
      typeof raw.apiKey !== 'string' ||
      raw.apiKey.length === 0
    ) {
      throw new Error('Invalid config provided. API key must be provided');
    }
    const baseURL =
      'baseURL' in raw && typeof raw.baseURL === 'string'
        ? raw.baseURL
        : undefined;

    return {
      apiKey: raw.apiKey,
      ...(baseURL ? { baseURL } : {}),
    };
  }

  static getProviderConfigFields(): UIConfigField[] {
    return providerConfigFields;
  }

  static getProviderMetadata(): ProviderMetadata {
    return {
      key: 'zai',
      name: 'Z.AI',
    };
  }
}

export default ZAIProvider;
