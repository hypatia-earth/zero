/**
 * AboutService - Manages about dialog state and markdown content
 */

import m from 'mithril';
import { marked } from 'marked';

/** Known about pages - must exist at bootstrap */
const ABOUT_PAGES = ['about'] as const;

export class AboutService {
  dialogOpen = false;
  currentPage = 'about';
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
    for (const page of ABOUT_PAGES) {
      const response = await fetch(`about/${page}.md`);
      if (!response.ok) {
        throw new Error(`[About] Missing page: ${page}.md`);
      }
      const markdown = await response.text();
      const html = await marked.parse(markdown);
      this.cache.set(page, html);
    }
  }

  openDialog(page = 'about'): void {
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
