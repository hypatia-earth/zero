/**
 * InfoService - Manages info dialog state and markdown content
 */

import m from 'mithril';
import { marked } from 'marked';

/** Known info pages - must exist at bootstrap */
const INFO_PAGES = ['welcome'] as const;

export class InfoService {
  dialogOpen = false;
  currentPage = 'welcome';
  content = '';
  error: string | null = null;

  // Cache loaded pages
  private cache = new Map<string, string>();

  constructor() {
    // Configure marked
    marked.use({
      gfm: true,
      breaks: true,
      renderer: {
        heading({ text, depth }: { text: string; depth: number }) {
          const id = text.toLowerCase().replace(/[^\w]+/g, '-');
          return `<h${depth} id="${id}">${text}</h${depth}>\n`;
        },
        link({ href, text }: { href: string; text: string }) {
          // External links open in new tab
          if (href.startsWith('http://') || href.startsWith('https://')) {
            return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
          }
          return `<a href="${href}">${text}</a>`;
        }
      }
    });
  }

  /**
   * Preload all info pages during bootstrap
   * @throws Error if any page is missing
   */
  async init(): Promise<void> {
    for (const page of INFO_PAGES) {
      const response = await fetch(`info/${page}.md`);
      if (!response.ok) {
        throw new Error(`[Info] Missing info page: ${page}.md`);
      }
      const markdown = await response.text();
      const html = await marked.parse(markdown);
      this.cache.set(page, html);
    }
    console.log(`[Info] Preloaded ${INFO_PAGES.length} page(s)`);
  }

  openDialog(page = 'welcome'): void {
    this.dialogOpen = true;
    this.currentPage = page;
    this.error = null;
    this.loadPage(page);
  }

  closeDialog(): void {
    this.dialogOpen = false;
    m.redraw();
  }

  loadPage(page: string): void {
    const cached = this.cache.get(page);
    if (cached) {
      this.content = cached;
    } else {
      this.error = `Unknown page: ${page}`;
      this.content = '';
    }
    m.redraw();
  }

  navigateTo(page: string): void {
    this.currentPage = page;
    this.loadPage(page);
  }
}
