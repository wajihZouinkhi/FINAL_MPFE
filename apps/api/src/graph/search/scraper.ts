import { Injectable, Logger } from "@nestjs/common";
import * as cheerio from "cheerio";

@Injectable()
export class Scraper {
  private readonly logger = new Logger(Scraper.name);
  private readonly maxBytes = 200_000;
  private readonly maxChars = 8_000;

  /**
   * Fetch a URL and extract readable text. Best-effort: returns "" on
   * any error (timeout, non-2xx, non-HTML, parse error). Search-loop
   * code treats "" as "skip this candidate".
   */
  async fetchReadable(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; FINAL-MPFE-Bot/0.1; +https://github.com/hamdisoudani/FINAL_MPFE)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!res.ok) return "";
      const ctype = res.headers.get("content-type") ?? "";
      if (!ctype.includes("text/html") && !ctype.includes("application/xhtml")) {
        return "";
      }
      const buf = await res.arrayBuffer();
      const sliced = buf.byteLength > this.maxBytes
        ? buf.slice(0, this.maxBytes)
        : buf;
      const html = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
      const text = this.extract(html);
      return text.slice(0, this.maxChars);
    } catch (err) {
      this.logger.debug(
        `scrape failed for ${url}: ${(err as Error).message}`,
      );
      return "";
    } finally {
      clearTimeout(timeout);
    }
  }

  private extract(html: string): string {
    const $ = cheerio.load(html);
    $("script, style, noscript, iframe, nav, footer, header, form").remove();
    const main = $("article").text() || $("main").text() || $("body").text();
    // Three-pass cleanup so paragraph structure survives for the LLM:
    //  1. collapse runs of non-newline whitespace into a single space,
    //  2. strip the spaces hugging newlines (otherwise indentation-blank
    //     lines like "\n \n" survive the next pass),
    //  3. collapse blank-line runs to a single newline.
    return main
      .replace(/[^\S\n]+/g, " ")
      .replace(/[ ]*\n[ ]*/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }
}
