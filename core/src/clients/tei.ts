import axios from "axios";
import { requireEnv } from "../lib/env.js";

export interface TeiEmbedOptions {
  normalize?: boolean;
  truncate?: boolean;
  promptName?: string;
}

/** Hugging Face TEI(Text Embeddings Inference) 서버 연동 클라이언트 (무상태). */
export class TeiEmbeddingClient {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = requireEnv("TEI_BASE_URL");
  }

  /** 텍스트 배열을 임베딩 벡터 배열로 변환한다. 입력 순서와 출력 순서가 1:1 대응한다. */
  async embed(texts: string[], opts: TeiEmbedOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];

    const body: Record<string, unknown> = {
      inputs: texts,
      normalize: opts.normalize ?? true,
      truncate: opts.truncate ?? true,
    };
    if (opts.promptName !== undefined) {
      body.prompt_name = opts.promptName;
    }

    const { data } = await axios.post<number[][]>(`${this.baseUrl}/embed`, body);
    return data;
  }
}
