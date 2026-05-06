/**
 * Options Dialog Component
 *
 * Auto-generated UI from schema metadata.
 * - Modal centered on desktop, slide-up on mobile
 * - Draggable header (desktop only)
 * - Filter support for layer-specific views
 */

import m from 'mithril';
import {
  optionGroups,
  extractOptionsMeta,
  optionsSchema,
  type ZeroOptions,
  type FlatOption,
  type OptionFilter,
} from '../schemas/options.schema';
import { auroraOptionsSchema, type PressureColorOption } from '../aurora/options/schema';
import type { OptionsService } from '../services/options-service';
import type { PaletteService } from '../services/palette-service';
import { getByPath } from '../utils/object';
import type { ConfigService } from '../services/config-service';
import type { DialogService } from '../services/dialog-service';
import type { AuroraService } from '../services/aurora-service';
import { clearCache, nuke } from '../services/sw-registration';
import { RadioPaletteControl } from './radio-palette-control';
import { isPaletteId } from '../services/palette-service';
import { PressureColorControl } from './pressure-color-control';
import { DialogHeader } from './dialog-header';
import {
  createHostAdapter,
  createLayerAdapter,
  createEngineAdapter,
  adapterFor,
  type OptionsAdapter,
} from '../services/aurora-options-adapters';
import { CITY_COLORS_RGB } from '../utils/cities-colors';

/** Delete aurora-db so a Reset All actually resets aurora-owned options.
 *  The worker keeps the DB open so deleteDatabase fires `onblocked` rather
 *  than resolving — the page reload that follows closes the connection,
 *  so we proceed regardless. */
function deleteAuroraDb(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('aurora-db');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      console.warn('[Reset] aurora-db delete blocked — proceeding; reload will close the connection');
      resolve();
    };
  });
}

/** Walk both schemas and merge into one FlatOption[] for the dialog.
 *  Memoized at module scope — both schemas are stable. */
let cachedFlat: FlatOption[] | null = null;
function getAllFlat(): FlatOption[] {
  if (cachedFlat) return cachedFlat;
  cachedFlat = [
    ...extractOptionsMeta(optionsSchema),
    ...extractOptionsMeta(auroraOptionsSchema),
  ];
  return cachedFlat;
}

function filterByEntryPoint(flat: FlatOption[], filter: OptionFilter): FlatOption[] {
  return flat.filter(o => {
    const f = o.meta.filter;
    return Array.isArray(f) ? f.includes(filter) : f === filter;
  });
}

function groupByGroupId(flat: FlatOption[]): Record<string, FlatOption[]> {
  const grouped: Record<string, FlatOption[]> = {};
  for (const opt of flat) {
    const group = opt.meta.group;
    if (!grouped[group]) grouped[group] = [];
    grouped[group]!.push(opt);
  }
  for (const group of Object.values(grouped)) {
    group.sort((a, b) => a.meta.order - b.meta.order);
  }
  return grouped;
}

/** Extract the layer id from a path. Host paths use `<id>.<key>`; aurora
 *  layer paths use `layers.<id>.opacity` or `layers.<id>.opts.<key>`. */
function layerIdFromPath(path: string): string {
  const segs = path.split('.');
  if (segs[0] === 'layers') return segs[1] ?? '';
  return segs[0] ?? '';
}

/** Cheap deep equality — JSON.stringify is fine for descriptor-shape
 *  values (no functions, no cycles). Used by the chip selection check
 *  and the modified flag for non-primitive defaults. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ============================================================
// Type guard for slider formatting
// ============================================================

interface SliderFields {
  min: number;
  max: number;
  step: number;
}

const isLocalhost = location.hostname === 'localhost';

// ============================================================
// Prefetch size calculation
// ============================================================

// OUTDATED: Prefetch size estimation hardcodes layer names and sizes.
// Should derive from published params (params-ecmwf_ifs.ts sizeEstimate).
// Per-layer toggles should be removed — prefetch downloads all published params.
// See also: options.schema.ts prefetch section, sw-registration.ts PrefetchConfig.

/** Timesteps per forecast day range (ECMWF: 1h to 90h, 3h to 144h, 6h after) */
const TIMESTEPS_BY_DAYS: Record<string, number> = {
  '1': 24,   // 0-24h: hourly
  '2': 48,   // 0-48h: hourly
  '4': 92,   // 0-72h hourly (72) + 72-96h mixed (20)
  '6': 108,  // + 96-144h 3-hourly (16)
  '8': 116,  // + 144-192h 6-hourly (8)
};

