/**
 * InfoService - Manages info dialog state and markdown content
 */

import m from 'mithril';
import { marked } from 'marked';

export class InfoService {
  dialogOpen = false;
  currentPage = 'welcome';
  content = '';
  loading = false;
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
        }
      }
    });
  }

  async openDialog(page = 'welcome'): Promise<void> {
    this.dialogOpen = true;
    this.currentPage = page;
    this.error = null;
    m.redraw();
    await this.loadPage(page);
  }

  closeDialog(): void {
    this.dialogOpen = false;
    m.redraw();
  }

  async loadPage(page: string): Promise<void> {
    // Check cache
    if (this.cache.has(page)) {
      this.content = this.cache.get(page)!;
      m.redraw();
      return;
    }

    this.loading = true;
    this.error = null;
    m.redraw();

    try {
      const response = await fetch(`info/${page}.md`);
      if (!response.ok) {
        throw new Error(`Failed to load ${page}.md`);
      }
      const markdown = await response.text();
      const html = await marked.parse(markdown);
      this.content = html;
      this.cache.set(page, html);
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to load content';
      this.content = '';
    } finally {
      this.loading = false;
      m.redraw();
    }
  }

  async navigateTo(page: string): Promise<void> {
    this.currentPage = page;
    await this.loadPage(page);
  }
}
