import { Injectable, Logger } from "@nestjs/common";
import { AppConfigService } from "../../config/app-config.service";

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

/**
 * Search provider that prefers Tavily when `TAVILY_API_KEY` is set,
 * and falls back to serper.dev when only `SERPR_API_KEY` is set.
 * The abstraction stays decoupled from the vendor — swapping to
 * Brave or SerpAPI is one new branch.
 */
@Injectable()
export class SerperSearchProvider {
  private readonly logger = new Logger(SerperSearchProvider.name);
  private readonly serperEndpoint = "https://google.serper.dev/search";
  private readonly tavilyEndpoint = "https://api.tavily.com/search";

  constructor(private readonly cfg: AppConfigService) {}

  async search(query: string, num = 5): Promise<SearchResult[]> {
    const tavilyKey = this.cfg.tavilyApiKey;
    if (tavilyKey) {
      return this.searchTavily(tavilyKey, query, num);
    }
    const serperKey = this.cfg.serperApiKey;
    if (serperKey) {
      return this.searchSerper(serperKey, query, num);
    }
    this.logger.warn(
      "Neither TAVILY_API_KEY nor SERPR_API_KEY is set — returning empty search results",
    );
    return [];
  }

  private async searchTavily(
    key: string,
    query: string,
    num: number,
  ): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(this.tavilyEndpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          max_results: num,
          search_depth: "basic",
        }),
      });
      if (!res.ok) {
        this.logger.warn(`tavily ${res.status}: ${await res.text()}`);
        return [];
      }
      const data = (await res.json()) as {
        results?: { title?: string; url?: string; content?: string }[];
      };
      return (data.results ?? []).slice(0, num).map((r) => ({
        title: r.title ?? "",
        link: r.url ?? "",
        snippet: r.content ?? "",
      }));
    } catch (err) {
      this.logger.warn(`tavily failed: ${(err as Error).message}`);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private async searchSerper(
    key: string,
    query: string,
    num: number,
  ): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(this.serperEndpoint, {
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