/** Network transfer size per timestep per layer (MB) from defaultSizeEstimate */
const SIZE_PER_TIMESTEP_MB: Record<string, number> = {
  temp: 8,
  pressure: 2,
  wind: 16.4,  // U + V components
};

/** Calculate estimated prefetch size in MB */
function calculatePrefetchSizeMB(days: string, layers: { temp: boolean; pressure: boolean; wind: boolean }): number {
  const timesteps = TIMESTEPS_BY_DAYS[days]!;
  let sizePerTimestep = 0;
  if (layers.temp) sizePerTimestep += SIZE_PER_TIMESTEP_MB.temp!;
  if (layers.pressure) sizePerTimestep += SIZE_PER_TIMESTEP_MB.pressure!;
  if (layers.wind) sizePerTimestep += SIZE_PER_TIMESTEP_MB.wind!;
  return timesteps * sizePerTimestep;
}

/** Format size for display */
function formatSize(mb: number): string {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

// Module-level state for advanced toggle
let showAdvanced = false;

// ============================================================
// Helpers
// ============================================================

function isModified(adapter: OptionsAdapter, path: string, currentValue: unknown): boolean {
  return !deepEqual(currentValue, adapter.getDefault(path));
}

function formatValue(value: number, meta: SliderFields): string {
  if (meta.max === 1 && meta.min <= 0.1) {
    return `${Math.round(value * 100)}%`;
  }
  if (meta.step < 0.1) return value.toFixed(2);
  if (meta.step < 1) return value.toFixed(1);
  return String(value);
}

// ============================================================
// Control renderers
// ============================================================

function renderControl(
  opt: FlatOption,
  currentValue: unknown,
  adapter: OptionsAdapter,
  optionsService: OptionsService,
  paletteService: PaletteService,
  options: ZeroOptions,
): m.Children {
  const { path, meta } = opt;

  // Palette selector — only host paths today (`temp.palette`).
  if (path.endsWith('.palette')) {
    const layerId = layerIdFromPath(path);
    const palettes = paletteService.getPalettes(layerId);

    if (!isPaletteId(currentValue)) return null;

    return m(RadioPaletteControl, {
      palettes,
      selected: currentValue,
      onSelect: (paletteId) => {
        adapter.write(path, paletteId);
        paletteService.setPalette(layerId, paletteId);
      }
    });
  }

  // Pressure colors — discriminated union, special control. Aurora path:
  // `layers.pressure.opts.colors`.
  if (path === 'layers.pressure.opts.colors') {
    return m(PressureColorControl, {
      value: currentValue as PressureColorOption,
      onChange: (value: PressureColorOption) => adapter.write(path, value),
    });
  }

  switch (meta.control) {
    case 'toggle': {
      const disabled = path === 'prefetch.enabled'
        || (meta.disabledWhen !== undefined && getByPath(options, meta.disabledWhen.path) === meta.disabledWhen.equals);
      return m('label.toggle', { class: disabled ? 'disabled' : '' }, [
        m('input[type=checkbox]', {
          checked: currentValue as boolean,
          disabled,
          onchange: (e: Event) => adapter.write(path, (e.target as HTMLInputElement).checked),
        }),
        m('span.track')
      ]);
    }

    case 'slider': {
      return m('div.slider', [
        m('input[type=range]', {
          min: meta.min,
          max: meta.max,
          step: meta.step,
          value: currentValue as number,
          oninput: (e: Event) => adapter.write(path, parseFloat((e.target as HTMLInputElement).value)),
        }),
        m('span.value', formatValue(currentValue as number, meta))
      ]);
    }

    case 'select': {
      const filteredOptions = meta.options.filter(o =>
        (!o.localhostOnly || isLocalhost) &&
        (!o.maxCores || isLocalhost || navigator.hardwareConcurrency >= o.maxCores)
      );
      return m('select.select', {
        value: String(currentValue),
        onchange: (e: Event) => {
          const next = (e.target as HTMLSelectElement).value;
          // Coerce string back to descriptor's value type via meta options.
          const match = filteredOptions.find(o => String(o.value) === next);
          adapter.write(path, match ? match.value : next);
        }
      }, filteredOptions.map(o =>
        m('option', { value: String(o.value) }, o.label)
      ));
    }

    case 'radio': {
      const layerId = layerIdFromPath(path);
      const isLoading = optionsService.loadingLayers.value.has(layerId);
      const groupDisabled = meta.disabled === true
        || (meta.disabledWhen !== undefined && getByPath(options, meta.disabledWhen.path) === meta.disabledWhen.equals);

      return m('div.radio-group', { class: groupDisabled ? 'disabled' : '' }, [
        m('span.spinner', { class: isLoading ? 'visible' : '' }),
        ...meta.options.map(o => {
          const isDisabled = groupDisabled;
          return m('label.radio', {
            class: [
              currentValue === o.value ? 'selected' : '',
              isDisabled ? 'disabled' : ''
            ].filter(Boolean).join(' ')
          }, [
            m('input[type=radio]', {
              name: path,
              value: String(o.value),
              checked: currentValue === o.value,
              disabled: isDisabled,
              onchange: () => adapter.write(path, o.value),
            }),
            m('span', o.label)
          ]);
        })
      ]);
    }

    case 'color-chips': {
      // Aurora persists RGB triplet; chip metadata carries named-value
      // (`'white'`, etc.) → look up triplet via CITY_COLORS_RGB at click.
      const rgb = currentValue as [number, number, number];
      return m('div.color-chips', meta.options.map((o: { value: string; label: string; color: string }) =>
        m('button.color-chip', {
          key: o.value,
          class: deepEqual(rgb, CITY_COLORS_RGB[o.value as keyof typeof CITY_COLORS_RGB]) ? 'selected' : '',
          style: { backgroundColor: o.color },
          title: o.label,
          onclick: () => adapter.write(path, CITY_COLORS_RGB[o.value as keyof typeof CITY_COLORS_RGB]),
        })
      ));
    }

    case 'pressure-colors':
      // Handled by the early special-case branch above.
      return null;

    case 'layer-toggle': {
      return m('div.layer-toggle-row', [
        m('span.layer-color', {
          style: { backgroundColor: `var(--color-layer-${meta.layerId})` }
        }),
        m('label.toggle', [
          m('input[type=checkbox]', {
            checked: currentValue as boolean,
            onchange: (e: Event) => adapter.write(path, (e.target as HTMLInputElement).checked),
          }),
          m('span.track')
        ])
      ]);
    }
  }
}

/** Render prefetch size estimate row */
function renderPrefetchSizeEstimate(options: ZeroOptions): m.Children {
  const { prefetch } = options;
  const sizeMB = calculatePrefetchSizeMB(prefetch.forecastDays, {
    temp: prefetch.temp,
    pressure: prefetch.pressure,
    wind: prefetch.wind,
  });

  if (sizeMB === 0) {
    return m('div.row.prefetch-size', { key: '_prefetch_size' }, [
      m('div.info', [
        m('label.label', 'Estimated size'),
      ]),
      m('div.controls', [
        m('span.size-value', 'No layers selected'),
      ]),
    ]);
  }

  return m('div.row.prefetch-size', { key: '_prefetch_size' }, [
    m('div.info', [
      m('label.label', 'Estimated size'),
    ]),
    m('div.controls', [
      m('span.size-value', formatSize(sizeMB)),
    ]),
  ]);
}

function renderOption(
  opt: FlatOption,
  options: ZeroOptions,
  optionsService: OptionsService,
  paletteService: PaletteService,
  hostAdapter: OptionsAdapter,
  engineAdapter: OptionsAdapter,
  layerAdapter: OptionsAdapter,
): m.Children {
  const adapter = adapterFor(opt.path, hostAdapter, engineAdapter, layerAdapter);
  const currentValue = adapter.read(opt.path);
  const modified = isModified(adapter, opt.path, currentValue);
  const isPalette = opt.path.endsWith('.palette');

  // Reset writes the default through the same adapter that owns the path.
  // For host paths this still routes through optionsService.update via
  // hostAdapter.write; for aurora paths it dispatches to the worker.
  const resetButton = m('button.reset', {
    title: 'Reset to default',
    onclick: () => adapter.write(opt.path, adapter.getDefault(opt.path)),
    style: { visibility: modified ? 'visible' : 'hidden' }
  }, '↺');

  return m('div.row', { key: opt.path, class: isPalette ? 'palette-row' : '', 'data-testid': opt.path }, [
    m('div.info', isPalette ? [
      m('div.text', [
        m('label.label', opt.meta.label),
        opt.meta.description ? m('span.hint', opt.meta.description) : null
      ]),
      resetButton,
    ] : [
      m('label.label', opt.meta.label),
      opt.meta.description ? m('span.hint', opt.meta.description) : null
    ].filter(Boolean)),
    m('div.controls', [
      !isPalette ? resetButton : null,
      renderControl(opt, currentValue, adapter, optionsService, paletteService, options),
    ].filter(Boolean))
  ]);
}

// ============================================================
// Layer labels
// ============================================================

const layerLabels: Record<string, string> = {
  earth: 'Earth',
  sun: 'Sun',
  graticule: 'Graticule',
  temp: 'Temperature',
  rain: 'Precipitation',
  clouds: 'Cloud Cover',
  humidity: 'Humidity',
  wind: 'Wind',
  pressure: 'Pressure',
  cities: 'Cities',
};

const advancedSubgroups: Record<string, string> = {
  'viewport.mouse': 'Mouse',
  'viewport.touch': 'Touch',
  'debug': 'Development',
};

function getAdvancedSubgroup(path: string): string {
  for (const prefix of Object.keys(advancedSubgroups)) {
    if (path.startsWith(prefix + '.') || path.startsWith(prefix)) {
      return prefix;
    }
  }
  return 'other';
}

// ============================================================
// Group renderer
// ============================================================

function renderGroup(
  groupId: string,
  groupOptions: FlatOption[],
  options: ZeroOptions,
  optionsService: OptionsService,
  paletteService: PaletteService,
  showAdvancedOptions: boolean,
  hostAdapter: OptionsAdapter,
  engineAdapter: OptionsAdapter,
  layerAdapter: OptionsAdapter,
  skipGroupHeader: boolean = false
): m.Children {
  const ro = (opt: FlatOption) => renderOption(opt, options, optionsService, paletteService, hostAdapter, engineAdapter, layerAdapter);
  const group = optionGroups[groupId as keyof typeof optionGroups];
  if (!group) return null;

  const currentModel = options.viewport.physicsModel;

  // Filter options
  const visibleOptions = groupOptions
    .filter(o => {
      if (o.meta.hidden) return false;
      if (!showAdvancedOptions && o.meta.group === 'advanced') return false;
      if (o.meta.model && o.meta.model !== currentModel) return false;
      return true;
    })
    .sort((a, b) => a.meta.order - b.meta.order);

  if (visibleOptions.length === 0) return null;

  // Layers group: sub-group by layer ID
  if (groupId === 'layers' && !skipGroupHeader) {
    const byLayer = new Map<string, FlatOption[]>();
    for (const opt of visibleOptions) {
      const layerId = layerIdFromPath(opt.path);
      if (!byLayer.has(layerId)) byLayer.set(layerId, []);
      byLayer.get(layerId)!.push(opt);
    }

    return m('div.section', { key: groupId }, [
      m('h3.title', { key: '_title' }, group.label),
      group.description ? m('p.description', { key: '_desc' }, group.description) : null,
      ...Array.from(byLayer.entries()).map(([layerId, opts]) => {
        return m('div.subsection', { key: layerId }, [
          m('h4.title', { key: `${layerId}_title` }, layerLabels[layerId] || layerId),
          ...opts.map(ro)
        ].filter(Boolean));
      })
    ].filter(Boolean));
  }

  // Advanced group: sub-group by path prefix
  if (groupId === 'advanced') {
    const bySubgroup = new Map<string, FlatOption[]>();
    for (const opt of visibleOptions) {
      const subgroup = getAdvancedSubgroup(opt.path);
      if (!bySubgroup.has(subgroup)) bySubgroup.set(subgroup, []);
      bySubgroup.get(subgroup)!.push(opt);
    }

    const subgroupOrder = ['viewport.mouse', 'viewport.touch', 'debug', 'other'];
    const sortedSubgroups = Array.from(bySubgroup.entries()).sort((a, b) => {
      return subgroupOrder.indexOf(a[0]) - subgroupOrder.indexOf(b[0]);
    });

    return m('div.section', { key: groupId }, [
      m('h3.title', { key: '_title' }, group.label),
      group.description ? m('p.description', { key: '_desc' }, group.description) : null,
      ...sortedSubgroups.map(([subgroupKey, opts]) =>
        m('div.subsection', { key: subgroupKey }, [
          m('h4.title', { key: `${subgroupKey}_title` }, advancedSubgroups[subgroupKey] || subgroupKey),
          ...opts.map(ro)
        ])
      )
    ].filter(Boolean));
  }

  // Download group: add prefetch size estimate after layer toggles
  // Hide prefetch sub-options when prefetch.enabled is false
  if (groupId === 'download') {
    const prefetchEnabled = options.prefetch.enabled;
    const filteredOptions = visibleOptions.filter(opt => {
      // Always show the enabled toggle
      if (opt.path === 'prefetch.enabled') return true;
      // Hide other prefetch options when disabled
      if (opt.path.startsWith('prefetch.')) return prefetchEnabled;
      return true;
    });

    return m('div.section', { key: groupId }, [
      !skipGroupHeader ? m('h3.title', { key: '_title' }, group.label) : null,
      !skipGroupHeader && group.description ? m('p.description', { key: '_desc' }, group.description) : null,
      ...filteredOptions.map(ro),
      prefetchEnabled ? renderPrefetchSizeEstimate(options) : null,
    ].filter(Boolean));
  }

  return m('div.section', { key: groupId }, [
    !skipGroupHeader ? m('h3.title', { key: '_title' }, group.label) : null,
    !skipGroupHeader && group.description ? m('p.description', { key: '_desc' }, group.description) : null,
    ...visibleOptions.map(ro)
  ].filter(Boolean));
}

// ============================================================
// Component
// ============================================================

export interface OptionsDialogAttrs {
  optionsService: OptionsService;
  paletteService: PaletteService;
  dialogService: DialogService;
  configService: ConfigService;
  auroraService: AuroraService;
}

export const OptionsDialog: m.ClosureComponent<OptionsDialogAttrs> = ({ attrs: initialAttrs }) => {
  let windowEl: HTMLElement | null = null;
  // Built once per dialog instance — adapters close over service refs.
  const hostAdapter = createHostAdapter(initialAttrs.optionsService);
  const engineAdapter = createEngineAdapter(initialAttrs.auroraService);
  const layerAdapter = createLayerAdapter(initialAttrs.auroraService);

  return {
    view({ attrs }) {
      const { optionsService, paletteService, dialogService } = attrs;

    if (!dialogService.isOpen('options')) return null;

    const isFloating = dialogService.isFloating('options');
    const isTop = dialogService.isTop('options');
    const isDragging = dialogService.isDragging('options');
    const dragOffset = dialogService.getDragOffset('options');

    const filter = dialogService.getPayload('options')?.filter;
    const options = optionsService.options.value;

    // Walk both schemas (host + aurora) into one FlatOption[] then
    // filter/group by entry-point and group id.
    const allFlat = getAllFlat();
    const filteredFlat = filter && filter !== 'global'
      ? filterByEntryPoint(allFlat, filter)
      : filterByEntryPoint(allFlat, 'global');
    const filteredGroups = groupByGroupId(filteredFlat);

    // Sort groups by order (exclude 'advanced')
    const sortedGroupIds = Object.keys(filteredGroups)
      .filter(id => id !== 'advanced')
      .sort((a, b) => {
        const orderA = optionGroups[a as keyof typeof optionGroups]!.order;
        const orderB = optionGroups[b as keyof typeof optionGroups]!.order;
        return orderA - orderB;
      });

    // Check for advanced options
    const grouped = groupByGroupId(allFlat);
    const advancedGroup = grouped['advanced'];
    const hasAdvanced = !filter && advancedGroup !== undefined && advancedGroup.length > 0;

    // Dialog title
    const filterTitles: Record<string, string> = {
      dataCache: 'Download',
      gpu: 'GPU',
      queue: 'Download',
      capture: 'Capture',
    };
    const dialogTitle = filter && filter !== 'global'
      ? `${filterTitles[filter] ?? layerLabels[filter]!} Options` // QC-OK: try service title, then layer label
      : 'Options';

    const windowStyle: Record<string, string> = {};
    if (dragOffset.x !== 0 || dragOffset.y !== 0) {
      windowStyle.transform = `translate(${dragOffset.x}px, ${dragOffset.y}px)`;
    }

    const floatingClass = isFloating ? (isTop ? 'floating top' : 'floating behind') : '';
    const closingClass = dialogService.isClosing('options') ? 'closing' : '';

    const close = () => dialogService.close('options');

    return m('div.dialog.options', { class: `${floatingClass} ${closingClass}` }, [
      m('div.backdrop', {
        onclick: () => {
          if (dialogService.shouldCloseOnBackdrop('options')) {
            close();
          }
        }
      }),
      m('div.window', {
        class: isDragging ? 'dragging' : '',
        style: windowStyle,
        onmousedown: () => dialogService.bringToFront('options'),
        oncreate: (vnode) => { windowEl = vnode.dom as HTMLElement; },
        onupdate: (vnode) => { windowEl = vnode.dom as HTMLElement; },
      }, [
        m(DialogHeader, {
          dialogId: 'options',
          title: dialogTitle,
          dialogService,
          windowEl,
          onClose: close,
        }),
        m('div.content', [
          ...sortedGroupIds.map(groupId => {
            const groupOpts = filteredGroups[groupId];
            if (!groupOpts) return null;
            return renderGroup(groupId, groupOpts, options, optionsService, paletteService, showAdvanced, hostAdapter, engineAdapter, layerAdapter, !!filter && filter !== 'global');
          }).filter(Boolean),

          // Danger zone (only in global view)
          !filter || filter === 'global' ? m('div.danger-zone', { key: '_danger_zone' }, [
            m('h3', 'Danger Zone'),
            // Advanced toggle
            hasAdvanced ? m('div.advanced-toggle-row', [
              m('span.toggle-label', 'Show advanced options'),
              m('label.toggle', {
                onclick: () => {
                  showAdvanced = !showAdvanced;
                  m.redraw();
                }
              }, [
                m('input[type=checkbox]', {
                  checked: showAdvanced,
                  onclick: (e: Event) => e.stopPropagation()
                }),
                m('span.track')
              ])
            ]) : null,
            m('span.hint', 'Will restart the application.'),
            m('div.actions', [
              m('button.btn.btn-danger', {
                onclick: async () => {
                  optionsService.reset();
                  // Phase C+: aurora-db is authoritative for migrated layer
                  // options. Clear it so reset reaches every store.
                  await deleteAuroraDb();
                  location.href = '/';
                }
              }, 'Reset All'),
              m('button.btn.btn-danger', {
                onclick: async () => {
                  await clearCache();
                  location.href = '/';
                }
              }, 'Clear Cache'),
              m('button.btn.btn-danger', {
                onclick: async () => { await nuke(); location.href = '/'; }
              }, 'Nuke'),
            ]),
            location.hostname === 'localhost' ? [
              m('h3', { style: 'margin-top: 16px' }, 'Performance'),
              m('span.hint', 'Run GPU benchmark across all layers and zoom levels.'),
              m('div.actions', [
                m('button.btn.btn-danger', {
                  onclick: () => {
                    const today = new Date().toISOString().slice(0, 10);
                    location.href = `/?event=${today}--${today}&perftest`;
                  }
                }, 'Run GPU Test'),
              ]),
            ] : null
          ]) : null,

          // Advanced group (only in global view)
          (!filter || filter === 'global') && showAdvanced && advancedGroup
            ? renderGroup('advanced', advancedGroup, options, optionsService, paletteService, true, hostAdapter, engineAdapter, layerAdapter)
            : null
        ].filter(Boolean)),
        m('div.footer', [
          m('span.version', `v${__APP_VERSION__} (${__APP_HASH__})`),
          m('div.actions', [
            filter && filter !== 'global' ? m('button.btn.btn-danger', {
              onclick: () => optionsService.reset(filter)
            }, layerLabels[filter] ? 'Reset Layer' : 'Reset') : null,
            optionsService.needsReload.value ? m('button.btn.btn-secondary', {
              onclick: () => { location.href = '/'; }
            }, 'Reload') : null,
            m('button.btn.btn-secondary', { onclick: close }, 'Close')
          ])
        ])
      ])
    ]);
    }
  };
};
