import { UIConfigField } from '@/lib/config/types';
import { getConfiguredModelProviderById } from '@/lib/config/serverRegistry';
import { Model, ModelList, ProviderMetadata } from '../../types';
import OpenAIEmbedding from './openaiEmbedding';
import BaseEmbedding from '../../base/embedding';
import BaseModelProvider from '../../base/provider';
import BaseLLM from '../../base/llm';
import OpenAILLM from './openaiLLM';

interface OpenAIConfig {
  apiKey: string;
  baseURL: string;
}

const defaultChatModels: Model[] = [
  {
    name: 'GPT-3.5 Turbo',
    key: 'gpt-3.5-turbo',
  },
  {
    name: 'GPT-4',
    key: 'gpt-4',
  },
  {
    name: 'GPT-4 turbo',
    key: 'gpt-4-turbo',
  },
  {
    name: 'GPT-4 omni',
    key: 'gpt-4o',
  },
  {
    name: 'GPT-4o (2024-05-13)',
    key: 'gpt-4o-2024-05-13',
  },
  {
    name: 'GPT-4 omni mini',
    key: 'gpt-4o-mini',
  },
  {
    name: 'GPT 4.1 nano',
    key: 'gpt-4.1-nano',
  },
  {
    name: 'GPT 4.1 mini',
    key: 'gpt-4.1-mini',
  },
  {
    name: 'GPT 4.1',
    key: 'gpt-4.1',
  },
  {
    name: 'GPT 5 nano',
    key: 'gpt-5-nano',
  },
  {
    name: 'GPT 5',
    key: 'gpt-5',
  },
  {
    name: 'GPT 5 Mini',
    key: 'gpt-5-mini',
  },
  {
    name: 'GPT 5 Pro',
    key: 'gpt-5-pro',
  },
  {
    name: 'GPT 5.1',
    key: 'gpt-5.1',
  },
  {
    name: 'GPT 5.2',
    key: 'gpt-5.2',
  },
  {
    name: 'GPT 5.2 Pro',
    key: 'gpt-5.2-pro',
  },
  {
    name: 'o1',
    key: 'o1',
  },
  {
    name: 'o3',
    key: 'o3',
  },
  {
    name: 'o3 Mini',
    key: 'o3-mini',
  },
  {
    name: 'o4 Mini',
    key: 'o4-mini',
  },
];

const defaultEmbeddingModels: Model[] = [
  {
    name: 'Text Embedding 3 Small',
    key: 'text-embedding-3-small',
  },
  {
    name: 'Text Embedding 3 Large',
    key: 'text-embedding-3-large',
  },
];

const providerConfigFields: UIConfigField[] = [
  {
    type: 'password',
    name: 'API Key',
    key: 'apiKey',
    description: 'Your OpenAI API key',
    required: true,
    placeholder: 'OpenAI API Key',
    env: 'OPENAI_API_KEY',
    scope: 'server',
  },
  {
    type: 'string',
    name: 'Base URL',
    key: 'baseURL',
    description: 'The base URL for the OpenAI API',
    required: true,
    placeholder: 'OpenAI Base URL',
    default: 'https://api.openai.com/v1',
    env: 'OPENAI_BASE_URL',
    scope: 'server',
  },
];

const dynamicModelsCache = new Map<
  string,
  { models: ModelList; timestamp: number }
>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes cache

export const clearOpenAIModelCache = (providerId?: string) => {
  if (providerId) {
    for (const key of dynamicModelsCache.keys()) {
      if (key.startsWith(`${providerId}::`)) {
        dynamicModelsCache.delete(key);
      }
    }
  } else {
    dynamicModelsCache.clear();
  }
};

class OpenAIProvider extends BaseModelProvider<OpenAIConfig> {
  constructor(id: string, name: string, config: OpenAIConfig) {
    super(id, name, config);
  }

  async getDefaultModels(): Promise<ModelList> {
    const isStandardOpenAI =
      !this.config.baseURL ||
      this.config.baseURL === 'https://api.openai.com/v1';

    const cacheKey = `${this.id}::${this.config.baseURL}`;
    const cached = dynamicModelsCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.models;
    }

    try {
      const baseURL = this.config.baseURL || 'https://api.openai.com/v1';
      const modelsUrl = `${baseURL.replace(/\/+$/, '')}/models`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey
            ? { Authorization: `Bearer ${this.config.apiKey}` }
            : {}),
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        const rawModels: any[] = Array.isArray(data.data)
          ? data.data
          : Array.isArray(data)
            ? data
            : [];

