import { Injectable, Logger } from "@nestjs/common";
import { AppConfigService } from "../../config/app-config.service";

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

/**
 * Search provider backed by serper.dev. We keep the abstraction so the
 * search subgraph stays decoupled from the vendor — swapping to Tavily,
 * SerpAPI, or Brave is one new file and one DI binding.
 */
@Injectable()
export class SerperSearchProvider {
  private readonly logger = new Logger(SerperSearchProvider.name);
  private readonly endpoint = "https://google.serper.dev/search";

  constructor(private readonly cfg: AppConfigService) {}

  async search(query: string, num = 5): Promise<SearchResult[]> {
    const key = this.cfg.serperApiKey;
    if (!key) {
      this.logger.warn("SERPR_API_KEY missing — returning empty search results");
      return [];
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, num }),
      });
      if (!res.ok) {
        this.logger.warn(`serper.dev ${res.status}: ${await res.text()}`);
        return [];
      }
      const data = (await res.json()) as { organic?: SearchResult[] };
      return (data.organic ?? []).slice(0, num).map((r) => ({
        title: r.title ?? "",
        link: r.link ?? "",
        snippet: r.snippet ?? "",
      }));
    } catch (err) {
      this.logger.warn(`serper.dev failed: ${(err as Error).message}`);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
