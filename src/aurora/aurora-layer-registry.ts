/**
 * AuroraLayerRegistry — aurora-internal dispatcher for AuroraLayer instances.
 *
 * Phase 1 of Sub-A (zero-arch-aurora-layers.md): nothing registers yet. Built-in
 * layers (graticule, cities, wind, pressure) absorb into AuroraLayer instances in
 * subsequent phases. App-side experimental layers register through this same
 * surface in Phase 8.
 *
 * Validates at the boundary per parent plan's "Fail-Early Practices":
 * - register() throws on duplicate id, missing/non-finite order, empty id
 * - compute() return value is checked to be boolean
 * - unregister() of unknown id throws
 */

import type {
  AuroraDataEvent,
  AuroraLayer,
  AuroraLayerContext,
  AuroraLayerFrame,
} from './types/aurora-layer';

export class AuroraLayerRegistry {
  private layers = new Map<string, AuroraLayer>();
  private byOrder: AuroraLayer[] = [];

  register(layer: AuroraLayer, ctx: AuroraLayerContext): void {
    if (typeof layer.id !== 'string' || layer.id.length === 0) {
      throw new Error('AuroraLayerRegistry.register: layer.id must be a non-empty string');
    }
    if (typeof layer.order !== 'number' || !Number.isFinite(layer.order)) {
      throw new Error(`AuroraLayerRegistry.register: layer.order must be a finite number (id="${layer.id}")`);
    }
    if (this.layers.has(layer.id)) {
      throw new Error(`AuroraLayerRegistry.register: duplicate layer id "${layer.id}"`);
    }
    this.layers.set(layer.id, layer);
    this.rebuildByOrder();
    layer.initialize(ctx);
  }

  unregister(id: string): void {
    const layer = this.layers.get(id);
    if (!layer) {
      throw new Error(`AuroraLayerRegistry.unregister: unknown layer id "${id}"`);
    }
    layer.dispose();
    this.layers.delete(id);
    this.rebuildByOrder();
  }

  onDataChanged(layerId: string, events: AuroraDataEvent[], ctx: AuroraLayerContext): void {
    const layer = this.layers.get(layerId);
    if (layer) layer.onDataChanged(ctx, events);
  }

  onOptionsChanged(layerId: string, options: Record<string, unknown>, ctx: AuroraLayerContext): void {
    const layer = this.layers.get(layerId);
    if (layer) layer.onOptionsChanged(ctx, options);
  }

  computeAll(frame: AuroraLayerFrame, opacityOf: (id: string) => number): void {
    for (const layer of this.byOrder) {
      frame.opacity = opacityOf(layer.id);
      const dispatched = layer.compute(frame);
      if (typeof dispatched !== 'boolean') {
        throw new Error(`AuroraLayerRegistry.computeAll: layer "${layer.id}".compute() must return boolean`);
      }
    }
  }

  updateAll(frame: AuroraLayerFrame, opacityOf: (id: string) => number): void {
    for (const layer of this.byOrder) {
      frame.opacity = opacityOf(layer.id);
      layer.update(frame);
    }
  }

  renderAll(frame: AuroraLayerFrame, pass: GPURenderPassEncoder, opacityOf: (id: string) => number): void {
    for (const layer of this.byOrder) {
      frame.opacity = opacityOf(layer.id);
      layer.render(frame, pass);
    }
  }

  disposeAll(): void {
    for (const layer of this.byOrder) {
      layer.dispose();
    }
    this.layers.clear();
    this.byOrder = [];
  }

  has(id: string): boolean {
    return this.layers.has(id);
  }

  size(): number {
    return this.layers.size;
  }

  private rebuildByOrder(): void {
    this.byOrder = [...this.layers.values()].sort((a, b) => a.order - b.order);
  }
}