        const dynamicChatModels: Model[] = [];
        const dynamicEmbeddingModels: Model[] = [];

        rawModels.forEach((m: any) => {
          const modelId = m.id || m.key;
          if (!modelId || typeof modelId !== 'string') return;

          const isEmbedding =
            modelId.toLowerCase().includes('embed') ||
            m.architecture?.modality === 'text->embedding';

          const modelObj: Model = {
            key: modelId,
            name: m.name || modelId,
          };

          if (isEmbedding) {
            dynamicEmbeddingModels.push(modelObj);
          } else {
            dynamicChatModels.push(modelObj);
          }
        });

        if (dynamicChatModels.length > 0 || dynamicEmbeddingModels.length > 0) {
          dynamicChatModels.sort((a, b) => a.name.localeCompare(b.name));
          dynamicEmbeddingModels.sort((a, b) => a.name.localeCompare(b.name));

          const result: ModelList = {
            embedding:
              dynamicEmbeddingModels.length > 0
                ? dynamicEmbeddingModels
                : isStandardOpenAI
                  ? defaultEmbeddingModels
                  : [],
            chat:
              dynamicChatModels.length > 0
                ? dynamicChatModels
                : isStandardOpenAI
                  ? defaultChatModels
                  : [],
          };

          dynamicModelsCache.set(cacheKey, {
            models: result,
            timestamp: Date.now(),
          });

          return result;
        }
      }
    } catch (err: any) {
      console.warn(
        `Failed to fetch dynamic models for provider ${this.id} (${this.config.baseURL}):`,
        err.message || err,
      );
    }

    if (cached) {
      return cached.models;
    }

    if (isStandardOpenAI) {
      return {
        embedding: defaultEmbeddingModels,
        chat: defaultChatModels,
      };
    }

    return {
      embedding: [],
      chat: [],
    };
  }

  async getModelList(): Promise<ModelList> {
    const defaultModels = await this.getDefaultModels();
    const configProvider = getConfiguredModelProviderById(this.id);

    const userChatModels = configProvider?.chatModels || [];
    const userEmbeddingModels = configProvider?.embeddingModels || [];

    const chatMap = new Map<string, Model>();
    defaultModels.chat.forEach((m) => chatMap.set(m.key, m));
    userChatModels.forEach((m) => chatMap.set(m.key, m));

    const embedMap = new Map<string, Model>();
    defaultModels.embedding.forEach((m) => embedMap.set(m.key, m));
    userEmbeddingModels.forEach((m) => embedMap.set(m.key, m));

    return {
      embedding: Array.from(embedMap.values()),
      chat: Array.from(chatMap.values()),
    };
  }

  async loadChatModel(key: string): Promise<BaseLLM<any>> {
    const modelList = await this.getModelList();

    const exists = modelList.chat.find((m) => m.key === key);

    if (!exists && this.config.baseURL === 'https://api.openai.com/v1') {
      throw new Error(
        'Error Loading OpenAI Chat Model. Invalid Model Selected',
      );
    }

    return new OpenAILLM({
      apiKey: this.config.apiKey,
      model: key,
      baseURL: this.config.baseURL,
    });
  }

  async loadEmbeddingModel(key: string): Promise<BaseEmbedding<any>> {
    const modelList = await this.getModelList();
    const exists = modelList.embedding.find((m) => m.key === key);

    if (!exists) {
      throw new Error(
        'Error Loading OpenAI Embedding Model. Invalid Model Selected.',
      );
    }

    return new OpenAIEmbedding({
      apiKey: this.config.apiKey,
      model: key,
      baseURL: this.config.baseURL,
    });
  }

  static parseAndValidate(raw: any): OpenAIConfig {
    if (!raw || typeof raw !== 'object')
      throw new Error('Invalid config provided. Expected object');
    if (!raw.apiKey || !raw.baseURL)
      throw new Error(
        'Invalid config provided. API key and base URL must be provided',
      );

    return {
      apiKey: String(raw.apiKey),
      baseURL: String(raw.baseURL),
    };
  }

  static getProviderConfigFields(): UIConfigField[] {
    return providerConfigFields;
  }

  static getProviderMetadata(): ProviderMetadata {
    return {
      key: 'openai',
      name: 'OpenAI',
    };
  }
}

export default OpenAIProvider;
